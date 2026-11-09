import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { pool, tx } from '../../core/db.js';
import { badRequest, forbidden, HttpError } from '../../core/errors.js';
import { DEFAULT_SETTINGS, clearSecret, getSettings, secretStatus, setSecret, setSetting, type SettingKey } from '../../core/settings.js';
import { resolveSmtp, sendMail, verifySmtp } from '../../lib/mailer.js';
import { testEmail } from '../notifications/account-emails.js';
import { drive, mustGeocode, toMiles } from '../../lib/maps.js';
import { audit } from '../../core/util.js';
import { getStripe } from '../payments/payments.js';
import { putPublic, removePublic } from '../../lib/storage.js';
import { sniffImage } from '../../core/util.js';
import crypto from 'node:crypto';

/** The parts of the business address, in printed order. */
const ADDRESS_PARTS = ['company.addressLine1', 'company.addressLine2', 'company.city', 'company.region', 'company.postcode', 'company.country'] as const;

/** Deletes a replaced logo file. Its storage key is the part of the URL from "branding/" on. */
async function removeLogoFile(url: string) {
  const i = url.indexOf('branding/');
  if (i < 0) return;
  await removePublic(decodeURIComponent(url.slice(i)), url).catch(() => undefined); // a leftover file is harmless
}

/** Settings plus which secrets exist (never their values) and where the email connection comes from. */
async function settingsPayload() {
  const smtp = await resolveSmtp();
  return { settings: await getSettings(), secrets: await secretStatus(), mail: { source: smtp ? (smtp.kind === 'settings' ? 'dashboard' : 'environment') : 'none' } };
}

export function settingsRoutes(app: FastifyInstance) {
  app.get('/settings', async () => settingsPayload());

  app.put('/settings', async (req) => {
    if (req.user.role !== 'owner') throw forbidden('Only the company owner can change settings');
    const body = z.object({
      settings: z.record(z.string(), z.unknown()).optional(),
      secrets: z.object({
        stripeSecretKey: z.string().regex(/^(sk|rk)_(test|live)_[A-Za-z0-9]+$/, 'Must be a Stripe secret or restricted key').optional(),
        stripeWebhookSecret: z.string().regex(/^whsec_[A-Za-z0-9]+$/, 'Must start with whsec_').optional(),
        emailPassword: z.string().min(1).max(500).optional(),
        mapsGoogleKey: z.string().regex(/^[A-Za-z0-9_-]{20,}$/, 'That does not look like a Google API key').optional(),
      }).optional(),
      clearSecrets: z.array(z.enum(['email.password', 'maps.googleKey'])).optional(),
    }).parse(req.body);
    await tx(async (c) => {
      for (const [k, v] of Object.entries(body.settings ?? {})) {
        if (!(k in DEFAULT_SETTINGS)) throw badRequest(`Unknown setting ${k}`);
        const def = DEFAULT_SETTINGS[k as SettingKey];
        if (typeof v !== typeof def) throw badRequest(`Setting ${k} must be a ${typeof def}`);
        if (k === 'payment.mode' && v !== 'full' && v !== 'deposit') throw badRequest('payment.mode must be full or deposit');
        if (k === 'booking.bufferMinutes' && (!Number.isInteger(v) || (v as number) > 1440)) throw badRequest('The preparation buffer must be a whole number of minutes, up to 1440');
        if (k === 'tax.rateBp' && (!Number.isInteger(v) || (v as number) > 10000)) throw badRequest('Tax rate must be between 0% and 100%', 'invalid_tax');
        if (k === 'tax.policy' && v !== 'after_discount' && v !== 'before_discount') throw badRequest('Tax must be applied after or before discounts', 'invalid_tax');
        if (k === 'tax.label' && !String(v).trim()) throw badRequest('Give the tax a name, e.g. VAT', 'invalid_tax');
        if (k === 'booking.maxVehiclesPerOrder' && (!Number.isInteger(v) || (v as number) < 1 || (v as number) > 20)) throw badRequest('Vehicles per booking must be between 1 and 20');
        if (k === 'booking.pendingHoldHours' && (!Number.isInteger(v) || (v as number) > 720)) throw badRequest('How long an unapproved request holds a car must be a whole number of hours, up to 720 (0 = until staff act)');
        if (k === 'booking.maxOpenUnpaidOrders' && (!Number.isInteger(v) || (v as number) > 50)) throw badRequest('Open unpaid requests per customer must be a whole number up to 50 (0 = no limit)');
        if (k === 'pricing.serviceFeeBp' && v !== 0) throw badRequest('No service fee is charged on bookings');
        if (k === 'booking.maxDays' && (!Number.isInteger(v) || (v as number) < 1 || (v as number) > 60)) throw badRequest('The longest day booking must be between 1 and 60 days');
        if (k === 'booking.maxAdvanceDays' && (!Number.isInteger(v) || (v as number) < 1 || (v as number) > 1095)) throw badRequest('Advance booking must be between 1 and 1095 days');
        if ((k === 'delivery.ratePerMilePence' || k === 'delivery.showroomFeePence') && !Number.isInteger(v)) throw badRequest(`${k} must be a whole number of pence`);
        if (typeof v === 'number' && (!Number.isFinite(v) || v < 0)) throw badRequest(`Setting ${k} must be zero or more`);
        if (k === 'email.port' && (!Number.isInteger(v) || (v as number) < 1 || (v as number) > 65535)) throw badRequest('Email port must be between 1 and 65535');
        if (k === 'email.fromAddress' && v && !z.string().email().safeParse(v).success) throw badRequest('From address must be a valid email address');
        if ((k === 'company.email' || k === 'company.supportEmail') && String(v).trim() && !z.string().email().safeParse(String(v).trim()).success) throw badRequest(k === 'company.email' ? 'Business email must be a valid email address' : 'Support email must be a valid email address');
        if (k === 'company.name' && !String(v).trim()) throw badRequest('Business name cannot be empty');
        if (k === 'company.logoUrl') throw badRequest('Upload the logo with the logo button');
        if (k.startsWith('company.') && String(v).length > 2000) throw badRequest(`${k} is too long`);
        if (k === 'notifications.ownerEmails' && String(v).trim() && !String(v).split(/[,;\s]+/).filter(Boolean).every((e) => z.string().email().safeParse(e).success)) throw badRequest('Owner notification emails must be email addresses separated by commas');
        if ((k === 'company.websiteUrl' || k === 'company.dashboardUrl' || k === 'company.privacyUrl') && String(v).trim() && !/^https?:\/\/\S+$/i.test(String(v).trim())) throw badRequest('Links must start with https://');
        if (k === 'email.host' && v && !/^[A-Za-z0-9.-]+$/.test(String(v).trim())) throw badRequest('Email server must be a host name like smtp.example.com');
        if (k === 'maps.provider' && v !== 'osm' && v !== 'google') throw badRequest('Map provider must be osm or google');
        if (k === 'maps.countryCodes' && !/^([a-zA-Z]{2})(,\s*[a-zA-Z]{2})*$/.test(String(v).trim())) throw badRequest('Countries must be two-letter codes separated by commas, e.g. gb,ie');
        await setSetting(k as SettingKey, typeof v === 'string' ? v.trim() : v, c);
      }
      // Receipts, statements and emails print one address line: rebuild it whenever a part changes.
      if (ADDRESS_PARTS.some((k) => k in (body.settings ?? {}))) {
        const s = await getSettings(c);
        await setSetting('company.address', ADDRESS_PARTS.map((k) => String(s[k]).trim()).filter(Boolean).join(', '), c);
      }
      if (body.secrets?.emailPassword) await setSecret('email.password', body.secrets.emailPassword, c);
      if (body.secrets?.mapsGoogleKey) await setSecret('maps.googleKey', body.secrets.mapsGoogleKey, c);
      for (const k of body.clearSecrets ?? []) await clearSecret(k, c);
      if (body.secrets?.stripeSecretKey) await setSecret('stripe.secretKey', body.secrets.stripeSecretKey, c);
      if (body.secrets?.stripeWebhookSecret) await setSecret('stripe.webhookSecret', body.secrets.stripeWebhookSecret, c);
      await audit(c, req.user.sub, 'settings', null, 'update', null, { keys: Object.keys(body.settings ?? {}), secretsChanged: Object.keys(body.secrets ?? {}) }); // values never logged
    });
    return settingsPayload();
  });

  /** The business logo: JPEG, PNG or WebP (checked from the bytes), replacing any earlier one. */
  app.post('/settings/logo', async (req) => {
    if (req.user.role !== 'owner') throw forbidden('Only the company owner can change settings');
    const part = await req.file();
    if (!part) throw badRequest('No file received', 'no_file');
    const buf = await part.toBuffer();
    if (part.file.truncated) throw badRequest('The logo must be 8 MB or smaller', 'file_too_large');
    const type = sniffImage(buf);
    if (!type) throw badRequest('Only JPEG, PNG or WebP images are accepted', 'invalid_image');
    const before = (await getSettings())['company.logoUrl'];
    const key = `branding/logo-${crypto.randomUUID()}.${type.ext}`;
    const url = await putPublic(key, buf, type.mime);
    await setSetting('company.logoUrl', url);
    if (before) await removeLogoFile(before);
    await audit(pool, req.user.sub, 'settings', null, 'logo_uploaded');
    return settingsPayload();
  });

  app.delete('/settings/logo', async (req) => {
    if (req.user.role !== 'owner') throw forbidden('Only the company owner can change settings');
    const before = (await getSettings())['company.logoUrl'];
    await setSetting('company.logoUrl', '');
    if (before) await removeLogoFile(before);
    await audit(pool, req.user.sub, 'settings', null, 'logo_removed');
    return settingsPayload();
  });

  /** Opens and authenticates an SMTP connection without sending anything. */
  app.post('/settings/email/verify', async () => {
    const r = await verifySmtp();
    if (!r.sent) throw new HttpError(422, r.reason === 'no_mail_provider_configured' ? 'No email server is configured yet. Save the settings first.' : `Could not connect: ${r.reason}`, 'smtp_failed');
    return { ok: true };
  });

  /** Sends a real test message so the owner can see the whole path working. */
  app.post('/settings/email/test', async (req) => {
    const { to } = z.object({ to: z.string().email() }).parse(req.body);
    const s = await getSettings();
    const r = await sendMail(testEmail(to, s));
    if (!r.sent) throw new HttpError(422, r.reason === 'no_mail_provider_configured' ? 'No email server is configured yet. Save the settings first.' : `The email was not sent: ${r.reason}`, 'smtp_failed');
    await audit(pool, req.user.sub, 'settings', null, 'email_test_sent');
    return { ok: true, to };
  });

  /** Checks the chosen map provider can find an address and measure a route. */
  app.post('/settings/maps/test', async () => {
    const a = await mustGeocode('Buckingham Palace, London');
    const b = await mustGeocode('Tower of London, London');
    const d = await drive(a, b);
    return { ok: true, example: `Buckingham Palace to the Tower of London: ${toMiles(d.km)} miles, about ${d.minutes} minutes by road` };
  });

  /** Lets the owner verify the saved Stripe key from the dashboard. */
  app.post('/settings/stripe/test', async () => {
    const stripe = await getStripe();
    const bal = await stripe.balance.retrieve();
    return { ok: true, liveMode: bal.livemode, currencies: bal.available.map((a) => a.currency) };
  });
}
