import type pg from 'pg';
import { DateTime } from 'luxon';
import type { Q } from '../../core/db.js';
import { notFound } from '../../core/errors.js';
import { getSettings } from '../../core/settings.js';
import { orderStatus } from '../bookings/orders.js';
import { gbp, loadOrderFinance } from './finance.js';
import { logoDataUri } from '../notifications/layout.js';

/** Receipts, credit notes and statements: numbering, issuing, and the printable HTML. */

type C = pg.PoolClient;

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

export async function issueChargeNote(c: C, charge: any, previous: any | null, action: 'confirm' | 'void') {
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
  .brandbar{background:#000;border-radius:12px 12px 0 0;padding:14px 18px;text-align:center;border-bottom:4px solid #ffc41f;margin-bottom:18px;-webkit-print-color-adjust:exact;print-color-adjust:exact} .brandbar img{display:inline-block;width:150px;height:auto}
  .actions{margin:0 auto 16px;max-width:760px;text-align:right} .actions button{padding:9px 16px;border-radius:8px;border:1px solid #c9ccd2;background:#fff;color:#15161a;cursor:pointer;font-size:14px}
  @media print{.actions{display:none} body{padding:0}}
  @media (max-width:560px){.grid{grid-template-columns:1fr}}
</style></head><body><div class="actions"><button onclick="window.print()">Print or save as PDF</button></div><div class="doc">${body}</div></body></html>`;
}

type Ctx = Awaited<ReturnType<typeof docContext>>;

type Shown = Omit<Ctx, 'customerId'>;

function header(ctx: Pick<Shown, 'business' | 'timezone'>, title: string, number: string | null, issuedAt: string | Date) {
  const biz = ctx.business;
  const logo = logoDataUri();
  return `${logo ? `<div class="brandbar"><img src="${logo}" alt="${esc(biz.name)}" width="150"></div>` : ''}<header><div><h1>${esc(title)}</h1>${number ? `<div><b>No. ${esc(number)}</b></div>` : ''}<div class="muted small">Issued ${esc(fmt(issuedAt, ctx.timezone))}</div></div>
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
