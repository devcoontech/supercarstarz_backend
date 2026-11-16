import type { FastifyInstance } from 'fastify';
import crypto from 'node:crypto';
import { z } from 'zod';
import { pool, tx } from '../../core/db.js';
import { badRequest, conflict, forbidden, notFound } from '../../core/errors.js';
import { audit, sniffImage } from '../../core/util.js';
import { getPrivate, putPrivate, removePrivate } from '../../lib/storage.js';
import { logEvent } from '../bookings/history.js';
import { notify } from '../notifications/notify.js';
import { applicationSql } from './self-drive.js';

const uuid = z.string().uuid();
/** The same roles that may see staff drivers' licences. */
export const LICENCE_ROLES = ['owner', 'administrator', 'driver_coordinator'];

/* ---------- Customer app (/api/me) ---------- */

export function mySelfDriveRoutes(app: FastifyInstance) {
  /**
   * A photo of the customer's driving licence (front or back), sent before the booking that uses it. JPEG, PNG or
   * WebP up to 8 MB, checked from the bytes. Kept private: the customer gets back an id to put in the booking.
   */
  app.post('/licence-uploads/:side', { config: { rateLimit: { max: process.env.NODE_ENV === 'test' ? 10000 : 20, timeWindow: '10 minutes' } } }, async (req, reply) => {
    const { side } = z.object({ side: z.enum(['front', 'back']) }).parse(req.params);
    const part = await req.file();
    if (!part) throw badRequest('No photo received', 'no_file');
    const buf = await part.toBuffer();
    if (part.file.truncated) throw badRequest('The photo is larger than 8 MB. Take it again at a lower size.', 'file_too_large');
    const type = sniffImage(buf);
    if (!type) throw badRequest('Only JPEG, PNG or WebP photos are accepted', 'invalid_image');
    const key = `customer-licences/${req.user.sub}/${crypto.randomUUID()}.${type.ext}`;
    await putPrivate(key, buf, type.mime);
    try {
      const row = (await pool.query(
        `INSERT INTO customer_licence_uploads(customer_id, side, storage_key, mime, size_bytes) VALUES ($1,$2,$3,$4,$5)
         RETURNING id, side, created_at AS "createdAt"`, [req.user.sub, side, key, type.mime, buf.length])).rows[0];
      return reply.status(201).send(row);
    } catch (e) {
      await removePrivate(key);
      throw e;
    }
  });

  /**
   * The details from the customer's last self-drive booking, so the form can be filled in for them next time, and the
   * licence photos already on file (which can be used again instead of uploading new ones).
   */
  app.get('/self-drive', async (req) => {
    const last = (await pool.query(`${applicationSql} WHERE s.customer_id=$1 ORDER BY s.created_at DESC LIMIT 1`, [req.user.sub])).rows[0];
    const latest = async (side: string) => (await pool.query(
      `SELECT id, created_at AS "createdAt" FROM customer_licence_uploads WHERE customer_id=$1 AND side=$2 ORDER BY created_at DESC LIMIT 1`, [req.user.sub, side])).rows[0] ?? null;
    if (!last) return { details: null, licenceFront: null, licenceBack: null };
    const { id, orderId, status, reviewNote, reviewedAt, reviewedBy, createdAt, licenceFront, licenceBack, ...details } = last;
    // Photos from an application staff turned down are not offered again.
    return {
      details,
      licenceFront: status === 'rejected' ? null : licenceFront ?? (await latest('front')),
      licenceBack: status === 'rejected' ? null : licenceBack ?? (await latest('back')),
    };
  });
}

/* ---------- Admin dashboard (/api/admin) ---------- */

export function selfDriveAdminRoutes(app: FastifyInstance) {
  const requireLicenceAccess = (req: any) => {
    if (!LICENCE_ROLES.includes(req.user.role)) throw forbidden('Only the owner, administrators and driver coordinators can see licence details');
  };

  /** Self-drive applications, newest first; `status=pending` lists the ones waiting for a review. */
  app.get('/self-drive', async (req) => {
    requireLicenceAccess(req);
    const q = z.object({ status: z.enum(['pending', 'approved', 'rejected']).optional(), limit: z.coerce.number().int().min(1).max(200).default(50) }).parse(req.query);
    const rows = (await pool.query(
      `SELECT a.*, o.ref AS "orderRef", (SELECT b.id FROM bookings b WHERE b.order_id=a."orderId" ORDER BY b.created_at, b.ref LIMIT 1) AS "bookingId",
              (SELECT min(b.start_at) FROM bookings b WHERE b.order_id=a."orderId") AS "startAt"
         FROM (${applicationSql} WHERE ($1::text IS NULL OR s.status=$1)) a JOIN orders o ON o.id=a."orderId"
        ORDER BY a."createdAt" DESC LIMIT $2`, [q.status ?? null, q.limit])).rows;
    return { items: rows };
  });

  /** A licence photo from an application. Never cached; every view is in the audit log. */
  app.get('/self-drive/:id/licence/:side', async (req, reply) => {
    requireLicenceAccess(req);
    const p = z.object({ id: uuid, side: z.enum(['front', 'back']) }).parse(req.params);
    const img = (await pool.query(
      `SELECT u.storage_key, u.mime FROM self_drive_applications s JOIN customer_licence_uploads u ON u.id = CASE WHEN $2='front' THEN s.licence_front_id ELSE s.licence_back_id END
        WHERE s.id=$1`, [p.id, p.side])).rows[0];
    if (!img) throw notFound('No photo of that side of the licence');
    const file = await getPrivate(img.storage_key);
    if (!file) throw notFound('The photo file is missing');
    await audit(pool, req.user.sub, 'self_drive_application', p.id, 'view_licence_image', null, { side: p.side });
    return reply.type(img.mime).header('cache-control', 'no-store, private').header('x-content-type-options', 'nosniff').send(file);
  });

  /**
   * Approve or turn down the driver for a self-drive booking (or put it back to pending). The customer is told, and
   * the decision is written to the history of every car in the order. Turning the driver down does not cancel the
   * booking: staff choose what happens next (a driver instead, or cancel and refund) with the usual booking tools.
   */
  app.post('/self-drive/:id/review', async (req) => {
    requireLicenceAccess(req);
    const { id } = z.object({ id: uuid }).parse(req.params);
    const b = z.object({ status: z.enum(['pending', 'approved', 'rejected']), note: z.string().trim().max(1000).nullish() }).parse(req.body);
    if (b.status === 'rejected' && !b.note) throw badRequest('Tell the customer why the driver could not be accepted', 'note_required');
    return tx(async (c) => {
      const before = (await c.query('SELECT * FROM self_drive_applications WHERE id=$1 FOR UPDATE', [id])).rows[0];
      if (!before) throw notFound('Self-drive details not found');
      if (before.status === b.status && (before.review_note ?? null) === (b.note || null)) throw conflict('Nothing has changed', 'no_change');
      await c.query(
        `UPDATE self_drive_applications SET status=$2, review_note=$3, reviewed_by=$4, reviewed_at=CASE WHEN $2='pending' THEN NULL ELSE now() END, updated_at=now() WHERE id=$1`,
        [id, b.status, b.note || null, b.status === 'pending' ? null : req.user.sub]);
      const bookings = (await c.query('SELECT id, ref FROM bookings WHERE order_id=$1 ORDER BY created_at, ref', [before.order_id])).rows;
      for (const bk of bookings) {
        await logEvent(c, bk.id, { type: 'staff', id: req.user.sub }, 'self_drive_review', { from: before.status, to: b.status, reason: b.note || null });
      }
      await audit(c, req.user.sub, 'self_drive_application', id, 'review', { status: before.status }, { status: b.status });
      if (b.status !== 'pending' && bookings[0]) {
        const ref = bookings[0].ref;
        await notify(c, {
          customerId: before.customer_id, bookingId: bookings[0].id, kind: `self_drive_${b.status}`, dedupeKey: `self_drive:${id}:${b.status}:${Date.now()}`,
          title: b.status === 'approved' ? 'Driver approved for self-drive' : 'Self-drive details need attention',
          body: b.status === 'approved'
            ? `${before.full_name} is approved to drive on booking ${ref}. Bring the driving licence with you on the day.`
            : `We couldn't accept the self-drive details on booking ${ref}: ${b.note}`,
        });
      }
      return (await c.query(`${applicationSql} WHERE s.id=$1`, [id])).rows[0];
    });
  });
}

/** The application for an order, as staff see it on a booking: everything for licence roles, only the status for others. */
export async function selfDriveForStaff(orderId: string, role: string) {
  const row = (await pool.query(`${applicationSql} WHERE s.order_id=$1`, [orderId])).rows[0];
  if (!row) return null;
  if (LICENCE_ROLES.includes(role)) return { ...row, restricted: false };
  return { id: row.id, status: row.status, reviewNote: row.reviewNote, reviewedAt: row.reviewedAt, reviewedBy: row.reviewedBy, fullName: row.fullName, restricted: true };
}

/** Removes a deleted customer's licence photos and self-drive details. Run after the account is deleted. */
export async function removeCustomerLicenceFiles(keys: string[]) {
  for (const k of keys) await removePrivate(k).catch(() => {});
}
