import { DateTime } from 'luxon';
import { pool } from './db.js';
import { getSettings, type Settings } from './settings.js';
import { getMailer, type Mail } from './mailer.js';
import { DOC_TITLES, renderDocument, type DocKind } from './finance.js';

/*
 * Customer emails for booking events. Rows are queued by notify() (bookings.ts) in the same transaction as the
 * in-app notification; this file turns them into messages and sends them.
 *
 * Rules: customer-facing wording only (never internal notes, staff names or cancel reasons), and a row is only
 * marked 'sent' when the provider says it accepted the message.
 */

const MAX_ATTEMPTS = 5;
const gbp = (pence: number) => '£' + (pence / 100).toLocaleString('en-GB', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

type Booking = {
  ref: string; start_at: Date; end_at: Date; hours: number; experience: string; address: string | null; status: string;
  total_pence: number; paid_pence: number; refunded_pence: number; deposit_due_pence: number; vehicle: string; event: string | null;
};
type Receipt = { number: string; kind: DocKind; issued_at: Date; amount_pence: number; data: any };
type Ctx = { first: string; booking: Booking; settings: Settings; payload: Record<string, unknown>; receipt?: Receipt | null };

const when = (b: Booking, tz: string) => {
  const s = DateTime.fromJSDate(b.start_at, { zone: tz });
  const e = DateTime.fromJSDate(b.end_at, { zone: tz });
  return `${s.toFormat('cccc d LLLL yyyy')}, ${s.toFormat('HH:mm')} to ${e.toFormat('HH:mm')} (${b.hours} ${b.hours === 1 ? 'hour' : 'hours'})`;
};

const details = (x: Ctx) => {
  const b = x.booking;
  return [
    `Booking reference: ${b.ref}`,
    `Car: ${b.vehicle}`,
    ...(b.event ? [`Event: ${b.event}`] : []),
    `When: ${when(b, x.settings['booking.timezone'])}`,
    `Where: ${b.experience === 'delivered' ? `Delivered to ${b.address}` : 'At our location. We will send the address before your booking.'}`,
    `Total: ${gbp(b.total_pence)}`,
  ].join('\n');
};

const TEMPLATES: Record<string, (x: Ctx) => { subject: string; body: string }> = {
  booking_received: (x) => ({
    subject: x.settings['booking.requireApproval'] ? `We've received your booking request (${x.booking.ref})` : `Booking created: complete payment (${x.booking.ref})`,
    body: [
      `Hi ${x.first},`,
      '',
      x.settings['booking.requireApproval']
        ? "Thanks for your booking request. We'll review it and email you as soon as it's confirmed. You'll be asked to pay securely in the app once it is. Nothing has been charged yet."
        : `Thanks for your booking. We're holding the car for ${x.settings['booking.holdMinutes']} minutes. Open the app and pay to confirm it.`,
      '',
      details(x),
    ].join('\n'),
  }),
  booking_awaiting_payment: (x) => {
    const due = Math.max(0, x.booking.deposit_due_pence - (x.booking.paid_pence - x.booking.refunded_pence));
    return {
      subject: `Your booking is approved: payment needed (${x.booking.ref})`,
      body: [
        `Hi ${x.first},`,
        '',
        `Good news: we've approved your booking. To confirm it, please pay ${gbp(due)} in the app (My Bookings, then Pay now). We're holding the car for ${x.settings['booking.holdMinutes']} minutes; after that it may be released to someone else.`,
        '',
        details(x),
      ].join('\n'),
    };
  },
  refund: (x) => {
    const amount = Number(x.payload.amountPence ?? 0);
    return {
      subject: `Refund issued for ${x.booking.ref}`,
      body: [
        `Hi ${x.first},`,
        '',
        `We've issued a refund${amount ? ` of ${gbp(amount)}` : ''} for booking ${x.booking.ref}. Card refunds usually take 5 to 10 working days to appear, depending on your bank.`,
        '',
        `Refunded in total: ${gbp(x.booking.refunded_pence)}`,
      ].join('\n'),
    };
  },
  booking_confirmed: (x) => {
    const owed = Math.max(0, x.booking.total_pence - (x.booking.paid_pence - x.booking.refunded_pence));
    return {
      subject: `Your booking is confirmed (${x.booking.ref})`,
      body: [`Hi ${x.first},`, '', "Good news: your booking is confirmed.", '', details(x), ...(owed > 0 ? ['', `A balance of ${gbp(owed)} is still to pay. You can pay it in the app under My Bookings.`] : [])].join('\n'),
    };
  },
  payment_received: (x) => {
    const amount = Number(x.payload.amountPence ?? 0);
    const net = x.booking.paid_pence - x.booking.refunded_pence;
    const owed = Math.max(0, x.booking.total_pence - net);
    return {
      subject: `Payment verified for ${x.booking.ref}${x.receipt ? ` (receipt ${x.receipt.number})` : ''}`,
      body: [
        `Hi ${x.first},`,
        '',
        `We've received and verified your payment${amount ? ` of ${gbp(amount)}` : ''}. Thank you.`,
        ...(x.receipt ? ['', `Your ${DOC_TITLES[x.receipt.kind].toLowerCase()} ${x.receipt.number} is attached. Open it in a browser to print it or save it as a PDF.`] : []),
        '',
        details(x),
        `Paid so far: ${gbp(net)} of ${gbp(x.booking.total_pence)}`,
        owed > 0 ? `Still to pay: ${gbp(owed)}. You can pay it in the app under My Bookings.` : 'Nothing further to pay.',
      ].join('\n'),
    };
  },
  charge_confirmed: (x) => {
    const amount = Number(x.payload.amountPence ?? 0);
    const previous = x.payload.previousPence == null ? null : Number(x.payload.previousPence);
    const owed = Math.max(0, x.booking.total_pence - (x.booking.paid_pence - x.booking.refunded_pence));
    return {
      subject: `Your booking total has been updated (${x.booking.ref})`,
      body: [
        `Hi ${x.first},`,
        '',
        previous != null ? `We've updated a charge on your booking from ${gbp(previous)} to ${gbp(amount)}.` : `We've confirmed a charge of ${gbp(amount)} on your booking.`,
        '',
        `Booking reference: ${x.booking.ref}`,
        `New booking total: ${gbp(x.booking.total_pence)}`,
        owed > 0 ? `Still to pay: ${gbp(owed)}. You can pay it in the app under My Bookings.` : 'Nothing further to pay.',
      ].join('\n'),
    };
  },
  charge_removed: (x) => {
    const owed = Math.max(0, x.booking.total_pence - (x.booking.paid_pence - x.booking.refunded_pence));
    return {
      subject: `A charge was removed from your booking (${x.booking.ref})`,
      body: [
        `Hi ${x.first},`,
        '',
        `We've removed ${String(x.payload.body ?? 'a charge')} from your booking.`,
        '',
        `Booking reference: ${x.booking.ref}`,
        `New booking total: ${gbp(x.booking.total_pence)}`,
        owed > 0 ? `Still to pay: ${gbp(owed)}.` : 'Nothing further to pay. If you have paid more than the new total, our team will arrange a refund.',
      ].join('\n'),
    };
  },
  booking_cancelled: (x) => {
    const net = x.booking.paid_pence - x.booking.refunded_pence;
    return {
      subject: `Your booking ${x.booking.ref} has been cancelled`,
      body: [
        `Hi ${x.first},`,
        '',
        `Your booking ${x.booking.ref} for the ${x.booking.vehicle} on ${when(x.booking, x.settings['booking.timezone'])} has been cancelled.`,
        '',
        net > 0 ? "Our team will arrange any refund you're due and confirm it separately." : 'Nothing was charged for this booking.',
      ].join('\n'),
    };
  },
};

/** A change to the booking (new time, car, driver, extension...): the notification's own wording plus the current details. */
const bookingUpdate = (subject: string) => (x: Ctx) => ({
  subject: `${String(x.payload.title ?? subject)} (${x.booking.ref})`,
  body: [`Hi ${x.first},`, '', `There's an update to your booking: ${String(x.payload.title ?? subject).toLowerCase()}.`, ...(x.payload.body ? [String(x.payload.body)] : []), '', 'Your booking now:', details(x)].join('\n'),
});
TEMPLATES.rescheduled = bookingUpdate('Booking rescheduled');
TEMPLATES.vehicle_changed = bookingUpdate('Your car has changed');
TEMPLATES.vehicle_added = bookingUpdate('A car was added to your booking');
TEMPLATES.booking_extended = bookingUpdate('Booking extended');
TEMPLATES.driver_assigned = bookingUpdate('Driver assigned');
TEMPLATES.extension_rejected = (x) => ({
  subject: `About your extension request (${x.booking.ref})`,
  body: [`Hi ${x.first},`, '', "Sorry, we can't extend your booking this time.", ...(x.payload.body ? ['', String(x.payload.body)] : []), '', 'Your booking is unchanged:', details(x)].join('\n'),
});

const footer = (s: Settings) =>
  ['', '', '—', s['company.name'], ...(s['company.supportEmail'] ? [`Questions? ${s['company.supportEmail']}`] : []), ...(s['company.supportPhone'] ? [`Call us: ${s['company.supportPhone']}`] : [])].join('\n');

export type OutboxResult = { sent: number; retrying: number; failed: number; skipped: number };

/**
 * Sends due emails. Safe to run on several instances at once (rows are claimed with SKIP LOCKED) and
 * to run repeatedly. Failures retry with growing delays, then stop at MAX_ATTEMPTS.
 */
export async function processOutbox(limit = 10): Promise<OutboxResult> {
  const out: OutboxResult = { sent: 0, retrying: 0, failed: 0, skipped: 0 };
  const rows = (await pool.query(
    `UPDATE email_outbox SET status='sending', attempts = attempts + 1, locked_at = now()
      WHERE id IN (SELECT id FROM email_outbox
                    WHERE (status='pending' AND next_attempt_at <= now()) OR (status='sending' AND locked_at < now() - interval '5 minutes')
                    ORDER BY created_at LIMIT $1 FOR UPDATE SKIP LOCKED)
      RETURNING *`, [limit])).rows;
  if (!rows.length) return out;
  const settings = await getSettings();

  for (const r of rows) {
    const finish = (status: string, error: string | null = null, delayMin = 0) =>
      pool.query(
        `UPDATE email_outbox SET status=$2, last_error=$3, locked_at=NULL, sent_at = CASE WHEN $2='sent' THEN now() ELSE sent_at END,
                next_attempt_at = now() + ($4 || ' minutes')::interval WHERE id=$1`, [r.id, status, error, String(delayMin)]);
    try {
      const c = (await pool.query('SELECT name, email FROM customers WHERE id=$1', [r.customer_id])).rows[0];
      const b = (await pool.query(
        // Money is the order's (all vehicles booked together); the reference is the order's.
        `SELECT o.ref, b.start_at, b.end_at, b.hours, b.experience, b.address, b.status, o.total_pence, o.paid_pence, o.refunded_pence, o.deposit_due_pence,
                v.make || ' ' || v.model || CASE WHEN (SELECT count(*) FROM bookings x WHERE x.order_id=o.id AND x.status NOT IN ('cancelled','rejected')) > 1
                  THEN ' and ' || ((SELECT count(*) FROM bookings x WHERE x.order_id=o.id AND x.status NOT IN ('cancelled','rejected')) - 1) || ' more' ELSE '' END AS vehicle,
                e.title AS event
           FROM bookings b JOIN orders o ON o.id=b.order_id JOIN vehicles v ON v.id=b.vehicle_id LEFT JOIN event_types e ON e.id=b.event_type_id WHERE b.id=$1`, [r.booking_id])).rows[0];
      const template = TEMPLATES[r.kind];
      if (!c?.email || !b || !template) {
        await finish('skipped', 'missing customer, booking or template');
        out.skipped++;
        continue;
      }
      // A payment email carries its receipt (issued in the same transaction as the payment).
      const receipt: Receipt | null = r.kind === 'payment_received' && r.payload?.paymentId
        ? (await pool.query('SELECT number, kind, issued_at, amount_pence, data FROM invoices WHERE payment_id=$1', [r.payload.paymentId])).rows[0] ?? null
        : null;
      const t = template({ first: c.name.split(' ')[0], booking: b, settings, payload: r.payload, receipt });
      const mail: Mail = {
        to: c.email, subject: t.subject, text: t.body + footer(settings),
        attachments: receipt ? [{ filename: `${receipt.number}.html`, content: renderDocument(receipt), contentType: 'text/html; charset=utf-8' }] : undefined,
      };
      const res = await getMailer().send(mail);
      if (res.sent) {
        await finish('sent');
        out.sent++;
      } else if (res.reason === 'no_mail_provider_configured') {
        // Not sending stale mail later if a provider is configured: record it plainly instead.
        await finish('skipped', 'no mail provider configured');
        out.skipped++;
      } else if (r.attempts >= MAX_ATTEMPTS) {
        await finish('failed', res.reason ?? 'send failed');
        out.failed++;
      } else {
        await finish('pending', res.reason ?? 'send failed', r.attempts * 5);
        out.retrying++;
      }
    } catch (e) {
      const msg = (e as Error).message;
      if (r.attempts >= MAX_ATTEMPTS) { await finish('failed', msg); out.failed++; } else { await finish('pending', msg, r.attempts * 5); out.retrying++; }
    }
  }
  return out;
}
