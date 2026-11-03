import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { pool } from '../../core/db.js';
import { notFound } from '../../core/errors.js';
import { renderDocument, renderStatement } from './documents.js';


const uuid = z.string().uuid();

export function documentRoutes(app: FastifyInstance) {
  app.get('/invoices/:id/document', async (req, reply) => {
    const { id } = z.object({ id: uuid }).parse(req.params);
    const doc = (await pool.query('SELECT * FROM invoices WHERE id=$1', [id])).rows[0];
    if (!doc) throw notFound('Document not found');
    return reply.type('text/html; charset=utf-8').header('cache-control', 'no-store').send(renderDocument(doc));
  });

  app.get('/bookings/:id/statement', async (req, reply) => {
    const { id } = z.object({ id: uuid }).parse(req.params);
    return reply.type('text/html; charset=utf-8').header('cache-control', 'no-store').send(await renderStatement(pool, id));
  });
}
