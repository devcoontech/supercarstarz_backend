import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { pool, tx } from '../../core/db.js';
import { loadFinance } from './finance.js';
import { addAdjustment, chargesForStaff, setDeliveryCharge, voidCharge } from './charges.js';
import { requireFinance } from './permissions.js';


const uuid = z.string().uuid();

export function chargeRoutes(app: FastifyInstance) {
  /** Confirms or amends the delivery charge: distance x rate, and the final amount staff approve. */
  app.post('/bookings/:id/delivery-charge', async (req) => {
    requireFinance(req);
    const { id } = z.object({ id: uuid }).parse(req.params);
    const b = z.object({
      distanceMiles: z.number().min(0).max(5000).nullable().transform((n) => (n == null ? null : Math.round(n * 100) / 100)), ratePerMilePence: z.number().int().min(0).max(100000),
      finalPence: z.number().int().min(0).max(10_000_000), address: z.string().max(300).nullish(), reason: z.string().max(500).nullish(),
    }).parse(req.body);
    await tx((c) => setDeliveryCharge(c, id, b, req.user.sub));
    return { finance: await loadFinance(pool, id), charges: await chargesForStaff(pool, id) };
  });

  app.post('/bookings/:id/charges/:chargeId/void', async (req) => {
    requireFinance(req);
    const p = z.object({ id: uuid, chargeId: uuid }).parse(req.params);
    const { reason } = z.object({ reason: z.string().trim().min(1).max(500) }).parse(req.body);
    await tx((c) => voidCharge(c, p.id, p.chargeId, reason, req.user.sub));
    return { finance: await loadFinance(pool, p.id) };
  });

  /** A one-off extra charge (positive) or credit (negative) on the booking, with a reason. */
  app.post('/bookings/:id/adjustments', async (req, reply) => {
    requireFinance(req);
    const { id } = z.object({ id: uuid }).parse(req.params);
    const b = z.object({ amountPence: z.number().int().min(-10_000_000).max(10_000_000).refine((n) => n !== 0, 'Must not be zero'), description: z.string().trim().min(1).max(200) }).parse(req.body);
    await tx((c) => addAdjustment(c, id, b, req.user.sub));
    return reply.status(201).send({ finance: await loadFinance(pool, id) });
  });
}
