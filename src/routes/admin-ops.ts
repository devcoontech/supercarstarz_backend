import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { DateTime } from 'luxon';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { config } from '../config.js';
import { hashPassword } from '../security.js';
import { pool, tx } from '../db.js';
import { badRequest, conflict, forbidden, HttpError, notFound } from '../errors.js';
import { DEFAULT_SETTINGS, clearSecret, getSettings, isSecretKey, secretStatus, setSecret, setSetting, type SettingKey } from '../settings.js';
import { resolveSmtp, sendMail, verifySmtp } from '../mailer.js';
import { drive, mustGeocode, toMiles } from '../maps.js';
import { audit, buildInsert, buildUpdate, sniffImage } from '../util.js';
import { expireHolds } from '../bookings.js';
import { getStripe, reconcilePayment } from '../payments.js';

const uuid = z.string().uuid();
const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const LIVE = `('confirmed','driver_assigned','in_progress','completed')`;
const SENSITIVE_DRIVER_ROLES = ['owner', 'administrator', 'driver_coordinator'];

const csvCell = (v: unknown) => {
  let s = v == null ? '' : v instanceof Date ? v.toISOString() : typeof v === 'object' ? JSON.stringify(v) : String(v);
  if (/^[=+\-@\t\r]/.test(s)) s = "'" + s; // neutralise spreadsheet formula injection
  // Quote any cell with a line break (CR too): unquoted, a spreadsheet could start a new row there with a formula.
  return /[",\r\n]/.test(s) ? '"' + s.replaceAll('"', '""') + '"' : s;
};
export const toCsv = (rows: Record<string, unknown>[]) =>
  rows.length ? [Object.keys(rows[0]).join(','), ...rows.map((r) => Object.values(r).map(csvCell).join(','))].join('\n') : '';

/** Settings plus which secrets exist (never their values) and where the email connection comes from. */
async function settingsPayload() {
  const smtp = await resolveSmtp();
  return { settings: await getSettings(), secrets: await secretStatus(), mail: { source: smtp ? (smtp.kind === 'settings' ? 'dashboard' : 'environment') : 'none' } };
}

export async function adminOpsRoutes(app: FastifyInstance) {
  app.addHook('onRequest', app.staffOnly);

  app.get('/me', async (req) => {
    const s = (await pool.query('SELECT id, email, name, role FROM staff_users WHERE id=$1 AND active', [req.user.sub])).rows[0];
    if (!s) throw notFound('Account not found');
    return s;
  });

  /* ---------- Drivers ---------- */
  const driverBody = z.object({
    internalRef: z.string().max(40).nullish(), fullName: z.string().trim().min(1).max(120), phone: z.string().trim().min(5).max(40), email: z.string().email().nullish(),
    licenseNumber: z.string().max(60).nullish(), licenseExpiry: date.nullish(), employment: z.enum(['employee', 'contractor']),
    workingHours: z.object({ start: z.string().regex(/^\d{2}:\d{2}$/), end: z.string().regex(/^\d{2}:\d{2}$/) }).nullish(), notes: z.string().max(2000).nullish(), active: z.boolean(),
  });
  const driverFields = { internalRef: 'internal_ref', fullName: 'full_name', phone: 'phone', email: 'email', licenseNumber: 'license_number', licenseExpiry: 'license_expiry', employment: 'employment', workingHours: 'working_hours', notes: 'notes', active: 'active' };
  const driverOut = (d: any, role: string) => {
    const { license_number, ...rest } = d;
    return SENSITIVE_DRIVER_ROLES.includes(role) ? d : rest;
  };

  app.get('/drivers', async (req) => {
    const q = z.object({ active: z.enum(['true', 'false']).optional(), q: z.string().max(80).optional() }).parse(req.query);
    const rows = (await pool.query(
      `SELECT d.*, (SELECT count(*)::int FROM driver_assignments a WHERE a.driver_id=d.id AND a.active AND upper(a.during) > now()) AS "upcomingAssignments",
              (SELECT count(*)::int FROM driver_licence_images i WHERE i.driver_id=d.id) AS "licenceImages"
         FROM drivers d WHERE ($1::boolean IS NULL OR d.active=$1) AND ($2::text IS NULL OR d.full_name ILIKE '%'||$2||'%') ORDER BY d.full_name`,
      [q.active == null ? null : q.active === 'true', q.q ?? null])).rows;
    return { items: rows.map((r) => driverOut(r, req.user.role!)) };
  });

  app.post('/drivers', async (req, reply) => {
    const data = driverBody.partial().required({ fullName: true, phone: true }).strict().parse(req.body);
    const ins = buildInsert('drivers', driverFields, { ...data, workingHours: data.workingHours ? JSON.stringify(data.workingHours) : undefined });
    const r = (await pool.query(ins.sql, ins.vals)).rows[0];
    await audit(pool, req.user.sub, 'driver', r.id, 'create');
    return reply.status(201).send(driverOut(r, req.user.role!));
  });

  app.patch('/drivers/:id', async (req) => {
    const { id } = z.object({ id: uuid }).parse(req.params);
    const data = driverBody.partial().strict().parse(req.body);
    if (('licenseNumber' in data || 'licenseExpiry' in data) && !SENSITIVE_DRIVER_ROLES.includes(req.user.role!)) throw badRequest('Not allowed to change licence details');
    const u = buildUpdate('drivers', id, driverFields, { ...data, workingHours: data.workingHours === undefined ? undefined : data.workingHours && JSON.stringify(data.workingHours) }, false);
    if (u.empty) throw badRequest('Nothing to update');
    if (data.active === false) {
      const n = (await pool.query(`SELECT count(*)::int n FROM driver_assignments WHERE driver_id=$1 AND active AND upper(during) > now()`, [id])).rows[0].n;
      if (n) throw conflict(`This driver has ${n} upcoming assignment(s). Reassign them before deactivating.`, 'has_assignments');
    }
    const r = await pool.query(u.sql, u.vals);
    if (!r.rowCount) throw notFound('Driver not found');
    await audit(pool, req.user.sub, 'driver', id, 'update', null, { fields: Object.keys(data) });
    return driverOut(r.rows[0], req.user.role!);
  });

  /* ----- Driving licence photos (front and back) -----
   * Identity documents: stored outside the public uploads folder, sent only to the roles allowed to see licence
   * details, never cached, and every view, upload and removal is in the audit log. */
  const licenceDir = () => path.resolve(config.privateUploadDir);
  const requireLicenceAccess = (req: any) => {
    if (!SENSITIVE_DRIVER_ROLES.includes(req.user.role)) throw forbidden('Only the owner, administrators and driver coordinators can see licence details');
  };
  const licenceImages = async (driverId: string) => (await pool.query(
    `SELECT i.id, i.side, i.mime, i.size_bytes AS "sizeBytes", i.created_at AS "createdAt", s.name AS "uploadedBy"
       FROM driver_licence_images i LEFT JOIN staff_users s ON s.id=i.uploaded_by WHERE i.driver_id=$1 ORDER BY i.side DESC`, [driverId])).rows;

  app.get('/drivers/:id/licence-images', async (req) => {
    requireLicenceAccess(req);
    const { id } = z.object({ id: uuid }).parse(req.params);
    return { items: await licenceImages(id) };
  });

  /** One image per side; uploading a side again replaces the old photo. JPEG, PNG or WebP, checked from the bytes. */
  app.post('/drivers/:id/licence-images/:side', async (req, reply) => {
    requireLicenceAccess(req);
    const { id, side } = z.object({ id: uuid, side: z.enum(['front', 'back']) }).parse(req.params);
    if (!(await pool.query('SELECT 1 FROM drivers WHERE id=$1', [id])).rowCount) throw notFound('Driver not found');
    const part = await req.file();
    if (!part) throw badRequest('No file received', 'no_file');
    const buf = await part.toBuffer();
    if (part.file.truncated) throw badRequest('File is larger than 8 MB', 'file_too_large');
    const type = sniffImage(buf);
    if (!type) throw badRequest('Only JPEG, PNG or WebP images are accepted', 'invalid_image');
    const key = `drivers/${id}/${crypto.randomUUID()}.${type.ext}`;
    const full = path.join(licenceDir(), key);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, buf, { mode: 0o600 });
    let old: { storage_key: string } | undefined;
    try {
      await tx(async (c) => {
        old = (await c.query('DELETE FROM driver_licence_images WHERE driver_id=$1 AND side=$2 RETURNING storage_key', [id, side])).rows[0];
        await c.query('INSERT INTO driver_licence_images(driver_id, side, storage_key, mime, size_bytes, uploaded_by) VALUES ($1,$2,$3,$4,$5,$6)',
          [id, side, key, type.mime, buf.length, req.user.sub]);
        await audit(c, req.user.sub, 'driver', id, old ? 'replace_licence_image' : 'add_licence_image', null, { side });
      });
    } catch (e) {
      fs.rmSync(full, { force: true });
      throw e;
    }
    if (old) fs.rmSync(path.join(licenceDir(), old.storage_key), { force: true });
    return reply.status(201).send({ items: await licenceImages(id) });
  });

  app.get('/drivers/:id/licence-images/:imageId', async (req, reply) => {
    requireLicenceAccess(req);
    const p = z.object({ id: uuid, imageId: uuid }).parse(req.params);
    const img = (await pool.query('SELECT * FROM driver_licence_images WHERE id=$1 AND driver_id=$2', [p.imageId, p.id])).rows[0];
    if (!img) throw notFound('Image not found');
    const full = path.join(licenceDir(), img.storage_key);
    if (!fs.existsSync(full)) throw notFound('The image file is missing');
    await audit(pool, req.user.sub, 'driver', p.id, 'view_licence_image', null, { side: img.side });
    return reply.type(img.mime).header('cache-control', 'no-store, private').header('x-content-type-options', 'nosniff').send(fs.readFileSync(full));
  });

  app.delete('/drivers/:id/licence-images/:imageId', async (req) => {
    requireLicenceAccess(req);
    const p = z.object({ id: uuid, imageId: uuid }).parse(req.params);
    const img = (await pool.query('DELETE FROM driver_licence_images WHERE id=$1 AND driver_id=$2 RETURNING side, storage_key', [p.imageId, p.id])).rows[0];
    if (!img) throw notFound('Image not found');
    fs.rmSync(path.join(licenceDir(), img.storage_key), { force: true });
    await audit(pool, req.user.sub, 'driver', p.id, 'remove_licence_image', null, { side: img.side });
    return { items: await licenceImages(p.id) };
  });

  app.get('/drivers/:id/assignments', async (req) => {
    const { id } = z.object({ id: uuid }).parse(req.params);
    return { items: (await pool.query(
      `SELECT a.id, a.active, a.created_at AS "assignedAt", a.ended_at AS "endedAt", a.ended_reason AS "endedReason", b.id AS "bookingId", b.ref, b.status, b.start_at AS "startAt", b.end_at AS "endAt", b.address
         FROM driver_assignments a JOIN bookings b ON b.id=a.booking_id WHERE a.driver_id=$1 ORDER BY b.start_at DESC LIMIT 200`, [id])).rows };
  });

  /* ---------- Customers ---------- */
  /**
   * Search by name, email or phone. Phone numbers match on digits only, so "07700 900123", "07700900123" and
   * "+44 7700 900123" all find the same customer. Exact email or phone matches are listed first.
   */
  app.get('/customers', async (req) => {
    const q = z.object({ q: z.string().max(80).optional(), limit: z.coerce.number().int().min(1).max(200).default(50), offset: z.coerce.number().int().min(0).default(0) }).parse(req.query);
    const term = q.q?.trim() || null;
    let digits = term ? term.replace(/\D/g, '') : '';
    if (term?.startsWith('+44') || (digits.startsWith('44') && digits.length > 10)) digits = '0' + digits.slice(2); // +44 7700... -> 07700...
    const p: unknown[] = [term ? `%${term}%` : null, digits.length >= 4 ? `%${digits.replace(/^0/, '')}%` : null, term, q.limit, q.offset];
    const where = `$1::text IS NULL OR (c.name ILIKE $1 OR c.email ILIKE $1 OR c.phone ILIKE $1 OR ($2::text IS NOT NULL AND regexp_replace(COALESCE(c.phone,''), '\\D', '', 'g') LIKE $2))`;
    const rows = (await pool.query(
      `SELECT c.id, c.name, c.email, c.phone, c.city, c.postcode, c.created_at AS "createdAt",
              (SELECT count(*)::int FROM bookings b WHERE b.customer_id=c.id) AS bookings,
              (SELECT max(b.start_at) FROM bookings b WHERE b.customer_id=c.id) AS "lastBookingAt",
              (SELECT COALESCE(sum(p.amount_pence),0)::int FROM payments p WHERE p.customer_id=c.id AND p.status='succeeded') AS "paidPence"
         FROM customers c WHERE ${where}
        ORDER BY (lower(c.email) = lower(COALESCE($3::text, ''))) DESC, c.created_at DESC LIMIT $4 OFFSET $5`, p)).rows;
    const total = (await pool.query(`SELECT count(*)::int n FROM customers c WHERE ${where}`, p.slice(0, 2))).rows[0].n;
    return { items: rows, total };
  });

  /**
   * For phone/walk-in customers: name, email and phone only. No password is ever shown to staff; the account gets a
   * random one nobody knows, and the customer sets their own in the app with "Forgot your password?" on the same email.
   */
  app.post('/customers', async (req, reply) => {
    const b = z.object({ name: z.string().trim().min(1).max(120), email: z.string().email().max(200), phone: z.string().max(40).optional() }).parse(req.body);
    const email = b.email.toLowerCase();
    // Never create a second record for someone already on file: hand back the existing customer so staff can select them.
    const existing = (await pool.query('SELECT id, name, email, phone FROM customers WHERE lower(email)=$1', [email])).rows[0];
    if (existing) throw conflict(`${existing.name} is already a customer with that email. Select them instead.`, 'email_taken', { customer: existing });
    const unknownPassword = crypto.randomBytes(32).toString('base64url'); // never returned or stored in clear
    const r = (await pool.query(
      `INSERT INTO customers(email, name, phone, password_hash) VALUES ($1,$2,$3,$4) RETURNING id, name, email, phone`,
      [email, b.name, b.phone ?? null, await hashPassword(unknownPassword)])).rows[0];
    await audit(pool, req.user.sub, 'customer', r.id, 'create');
    return reply.status(201).send({ customer: r });
  });

  app.get('/customers/:id', async (req) => {
    const { id } = z.object({ id: uuid }).parse(req.params);
    const c = (await pool.query('SELECT id, name, email, phone, postcode, city, internal_notes AS "internalNotes", created_at AS "createdAt" FROM customers WHERE id=$1', [id])).rows[0];
    if (!c) throw notFound('Customer not found');
    const bookings = (await pool.query(
      `SELECT b.id, b.ref, b.status, b.start_at AS "startAt", b.total_pence AS "totalPence", b.paid_pence AS "paidPence", b.cancel_reason AS "cancelReason", v.make || ' ' || v.model AS vehicle
         FROM bookings b JOIN vehicles v ON v.id=b.vehicle_id WHERE b.customer_id=$1 ORDER BY b.start_at DESC`, [id])).rows;
    return { ...c, bookings, cancellations: bookings.filter((b) => ['cancelled', 'cancellation_requested'].includes(b.status)).length };
  });

  app.patch('/customers/:id', async (req) => {
    const { id } = z.object({ id: uuid }).parse(req.params);
    const data = z.object({ name: z.string().trim().min(1).max(120), phone: z.string().max(40).nullable(), postcode: z.string().max(12).nullable(), city: z.string().max(80).nullable(), internalNotes: z.string().max(4000).nullable() }).partial().strict().parse(req.body);
    const u = buildUpdate('customers', id, { name: 'name', phone: 'phone', postcode: 'postcode', city: 'city', internalNotes: 'internal_notes' }, data);
    if (u.empty) throw badRequest('Nothing to update');
    const r = await pool.query(u.sql, u.vals);
    if (!r.rowCount) throw notFound('Customer not found');
    await audit(pool, req.user.sub, 'customer', id, 'update', null, { fields: Object.keys(data) });
    return { ok: true };
  });

  /* ---------- Offers ---------- */
  const offerBody = z.object({
    code: z.string().trim().min(3).max(40).regex(/^[A-Za-z0-9_-]+$/).nullish(), title: z.string().trim().min(1).max(120), description: z.string().max(1000).nullish(), imageUrl: z.string().url().nullish(),
    discountType: z.enum(['percent', 'fixed']), discountValue: z.number().int().min(1), startsAt: z.string().datetime({ offset: true }).nullish(), endsAt: z.string().datetime({ offset: true }).nullish(),
    usageLimit: z.number().int().min(1).nullish(), perCustomerLimit: z.number().int().min(1).nullish(), minBookingPence: z.number().int().min(0), vehicleIds: z.array(uuid).nullish(), eventTypeIds: z.array(uuid).nullish(), active: z.boolean(),
    // Multi-vehicle offers
    autoApply: z.boolean(), minVehicles: z.number().int().min(1).max(50), maxVehicles: z.number().int().min(1).max(50).nullish(),
    vehicleCategories: z.array(z.enum(['Supercar', 'Convertible', 'SUV', 'Luxury'])).nullish(), requiredVehicleIds: z.array(uuid).max(20).nullish(),
    requiredCategories: z.array(z.enum(['Supercar', 'Convertible', 'SUV', 'Luxury'])).nullish(), maxDiscountPence: z.number().int().min(1).nullish(),
    appliesTo: z.enum(['rental', 'subtotal']), priority: z.number().int().min(-100).max(100), stackable: z.boolean(),
  });
  const offerFields = {
    code: 'code', title: 'title', description: 'description', imageUrl: 'image_url', discountType: 'discount_type', discountValue: 'discount_value', startsAt: 'starts_at', endsAt: 'ends_at',
    usageLimit: 'usage_limit', perCustomerLimit: 'per_customer_limit', minBookingPence: 'min_booking_pence', vehicleIds: 'vehicle_ids', eventTypeIds: 'event_type_ids', active: 'active',
    autoApply: 'auto_apply', minVehicles: 'min_vehicles', maxVehicles: 'max_vehicles', vehicleCategories: 'vehicle_categories', requiredVehicleIds: 'required_vehicle_ids',
    requiredCategories: 'required_categories', maxDiscountPence: 'max_discount_pence', appliesTo: 'applies_to', priority: 'priority', stackable: 'stackable',
  };
  const emptyToNull = (a: unknown) => (Array.isArray(a) && !a.length ? null : a);
  const normOffer = (d: any) => ({
    ...d, code: d.code ? d.code.toUpperCase() : d.code,
    ...(d.autoApply ? { code: null } : {}), // automatic offers have no code
    ...('vehicleIds' in d ? { vehicleIds: emptyToNull(d.vehicleIds) } : {}), ...('eventTypeIds' in d ? { eventTypeIds: emptyToNull(d.eventTypeIds) } : {}),
    ...('vehicleCategories' in d ? { vehicleCategories: emptyToNull(d.vehicleCategories) } : {}), ...('requiredVehicleIds' in d ? { requiredVehicleIds: emptyToNull(d.requiredVehicleIds) } : {}),
    ...('requiredCategories' in d ? { requiredCategories: emptyToNull(d.requiredCategories) } : {}),
  });
  /** Rules that span several fields: checked against the offer as it will be saved. */
  const checkOffer = (o: any) => {
    if (o.discount_type === 'percent' && o.discount_value > 100) throw badRequest('A percentage discount cannot exceed 100', 'invalid_offer');
    if (o.max_vehicles != null && o.max_vehicles < o.min_vehicles) throw badRequest('The maximum number of vehicles must be at least the minimum', 'invalid_offer');
    if (o.starts_at && o.ends_at && new Date(o.ends_at) <= new Date(o.starts_at)) throw badRequest('The offer must end after it starts', 'invalid_offer');
    if (o.auto_apply && o.code) throw badRequest('An automatic offer has no code', 'invalid_offer');
  };
  const offerError = (e: any) => { if (e.code === '23514') throw badRequest('Those offer settings are not valid', 'invalid_offer'); throw e; };

  app.get('/offers', async () => ({
    items: (await pool.query(
      `SELECT o.*, COALESCE(r.uses,0)::int AS uses, COALESCE(r.discount,0)::int AS "discountGivenPence"
         FROM offers o LEFT JOIN (SELECT offer_id, count(*) uses, sum(discount_pence) discount FROM offer_redemptions WHERE released_at IS NULL GROUP BY offer_id) r ON r.offer_id=o.id ORDER BY o.created_at DESC`)).rows,
  }));

  app.post('/offers', async (req, reply) => {
    const data = offerBody.partial().required({ title: true, discountType: true, discountValue: true }).strict().parse(req.body);
    const ins = buildInsert('offers', offerFields, normOffer(data));
    const r = await tx(async (c) => {
      const row = (await c.query(ins.sql, ins.vals).catch(offerError)).rows[0];
      checkOffer(row);
      await audit(c, req.user.sub, 'offer', row.id, 'create', null, row);
      return row;
    });
    return reply.status(201).send(r);
  });

  app.patch('/offers/:id', async (req) => {
    const { id } = z.object({ id: uuid }).parse(req.params);
    const data = offerBody.partial().strict().parse(req.body);
    const u = buildUpdate('offers', id, offerFields, normOffer(data));
    if (u.empty) throw badRequest('Nothing to update');
    // Orders keep the offer as it was when applied (order_offers), so editing an offer never changes existing bookings.
    return tx(async (c) => {
      const before = (await c.query('SELECT * FROM offers WHERE id=$1 FOR UPDATE', [id])).rows[0];
      if (!before) throw notFound('Offer not found');
      const after = (await c.query(u.sql, u.vals).catch(offerError)).rows[0];
      checkOffer(after);
      await audit(c, req.user.sub, 'offer', id, 'update', before, after);
      return after;
    });
  });

  /** Offers that have been used keep their history; deactivate those instead. */
  app.delete('/offers/:id', async (req) => {
    const { id } = z.object({ id: uuid }).parse(req.params);
    const used = (await pool.query('SELECT count(*)::int n FROM offer_redemptions WHERE offer_id=$1', [id])).rows[0].n
      + (await pool.query('SELECT count(*)::int n FROM bookings WHERE offer_id=$1', [id])).rows[0].n;
    if (used) throw conflict('This offer has been used on bookings. Turn it off instead; its history is kept.', 'has_bookings');
    const r = await pool.query('DELETE FROM offers WHERE id=$1 RETURNING title, code', [id]);
    if (!r.rowCount) throw notFound('Offer not found');
    await audit(pool, req.user.sub, 'offer', id, 'delete', r.rows[0], null);
    return { ok: true };
  });

  /** Drivers with any assignment history cannot be deleted (it is audit history); deactivate them. */
  app.delete('/drivers/:id', async (req) => {
    const { id } = z.object({ id: uuid }).parse(req.params);
    const used = (await pool.query('SELECT count(*)::int n FROM driver_assignments WHERE driver_id=$1', [id])).rows[0].n
      + (await pool.query('SELECT count(*)::int n FROM bookings WHERE driver_id=$1', [id])).rows[0].n;
    if (used) throw conflict('This driver has assignment history. Deactivate them instead; the history is kept.', 'has_assignments');
    const files = (await pool.query('SELECT storage_key, side FROM driver_licence_images WHERE driver_id=$1', [id])).rows;
    // Deleting the driver deletes their licence photos too, so it needs the same access as removing a photo.
    if (files.length) requireLicenceAccess(req);
    const r = await pool.query('DELETE FROM drivers WHERE id=$1 RETURNING full_name', [id]);
    if (!r.rowCount) throw notFound('Driver not found');
    for (const f of files) {
      fs.rmSync(path.join(licenceDir(), f.storage_key), { force: true }); // licence photos go with the driver
      await audit(pool, req.user.sub, 'driver', id, 'remove_licence_image', null, { side: f.side, via: 'driver_delete' });
    }
    await audit(pool, req.user.sub, 'driver', id, 'delete', { name: r.rows[0].full_name }, null);
    return { ok: true };
  });

  /* ---------- Payments ledger ---------- */
  app.get('/payments', async (req) => {
    const q = z.object({
      q: z.string().max(80).optional(), status: z.enum(['pending', 'succeeded', 'failed', 'canceled']).optional(), source: z.enum(['stripe', 'manual']).optional(),
      from: z.string().optional(), to: z.string().optional(), format: z.enum(['json', 'csv']).default('json'),
      limit: z.coerce.number().int().min(1).max(500).default(50), offset: z.coerce.number().int().min(0).default(0),
    }).parse(req.query);
    const w: string[] = [];
    const p: unknown[] = [];
    const add = (sql: string, v: unknown) => { p.push(v); w.push(sql.replaceAll('?', '$' + p.length)); };
    if (q.q) add('(b.ref ILIKE ? OR p.provider_ref ILIKE ? OR p.manual_reference ILIKE ? OR c.name ILIKE ?)', `%${q.q}%`);
    if (q.status) add('p.status=?', q.status);
    if (q.source) add('p.source=?', q.source);
    if (q.from) add('COALESCE(p.paid_at, p.created_at) >= ?', q.from);
    if (q.to) add('COALESCE(p.paid_at, p.created_at) < ?', q.to);
    const where = w.length ? 'WHERE ' + w.join(' AND ') : '';
    const base = `FROM payments p JOIN bookings b ON b.id=p.booking_id JOIN customers c ON c.id=p.customer_id LEFT JOIN staff_users s ON s.id=p.recorded_by LEFT JOIN invoices i ON i.payment_id=p.id ${where}`;
    const cols = `p.id, b.ref AS "bookingRef", b.id AS "bookingId", c.name AS customer, p.amount_pence AS "amountPence", p.currency, p.method, p.source, p.purpose, p.status,
                  p.provider_ref AS "providerRef", p.manual_reference AS "manualReference", s.name AS "recordedBy", p.reconciled_at AS "reconciledAt", p.created_at AS "createdAt",
                  p.paid_at AS "paidAt", (p.source='stripe' AND p.status='succeeded') AS verified, i.id AS "receiptId", i.number AS "receiptNumber",
                  COALESCE((SELECT sum(r.amount_pence) FROM refunds r WHERE r.payment_id=p.id AND r.status IN ('pending','succeeded')),0)::int AS "refundedPence"`;
    if (q.format === 'csv') {
      const rows = (await pool.query(`SELECT ${cols} ${base} ORDER BY p.created_at DESC LIMIT 10000`, p)).rows;
      await audit(pool, req.user.sub, 'payments', null, 'export_csv', null, { rows: rows.length });
      return { csv: toCsv(rows) };
    }
    const total = (await pool.query(`SELECT count(*)::int n ${base}`, p)).rows[0].n;
    p.push(q.limit, q.offset);
    const items = (await pool.query(`SELECT ${cols} ${base} ORDER BY p.created_at DESC LIMIT $${p.length - 1} OFFSET $${p.length}`, p)).rows;
    return { items, total };
  });

  /** Asks Stripe (server-side) for the intent's real state and compares it with our ledger. */
  app.post('/payments/:id/reconcile', async (req) => {
    const { id } = z.object({ id: uuid }).parse(req.params);
    return reconcilePayment(id, req.user.sub);
  });

  /* ---------- Dashboard ---------- */
  app.get('/dashboard', async (req) => {
    const q = z.object({ from: date.optional(), to: date.optional() }).parse(req.query);
    const s = await getSettings();
    const tz = s['booking.timezone'];
    const to = q.to ? DateTime.fromISO(q.to, { zone: tz }).plus({ days: 1 }) : DateTime.now().setZone(tz).plus({ days: 1 }).startOf('day');
    const from = q.from ? DateTime.fromISO(q.from, { zone: tz }) : to.minus({ days: 30 });
    const range = [from.toUTC().toJSDate(), to.toUTC().toJSDate()];
    const one = async (sql: string, params: unknown[] = []) => (await pool.query(sql, params)).rows[0];

    const [fleet, counts, money, outstanding, refunds, attention, upcoming, availableNow] = await Promise.all([
      one(`SELECT count(*)::int total, count(*) FILTER (WHERE operational_status='active')::int active,
                  count(*) FILTER (WHERE operational_status<>'active')::int inactive, count(*) FILTER (WHERE published)::int published
             FROM vehicles WHERE deleted_at IS NULL`),
      pool.query(`SELECT status, count(*)::int n FROM bookings WHERE start_at >= $1 AND start_at < $2 GROUP BY status`, range),
      one(`SELECT COALESCE(sum(total_pence) FILTER (WHERE status IN ${LIVE}),0)::int AS "grossBookingValuePence" FROM bookings WHERE start_at >= $1 AND start_at < $2`, range),
      one(`SELECT COALESCE(sum(o.total_pence - (o.paid_pence - o.refunded_pence)) FILTER (WHERE o.total_pence > o.paid_pence - o.refunded_pence),0)::int AS p
             FROM orders o WHERE EXISTS (SELECT 1 FROM bookings b WHERE b.order_id=o.id AND b.status IN ('confirmed','driver_assigned','in_progress','completed'))`),
      one(`SELECT COALESCE(sum(amount_pence) FILTER (WHERE status IN ('succeeded','pending')),0)::int AS "refundedPence" FROM refunds WHERE created_at >= $1 AND created_at < $2`, range),
      one(`SELECT count(*)::int n FROM bookings WHERE chauffeur AND driver_id IS NULL AND status IN ('confirmed','driver_assigned') AND start_at > now() AND start_at < now() + interval '7 days'`),
      pool.query(`SELECT b.id, b.ref, b.start_at AS "startAt", b.status, v.make || ' ' || v.model AS vehicle, c.name AS customer FROM bookings b JOIN vehicles v ON v.id=b.vehicle_id JOIN customers c ON c.id=b.customer_id
                   WHERE b.start_at > now() AND b.start_at < now() + interval '7 days' AND b.status IN ('confirmed','driver_assigned','pending','awaiting_payment') ORDER BY b.start_at LIMIT 20`),
      one(`SELECT count(*)::int n FROM vehicles v WHERE v.deleted_at IS NULL AND v.operational_status='active'
             AND NOT EXISTS (SELECT 1 FROM bookings b WHERE b.vehicle_id=v.id AND b.status IN ('confirmed','driver_assigned','in_progress') AND tstzrange(b.start_at,b.end_at) @> now())
             AND NOT EXISTS (SELECT 1 FROM availability_blocks k WHERE k.vehicle_id=v.id AND k.during @> now())`),
    ]);
    const collected = await one(`SELECT COALESCE(sum(amount_pence),0)::int AS p FROM payments WHERE status='succeeded' AND COALESCE(paid_at, created_at) >= $1 AND COALESCE(paid_at, created_at) < $2`, range);
    const byStatus = Object.fromEntries(counts.rows.map((r) => [r.status, r.n]));
    const perDay = (await pool.query(
      `SELECT to_char(d.day,'YYYY-MM-DD') AS day,
              (SELECT count(*)::int FROM bookings b WHERE (b.start_at AT TIME ZONE $3)::date = d.day AND b.status NOT IN ('cancelled','rejected','payment_failed')) AS bookings,
              (SELECT COALESCE(sum(p.amount_pence),0)::int FROM payments p WHERE p.status='succeeded' AND (COALESCE(p.paid_at, p.created_at) AT TIME ZONE $3)::date = d.day) AS "collectedPence"
         FROM generate_series(($1::timestamptz AT TIME ZONE $3)::date, (($2::timestamptz AT TIME ZONE $3)::date - 1), interval '1 day') AS d(day) ORDER BY d.day`, [...range, tz])).rows;
    const util = (await pool.query(
      `SELECT v.id, v.make || ' ' || v.model AS name,
              COALESCE(sum(EXTRACT(EPOCH FROM (LEAST(b.end_at,$2) - GREATEST(b.start_at,$1)))/3600) FILTER (WHERE b.id IS NOT NULL),0)::float AS "bookedHours"
         FROM vehicles v LEFT JOIN bookings b ON b.vehicle_id=v.id AND b.status IN ${LIVE} AND b.start_at < $2 AND b.end_at > $1
        WHERE v.deleted_at IS NULL AND v.operational_status='active' GROUP BY v.id ORDER BY "bookedHours" DESC LIMIT 10`, range)).rows;
    const days = Math.max(1, Math.round(to.diff(from, 'days').days));
    const openHoursPerDay = s['booking.closeHour'] - s['booking.openHour'];
    return {
      range: { from: from.toISODate(), to: to.minus({ days: 1 }).toISODate(), timezone: tz },
      // Definitions: gross = value of live bookings starting in range; collected = succeeded payments received in range;
      // refunded = refunds issued in range; net = collected - refunded; outstanding = unpaid balance on live bookings (all time).
      money: {
        grossBookingValuePence: money.grossBookingValuePence, collectedPence: collected.p, refundedPence: refunds.refundedPence,
        netCollectedPence: collected.p - refunds.refundedPence, outstandingPence: outstanding.p,
      },
      fleet: { ...fleet, availableNow: availableNow.n },
      bookings: {
        byStatus, pending: byStatus.pending ?? 0, confirmed: (byStatus.confirmed ?? 0) + (byStatus.driver_assigned ?? 0), ongoing: byStatus.in_progress ?? 0,
        completed: byStatus.completed ?? 0, cancelled: (byStatus.cancelled ?? 0) + (byStatus.rejected ?? 0),
      },
      attention: { driverAssignmentsNeeded: attention.n },
      upcoming: upcoming.rows,
      perDay,
      utilization: util.map((u) => ({ ...u, percent: Math.min(100, Math.round((u.bookedHours / (days * openHoursPerDay)) * 1000) / 10) })),
    };
  });

  /* ---------- Reports ---------- */
  const reports: Record<string, string> = {
    'bookings-by-event': `SELECT COALESCE(e.title,'(no event)') AS event, count(*)::int AS bookings, COALESCE(sum(b.total_pence) FILTER (WHERE b.status IN ${LIVE}),0)::int AS "valuePence"
        FROM bookings b LEFT JOIN event_types e ON e.id=b.event_type_id WHERE b.start_at >= $1 AND b.start_at < $2 GROUP BY e.title ORDER BY bookings DESC`,
    'bookings-by-vehicle': `SELECT v.make || ' ' || v.model AS vehicle, count(*)::int AS bookings, COALESCE(sum(b.total_pence) FILTER (WHERE b.status IN ${LIVE}),0)::int AS "valuePence"
        FROM bookings b JOIN vehicles v ON v.id=b.vehicle_id WHERE b.start_at >= $1 AND b.start_at < $2 AND b.status NOT IN ('cancelled','rejected','payment_failed') GROUP BY v.id ORDER BY bookings DESC`,
    'payments-collected': `SELECT to_char(COALESCE(p.paid_at, p.created_at),'YYYY-MM-DD') AS day, p.source, p.method, count(*)::int AS payments, sum(p.amount_pence)::int AS "amountPence"
        FROM payments p WHERE p.status='succeeded' AND COALESCE(p.paid_at, p.created_at) >= $1 AND COALESCE(p.paid_at, p.created_at) < $2 GROUP BY 1,2,3 ORDER BY 1`,
    'outstanding-balances': `SELECT o.ref, c.name AS customer, (SELECT count(*)::int FROM bookings x WHERE x.order_id=o.id AND x.status NOT IN ('cancelled','rejected')) AS vehicles,
        (SELECT min(x.start_at) FROM bookings x WHERE x.order_id=o.id) AS "startAt", o.total_pence AS "totalPence", (o.paid_pence-o.refunded_pence) AS "netPaidPence",
        (o.total_pence-(o.paid_pence-o.refunded_pence)) AS "outstandingPence" FROM orders o JOIN customers c ON c.id=o.customer_id
        WHERE EXISTS (SELECT 1 FROM bookings x WHERE x.order_id=o.id AND x.status IN ('confirmed','driver_assigned','in_progress','completed') AND x.start_at >= $1 AND x.start_at < $2)
          AND o.total_pence > o.paid_pence-o.refunded_pence ORDER BY 4`,
    'offers-applied': `SELECT x.title, x.code, count(DISTINCT x.order_id)::int AS orders, COALESCE(sum(x.discount_pence),0)::int AS "discountPence" FROM order_offers x
        WHERE x.superseded_at IS NULL AND x.created_at >= $1 AND x.created_at < $2 GROUP BY x.title, x.code ORDER BY "discountPence" DESC`,
    'tax-collected': `SELECT o.ref, o.tax_label AS label, o.tax_rate_bp AS "rateBp", o.taxable_pence AS "taxablePence", o.tax_pence AS "taxPence", o.created_at AS "createdAt"
        FROM orders o WHERE o.tax_pence > 0 AND o.created_at >= $1 AND o.created_at < $2
          AND EXISTS (SELECT 1 FROM bookings x WHERE x.order_id=o.id AND x.status NOT IN ('cancelled','rejected')) ORDER BY o.created_at`,
    refunds: `SELECT r.created_at AS "createdAt", b.ref, r.amount_pence AS "amountPence", r.status, r.reason FROM refunds r JOIN bookings b ON b.id=r.booking_id WHERE r.created_at >= $1 AND r.created_at < $2 ORDER BY r.created_at`,
    cancellations: `SELECT b.ref, b.status, b.cancelled_at AS "cancelledAt", b.cancel_reason AS reason, b.total_pence AS "totalPence" FROM bookings b WHERE b.status IN ('cancelled','rejected','cancellation_requested') AND b.start_at >= $1 AND b.start_at < $2 ORDER BY b.start_at`,
    'popular-events': `SELECT COALESCE(e.title,'(no event)') AS event, count(*)::int AS bookings FROM bookings b LEFT JOIN event_types e ON e.id=b.event_type_id
        WHERE b.status IN ${LIVE} AND b.start_at >= $1 AND b.start_at < $2 GROUP BY e.title ORDER BY bookings DESC`,
    offers: `SELECT o.title, o.code, count(r.id)::int AS uses, COALESCE(sum(r.discount_pence),0)::int AS "discountGivenPence" FROM offers o
        LEFT JOIN offer_redemptions r ON r.offer_id=o.id AND r.released_at IS NULL AND r.created_at >= $1 AND r.created_at < $2 GROUP BY o.id ORDER BY uses DESC`,
    'driver-workload': `SELECT d.full_name AS driver, count(a.id)::int AS assignments, COALESCE(round(sum(EXTRACT(EPOCH FROM (b.end_at-b.start_at))/3600)::numeric,1),0)::float AS hours
        FROM drivers d LEFT JOIN driver_assignments a ON a.driver_id=d.id AND a.active LEFT JOIN bookings b ON b.id=a.booking_id AND b.start_at >= $1 AND b.start_at < $2 AND b.status NOT IN ('cancelled','rejected')
        GROUP BY d.id ORDER BY hours DESC`,
  };

  app.get('/reports/:name', async (req) => {
    const { name } = z.object({ name: z.string() }).parse(req.params);
    const q = z.object({ from: date, to: date, format: z.enum(['json', 'csv']).default('json') }).parse(req.query);
    const sql = reports[name];
    if (!sql) throw notFound('Unknown report');
    const tz = (await getSettings())['booking.timezone'];
    const range = [DateTime.fromISO(q.from, { zone: tz }).toUTC().toJSDate(), DateTime.fromISO(q.to, { zone: tz }).plus({ days: 1 }).toUTC().toJSDate()];
    const rows = (await pool.query(sql, range)).rows;
    if (q.format === 'csv') { await audit(pool, req.user.sub, 'report', name, 'export_csv', null, { rows: rows.length }); return { csv: toCsv(rows) }; }
    return { name, from: q.from, to: q.to, rows };
  });

  /* ---------- Settings ---------- */
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
        if (k === 'booking.maxAdvanceDays' && (!Number.isInteger(v) || (v as number) < 1 || (v as number) > 1095)) throw badRequest('Advance booking must be between 1 and 1095 days');
        if ((k === 'delivery.ratePerMilePence' || k === 'delivery.showroomFeePence') && !Number.isInteger(v)) throw badRequest(`${k} must be a whole number of pence`);
        if (typeof v === 'number' && (!Number.isFinite(v) || v < 0)) throw badRequest(`Setting ${k} must be zero or more`);
        if (k === 'email.port' && (!Number.isInteger(v) || (v as number) < 1 || (v as number) > 65535)) throw badRequest('Email port must be between 1 and 65535');
        if (k === 'email.fromAddress' && v && !z.string().email().safeParse(v).success) throw badRequest('From address must be a valid email address');
        if (k === 'email.host' && v && !/^[A-Za-z0-9.-]+$/.test(String(v).trim())) throw badRequest('Email server must be a host name like smtp.example.com');
        if (k === 'maps.provider' && v !== 'osm' && v !== 'google') throw badRequest('Map provider must be osm or google');
        if (k === 'maps.countryCodes' && !/^([a-zA-Z]{2})(,\s*[a-zA-Z]{2})*$/.test(String(v).trim())) throw badRequest('Countries must be two-letter codes separated by commas, e.g. gb,ie');
        await setSetting(k as SettingKey, typeof v === 'string' ? v.trim() : v, c);
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
    const r = await sendMail({
      to, subject: `Test email from ${s['company.name']}`,
      text: `This is a test message from the ${s['company.name']} admin dashboard.\n\nIf you can read it, your email connection works and customers will receive booking emails and password reset codes.`,
    });
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

  /* ---------- Misc ---------- */
  app.get('/audit-log', async (req) => {
    const q = z.object({ entity: z.string().optional(), limit: z.coerce.number().int().min(1).max(500).default(100) }).parse(req.query);
    return { items: (await pool.query(
      `SELECT a.id, a.entity, a.entity_id AS "entityId", a.action, a.before, a.after, a.created_at AS "createdAt", s.name AS staff
         FROM audit_log a LEFT JOIN staff_users s ON s.id=a.staff_id WHERE ($1::text IS NULL OR a.entity=$1) ORDER BY a.id DESC LIMIT $2`, [q.entity ?? null, q.limit])).rows };
  });

  app.get('/notifications', async () => ({
    items: (await pool.query(`SELECT id, kind, title, body, booking_id AS "bookingId", read_at AS "readAt", created_at AS "createdAt" FROM notifications WHERE staff_only ORDER BY created_at DESC LIMIT 100`)).rows,
  }));

  app.post('/maintenance/expire-holds', async () => ({ expired: await tx((c) => expireHolds(c)) }));
}
