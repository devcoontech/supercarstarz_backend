import type pg from 'pg';
import { DateTime } from 'luxon';
import { conflict, badRequest, notFound } from '../../core/errors.js';
import { getSettings, type Settings } from '../../core/settings.js';
import { applyOrderPaymentState, isLiveItem, orderIdOf, recalcOrderTotal, repriceOrder } from './orders.js';
import { type Actor, logEvent } from './history.js';
import { notify } from '../notifications/notify.js';

/** Booking status lifecycle: allowed changes, holds that expire, and the cancellation refund policy. */

type C = pg.PoolClient;

export type BookingStatus =
  | 'pending' | 'awaiting_payment' | 'confirmed' | 'driver_assigned' | 'in_progress'
  | 'completed' | 'cancellation_requested' | 'cancelled' | 'rejected' | 'payment_failed';

/** Allowed manual transitions. Payment success moves awaiting_payment -> confirmed separately (see applyPaymentState). */
export const TRANSITIONS: Record<BookingStatus, BookingStatus[]> = {
  pending: ['awaiting_payment', 'confirmed', 'rejected', 'cancelled', 'cancellation_requested'],
  awaiting_payment: ['confirmed', 'payment_failed', 'cancelled', 'cancellation_requested'],
  payment_failed: ['awaiting_payment', 'cancelled'],
  confirmed: ['driver_assigned', 'in_progress', 'cancellation_requested', 'cancelled'],
  driver_assigned: ['confirmed', 'in_progress', 'cancellation_requested', 'cancelled'],
  in_progress: ['completed'],
  cancellation_requested: ['cancelled', 'confirmed', 'driver_assigned'],
  completed: [],
  cancelled: [],
  rejected: [],
};

export const RELEASING: BookingStatus[] = ['cancelled', 'rejected', 'payment_failed'];

export async function lockBooking(c: C, id: string) {
  const b = (await c.query('SELECT * FROM bookings WHERE id=$1 FOR UPDATE', [id])).rows[0];
  if (!b) throw notFound('Booking not found');
  return b;
}

async function releaseResources(c: C, b: any, reason: string) {
  await c.query(
    `UPDATE driver_assignments SET active=false, ended_at=now(), ended_reason=$2 WHERE booking_id=$1 AND active`, [b.id, reason],
  );
}

export async function changeStatus(
  c: C, id: string, to: BookingStatus, actor: Actor,
  o: { reason?: string | null; allowUnpaid?: boolean; asCustomer?: boolean } = {},
) {
  const b = await lockBooking(c, id);
  const from = b.status as BookingStatus;
  if (from === to) return b;
  if (!TRANSITIONS[from].includes(to)) throw conflict(`A ${from.replace('_', ' ')} booking cannot become ${to.replace('_', ' ')}`, 'invalid_transition');
  if (to === 'confirmed' && !o.allowUnpaid && from !== 'cancellation_requested' && from !== 'driver_assigned') {
    // The deposit (or full amount) is paid per order, so check the order.
    const ord = (await c.query('SELECT paid_pence, refunded_pence, deposit_due_pence FROM orders WHERE id=$1', [b.order_id])).rows[0];
    if (ord.paid_pence - ord.refunded_pence < ord.deposit_due_pence) {
      throw conflict('Payment has not been received. Confirm anyway by allowing unpaid confirmation with a reason.', 'payment_required');
    }
  }
  if (['cancelled', 'rejected', 'payment_failed', 'cancellation_requested'].includes(to) && !o.reason && actor.type === 'staff' && to !== 'payment_failed') {
    throw badRequest('A reason is required', 'reason_required');
  }
  if (to === 'in_progress' && !b.started_at) await c.query('UPDATE bookings SET started_at=now() WHERE id=$1', [id]);
  if (to === 'completed') await c.query('UPDATE bookings SET completed_at=now(), dispatch_status=\'service_complete\' WHERE id=$1', [id]);
  if (to === 'cancelled' || to === 'rejected') {
    await c.query('UPDATE bookings SET cancelled_at=now(), cancel_reason=$2 WHERE id=$1', [id, o.reason ?? null]);
  }
  const hold = to === 'awaiting_payment' ? DateTime.utc().plus({ minutes: (await getSettings(c))['booking.holdMinutes'] }).toJSDate() : null;
  if (to === 'awaiting_payment' || from === 'awaiting_payment' || from === 'pending') {
    await c.query('UPDATE bookings SET hold_expires_at=$2 WHERE id=$1', [id, hold]);
  }
  let updated;
  try {
    updated = (await c.query('UPDATE bookings SET status=$2, updated_at=now() WHERE id=$1 RETURNING *', [id, to])).rows[0];
  } catch (e: any) {
    if (e.code === '23P01') throw conflict('That time has since been taken by another booking', 'slot_unavailable');
    throw e;
  }
  if (RELEASING.includes(to)) await releaseResources(c, b, `Booking ${to}`);
  await logEvent(c, id, actor, 'status_changed', { from, to, reason: o.reason });
  if (!isLiveItem(to) && isLiveItem(from)) {
    const siblings = (await c.query('SELECT status FROM bookings WHERE order_id=$1 AND id<>$2', [b.order_id, id])).rows;
    if (siblings.some((x) => isLiveItem(x.status))) {
      // One vehicle of a bigger order: the others carry on, re-priced without it (offers and tax may change).
      await repriceOrder(c, b.order_id, actor, `${to === 'rejected' ? 'Vehicle rejected' : 'Vehicle cancelled'}: ${b.ref}`);
    } else {
      // The whole order is closed: give back any offer uses.
      await c.query('UPDATE offer_redemptions SET released_at = now() WHERE order_id=$1 AND released_at IS NULL', [b.order_id]);
    }
  }
  const titles: Partial<Record<BookingStatus, string>> = {
    awaiting_payment: 'Booking approved: payment needed', confirmed: 'Booking confirmed', rejected: 'Booking declined',
    cancelled: 'Booking cancelled', in_progress: 'Your experience has started', completed: 'Booking completed',
    cancellation_requested: 'Cancellation requested',
  };
  if (titles[to]) {
    await notify(c, { customerId: b.customer_id, bookingId: id, kind: 'booking_' + to, title: titles[to]!, body: `Reference ${b.ref}`, dedupeKey: `status:${id}:${to}:${from}` });
  }
  return updated;
}

/** Recalculates the total of the order this booking belongs to (see orders.ts). Returns the order. */
export async function recalcTotal(c: C, bookingId: string, actor: Actor) {
  return recalcOrderTotal(c, await orderIdOf(c, bookingId), actor);
}

/** Works out the payment state of the order this booking belongs to (see orders.ts). Returns the order. */
export async function applyPaymentState(c: C, bookingId: string, actor: Actor) {
  return applyOrderPaymentState(c, await orderIdOf(c, bookingId), actor);
}

/**
 * Cancels unpaid bookings whose hold ran out: an unpaid 'awaiting_payment' booking, or a customer request that
 * staff did not approve in time. Safe to run repeatedly.
 */
export async function expireHolds(c: C): Promise<number> {
  const rows = (await c.query(
    `SELECT id, status FROM bookings WHERE status IN ('awaiting_payment','pending') AND hold_expires_at < now() AND paid_pence = 0
       AND NOT EXISTS (SELECT 1 FROM payments p WHERE p.order_id = bookings.order_id AND p.status='pending' AND p.created_at > now() - interval '10 minutes')`,
  )).rows;
  for (const r of rows) {
    const reason = r.status === 'pending' ? 'Request expired before it was approved' : 'Payment hold expired';
    await changeStatus(c, r.id, 'cancelled', { type: 'system' }, { reason });
  }
  return rows.length;
}

/** Refund the customer is due under the cancellation policy if they cancel now (preview only). */
export function policyRefund(b: { start_at: Date; paid_pence: number; refunded_pence: number }, s: Settings, now = new Date()) {
  const hoursAhead = (b.start_at.getTime() - now.getTime()) / 3_600_000;
  const net = b.paid_pence - b.refunded_pence;
  const pct = hoursAhead >= s['booking.cancellationFreeHours'] ? 100 : s['booking.cancellationLateRefundPercent'];
  return { percent: pct, refundPence: Math.floor((net * pct) / 100), hoursAhead: Math.floor(hoursAhead) };
}
