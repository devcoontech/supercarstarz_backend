import type { Q } from './db.js';
import { pool } from './db.js';
import { config } from './config.js';
import { decryptSecret, encryptSecret } from './security.js';

/** Business settings with defaults. Editable from Admin > Settings. */
export const DEFAULT_SETTINGS = {
  'booking.openHour': 10,
  'booking.closeHour': 19,
  'booking.timezone': 'Europe/London',
  'booking.minLeadHours': 24,
  'booking.requireApproval': false, // off: customer bookings go straight to payment and confirm when paid; on: they start 'pending' until staff approve
  'booking.holdMinutes': 30, // how long an unpaid 'awaiting_payment' booking holds the car
  'booking.pendingHoldHours': 48, // how long an unpaid customer request waiting for approval holds the car (0 = until staff act)
  'booking.maxOpenUnpaidOrders': 3, // unpaid customer orders one customer can have open at once (0 = no limit)
  'booking.cancellationFreeHours': 48, // full refund if cancelled this far ahead
  'booking.cancellationLateRefundPercent': 0,
  'booking.bufferMinutes': 60, // preparation time kept free before and after every booking (a car's own buffer applies if longer)
  'booking.maxAdvanceDays': 365, // furthest ahead a booking can start
  'booking.allowExtensions': true, // customers can extend upcoming and active bookings when the car is free
  'booking.maxVehiclesPerOrder': 10,
  'delivery.ratePerMilePence': 435, // default delivery rate per mile from the showroom; staff confirm the final charge per booking
  'delivery.showroomFeePence': 0, // optional fee for collecting from the showroom; 0 means collection is free
  'pricing.serviceFeeBp': 500, // 5% customer service fee
  'tax.enabled': false, // add tax to bookings (off = prices already include any tax, or not registered)
  'tax.rateBp': 2000, // basis points: 2000 = 20%
  'tax.policy': 'after_discount', // 'after_discount' (tax the discounted amount) | 'before_discount' (tax the full rental subtotal)
  'tax.label': 'VAT', // shown on prices and receipts
  'payment.mode': 'full', // 'full' | 'deposit'
  'payment.depositPercentBp': 3000, // used when mode = 'deposit' and the vehicle has no fixed deposit
  'stripe.publishableKey': '', // pk_test_/pk_live_: designed to be public, so stored as a normal setting
  'maps.provider': 'osm', // 'osm' (OpenStreetMap Nominatim + OSRM) or 'google'
  'maps.countryCodes': 'gb', // comma separated ISO codes that address search is limited to
  'email.host': '', // SMTP server; blank means fall back to the SMTP_URL environment variable
  'email.port': 587,
  'email.secure': false, // true = TLS from the start (usually port 465); false = STARTTLS (usually port 587)
  'email.user': '',
  'email.fromName': '',
  'email.fromAddress': '',
  'driver.bufferMinutes': 30, // travel/turnaround kept free either side of a driver's assignment
  'company.name': 'Supercarstars',
  'company.supportEmail': '',
  'company.supportPhone': '',
  'company.address': '', // printed on receipts and invoices; built from the address parts below when they are saved
  'company.addressLine1': '',
  'company.addressLine2': '',
  'company.city': '',
  'company.region': '', // county, state or province
  'company.postcode': '',
  'company.country': 'United Kingdom',
  'company.logoUrl': '', // uploaded in Settings > Business details; printed on receipts and statements
  'company.description': '',
  'company.type': '', // e.g. Limited company, Sole trader
  'company.registrationNumber': '', // company registration number, if any
  'company.email': '', // general business email (customer emails use the support email)
  'company.altPhone': '',
  'company.vatNumber': '',
  'company.websiteUrl': 'https://supercarstars.com', // linked from the buttons and footer of customer emails
  'company.dashboardUrl': '', // admin dashboard address, linked from owner emails ("Open in dashboard")
  'notifications.ownerEmails': '', // comma separated; who gets new booking / confirmed / cancellation emails (blank = support email)
} as const;
export type SettingKey = keyof typeof DEFAULT_SETTINGS;
type Widen<T> = T extends number ? number : T extends boolean ? boolean : T extends string ? string : T;
export type Settings = { -readonly [K in SettingKey]: Widen<(typeof DEFAULT_SETTINGS)[K]> };

const SECRET_KEYS = ['stripe.secretKey', 'stripe.webhookSecret', 'maps.googleKey', 'email.password'] as const;
export type SecretKey = (typeof SECRET_KEYS)[number];
export const isSecretKey = (k: string): k is SecretKey => (SECRET_KEYS as readonly string[]).includes(k);

export async function getSettings(q: Q = pool): Promise<Settings> {
  const rows = (await q.query('SELECT key, value FROM settings')).rows as { key: string; value: unknown }[];
  const out: Record<string, unknown> = { ...DEFAULT_SETTINGS };
  for (const r of rows) if (r.key in DEFAULT_SETTINGS) out[r.key] = r.value;
  return out as Settings;
}

export async function setSetting(key: SettingKey, value: unknown, q: Q = pool) {
  if (!(key in DEFAULT_SETTINGS)) throw new Error(`Unknown setting ${key}`);
  await q.query(
    `INSERT INTO settings(key, value) VALUES ($1, $2) ON CONFLICT (key) DO UPDATE SET value = $2, updated_at = now()`,
    [key, JSON.stringify(value)],
  );
}

export async function setSecret(key: SecretKey, plain: string, q: Q = pool) {
  await q.query(
    `INSERT INTO settings(key, value) VALUES ($1, $2) ON CONFLICT (key) DO UPDATE SET value = $2, updated_at = now()`,
    [key, JSON.stringify(encryptSecret(plain))],
  );
}

export async function getSecret(key: SecretKey, q: Q = pool): Promise<string> {
  const r = await q.query('SELECT value FROM settings WHERE key = $1', [key]);
  if (r.rows[0]) return decryptSecret(r.rows[0].value as string);
  if (key === 'stripe.secretKey') return config.stripeSecretFallback;
  if (key === 'stripe.webhookSecret') return config.stripeWebhookFallback;
  return '';
}

export async function clearSecret(key: SecretKey, q: Q = pool) {
  await q.query('DELETE FROM settings WHERE key = $1', [key]);
}

/** Never returns secret values; only whether one is configured and its last 4 characters. */
export async function secretStatus(q: Q = pool) {
  const out: Record<string, { configured: boolean; hint: string | null }> = {};
  for (const k of SECRET_KEYS) {
    const v = await getSecret(k, q).catch(() => '');
    out[k] = { configured: !!v, hint: v ? '…' + v.slice(-4) : null };
  }
  return out;
}
