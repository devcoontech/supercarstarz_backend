import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { pool } from '../../core/db.js';
import { audit } from '../../core/util.js';
import { reconcilePayment } from './payments.js';
import { toCsv } from '../reports/reports.routes.js';

const uuid = z.string().uuid();

export function paymentsRoutes(app: FastifyInstance) {
  app.get('/payments', async (req) => {
    const q = z.object({
      q: z.string().max(80).optional(), status: z.enum(['pending', 'succeeded', 'failed', 'canceled']).optional(), source: z.enum(['stripe', 'manual']).optional(),
      from: z.string().optional(), to: z.string().optional(), format: z.enum(['json', 'csv']).default('json'),
      limit: z.coerce.number().int().min(1).max(500).default(50), offset: z.coerce.number().int().min(0).default(0),
    }).parse(req.query);
    const w: string[] = [];
    const p: unknown[] = [];
    const add = (sql: string, v: unknown) => { p.push(v); w.push(sql.replaceAll('?', '$' + p.length)); };
    if (q.q) add('(b.ref ILIKE ? OR p.provider_ref ILIKE ? OR p.manual_reference ILIKE ? OR c.name ILIKE ?)', `%${q.q}%`);
    if (q.status) add('p.status=?', q.status);
    if (q.source) add('p.source=?', q.source);
    if (q.from) add('COALESCE(p.paid_at, p.created_at) >= ?', q.from);
    if (q.to) add('COALESCE(p.paid_at, p.created_at) < ?', q.to);
    const where = w.length ? 'WHERE ' + w.join(' AND ') : '';
    const base = `FROM payments p JOIN bookings b ON b.id=p.booking_id JOIN customers c ON c.id=p.customer_id LEFT JOIN staff_users s ON s.id=p.recorded_by LEFT JOIN invoices i ON i.payment_id=p.id ${where}`;
    const cols = `p.id, b.ref AS "bookingRef", b.id AS "bookingId", c.name AS customer, p.amount_pence AS "amountPence", p.currency, p.method, p.source, p.purpose, p.status,
                  p.provider_ref AS "providerRef", p.manual_reference AS "manualReference", s.name AS "recordedBy", p.reconciled_at AS "reconciledAt", p.created_at AS "createdAt",
                  p.paid_at AS "paidAt", (p.source='stripe' AND p.status='succeeded') AS verified, i.id AS "receiptId", i.number AS "receiptNumber",
                  COALESCE((SELECT sum(r.amount_pence) FROM refunds r WHERE r.payment_id=p.id AND r.status IN ('pending','succeeded')),0)::int AS "refundedPence"`;
    if (q.format === 'csv') {
      const rows = (await pool.query(`SELECT ${cols} ${base} ORDER BY p.created_at DESC LIMIT 10000`, p)).rows;
      await audit(pool, req.user.sub, 'payments', null, 'export_csv', null, { rows: rows.length });
      return { csv: toCsv(rows) };
    }
    const total = (await pool.query(`SELECT count(*)::int n ${base}`, p)).rows[0].n;
    p.push(q.limit, q.offset);
    const items = (await pool.query(`SELECT ${cols} ${base} ORDER BY p.created_at DESC LIMIT $${p.length - 1} OFFSET $${p.length}`, p)).rows;
    return { items, total };
  });

  /** Asks Stripe (server-side) for the intent's real state and compares it with our ledger. */
  app.post('/payments/:id/reconcile', async (req) => {
    const { id } = z.object({ id: uuid }).parse(req.params);
    return reconcilePayment(id, req.user.sub);
  });
}
