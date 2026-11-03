import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { pool, tx } from '../../core/db.js';
import { loadFinance } from '../finance/finance.js';
import { applyExtension, quoteExtension, requestExtension } from './extensions.js';

export function myExtensionRoutes(app: FastifyInstance) {
  const hoursBody = z.object({ hours: z.number().int().min(1).max(12) });

  /** Is the extra time free, and what would it cost? Checked on the server; nothing is saved. */
  app.post('/bookings/:id/extension-quote', async (req) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    const { hours } = hoursBody.parse(req.body);
    return tx((c) => quoteExtension(c, id, hours, { customerId: req.user.sub }));
  });

  /**
   * Confirms an extension. Availability is checked again here, under the car's lock. `expectedEndAt` is the end time
   * the customer saw: if the booking has changed since (e.g. a double tap already extended it), nothing happens.
   */
  app.post('/bookings/:id/extend', async (req) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    const b = hoursBody.extend({ expectedEndAt: z.string().datetime({ offset: true }) }).parse(req.body);
    const r = await tx((c) => applyExtension(c, id, b.hours, { type: 'customer', id: req.user.sub }, { customerId: req.user.sub, expectedEndAt: b.expectedEndAt }));
    return { extension: r.extension, finance: await loadFinance(pool, id) };
  });

  /** "Contact us": asks staff for more time (or another car) when the extension isn't possible online. */
  app.post('/bookings/:id/extension-requests', async (req, reply) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    const b = hoursBody.extend({ message: z.string().max(1000).nullish() }).parse(req.body);
    const row = await tx((c) => requestExtension(c, id, b.hours, req.user.sub, b.message ?? null));
    return reply.status(201).send({ id: row.id, status: row.status, requestedEndAt: row.requested_end_at });
  });
}
