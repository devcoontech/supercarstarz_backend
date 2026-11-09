import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import Fastify from 'fastify';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type Stripe from 'stripe';
import { pool } from '../src/core/db.js';
import { config, trustProxySetting } from '../src/core/config.js';
import { expireHolds } from '../src/modules/bookings/status.js';
import { handleStripeEvent } from '../src/modules/payments/payments.js';
import { setMailer, type Mail } from '../src/lib/mailer.js';
import { clearMapsCache, setMapsHttp } from '../src/lib/maps.js';
import { toCsv } from '../src/modules/reports/reports.routes.js';
import { app as makeApp, requireApproval, bookingPayload, makeCustomer, makeStaff, makeVehicle, resetDb } from './helpers.js';

/** Regression tests for the security audit findings (docs/security-audit/REPORT.md). */

let app: FastifyInstance;
beforeAll(async () => { app = await makeApp(); });
afterAll(async () => { await app.close(); setMapsHttp(null); await pool.end(); });
beforeEach(async () => { await resetDb(); setMailer(null); clearMapsCache(); setMapsHttp(null); });

const post = (url: string, headers: any, payload?: unknown) => app.inject({ method: 'POST', url, headers, payload: payload as any });
const get = (url: string, headers: any) => app.inject({ method: 'GET', url, headers });

describe('staff sessions follow the current account', () => {
  it('stops a deactivated account at once and uses the current role, not the one in the token', async () => {
    await makeStaff(app);
    const fin = await makeStaff(app, 'finance_manager', 'fin@test.com');
    const v = await makeVehicle();
    const c = await makeCustomer(app);
    const bk = (await post('/api/me/bookings', c.h, bookingPayload(v.id))).json();

    await pool.query(`UPDATE staff_users SET role='booking_manager' WHERE email='fin@test.com'`);
    const pay = await post(`/api/admin/bookings/${bk.id}/payments/manual`, fin.h, { amountPence: 1000, method: 'cash' });
    expect(pay.statusCode).toBe(403); // the demoted role, although the token still says finance_manager

    await pool.query(`UPDATE staff_users SET active=false WHERE email='fin@test.com'`);
    expect((await get('/api/admin/customers', fin.h)).statusCode).toBe(401);
  });
});

describe('password reset guessing', () => {
  let sent: Mail[] = [];
  beforeEach(() => { sent = []; setMailer({ send: async (m) => (sent.push(m), { sent: true }) }); });
  const forgot = (email: string) => post('/api/auth/customer/forgot', {}, { email });
  const reset = (email: string, code: string) => post('/api/auth/customer/reset', {}, { email, code, password: 'attacker-pw-123' });
  const codeFrom = (m: Mail) => m.text.match(/\b(\d{6})\b/)![1];
  const wrong = (code: string) => String((Number(code) + 1) % 1_000_000).padStart(6, '0');

  it('caps wrong guesses per account across new codes, so requesting a fresh code does not reset the budget', async () => {
    await makeCustomer(app, 'victim@test.com');
    for (let round = 0; round < 2; round++) {
      await forgot('victim@test.com');
      const code = codeFrom(sent[sent.length - 1]);
      for (let i = 0; i < 5; i++) expect((await reset('victim@test.com', wrong(code))).statusCode).toBe(400);
      await pool.query(`UPDATE password_resets SET created_at = created_at - interval '61 seconds'`); // past the one-a-minute limit
    }
    const before = sent.length;
    expect((await forgot('victim@test.com')).statusCode).toBe(200); // same answer as always
    expect(sent.length).toBe(before); // but no new code once the daily budget is used

    // Even a valid, unused code is refused while the account is locked.
    const id = (await pool.query(`SELECT id FROM customers WHERE email='victim@test.com'`)).rows[0].id;
    const hash = crypto.createHmac('sha256', config.jwtSecret).update(`${id}:123456`).digest('hex');
    await pool.query(`INSERT INTO password_resets(customer_id, code_hash, expires_at) VALUES ($1,$2,now() + interval '15 minutes')`, [id, hash]);
    expect((await reset('victim@test.com', '123456')).json().error.code).toBe('invalid_code');
    expect((await post('/api/auth/customer/login', {}, { email: 'victim@test.com', password: 'password-123' })).statusCode).toBe(200);
  });
});

describe('client address for rate limits', () => {
  it('trusts X-Forwarded-For only from a proxy on this machine by default', async () => {
    expect(config.trustProxy).toBe('loopback');
    const probe = Fastify({ trustProxy: trustProxySetting(undefined) });
    probe.get('/ip', async (req) => ({ ip: req.ip }));
    const fromInternet = await probe.inject({ method: 'GET', url: '/ip', remoteAddress: '203.0.113.5', headers: { 'x-forwarded-for': '1.2.3.4' } });
    expect(fromInternet.json().ip).toBe('203.0.113.5'); // a spoofed header from a direct client is ignored
    const viaLocalProxy = await probe.inject({ method: 'GET', url: '/ip', remoteAddress: '127.0.0.1', headers: { 'x-forwarded-for': '9.9.9.9, 198.51.100.7' } });
    expect(viaLocalProxy.json().ip).toBe('198.51.100.7'); // the address the proxy appended, not the client-written one
    await probe.close();
    expect(trustProxySetting('false')).toBe(false);
    expect(typeof trustProxySetting('1')).toBe('function');
  });
});

describe('map lookups for quotes and bookings', () => {
  const PLACES: Record<string, [number, number]> = { london: [51.5074, -0.1278], edinburgh: [55.9533, -3.1883] };
  let calls: string[] = [];
  const fakeMaps = async (url: string): Promise<Response> => {
    calls.push(url);
    const u = new URL(url);
    if (u.pathname === '/search') {
      const hit = PLACES[(u.searchParams.get('q') ?? '').trim().toLowerCase()];
      return Response.json(hit ? [{ lat: String(hit[0]), lon: String(hit[1]), display_name: u.searchParams.get('q') }] : []);
    }
    const m = u.pathname.match(/driving\/([-\d.]+),([-\d.]+);([-\d.]+),([-\d.]+)/);
    if (m) {
      const km = Math.hypot(Number(m[3]) - Number(m[1]), Number(m[4]) - Number(m[2])) * 111;
      return Response.json({ code: 'Ok', routes: [{ distance: km * 1000, duration: km * 60 }] });
    }
    return new Response('?', { status: 404 });
  };
  beforeEach(() => { calls = []; setMapsHttp(fakeMaps); });

  async function tripSetup() {
    const staff = await makeStaff(app);
    const v = await makeVehicle({ chauffeur_available: true, base_lat: 51.5074, base_lng: -0.1278, delivery_pricing: 'per_mile', delivery_radius_miles: 80 });
    const ev = (await post('/api/admin/event-types', staff.h, { title: 'Pick and Drop', published: true, pricingBasis: 'distance' })).json();
    await app.inject({ method: 'PUT', url: `/api/admin/vehicles/${v.id}/event-types`, headers: staff.h, payload: { eventTypeIds: [ev.id] } });
    await post('/api/admin/pricing-rules', staff.h, { kind: 'per_mile', vehicleId: v.id, eventTypeId: ev.id, amountPence: 250, minAmountPence: 3000 });
    return { v, ev };
  }

  it('refuses map pins that are far from the address typed with them', async () => {
    const { v, ev } = await tripSetup();
    const c = await makeCustomer(app);
    const here = { lat: 51.5074, lng: -0.1278 };
    const trip = bookingPayload(v.id, { eventTypeId: ev.id, pickupAddress: 'London', dropoffAddress: 'Edinburgh', pickupPoint: here, dropoffPoint: here });
    const r = await post('/api/me/orders', c.h, { items: [trip] });
    expect(r.statusCode).toBe(400);
    expect(r.json().error.code).toBe('pin_mismatch');
    // A pin next to its address is still used as given.
    const ok = await post('/api/public/quote', {}, bookingPayload(v.id, { eventTypeId: ev.id, pickupAddress: 'London', dropoffAddress: 'Edinburgh', pickupPoint: here, dropoffPoint: { lat: 55.95, lng: -3.19 } }));
    expect(ok.statusCode).toBe(200);
    expect(ok.json().pricing.distances.routeMiles).toBeGreaterThan(250);
  });

  it('refuses an oversized quote before making any map call', async () => {
    const { v, ev } = await tripSetup();
    const item = (i: number) => bookingPayload(v.id, { eventTypeId: ev.id, pickupAddress: `Street ${i}`, dropoffAddress: `Road ${i}` });
    const r = await post('/api/public/quote-order', {}, { items: Array.from({ length: 11 }, (_, i) => item(i)) });
    expect(r.statusCode).toBe(400);
    expect(r.json().error.code).toBe('too_many_items');
    expect(calls).toHaveLength(0);
  });
});

describe('unpaid customer requests', () => {
  it('expire if staff do not approve them in time, and one customer cannot hold many at once', async () => {
    await requireApproval();
    const cars = [await makeVehicle(), await makeVehicle(), await makeVehicle(), await makeVehicle()];
    const c = await makeCustomer(app);
    const orders = [];
    for (const v of cars.slice(0, 3)) orders.push(await post('/api/me/orders', c.h, { items: [bookingPayload(v.id)] }));
    expect(orders.map((o) => o.statusCode)).toEqual([201, 201, 201]);
    const fourth = await post('/api/me/orders', c.h, { items: [bookingPayload(cars[3].id)] });
    expect(fourth.statusCode).toBe(409);
    expect(fourth.json().error.code).toBe('too_many_open_orders');

    const row = (await pool.query(`SELECT status, hold_expires_at FROM bookings WHERE vehicle_id=$1`, [cars[0].id])).rows[0];
    expect(row.status).toBe('pending');
    const hours = (row.hold_expires_at.getTime() - Date.now()) / 3_600_000;
    expect(hours).toBeGreaterThan(47);
    expect(hours).toBeLessThan(49);

    await pool.query(`UPDATE bookings SET hold_expires_at = now() - interval '1 minute' WHERE vehicle_id=$1`, [cars[0].id]);
    expect(await expireHolds(pool as any)).toBe(1);
    expect((await pool.query(`SELECT status, cancel_reason FROM bookings WHERE vehicle_id=$1`, [cars[0].id])).rows[0])
      .toMatchObject({ status: 'cancelled', cancel_reason: 'Request expired before it was approved' });
    const other = await makeCustomer(app, 'other@test.com');
    expect((await post('/api/me/orders', other.h, { items: [bookingPayload(cars[0].id)] })).statusCode).toBe(201); // the car is free again
  });
});

describe('staff money and licence controls', () => {
  async function paidBooking() {
    const owner = await makeStaff(app);
    const lambo = await makeVehicle();
    const cheap = await makeVehicle({ price_per_hour_pence: 10000 });
    const c = await makeCustomer(app);
    const bk = (await post('/api/me/bookings', c.h, bookingPayload(lambo.id))).json();
    const pay = (await post(`/api/admin/bookings/${bk.id}/payments/manual`, owner.h, { amountPence: bk.totalPence, method: 'cash' })).json();
    return { owner, lambo, cheap, bk, pay };
  }
  const orderTotal = async (bookingId: string) => (await pool.query('SELECT o.total_pence FROM orders o JOIN bookings b ON b.order_id=o.id WHERE b.id=$1', [bookingId])).rows[0].total_pence;

  it('does not let a non-finance role lower a price by changing the car', async () => {
    const { owner, lambo, cheap, bk } = await paidBooking();
    const fleet = await makeStaff(app, 'fleet_manager', 'fleet@test.com');
    const total = await orderTotal(bk.id);
    const keep = await post(`/api/admin/bookings/${bk.id}/change-vehicle`, fleet.h, { vehicleId: cheap.id, reprice: false, reason: 'swap' });
    expect(keep.statusCode).toBe(403);
    const cheaper = await post(`/api/admin/bookings/${bk.id}/change-vehicle`, fleet.h, { vehicleId: cheap.id, reprice: true, reason: 'swap' });
    expect(cheaper.statusCode).toBe(403);
    expect(await orderTotal(bk.id)).toBe(total); // rolled back
    expect((await pool.query('SELECT vehicle_id FROM bookings WHERE id=$1', [bk.id])).rows[0].vehicle_id).toBe(lambo.id);
    // Finance roles can still make the change and the credit.
    expect((await post(`/api/admin/bookings/${bk.id}/change-vehicle`, owner.h, { vehicleId: cheap.id, reprice: true, reason: 'swap' })).statusCode).toBe(200);
    expect(await orderTotal(bk.id)).toBeLessThan(total);
  });

  it('needs licence access to delete a driver who has licence photos', async () => {
    const owner = await makeStaff(app);
    const fleet = await makeStaff(app, 'fleet_manager', 'fleet@test.com');
    const d = (await post('/api/admin/drivers', owner.h, { fullName: 'Dan', phone: '07000000001' })).json();
    const boundary = '----t' + Math.random().toString(16).slice(2);
    const jpeg = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(64, 1)]);
    const body = Buffer.concat([Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="l.jpg"\r\nContent-Type: image/jpeg\r\n\r\n`), jpeg, Buffer.from(`\r\n--${boundary}--\r\n`)]);
    const up = await app.inject({ method: 'POST', url: `/api/admin/drivers/${d.id}/licence-images/front`, payload: body, headers: { ...owner.h, 'content-type': `multipart/form-data; boundary=${boundary}` } });
    expect(up.statusCode).toBe(201);
    const key = (await pool.query('SELECT storage_key FROM driver_licence_images WHERE driver_id=$1', [d.id])).rows[0].storage_key;
    const file = path.join(path.resolve(config.privateUploadDir), key);
    expect(fs.existsSync(file)).toBe(true);

    expect((await app.inject({ method: 'DELETE', url: `/api/admin/drivers/${d.id}`, headers: fleet.h })).statusCode).toBe(403);
    expect(fs.existsSync(file)).toBe(true);
    expect((await app.inject({ method: 'DELETE', url: `/api/admin/drivers/${d.id}`, headers: owner.h })).statusCode).toBe(200);
    expect(fs.existsSync(file)).toBe(false);
    const actions = (await pool.query(`SELECT action FROM audit_log WHERE entity_id=$1 ORDER BY created_at`, [d.id])).rows.map((r) => r.action);
    expect(actions).toContain('remove_licence_image');
  });

  it('never refunds more than was paid when two refunds arrive at once', async () => {
    const { owner, bk, pay } = await paidBooking();
    const [a, b] = await Promise.all([
      post(`/api/admin/payments/${pay.id}/refund`, owner.h, { amountPence: bk.totalPence, reason: 'first' }),
      post(`/api/admin/payments/${pay.id}/refund`, owner.h, { amountPence: bk.totalPence, reason: 'second' }),
    ]);
    expect([a.statusCode, b.statusCode].sort()).toEqual([201, 400]);
    const o = (await pool.query('SELECT o.paid_pence, o.refunded_pence FROM orders o JOIN bookings b ON b.order_id=o.id WHERE b.id=$1', [bk.id])).rows[0];
    expect(o.refunded_pence).toBe(o.paid_pence);
  });
});

describe('Stripe refund events', () => {
  it('ignores an older refund event that arrives after the refund has failed', async () => {
    const v = await makeVehicle();
    const c = await makeCustomer(app);
    await pool.query(`INSERT INTO settings(key,value) VALUES ('booking.requireApproval','false')`);
    const bk = (await post('/api/me/bookings', c.h, bookingPayload(v.id))).json();
    const pay = (await pool.query(
      `INSERT INTO payments(booking_id,customer_id,amount_pence,method,source,status,provider_ref) VALUES ($1,$2,$3,'card','stripe','pending','pi_order_1') RETURNING *`,
      [bk.id, c.id, bk.totalPence])).rows[0];
    const ev = (id: string, type: string, object: object) => ({ id, object: 'event', type, data: { object } }) as unknown as Stripe.Event;
    await handleStripeEvent(ev('evt_paid', 'payment_intent.succeeded', { id: 'pi_order_1', object: 'payment_intent', amount_received: bk.totalPence, currency: 'gbp' }));
    await pool.query(`INSERT INTO refunds(payment_id, booking_id, amount_pence, reason, status, provider_ref) VALUES ($1,$2,$3,'test','pending','re_order_1')`, [pay.id, bk.id, bk.totalPence]);

    await handleStripeEvent(ev('evt_r2', 'refund.updated', { id: 're_order_1', object: 'refund', status: 'failed' }));
    await handleStripeEvent(ev('evt_r1', 'refund.created', { id: 're_order_1', object: 'refund', status: 'pending' })); // delivered late
    expect((await pool.query(`SELECT status FROM refunds WHERE provider_ref='re_order_1'`)).rows[0].status).toBe('failed');
    const o = (await pool.query('SELECT o.refunded_pence, o.payment_status FROM orders o JOIN bookings b ON b.order_id=o.id WHERE b.id=$1', [bk.id])).rows[0];
    expect(o).toMatchObject({ refunded_pence: 0, payment_status: 'paid' });
  });
});

describe('CSV export', () => {
  it('quotes cells containing a carriage return so no row can start with a formula', () => {
    const csv = toCsv([{ reason: 'Changed plans\r=1+1' }]);
    expect(csv).toBe('reason\n"Changed plans\r=1+1"');
  });
});

describe('customers can delete their account (store requirement)', () => {
  it('needs the password, refuses while a booking is upcoming, then erases personal details and ends every session', async () => {
    const v = await makeVehicle();
    const c = await makeCustomer(app, 'leaver@test.com');
    const bk = (await post('/api/me/bookings', c.h, bookingPayload(v.id))).json();

    expect((await post('/api/me/delete', c.h, { password: 'wrong-password' })).statusCode).toBe(401);
    const blocked = await post('/api/me/delete', c.h, { password: 'password-123' });
    expect(blocked.statusCode).toBe(409);
    expect(blocked.json().error.code).toBe('has_active_bookings');

    await post(`/api/me/bookings/${bk.id}/cancel`, c.h, {});
    expect((await post('/api/me/delete', c.h, { password: 'password-123' })).statusCode).toBe(200);

    const row = (await pool.query('SELECT email, name, phone, deleted_at FROM customers WHERE id=$1', [c.id])).rows[0];
    expect(row.email).not.toContain('leaver');
    expect(row.name).toBe('Deleted customer');
    expect(row.deleted_at).not.toBeNull();
    // The booking record stays (for accounting), the old token no longer works, and the old login is gone.
    expect((await pool.query('SELECT 1 FROM bookings WHERE id=$1', [bk.id])).rowCount).toBe(1);
    expect((await get('/api/me', c.h)).statusCode).toBe(401);
    const login = await app.inject({ method: 'POST', url: '/api/auth/customer/login', payload: { email: 'leaver@test.com', password: 'password-123' } });
    expect(login.statusCode).toBe(401);
    // The email can be used again for a new account.
    expect((await app.inject({ method: 'POST', url: '/api/auth/customer/register', payload: { email: 'leaver@test.com', password: 'password-123', name: 'New' } })).statusCode).toBe(201);
  });

  it('serves the public account-deletion page', async () => {
    const r = await app.inject({ method: 'GET', url: '/api/public/account-deletion' });
    expect(r.statusCode).toBe(200);
    expect(r.headers['content-type']).toContain('text/html');
    expect(r.body).toContain('Delete account');
  });
});
