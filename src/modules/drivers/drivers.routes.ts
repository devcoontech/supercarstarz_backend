import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { getPrivate, putPrivate, removePrivate } from '../../lib/storage.js';
import crypto from 'node:crypto';
import { pool, tx } from '../../core/db.js';
import { badRequest, conflict, forbidden, notFound } from '../../core/errors.js';
import { audit, buildInsert, buildUpdate, sniffImage } from '../../core/util.js';

const uuid = z.string().uuid();

const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

const SENSITIVE_DRIVER_ROLES = ['owner', 'administrator', 'driver_coordinator'];

export function driversRoutes(app: FastifyInstance) {
  const driverBody = z.object({
    internalRef: z.string().max(40).nullish(), fullName: z.string().trim().min(1).max(120), phone: z.string().trim().min(5).max(40), email: z.string().email().nullish(),
    licenseNumber: z.string().max(60).nullish(), licenseType: z.string().trim().max(40).nullish(), licenseExpiry: date.nullish(), address: z.string().trim().max(300).nullish(), employment: z.enum(['employee', 'contractor']),
    workingHours: z.object({ start: z.string().regex(/^\d{2}:\d{2}$/), end: z.string().regex(/^\d{2}:\d{2}$/) }).nullish(), notes: z.string().max(2000).nullish(), active: z.boolean(),
  });
  const driverFields = { internalRef: 'internal_ref', fullName: 'full_name', phone: 'phone', email: 'email', licenseNumber: 'license_number', licenseType: 'license_type', licenseExpiry: 'license_expiry', address: 'address', employment: 'employment', workingHours: 'working_hours', notes: 'notes', active: 'active' };
  const driverOut = (d: any, role: string) => {
    const { license_number, license_type, ...rest } = d;
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
    if (('licenseNumber' in data || 'licenseType' in data || 'licenseExpiry' in data) && !SENSITIVE_DRIVER_ROLES.includes(req.user.role!)) throw badRequest('Not allowed to change licence details');
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
    await putPrivate(key, buf, type.mime);
    let old: { storage_key: string } | undefined;
    try {
      await tx(async (c) => {
        old = (await c.query('DELETE FROM driver_licence_images WHERE driver_id=$1 AND side=$2 RETURNING storage_key', [id, side])).rows[0];
        await c.query('INSERT INTO driver_licence_images(driver_id, side, storage_key, mime, size_bytes, uploaded_by) VALUES ($1,$2,$3,$4,$5,$6)',
          [id, side, key, type.mime, buf.length, req.user.sub]);
        await audit(c, req.user.sub, 'driver', id, old ? 'replace_licence_image' : 'add_licence_image', null, { side });
      });
    } catch (e) {
      await removePrivate(key);
      throw e;
    }
    if (old) await removePrivate(old.storage_key);
    return reply.status(201).send({ items: await licenceImages(id) });
  });

  app.get('/drivers/:id/licence-images/:imageId', async (req, reply) => {
    requireLicenceAccess(req);
    const p = z.object({ id: uuid, imageId: uuid }).parse(req.params);
    const img = (await pool.query('SELECT * FROM driver_licence_images WHERE id=$1 AND driver_id=$2', [p.imageId, p.id])).rows[0];
    if (!img) throw notFound('Image not found');
    const file = await getPrivate(img.storage_key);
    if (!file) throw notFound('The image file is missing');
    await audit(pool, req.user.sub, 'driver', p.id, 'view_licence_image', null, { side: img.side });
    return reply.type(img.mime).header('cache-control', 'no-store, private').header('x-content-type-options', 'nosniff').send(file);
  });

  app.delete('/drivers/:id/licence-images/:imageId', async (req) => {
    requireLicenceAccess(req);
    const p = z.object({ id: uuid, imageId: uuid }).parse(req.params);
    const img = (await pool.query('DELETE FROM driver_licence_images WHERE id=$1 AND driver_id=$2 RETURNING side, storage_key', [p.imageId, p.id])).rows[0];
    if (!img) throw notFound('Image not found');
    await removePrivate(img.storage_key);
    await audit(pool, req.user.sub, 'driver', p.id, 'remove_licence_image', null, { side: img.side });
    return { items: await licenceImages(p.id) };
  });

  app.get('/drivers/:id/assignments', async (req) => {
    const { id } = z.object({ id: uuid }).parse(req.params);
    return { items: (await pool.query(
      `SELECT a.id, a.active, a.created_at AS "assignedAt", a.ended_at AS "endedAt", a.ended_reason AS "endedReason", b.id AS "bookingId", b.ref, b.status, b.start_at AS "startAt", b.end_at AS "endAt", b.address
         FROM driver_assignments a JOIN bookings b ON b.id=a.booking_id WHERE a.driver_id=$1 ORDER BY b.start_at DESC LIMIT 200`, [id])).rows };
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
      await removePrivate(f.storage_key); // licence photos go with the driver
      await audit(pool, req.user.sub, 'driver', id, 'remove_licence_image', null, { side: f.side, via: 'driver_delete' });
    }
    await audit(pool, req.user.sub, 'driver', id, 'delete', { name: r.rows[0].full_name }, null);
    return { ok: true };
  });
}
