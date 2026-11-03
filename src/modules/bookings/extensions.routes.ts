import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { pool, tx } from '../../core/db.js';
import { loadFinance } from '../finance/finance.js';
import { applyExtension, decideExtension, quoteExtension } from './extensions.js';
import { actorOf } from './history.js';


const uuid = z.string().uuid();

export function extensionRoutes(app: FastifyInstance) {
  app.post('/bookings/:id/extension-quote', async (req) => {
    const { id } = z.object({ id: uuid }).parse(req.params);
    const { hours } = z.object({ hours: z.number().int().min(1).max(12) }).parse(req.body);
    return tx((c) => quoteExtension(c, id, hours, { staff: true }));
  });

  /** Staff extend directly. Availability is always enforced; opening hours and the car's maximum hours are not. */
  app.post('/bookings/:id/extend', async (req) => {
    const { id } = z.object({ id: uuid }).parse(req.params);
    const b = z.object({ hours: z.number().int().min(1).max(12), reason: z.string().max(500).nullish(), expectedEndAt: z.string().datetime({ offset: true }).optional() }).parse(req.body);
    const r = await tx((c) => applyExtension(c, id, b.hours, actorOf(req), { staff: true, reason: b.reason ?? null, expectedEndAt: b.expectedEndAt }));
    return { extension: r.extension, finance: await loadFinance(pool, id) };
  });

  app.get('/extension-requests', async (req) => {
    const { status } = z.object({ status: z.enum(['requested', 'confirmed', 'rejected']).default('requested') }).parse(req.query);
    return { items: (await pool.query(
      `SELECT x.id, x.status, x.booking_id AS "bookingId", b.ref, c.name AS customer, v.make || ' ' || v.model AS vehicle, x.previous_end_at AS "previousEndAt",
              x.requested_end_at AS "requestedEndAt", x.additional_hours AS "additionalHours", x.conflict_reason AS "conflictReason", x.customer_message AS "customerMessage",
              x.created_at AS "createdAt", x.decided_at AS "decidedAt", s.name AS "decidedBy", x.decision_reason AS "decisionReason"
         FROM booking_extensions x JOIN bookings b ON b.id=x.booking_id JOIN customers c ON c.id=b.customer_id JOIN vehicles v ON v.id=b.vehicle_id
         LEFT JOIN staff_users s ON s.id=x.decided_by WHERE x.status=$1 ORDER BY x.created_at DESC LIMIT 200`, [status])).rows };
  });

  /** Approve re-checks availability under the vehicle lock; if the time is taken it fails and nothing changes. */
  app.post('/extensions/:id/approve', async (req) => {
    const { id } = z.object({ id: uuid }).parse(req.params);
    const b = z.object({ reason: z.string().max(500).nullish(), hours: z.number().int().min(1).max(12).optional() }).parse(req.body ?? {});
    return tx((c) => decideExtension(c, id, true, req.user.sub, b.reason ?? null, { hours: b.hours }));
  });

  app.post('/extensions/:id/reject', async (req) => {
    const { id } = z.object({ id: uuid }).parse(req.params);
    const { reason } = z.object({ reason: z.string().trim().min(1).max(500) }).parse(req.body);
    return tx((c) => decideExtension(c, id, false, req.user.sub, reason));
  });

  /** Create a booking for a customer (phone/walk-in). Staff skip lead time; availability is still enforced. */
}
