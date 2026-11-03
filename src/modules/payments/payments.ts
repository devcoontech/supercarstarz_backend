import Stripe from 'stripe';
import type pg from 'pg';
import { pool, tx } from '../../core/db.js';
import { HttpError, badRequest, conflict, notFound } from '../../core/errors.js';
import { getSecret } from '../../core/settings.js';
import { notify } from '../notifications/notify.js';
import { applyPaymentState, lockBooking } from '../bookings/status.js';
import { logEvent, type Actor } from '../bookings/history.js';
import { loadOrderFinance } from '../finance/finance.js';
import { issuePaymentReceipt, issueRefundReceipt } from '../finance/documents.js';
import { isLiveItem, lockOrder } from '../bookings/orders.js';

type C = pg.PoolClient;

export async function getStripe(): Promise<Stripe> {
  const key = await getSecret('stripe.secretKey');
  if (!key) throw new HttpError(503, 'Stripe is not configured. Add the secret key in Admin > Settings > Payments.', 'stripe_not_configured');
  return new Stripe(key);
}

const PAYABLE = ['pending', 'awaiting_payment', 'confirmed', 'driver_assigned', 'in_progress'];

/** Card payment for the order a booking belongs to (one payment covers every vehicle in the order). */
export async function createPaymentIntent(bookingId: string, customerId: string, which: 'due_now' | 'balance') {
  const b = (await pool.query('SELECT order_id FROM bookings WHERE id=$1 AND customer_id=$2', [bookingId, customerId])).rows[0];
  if (!b) throw notFound('Booking not found');
  return createOrderPaymentIntent(b.order_id, customerId, which);
}

/**
 * Starts (or resumes) a card payment for what is owed on an order right now, worked out on the server from the
 * order's finance summary: the deposit still due, or the whole outstanding balance. The amount is never taken from the client.
 */
export async function createOrderPaymentIntent(orderId: string, customerId: string, which: 'due_now' | 'balance') {
  const o = (await pool.query('SELECT * FROM orders WHERE id=$1 AND customer_id=$2', [orderId, customerId])).rows[0];
  if (!o) throw notFound('Booking not found');
  const items = (await pool.query('SELECT id, status FROM bookings WHERE order_id=$1 ORDER BY created_at, ref', [orderId])).rows;
  const anchor = items.find((i) => PAYABLE.includes(i.status));
  if (!anchor) throw conflict('This booking cannot be paid in its current state', 'not_payable');
  const f = await loadOrderFinance(pool, orderId);
  const amount = which === 'due_now' ? f.dueNowPence : f.balanceDuePence;
  if (amount <= 0) throw conflict('Nothing is due on this booking', 'nothing_due');
  const stripe = await getStripe();

  // Reuse a still-open intent for the same amount so double-taps don't create duplicates.
  const open = (await pool.query(
    `SELECT provider_ref FROM payments WHERE order_id=$1 AND source='stripe' AND status='pending' AND amount_pence=$2 ORDER BY created_at DESC LIMIT 1`,
    [orderId, amount],
  )).rows[0];
  if (open) {
    const pi = await stripe.paymentIntents.retrieve(open.provider_ref);
    if (['requires_payment_method', 'requires_confirmation', 'requires_action'].includes(pi.status)) {
      return { clientSecret: pi.client_secret, paymentIntentId: pi.id, amountPence: amount, currency: o.currency, finance: f };
    }
  }
  const pi = await stripe.paymentIntents.create(
    {
      amount, currency: o.currency, automatic_payment_methods: { enabled: true },
      metadata: { order_id: o.id, booking_id: anchor.id, booking_ref: o.ref, customer_id: customerId },
      description: `Supercarstars booking ${o.ref}`,
    },
    { idempotencyKey: `pi:${o.id}:${amount}:${o.paid_pence}:${Date.now() - (Date.now() % 60000)}` },
  );
  await pool.query(
    `INSERT INTO payments(booking_id, order_id, customer_id, amount_pence, currency, method, source, purpose, status, provider_ref)
     VALUES ($1,$2,$3,$4,$5,'card','stripe',$6,'pending',$7)`,
    [anchor.id, o.id, customerId, amount, o.currency, which === 'due_now' && f.depositMode && f.netPaidPence === 0 ? 'deposit' : f.netPaidPence > 0 ? 'balance' : 'payment', pi.id],
  );
  return { clientSecret: pi.client_secret, paymentIntentId: pi.id, amountPence: amount, currency: o.currency, finance: f };
}

/**
 * Records a succeeded PaymentIntent against our ledger. The caller must have obtained `pi` from a
 * signature-verified webhook or directly from the Stripe API; the amount and currency must match what we created.
 */
async function settleSucceededIntent(c: C, pi: Stripe.PaymentIntent, actor: Actor): Promise<boolean> {
  const p = (await c.query('SELECT * FROM payments WHERE provider_ref=$1 FOR UPDATE', [pi.id])).rows[0];
  if (!p) return false;
  if (pi.amount_received !== p.amount_pence || pi.currency !== p.currency) {
    await logEvent(c, p.booking_id, actor, 'payment_mismatch', { meta: { expected: p.amount_pence, received: pi.amount_received, currency: pi.currency } });
    await notify(c, { bookingId: p.booking_id, staffOnly: true, kind: 'payment_mismatch', title: 'Stripe payment amount mismatch', body: pi.id, dedupeKey: `mismatch:${pi.id}` });
    return false;
  }
  if (p.status !== 'succeeded') {
    await c.query(`UPDATE payments SET status='succeeded', paid_at=now(), updated_at=now() WHERE id=$1`, [p.id]);
    await logEvent(c, p.booking_id, actor, 'payment_succeeded', { meta: { paymentId: p.id, amountPence: p.amount_pence } });
    await notify(c, { customerId: p.customer_id, bookingId: p.booking_id, kind: 'payment_received', title: 'Payment received', dedupeKey: `paid:${p.id}`, data: { amountPence: p.amount_pence, paymentId: p.id } });
    await applyPaymentState(c, p.booking_id, actor);
    await issuePaymentReceipt(c, p.id);
  }
  return true;
}

/** Compares one Stripe payment with the gateway's own record (fetched server-side) and stamps it reconciled if they agree. */
export async function reconcilePayment(paymentId: string, staffId: string) {
  const p = (await pool.query('SELECT * FROM payments WHERE id=$1', [paymentId])).rows[0];
  if (!p) throw notFound('Payment not found');
  if (p.source !== 'stripe') throw conflict('Manual payments have no gateway record to reconcile', 'not_stripe');
  const stripe = await getStripe();
  const pi = await stripe.paymentIntents.retrieve(p.provider_ref);
  const gatewayStatus = pi.status === 'succeeded' ? 'succeeded' : pi.status === 'canceled' ? 'canceled' : 'pending';
  return tx(async (c) => {
    const actor: Actor = { type: 'staff', id: staffId };
    let repaired = false;
    if (gatewayStatus === 'succeeded' && p.status !== 'succeeded') repaired = await settleSucceededIntent(c, pi, actor);
    const fresh = (await c.query('SELECT * FROM payments WHERE id=$1', [paymentId])).rows[0];
    const matches = fresh.status === gatewayStatus || (fresh.status === 'failed' && gatewayStatus === 'pending');
    if (matches) await c.query('UPDATE payments SET reconciled_at=now() WHERE id=$1', [paymentId]);
    return { paymentId, ledgerStatus: fresh.status, gatewayStatus, matches, repaired, reconciled: matches };
  });
}

/**
 * Processes a verified Stripe event exactly once. Payment success is only ever recorded here, from a
 * signature-verified event, and only if the amount and currency match the intent we created.
 */
export async function handleStripeEvent(event: Stripe.Event): Promise<{ handled: boolean; duplicate: boolean }> {
  return tx(async (c) => {
    const ins = await c.query(
      `INSERT INTO webhook_events(provider, event_id, type) VALUES ('stripe',$1,$2) ON CONFLICT DO NOTHING`, [event.id, event.type],
    );
    if (!ins.rowCount) return { handled: false, duplicate: true };
    const actor: Actor = { type: 'stripe' };

    if (event.type === 'payment_intent.succeeded') {
      const ok = await settleSucceededIntent(c, event.data.object as Stripe.PaymentIntent, actor);
      return { handled: ok, duplicate: false };
    }

    if (event.type === 'payment_intent.payment_failed' || event.type === 'payment_intent.canceled') {
      const pi = event.data.object as Stripe.PaymentIntent;
      const p = (await c.query('SELECT * FROM payments WHERE provider_ref=$1 FOR UPDATE', [pi.id])).rows[0];
      if (!p || p.status === 'succeeded') return { handled: false, duplicate: false };
      const status = event.type === 'payment_intent.canceled' ? 'canceled' : 'failed';
      await c.query(`UPDATE payments SET status=$2, updated_at=now() WHERE id=$1`, [p.id, status]);
      await logEvent(c, p.booking_id, actor, 'payment_' + status, { meta: { paymentId: p.id, message: pi.last_payment_error?.message } });
      await applyPaymentState(c, p.booking_id, actor);
      if (status === 'failed') {
        await notify(c, { customerId: p.customer_id, bookingId: p.booking_id, kind: 'payment_failed', title: 'Payment failed', body: 'Please try again or use another card.', dedupeKey: `payfail:${p.id}` });
      }
      return { handled: true, duplicate: false };
    }

    if (event.type === 'refund.updated' || event.type === 'refund.created') {
      const r = event.data.object as Stripe.Refund;
      const row = (await c.query('SELECT * FROM refunds WHERE provider_ref=$1 FOR UPDATE', [r.id])).rows[0];
      if (!row) return { handled: false, duplicate: false };
      const status = r.status === 'succeeded' ? 'succeeded' : r.status === 'failed' || r.status === 'canceled' ? 'failed' : 'pending';
      // Stripe does not deliver events in order: a refund only ever moves forward from pending, so a late,
      // older event can never revive a failed refund or reopen a completed one.
      if (row.status !== 'pending' || status === 'pending') return { handled: false, duplicate: false };
      await c.query(`UPDATE refunds SET status=$2 WHERE id=$1 AND status='pending'`, [row.id, status]);
      await applyPaymentState(c, row.booking_id, actor);
      if (status === 'succeeded') await issueRefundReceipt(c, row.id);
      return { handled: true, duplicate: false };
    }
    return { handled: false, duplicate: false };
  });
}

export type ManualMethod = 'cash' | 'card_terminal' | 'bank_transfer' | 'other';

/**
 * Money taken outside the app (cash, a card machine, bank transfer). Recorded under the staff member's name and
 * clearly labelled as manual: a manually recorded card payment is never treated as a verified gateway transaction.
 * Only a payment marked as received counts towards the amount paid.
 */
export async function recordManualPayment(
  c: C, p: {
    bookingId: string; amountPence: number; method: ManualMethod; reference?: string; purpose?: 'payment' | 'deposit' | 'balance'; staffId: string;
    paidAt?: string | null; status?: 'succeeded' | 'pending'; note?: string | null; idempotencyKey?: string | null;
  },
) {
  if (!Number.isInteger(p.amountPence) || p.amountPence <= 0) throw badRequest('Amount must be a positive number of pence');
  const b = await lockBooking(c, p.bookingId);
  const o = await lockOrder(c, b.order_id);
  if (p.idempotencyKey) {
    const ex = (await c.query('SELECT * FROM payments WHERE order_id=$1 AND idempotency_key=$2', [o.id, p.idempotencyKey])).rows[0];
    if (ex) return ex; // the same submission sent twice
  }
  const items = (await c.query('SELECT status FROM bookings WHERE order_id=$1', [o.id])).rows;
  if (!items.some((i) => isLiveItem(i.status))) throw conflict('This booking is closed', 'booking_closed');
  // Money is taken for the whole order, never more than it still owes.
  const outstanding = o.total_pence - (o.paid_pence - o.refunded_pence);
  if (p.amountPence > outstanding) throw conflict(`Amount exceeds the outstanding balance (£${(outstanding / 100).toFixed(2)})`, 'overpayment');
  const paidAt = p.paidAt ? new Date(p.paidAt) : new Date();
  if (Number.isNaN(paidAt.getTime()) || paidAt.getTime() > Date.now() + 5 * 60_000) throw badRequest('The payment date cannot be in the future', 'invalid_paid_at');
  const status = p.status ?? 'succeeded';
  const row = (await c.query(
    `INSERT INTO payments(booking_id, order_id, customer_id, amount_pence, currency, method, source, purpose, status, manual_reference, recorded_by, paid_at, note, idempotency_key)
     VALUES ($1,$13,$2,$3,$4,$5,'manual',$6,$7,$8,$9,$10,$11,$12) RETURNING *`,
    [b.id, b.customer_id, p.amountPence, o.currency, p.method, p.purpose ?? 'payment', status, p.reference ?? null, p.staffId,
     status === 'succeeded' ? paidAt : null, p.note ?? null, p.idempotencyKey ?? null, o.id],
  )).rows[0];
  const actor: Actor = { type: 'staff', id: p.staffId };
  await logEvent(c, b.id, actor, 'manual_payment_recorded', { to: status, meta: { paymentId: row.id, amountPence: p.amountPence, method: p.method, reference: p.reference, paidAt } });
  if (status === 'succeeded') await settleManual(c, row, actor);
  return (await c.query('SELECT * FROM payments WHERE id=$1', [row.id])).rows[0];
}

async function settleManual(c: C, row: any, actor: Actor) {
  await notify(c, { customerId: row.customer_id, bookingId: row.booking_id, kind: 'payment_received', title: 'Payment received', dedupeKey: `paid:${row.id}`, data: { amountPence: row.amount_pence, paymentId: row.id } });
  await applyPaymentState(c, row.booking_id, actor);
  await issuePaymentReceipt(c, row.id);
}

/** A pending manual payment becomes received (counted, receipt issued), or failed/cancelled (never counted). */
export async function setManualPaymentStatus(c: C, paymentId: string, to: 'succeeded' | 'failed' | 'canceled', staffId: string, paidAt?: string | null) {
  const p = (await c.query('SELECT * FROM payments WHERE id=$1', [paymentId])).rows[0];
  if (!p) throw notFound('Payment not found');
  const b = await lockBooking(c, p.booking_id);
  const o = await lockOrder(c, p.order_id);
  const row = (await c.query('SELECT * FROM payments WHERE id=$1 FOR UPDATE', [paymentId])).rows[0];
  if (row.source !== 'manual') throw conflict('Card payments made in the app are updated by the payment provider only', 'not_manual');
  if (row.status !== 'pending') throw conflict('Only a pending payment can be updated', 'not_pending');
  if (to === 'succeeded') {
    const outstanding = o.total_pence - (o.paid_pence - o.refunded_pence);
    if (row.amount_pence > outstanding) throw conflict(`Amount exceeds the outstanding balance (£${(outstanding / 100).toFixed(2)})`, 'overpayment');
  }
  const at = paidAt ? new Date(paidAt) : new Date();
  if (Number.isNaN(at.getTime()) || at.getTime() > Date.now() + 5 * 60_000) throw badRequest('The payment date cannot be in the future', 'invalid_paid_at');
  const updated = (await c.query('UPDATE payments SET status=$2, paid_at=$3, status_changed_by=$4, updated_at=now() WHERE id=$1 RETURNING *',
    [paymentId, to, to === 'succeeded' ? at : null, staffId])).rows[0];
  const actor: Actor = { type: 'staff', id: staffId };
  await logEvent(c, b.id, actor, 'manual_payment_status', { from: 'pending', to, meta: { paymentId, amountPence: row.amount_pence } });
  if (to === 'succeeded') await settleManual(c, updated, actor);
  else await applyPaymentState(c, b.id, actor);
  return (await c.query('SELECT * FROM payments WHERE id=$1', [paymentId])).rows[0];
}

export async function refundPayment(
  paymentId: string, amountPence: number, reason: string, staffId: string,
) {
  // The payment row stays locked from the "how much is left to refund" check until the refund is recorded, so two
  // refunds at once (a double click, two staff members) are handled one after the other and can't exceed it.
  return tx(async (c) => {
    const p = (await c.query('SELECT * FROM payments WHERE id=$1 FOR UPDATE', [paymentId])).rows[0];
    if (!p) throw notFound('Payment not found');
    if (p.status !== 'succeeded') throw conflict('Only successful payments can be refunded', 'not_refundable');
    const already = (await c.query(`SELECT COALESCE(sum(amount_pence),0)::int s FROM refunds WHERE payment_id=$1 AND status IN ('pending','succeeded')`, [paymentId])).rows[0].s;
    if (!Number.isInteger(amountPence) || amountPence <= 0 || amountPence > p.amount_pence - already) {
      throw badRequest(`Refund must be between 1 and ${p.amount_pence - already} pence`, 'invalid_refund');
    }
    const actor: Actor = { type: 'staff', id: staffId };
    if (p.source === 'stripe') {
      const stripe = await getStripe();
      const sr = await stripe.refunds.create({ payment_intent: p.provider_ref, amount: amountPence, reason: 'requested_by_customer', metadata: { payment_id: p.id } },
        { idempotencyKey: `refund:${p.id}:${already}:${amountPence}` });
      const status = sr.status === 'succeeded' ? 'succeeded' : sr.status === 'failed' || sr.status === 'canceled' ? 'failed' : 'pending';
      const r = (await c.query(
        `INSERT INTO refunds(payment_id, booking_id, order_id, amount_pence, reason, status, provider_ref, recorded_by) VALUES ($1,$2,$8,$3,$4,$5,$6,$7) RETURNING *`,
        [p.id, p.booking_id, amountPence, reason, status, sr.id, staffId, p.order_id])).rows[0];
      await logEvent(c, p.booking_id, actor, 'refund_recorded', { reason, meta: { refundId: r.id, amountPence, status } });
      await notify(c, { customerId: p.customer_id, bookingId: p.booking_id, kind: 'refund', title: 'Refund issued', dedupeKey: `refund:${r.id}`, data: { amountPence } });
      await applyPaymentState(c, p.booking_id, actor);
      if (status === 'succeeded') await issueRefundReceipt(c, r.id);
      return r;
    }
    // Manual payments are refunded outside Stripe; we only record that it happened.
    const r = (await c.query(
      `INSERT INTO refunds(payment_id, booking_id, order_id, amount_pence, reason, status, recorded_by) VALUES ($1,$2,$6,$3,$4,'succeeded',$5) RETURNING *`,
      [p.id, p.booking_id, amountPence, reason, staffId, p.order_id])).rows[0];
    await logEvent(c, p.booking_id, actor, 'refund_recorded', { reason, meta: { refundId: r.id, amountPence, manual: true } });
    await notify(c, { customerId: p.customer_id, bookingId: p.booking_id, kind: 'refund', title: 'Refund issued', dedupeKey: `refund:${r.id}`, data: { amountPence } });
    await applyPaymentState(c, p.booking_id, actor);
    await issueRefundReceipt(c, r.id);
    return r;
  });
}
