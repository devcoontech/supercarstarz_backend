import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import Stripe from 'stripe';
import { pool } from '../src/core/db.js';
import { setSecret } from '../src/core/settings.js';
import { expireHolds } from '../src/modules/bookings/status.js';
import { setMailer, type Mail } from '../src/lib/mailer.js';
import { processOutbox } from '../src/modules/notifications/emails.js';
import { app as makeApp, requireApproval, bookingPayload, day, makeCustomer, makeEvent, makeStaff, makeVehicle, resetDb } from './helpers.js';

let app: FastifyInstance;
beforeAll(async () => { app = await makeApp(); });
afterAll(async () => { await app.close(); await pool.end(); });
beforeEach(resetDb);

const post = (url: string, headers: any, payload?: unknown) => app.inject({ method: 'POST', url, headers, payload: payload as any });

describe('customer app support endpoints', () => {
  it('serves public config without any secrets, including the publishable key once set', async () => {
    const staff = await makeStaff(app);
    await setSecret('stripe.secretKey', 'sk_test_SHOULDNEVERLEAK');
    await app.inject({ method: 'PUT', url: '/api/admin/settings', headers: staff.h, payload: { settings: { 'stripe.publishableKey': 'pk_test_abc123', 'company.supportPhone': '020 0000 0000' } } });
    const r = await app.inject({ method: 'GET', url: '/api/public/config' });
    expect(r.statusCode).toBe(200);
    expect(r.json().stripe.publishableKey).toBe('pk_test_abc123');
    expect(r.json().company.supportPhone).toBe('020 0000 0000');
    expect(r.json().booking).toMatchObject({ openHour: 10, closeHour: 19, requireApproval: false });
    expect(r.body).not.toContain('SHOULDNEVERLEAK');
    expect(r.body).not.toContain('sk_test');
  });

  it('reports free start times per day and marks a fully booked day as having none', async () => {
    const v = await makeVehicle({ max_hours: 9 });
    const c = await makeCustomer(app);
    await post('/api/me/bookings', c.h, bookingPayload(v.id, { time: '10:00', hours: 9 }));
    const r = await app.inject({ method: 'GET', url: `/api/public/vehicles/${v.id}/availability?date=${day()}&days=3` });
    expect(r.statusCode, r.body).toBe(200);
    const days = r.json().days;
    expect(days).toHaveLength(3);
    expect(days[0].slots).toEqual([]);
    expect(days[1].slots.length).toBeGreaterThan(0);
    expect(days[1].slots[0]).toMatchObject({ time: '10:00', maxHours: 9 });
  });

  it('stores the consents ticked at checkout and shows them to staff only', async () => {
    const v = await makeVehicle();
    const c = await makeCustomer(app);
    const staff = await makeStaff(app);
    const bk = (await post('/api/me/bookings', c.h, bookingPayload(v.id, { consents: { guardian: true, terms: true, marketingPhotos: false } }))).json();
    expect(bk).not.toHaveProperty('consents');
    const detail = (await app.inject({ method: 'GET', url: `/api/admin/bookings/${bk.id}`, headers: staff.h })).json();
    expect(detail.consents).toMatchObject({ guardian: true, terms: true, marketingPhotos: false });
    expect(detail.consents.at).toBeTruthy();
  });
});

describe('booking emails', () => {
  let sent: Mail[] = [];
  let mode: 'ok' | 'fail' | 'unconfigured' = 'ok';
  beforeEach(() => {
    sent = [];
    mode = 'ok';
    setMailer({
      send: async (m) => {
        if (mode === 'unconfigured') return { sent: false, reason: 'no_mail_provider_configured' };
        if (mode === 'fail') return { sent: false, reason: 'smtp down' };
        sent.push(m);
        return { sent: true };
      },
    });
  });
  const outbox = async () => (await pool.query('SELECT kind, status, attempts, last_error FROM email_outbox ORDER BY created_at')).rows;
  const whsec = 'whsec_emailtest123';
  const hook = (event: object) => {
    const payload = JSON.stringify(event);
    return app.inject({ method: 'POST', url: '/api/webhooks/stripe', headers: { 'content-type': 'application/json', 'stripe-signature': Stripe.webhooks.generateTestHeaderString({ payload, secret: whsec }) }, payload });
  };

  it('emails once when a booking is received, and not again on a second run', async () => {
    await requireApproval();
    const v = await makeVehicle();
    const c = await makeCustomer(app, 'mail@test.com');
    const bk = (await post('/api/me/bookings', c.h, bookingPayload(v.id))).json();
    expect((await processOutbox()).sent).toBe(1);
    expect((await processOutbox()).sent).toBe(0);
    expect(sent).toHaveLength(1);
    expect(sent[0].to).toBe('mail@test.com');
    expect(sent[0].subject).toContain(bk.ref);
    expect(sent[0].text).toContain('Nothing has been charged yet');
    expect(sent[0].text).toContain('Lamborghini Huracan');
    expect(await outbox()).toEqual([expect.objectContaining({ kind: 'booking_received', status: 'sent' })]);
  });

  it('sends one confirmed and one payment email even when Stripe retries the webhook', async () => {
    await setSecret('stripe.webhookSecret', whsec);
    await pool.query(`INSERT INTO settings(key,value) VALUES ('booking.requireApproval','false')`);
    const v = await makeVehicle();
    const c = await makeCustomer(app, 'pay@test.com');
    const bk = (await post('/api/me/bookings', c.h, bookingPayload(v.id))).json();
    await pool.query(`INSERT INTO payments(booking_id,customer_id,amount_pence,method,source,status,provider_ref) VALUES ($1,$2,$3,'card','stripe','pending','pi_mail_1')`, [bk.id, c.id, bk.totalPence]);
    const evt = { id: 'evt_mail_1', object: 'event', type: 'payment_intent.succeeded', data: { object: { id: 'pi_mail_1', object: 'payment_intent', amount_received: bk.totalPence, currency: 'gbp' } } };
    await hook(evt);
    await hook(evt);
    await hook({ ...evt, id: 'evt_mail_2' }); // a different event id for the same payment must not add another email
    await processOutbox(50);
    const kinds = (await outbox()).map((r) => r.kind).sort();
    expect(kinds).toEqual(['booking_confirmed', 'booking_received', 'payment_received']);
    const pay = sent.find((m) => m.subject.startsWith('Payment verified'))!;
    expect(pay.text).toContain('£420.00'); // 2h x 200 + 5% fee
    expect(pay.text).toContain('Nothing further to pay');
    // The receipt issued for the payment is attached, and named in the subject.
    const receipt = (await pool.query('SELECT number FROM invoices WHERE payment_id IS NOT NULL')).rows[0];
    expect(pay.subject).toContain(receipt.number);
    expect(pay.attachments).toEqual([expect.objectContaining({ filename: `${receipt.number}.html`, contentType: expect.stringContaining('text/html') })]);
    expect(pay.attachments![0].content).toContain(receipt.number);
    expect(pay.attachments![0].content).toContain('£420.00');
  });

  it('emails when a booking is approved for payment, with the exact amount due, and again only for a genuine new approval', async () => {
    await requireApproval();
    const v = await makeVehicle();
    const c = await makeCustomer(app, 'approve@test.com');
    const staff = await makeStaff(app);
    const bk = (await post('/api/me/bookings', c.h, bookingPayload(v.id))).json(); // total 420.00
    await post(`/api/admin/bookings/${bk.id}/status`, staff.h, { to: 'awaiting_payment' });
    await processOutbox(50);
    const mail = sent.find((m) => m.subject.includes('payment needed'))!;
    expect(mail.subject).toContain(bk.ref);
    expect(mail.text).toContain('pay £420.00');
    expect(mail.text).toContain('30 minutes');
    await processOutbox(50);
    expect(sent.filter((m) => m.subject.includes('payment needed'))).toHaveLength(1);
  });

  it('emails a refund once, for manual refunds too, without internal wording', async () => {
    const v = await makeVehicle();
    const c = await makeCustomer(app, 'refund@test.com');
    const staff = await makeStaff(app);
    const bk = (await post('/api/me/bookings', c.h, bookingPayload(v.id))).json();
    const pay = (await post(`/api/admin/bookings/${bk.id}/payments/manual`, staff.h, { amountPence: 42000, method: 'bank_transfer' })).json();
    const r = await post(`/api/admin/payments/${pay.id}/refund`, staff.h, { amountPence: 5000, reason: 'INTERNAL goodwill note' });
    expect(r.statusCode).toBe(201);
    await processOutbox(50);
    await processOutbox(50);
    const mails = sent.filter((m) => m.subject.startsWith('Refund issued'));
    expect(mails).toHaveLength(1);
    expect(mails[0].text).toContain('£50.00');
    expect(mails[0].text).toContain('Refunded in total: £50.00');
    expect(mails[0].text).not.toContain('INTERNAL');
    expect((await outbox()).filter((o) => o.kind === 'refund')).toEqual([expect.objectContaining({ status: 'sent' })]);
  });

  it('keeps staff cancel reasons out of the cancellation email', async () => {
    const v = await makeVehicle();
    const c = await makeCustomer(app, 'cancel@test.com');
    const staff = await makeStaff(app);
    const bk = (await post('/api/me/bookings', c.h, bookingPayload(v.id))).json();
    await post(`/api/admin/bookings/${bk.id}/status`, staff.h, { to: 'cancelled', reason: 'SECRET staff reason' });
    await processOutbox(50);
    const mail = sent.find((m) => m.subject.includes('cancelled'))!;
    expect(mail.text).toContain('Nothing was charged');
    expect(mail.text).not.toContain('SECRET');
  });

  it('never marks an email sent unless the provider accepted it, and retries failures', async () => {
    const v = await makeVehicle();
    const c = await makeCustomer(app, 'retry@test.com');
    await post('/api/me/bookings', c.h, bookingPayload(v.id));
    mode = 'fail';
    expect(await processOutbox()).toMatchObject({ sent: 0, retrying: 1 });
    expect(await outbox()).toEqual([expect.objectContaining({ status: 'pending', attempts: 1, last_error: 'smtp down' })]);
    expect(await processOutbox()).toMatchObject({ sent: 0, retrying: 0 }); // not due yet
    await pool.query(`UPDATE email_outbox SET next_attempt_at = now() - interval '1 minute'`);
    mode = 'ok';
    expect(await processOutbox()).toMatchObject({ sent: 1 });
    expect((await outbox())[0]).toMatchObject({ status: 'sent', attempts: 2 });
  });

  it('gives up after repeated failures and records a skip when no provider is configured', async () => {
    const v = await makeVehicle();
    const c = await makeCustomer(app, 'give@test.com');
    await post('/api/me/bookings', c.h, bookingPayload(v.id));
    mode = 'fail';
    for (let i = 0; i < 5; i++) {
      await pool.query(`UPDATE email_outbox SET next_attempt_at = now() - interval '1 minute' WHERE status='pending'`);
      await processOutbox();
    }
    expect((await outbox())[0]).toMatchObject({ status: 'failed', attempts: 5 });
    await pool.query('DELETE FROM email_outbox');
    await post('/api/me/bookings', c.h, bookingPayload(v.id, { time: '15:00' }));
    mode = 'unconfigured';
    expect(await processOutbox()).toMatchObject({ sent: 0, skipped: 1 });
    expect((await outbox())[0].status).toBe('skipped');
  });

  it('sends exactly once when two workers run at the same time, and does not email a driver assignment', async () => {
    const v = await makeVehicle();
    const c = await makeCustomer(app, 'race@test.com');
    const staff = await makeStaff(app);
    const bk = (await post('/api/me/bookings', c.h, bookingPayload(v.id, { chauffeur: true }))).json();
    await post(`/api/admin/bookings/${bk.id}/status`, staff.h, { to: 'confirmed', allowUnpaid: true });
    const d = (await post('/api/admin/drivers', staff.h, { fullName: 'Dan', phone: '07000000001' })).json();
    await post(`/api/admin/bookings/${bk.id}/driver`, staff.h, { driverId: d.id }); // shown in the app, not emailed
    await Promise.all([processOutbox(), processOutbox(), processOutbox()]);
    expect((await outbox()).map((r) => r.kind).sort()).toEqual(['booking_confirmed', 'booking_received']);
    expect(sent).toHaveLength(2);
    expect(sent.some((m) => m.subject.startsWith('Driver assigned'))).toBe(false);
    expect((await pool.query(`SELECT count(*)::int n FROM notifications WHERE kind='driver_assigned'`)).rows[0].n).toBe(1);
    const detail = (await app.inject({ method: 'GET', url: `/api/admin/bookings/${bk.id}`, headers: staff.h })).json();
    expect(detail.emails.map((e: any) => e.status)).toEqual(['sent', 'sent']);
  });
});

describe('password reset', () => {
  let sent: Mail[] = [];
  let sendOk = true;
  beforeEach(() => {
    sent = [];
    sendOk = true;
    setMailer({ send: async (m) => (sendOk ? (sent.push(m), { sent: true }) : { sent: false, reason: 'down' }) });
  });
  const forgot = (email: string) => post('/api/auth/customer/forgot', {}, { email });
  const reset = (email: string, code: string, password: string) => post('/api/auth/customer/reset', {}, { email, code, password });
  const codeFrom = (m: Mail) => m.text.match(/\b(\d{6})\b/)![1];

  it('answers identically for unknown emails and sends nothing', async () => {
    await makeCustomer(app, 'real@test.com');
    const a = await forgot('real@test.com');
    const b = await forgot('nobody@test.com');
    expect(a.statusCode).toBe(200);
    expect(b.json()).toEqual(a.json());
    expect(sent).toHaveLength(1);
    expect(sent[0].to).toBe('real@test.com');
  });

  it('resets the password with the emailed code, single use, and signs out older sessions', async () => {
    const c = await makeCustomer(app, 'r@test.com');
    await forgot('r@test.com');
    const code = codeFrom(sent[0]);
    const stored = (await pool.query('SELECT code_hash FROM password_resets')).rows[0].code_hash;
    expect(stored).not.toContain(code); // only a keyed hash is stored
    expect((await app.inject({ method: 'GET', url: '/api/me', headers: c.h })).statusCode).toBe(200);
    await new Promise((r) => setTimeout(r, 1100)); // tokens have 1 second resolution
    expect((await reset('r@test.com', code, 'brand-new-pass-1')).statusCode).toBe(200);
    expect((await post('/api/auth/customer/login', {}, { email: 'r@test.com', password: 'password-123' })).statusCode).toBe(401);
    const login = await post('/api/auth/customer/login', {}, { email: 'r@test.com', password: 'brand-new-pass-1' });
    expect(login.statusCode).toBe(200);
    expect((await app.inject({ method: 'GET', url: '/api/me', headers: c.h })).statusCode).toBe(401); // old session
    expect((await app.inject({ method: 'GET', url: '/api/me', headers: { authorization: 'Bearer ' + login.json().token } })).statusCode).toBe(200);
    expect((await reset('r@test.com', code, 'another-pass-22')).json().error.code).toBe('invalid_code'); // used
  });

  it('burns the code after five wrong guesses, even if the right one follows', async () => {
    await makeCustomer(app, 'b@test.com');
    await forgot('b@test.com');
    const code = codeFrom(sent[0]);
    const wrong = code === '000000' ? '111111' : '000000';
    for (let i = 0; i < 5; i++) expect((await reset('b@test.com', wrong, 'brand-new-pass-1')).statusCode).toBe(400);
    expect((await reset('b@test.com', code, 'brand-new-pass-1')).json().error.code).toBe('invalid_code');
    expect((await post('/api/auth/customer/login', {}, { email: 'b@test.com', password: 'password-123' })).statusCode).toBe(200); // unchanged
  });

  it('rejects expired codes, weak passwords and malformed codes', async () => {
    await makeCustomer(app, 'e@test.com');
    await forgot('e@test.com');
    const code = codeFrom(sent[0]);
    expect((await reset('e@test.com', code, 'short')).statusCode).toBe(400);
    expect((await reset('e@test.com', '12ab', 'brand-new-pass-1')).statusCode).toBe(400);
    await pool.query("UPDATE password_resets SET expires_at = now() - interval '1 minute'");
    expect((await reset('e@test.com', code, 'brand-new-pass-1')).json().error.code).toBe('invalid_code');
  });

  it('sends only one code a minute, and a newer code replaces the older one', async () => {
    await makeCustomer(app, 't@test.com');
    await forgot('t@test.com');
    await forgot('t@test.com');
    expect(sent).toHaveLength(1);
    await pool.query("UPDATE password_resets SET created_at = now() - interval '5 minutes'");
    await forgot('t@test.com');
    expect(sent).toHaveLength(2);
    const [oldCode, newCode] = sent.map(codeFrom);
    if (oldCode !== newCode) expect((await reset('t@test.com', oldCode, 'brand-new-pass-1')).statusCode).toBe(400);
    expect((await reset('t@test.com', newCode, 'brand-new-pass-1')).statusCode).toBe(200);
  });

  it('still answers generically when the email provider fails', async () => {
    await makeCustomer(app, 'f@test.com');
    sendOk = false;
    const r = await forgot('f@test.com');
    expect(r.statusCode).toBe(200);
    expect(r.json().ok).toBe(true);
  });
});

describe('cors', () => {
  it('lets the dashboard origin use PUT, PATCH and DELETE, and refuses other origins', async () => {
    const origin = process.env.CORS_ORIGINS!.split(',')[0].trim();
    for (const method of ['PUT', 'PATCH', 'DELETE']) {
      const r = await app.inject({ method: 'OPTIONS', url: '/api/admin/vehicles/x', headers: { origin, 'access-control-request-method': method, 'access-control-request-headers': 'authorization,content-type' } });
      expect(r.statusCode).toBe(204);
      expect(r.headers['access-control-allow-methods']).toContain(method);
      expect(r.headers['access-control-allow-origin']).toBe(origin);
    }
    const evil = await app.inject({ method: 'OPTIONS', url: '/api/admin/vehicles/x', headers: { origin: 'https://evil.example', 'access-control-request-method': 'PUT' } });
    expect(evil.headers['access-control-allow-origin']).toBeUndefined();
  });
});

describe('access control', () => {
  it('rejects anonymous and customer access to admin endpoints', async () => {
    const c = await makeCustomer(app);
    for (const url of ['/api/admin/bookings', '/api/admin/vehicles', '/api/admin/payments', '/api/admin/settings', '/api/admin/customers', '/api/admin/dashboard']) {
      expect((await app.inject({ method: 'GET', url })).statusCode).toBe(401);
      expect((await app.inject({ method: 'GET', url, headers: c.h })).statusCode).toBe(403);
    }
  });

  it('keeps customers out of each other\'s bookings and hides admin notes', async () => {
    const v = await makeVehicle();
    const a = await makeCustomer(app, 'a@test.com');
    const b = await makeCustomer(app, 'b@test.com');
    const created = await post('/api/me/bookings', a.h, bookingPayload(v.id));
    expect(created.statusCode).toBe(201);
    expect(created.json()).not.toHaveProperty('adminNotes');
    expect((await app.inject({ method: 'GET', url: `/api/me/bookings/${created.json().id}`, headers: b.h })).statusCode).toBe(404);
  });

  it('does not offer a way for a client to mark a payment as succeeded', async () => {
    await requireApproval();
    const v = await makeVehicle();
    const c = await makeCustomer(app);
    const bk = (await post('/api/me/bookings', c.h, bookingPayload(v.id))).json();
    const r = await app.inject({ method: 'PATCH', url: `/api/me/bookings/${bk.id}`, headers: c.h, payload: { paymentStatus: 'paid', status: 'confirmed', paidPence: 99999 } });
    expect(r.statusCode).toBe(404);
    expect((await pool.query('SELECT status, payment_status, paid_pence FROM bookings WHERE id=$1', [bk.id])).rows[0]).toMatchObject({ status: 'pending', payment_status: 'unpaid', paid_pence: 0 });
  });
});

describe('booking creation and availability', () => {
  it('by default sends a customer booking straight to payment, with no approval step', async () => {
    const v = await makeVehicle();
    const c = await makeCustomer(app);
    const r = await post('/api/me/bookings', c.h, bookingPayload(v.id));
    expect(r.statusCode).toBe(201);
    expect(r.json()).toMatchObject({ status: 'awaiting_payment' });
    expect(r.json().holdExpiresAt).toBeTruthy();
  });

  it('creates a priced booking with a snapshot and starts pending when approval is on', async () => {
    await requireApproval();
    const v = await makeVehicle();
    const c = await makeCustomer(app);
    const r = await post('/api/me/bookings', c.h, bookingPayload(v.id));
    expect(r.statusCode).toBe(201);
    expect(r.json()).toMatchObject({ status: 'pending', totalPence: 42000, hours: 2 });
    expect(r.json().pricing.lines[0].amountPence).toBe(40000);
  });

  it('lets exactly one of many concurrent requests take the same slot', async () => {
    const v = await makeVehicle();
    const customers = await Promise.all([1, 2, 3, 4, 5, 6].map((i) => makeCustomer(app, `c${i}@test.com`)));
    const results = await Promise.all(customers.map((c) => post('/api/me/bookings', c.h, bookingPayload(v.id))));
    const codes = results.map((r) => r.statusCode).sort();
    expect(codes.filter((s) => s === 201)).toHaveLength(1);
    expect(codes.filter((s) => s === 409)).toHaveLength(5);
    expect((await pool.query('SELECT count(*)::int n FROM bookings')).rows[0].n).toBe(1);
  });

  it('rejects overlapping and buffer-violating bookings, allows adjacent ones', async () => {
    const v = await makeVehicle({ buffer_minutes: 30 });
    const c = await makeCustomer(app);
    expect((await post('/api/me/bookings', c.h, bookingPayload(v.id, { time: '11:00', hours: 2 }))).statusCode).toBe(201);
    expect((await post('/api/me/bookings', c.h, bookingPayload(v.id, { time: '12:00', hours: 1 }))).statusCode).toBe(409); // overlaps
    expect((await post('/api/me/bookings', c.h, bookingPayload(v.id, { time: '13:00', hours: 1 }))).statusCode).toBe(409); // inside 30m buffer
    expect((await post('/api/me/bookings', c.h, bookingPayload(v.id, { time: '14:00', hours: 1 }))).statusCode).toBe(201);
  });

  it('the database itself refuses an overlapping insert that bypasses the API', async () => {
    const v = await makeVehicle();
    const c = await makeCustomer(app);
    const first = (await post('/api/me/bookings', c.h, bookingPayload(v.id))).json();
    const row = (await pool.query('SELECT * FROM bookings WHERE id=$1', [first.id])).rows[0];
    await expect(pool.query(
      `INSERT INTO bookings(customer_id,vehicle_id,status,start_at,end_at,hours,blocked_during,experience,pricing_snapshot,total_pence)
       VALUES ($1,$2,'confirmed',$3,$4,2,$5,'stationary','{}',0)`, [row.customer_id, row.vehicle_id, row.start_at, row.end_at, '[' + row.start_at.toISOString() + ',' + row.end_at.toISOString() + ')']),
    ).rejects.toMatchObject({ code: '23P01' });
  });

  it('enforces opening hours, duration limits, unpublished cars and notice period', async () => {
    const v = await makeVehicle({ max_hours: 4 });
    const hidden = await makeVehicle({ published: false });
    const c = await makeCustomer(app);
    expect((await post('/api/me/bookings', c.h, bookingPayload(v.id, { time: '09:00' }))).json().error.code).toBe('outside_hours');
    expect((await post('/api/me/bookings', c.h, bookingPayload(v.id, { time: '18:00', hours: 2 }))).json().error.code).toBe('outside_hours');
    expect((await post('/api/me/bookings', c.h, bookingPayload(v.id, { hours: 5 }))).json().error.code).toBe('invalid_duration');
    expect((await post('/api/me/bookings', c.h, bookingPayload(hidden.id))).statusCode).toBe(409);
    // Tomorrow is always in the future but always inside a 48-hour notice period, whatever time the test runs.
    await pool.query(`INSERT INTO settings(key, value) VALUES ('booking.minLeadHours', '48') ON CONFLICT (key) DO UPDATE SET value='48'`);
    expect((await post('/api/me/bookings', c.h, bookingPayload(v.id, { date: day(1) }))).json().error.code).toBe('too_soon');
  });

  it('replays an idempotent request instead of creating a duplicate', async () => {
    const v = await makeVehicle();
    const c = await makeCustomer(app);
    const h = { ...c.h, 'idempotency-key': 'abc-123' };
    const a = await post('/api/me/bookings', h, bookingPayload(v.id));
    const b = await post('/api/me/bookings', h, bookingPayload(v.id));
    expect(a.statusCode).toBe(201);
    expect(b.statusCode).toBe(200);
    expect(b.json().id).toBe(a.json().id);
    expect((await pool.query('SELECT count(*)::int n FROM bookings')).rows[0].n).toBe(1);
  });

  it('cancelling releases the slot; blocked times and maintenance are respected', async () => {
    const v = await makeVehicle();
    const c = await makeCustomer(app);
    const staff = await makeStaff(app);
    const bk = (await post('/api/me/bookings', c.h, bookingPayload(v.id))).json();
    expect((await post('/api/me/bookings', c.h, bookingPayload(v.id))).statusCode).toBe(409);
    expect((await post(`/api/me/bookings/${bk.id}/cancel`, c.h, {})).json().status).toBe('cancelled');
    expect((await post('/api/me/bookings', c.h, bookingPayload(v.id))).statusCode).toBe(201);

    const blk = await post(`/api/admin/vehicles/${v.id}/blocks`, staff.h, { startAt: `${day(12)}T10:00:00+01:00`, endAt: `${day(12)}T19:00:00+01:00`, reason: 'service' });
    expect([201]).toContain(blk.statusCode);
    expect((await post('/api/me/bookings', c.h, bookingPayload(v.id, { date: day(12) }))).statusCode).toBe(409);
  });

  it('refuses to block a time that has a live booking', async () => {
    const v = await makeVehicle();
    const c = await makeCustomer(app);
    const staff = await makeStaff(app);
    await post('/api/me/bookings', c.h, bookingPayload(v.id));
    const r = await post(`/api/admin/vehicles/${v.id}/blocks`, staff.h, { startAt: `${day()}T00:00:00Z`, endAt: `${day()}T23:00:00Z` });
    expect(r.statusCode).toBe(409);
    expect(r.json().error.code).toBe('overlaps_bookings');
  });

  it('only searches cars that are free for the requested period', async () => {
    const free = await makeVehicle();
    const taken = await makeVehicle();
    const c = await makeCustomer(app);
    await post('/api/me/bookings', c.h, bookingPayload(taken.id));
    const r = await app.inject({ method: 'GET', url: `/api/public/vehicles?date=${day()}&time=11:00&hours=2` });
    expect(r.json().items.map((i: any) => i.id)).toEqual([free.id]);
  });

  it('expires unpaid payment holds and releases the car', async () => {
    const v = await makeVehicle();
    const c = await makeCustomer(app);
    await pool.query(`INSERT INTO settings(key,value) VALUES ('booking.requireApproval','false')`);
    const bk = (await post('/api/me/bookings', c.h, bookingPayload(v.id))).json();
    expect(bk.status).toBe('awaiting_payment');
    await pool.query(`UPDATE bookings SET hold_expires_at = now() - interval '1 minute' WHERE id=$1`, [bk.id]);
    const client = await pool.connect();
    try { expect(await expireHolds(client)).toBe(1); } finally { client.release(); }
    expect((await pool.query('SELECT status FROM bookings WHERE id=$1', [bk.id])).rows[0].status).toBe('cancelled');
    expect((await post('/api/me/bookings', c.h, bookingPayload(v.id))).statusCode).toBe(201);
  });
});

describe('events and offers', () => {
  it('requires the vehicle to support the chosen event', async () => {
    const v = await makeVehicle();
    const other = await makeVehicle();
    const e = await makeEvent(v.id);
    const c = await makeCustomer(app);
    expect((await post('/api/me/bookings', c.h, bookingPayload(v.id, { eventTypeId: e.id }))).statusCode).toBe(201);
    expect((await post('/api/me/bookings', c.h, bookingPayload(other.id, { eventTypeId: e.id }))).json().error.code).toBe('event_not_supported');
  });

  it('applies a valid code once, records it in the snapshot, and rejects invalid, expired and exhausted codes', async () => {
    const v = await makeVehicle();
    const c = await makeCustomer(app);
    await pool.query(`INSERT INTO offers(code,title,discount_type,discount_value,usage_limit) VALUES ('SAVE10','Ten off','percent',10,1)`);
    await pool.query(`INSERT INTO offers(code,title,discount_type,discount_value,ends_at) VALUES ('OLD','Expired','percent',10, now() - interval '1 day')`);
    const ok = await post('/api/me/bookings', c.h, bookingPayload(v.id, { offerCode: 'save10' }));
    expect(ok.statusCode).toBe(201);
    expect(ok.json().pricing.discountPence).toBe(4000);
    expect(ok.json().pricing.offer.code).toBe('SAVE10');
    expect((await post('/api/me/bookings', c.h, bookingPayload(v.id, { time: '15:00', offerCode: 'SAVE10' }))).json().error.code).toBe('invalid_offer'); // exhausted
    expect((await post('/api/me/bookings', c.h, bookingPayload(v.id, { time: '15:00', offerCode: 'OLD' }))).json().error.code).toBe('invalid_offer');
    expect((await post('/api/me/bookings', c.h, bookingPayload(v.id, { time: '15:00', offerCode: 'NOPE' }))).json().error.code).toBe('invalid_offer');
    // cancelling returns the use
    await post(`/api/me/bookings/${ok.json().id}/cancel`, c.h, {});
    expect((await post('/api/me/bookings', c.h, bookingPayload(v.id, { offerCode: 'SAVE10' }))).statusCode).toBe(201);
  });

  it('keeps historical prices when pricing rules change afterwards', async () => {
    const v = await makeVehicle();
    const c = await makeCustomer(app);
    const staff = await makeStaff(app);
    const bk = (await post('/api/me/bookings', c.h, bookingPayload(v.id))).json();
    await post('/api/admin/pricing-rules', staff.h, { vehicleId: v.id, kind: 'hourly', amountPence: 99900 });
    await app.inject({ method: 'PATCH', url: `/api/admin/vehicles/${v.id}`, headers: staff.h, payload: { pricePerHourPence: 77700 } });
    const after = (await app.inject({ method: 'GET', url: `/api/me/bookings/${bk.id}`, headers: c.h })).json();
    expect(after.totalPence).toBe(42000);
    expect(after.pricing.totalPence).toBe(42000);
    const newQuote = (await post('/api/public/quote', {}, bookingPayload(v.id, { time: '15:00' }))).json();
    expect(newQuote.pricing.subtotalPence).toBe(99900 * 2);
  });
});

describe('lifecycle and audit', () => {
  it('enforces allowed transitions, requires reasons, and logs who did what', async () => {
    await requireApproval();
    const v = await makeVehicle();
    const c = await makeCustomer(app);
    const staff = await makeStaff(app);
    const bk = (await post('/api/me/bookings', c.h, bookingPayload(v.id))).json();
    expect((await post(`/api/admin/bookings/${bk.id}/status`, staff.h, { to: 'completed' })).json().error.code).toBe('invalid_transition');
    expect((await post(`/api/admin/bookings/${bk.id}/status`, staff.h, { to: 'rejected' })).json().error.code).toBe('reason_required');
    expect((await post(`/api/admin/bookings/${bk.id}/status`, staff.h, { to: 'confirmed' })).json().error.code).toBe('payment_required');
    expect((await post(`/api/admin/bookings/${bk.id}/status`, staff.h, { to: 'awaiting_payment' })).statusCode).toBe(200);
    // status change alone never marks payment as made
    const row = (await pool.query('SELECT status, payment_status, paid_pence FROM bookings WHERE id=$1', [bk.id])).rows[0];
    expect(row).toMatchObject({ status: 'awaiting_payment', payment_status: 'unpaid', paid_pence: 0 });
    const detail = (await app.inject({ method: 'GET', url: `/api/admin/bookings/${bk.id}`, headers: staff.h })).json();
    const change = detail.events.find((e: any) => e.action === 'status_changed');
    expect(change).toMatchObject({ from: 'pending', to: 'awaiting_payment', actorType: 'staff', actorName: 'Test Owner' });
  });

  it('reschedules without repricing and respects availability', async () => {
    const v = await makeVehicle();
    const c = await makeCustomer(app);
    const staff = await makeStaff(app);
    const a = (await post('/api/me/bookings', c.h, bookingPayload(v.id, { time: '10:00', hours: 1 }))).json();
    await post('/api/me/bookings', c.h, bookingPayload(v.id, { time: '14:00', hours: 1 }));
    expect((await post(`/api/admin/bookings/${a.id}/reschedule`, staff.h, { date: day(), time: '14:00' })).statusCode).toBe(409);
    const ok = await post(`/api/admin/bookings/${a.id}/reschedule`, staff.h, { date: day(), time: '16:00' });
    expect(ok.statusCode).toBe(200);
    expect(ok.json().total_pence).toBe(a.totalPence);
  });
});

describe('drivers', () => {
  async function confirmed(vehicleId: string, custId: string, h: any, staffH: any, time: string) {
    const bk = (await post('/api/me/bookings', h, bookingPayload(vehicleId, { time, hours: 1, chauffeur: true }))).json();
    await post(`/api/admin/bookings/${bk.id}/status`, staffH, { to: 'confirmed', allowUnpaid: true });
    return bk.id as string;
  }

  it('prevents a driver being double-booked, including travel buffer, and supports reassignment with history', async () => {
    const v1 = await makeVehicle();
    const v2 = await makeVehicle();
    const c = await makeCustomer(app);
    const staff = await makeStaff(app);
    const d1 = (await post('/api/admin/drivers', staff.h, { fullName: 'Dan Driver', phone: '07000000001' })).json();
    const d2 = (await post('/api/admin/drivers', staff.h, { fullName: 'Eve Driver', phone: '07000000002' })).json();
    const b1 = await confirmed(v1.id, c.id, c.h, staff.h, '10:00');
    const b2 = await confirmed(v2.id, c.id, c.h, staff.h, '11:00'); // adjacent: within the 30 min buffer
    const b3 = await confirmed(v2.id, c.id, c.h, staff.h, '15:00');

    expect((await post(`/api/admin/bookings/${b1}/driver`, staff.h, { driverId: d1.id })).statusCode).toBe(200);
    const clash = await post(`/api/admin/bookings/${b2}/driver`, staff.h, { driverId: d1.id });
    expect(clash.statusCode).toBe(409);
    expect(clash.json().error.code).toBe('driver_conflict');
    expect((await post(`/api/admin/bookings/${b3}/driver`, staff.h, { driverId: d1.id })).statusCode).toBe(200);

    const elig = (await app.inject({ method: 'GET', url: `/api/admin/bookings/${b2}/eligible-drivers`, headers: staff.h })).json().items;
    expect(elig.find((e: any) => e.id === d1.id).eligible).toBe(false);
    expect(elig.find((e: any) => e.id === d2.id).eligible).toBe(true);

    expect((await post(`/api/admin/bookings/${b1}/driver`, staff.h, { driverId: d2.id, reason: 'Dan sick' })).statusCode).toBe(200);
    const detail = (await app.inject({ method: 'GET', url: `/api/admin/bookings/${b1}`, headers: staff.h })).json();
    expect(detail.driverAssignments).toHaveLength(2);
    expect(detail.driverAssignments.filter((a: any) => a.active)).toHaveLength(1);
    expect(detail.events.some((e: any) => e.action === 'driver_reassigned' && e.reason === 'Dan sick')).toBe(true);
    // d1 was released from b1, so the adjacent 11:00 job no longer conflicts for d1
    expect((await post(`/api/admin/bookings/${b2}/driver`, staff.h, { driverId: d1.id })).statusCode).toBe(200);
  });

  it('hides licence numbers from roles that should not see them', async () => {
    const staff = await makeStaff(app);
    const lim = await makeStaff(app, 'booking_manager', 'bm@test.com');
    await post('/api/admin/drivers', staff.h, { fullName: 'Dan', phone: '07000000001', licenseNumber: 'SECRET123' });
    const owner = (await app.inject({ method: 'GET', url: '/api/admin/drivers', headers: staff.h })).json().items[0];
    const bm = (await app.inject({ method: 'GET', url: '/api/admin/drivers', headers: lim.h })).json().items[0];
    expect(owner.license_number).toBe('SECRET123');
    expect(bm).not.toHaveProperty('license_number');
  });

  it('stores licence photos privately, replaces a side on re-upload, and shows them only to allowed roles', async () => {
    const staff = await makeStaff(app);
    const lim = await makeStaff(app, 'booking_manager', 'bm@test.com');
    const c = await makeCustomer(app);
    const d = (await post('/api/admin/drivers', staff.h, { fullName: 'Dan', phone: '07000000001' })).json();
    const form = (h: object, data: Buffer) => {
      const boundary = '----t' + Math.random().toString(16).slice(2);
      const body = Buffer.concat([Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="l.jpg"\r\nContent-Type: image/jpeg\r\n\r\n`), data, Buffer.from(`\r\n--${boundary}--\r\n`)]);
      return { payload: body, headers: { ...h, 'content-type': `multipart/form-data; boundary=${boundary}` } };
    };
    const jpeg = (fill: number) => Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(64, fill)]);
    const up = (h: object, side: string, data: Buffer) => app.inject({ method: 'POST', url: `/api/admin/drivers/${d.id}/licence-images/${side}`, ...form(h, data) });

    expect((await up(staff.h, 'front', Buffer.from('not an image at all, honestly'))).statusCode).toBe(400);
    expect((await up(lim.h, 'front', jpeg(1))).statusCode).toBe(403);
    expect((await up(staff.h, 'front', jpeg(1))).statusCode).toBe(201);
    expect((await up(staff.h, 'back', jpeg(2))).statusCode).toBe(201);
    const replaced = await up(staff.h, 'front', jpeg(3));
    expect(replaced.json().items.map((i: any) => i.side)).toEqual(['front', 'back']);
    const front = replaced.json().items[0];

    const img = await app.inject({ method: 'GET', url: `/api/admin/drivers/${d.id}/licence-images/${front.id}`, headers: staff.h });
    expect(img.statusCode).toBe(200);
    expect(img.headers['content-type']).toBe('image/jpeg');
    expect(img.headers['cache-control']).toContain('no-store');
    expect(img.rawPayload[10]).toBe(3); // the replacement, not the first upload
    for (const h of [lim.h, c.h, {}]) expect((await app.inject({ method: 'GET', url: `/api/admin/drivers/${d.id}/licence-images/${front.id}`, headers: h })).statusCode).not.toBe(200);
    // Never reachable through the public uploads folder.
    const key = (await pool.query('SELECT storage_key FROM driver_licence_images WHERE id=$1', [front.id])).rows[0].storage_key;
    expect((await app.inject({ method: 'GET', url: `/uploads/${key}` })).statusCode).toBe(404);
    expect((await app.inject({ method: 'GET', url: '/api/admin/drivers', headers: staff.h })).json().items[0].licenceImages).toBe(2);
    const actions = (await pool.query(`SELECT action FROM audit_log WHERE entity='driver' AND entity_id=$1 ORDER BY id`, [d.id])).rows.map((r) => r.action);
    expect(actions).toEqual(expect.arrayContaining(['add_licence_image', 'replace_licence_image', 'view_licence_image']));

    expect((await app.inject({ method: 'DELETE', url: `/api/admin/drivers/${d.id}/licence-images/${front.id}`, headers: staff.h })).json().items.map((i: any) => i.side)).toEqual(['back']);
    // Deleting a driver with no history removes their photos too.
    expect((await app.inject({ method: 'DELETE', url: `/api/admin/drivers/${d.id}`, headers: staff.h })).statusCode).toBe(200);
    expect((await pool.query('SELECT count(*)::int n FROM driver_licence_images')).rows[0].n).toBe(0);
  });
});

describe('payments', () => {
  const whsec = 'whsec_testsecret123';
  async function setup() {
    await setSecret('stripe.webhookSecret', whsec);
    const v = await makeVehicle();
    const c = await makeCustomer(app);
    await pool.query(`INSERT INTO settings(key,value) VALUES ('booking.requireApproval','false')`);
    const bk = (await post('/api/me/bookings', c.h, bookingPayload(v.id))).json();
    const pay = (await pool.query(
      `INSERT INTO payments(booking_id,customer_id,amount_pence,method,source,status,provider_ref) VALUES ($1,$2,$3,'card','stripe','pending','pi_test_1') RETURNING *`,
      [bk.id, c.id, bk.totalPence])).rows[0];
    return { bk, c, pay };
  }
  const event = (id: string, type: string, obj: object) => JSON.stringify({ id, object: 'event', type, data: { object: obj } });
  const sign = (payload: string, secret = whsec) => Stripe.webhooks.generateTestHeaderString({ payload, secret });
  const hook = (payload: string, sig?: string) => app.inject({ method: 'POST', url: '/api/webhooks/stripe', headers: { 'content-type': 'application/json', ...(sig ? { 'stripe-signature': sig } : {}) }, payload });

  it('rejects unsigned and wrongly signed webhooks without changing anything', async () => {
    const { bk } = await setup();
    const body = event('evt_1', 'payment_intent.succeeded', { id: 'pi_test_1', object: 'payment_intent', amount_received: bk.totalPence, currency: 'gbp' });
    expect((await hook(body)).statusCode).toBe(400);
    expect((await hook(body, sign(body, 'whsec_wrong'))).statusCode).toBe(400);
    expect((await pool.query('SELECT status, paid_pence FROM bookings WHERE id=$1', [bk.id])).rows[0]).toMatchObject({ status: 'awaiting_payment', paid_pence: 0 });
  });

  it('confirms the booking on a verified success event, exactly once even if retried', async () => {
    const { bk, c } = await setup();
    const body = event('evt_2', 'payment_intent.succeeded', { id: 'pi_test_1', object: 'payment_intent', amount_received: bk.totalPence, currency: 'gbp' });
    expect((await hook(body, sign(body))).json()).toMatchObject({ handled: true, duplicate: false });
    expect((await hook(body, sign(body))).json()).toMatchObject({ duplicate: true });
    const row = (await pool.query('SELECT status, payment_status, paid_pence FROM bookings WHERE id=$1', [bk.id])).rows[0];
    expect(row).toMatchObject({ status: 'confirmed', payment_status: 'paid', paid_pence: bk.totalPence });
    expect((await pool.query(`SELECT count(*)::int n FROM notifications WHERE customer_id=$1 AND kind='payment_received'`, [c.id])).rows[0].n).toBe(1);
  });

  it('ignores a success event whose amount does not match what was charged', async () => {
    const { bk } = await setup();
    const body = event('evt_3', 'payment_intent.succeeded', { id: 'pi_test_1', object: 'payment_intent', amount_received: 100, currency: 'gbp' });
    expect((await hook(body, sign(body))).json().handled).toBe(false);
    expect((await pool.query('SELECT status, paid_pence FROM bookings WHERE id=$1', [bk.id])).rows[0]).toMatchObject({ status: 'awaiting_payment', paid_pence: 0 });
  });

  it('records failures without confirming', async () => {
    const { bk } = await setup();
    const body = event('evt_4', 'payment_intent.payment_failed', { id: 'pi_test_1', object: 'payment_intent', last_payment_error: { message: 'declined' } });
    await hook(body, sign(body));
    expect((await pool.query(`SELECT status FROM payments WHERE provider_ref='pi_test_1'`)).rows[0].status).toBe('failed');
    expect((await pool.query('SELECT status FROM bookings WHERE id=$1', [bk.id])).rows[0].status).toBe('awaiting_payment');
  });

  it('reports a rejected Stripe key as a gateway problem (502), never as a failed login (401)', async () => {
    const staff = await makeStaff(app);
    const put = await app.inject({ method: 'PUT', url: '/api/admin/settings', headers: staff.h, payload: { secrets: { stripeSecretKey: 'sk_test_FAKEFAKEFAKE1234' } } });
    expect(put.statusCode).toBe(200);
    expect(JSON.stringify(put.json())).not.toContain('FAKEFAKEFAKE'); // secret is never echoed back
    expect(put.json().secrets['stripe.secretKey']).toEqual({ configured: true, hint: '…1234' });
    const r = await post('/api/admin/settings/stripe/test', staff.h, {});
    expect(r.statusCode).toBe(502);
    expect(['stripe_auth_failed', 'stripe_unreachable']).toContain(r.json().error.code);
    expect((await app.inject({ method: 'PUT', url: '/api/admin/settings', headers: staff.h, payload: { secrets: { stripeSecretKey: 'nope' } } })).statusCode).toBe(400);
  });

  it('refuses card payment creation until Stripe is configured', async () => {
    const v = await makeVehicle();
    const c = await makeCustomer(app);
    const bk = (await post('/api/me/bookings', c.h, bookingPayload(v.id))).json();
    const r = await post(`/api/me/bookings/${bk.id}/pay`, c.h, {});
    expect(r.statusCode).toBe(503);
    expect(r.json().error.code).toBe('stripe_not_configured');
  });

  it('records manual payments, tracks partial/full/refunded states and blocks overpayment', async () => {
    await requireApproval();
    const v = await makeVehicle();
    const c = await makeCustomer(app);
    const staff = await makeStaff(app);
    const bk = (await post('/api/me/bookings', c.h, bookingPayload(v.id))).json(); // total 42000
    const m1 = await post(`/api/admin/bookings/${bk.id}/payments/manual`, staff.h, { amountPence: 20000, method: 'cash', reference: 'receipt 1' });
    expect(m1.statusCode).toBe(201);
    expect((await pool.query('SELECT payment_status, status FROM bookings WHERE id=$1', [bk.id])).rows[0]).toMatchObject({ payment_status: 'partially_paid', status: 'pending' });
    expect((await post(`/api/admin/bookings/${bk.id}/payments/manual`, staff.h, { amountPence: 30000, method: 'cash' })).json().error.code).toBe('overpayment');
    await post(`/api/admin/bookings/${bk.id}/payments/manual`, staff.h, { amountPence: 22000, method: 'bank_transfer' });
    expect((await pool.query('SELECT payment_status, paid_pence FROM bookings WHERE id=$1', [bk.id])).rows[0]).toMatchObject({ payment_status: 'paid', paid_pence: 42000 });

    const first = m1.json();
    expect((await post(`/api/admin/payments/${first.id}/refund`, staff.h, { amountPence: 25000, reason: 'x' })).statusCode).toBe(400); // more than the payment
    expect((await post(`/api/admin/payments/${first.id}/refund`, staff.h, { amountPence: 5000, reason: 'goodwill' })).statusCode).toBe(201);
    expect((await pool.query('SELECT payment_status, refunded_pence FROM bookings WHERE id=$1', [bk.id])).rows[0]).toMatchObject({ payment_status: 'partially_refunded', refunded_pence: 5000 });
    const dash = (await app.inject({ method: 'GET', url: '/api/admin/dashboard', headers: staff.h })).json();
    expect(dash.money.collectedPence).toBe(42000);
    expect(dash.money.refundedPence).toBe(5000);
    expect(dash.money.netCollectedPence).toBe(37000);
  });
});

describe('staff-created customers', () => {
  it('creates a customer without showing staff a password; the customer sets one with Forgot password, and staff book for them', async () => {
    const staff = await makeStaff(app);
    const v = await makeVehicle();
    const r = await post('/api/admin/customers', staff.h, { name: 'Walk In', email: 'Walk@In.com', phone: '07123' });
    expect(r.statusCode).toBe(201);
    expect(r.json()).not.toHaveProperty('temporaryPassword');
    expect((await pool.query(`SELECT city, postcode FROM customers WHERE email='walk@in.com'`)).rows[0]).toEqual({ city: null, postcode: null });
    // Later, in the app: same email, "Forgot your password?", the emailed code, then signed in with their own password.
    const sent: Mail[] = [];
    setMailer({ send: async (m) => (sent.push(m), { sent: true }) });
    expect((await post('/api/auth/customer/forgot', {}, { email: 'walk@in.com' })).statusCode).toBe(200);
    const code = sent[0].text.match(/\b(\d{6})\b/)![1];
    expect((await post('/api/auth/customer/reset', {}, { email: 'walk@in.com', code, password: 'my-own-pass-1' })).statusCode).toBe(200);
    const login = await post('/api/auth/customer/login', {}, { email: 'walk@in.com', password: 'my-own-pass-1' });
    expect(login.statusCode).toBe(200);
    setMailer(null);
    expect((await post('/api/admin/customers', staff.h, { name: 'Dup', email: 'walk@in.com' })).json().error.code).toBe('email_taken');
    const bk = await post('/api/admin/bookings', staff.h, { ...bookingPayload(v.id), customerId: r.json().customer.id, initialStatus: 'awaiting_payment' });
    expect(bk.statusCode).toBe(201);
    expect(bk.json().status).toBe('awaiting_payment');
  });
});

describe('uploads', () => {
  it('rejects non-image files and accepts a real image as the cover', async () => {
    const v = await makeVehicle();
    await pool.query('DELETE FROM vehicle_images');
    const staff = await makeStaff(app);
    const form = (name: string, data: Buffer) => {
      const boundary = '----t' + Math.random().toString(16).slice(2);
      const body = Buffer.concat([
        Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${name}"\r\nContent-Type: image/jpeg\r\n\r\n`), data, Buffer.from(`\r\n--${boundary}--\r\n`),
      ]);
      return { payload: body, headers: { ...staff.h, 'content-type': `multipart/form-data; boundary=${boundary}` } };
    };
    const bad = await app.inject({ method: 'POST', url: `/api/admin/vehicles/${v.id}/images`, ...form('evil.jpg', Buffer.from('<?php echo 1; ?> not an image at all')) });
    expect(bad.statusCode).toBe(400);
    expect(bad.json().failed[0].reason).toMatch(/JPEG, PNG or WebP/);
    const jpeg = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(64)]);
    const good = await app.inject({ method: 'POST', url: `/api/admin/vehicles/${v.id}/images`, ...form('car.jpg', jpeg) });
    expect(good.statusCode).toBe(201);
    expect(good.json().saved[0].isCover).toBe(true);
    const up = await app.inject({ method: 'POST', url: '/api/admin/uploads/events', ...form('e.jpg', jpeg) });
    expect(up.statusCode).toBe(201);
    expect(up.json().url).toMatch(/\/uploads\/events\/.+\.jpg$/);
    expect((await app.inject({ method: 'POST', url: '/api/admin/uploads/events', ...form('x.jpg', Buffer.from('nope nope nope nope')) })).statusCode).toBe(400);
    // cannot publish without a cover
    await pool.query('DELETE FROM vehicle_images');
    expect((await post(`/api/admin/vehicles/${v.id}/publish`, staff.h, { published: true })).json().error.code).toBe('publish_requirements');
  });
});

describe('branded emails, owner emails and reminders', () => {
  let sent: Mail[] = [];
  beforeEach(() => {
    sent = [];
    setMailer({ send: async (m) => (sent.push(m), { sent: true }) });
  });
  const outbox = async () => (await pool.query('SELECT kind, recipient, status, last_error FROM email_outbox ORDER BY created_at, recipient')).rows;

  it('sends every customer email as branded HTML with the inline logo, plus a matching plain-text body', async () => {
    const v = await makeVehicle();
    const c = await makeCustomer(app, 'html@test.com');
    await post('/api/me/bookings', c.h, bookingPayload(v.id));
    await processOutbox();
    const m = sent[0];
    expect(m.html).toContain('cid:logo@supercarstars');
    expect(m.html).toContain('#ffc41f'); // brand gold
    expect(m.html).toContain('Lamborghini Huracan');
    expect(m.text).toContain('Lamborghini Huracan');
    expect(m.inline).toEqual([expect.objectContaining({ cid: 'logo@supercarstars', contentType: 'image/jpeg' })]);
    expect(m.attachments).toBeUndefined(); // the logo is inline, not a download
  });

  it('queues no owner emails until an owner address is set', async () => {
    const v = await makeVehicle();
    const c = await makeCustomer(app, 'noowner@test.com');
    await post('/api/me/bookings', c.h, bookingPayload(v.id));
    expect((await outbox()).map((r) => r.recipient)).toEqual(['customer']);
  });

  it('emails the owner the full booking sheet on a new request and on confirmation; the customer never sees staff notes', async () => {
    await requireApproval();
    const staff = await makeStaff(app);
    await app.inject({ method: 'PUT', url: '/api/admin/settings', headers: staff.h, payload: { settings: { 'notifications.ownerEmails': 'boss@test.com, ops@test.com' } } });
    const v = await makeVehicle();
    const c = await makeCustomer(app, 'sheet@test.com');
    await pool.query(`UPDATE customers SET phone='07999 123456' WHERE id=$1`, [c.id]);
    const bk = (await post('/api/me/bookings', c.h, bookingPayload(v.id, { customerNotes: 'Birthday for Leo, turning 7' }))).json();
    await pool.query(`UPDATE bookings SET admin_notes='VIP INTERNAL' WHERE id=$1`, [bk.id]);
    await post(`/api/admin/bookings/${bk.id}/status`, staff.h, { to: 'confirmed', allowUnpaid: true, reason: 'paid cash' });
    await processOutbox(50);
    expect(await outbox()).toEqual([
      expect.objectContaining({ kind: 'booking_received', recipient: 'customer', status: 'sent' }),
      expect.objectContaining({ kind: 'booking_received', recipient: 'owner', status: 'sent' }),
      expect.objectContaining({ kind: 'booking_confirmed', recipient: 'customer', status: 'sent' }),
      expect.objectContaining({ kind: 'booking_confirmed', recipient: 'owner', status: 'sent' }),
    ]);
    const owner = sent.find((m) => m.subject.startsWith('Booking confirmed:'))!;
    expect(owner.to).toBe('boss@test.com, ops@test.com');
    expect(owner.subject).toContain(bk.ref);
    for (const s of ['sheet@test.com', '07999 123456', 'Birthday for Leo', 'VIP INTERNAL', 'Booking total', 'Balance due']) expect(owner.text).toContain(s);
    expect(sent.find((m) => m.subject.startsWith('New booking request'))!.text).toContain('Action needed');
    for (const m of sent.filter((x) => x.to === 'sheet@test.com')) expect(m.text + m.html).not.toContain('VIP INTERNAL');
  });

  it('tells the customer and the owner about a cancellation request', async () => {
    const staff = await makeStaff(app);
    await app.inject({ method: 'PUT', url: '/api/admin/settings', headers: staff.h, payload: { settings: { 'notifications.ownerEmails': 'boss@test.com' } } });
    const v = await makeVehicle();
    const c = await makeCustomer(app, 'creq@test.com');
    const bk = (await post('/api/me/bookings', c.h, bookingPayload(v.id))).json();
    await post(`/api/admin/bookings/${bk.id}/status`, staff.h, { to: 'confirmed', allowUnpaid: true, reason: 'ok' });
    await pool.query('DELETE FROM email_outbox');
    expect((await post(`/api/me/bookings/${bk.id}/cancel`, c.h, {})).statusCode).toBeLessThan(300);
    await processOutbox(50);
    expect(sent.map((m) => [m.to, m.subject.split(' (')[0].split(':')[0]])).toEqual(expect.arrayContaining([
      ['creq@test.com', "We've received your cancellation request"], ['boss@test.com', 'Cancellation requested'],
    ]));
  });

  it('queues one reminder per booking the day before, never twice, and not for bookings made at the last minute', async () => {
    const { queueReminders } = await import('../src/modules/notifications/reminders.js');
    const staff = await makeStaff(app);
    const v = await makeVehicle();
    const c = await makeCustomer(app, 'remind@test.com');
    const bk = (await post('/api/me/bookings', c.h, bookingPayload(v.id))).json();
    await post(`/api/admin/bookings/${bk.id}/status`, staff.h, { to: 'confirmed', allowUnpaid: true, reason: 'ok' });
    const run = async () => { const x = await pool.connect(); try { return await queueReminders(x); } finally { x.release(); } };
    expect(await run()).toBe(0); // 10 days away
    // Move it to tomorrow morning, booked long ago.
    await pool.query(`UPDATE bookings SET created_at = now() - interval '10 days', start_at = now() + interval '20 hours', end_at = now() + interval '22 hours',
                        blocked_during = tstzrange(now() + interval '20 hours', now() + interval '22 hours') WHERE id=$1`, [bk.id]);
    expect(await run()).toBe(1);
    expect(await run()).toBe(0);
    await processOutbox(50);
    const m = sent.find((s) => s.subject.startsWith('See you tomorrow'))!;
    expect(m.to).toBe('remind@test.com');
    expect(m.subject).toContain(bk.ref);
  });

  it('sends the paid-in-full invoice email with the final receipt attached', async () => {
    const staff = await makeStaff(app);
    const v = await makeVehicle();
    const c = await makeCustomer(app, 'invoice@test.com');
    const bk = (await post('/api/me/bookings', c.h, bookingPayload(v.id))).json();
    await post(`/api/admin/bookings/${bk.id}/payments/manual`, staff.h, { amountPence: 10000, method: 'bank_transfer' });
    await post(`/api/admin/bookings/${bk.id}/payments/manual`, staff.h, { amountPence: 32000, method: 'bank_transfer' });
    await processOutbox(50);
    const part = sent.find((m) => m.subject.startsWith('Payment verified for'))!;
    expect(part.text).toContain('Still to pay: £320.00');
    const full = sent.find((m) => m.subject.includes('paid in full'))!;
    const receipt = (await pool.query(`SELECT number FROM invoices WHERE kind='full_payment_receipt'`)).rows[0];
    expect(full.subject).toContain(receipt.number);
    expect(full.text).toContain('Nothing further to pay');
    expect(full.attachments).toEqual([expect.objectContaining({ filename: `${receipt.number}.html` })]);
    expect(full.attachments![0].content).toContain('data:image/jpeg;base64,'); // the receipt carries the logo too
  });
});
