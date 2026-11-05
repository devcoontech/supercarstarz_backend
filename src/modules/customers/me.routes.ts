import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { pool } from '../../core/db.js';
import { notFound } from '../../core/errors.js';
import { myBookingRoutes } from '../bookings/my-bookings.routes.js';
import { myPaymentRoutes } from '../payments/my-payments.routes.js';
import { myExtensionRoutes } from '../bookings/my-extensions.routes.js';
import { myDocumentRoutes } from '../finance/my-documents.routes.js';

const pushToken = z.string().max(200).regex(/^Expo(nent)?PushToken\[[^\]]+\]$/, 'Not a valid push token');

export async function customerRoutes(app: FastifyInstance) {
  app.addHook('onRequest', app.customerOnly);

  // Feature route groups share this instance, so the customer-only hook above applies to all of them.
  myBookingRoutes(app);
  myPaymentRoutes(app);
  myExtensionRoutes(app);
  myDocumentRoutes(app);

  app.get('/', async (req) => {
    const c = (await pool.query('SELECT id, email, name, phone, postcode, city FROM customers WHERE id=$1', [req.user.sub])).rows[0];
    if (!c) throw notFound('Account not found');
    return c;
  });

  app.patch('/', async (req) => {
    const b = z.object({
      name: z.string().trim().min(1).max(120).optional(), phone: z.string().max(40).nullish(),
      postcode: z.string().max(12).nullish(), city: z.string().max(80).nullish(),
    }).strict().parse(req.body);
    const r = await pool.query(
      `UPDATE customers SET name=COALESCE($2,name), phone=CASE WHEN $3::boolean THEN $4 ELSE phone END,
         postcode=CASE WHEN $5::boolean THEN $6 ELSE postcode END, city=CASE WHEN $7::boolean THEN $8 ELSE city END, updated_at=now()
       WHERE id=$1 RETURNING id, email, name, phone, postcode, city`,
      [req.user.sub, b.name ?? null, 'phone' in b, b.phone ?? null, 'postcode' in b, b.postcode ?? null, 'city' in b, b.city ?? null],
    );
    return r.rows[0];
  });

  app.get('/notifications', async (req) => ({
    items: (await pool.query(
      `SELECT id, kind, title, body, booking_id AS "bookingId", read_at AS "readAt", created_at AS "createdAt"
         FROM notifications WHERE customer_id=$1 AND NOT staff_only ORDER BY created_at DESC LIMIT 100`, [req.user.sub])).rows,
  }));

  app.post('/notifications/read', async (req) => {
    await pool.query('UPDATE notifications SET read_at=now() WHERE customer_id=$1 AND read_at IS NULL', [req.user.sub]);
    return { ok: true };
  });

  /** Called by the app after sign-in. A phone belongs to whoever last signed in on it. */
  app.post('/push-tokens', async (req) => {
    const b = z.object({ token: pushToken, platform: z.enum(['ios', 'android']) }).parse(req.body);
    await pool.query(
      `INSERT INTO push_tokens(token, customer_id, platform) VALUES ($1,$2,$3)
       ON CONFLICT (token) DO UPDATE SET customer_id=EXCLUDED.customer_id, platform=EXCLUDED.platform, updated_at=now()`,
      [b.token, req.user.sub, b.platform],
    );
    return { ok: true };
  });

  /** Called by the app on sign-out. */
  app.post('/push-tokens/remove', async (req) => {
    const b = z.object({ token: pushToken }).parse(req.body);
    await pool.query('DELETE FROM push_tokens WHERE token=$1 AND customer_id=$2', [b.token, req.user.sub]);
    return { ok: true };
  });
}
