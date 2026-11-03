import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { tx } from '../../core/db.js';
import { recordManualPayment, refundPayment, setManualPaymentStatus } from './payments.js';
import { requireFinance } from '../finance/permissions.js';


const uuid = z.string().uuid();

export function bookingPaymentRoutes(app: FastifyInstance) {
  /** Money received outside the app. Send an Idempotency-Key header so a double click records it once. */
  app.post('/bookings/:id/payments/manual', async (req, reply) => {
    requireFinance(req);
    const { id } = z.object({ id: uuid }).parse(req.params);
    const b = z.object({
      amountPence: z.number().int().positive(), method: z.enum(['cash', 'card_terminal', 'bank_transfer', 'other']), reference: z.string().max(200).optional(),
      purpose: z.enum(['payment', 'deposit', 'balance']).optional(), paidAt: z.string().datetime({ offset: true }).nullish(),
      status: z.enum(['succeeded', 'pending']).default('succeeded'), note: z.string().max(1000).nullish(),
    }).parse(req.body);
    const key = z.string().max(100).optional().parse(req.headers['idempotency-key']);
    const row = await tx((c) => recordManualPayment(c, { bookingId: id, ...b, staffId: req.user.sub, idempotencyKey: key }));
    return reply.status(201).send(row);
  });

  /** A pending manual payment is marked received, failed or cancelled. Card payments made in the app cannot be changed here. */
  app.post('/payments/:id/status', async (req) => {
    requireFinance(req);
    const { id } = z.object({ id: uuid }).parse(req.params);
    const b = z.object({ status: z.enum(['succeeded', 'failed', 'canceled']), paidAt: z.string().datetime({ offset: true }).nullish() }).parse(req.body);
    return tx((c) => setManualPaymentStatus(c, id, b.status, req.user.sub, b.paidAt));
  });

  app.post('/payments/:id/refund', async (req, reply) => {
    requireFinance(req);
    const { id } = z.object({ id: uuid }).parse(req.params);
    const b = z.object({ amountPence: z.number().int().positive(), reason: z.string().min(1).max(500) }).parse(req.body);
    return reply.status(201).send(await refundPayment(id, b.amountPence, b.reason, req.user.sub));
  });
}
