import Fastify, { type FastifyReply, type FastifyRequest } from 'fastify';
import cors from '@fastify/cors';
import jwt from '@fastify/jwt';
import multipart from '@fastify/multipart';
import fastifyStatic from '@fastify/static';
import rateLimit from '@fastify/rate-limit';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { ZodError } from 'zod';
import { config } from './core/config.js';
import { pool } from './core/db.js';
import { HttpError, forbidden, unauthorized } from './core/errors.js';
import { authRoutes } from './modules/auth/auth.routes.js';
import { publicRoutes } from './modules/public/public.routes.js';
import { customerRoutes } from './modules/customers/me.routes.js';
import { adminCatalogRoutes } from './modules/catalog/catalog.routes.js';
import { adminBookingRoutes } from './modules/bookings/bookings.routes.js';
import { adminOpsRoutes } from './modules/admin/admin.routes.js';
import { webhookRoutes } from './modules/payments/webhooks.routes.js';
import { runBackgroundJobs } from './modules/jobs.js';

export type TokenUser = { sub: string; kind: 'staff' | 'customer'; role?: string };

declare module '@fastify/jwt' {
  interface FastifyJWT {
    payload: TokenUser;
    user: TokenUser;
  }
}

/**
 * Staff tokens live 12 hours, so the account is checked on every request: a deactivated account stops working at
 * once, and role checks use the role the account has now, not the one it had when the token was issued.
 */
async function useCurrentStaff(req: FastifyRequest) {
  const s = (await pool.query('SELECT role FROM staff_users WHERE id=$1 AND active', [req.user.sub])).rows[0];
  if (!s) throw unauthorized('Please sign in again');
  req.user.role = s.role;
}

export async function buildApp() {
  const app = Fastify({
    logger: config.env === 'test' ? false : { level: 'info', redact: ['req.headers.authorization'] },
    trustProxy: config.trustProxy,
    bodyLimit: 1_000_000,
  });

  await app.register(cors, {
    origin: config.corsOrigins.length ? config.corsOrigins : false,
    methods: ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['authorization', 'content-type', 'idempotency-key'],
    credentials: true,
  });
  await app.register(jwt, { secret: config.jwtSecret, sign: { expiresIn: '12h' } });
  await app.register(rateLimit, { global: false });
  await app.register(multipart, { limits: { fileSize: 8 * 1024 * 1024, files: 10 } });

  fs.mkdirSync(path.resolve(config.uploadDir), { recursive: true });
  await app.register(fastifyStatic, { root: path.resolve(config.uploadDir), prefix: '/uploads/', decorateReply: false });

  app.decorate('staffOnly', async (req: FastifyRequest) => {
    try {
      await req.jwtVerify();
    } catch {
      throw unauthorized();
    }
    if (req.user.kind !== 'staff') throw forbidden('Staff access only');
    await useCurrentStaff(req);
  });
  app.decorate('ownerOnly', async (req: FastifyRequest) => {
    try {
      await req.jwtVerify();
    } catch {
      throw unauthorized();
    }
    if (req.user.kind !== 'staff') throw forbidden('Company owner access only');
    await useCurrentStaff(req);
    if (req.user.role !== 'owner') throw forbidden('Company owner access only');
  });
  app.decorate('customerOnly', async (req: FastifyRequest) => {
    try {
      await req.jwtVerify();
    } catch {
      throw unauthorized();
    }
    if (req.user.kind !== 'customer') throw forbidden('Customer access only');
    // A password reset signs out every older session.
    const row = (await pool.query('SELECT password_changed_at, deleted_at FROM customers WHERE id=$1', [req.user.sub])).rows[0];
    const iat = (req.user as unknown as { iat?: number }).iat ?? 0;
    if (!row || row.deleted_at || (row.password_changed_at && iat < Math.floor(row.password_changed_at.getTime() / 1000))) throw unauthorized('Please sign in again');
  });

  app.setErrorHandler((err: any, req: FastifyRequest, reply: FastifyReply) => {
    if (err instanceof HttpError) {
      return reply.status(err.status).send({ error: { code: err.code ?? 'error', message: err.message, details: err.details } });
    }
    if (err instanceof ZodError) {
      return reply.status(400).send({
        error: { code: 'validation_error', message: 'Invalid input', details: err.issues.map((i) => ({ path: i.path.join('.'), message: i.message })) },
      });
    }
    // Stripe's own status codes (e.g. 401 for a bad key) must never be mistaken for the caller's login failing.
    if (typeof err.type === 'string' && err.type.startsWith('Stripe')) {
      const code = err.type === 'StripeAuthenticationError' ? 'stripe_auth_failed' : err.type === 'StripeConnectionError' ? 'stripe_unreachable' : 'stripe_error';
      const message = code === 'stripe_auth_failed' ? 'Stripe rejected the secret key. Check it is correct and not revoked.'
        : code === 'stripe_unreachable' ? 'Could not reach Stripe. Try again shortly.' : `Stripe error: ${err.message}`;
      req.log.warn({ stripeType: err.type }, 'stripe request failed');
      return reply.status(502).send({ error: { code, message } });
    }
    if (err.code === '23P01') return reply.status(409).send({ error: { code: 'overlap', message: 'That overlaps an existing booking or assignment' } });
    if (err.code === '23505') return reply.status(409).send({ error: { code: 'duplicate', message: 'That already exists' } });
    if (err.code === '23503') return reply.status(409).send({ error: { code: 'in_use', message: 'This record is referenced by other records' } });
    if (err.statusCode && err.statusCode < 500) {
      return reply.status(err.statusCode).send({ error: { code: err.code ?? 'error', message: err.message } });
    }
    req.log.error({ err }, 'unhandled error');
    return reply.status(500).send({ error: { code: 'internal', message: 'Something went wrong' } });
  });

  app.get('/health', async () => ({ ok: true }));
  app.get('/internal/run-jobs', async (req, reply) => {
    if (!config.cronSecret) return reply.status(404).send({ error: { code: 'not_found', message: 'Not found' } });
    const digest = (s: string) => crypto.createHash('sha256').update(s).digest();
    if (!crypto.timingSafeEqual(digest(req.headers.authorization ?? ''), digest(`Bearer ${config.cronSecret}`))) throw unauthorized();
    return runBackgroundJobs();
  });
  await app.register(authRoutes, { prefix: '/api' });
  await app.register(publicRoutes, { prefix: '/api/public' });
  await app.register(customerRoutes, { prefix: '/api/me' });
  await app.register(adminCatalogRoutes, { prefix: '/api/admin' });
  await app.register(adminBookingRoutes, { prefix: '/api/admin' });
  await app.register(adminOpsRoutes, { prefix: '/api/admin' });
  await app.register(webhookRoutes, { prefix: '/api/webhooks' });
  return app;
}

declare module 'fastify' {
  interface FastifyInstance {
    staffOnly: (req: FastifyRequest) => Promise<void>;
    ownerOnly: (req: FastifyRequest) => Promise<void>;
    customerOnly: (req: FastifyRequest) => Promise<void>;
  }
}
