import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { pool } from '../../core/db.js';
import { createOrderPaymentIntent, createPaymentIntent } from './payments.js';

export function myPaymentRoutes(app: FastifyInstance) {
  /** Starts (or resumes) a Stripe PaymentIntent for what is due on the booking's order. */
  app.post('/bookings/:id/pay', async (req) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    const { which } = z.object({ which: z.enum(['due_now', 'balance']).default('due_now') }).parse(req.body ?? {});
    return createPaymentIntent(id, req.user.sub, which);
  });

  app.post('/orders/:id/pay', async (req) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    const { which } = z.object({ which: z.enum(['due_now', 'balance']).default('due_now') }).parse(req.body ?? {});
    return createOrderPaymentIntent(id, req.user.sub, which);
  });

  app.get('/payments', async (req) => ({
    items: (await pool.query(
      `SELECT p.id, o.ref AS "bookingRef", p.amount_pence AS "amountPence", p.status, p.method, p.source, p.purpose, COALESCE(p.paid_at, p.created_at) AS "paidAt", p.created_at AS "createdAt"
         FROM payments p JOIN orders o ON o.id=p.order_id WHERE p.customer_id=$1 AND p.status IN ('succeeded','failed') ORDER BY p.created_at DESC`, [req.user.sub])).rows,
  }));
}
