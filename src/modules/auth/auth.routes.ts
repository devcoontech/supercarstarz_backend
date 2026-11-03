import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import crypto from 'node:crypto';
import { pool, tx } from '../../core/db.js';
import { config } from '../../core/config.js';
import { getMailer } from '../../lib/mailer.js';
import { getSettings } from '../../core/settings.js';
import { resetCodeEmail, welcomeEmail } from '../notifications/account-emails.js';
import { hashPassword, verifyPassword } from '../../core/security.js';
import { unauthorized, conflict, HttpError } from '../../core/errors.js';

const limit = { rateLimit: { max: process.env.NODE_ENV === 'test' ? 10000 : 10, timeWindow: '1 minute' } };

// Used to spend the same time verifying when the account does not exist (no user enumeration by timing).
const DUMMY_HASH = 'scrypt$00000000000000000000000000000000$' + '00'.repeat(64);

const password = z.string().min(8).max(200);

/**
 * Wrong reset-code guesses allowed per customer in 24 hours, across every code issued. Each code also allows five,
 * but a new code can be requested every minute, so without this a 6-digit code could be guessed slowly forever.
 */
const RESET_FAILS_PER_DAY = 10;
const resetFailsSql = `SELECT coalesce(sum(attempts),0)::int AS n FROM password_resets WHERE customer_id=$1 AND created_at > now() - interval '24 hours'`;

/** Keyed hash so a database leak alone does not reveal valid codes. */
const hashCode = (customerId: string, code: string) => crypto.createHmac('sha256', config.jwtSecret).update(`${customerId}:${code}`).digest('hex');

export async function authRoutes(app: FastifyInstance) {
  app.post('/auth/customer/register', { config: limit }, async (req, reply) => {
    const b = z.object({
      email: z.string().email().max(200), password, name: z.string().trim().min(1).max(120),
      phone: z.string().max(40).optional(), postcode: z.string().max(12).optional(), city: z.string().max(80).optional(),
    }).parse(req.body);
    const email = b.email.toLowerCase();
    const exists = await pool.query('SELECT 1 FROM customers WHERE email=$1', [email]);
    if (exists.rowCount) throw conflict('An account with that email already exists', 'email_taken');
    const r = await pool.query(
      `INSERT INTO customers(email, name, phone, postcode, city, password_hash) VALUES ($1,$2,$3,$4,$5,$6) RETURNING id, email, name`,
      [email, b.name, b.phone ?? null, b.postcode ?? null, b.city ?? null, await hashPassword(b.password)],
    );
    const token = app.jwt.sign({ sub: r.rows[0].id, kind: 'customer' });
    // Welcome email: best effort, never delays or fails the sign-up. (Not in tests, which count the emails they trigger.)
    if (config.env !== 'test') getSettings().then((s) => getMailer().send(welcomeEmail(r.rows[0].email, r.rows[0].name, s)))
      .then((m) => { if (!m.sent && m.reason !== 'no_mail_provider_configured') req.log.warn({ reason: m.reason }, 'welcome email was not sent'); })
      .catch((e) => req.log.warn({ err: e }, 'welcome email failed'));
    return reply.status(201).send({ token, customer: r.rows[0] });
  });

  app.post('/auth/customer/login', { config: limit }, async (req) => {
    const b = z.object({ email: z.string().email(), password: z.string().min(1) }).parse(req.body);
    const c = (await pool.query('SELECT id, email, name, password_hash FROM customers WHERE email=$1', [b.email.toLowerCase()])).rows[0];
    const ok = await verifyPassword(b.password, c?.password_hash ?? DUMMY_HASH);
    if (!c || !ok) throw unauthorized('Incorrect email or password');
    return { token: app.jwt.sign({ sub: c.id, kind: 'customer' }), customer: { id: c.id, email: c.email, name: c.name } };
  });

  /**
   * Starts a password reset. Always answers the same way, whether or not the email has an account,
   * so it can't be used to discover who is a customer. A 6-digit code is emailed; it works once, for 15 minutes.
   */
  app.post('/auth/customer/forgot', { config: limit }, async (req) => {
    const { email } = z.object({ email: z.string().email().max(200) }).parse(req.body);
    const generic = { ok: true, message: 'If that email has an account, we have sent a 6-digit code. It is valid for 15 minutes.' };
    const c = (await pool.query('SELECT id, name, email FROM customers WHERE email=$1', [email.toLowerCase()])).rows[0];
    if (!c) return generic;
    const recent = await pool.query(`SELECT 1 FROM password_resets WHERE customer_id=$1 AND created_at > now() - interval '60 seconds'`, [c.id]);
    if (recent.rowCount) return generic; // one code a minute per customer
    const fails = (await pool.query(resetFailsSql, [c.id])).rows[0].n;
    if (fails >= RESET_FAILS_PER_DAY) {
      req.log.warn({ customerId: c.id }, 'password reset locked after too many wrong codes');
      return generic; // same answer as always, so this cannot be used to discover accounts
    }
    const code = String(crypto.randomInt(0, 1_000_000)).padStart(6, '0');
    await tx(async (q) => {
      await q.query(`UPDATE password_resets SET used_at = now() WHERE customer_id=$1 AND used_at IS NULL`, [c.id]);
      await q.query(`INSERT INTO password_resets(customer_id, code_hash, expires_at) VALUES ($1,$2,now() + interval '15 minutes')`, [c.id, hashCode(c.id, code)]);
    });
    const r = await getMailer().send(resetCodeEmail(c.email, c.name, code, await getSettings()));
    if (!r.sent) req.log.warn({ reason: r.reason }, 'password reset email was not sent');
    return generic;
  });

  /** Completes a reset with the emailed code. Five wrong tries burn the code. Signs out every older session. */
  app.post('/auth/customer/reset', { config: limit }, async (req) => {
    const b = z.object({ email: z.string().email().max(200), code: z.string().regex(/^\d{6}$/), password }).parse(req.body);
    const bad = () => new HttpError(400, "That code isn't right or has expired. Request a new one.", 'invalid_code');
    const c = (await pool.query('SELECT id FROM customers WHERE email=$1', [b.email.toLowerCase()])).rows[0];
    if (!c) throw bad();
    const hash = await hashPassword(b.password);
    // Count the attempt first, atomically, so parallel guesses cannot exceed five per code, and stop once the
    // customer's daily total across all codes is used up.
    const r = (await pool.query(
      `UPDATE password_resets SET attempts = attempts + 1
        WHERE id = (SELECT id FROM password_resets WHERE customer_id=$1 AND used_at IS NULL AND expires_at > now() ORDER BY created_at DESC LIMIT 1)
          AND attempts < 5 AND (${resetFailsSql}) < $2 RETURNING id, code_hash`, [c.id, RESET_FAILS_PER_DAY])).rows[0];
    if (!r) throw bad();
    const expected = Buffer.from(hashCode(c.id, b.code));
    const given = Buffer.from(r.code_hash);
    if (expected.length !== given.length || !crypto.timingSafeEqual(given, expected)) throw bad();
    return tx(async (q) => {
      const used = await q.query('UPDATE password_resets SET used_at = now() WHERE id=$1 AND used_at IS NULL RETURNING id', [r.id]);
      if (!used.rowCount) throw bad(); // someone else just used it
      await q.query('UPDATE customers SET password_hash=$2, password_changed_at=now(), updated_at=now() WHERE id=$1', [c.id, hash]);
      return { ok: true };
    });
  });

  app.post('/auth/staff/login', { config: limit }, async (req) => {
    const b = z.object({ email: z.string().email(), password: z.string().min(1) }).parse(req.body);
    const s = (await pool.query('SELECT id, email, name, role, active, password_hash FROM staff_users WHERE email=$1', [b.email.toLowerCase()])).rows[0];
    const ok = await verifyPassword(b.password, s?.password_hash ?? DUMMY_HASH);
    if (!s || !ok || !s.active) throw unauthorized('Incorrect email or password');
    return { token: app.jwt.sign({ sub: s.id, kind: 'staff', role: s.role }), staff: { id: s.id, email: s.email, name: s.name, role: s.role } };
  });
}
