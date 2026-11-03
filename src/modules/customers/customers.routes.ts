import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import crypto from 'node:crypto';
import { hashPassword } from '../../core/security.js';
import { pool } from '../../core/db.js';
import { badRequest, conflict, notFound } from '../../core/errors.js';
import { audit, buildUpdate } from '../../core/util.js';

const uuid = z.string().uuid();

export function customerAdminRoutes(app: FastifyInstance) {
  /**
   * Search by name, email or phone. Phone numbers match on digits only, so "07700 900123", "07700900123" and
   * "+44 7700 900123" all find the same customer. Exact email or phone matches are listed first.
   */
  app.get('/customers', async (req) => {
    const q = z.object({ q: z.string().max(80).optional(), limit: z.coerce.number().int().min(1).max(200).default(50), offset: z.coerce.number().int().min(0).default(0) }).parse(req.query);
    const term = q.q?.trim() || null;
    let digits = term ? term.replace(/\D/g, '') : '';
    if (term?.startsWith('+44') || (digits.startsWith('44') && digits.length > 10)) digits = '0' + digits.slice(2); // +44 7700... -> 07700...
    const p: unknown[] = [term ? `%${term}%` : null, digits.length >= 4 ? `%${digits.replace(/^0/, '')}%` : null, term, q.limit, q.offset];
    const where = `$1::text IS NULL OR (c.name ILIKE $1 OR c.email ILIKE $1 OR c.phone ILIKE $1 OR ($2::text IS NOT NULL AND regexp_replace(COALESCE(c.phone,''), '\\D', '', 'g') LIKE $2))`;
    const rows = (await pool.query(
      `SELECT c.id, c.name, c.email, c.phone, c.city, c.postcode, c.created_at AS "createdAt",
              (SELECT count(*)::int FROM bookings b WHERE b.customer_id=c.id) AS bookings,
              (SELECT max(b.start_at) FROM bookings b WHERE b.customer_id=c.id) AS "lastBookingAt",
              (SELECT COALESCE(sum(p.amount_pence),0)::int FROM payments p WHERE p.customer_id=c.id AND p.status='succeeded') AS "paidPence"
         FROM customers c WHERE ${where}
        ORDER BY (lower(c.email) = lower(COALESCE($3::text, ''))) DESC, c.created_at DESC LIMIT $4 OFFSET $5`, p)).rows;
    const total = (await pool.query(`SELECT count(*)::int n FROM customers c WHERE ${where}`, p.slice(0, 2))).rows[0].n;
    return { items: rows, total };
  });

  /**
   * For phone/walk-in customers: name, email and phone only. No password is ever shown to staff; the account gets a
   * random one nobody knows, and the customer sets their own in the app with "Forgot your password?" on the same email.
   */
  app.post('/customers', async (req, reply) => {
    const b = z.object({ name: z.string().trim().min(1).max(120), email: z.string().email().max(200), phone: z.string().max(40).optional() }).parse(req.body);
    const email = b.email.toLowerCase();
    // Never create a second record for someone already on file: hand back the existing customer so staff can select them.
    const existing = (await pool.query('SELECT id, name, email, phone FROM customers WHERE lower(email)=$1', [email])).rows[0];
    if (existing) throw conflict(`${existing.name} is already a customer with that email. Select them instead.`, 'email_taken', { customer: existing });
    const unknownPassword = crypto.randomBytes(32).toString('base64url'); // never returned or stored in clear
    const r = (await pool.query(
      `INSERT INTO customers(email, name, phone, password_hash) VALUES ($1,$2,$3,$4) RETURNING id, name, email, phone`,
      [email, b.name, b.phone ?? null, await hashPassword(unknownPassword)])).rows[0];
    await audit(pool, req.user.sub, 'customer', r.id, 'create');
    return reply.status(201).send({ customer: r });
  });

  app.get('/customers/:id', async (req) => {
    const { id } = z.object({ id: uuid }).parse(req.params);
    const c = (await pool.query('SELECT id, name, email, phone, postcode, city, internal_notes AS "internalNotes", created_at AS "createdAt" FROM customers WHERE id=$1', [id])).rows[0];
    if (!c) throw notFound('Customer not found');
    const bookings = (await pool.query(
      `SELECT b.id, b.ref, b.status, b.start_at AS "startAt", b.total_pence AS "totalPence", b.paid_pence AS "paidPence", b.cancel_reason AS "cancelReason", v.make || ' ' || v.model AS vehicle
         FROM bookings b JOIN vehicles v ON v.id=b.vehicle_id WHERE b.customer_id=$1 ORDER BY b.start_at DESC`, [id])).rows;
    return { ...c, bookings, cancellations: bookings.filter((b) => ['cancelled', 'cancellation_requested'].includes(b.status)).length };
  });

  app.patch('/customers/:id', async (req) => {
    const { id } = z.object({ id: uuid }).parse(req.params);
    const data = z.object({ name: z.string().trim().min(1).max(120), phone: z.string().max(40).nullable(), postcode: z.string().max(12).nullable(), city: z.string().max(80).nullable(), internalNotes: z.string().max(4000).nullable() }).partial().strict().parse(req.body);
    const u = buildUpdate('customers', id, { name: 'name', phone: 'phone', postcode: 'postcode', city: 'city', internalNotes: 'internal_notes' }, data);
    if (u.empty) throw badRequest('Nothing to update');
    const r = await pool.query(u.sql, u.vals);
    if (!r.rowCount) throw notFound('Customer not found');
    await audit(pool, req.user.sub, 'customer', id, 'update', null, { fields: Object.keys(data) });
    return { ok: true };
  });
}
