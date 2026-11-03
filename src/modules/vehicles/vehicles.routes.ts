import type { FastifyInstance } from 'fastify';
import crypto from 'node:crypto';
import { z } from 'zod';
import { putPublic, removePublic } from '../../lib/storage.js';
import { pool, tx } from '../../core/db.js';
import { badRequest, conflict, notFound } from '../../core/errors.js';
import { audit, buildInsert, buildUpdate, sniffImage } from '../../core/util.js';
import { lockVehicle, rangeParam } from '../bookings/slots.js';
import { mustGeocode } from '../../lib/maps.js';
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

export function vehicleRoutes(app: FastifyInstance) {
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
