import fs from 'node:fs';
import path from 'node:path';
import { DEFAULT_SETTINGS, type Settings } from '../core/settings.js';
import { buildBookingEmail, CUSTOMER_TEMPLATE_KINDS, OWNER_TEMPLATE_KINDS, type EmailCtx } from '../modules/notifications/emails.js';
import { resetCodeEmail, testEmail, welcomeEmail } from '../modules/notifications/account-emails.js';
import { logoDataUri } from '../modules/notifications/layout.js';

/*
 * Writes every email template, filled with sample data, to ./email-previews/ (open index.html in a browser).
 * No database or mail server needed:  npm run email:preview
 */

const out = path.resolve(process.argv[2] ?? 'email-previews');
fs.mkdirSync(out, { recursive: true });

const settings: Settings = {
  ...DEFAULT_SETTINGS,
  'company.supportEmail': 'hello@supercarstars.com', 'company.supportPhone': '020 3000 0000',
  'company.address': '1 Showroom Way, London', 'company.dashboardUrl': 'https://admin.supercarstars.com',
} as Settings;

const at = (days: number, hour: number) => { const d = new Date(); d.setDate(d.getDate() + days); d.setHours(hour, 0, 0, 0); return d; };
const start = at(9, 14), end = at(9, 16);
const item = {
  id: 'b1', ref: 'SCS-1042', status: 'confirmed', start_at: start, end_at: end, hours: 2, experience: 'delivered', address: '24 Rosewood Avenue, Kingston KT1 2AB',
  pickup_address: null, dropoff_address: null, driver_option: 'with_driver', children: 8, occasion: "Leo's 7th birthday", customer_notes: 'Please arrive quietly, it is a surprise!',
  admin_notes: 'Repeat customer', pricing_snapshot: { lines: [{ label: 'Lamborghini Huracán, 2 hours', amountPence: 40000 }, { label: 'Delivery (6.2 miles)', amountPence: 2700 }, { label: 'Driver', amountPence: 10000 }] },
  vehicle: 'Lamborghini Huracán', year: 2023, event: 'Birthday party', driver_name: 'Daniel', driver_phone: '07700 900123',
};
const ctx = (over: Partial<{ paid: number; refunded: number; payload: Record<string, unknown>; receipt: any }> = {}): EmailCtx => {
  const total = 55335, paid = over.paid ?? 55335, refunded = over.refunded ?? 0;
  return {
    first: 'Sarah', customer: { name: 'Sarah Thompson', email: 'sarah@example.com', phone: '07700 900456' },
    booking: { ref: 'SCS-1042', item_ref: 'SCS-1042', start_at: start, end_at: end, hours: 2, experience: 'delivered', address: item.address, pickup_address: null, dropoff_address: null,
      status: 'confirmed', driver_option: 'with_driver', total_pence: total, paid_pence: paid, refunded_pence: refunded, deposit_due_pence: 16600, vehicle: 'Lamborghini Huracán', event: 'Birthday party' },
    order: { id: 'o1', ref: 'SCS-1042', source: 'customer_app', created_at: at(-3, 18), subtotal_pence: 52700, discount_pence: 0, tax_pence: 0, fee_pence: 2635, tax_label: 'VAT',
      payment_status: paid >= total ? 'paid' : paid ? 'deposit_paid' : 'unpaid', pricing_snapshot: {}, total_pence: total, paid_pence: paid, refunded_pence: refunded, deposit_due_pence: 16600 },
    items: [item], charges: [], settings, payload: over.payload ?? {}, receipt: over.receipt ?? null,
  };
};
const receipt = (kind: string, n: string, paidTo: number) => ({ number: n, kind, issued_at: new Date(), amount_pence: 0, data: { bookingTotalPence: 55335, paidToDatePence: paidTo, balancePence: 55335 - paidTo } });

const samples: [string, string, 'customer' | 'owner', EmailCtx][] = [
  ['customer-booking-received', 'booking_received', 'customer', ctx({ paid: 0 })],
  ['customer-booking-approved-pay', 'booking_awaiting_payment', 'customer', ctx({ paid: 0 })],
  ['customer-booking-confirmed', 'booking_confirmed', 'customer', ctx({ paid: 16600 })],
  ['customer-payment-deposit', 'payment_received', 'customer', ctx({ paid: 16600, payload: { amountPence: 16600 }, receipt: receipt('deposit_receipt', 'DEP-1007', 16600) })],
  ['customer-paid-in-full-invoice', 'payment_received', 'customer', ctx({ payload: { amountPence: 38735 }, receipt: receipt('full_payment_receipt', 'RCT-1008', 55335) })],
  ['customer-payment-failed', 'payment_failed', 'customer', ctx({ paid: 0 })],
  ['customer-reminder', 'booking_reminder', 'customer', ctx()],
  ['customer-booking-completed', 'booking_completed', 'customer', ctx()],
  ['customer-driver-assigned', 'driver_assigned', 'customer', ctx({ payload: { title: 'Driver assigned', body: 'Daniel will be your driver.' } })],
  ['customer-rescheduled', 'rescheduled', 'customer', ctx({ payload: { title: 'Booking rescheduled' } })],
  ['customer-charge-updated', 'charge_confirmed', 'customer', ctx({ paid: 52635, payload: { amountPence: 2700, previousPence: null } })],
  ['customer-cancellation-requested', 'booking_cancellation_requested', 'customer', ctx()],
  ['customer-booking-cancelled', 'booking_cancelled', 'customer', ctx({ paid: 0 })],
  ['customer-booking-rejected', 'booking_rejected', 'customer', ctx({ paid: 0 })],
  ['customer-refund', 'refund', 'customer', ctx({ refunded: 55335, payload: { amountPence: 55335 } })],
  ['customer-extension-declined', 'extension_rejected', 'customer', ctx({ payload: { body: 'The car is booked straight after you.' } })],
  ['owner-new-booking-request', 'booking_received', 'owner', ctx({ paid: 0 })],
  ['owner-booking-confirmed-details', 'booking_confirmed', 'owner', ctx({ paid: 16600 })],
  ['owner-cancellation-requested', 'booking_cancellation_requested', 'owner', ctx()],
  ['owner-booking-cancelled', 'booking_cancelled', 'owner', ctx()],
  ['owner-extension-requested', 'extension_requested', 'owner', ctx({ payload: { title: 'Extension requested for SCS-1042', body: '1 extra hour requested' } })],
  ['owner-booking-extended', 'booking_extended', 'owner', ctx({ payload: { title: 'Booking extended', body: 'SCS-1042 now ends at 16:00.' } })],
  ['owner-overpaid', 'overpaid', 'owner', ctx({ paid: 60000, payload: { title: 'Booking SCS-1042 is overpaid by £46.65', body: 'Refund the difference.' } })],
];

const logo = logoDataUri();
const show = (html: string) => (logo ? html.replaceAll('cid:logo@supercarstars', logo) : html);
const links: string[] = [];
const write = (name: string, subject: string, html: string, group: string) => {
  fs.writeFileSync(path.join(out, `${name}.html`), show(html));
  links.push(`<li data-g="${group}"><a href="${name}.html" target="view">${name.replace(/^(customer|owner|account)-/, '').replace(/-/g, ' ')}</a><small>${subject.replace(/</g, '&lt;')}</small></li>`);
};
for (const [name, kind, who, x] of samples) {
  const e = buildBookingEmail(kind, who, x);
  if (e) write(name, e.subject, e.html, who);
}
for (const [name, m] of [
  ['account-welcome', welcomeEmail('sarah@example.com', 'Sarah Thompson', settings)],
  ['account-password-reset', resetCodeEmail('sarah@example.com', 'Sarah Thompson', '482913', settings)],
  ['account-test-email', testEmail('owner@supercarstars.com', settings)],
] as const) write(name, m.subject, m.html!, 'account');

const group = (g: string, title: string) => `<h3>${title}</h3><ul>${links.filter((l) => l.includes(`data-g="${g}"`)).join('')}</ul>`;
fs.writeFileSync(path.join(out, 'index.html'), `<!doctype html><meta charset="utf-8"><title>Supercarstars email templates</title>
<style>body{margin:0;display:grid;grid-template-columns:320px 1fr;height:100vh;font-family:system-ui,sans-serif;background:#08090c;color:#f4f4f6}
nav{overflow:auto;padding:18px;border-right:1px solid #222} h2{color:#ffc41f;margin:0 0 6px} h3{font-size:12px;letter-spacing:.1em;text-transform:uppercase;color:#7d808c;margin:18px 0 6px}
ul{list-style:none;margin:0;padding:0} li{margin:0 0 8px} a{color:#f4f4f6;text-decoration:none;text-transform:capitalize;font-weight:600} a:hover{color:#ffc41f} small{display:block;color:#7d808c;font-size:11px}
iframe{width:100%;height:100%;border:0;background:#eef0f3}</style>
<nav><h2>Email templates</h2><small>${CUSTOMER_TEMPLATE_KINDS.length} customer · ${OWNER_TEMPLATE_KINDS.length} owner · 3 account</small>
${group('customer', 'Customer')}${group('owner', 'Owner / company')}${group('account', 'Account')}</nav>
<iframe name="view" src="customer-booking-confirmed.html"></iframe>`);
console.log(`Wrote ${links.length} previews to ${out}/index.html`);
