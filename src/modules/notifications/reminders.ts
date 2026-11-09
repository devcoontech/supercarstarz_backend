import type pg from 'pg';
import { notify } from './notify.js';

/**
 * Queues a "see you tomorrow" reminder for confirmed bookings starting in the next 24 hours: one per order, once
 * (the dedupe key makes reruns a no-op). Bookings made less than 36 hours before they start are skipped, since the
 * confirmation email arrived moments ago. Safe to run on several instances and as often as you like.
 */
export async function queueReminders(c: pg.PoolClient): Promise<number> {
  const rows = (await c.query(
    `SELECT DISTINCT ON (b.order_id) b.id, b.order_id, b.customer_id, o.ref
       FROM bookings b JOIN orders o ON o.id=b.order_id
      WHERE b.status IN ('confirmed','driver_assigned')
        AND b.start_at > now() AND b.start_at <= now() + interval '24 hours'
        AND b.start_at - b.created_at > interval '36 hours'
        AND NOT EXISTS (SELECT 1 FROM notifications n WHERE n.dedupe_key = 'reminder:' || b.order_id)
      ORDER BY b.order_id, b.start_at`,
  )).rows;
  for (const b of rows) {
    await notify(c, { customerId: b.customer_id, bookingId: b.id, kind: 'booking_reminder', title: 'Your booking is tomorrow', body: `Reference ${b.ref}`, dedupeKey: `reminder:${b.order_id}` });
  }
  return rows.length;
}

/**
 * "Payment due" reminder: a confirmed order that still has money to pay (a deposit was paid, or a charge or
 * extension was added) and starts within 3 days. Sent once per order as an in-app notification and phone push.
 */
export async function queueBalanceReminders(c: pg.PoolClient): Promise<number> {
  const rows = (await c.query(
    `SELECT DISTINCT ON (o.id) b.id, o.id AS order_id, o.customer_id, o.ref,
            GREATEST(0, o.total_pence - (o.paid_pence - o.refunded_pence)) AS owed
       FROM orders o JOIN bookings b ON b.order_id = o.id
      WHERE b.status IN ('confirmed','driver_assigned')
        AND b.start_at > now() AND b.start_at <= now() + interval '3 days'
        AND o.total_pence - (o.paid_pence - o.refunded_pence) > 0
        AND NOT EXISTS (SELECT 1 FROM notifications n WHERE n.dedupe_key = 'balance-due:' || o.id)
      ORDER BY o.id, b.start_at`,
  )).rows;
  for (const r of rows) {
    await notify(c, {
      customerId: r.customer_id, bookingId: r.id, kind: 'balance_due', dedupeKey: `balance-due:${r.order_id}`,
      title: 'Payment due', body: `£${(r.owed / 100).toFixed(2)} is left to pay on ${r.ref}. Open the booking to pay.`,
    });
  }
  return rows.length;
}
