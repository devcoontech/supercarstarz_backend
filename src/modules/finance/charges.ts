import type pg from 'pg';
import type { Q } from '../../core/db.js';
import { badRequest, conflict, notFound } from '../../core/errors.js';
import { notify } from '../notifications/notify.js';
import { lockBooking, recalcTotal } from '../bookings/status.js';
import { logEvent, type Actor } from '../bookings/history.js';
import { CLOSED, gbp } from './finance.js';
import { issueChargeNote } from './documents.js';

/** Extra charges on a booking: the delivery charge, one-off adjustments and credits. */

type C = pg.PoolClient;

/** Charges for staff, with who approved or voided them. Includes voided rows so the history stays visible. */
export async function chargesForStaff(q: Q, bookingId: string) {
  return (await q.query(
    `SELECT ch.id, ch.kind, ch.status, ch.amount_pence AS "amountPence", ch.currency, ch.description, ch.address, ch.distance_miles AS "distanceMiles",
            ch.rate_per_mile_pence AS "ratePerMilePence", ch.calculated_pence AS "calculatedPence", ch.supersedes_id AS "supersedesId",
            ch.created_at AS "createdAt", s.name AS "approvedBy", ch.voided_at AS "voidedAt", vs.name AS "voidedBy", ch.void_reason AS "voidReason"
       FROM booking_charges ch LEFT JOIN staff_users s ON s.id=ch.created_by LEFT JOIN staff_users vs ON vs.id=ch.voided_by
      WHERE ch.booking_id=$1 ORDER BY ch.created_at`, [bookingId])).rows;
}

/** Charges a customer may see: live ones only, no staff names or internal reasons. */
export async function chargesForCustomer(q: Q, bookingId: string) {
  return (await q.query(
    `SELECT id, kind, status, amount_pence AS "amountPence", currency, description, distance_miles AS "distanceMiles", rate_per_mile_pence AS "ratePerMilePence", created_at AS "createdAt"
       FROM booking_charges WHERE booking_id=$1 AND status <> 'void' ORDER BY created_at`, [bookingId])).rows;
}

const milesTimesRate = (miles: number, rate: number) => Math.round((Math.round(miles * 100) * rate) / 100);

/**
 * Confirms (or amends) the delivery charge. The live charge is voided and replaced, never edited, so the
 * charge can't be counted twice and its history stays readable. The total and balance are recalculated.
 */
export async function setDeliveryCharge(
  c: C, bookingId: string, p: { distanceMiles: number | null; ratePerMilePence: number; finalPence: number; address?: string | null; reason?: string | null }, staffId: string,
) {
  const b = await lockBooking(c, bookingId);
  if (b.experience !== 'delivered') throw conflict('This booking is collected from the showroom, so it has no delivery charge', 'not_delivery');
  if (CLOSED.includes(b.status)) throw conflict('This booking is closed', 'booking_closed');
  if ((b.pricing_snapshot?.lines ?? []).some((l: { key: string }) => l.key === 'delivery')) {
    throw conflict("Delivery is already included in this booking's quoted price", 'delivery_in_quote');
  }
  if (!Number.isInteger(p.finalPence) || p.finalPence < 0) throw badRequest('The final charge must be zero or more', 'invalid_amount');
  const calculated = p.distanceMiles == null ? null : milesTimesRate(p.distanceMiles, p.ratePerMilePence);
  const cur = (await c.query(`SELECT * FROM booking_charges WHERE booking_id=$1 AND kind='delivery' AND status <> 'void' FOR UPDATE`, [bookingId])).rows[0];
  if (cur?.status === 'confirmed' && cur.amount_pence === p.finalPence && (cur.distance_miles == null ? null : Number(cur.distance_miles)) === p.distanceMiles && cur.rate_per_mile_pence === p.ratePerMilePence) {
    return cur; // the same confirmation sent twice changes nothing
  }
  if (cur) {
    await c.query(`UPDATE booking_charges SET status='void', voided_at=now(), voided_by=$2, void_reason=$3 WHERE id=$1`,
      [cur.id, staffId, cur.status === 'pending' ? 'Estimate replaced by the confirmed charge' : p.reason || 'Amended']);
  }
  const description = p.distanceMiles == null ? 'Delivery' : `Delivery (${p.distanceMiles} ${p.distanceMiles === 1 ? 'mile' : 'miles'} at ${gbp(p.ratePerMilePence)}/mile)`;
  const row = (await c.query(
    `INSERT INTO booking_charges(booking_id, kind, status, amount_pence, currency, description, address, distance_miles, rate_per_mile_pence, calculated_pence, supersedes_id, created_by)
     VALUES ($1,'delivery','confirmed',$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *`,
    [bookingId, p.finalPence, b.currency, description, p.address?.trim() || cur?.address || b.address, p.distanceMiles, p.ratePerMilePence, calculated, cur?.id ?? null, staffId])).rows[0];
  const actor: Actor = { type: 'staff', id: staffId };
  const previous = cur?.status === 'confirmed' ? cur : null;
  await logEvent(c, bookingId, actor, previous ? 'delivery_charge_amended' : 'delivery_charge_confirmed', {
    from: previous ? gbp(previous.amount_pence) : null, to: gbp(p.finalPence), reason: p.reason ?? null,
    meta: { chargeId: row.id, distanceMiles: p.distanceMiles, ratePerMilePence: p.ratePerMilePence, calculatedPence: calculated, finalPence: p.finalPence },
  });
  const after = await recalcTotal(c, bookingId, actor);
  await issueChargeNote(c, row, previous, 'confirm');
  const balance = Math.max(0, after.total_pence - (after.paid_pence - after.refunded_pence));
  await notify(c, {
    customerId: b.customer_id, bookingId, kind: 'charge_confirmed', dedupeKey: `charge:${row.id}`,
    title: previous ? 'Delivery charge updated' : 'Delivery charge confirmed',
    body: `Delivery: ${gbp(p.finalPence)}. Booking total ${gbp(after.total_pence)}${balance ? `, ${gbp(balance)} left to pay` : ''}.`,
    data: { amountPence: p.finalPence, previousPence: previous?.amount_pence ?? null, totalPence: after.total_pence, balancePence: balance },
  });
  return row;
}

/** Removes a charge (e.g. the customer switched to showroom collection). A confirmed charge gets a credit note. */
export async function voidCharge(c: C, bookingId: string, chargeId: string, reason: string, staffId: string) {
  await lockBooking(c, bookingId);
  const ch = (await c.query('SELECT * FROM booking_charges WHERE id=$1 AND booking_id=$2 FOR UPDATE', [chargeId, bookingId])).rows[0];
  if (!ch) throw notFound('Charge not found');
  if (ch.status === 'void') return ch;
  const row = (await c.query(`UPDATE booking_charges SET status='void', voided_at=now(), voided_by=$2, void_reason=$3 WHERE id=$1 RETURNING *`, [chargeId, staffId, reason])).rows[0];
  const actor: Actor = { type: 'staff', id: staffId };
  await logEvent(c, bookingId, actor, `${ch.kind}_charge_removed`, { from: gbp(ch.amount_pence), reason, meta: { chargeId, status: ch.status } });
  const after = await recalcTotal(c, bookingId, actor);
  if (ch.status === 'confirmed') {
    await issueChargeNote(c, ch, null, 'void');
    const b = (await c.query('SELECT customer_id FROM bookings WHERE id=$1', [bookingId])).rows[0];
    await notify(c, {
      customerId: b.customer_id, bookingId, kind: 'charge_removed', dedupeKey: `chargevoid:${chargeId}`, title: 'A charge was removed from your booking',
      body: `${ch.description} (${gbp(ch.amount_pence)})`, data: { amountPence: ch.amount_pence, totalPence: after.total_pence },
    });
  }
  return row;
}

/** A confirmed one-off charge (positive) or credit (negative), with a reason. */
export async function addAdjustment(c: C, bookingId: string, p: { amountPence: number; description: string }, staffId: string) {
  const b = await lockBooking(c, bookingId);
  if (CLOSED.includes(b.status)) throw conflict('This booking is closed', 'booking_closed');
  if (!Number.isInteger(p.amountPence) || p.amountPence === 0) throw badRequest('Enter a charge or a credit amount', 'invalid_amount');
  if (b.total_pence + p.amountPence < 0) throw conflict('A credit cannot take the booking total below zero', 'negative_total');
  const row = (await c.query(
    `INSERT INTO booking_charges(booking_id, kind, status, amount_pence, currency, description, created_by) VALUES ($1,'adjustment','confirmed',$2,$3,$4,$5) RETURNING *`,
    [bookingId, p.amountPence, b.currency, p.description.trim(), staffId])).rows[0];
  const actor: Actor = { type: 'staff', id: staffId };
  await logEvent(c, bookingId, actor, p.amountPence > 0 ? 'charge_added' : 'credit_added', { to: gbp(p.amountPence), reason: p.description, meta: { chargeId: row.id } });
  const after = await recalcTotal(c, bookingId, actor);
  await issueChargeNote(c, row, null, 'confirm');
  await notify(c, {
    customerId: b.customer_id, bookingId, kind: 'charge_confirmed', dedupeKey: `charge:${row.id}`,
    title: p.amountPence > 0 ? 'A charge was added to your booking' : 'A credit was added to your booking',
    body: `${p.description.trim()}: ${gbp(p.amountPence)}. Booking total ${gbp(after.total_pence)}.`,
    data: { amountPence: p.amountPence, totalPence: after.total_pence },
  });
  return row;
}
