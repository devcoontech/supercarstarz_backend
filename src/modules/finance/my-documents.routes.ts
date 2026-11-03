import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { pool } from '../../core/db.js';
import { notFound } from '../../core/errors.js';
import { invoicesFor, renderDocument, renderStatement } from './documents.js';

export function myDocumentRoutes(app: FastifyInstance) {
  // A customer only ever sees their own receipts; anything else is "not found".
  app.get('/invoices', async (req) => ({ items: await invoicesFor(pool, 'customer', req.user.sub) }));

  app.get('/invoices/:id/document', async (req, reply) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    const doc = (await pool.query('SELECT * FROM invoices WHERE id=$1 AND customer_id=$2', [id, req.user.sub])).rows[0];
    if (!doc) throw notFound('Document not found');
    return reply.type('text/html; charset=utf-8').header('cache-control', 'no-store').send(renderDocument(doc));
  });

  app.get('/bookings/:id/statement', async (req, reply) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    if (!(await pool.query('SELECT 1 FROM bookings WHERE id=$1 AND customer_id=$2', [id, req.user.sub])).rowCount) throw notFound('Booking not found');
    return reply.type('text/html; charset=utf-8').header('cache-control', 'no-store').send(await renderStatement(pool, id));
  });
}
