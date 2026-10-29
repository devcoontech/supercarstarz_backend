import type { FastifyInstance } from 'fastify';
import crypto from 'node:crypto';
import { z } from 'zod';
import { putPublic, removePublic } from '../storage.js';
import { pool, tx } from '../db.js';
import { badRequest, conflict, notFound } from '../errors.js';
import { audit, buildInsert, buildUpdate, sniffImage } from '../util.js';
import { lockVehicle, rangeParam } from '../bookings.js';
import { mustGeocode } from '../maps.js';
import { DateTime } from 'luxon';

const id = z.string().uuid();
const idParams = z.object({ id });

const vehicleFields: Record<string, string> = {
  fleetRef: 'fleet_ref', make: 'make', model: 'model', year: 'year', category: 'category', colour: 'colour', transmission: 'transmission',
  seats: 'seats', power: 'power', topSpeed: 'top_speed', city: 'city', area: 'area', description: 'description', amenities: 'amenities',
  specs: 'specs', pricePerHourPence: 'price_per_hour_pence', deliveryAvailable: 'delivery_available', deliveryFeePence: 'delivery_fee_pence',
  deliveryRadiusMiles: 'delivery_radius_miles', stationaryAvailable: 'stationary_available', minHours: 'min_hours', maxHours: 'max_hours',
  bufferMinutes: 'buffer_minutes', chauffeurAvailable: 'chauffeur_available', chauffeurFeePence: 'chauffeur_fee_pence',
  depositPence: 'deposit_pence', operationalStatus: 'operational_status',
  baseAddress: 'base_address', baseLat: 'base_lat', baseLng: 'base_lng', deliveryPricing: 'delivery_pricing', deliveryPerMilePence: 'delivery_per_mile_pence',
  deliveryFreeMiles: 'delivery_free_miles', deliveryMinPence: 'delivery_min_pence', deliveryRoundTrip: 'delivery_round_trip', chauffeurChargeType: 'chauffeur_charge_type',
  selfDriveAvailable: 'self_drive_available',
};
const vehicleBase = z.object({
  fleetRef: z.string().trim().max(40).nullish(), make: z.string().trim().min(1).max(60), model: z.string().trim().min(1).max(80),
  year: z.number().int().min(1990).max(2100), category: z.enum(['Supercar', 'Convertible', 'SUV', 'Luxury']),
  colour: z.string().max(60).nullish(), transmission: z.string().max(40).nullish(), seats: z.number().int().min(1).max(20),
  power: z.string().max(40).nullish(), topSpeed: z.string().max(40).nullish(), city: z.string().trim().min(1).max(80), area: z.string().max(80).nullish(),
  description: z.string().max(4000), amenities: z.array(z.string().max(60)).max(40), specs: z.record(z.string(), z.unknown()),
  pricePerHourPence: z.number().int().min(0), deliveryAvailable: z.boolean(), deliveryFeePence: z.number().int().min(0),
  deliveryRadiusMiles: z.number().min(0).max(2000), stationaryAvailable: z.boolean(), minHours: z.number().int().min(1), maxHours: z.number().int().min(1),
  bufferMinutes: z.number().int().min(0).max(1440), chauffeurAvailable: z.boolean(), chauffeurFeePence: z.number().int().min(0),
  depositPence: z.number().int().min(0), operationalStatus: z.enum(['active', 'inactive', 'maintenance']),
  baseAddress: z.string().trim().max(300).nullish(), deliveryPricing: z.enum(['flat', 'per_mile']), deliveryPerMilePence: z.number().int().min(0),
  deliveryFreeMiles: z.number().min(0).max(1000), deliveryMinPence: z.number().int().min(0), deliveryRoundTrip: z.boolean(),
  chauffeurChargeType: z.enum(['fixed', 'hourly']), selfDriveAvailable: z.boolean(),
});

/** A car has to be bookable one way or the other. */
const checkDriving = (selfDrive: boolean, chauffeur: boolean) => {
  if (!selfDrive && !chauffeur) throw badRequest('Offer the car self-drive, with a driver, or both', 'no_driving_option');
};

/** Looks up the car's base address so delivery distance can be measured from it. Blank clears it. */
async function withBaseCoordinates<T extends { baseAddress?: string | null }>(data: T) {
  if (!('baseAddress' in data)) return data;
  const addr = data.baseAddress?.trim();
  if (!addr) return { ...data, baseAddress: null, baseLat: null, baseLng: null };
  const p = await mustGeocode(addr, "the car's base address");
  return { ...data, baseAddress: p.label, baseLat: p.lat, baseLng: p.lng };
}
const vehicleCreate = vehicleBase.partial().required({ make: true, model: true, year: true, category: true, seats: true, city: true, pricePerHourPence: true }).strict();
const vehicleUpdate = vehicleBase.partial().strict();

const vehicleAdminSelect = `
  SELECT v.*,
    COALESCE((SELECT json_agg(json_build_object('id', i.id, 'url', i.url, 'isCover', i.is_cover, 'sortOrder', i.sort_order) ORDER BY i.sort_order, i.created_at)
              FROM vehicle_images i WHERE i.vehicle_id=v.id), '[]') AS images,
    COALESCE((SELECT json_agg(x.event_type_id) FROM vehicle_event_types x WHERE x.vehicle_id=v.id), '[]') AS event_type_ids,
    COALESCE((SELECT json_agg(x.addon_id) FROM vehicle_addons x WHERE x.vehicle_id=v.id), '[]') AS addon_ids
  FROM vehicles v`;

const eventFields: Record<string, string> = {
  slug: 'slug', title: 'title', description: 'description', imageUrl: 'image_url', requirements: 'requirements', minHours: 'min_hours', published: 'published', sortOrder: 'sort_order', pricingBasis: 'pricing_basis',
};
const slugify = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 60);

export async function adminCatalogRoutes(app: FastifyInstance) {
  app.addHook('onRequest', app.staffOnly);

  /* ---------- Vehicles ---------- */
  app.get('/vehicles', async (req) => {
    const q = z.object({
      status: z.enum(['active', 'inactive', 'maintenance']).optional(), published: z.enum(['true', 'false']).optional(), q: z.string().max(80).optional(),
      limit: z.coerce.number().int().min(1).max(200).default(50), offset: z.coerce.number().int().min(0).default(0),
    }).parse(req.query);
    const w = ['v.deleted_at IS NULL'];
    const p: unknown[] = [];
    if (q.status) { p.push(q.status); w.push(`v.operational_status=$${p.length}`); }
    if (q.published) { p.push(q.published === 'true'); w.push(`v.published=$${p.length}`); }
    if (q.q) { p.push(`%${q.q}%`); w.push(`(v.make||' '||v.model||' '||coalesce(v.fleet_ref,'')) ILIKE $${p.length}`); }
    p.push(q.limit, q.offset);
    const rows = (await pool.query(`${vehicleAdminSelect} WHERE ${w.join(' AND ')} ORDER BY v.created_at DESC LIMIT $${p.length - 1} OFFSET $${p.length}`, p)).rows;
    const total = (await pool.query(`SELECT count(*)::int n FROM vehicles v WHERE ${w.join(' AND ')}`, p.slice(0, -2))).rows[0].n;
    return { items: rows, total };
  });

  app.get('/vehicles/:id', async (req) => {
    const { id: vid } = idParams.parse(req.params);
    const v = (await pool.query(`${vehicleAdminSelect} WHERE v.id=$1 AND v.deleted_at IS NULL`, [vid])).rows[0];
    if (!v) throw notFound('Vehicle not found');
    return v;
  });

  app.post('/vehicles', async (req, reply) => {
    const data = await withBaseCoordinates(vehicleCreate.parse(req.body));
    if (data.minHours && data.maxHours && data.maxHours < data.minHours) throw badRequest('Maximum hours must be at least the minimum');
    checkDriving(data.selfDriveAvailable ?? true, data.chauffeurAvailable ?? false);
    const ins = buildInsert('vehicles', vehicleFields, data);
    const row = await tx(async (c) => {
      const r = (await c.query(ins.sql, ins.vals)).rows[0];
      await audit(c, req.user.sub, 'vehicle', r.id, 'create', null, r);
      return r;
    });
    return reply.status(201).send(row);
  });

  app.patch('/vehicles/:id', async (req) => {
    const { id: vid } = idParams.parse(req.params);
    const data = await withBaseCoordinates(vehicleUpdate.parse(req.body));
    return tx(async (c) => {
      await lockVehicle(c, vid);
      const before = (await c.query('SELECT * FROM vehicles WHERE id=$1 AND deleted_at IS NULL FOR UPDATE', [vid])).rows[0];
      if (!before) throw notFound('Vehicle not found');
      const minH = data.minHours ?? before.min_hours, maxH = data.maxHours ?? before.max_hours;
      if (maxH < minH) throw badRequest('Maximum hours must be at least the minimum');
      checkDriving(data.selfDriveAvailable ?? before.self_drive_available, data.chauffeurAvailable ?? before.chauffeur_available);
      const u = buildUpdate('vehicles', vid, vehicleFields, data);
      if (u.empty) return before;
      const after = (await c.query(u.sql, u.vals)).rows[0];
      if (after.operational_status !== 'active' && before.operational_status === 'active') {
        const future = (await c.query(
          `SELECT count(*)::int n FROM bookings WHERE vehicle_id=$1 AND end_at > now() AND status IN ('pending','awaiting_payment','confirmed','driver_assigned')`, [vid])).rows[0].n;
        if (future) await audit(c, req.user.sub, 'vehicle', vid, 'taken_out_of_service_with_bookings', null, { upcomingBookings: future });
      }
      await audit(c, req.user.sub, 'vehicle', vid, 'update', before, after);
      return after;
    });
  });

  /** Publish / unpublish. A car needs a cover image and at least one supported published event to go live. */
  app.post('/vehicles/:id/publish', async (req) => {
    const { id: vid } = idParams.parse(req.params);
    const { published } = z.object({ published: z.boolean() }).parse(req.body);
    return tx(async (c) => {
      const v = (await c.query('SELECT * FROM vehicles WHERE id=$1 AND deleted_at IS NULL FOR UPDATE', [vid])).rows[0];
      if (!v) throw notFound('Vehicle not found');
      if (published) {
        const img = (await c.query('SELECT 1 FROM vehicle_images WHERE vehicle_id=$1 AND is_cover', [vid])).rowCount;
        if (!img) throw conflict('Add at least one image and choose a cover before publishing', 'publish_requirements');
        if (v.operational_status !== 'active') throw conflict('Only active vehicles can be published', 'publish_requirements');
      }
      const r = (await c.query('UPDATE vehicles SET published=$2, updated_at=now() WHERE id=$1 RETURNING *', [vid, published])).rows[0];
      await audit(c, req.user.sub, 'vehicle', vid, published ? 'publish' : 'unpublish');
      return r;
    });
  });

  /** Soft delete. Historical bookings keep their reference. Refused while future bookings exist. */
  app.delete('/vehicles/:id', async (req) => {
    const { id: vid } = idParams.parse(req.params);
    return tx(async (c) => {
      await lockVehicle(c, vid);
      const future = (await c.query(
        `SELECT count(*)::int n FROM bookings WHERE vehicle_id=$1 AND end_at > now() AND status IN ('pending','awaiting_payment','confirmed','driver_assigned','in_progress','cancellation_requested')`, [vid])).rows[0].n;
      if (future) throw conflict(`This vehicle has ${future} upcoming booking(s). Reassign or cancel them first.`, 'has_bookings');
      const r = await c.query('UPDATE vehicles SET deleted_at=now(), published=false, operational_status=\'inactive\', updated_at=now() WHERE id=$1 AND deleted_at IS NULL RETURNING id', [vid]);
      if (!r.rowCount) throw notFound('Vehicle not found');
      await audit(c, req.user.sub, 'vehicle', vid, 'delete');
      return { ok: true };
    });
  });

  app.put('/vehicles/:id/event-types', async (req) => {
    const { id: vid } = idParams.parse(req.params);
    const { eventTypeIds } = z.object({ eventTypeIds: z.array(id).max(100) }).parse(req.body);
    return tx(async (c) => {
      if (!(await c.query('SELECT 1 FROM vehicles WHERE id=$1 AND deleted_at IS NULL', [vid])).rowCount) throw notFound('Vehicle not found');
      await c.query('DELETE FROM vehicle_event_types WHERE vehicle_id=$1', [vid]);
      for (const e of eventTypeIds) await c.query('INSERT INTO vehicle_event_types(vehicle_id, event_type_id) VALUES ($1,$2)', [vid, e]);
      await audit(c, req.user.sub, 'vehicle', vid, 'set_event_types', null, eventTypeIds);
      return { eventTypeIds };
    });
  });

  /** Which add-ons customers can choose for this car (add-ons offered on every car are always included). */
  app.put('/vehicles/:id/addons', async (req) => {
    const { id: vid } = idParams.parse(req.params);
    const { addonIds } = z.object({ addonIds: z.array(id).max(200) }).parse(req.body);
    return tx(async (c) => {
      if (!(await c.query('SELECT 1 FROM vehicles WHERE id=$1 AND deleted_at IS NULL', [vid])).rowCount) throw notFound('Vehicle not found');
      const before = (await c.query('SELECT addon_id FROM vehicle_addons WHERE vehicle_id=$1', [vid])).rows.map((r) => r.addon_id);
      await c.query('DELETE FROM vehicle_addons WHERE vehicle_id=$1', [vid]);
      for (const a of new Set(addonIds)) await c.query('INSERT INTO vehicle_addons(vehicle_id, addon_id) VALUES ($1,$2)', [vid, a]);
      await audit(c, req.user.sub, 'vehicle', vid, 'set_addons', before, addonIds);
      return { addonIds };
    });
  });

  app.get('/vehicles/:id/bookings', async (req) => {
    const { id: vid } = idParams.parse(req.params);
    return { items: (await pool.query(
      `SELECT b.id, b.ref, b.status, b.start_at AS "startAt", b.end_at AS "endAt", b.total_pence AS "totalPence", c.name AS customer
         FROM bookings b JOIN customers c ON c.id=b.customer_id WHERE b.vehicle_id=$1 ORDER BY b.start_at DESC LIMIT 200`, [vid])).rows };
  });

  /* ---------- Images ---------- */
  app.post('/vehicles/:id/images', async (req, reply) => {
    const { id: vid } = idParams.parse(req.params);
    if (!(await pool.query('SELECT 1 FROM vehicles WHERE id=$1 AND deleted_at IS NULL', [vid])).rowCount) throw notFound('Vehicle not found');
    const saved: unknown[] = [];
    const failed: { filename: string; reason: string }[] = [];
    for await (const part of req.files()) {
      const buf = await part.toBuffer();
      if (part.file.truncated) { failed.push({ filename: part.filename, reason: 'File is larger than 8 MB' }); continue; }
      const type = sniffImage(buf);
      if (!type) { failed.push({ filename: part.filename, reason: 'Only JPEG, PNG or WebP images are accepted' }); continue; }
      const key = `vehicles/${vid}/${crypto.randomUUID()}.${type.ext}`;
      let url: string;
      try {
        url = await putPublic(key, buf, type.mime);
      } catch {
        failed.push({ filename: part.filename, reason: 'Could not save the image' });
        continue;
      }
      try {
        const row = await tx(async (c) => {
          await lockVehicle(c, vid);
          const n = (await c.query('SELECT count(*)::int n, COALESCE(max(sort_order),-1)+1 AS next FROM vehicle_images WHERE vehicle_id=$1', [vid])).rows[0];
          return (await c.query(
            `INSERT INTO vehicle_images(vehicle_id, url, storage_key, sort_order, is_cover) VALUES ($1,$2,$3,$4,$5) RETURNING id, url, is_cover AS "isCover", sort_order AS "sortOrder"`,
            [vid, url, key, n.next, n.n === 0])).rows[0];
        });
        saved.push(row);
      } catch {
        await removePublic(key);
        failed.push({ filename: part.filename, reason: 'Could not save the image' });
      }
    }
    await audit(pool, req.user.sub, 'vehicle', vid, 'upload_images', null, { saved: saved.length, failed: failed.length });
    if (failed.length && !saved.length) {
      return reply.status(400).send({ error: { code: 'upload_failed', message: failed.map((f) => `${f.filename}: ${f.reason}`).join('; ') }, saved, failed });
    }
    return reply.status(201).send({ saved, failed });
  });

  app.put('/vehicles/:id/images/order', async (req) => {
    const { id: vid } = idParams.parse(req.params);
    const { imageIds } = z.object({ imageIds: z.array(id).min(1).max(50) }).parse(req.body);
    return tx(async (c) => {
      const have = (await c.query('SELECT id FROM vehicle_images WHERE vehicle_id=$1', [vid])).rows.map((r) => r.id as string).sort();
      if (JSON.stringify(have) !== JSON.stringify([...imageIds].sort())) throw badRequest('imageIds must list every image of this vehicle exactly once');
      for (let i = 0; i < imageIds.length; i++) await c.query('UPDATE vehicle_images SET sort_order=$2 WHERE id=$1', [imageIds[i], i]);
      return { ok: true };
    });
  });

  app.post('/vehicles/:id/images/:imageId/cover', async (req) => {
    const p = z.object({ id, imageId: id }).parse(req.params);
    return tx(async (c) => {
      if (!(await c.query('SELECT 1 FROM vehicle_images WHERE id=$1 AND vehicle_id=$2', [p.imageId, p.id])).rowCount) throw notFound('Image not found');
      await c.query('UPDATE vehicle_images SET is_cover=false WHERE vehicle_id=$1 AND is_cover', [p.id]);
      await c.query('UPDATE vehicle_images SET is_cover=true WHERE id=$1', [p.imageId]);
      return { ok: true };
    });
  });

  app.delete('/vehicles/:id/images/:imageId', async (req) => {
    const p = z.object({ id, imageId: id }).parse(req.params);
    return tx(async (c) => {
      const img = (await c.query('DELETE FROM vehicle_images WHERE id=$1 AND vehicle_id=$2 RETURNING *', [p.imageId, p.id])).rows[0];
      if (!img) throw notFound('Image not found');
      if (img.is_cover) {
        const next = (await c.query('SELECT id FROM vehicle_images WHERE vehicle_id=$1 ORDER BY sort_order LIMIT 1', [p.id])).rows[0];
        if (next) await c.query('UPDATE vehicle_images SET is_cover=true WHERE id=$1', [next.id]);
        else await c.query('UPDATE vehicles SET published=false WHERE id=$1', [p.id]); // cannot stay live without a cover
      }
      if (img.storage_key) await removePublic(img.storage_key, img.url);
      return { ok: true };
    });
  });

  /** Single image for events and offers. Same validation as vehicle images; returns the public URL to store on the record. */
  app.post('/uploads/:kind', async (req, reply) => {
    const { kind } = z.object({ kind: z.enum(['events', 'offers', 'addons']) }).parse(req.params);
    const part = await req.file();
    if (!part) throw badRequest('No file received', 'no_file');
    const buf = await part.toBuffer();
    if (part.file.truncated) throw badRequest('File is larger than 8 MB', 'file_too_large');
    const type = sniffImage(buf);
    if (!type) throw badRequest('Only JPEG, PNG or WebP images are accepted', 'invalid_image');
    const key = `${kind}/${crypto.randomUUID()}.${type.ext}`;
    const url = await putPublic(key, buf, type.mime);
    await audit(pool, req.user.sub, 'upload', key, 'create');
    return reply.status(201).send({ url });
  });

  /* ---------- Event types ---------- */
  const eventBody = z.object({
    slug: z.string().regex(/^[a-z0-9-]+$/).max(60), title: z.string().trim().min(1).max(100), description: z.string().max(2000), imageUrl: z.string().url().nullish(),
    requirements: z.record(z.string(), z.unknown()), minHours: z.number().int().min(1).nullish(), published: z.boolean(), sortOrder: z.number().int(), pricingBasis: z.enum(['hourly', 'distance']),
  });

  app.get('/event-types', async () => ({
    items: (await pool.query(
      `SELECT e.*, COALESCE((SELECT json_agg(x.vehicle_id) FROM vehicle_event_types x WHERE x.event_type_id=e.id), '[]') AS vehicle_ids
         FROM event_types e ORDER BY e.archived_at NULLS FIRST, e.sort_order, e.title`)).rows,
  }));

  app.post('/event-types', async (req, reply) => {
    const raw = eventBody.partial().required({ title: true }).strict().parse(req.body);
    const data = { ...raw, slug: raw.slug ?? slugify(raw.title) };
    const ins = buildInsert('event_types', eventFields, data);
    const row = await tx(async (c) => {
      const r = (await c.query(ins.sql, ins.vals)).rows[0];
      await audit(c, req.user.sub, 'event_type', r.id, 'create', null, r);
      return r;
    });
    return reply.status(201).send(row);
  });

  app.patch('/event-types/:id', async (req) => {
    const { id: eid } = idParams.parse(req.params);
    const data = eventBody.partial().strict().parse(req.body);
    return tx(async (c) => {
      const before = (await c.query('SELECT * FROM event_types WHERE id=$1 FOR UPDATE', [eid])).rows[0];
      if (!before) throw notFound('Event type not found');
      const u = buildUpdate('event_types', eid, eventFields, data, false);
      if (u.empty) return before;
      const after = (await c.query(u.sql, u.vals)).rows[0];
      await audit(c, req.user.sub, 'event_type', eid, 'update', before, after);
      return after;
    });
  });

  /** Archive hides it from customers but keeps it on historical bookings. */
  app.post('/event-types/:id/archive', async (req) => {
    const { id: eid } = idParams.parse(req.params);
    const { archived } = z.object({ archived: z.boolean() }).parse(req.body);
    const r = await pool.query(`UPDATE event_types SET archived_at=${archived ? 'now()' : 'NULL'}, published=${archived ? 'false' : 'published'} WHERE id=$1 RETURNING *`, [eid]);
    if (!r.rowCount) throw notFound('Event type not found');
    await audit(pool, req.user.sub, 'event_type', eid, archived ? 'archive' : 'unarchive');
    return r.rows[0];
  });

  app.put('/event-types/order', async (req) => {
    const { ids } = z.object({ ids: z.array(id).min(1).max(200) }).parse(req.body);
    await tx(async (c) => { for (let i = 0; i < ids.length; i++) await c.query('UPDATE event_types SET sort_order=$2 WHERE id=$1', [ids[i], i]); });
    return { ok: true };
  });

  app.put('/event-types/:id/vehicles', async (req) => {
    const { id: eid } = idParams.parse(req.params);
    const { vehicleIds } = z.object({ vehicleIds: z.array(id).max(500) }).parse(req.body);
    return tx(async (c) => {
      if (!(await c.query('SELECT 1 FROM event_types WHERE id=$1', [eid])).rowCount) throw notFound('Event type not found');
      await c.query('DELETE FROM vehicle_event_types WHERE event_type_id=$1', [eid]);
      for (const v of vehicleIds) await c.query('INSERT INTO vehicle_event_types(vehicle_id, event_type_id) VALUES ($1,$2)', [v, eid]);
      await audit(c, req.user.sub, 'event_type', eid, 'set_vehicles', null, vehicleIds);
      return { vehicleIds };
    });
  });

  /* ---------- Pricing rules ---------- */
  const ruleBody = z.object({
    vehicleId: id.nullish(), eventTypeId: id.nullish(), kind: z.enum(['hourly', 'package', 'extra_hour', 'special_date', 'per_mile']), label: z.string().max(80).nullish(),
    hours: z.number().int().min(1).nullish(), amountPence: z.number().int().min(0).nullish(), minAmountPence: z.number().int().min(0).nullish(), multiplierBp: z.number().int().min(1).max(100000).nullish(),
    startsOn: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullish(), endsOn: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullish(), active: z.boolean().default(true),
  });
  const ruleFields = { vehicleId: 'vehicle_id', eventTypeId: 'event_type_id', kind: 'kind', label: 'label', hours: 'hours', amountPence: 'amount_pence', minAmountPence: 'min_amount_pence', multiplierBp: 'multiplier_bp', startsOn: 'starts_on', endsOn: 'ends_on', active: 'active' };

  app.get('/pricing-rules', async (req) => {
    const q = z.object({ vehicleId: id.optional(), eventTypeId: id.optional() }).parse(req.query);
    return { items: (await pool.query(
      `SELECT id, vehicle_id AS "vehicleId", event_type_id AS "eventTypeId", kind, label, hours, amount_pence AS "amountPence", min_amount_pence AS "minAmountPence", multiplier_bp AS "multiplierBp",
              to_char(starts_on,'YYYY-MM-DD') AS "startsOn", to_char(ends_on,'YYYY-MM-DD') AS "endsOn", active
         FROM pricing_rules WHERE ($1::uuid IS NULL OR vehicle_id=$1) AND ($2::uuid IS NULL OR event_type_id=$2) ORDER BY created_at DESC`,
      [q.vehicleId ?? null, q.eventTypeId ?? null])).rows };
  });

  app.post('/pricing-rules', async (req, reply) => {
    const data = ruleBody.parse(req.body);
    if (data.kind === 'special_date' && data.endsOn! < data.startsOn!) throw badRequest('End date must not be before start date');
    const ins = buildInsert('pricing_rules', ruleFields, data);
    const row = await tx(async (c) => {
      const r = (await c.query(ins.sql, ins.vals)).rows[0];
      await audit(c, req.user.sub, 'pricing_rule', r.id, 'create', null, r);
      return r;
    }).catch((e) => { if (e.code === '23514') throw badRequest('That rule is missing required fields for its type', 'invalid_rule'); throw e; });
    return reply.status(201).send(row);
  });

  app.patch('/pricing-rules/:id', async (req) => {
    const { id: rid } = idParams.parse(req.params);
    const data = ruleBody.partial().strict().parse(req.body);
    const u = buildUpdate('pricing_rules', rid, ruleFields, data, false);
    if (u.empty) throw badRequest('Nothing to update');
    const r = await pool.query(u.sql, u.vals).catch((e) => { if (e.code === '23514') throw badRequest('That rule is missing required fields for its type', 'invalid_rule'); throw e; });
    if (!r.rowCount) throw notFound('Rule not found');
    await audit(pool, req.user.sub, 'pricing_rule', rid, 'update', null, r.rows[0]);
    return r.rows[0];
  });

  app.delete('/pricing-rules/:id', async (req) => {
    const { id: rid } = idParams.parse(req.params);
    // Existing bookings keep their pricing snapshot, so deleting a rule never changes them.
    const r = await pool.query('DELETE FROM pricing_rules WHERE id=$1 RETURNING id', [rid]);
    if (!r.rowCount) throw notFound('Rule not found');
    await audit(pool, req.user.sub, 'pricing_rule', rid, 'delete');
    return { ok: true };
  });

  /* ---------- Add-ons ----------
   * Optional services (photographer, decoration, delivery extras, equipment, anything else). Prices here are today's
   * prices: a booking stores the price agreed when it was made (booking_addons), so changing one never alters a booking. */
  const addonBody = z.object({
    name: z.string().trim().min(1).max(100), detail: z.string().max(300).nullish(), pricePence: z.number().int().min(0).max(10_000_000), active: z.boolean(), sortOrder: z.number().int(),
    imageUrl: z.string().url().max(500).nullish(), pricingType: z.enum(['fixed', 'per_hour', 'per_unit']), maxQuantity: z.number().int().min(1).max(100),
    allVehicles: z.boolean(), vehicleIds: z.array(id).max(500),
  });
  const addonFields = {
    name: 'name', detail: 'detail', pricePence: 'price_pence', active: 'active', sortOrder: 'sort_order', imageUrl: 'image_url', pricingType: 'pricing_type',
    maxQuantity: 'max_quantity', allVehicles: 'all_vehicles',
  };
  const addonSelect = `SELECT a.id, a.name, a.detail, a.price_pence AS "pricePence", a.active, a.sort_order AS "sortOrder", a.image_url AS "imageUrl",
      a.pricing_type AS "pricingType", a.max_quantity AS "maxQuantity", a.all_vehicles AS "allVehicles",
      COALESCE((SELECT json_agg(x.vehicle_id) FROM vehicle_addons x WHERE x.addon_id=a.id), '[]') AS "vehicleIds",
      (SELECT count(*)::int FROM booking_addons ba WHERE ba.addon_id=a.id) AS "timesBooked"
    FROM addons a`;
  const setAddonVehicles = async (c: any, aid: string, vehicleIds: string[] | undefined) => {
    if (!vehicleIds) return;
    await c.query('DELETE FROM vehicle_addons WHERE addon_id=$1', [aid]);
    for (const v of new Set(vehicleIds)) await c.query('INSERT INTO vehicle_addons(vehicle_id, addon_id) VALUES ($1,$2)', [v, aid]);
  };
  app.get('/addons', async () => ({ items: (await pool.query(`${addonSelect} ORDER BY a.sort_order, a.name`)).rows }));
  app.post('/addons', async (req, reply) => {
    const { vehicleIds, ...data } = addonBody.partial().required({ name: true, pricePence: true }).strict().parse(req.body);
    const ins = buildInsert('addons', addonFields, data);
    const out = await tx(async (c) => {
      const r = (await c.query(ins.sql, ins.vals)).rows[0];
      await setAddonVehicles(c, r.id, vehicleIds);
      await audit(c, req.user.sub, 'addon', r.id, 'create', null, { ...r, vehicleIds });
      return (await c.query(`${addonSelect} WHERE a.id=$1`, [r.id])).rows[0];
    });
    return reply.status(201).send(out);
  });
  app.patch('/addons/:id', async (req) => {
    const { id: aid } = idParams.parse(req.params);
    const { vehicleIds, ...data } = addonBody.partial().strict().parse(req.body);
    const u = buildUpdate('addons', aid, addonFields, data);
    if (u.empty && !vehicleIds) throw badRequest('Nothing to update');
    return tx(async (c) => {
      const before = (await c.query(`${addonSelect} WHERE a.id=$1`, [aid])).rows[0];
      if (!before) throw notFound('Add-on not found');
      if (!u.empty) await c.query(u.sql, u.vals);
      await setAddonVehicles(c, aid, vehicleIds);
      const after = (await c.query(`${addonSelect} WHERE a.id=$1`, [aid])).rows[0];
      await audit(c, req.user.sub, 'addon', aid, 'update', before, after);
      return after;
    });
  });

  /* ---------- Deleting ---------- */
  // Bookings keep their own price snapshot, so removing an extra never changes an existing booking.
  app.delete('/addons/:id', async (req) => {
    const { id: aid } = idParams.parse(req.params);
    const r = await pool.query('DELETE FROM addons WHERE id=$1 RETURNING name', [aid]);
    if (!r.rowCount) throw notFound('Add-on not found');
    await audit(pool, req.user.sub, 'addon', aid, 'delete', r.rows[0], null);
    return { ok: true };
  });

  /** Only event types nobody has booked can be deleted; otherwise archive them (history keeps the label). */
  app.delete('/event-types/:id', async (req) => {
    const { id: eid } = idParams.parse(req.params);
    return tx(async (c) => {
      const ev = (await c.query('SELECT title FROM event_types WHERE id=$1 FOR UPDATE', [eid])).rows[0];
      if (!ev) throw notFound('Event type not found');
      const used = (await c.query('SELECT count(*)::int n FROM bookings WHERE event_type_id=$1', [eid])).rows[0].n;
      if (used) throw conflict(`${used} booking(s) used "${ev.title}". Archive it instead so past bookings keep their label.`, 'has_bookings');
      await c.query('DELETE FROM pricing_rules WHERE event_type_id=$1', [eid]);
      await c.query('DELETE FROM vehicle_event_types WHERE event_type_id=$1', [eid]);
      await c.query('DELETE FROM event_types WHERE id=$1', [eid]);
      await audit(c, req.user.sub, 'event_type', eid, 'delete', ev, null);
      return { ok: true };
    });
  });

  /* ---------- Availability blocks & calendar ---------- */
  app.get('/vehicles/:id/calendar', async (req) => {
    const { id: vid } = idParams.parse(req.params);
    const q = z.object({ from: z.string().datetime({ offset: true }), to: z.string().datetime({ offset: true }) }).parse(req.query);
    const range = rangeParam(DateTime.fromISO(q.from), DateTime.fromISO(q.to));
    const bookings = (await pool.query(
      `SELECT b.id, b.ref, b.status, b.start_at AS "startAt", b.end_at AS "endAt", c.name AS customer
         FROM bookings b JOIN customers c ON c.id=b.customer_id
        WHERE b.vehicle_id=$1 AND tstzrange(b.start_at,b.end_at) && $2::tstzrange AND b.status NOT IN ('cancelled','rejected','payment_failed') ORDER BY b.start_at`, [vid, range])).rows;
    const blocks = (await pool.query(
      `SELECT id, lower(during) AS "startAt", upper(during) AS "endAt", kind, reason FROM availability_blocks WHERE vehicle_id=$1 AND during && $2::tstzrange ORDER BY lower(during)`, [vid, range])).rows;
    return { bookings, blocks };
  });

  app.post('/vehicles/:id/blocks', async (req, reply) => {
    const { id: vid } = idParams.parse(req.params);
    const b = z.object({ startAt: z.string().datetime({ offset: true }), endAt: z.string().datetime({ offset: true }), kind: z.enum(['blocked', 'maintenance']).default('blocked'), reason: z.string().max(300).optional() }).parse(req.body);
    const s = DateTime.fromISO(b.startAt), e = DateTime.fromISO(b.endAt);
    if (e <= s) throw badRequest('End must be after start');
    const row = await tx(async (c) => {
      await lockVehicle(c, vid);
      if (!(await c.query('SELECT 1 FROM vehicles WHERE id=$1 AND deleted_at IS NULL', [vid])).rowCount) throw notFound('Vehicle not found');
      const clash = (await c.query(
        `SELECT ref, status, start_at FROM bookings WHERE vehicle_id=$1 AND blocked_during && $2::tstzrange
           AND status IN ('pending','awaiting_payment','confirmed','driver_assigned','in_progress','cancellation_requested')`, [vid, rangeParam(s, e)])).rows;
      if (clash.length) throw conflict(`This overlaps ${clash.length} booking(s): ${clash.map((x) => x.ref).join(', ')}. Move or cancel them first.`, 'overlaps_bookings', clash);
      const r = (await c.query('INSERT INTO availability_blocks(vehicle_id, during, kind, reason, created_by) VALUES ($1,$2::tstzrange,$3,$4,$5) RETURNING id', [vid, rangeParam(s, e), b.kind, b.reason ?? null, req.user.sub])).rows[0];
      await audit(c, req.user.sub, 'availability_block', r.id, 'create', null, { vehicleId: vid, ...b });
      return r;
    });
    return reply.status(201).send(row);
  });

  app.delete('/blocks/:id', async (req) => {
    const { id: bid } = idParams.parse(req.params);
    const r = await pool.query('DELETE FROM availability_blocks WHERE id=$1 RETURNING id', [bid]);
    if (!r.rowCount) throw notFound('Block not found');
    await audit(pool, req.user.sub, 'availability_block', bid, 'delete');
    return { ok: true };
  });
}
