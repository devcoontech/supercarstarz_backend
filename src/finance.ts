import type pg from 'pg';
import { DateTime } from 'luxon';
import type { Q } from './db.js';
import { badRequest, conflict, notFound } from './errors.js';
import { getSettings } from './settings.js';
import { lockBooking, logEvent, notify, recalcTotal, type Actor } from './bookings.js';
import { orderStatus } from './orders.js';

type C = pg.PoolClient;

/*
 * Booking money, in one place. Money belongs to the order (one or more vehicles booked together); a vehicle's screens
 * show its order's figures. Every screen, receipt and payment request reads from here, so the displayed total,
 * the amount sent to the gateway, the recorded payments and the receipts always agree.
 *
 *   final total  = quoted price (rental + driver + add-ons + fees - discount, frozen at booking)
 *                + confirmed charges (delivery, adjustments; credits are negative)
 *   net paid     = succeeded payments - refunds (pending refunds count, to be safe)
 *   balance due  = final total - net paid, never below zero (an overpayment shows as a credit instead)
 *
 * Pending delivery estimates are shown but never counted. All amounts are integer pence.
 */

const CLOSED = ['cancelled', 'rejected'];
const gbp = (pence: number) => (pence < 0 ? '-' : '') + '£' + (Math.abs(pence) / 100).toLocaleString('en-GB', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

export type Finance = {
  currency: string;
  quotedTotalPence: number;
  confirmedChargesPence: number;
  delivery: null | { status: 'pending' | 'confirmed'; amountPence: number; distanceMiles: number | null; ratePerMilePence: number | null };
  finalTotalPence: number;
  depositRequiredPence: number;
  depositMode: boolean;
  depositPaid: boolean;
  paidPence: number;
  refundedPence: number;
  netPaidPence: number;
  balanceDuePence: number;
  /** The part of the deposit (or full amount, without deposits) still to pay before the booking is secured. */
  dueNowPence: number;
  creditPence: number;
  paymentStatus: string;
};

type BookingMoney = {
  status: string; currency: string; quoted_total_pence: number; total_pence: number; deposit_due_pence: number;
  paid_pence: number; refunded_pence: number; payment_status: string;
};
type ChargeRow = { kind: string; status: string; amount_pence: number; distance_miles: number | null; rate_per_mile_pence: number | null };

export function summarize(b: BookingMoney, charges: ChargeRow[]): Finance {
  const net = b.paid_pence - b.refunded_pence;
  const closed = CLOSED.includes(b.status);
  const live = charges.filter((c) => c.status !== 'void');
  const d = live.find((c) => c.kind === 'delivery');
  const depositMode = b.deposit_due_pence < b.quoted_total_pence;
  return {
    currency: b.currency,
    quotedTotalPence: b.quoted_total_pence,
    confirmedChargesPence: live.filter((c) => c.status === 'confirmed').reduce((s, c) => s + c.amount_pence, 0),
    delivery: d ? { status: d.status as 'pending' | 'confirmed', amountPence: d.amount_pence, distanceMiles: d.distance_miles == null ? null : Number(d.distance_miles), ratePerMilePence: d.rate_per_mile_pence } : null,
    finalTotalPence: b.total_pence,
    depositRequiredPence: b.deposit_due_pence,
    depositMode,
    depositPaid: depositMode && net >= b.deposit_due_pence,
    paidPence: b.paid_pence,
    refundedPence: b.refunded_pence,
    netPaidPence: net,
    balanceDuePence: closed ? 0 : Math.max(0, b.total_pence - net),
    dueNowPence: closed ? 0 : Math.max(0, Math.min(b.deposit_due_pence, b.total_pence) - net),
    creditPence: closed ? 0 : Math.max(0, net - b.total_pence),
    paymentStatus: b.payment_status,
  };
}

/** The order's money, as seen from one of its vehicles (delivery shows that vehicle's delivery charge). */
export async function loadFinance(q: Q, bookingId: string): Promise<Finance> {
  const b = (await q.query('SELECT order_id FROM bookings WHERE id=$1', [bookingId])).rows[0];
  if (!b) throw notFound('Booking not found');
  return loadOrderFinance(q, b.order_id, bookingId);
}

export async function loadOrderFinance(q: Q, orderId: string, bookingId?: string): Promise<Finance> {
  const o = (await q.query('SELECT * FROM orders WHERE id=$1', [orderId])).rows[0];
  if (!o) throw notFound('Order not found');
  const items = (await q.query('SELECT status FROM bookings WHERE order_id=$1', [orderId])).rows;
  const charges = (await q.query(
    `SELECT kind, status, amount_pence, distance_miles, rate_per_mile_pence FROM booking_charges WHERE ${bookingId ? 'booking_id' : 'order_id'}=$1 ORDER BY created_at`, [bookingId ?? orderId])).rows;
  return summarize({ ...o, status: orderStatus(items) }, charges);
}

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

export async function bookingAddons(q: Q, bookingId: string) {
  return (await q.query(
    `SELECT id, addon_id AS "addonId", name, pricing_type AS "pricingType", unit_price_pence AS "unitPricePence", quantity, hours, total_pence AS "totalPence"
       FROM booking_addons WHERE booking_id=$1 ORDER BY created_at, name`, [bookingId])).rows;
}

/* ---------- Delivery charge and adjustments ---------- */

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

/* ---------- Receipts, notes and statements ---------- */

export type DocKind = 'deposit_receipt' | 'payment_receipt' | 'full_payment_receipt' | 'refund_receipt' | 'adjustment_note' | 'credit_note';
const PREFIX: Record<DocKind, string> = {
  deposit_receipt: 'DEP', payment_receipt: 'RCT', full_payment_receipt: 'RCT', refund_receipt: 'RFD', adjustment_note: 'ADJ', credit_note: 'CRN',
};
export const DOC_TITLES: Record<DocKind, string> = {
  deposit_receipt: 'Deposit receipt', payment_receipt: 'Payment receipt', full_payment_receipt: 'Final payment receipt',
  refund_receipt: 'Refund receipt', adjustment_note: 'Booking adjustment', credit_note: 'Credit note',
};
const METHOD: Record<string, string> = { card: 'Card', cash: 'Cash', card_terminal: 'Card', bank_transfer: 'Bank transfer', other: 'Other' };
export const methodLabel = (p: { method: string; source: string }) =>
  p.source === 'stripe' ? 'Card (online, verified by the payment provider)' : `${METHOD[p.method] ?? p.method} (recorded by staff)`;

/** Everything printed on a document, frozen at the moment it is issued: the whole order, every vehicle. */
async function docContext(q: Q, bookingId: string) {
  const s = await getSettings(q);
  const anchor = (await q.query('SELECT order_id FROM bookings WHERE id=$1', [bookingId])).rows[0];
  if (!anchor) throw notFound('Booking not found');
  const o = (await q.query(
    `SELECT o.*, c.name AS customer_name, c.email AS customer_email, c.phone AS customer_phone FROM orders o JOIN customers c ON c.id=o.customer_id WHERE o.id=$1`, [anchor.order_id])).rows[0];
  const rows = (await q.query(
    `SELECT b.*, v.make, v.model, v.year, v.category, e.title AS event_title FROM bookings b JOIN vehicles v ON v.id=b.vehicle_id
       LEFT JOIN event_types e ON e.id=b.event_type_id WHERE b.order_id=$1 ORDER BY b.created_at, b.ref`, [o.id])).rows;
  const charges = (await q.query(
    `SELECT ch.description, ch.amount_pence, b.ref FROM booking_charges ch JOIN bookings b ON b.id=ch.booking_id WHERE ch.order_id=$1 AND ch.status='confirmed' ORDER BY ch.created_at`, [o.id])).rows;
  const live = rows.filter((r) => !['cancelled', 'rejected'].includes(r.status));
  const counted = live.length ? live : rows;
  const snap = o.pricing_snapshot ?? {};
  const legacyOffer = rows[0]?.pricing_snapshot?.offer;
  const net = o.paid_pence - o.refunded_pence;
  const multi = rows.length > 1;
  return {
    business: { name: s['company.name'], address: s['company.address'], email: s['company.supportEmail'], phone: s['company.supportPhone'], vatNumber: s['company.vatNumber'] },
    timezone: s['booking.timezone'],
    customer: { name: o.customer_name, email: o.customer_email, phone: o.customer_phone },
    order: { id: o.id, ref: o.ref, vehicles: counted.length, status: orderStatus(rows) },
    // `booking` keeps the shape older documents used, for the first vehicle.
    booking: { id: rows[0].id, ref: multi ? o.ref : rows[0].ref },
    items: rows.map((b) => ({
      ref: b.ref, status: b.status, counted: counted.includes(b), startAt: b.start_at, endAt: b.end_at, hours: b.hours, event: b.event_title, driverOption: b.driver_option,
      collection: b.experience === 'delivered' ? 'delivery' : 'showroom', address: b.experience === 'delivered' ? b.address : null,
      pickupAddress: b.pickup_address, dropoffAddress: b.dropoff_address,
      vehicle: { make: b.make, model: b.model, year: b.year, category: b.category },
      lines: (b.pricing_snapshot?.lines ?? []) as { key: string; label: string; amountPence: number }[],
      subtotalPence: (b.pricing_snapshot?.lines ?? []).reduce((t: number, l: { amountPence: number }) => t + l.amountPence, 0),
    })),
    subtotalPence: o.subtotal_pence,
    offers: (snap.offers ?? (legacyOffer && o.discount_pence ? [{ title: legacyOffer.title, code: legacyOffer.code, discountPence: o.discount_pence }] : []))
      .map((x: { title: string; code: string | null; discountPence: number; conditions?: string }) => ({ title: x.title, code: x.code, discountPence: x.discountPence, conditions: x.conditions ?? null })),
    discountPence: o.discount_pence,
    taxablePence: o.taxable_pence,
    tax: { enabled: o.tax_enabled || o.tax_pence > 0, label: o.tax_label, rateBp: o.tax_rate_bp, policy: o.tax_policy },
    taxPence: o.tax_pence,
    serviceFeePence: o.fee_pence,
    charges: charges.map((x) => ({ description: multi ? `${x.description} (${x.ref})` : x.description, amountPence: x.amount_pence })),
    currency: o.currency,
    quotedTotalPence: o.quoted_total_pence,
    bookingTotalPence: o.total_pence,
    depositRequiredPence: o.deposit_due_pence,
    paidToDatePence: net,
    refundedToDatePence: o.refunded_pence,
    balancePence: Math.max(0, o.total_pence - net),
    customerId: o.customer_id,
  };
}

async function issue(c: C, p: {
  kind: DocKind; bookingId: string; amountPence: number; paymentId?: string; refundId?: string; chargeId?: string; action?: string; transaction: Record<string, unknown>;
}) {
  const ctx = await docContext(c, p.bookingId);
  const n = (await c.query(`SELECT nextval('invoice_number_seq') AS n`)).rows[0].n;
  const { customerId, ...data } = ctx;
  return (await c.query(
    `INSERT INTO invoices(number, booking_id, customer_id, kind, payment_id, refund_id, charge_id, currency, amount_pence, booking_total_pence, paid_to_date_pence, balance_pence, data)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) RETURNING *`,
    [`${PREFIX[p.kind]}-${n}`, p.bookingId, customerId, p.kind, p.paymentId ?? null, p.refundId ?? null, p.chargeId ?? null, ctx.currency, p.amountPence,
     ctx.bookingTotalPence, ctx.paidToDatePence, ctx.balancePence, JSON.stringify({ ...data, action: p.action ?? null, transaction: p.transaction })])).rows[0];
}

/** One receipt per succeeded payment. Call after the booking's payment state is updated. Safe to call twice. */
export async function issuePaymentReceipt(c: C, paymentId: string) {
  const existing = (await c.query('SELECT * FROM invoices WHERE payment_id=$1', [paymentId])).rows[0];
  if (existing) return existing;
  const p = (await c.query('SELECT * FROM payments WHERE id=$1', [paymentId])).rows[0];
  if (!p || p.status !== 'succeeded') return null;
  const b = (await c.query('SELECT total_pence, quoted_total_pence, deposit_due_pence, paid_pence, refunded_pence FROM orders WHERE id=$1', [p.order_id])).rows[0];
  const net = b.paid_pence - b.refunded_pence;
  const before = net - p.amount_pence;
  const kind: DocKind = net >= b.total_pence ? 'full_payment_receipt'
    : b.deposit_due_pence < b.quoted_total_pence && (p.purpose === 'deposit' || before < b.deposit_due_pence) ? 'deposit_receipt'
    : 'payment_receipt';
  return issue(c, {
    kind, bookingId: p.booking_id, paymentId, amountPence: p.amount_pence,
    transaction: {
      amountPence: p.amount_pence, method: methodLabel(p), verified: p.source === 'stripe', source: p.source,
      reference: p.provider_ref ?? p.manual_reference ?? null, paidAt: p.paid_at ?? p.updated_at, status: 'Paid',
    },
  });
}

export async function issueRefundReceipt(c: C, refundId: string) {
  const existing = (await c.query('SELECT * FROM invoices WHERE refund_id=$1', [refundId])).rows[0];
  if (existing) return existing;
  const r = (await c.query('SELECT r.*, p.method, p.source FROM refunds r JOIN payments p ON p.id=r.payment_id WHERE r.id=$1', [refundId])).rows[0];
  if (!r || r.status !== 'succeeded') return null;
  return issue(c, {
    kind: 'refund_receipt', bookingId: r.booking_id, refundId, amountPence: -r.amount_pence,
    transaction: { amountPence: -r.amount_pence, method: r.source === 'stripe' ? 'Refund to the original card' : `${METHOD[r.method] ?? r.method} refund (recorded by staff)`, reference: r.provider_ref, paidAt: r.created_at, status: 'Refunded' },
  });
}

async function issueChargeNote(c: C, charge: any, previous: any | null, action: 'confirm' | 'void') {
  const exists = (await c.query(`SELECT 1 FROM invoices WHERE charge_id=$1 AND data->>'action'=$2`, [charge.id, action])).rowCount;
  if (exists) return;
  const amount = action === 'void' ? -charge.amount_pence : charge.amount_pence - (previous?.amount_pence ?? 0);
  if (amount === 0 && action === 'confirm' && previous) return; // details changed but not the money
  await issue(c, {
    kind: amount >= 0 ? 'adjustment_note' : 'credit_note', bookingId: charge.booking_id, chargeId: charge.id, action, amountPence: amount,
    transaction: {
      amountPence: amount, description: action === 'void' ? `Removed: ${charge.description}` : charge.description,
      previousPence: previous?.amount_pence ?? null, newPence: action === 'void' ? 0 : charge.amount_pence, paidAt: new Date().toISOString(), status: 'Added to booking total',
    },
  });
}

/* ---------- HTML documents (print or save as PDF from the browser or phone) ---------- */

const esc = (v: unknown) => String(v ?? '').replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch]!);
const fmt = (iso: string | Date, tz: string, f = 'd LLL yyyy, HH:mm') => DateTime.fromJSDate(new Date(iso)).setZone(tz).toFormat(f);
const row = (label: string, value: string, strong = false) => `<tr${strong ? ' class="strong"' : ''}><td>${esc(label)}</td><td class="num">${esc(value)}</td></tr>`;

function page(title: string, body: string) {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="color-scheme" content="light"><title>${esc(title)}</title>
<style>
  :root{color-scheme:light} body{font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;color:#15161a;background:#fff;margin:0;padding:24px;font-size:14px;line-height:1.45}
  .doc{max-width:760px;margin:0 auto}
  header{display:flex;justify-content:space-between;gap:16px;flex-wrap:wrap;border-bottom:3px solid #e2a200;padding-bottom:14px;margin-bottom:18px}
  h1{font-size:22px;margin:0 0 4px} h2{font-size:15px;margin:22px 0 8px} .muted{color:#5b5e66} .small{font-size:12px}
  table{width:100%;border-collapse:collapse} td,th{padding:7px 4px;border-bottom:1px solid #e6e7ea;text-align:left;vertical-align:top} th{font-size:12px;color:#5b5e66;font-weight:600}
  .num{text-align:right;white-space:nowrap} tr.strong td{font-weight:700;border-top:2px solid #15161a}
  .grid{display:grid;grid-template-columns:1fr 1fr;gap:4px 24px} .box{background:#fff8e1;border:1px solid #f0d27a;border-radius:8px;padding:12px 14px;margin:16px 0}
  .pill{display:inline-block;padding:2px 8px;border-radius:99px;background:#eef0f3;font-size:12px}
  .actions{margin:0 auto 16px;max-width:760px;text-align:right} .actions button{padding:9px 16px;border-radius:8px;border:1px solid #c9ccd2;background:#fff;color:#15161a;cursor:pointer;font-size:14px}
  @media print{.actions{display:none} body{padding:0}}
  @media (max-width:560px){.grid{grid-template-columns:1fr}}
</style></head><body><div class="actions"><button onclick="window.print()">Print or save as PDF</button></div><div class="doc">${body}</div></body></html>`;
}

type Ctx = Awaited<ReturnType<typeof docContext>>;
type Shown = Omit<Ctx, 'customerId'>;

function header(ctx: Pick<Shown, 'business' | 'timezone'>, title: string, number: string | null, issuedAt: string | Date) {
  const biz = ctx.business;
  return `<header><div><h1>${esc(title)}</h1>${number ? `<div><b>No. ${esc(number)}</b></div>` : ''}<div class="muted small">Issued ${esc(fmt(issuedAt, ctx.timezone))}</div></div>
    <div style="text-align:right"><b>${esc(biz.name)}</b>${biz.address ? `<div class="small">${esc(biz.address)}</div>` : ''}
    ${biz.email ? `<div class="small">${esc(biz.email)}</div>` : ''}${biz.phone ? `<div class="small">${esc(biz.phone)}</div>` : ''}${biz.vatNumber ? `<div class="small">VAT ${esc(biz.vatNumber)}</div>` : ''}</div></header>`;
}

const pct = (bp: number) => `${(bp / 100).toFixed(bp % 100 ? 2 : 0)}%`;

/** Who is billed and what was booked: every vehicle in the order (documents issued before orders show one). */
function bookingBlock(ctx: any) {
  if (!ctx.items) return legacyBookingBlock(ctx);
  const items = ctx.items as Shown['items'];
  const vehicle = (it: Shown['items'][number]) => {
    const where = it.pickupAddress ? `Pick-up ${it.pickupAddress}, drop-off ${it.dropoffAddress}` : it.collection === 'delivery' ? `Delivered to ${it.address}` : 'Collected from the showroom';
    return `<div style="margin-bottom:8px"><b>${esc(`${it.vehicle.make} ${it.vehicle.model}`)}</b> <span class="pill">${esc(it.ref)}</span>${it.counted ? '' : ' <span class="pill">Cancelled, not charged</span>'}
      <div class="small">${esc(fmt(it.startAt, ctx.timezone, 'cccc d LLLL yyyy, HH:mm'))} to ${esc(fmt(it.endAt, ctx.timezone, 'HH:mm'))} (${it.hours} h)</div>
      <div class="small">${it.driverOption === 'with_driver' ? 'With driver' : 'Self-drive'} · ${esc(where)}${it.event ? ` · ${esc(it.event)}` : ''}</div></div>`;
  };
  return `<div class="grid">
    <div><h2>Billed to</h2>${esc(ctx.customer.name)}<div class="small">${esc(ctx.customer.email)}${ctx.customer.phone ? ` · ${esc(ctx.customer.phone)}` : ''}</div></div>
    <div><h2>Booking ${esc(ctx.order.ref)}${items.length > 1 ? ` · ${ctx.order.vehicles} vehicles` : ''}</h2>${items.map(vehicle).join('')}</div></div>`;
}

/** The price: each vehicle's own charges, then the order's offers, tax, fee and confirmed extras. */
function chargesTable(ctx: any) {
  if (!ctx.items) return legacyChargesTable(ctx);
  const items = (ctx.items as Shown['items']).filter((i) => i.counted);
  const rows: string[] = [];
  for (const it of items) {
    if (items.length > 1) rows.push(`<tr><td colspan="2"><b>${esc(`${it.vehicle.make} ${it.vehicle.model}`)}</b> <span class="muted small">${esc(it.ref)}</span></td></tr>`);
    for (const l of it.lines) rows.push(row(l.label, gbp(l.amountPence)));
  }
  rows.push(row('Subtotal', gbp(ctx.subtotalPence), true));
  for (const o of ctx.offers) rows.push(row(`Discount: ${o.title}${o.code ? ` (${o.code})` : ''}`, gbp(-o.discountPence)));
  if (ctx.tax.enabled) {
    rows.push(row(`Taxable amount${ctx.tax.policy === 'before_discount' ? ' (before discounts)' : ''}`, gbp(ctx.taxablePence)));
    rows.push(row(`${ctx.tax.label} at ${pct(ctx.tax.rateBp)}`, gbp(ctx.taxPence)));
  }
  if (ctx.serviceFeePence) rows.push(row('Service fee', gbp(ctx.serviceFeePence)));
  for (const ch of ctx.charges) rows.push(row(ch.description, gbp(ch.amountPence)));
  rows.push(row('Booking total', gbp(ctx.bookingTotalPence), true));
  return `<h2>Booking charges</h2><table><tbody>${rows.join('')}</tbody></table>`;
}

function legacyBookingBlock(ctx: any) {
  const b = ctx.booking;
  const where = b.pickupAddress ? `Pick-up ${b.pickupAddress}, drop-off ${b.dropoffAddress}` : b.collection === 'delivery' ? `Delivered to ${b.address}` : 'Collected from the showroom';
  return `<div class="grid">
    <div><h2>Billed to</h2>${esc(ctx.customer.name)}<div class="small">${esc(ctx.customer.email)}${ctx.customer.phone ? ` · ${esc(ctx.customer.phone)}` : ''}</div></div>
    <div><h2>Booking ${esc(b.ref)}</h2>${esc(`${b.vehicle.make} ${b.vehicle.model} (${b.vehicle.year})`)}
      <div class="small">${esc(fmt(b.startAt, ctx.timezone, 'cccc d LLLL yyyy, HH:mm'))} to ${esc(fmt(b.endAt, ctx.timezone, 'HH:mm'))} (${b.hours} h)</div>
      <div class="small">${b.driverOption === 'with_driver' ? 'With driver' : 'Self-drive'} · ${esc(where)}</div>${b.event ? `<div class="small">${esc(b.event)}</div>` : ''}</div></div>`;
}

function legacyChargesTable(ctx: any) {
  const rows = ctx.lines.map((l: { label: string; amountPence: number }) => row(l.label, gbp(l.amountPence)));
  if (ctx.discountPence) rows.push(row(`Discount${ctx.offerTitle ? ` (${ctx.offerTitle})` : ''}`, gbp(-ctx.discountPence)));
  if (ctx.serviceFeePence) rows.push(row('Service fee', gbp(ctx.serviceFeePence)));
  if (ctx.vatPence) rows.push(row('VAT', gbp(ctx.vatPence)));
  for (const ch of ctx.charges) rows.push(row(ch.description, gbp(ch.amountPence)));
  rows.push(row('Booking total', gbp(ctx.bookingTotalPence), true));
  return `<h2>Booking charges</h2><table><tbody>${rows.join('')}</tbody></table>`;
}

/** A receipt or note exactly as issued. */
export function renderDocument(doc: { number: string; kind: DocKind; issued_at: Date; amount_pence: number; data: any }) {
  const d = doc.data;
  const t = d.transaction ?? {};
  const isPayment = ['deposit_receipt', 'payment_receipt', 'full_payment_receipt'].includes(doc.kind);
  const thisLine = isPayment ? 'Paid in this transaction' : doc.kind === 'refund_receipt' ? 'Refunded in this transaction' : 'Change to the booking total';
  const summary = [
    row(thisLine, gbp(doc.amount_pence), true),
    ...(t.method ? [row('Payment method', t.method)] : []),
    ...(t.reference ? [row('Reference', t.reference)] : []),
    ...(t.paidAt ? [row(isPayment ? 'Payment date' : 'Date', fmt(t.paidAt, d.timezone))] : []),
    row('Status', t.status ?? ''),
  ];
  const totals = [
    row('Booking total', gbp(d.bookingTotalPence)),
    row('Paid to date (after refunds)', gbp(d.paidToDatePence)),
    row('Outstanding balance', gbp(d.balancePence), true),
  ];
  const note = doc.kind === 'deposit_receipt' || (doc.kind === 'payment_receipt' && d.balancePence > 0)
    ? `<div class="box">This receipt is for ${esc(gbp(doc.amount_pence))} paid towards booking ${esc(d.booking.ref)}. It is not a receipt for the full booking: ${esc(gbp(d.balancePence))} is still to pay.</div>`
    : doc.kind === 'full_payment_receipt' ? `<div class="box">Booking ${esc(d.booking.ref)} is now paid in full.</div>`
    : doc.kind === 'adjustment_note' || doc.kind === 'credit_note'
      ? `<div class="box">${esc(t.description ?? '')}${t.previousPence != null ? ` (was ${esc(gbp(t.previousPence))}, now ${esc(gbp(t.newPence))})` : ''}. The booking total is now ${esc(gbp(d.bookingTotalPence))}.</div>` : '';
  return page(`${DOC_TITLES[doc.kind]} ${doc.number}`, `${header(d, DOC_TITLES[doc.kind], doc.number, doc.issued_at)}${bookingBlock(d)}${note}
    <h2>This transaction</h2><table><tbody>${summary.join('')}</tbody></table>${chargesTable(d)}<h2>Balance</h2><table><tbody>${totals.join('')}</tbody></table>
    <p class="muted small">Amounts in ${esc(String(d.currency).toUpperCase())}. ${t.verified === false ? 'This payment was recorded by our staff.' : ''}</p>`);
}

/** The booking's current financial summary, worked out now. */
export async function renderStatement(q: Q, bookingId: string) {
  const ctx = await docContext(q, bookingId);
  const orderId = ctx.order.id;
  const f = await loadOrderFinance(q, orderId);
  const pays = (await q.query(`SELECT * FROM payments WHERE order_id=$1 AND status IN ('succeeded','failed','pending') ORDER BY COALESCE(paid_at, created_at)`, [orderId])).rows;
  const refunds = (await q.query(`SELECT * FROM refunds WHERE order_id=$1 AND status IN ('pending','succeeded') ORDER BY created_at`, [orderId])).rows;
  const docs = (await q.query(`SELECT number, kind, amount_pence, issued_at FROM invoices WHERE order_id=$1 ORDER BY issued_at`, [orderId])).rows;
  const payRows = pays.map((p) => `<tr><td>${esc(fmt(p.paid_at ?? p.created_at, ctx.timezone))}</td><td>${esc(methodLabel(p))}</td><td>${p.status === 'succeeded' ? 'Paid' : p.status === 'failed' ? 'Failed (not counted)' : 'Pending (not counted)'}</td><td class="num">${esc(gbp(p.amount_pence))}</td></tr>`);
  const refundRows = refunds.map((r) => `<tr><td>${esc(fmt(r.created_at, ctx.timezone))}</td><td>Refund</td><td>${r.status === 'pending' ? 'Pending' : 'Refunded'}</td><td class="num">${esc(gbp(-r.amount_pence))}</td></tr>`);
  const pending = f.delivery?.status === 'pending'
    ? `<div class="box">Delivery is estimated at ${esc(gbp(f.delivery.amountPence))}. It is not included above until our team confirms the final charge.</div>` : '';
  const totals = [
    row('Booking total', gbp(f.finalTotalPence)),
    ...(f.depositMode ? [row(`Deposit required${f.depositPaid ? ' (paid)' : ''}`, gbp(f.depositRequiredPence))] : []),
    row('Payments received', gbp(f.paidPence)),
    ...(f.refundedPence ? [row('Refunded', gbp(-f.refundedPence))] : []),
    row(f.creditPence ? 'Credit due to you' : 'Outstanding balance', gbp(f.creditPence || f.balanceDuePence), true),
  ];
  const { customerId, ...shown } = ctx;
  return page(`Booking ${ctx.order.ref} financial summary`, `${header(shown, 'Booking financial summary', null, new Date())}${bookingBlock(shown)}${chargesTable(shown)}${pending}
    <h2>Payments and refunds</h2>${payRows.length || refundRows.length ? `<table><thead><tr><th>Date</th><th>Method</th><th>Status</th><th class="num">Amount</th></tr></thead><tbody>${[...payRows, ...refundRows].join('')}</tbody></table>` : '<p class="muted">No payments yet.</p>'}
    <h2>Summary</h2><table><tbody>${totals.join('')}</tbody></table>
    ${docs.length ? `<h2>Documents issued</h2><table><tbody>${docs.map((x) => row(`${DOC_TITLES[x.kind as DocKind]} ${x.number} · ${fmt(x.issued_at, ctx.timezone, 'd LLL yyyy')}`, gbp(x.amount_pence))).join('')}</tbody></table>` : ''}
    <p class="muted small">Amounts in ${esc(String(ctx.currency).toUpperCase())}. This summary reflects the booking as of the date above.</p>`);
}

/** Receipts for an order (given any of its vehicles, or the order itself) or for a customer. */
export async function invoicesFor(q: Q, where: 'booking' | 'order' | 'customer', id: string) {
  const cond = where === 'booking' ? 'i.order_id = (SELECT order_id FROM bookings WHERE id=$1)' : where === 'order' ? 'i.order_id=$1' : 'i.customer_id=$1';
  return (await q.query(
    `SELECT i.id, i.number, i.kind, i.amount_pence AS "amountPence", i.currency, i.booking_total_pence AS "bookingTotalPence", i.paid_to_date_pence AS "paidToDatePence",
            i.balance_pence AS "balancePence", i.issued_at AS "issuedAt", i.payment_id AS "paymentId", o.ref AS "bookingRef", b.id AS "bookingId", o.id AS "orderId"
       FROM invoices i JOIN bookings b ON b.id=i.booking_id JOIN orders o ON o.id=i.order_id WHERE ${cond} ORDER BY i.issued_at DESC`, [id])).rows;
}
