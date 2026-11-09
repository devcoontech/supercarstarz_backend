import type pg from 'pg';
import { getSettings } from '../../core/settings.js';

/** In-app notifications, and the emails and pushes queued with them. */

type C = pg.PoolClient;

/** Booking events a customer is also emailed about. Add a kind here and a template in emails.ts to extend. */
export const EMAIL_KINDS = new Set([
  'booking_received', 'booking_awaiting_payment', 'booking_confirmed', 'payment_received', 'payment_failed', 'booking_cancelled', 'booking_rejected',
  'booking_cancellation_requested', 'booking_completed', 'booking_reminder', 'refund', 'charge_confirmed', 'charge_removed',
  // Changes to a booking: emailed with the notification's own title and text.
  'rescheduled', 'vehicle_changed', 'vehicle_added', 'booking_extended', 'extension_rejected',
  // Not 'driver_assigned': the customer sees that in the app only, with no email.
]);

/**
 * Events the company owner is emailed about (Settings > Business > Owner notification emails). Queued only when
 * an owner address is set, so nothing piles up unsent.
 */
export const OWNER_EMAIL_KINDS = new Set([
  'booking_received', 'booking_confirmed', 'booking_cancellation_requested', 'booking_cancelled',
  'extension_requested', 'booking_extended', 'overpaid', 'payment_after_release', 'payment_mismatch',
]);

/**
 * In-app notification, plus queued emails in the same transaction: to the customer (EMAIL_KINDS) and to the owner
 * (OWNER_EMAIL_KINDS). The dedupe key makes retried webhooks / double clicks a no-op for all of them. Sending
 * happens later, in emails.ts, and only after commit.
 */
export async function notify(
  c: C, p: { customerId?: string | null; bookingId?: string; kind: string; title: string; body?: string; dedupeKey: string; staffOnly?: boolean; data?: Record<string, unknown>;
    /** Override whether the owner is emailed (default: when the kind is in OWNER_EMAIL_KINDS). */
    ownerEmail?: boolean },
) {
  const r = await c.query(
    `INSERT INTO notifications(customer_id, booking_id, kind, title, body, dedupe_key, staff_only)
     VALUES ($1,$2,$3,$4,$5,$6,$7) ON CONFLICT (dedupe_key) DO NOTHING RETURNING id`,
    [p.customerId ?? null, p.bookingId ?? null, p.kind, p.title, p.body ?? null, p.dedupeKey, p.staffOnly ?? false],
  );
  if (!r.rowCount) return;
  const payload = JSON.stringify({ title: p.title, body: p.body ?? null, ...p.data });
  const queue = (recipient: 'customer' | 'owner', customerId: string | null) => c.query(
    `INSERT INTO email_outbox(notification_id, customer_id, booking_id, kind, payload, recipient) VALUES ($1,$2,$3,$4,$5,$6)
     ON CONFLICT (notification_id, recipient) DO NOTHING`,
    [r.rows[0].id, customerId, p.bookingId ?? null, p.kind, payload, recipient],
  );
  if (p.customerId && !p.staffOnly && EMAIL_KINDS.has(p.kind)) await queue('customer', p.customerId);
  // Every notification the customer can see in the app also goes to their phones, if they have the app signed in.
  if (p.customerId && !p.staffOnly) {
    await c.query(
      `INSERT INTO push_outbox(notification_id, customer_id, booking_id, title, body)
       SELECT $1::uuid, $2::uuid, $3::uuid, $4::text, $5::text WHERE EXISTS (SELECT 1 FROM push_tokens WHERE customer_id=$2::uuid)
       ON CONFLICT (notification_id) DO NOTHING`,
      [r.rows[0].id, p.customerId, p.bookingId ?? null, p.title, p.body ?? null],
    );
  }
  if (p.bookingId && (p.ownerEmail ?? OWNER_EMAIL_KINDS.has(p.kind))) {
    const s = await getSettings(c);
    if ((s['notifications.ownerEmails'] || s['company.supportEmail']).trim()) await queue('owner', null);
  }
}
