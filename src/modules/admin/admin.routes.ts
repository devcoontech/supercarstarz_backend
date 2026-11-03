import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { pool, tx } from '../../core/db.js';
import { notFound } from '../../core/errors.js';
import { expireHolds } from '../bookings/status.js';
import { driversRoutes } from '../drivers/drivers.routes.js';
import { customerAdminRoutes } from '../customers/customers.routes.js';
import { offersRoutes } from '../offers/offers.routes.js';
import { paymentsRoutes } from '../payments/payments.routes.js';
import { reportsRoutes } from '../reports/reports.routes.js';
import { settingsRoutes } from '../settings/settings.routes.js';

export async function adminOpsRoutes(app: FastifyInstance) {
  app.addHook('onRequest', app.staffOnly);

  // Feature route groups share this instance, so the staff-only hook above applies to all of them.
  driversRoutes(app);
  customerAdminRoutes(app);
  offersRoutes(app);
  paymentsRoutes(app);
  reportsRoutes(app);
  settingsRoutes(app);

  app.get('/me', async (req) => {
    const s = (await pool.query('SELECT id, email, name, role FROM staff_users WHERE id=$1 AND active', [req.user.sub])).rows[0];
    if (!s) throw notFound('Account not found');
    return s;
  });

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
