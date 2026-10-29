import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import Stripe from 'stripe';
import { pool } from '../src/db.js';
import { setSecret } from '../src/settings.js';
import { app as makeApp, bookingPayload, day, makeCustomer, makeStaff, makeVehicle, resetDb } from './helpers.js';

/*
 * Acceptance scenarios for tax settings, multi-vehicle orders, offers and booking extensions.
 * The brief's figures are used directly as pence (a "5,000 per hour" car is 5000), so the arithmetic matches it line for line.
 */

let app: FastifyInstance;
beforeAll(async () => { app = await makeApp(); });
afterAll(async () => { await app.close(); await pool.end(); });
beforeEach(async () => {
  await resetDb();
  await setting('pricing.serviceFeeBp', 0); // the brief's examples have no service fee
});

const post = (url: string, headers: any, payload?: unknown) => app.inject({ method: 'POST', url, headers, payload: payload as any });
const get = (url: string, headers: any = {}) => app.inject({ method: 'GET', url, headers });
const put = (url: string, headers: any, payload?: unknown) => app.inject({ method: 'PUT', url, headers, payload: payload as any });
const setting = (key: string, value: unknown) =>
  pool.query(`INSERT INTO settings(key, value) VALUES ($1,$2) ON CONFLICT (key) DO UPDATE SET value=$2`, [key, JSON.stringify(value)]);
const item = (vehicleId: string, over: Record<string, unknown> = {}) => bookingPayload(vehicleId, { hours: 4, time: '11:00', ...over });
const offer = (o: Record<string, unknown>) => pool.query(
  `INSERT INTO offers(title, discount_type, discount_value, auto_apply, min_vehicles, max_vehicles, vehicle_categories, required_categories, max_discount_pence, applies_to, priority, stackable, starts_at, ends_at, min_booking_pence)
   VALUES ($1,$2,$3,true,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14) RETURNING id`,
  [o.title ?? 'Offer', o.type ?? 'percent', o.value, o.min ?? 1, o.max ?? null, o.categories ?? null, o.requiredCategories ?? null, o.maxDiscount ?? null, o.appliesTo ?? 'rental',
   o.priority ?? 0, o.stackable ?? false, o.startsAt ?? null, o.endsAt ?? null, o.minSubtotal ?? 0]).then((r) => r.rows[0].id as string);

/** Four cars at £50, £30, £40 and £30 an hour (in pence 5000, 3000, 4000, 3000): 4 hours each = 60,000. */
async function fleet() {
  return [
    await makeVehicle({ price_per_hour_pence: 5000, category: 'Supercar' }),
    await makeVehicle({ price_per_hour_pence: 3000, category: 'Convertible' }),
    await makeVehicle({ price_per_hour_pence: 4000, category: 'SUV' }),
    await makeVehicle({ price_per_hour_pence: 3000, category: 'Luxury' }),
  ];
}

describe('tax settings', () => {
  it('can be enabled, updated and disabled by the owner, and invalid values are refused', async () => {
    const staff = await makeStaff(app);
    const save = (settings: object) => put('/api/admin/settings', staff.h, { settings });
    expect((await save({ 'tax.enabled': true, 'tax.rateBp': 1000, 'tax.policy': 'after_discount', 'tax.label': 'VAT' })).statusCode).toBe(200);
    const v = await makeVehicle({ price_per_hour_pence: 5000 });
    const q1 = (await post('/api/public/quote', {}, item(v.id))).json();
    expect(q1.pricing).toMatchObject({ subtotalPence: 20000, taxablePence: 20000, taxPence: 2000, totalPence: 22000 });
    expect(q1.order.tax).toMatchObject({ enabled: true, rateBp: 1000, label: 'VAT' });
    await save({ 'tax.rateBp': 1500 });
    expect((await post('/api/public/quote', {}, item(v.id))).json().pricing.taxPence).toBe(3000);
    await save({ 'tax.enabled': false });
    expect((await post('/api/public/quote', {}, item(v.id))).json().pricing).toMatchObject({ taxPence: 0, totalPence: 20000 });
    for (const bad of [{ 'tax.rateBp': -5 }, { 'tax.rateBp': 10001 }, { 'tax.rateBp': 12.5 }, { 'tax.policy': 'sometimes' }, { 'tax.label': ' ' }]) {
      expect((await save(bad)).statusCode, JSON.stringify(bad)).toBe(400);
    }
    const manager = await makeStaff(app, 'booking_manager', 'bm@test.com');
    expect((await put('/api/admin/settings', manager.h, { settings: { 'tax.rateBp': 0 } })).statusCode).toBe(403);
  });

  it('keeps the tax rate and amount on existing bookings when the settings change', async () => {
    await setting('tax.enabled', true);
    await setting('tax.rateBp', 1000);
    const v = await makeVehicle({ price_per_hour_pence: 5000 });
    const c = await makeCustomer(app);
    const bk = (await post('/api/me/bookings', c.h, item(v.id))).json();
    expect(bk.finance.finalTotalPence).toBe(22000);
    await setting('tax.rateBp', 2000);
    await setting('tax.enabled', false);
    const after = (await get(`/api/me/bookings/${bk.id}`, c.h)).json();
    expect(after.finance.finalTotalPence).toBe(22000);
    expect(after.order.tax).toMatchObject({ enabled: true, rateBp: 1000, taxPence: 2000 });
    expect(after.pricing).toMatchObject({ taxPence: 2000, vatPence: 2000 });
  });

  it('follows the brief: 20,000 subtotal, 2,000 multi-vehicle discount, 10% tax after discount = 19,800; before discount = 20,000', async () => {
    await setting('tax.enabled', true);
    await setting('tax.rateBp', 1000);
    await offer({ title: 'Two cars', value: 10, min: 2 });
    const a = await makeVehicle({ price_per_hour_pence: 3000 });
    const b = await makeVehicle({ price_per_hour_pence: 2000 });
    const q = (await post('/api/public/quote-order', {}, { items: [item(a.id), item(b.id)] })).json();
    expect(q.order).toMatchObject({ subtotalPence: 20000, discountPence: 2000, taxablePence: 18000, taxPence: 1800, totalPence: 19800 });
    await setting('tax.policy', 'before_discount');
    const q2 = (await post('/api/public/quote-order', {}, { items: [item(a.id), item(b.id)] })).json();
    expect(q2.order).toMatchObject({ subtotalPence: 20000, discountPence: 2000, taxablePence: 20000, taxPence: 2000, totalPence: 20000 });
  });
});

describe('multiple vehicles in one order', () => {
  it('a customer books cars with different rates in one order: each priced on its own rate, one parent order', async () => {
    const [a, b, cc] = await fleet();
    const c = await makeCustomer(app);
    const r = await post('/api/me/orders', { ...c.h, 'idempotency-key': 'order-1' }, { items: [item(a.id), item(b.id), item(cc.id)], consents: { guardian: true, terms: true } });
    expect(r.statusCode, r.body).toBe(201);
    const o = r.json();
    expect(o.items.map((i: any) => i.pricing.lines[0].amountPence)).toEqual([20000, 12000, 16000]);
    expect(o).toMatchObject({ subtotalPence: 48000, discountPence: 0 });
    expect(o.finance.finalTotalPence).toBe(48000);
    expect(o.items.map((i: any) => i.ref)).toEqual([o.ref, `${o.ref}-2`, `${o.ref}-3`]);
    expect(new Set(o.items.map((i: any) => i.order.id))).toEqual(new Set([o.id]));
    // Repeating the same request returns the same order.
    const again = await post('/api/me/orders', { ...c.h, 'idempotency-key': 'order-1' }, { items: [item(a.id), item(b.id), item(cc.id)] });
    expect(again.statusCode).toBe(200);
    expect(again.json().id).toBe(o.id);
    expect((await pool.query('SELECT count(*)::int n FROM orders')).rows[0].n).toBe(1);
    // Each vehicle is its own booking with its own times; one notification for the order.
    const one = (await get(`/api/me/bookings/${o.items[1].id}`, c.h)).json();
    expect(one.order).toMatchObject({ ref: o.ref, vehicles: 3 });
    expect(one.order.bookings).toHaveLength(3);
    expect((await pool.query(`SELECT count(*)::int n FROM notifications WHERE kind='booking_received'`)).rows[0].n).toBe(1);
    // The staff list grouped by order counts the order once and returns all three cars together.
    const staff = await makeStaff(app);
    const list = (await get('/api/admin/bookings?group=order&limit=1', staff.h)).json();
    expect(list.total).toBe(1);
    expect(list.items.map((i: any) => i.ref)).toEqual([o.ref, `${o.ref}-2`, `${o.ref}-3`]);
    const byCar = (await get(`/api/admin/bookings?group=order&vehicleId=${b.id}`, staff.h)).json();
    expect(byCar.items).toHaveLength(3);
  });

  it('allows different durations per vehicle, and refuses a car twice at clashing times', async () => {
    const [a, b] = await fleet();
    const c = await makeCustomer(app);
    const r = (await post('/api/me/orders', c.h, { items: [item(a.id, { hours: 2 }), item(b.id, { hours: 5 })] })).json();
    expect(r.items.map((i: any) => i.hours)).toEqual([2, 5]);
    expect(r.subtotalPence).toBe(2 * 5000 + 5 * 3000);
    const clash = await post('/api/me/orders', c.h, { items: [item(a.id, { date: day(11), hours: 2 }), item(a.id, { date: day(11), time: '13:00', hours: 1 })] });
    expect(clash.statusCode).toBe(409);
    expect((await pool.query('SELECT count(*)::int n FROM orders')).rows[0].n).toBe(1); // nothing half-created
  });

  it('an admin creates a multi-vehicle order and adds a vehicle later; the order is re-priced and logged', async () => {
    const [a, b, cc] = await fleet();
    const c = await makeCustomer(app);
    const staff = await makeStaff(app);
    await offer({ title: '3 or more', value: 10, min: 3 });
    const created = await post('/api/admin/orders', staff.h, { customerId: c.id, items: [item(a.id), item(b.id)], initialStatus: 'confirmed' });
    expect(created.statusCode, created.body).toBe(201);
    const o = created.json();
    expect(o).toMatchObject({ subtotalPence: 32000, discountPence: 0, totalPence: 32000 });
    expect(o.items.every((i: any) => i.status === 'confirmed')).toBe(true);
    const added = await post(`/api/admin/orders/${o.id}/items`, staff.h, item(cc.id));
    expect(added.statusCode, added.body).toBe(201);
    const after = (await get(`/api/admin/orders/${o.id}`, staff.h)).json();
    expect(after).toMatchObject({ subtotalPence: 48000, discountPence: 4800, totalPence: 43200 });
    expect(after.offers.map((x: any) => x.title)).toEqual(['3 or more']);
    expect(after.items.reduce((t: number, i: any) => t + i.totalPence, 0)).toBe(43200);
    const detail = (await get(`/api/admin/bookings/${o.bookingId}`, staff.h)).json();
    expect(detail.events.map((e: any) => e.action)).toEqual(expect.arrayContaining(['vehicle_added', 'order_repriced']));
    expect(detail.order.items).toHaveLength(3);
  });
});

describe('offers', () => {
  it('applies the brief example: 4 cars, 60,000, 10% offer, 10% tax = 59,400', async () => {
    await setting('tax.enabled', true);
    await setting('tax.rateBp', 1000);
    await offer({ title: 'Book 3+ and save 10%', value: 10, min: 3 });
    const cars = await fleet();
    const q = (await post('/api/public/quote-order', {}, { items: cars.map((v) => item(v.id)) })).json();
    expect(q.order).toMatchObject({ subtotalPence: 60000, discountPence: 6000, taxablePence: 54000, taxPence: 5400, totalPence: 59400 });
    expect(q.order.offers[0]).toMatchObject({ title: 'Book 3+ and save 10%', discountPence: 6000, eligibleVehicles: 4 });
    expect(q.items.reduce((t: number, i: any) => t + i.pricing.totalPence, 0)).toBe(59400); // vehicles add up exactly
  });

  it('picks the right quantity tier, applies fixed discounts, caps discounts, and only stacks offers that allow it', async () => {
    const cars = await fleet();
    await offer({ title: '2+ save 5%', value: 5, min: 2 });
    await offer({ title: '3+ save 10%', value: 10, min: 3 });
    await offer({ title: '4+ save 15%', value: 15, min: 4 });
    const quote = async (vs: any[]) => (await post('/api/public/quote-order', {}, { items: vs.map((v) => item(v.id)) })).json().order;
    expect((await quote(cars.slice(0, 1))).discountPence).toBe(0);
    expect((await quote(cars.slice(0, 2))).offers[0].title).toBe('2+ save 5%');
    expect((await quote(cars.slice(0, 3))).offers.map((o: any) => o.title)).toEqual(['3+ save 10%']); // one offer, not stacked
    expect((await quote(cars)).discountPence).toBe(9000);

    await pool.query('DELETE FROM offers');
    await offer({ title: 'Four cars, 5,000 off', type: 'fixed', value: 5000, min: 4, max: 4 });
    expect((await quote(cars)).discountPence).toBe(5000);
    expect((await quote(cars.slice(0, 3))).discountPence).toBe(0);
    await pool.query('DELETE FROM offers');
    await offer({ title: 'Capped', value: 50, min: 1, maxDiscount: 7000 });
    expect((await quote(cars)).discountPence).toBe(7000);
    await pool.query('DELETE FROM offers');
    await offer({ title: 'A', value: 10, stackable: true });
    await offer({ title: 'B', type: 'fixed', value: 1000, stackable: true });
    await offer({ title: 'C', value: 5, priority: -1 });
    const stacked = await quote(cars);
    expect(stacked.offers.map((o: any) => o.title).sort()).toEqual(['A', 'B']);
    expect(stacked.discountPence).toBe(7000);
  });

  it('applies combination offers only when the right vehicles are booked together, and never discounts below zero', async () => {
    const cars = await fleet();
    await offer({ title: 'Supercar + SUV', value: 20, requiredCategories: ['Supercar', 'SUV'], categories: ['Supercar', 'SUV'] });
    const quote = async (vs: any[]) => (await post('/api/public/quote-order', {}, { items: vs.map((v) => item(v.id)) })).json().order;
    expect((await quote([cars[0], cars[1]])).discountPence).toBe(0);
    const both = await quote([cars[0], cars[2], cars[1]]);
    expect(both.discountPence).toBe(Math.floor((20000 + 16000) * 0.2)); // only the Supercar and SUV are discounted
    expect(both.items[2].discountPence).toBe(0); // the Convertible
    await pool.query('DELETE FROM offers');
    await offer({ title: 'Huge', type: 'fixed', value: 9_000_000 });
    const huge = await quote([cars[0]]);
    expect(huge).toMatchObject({ discountPence: 20000, totalPence: 0 });
  });

  it('only applies offers inside their dates, and a valid code loses to a better offer without an error', async () => {
    const cars = await fleet();
    const future = await offer({ title: 'Later', value: 20, startsAt: new Date(Date.now() + 86400000).toISOString() });
    await offer({ title: 'Ended', value: 30, endsAt: new Date(Date.now() - 1000).toISOString() });
    const quote = async (extra: object = {}) => (await post('/api/public/quote-order', {}, { items: cars.slice(0, 2).map((v) => item(v.id)), ...extra })).json();
    expect((await quote()).order.discountPence).toBe(0);
    await pool.query(`UPDATE offers SET starts_at = now() - interval '1 minute' WHERE id=$1`, [future]);
    expect((await quote()).order.offers.map((o: any) => o.title)).toEqual(['Later']);
    await pool.query(`INSERT INTO offers(code,title,discount_type,discount_value) VALUES ('SMALL','Small code','percent',5)`);
    const q = await quote({ offerCode: 'small' });
    expect(q.order.offers.map((o: any) => o.title)).toEqual(['Later']);
    expect(q.order.notApplied[0]).toMatchObject({ code: 'SMALL', reason: expect.stringMatching(/better offer/) });
    expect((await post('/api/public/quote-order', {}, { items: [item(cars[0].id)], offerCode: 'NOPE' })).json().error.code).toBe('invalid_offer');
  });

  it('removing a vehicle recalculates the offer and tax; the other vehicles carry on', async () => {
    await setting('tax.enabled', true);
    await setting('tax.rateBp', 1000);
    await offer({ title: '2+ save 5%', value: 5, min: 2 });
    await offer({ title: '3+ save 10%', value: 10, min: 3 });
    const [a, b, cc] = await fleet();
    const c = await makeCustomer(app);
    const staff = await makeStaff(app);
    const o = (await post('/api/me/orders', c.h, { items: [item(a.id), item(b.id), item(cc.id)] })).json();
    expect(o).toMatchObject({ subtotalPence: 48000, discountPence: 4800 });
    expect(o.finance.finalTotalPence).toBe(48000 - 4800 + 4320);
    // The customer cancels the third car (nothing paid yet).
    expect((await post(`/api/me/bookings/${o.items[2].id}/cancel`, c.h, {})).json().status).toBe('cancelled');
    const after = (await get(`/api/admin/orders/${o.id}`, staff.h)).json();
    expect(after).toMatchObject({ subtotalPence: 32000, discountPence: 1600, taxablePence: 30400, taxPence: 3040, totalPence: 33440 });
    expect(after.offers.map((x: any) => x.title)).toEqual(['2+ save 5%']);
    expect(after.items.map((i: any) => i.status)).toEqual(['pending', 'pending', 'cancelled']);
    // The previous price is kept in the history.
    const superseded = (await pool.query(`SELECT title FROM order_offers WHERE order_id=$1 AND superseded_at IS NOT NULL`, [o.id])).rows.map((r) => r.title);
    expect(superseded).toContain('3+ save 10%');
  });
});

describe('payments for a multi-vehicle order', () => {
  it('one verified payment covers the order, confirms every vehicle, and the receipt lists them all', async () => {
    const whsec = 'whsec_orderstest1';
    await setSecret('stripe.webhookSecret', whsec);
    await setting('booking.requireApproval', false);
    await setting('payment.mode', 'deposit');
    await setting('payment.depositPercentBp', 5000);
    const [a, b] = await fleet();
    const c = await makeCustomer(app);
    const o = (await post('/api/me/orders', c.h, { items: [item(a.id), item(b.id)] })).json();
    expect(o.finance).toMatchObject({ finalTotalPence: 32000, depositRequiredPence: 16000, dueNowPence: 16000 });
    await pool.query(`INSERT INTO payments(booking_id, order_id, customer_id, amount_pence, method, source, purpose, status, provider_ref) VALUES ($1,$2,$3,16000,'card','stripe','deposit','pending','pi_order')`,
      [o.items[0].id, o.id, c.id]);
    const payload = JSON.stringify({ id: 'evt_o', object: 'event', type: 'payment_intent.succeeded', data: { object: { id: 'pi_order', object: 'payment_intent', amount_received: 16000, currency: 'gbp' } } });
    await app.inject({ method: 'POST', url: '/api/webhooks/stripe', headers: { 'content-type': 'application/json', 'stripe-signature': Stripe.webhooks.generateTestHeaderString({ payload, secret: whsec }) }, payload });
    const after = (await get(`/api/me/orders/${o.id}`, c.h)).json();
    expect(after.items.map((i: any) => i.status)).toEqual(['confirmed', 'confirmed']);
    expect(after.finance).toMatchObject({ paidPence: 16000, balanceDuePence: 16000, paymentStatus: 'deposit_paid' });
    expect(after.invoices).toHaveLength(1);
    const html = (await get(`/api/me/invoices/${after.invoices[0].id}/document`, c.h)).body;
    expect(html).toContain(o.ref);
    expect(html).toContain('2 vehicles');
    expect(html).toContain(`${o.ref}-2`);
  });
});

describe('extending a booking', () => {
  async function twoBookings() {
    const v = await makeVehicle({ price_per_hour_pence: 5000, max_hours: 8 });
    const a = await makeCustomer(app, 'a@test.com');
    const b = await makeCustomer(app, 'b@test.com');
    const first = (await post('/api/me/bookings', a.h, bookingPayload(v.id, { time: '12:00', hours: 2 }))).json(); // 12:00-14:00
    return { v, a, b, first };
  }

  it('extends when the time is free: same booking, new end time, extra charge and tax added to the balance', async () => {
    await setting('tax.enabled', true);
    await setting('tax.rateBp', 1000);
    const { a, first } = await twoBookings();
    expect(first.finance.finalTotalPence).toBe(11000);
    const q = (await post(`/api/me/bookings/${first.id}/extension-quote`, a.h, { hours: 2 })).json();
    expect(q).toMatchObject({ available: true, additionalPence: 10000, previousTotalPence: 11000, newTotalPence: 22000, priceDifferencePence: 11000, taxDifferencePence: 1000, balanceAfterPence: 22000 });
    const r = await post(`/api/me/bookings/${first.id}/extend`, a.h, { hours: 2, expectedEndAt: first.endAt });
    expect(r.statusCode, r.body).toBe(200);
    expect(r.json().finance).toMatchObject({ finalTotalPence: 22000, balanceDuePence: 22000 });
    const after = (await get(`/api/me/bookings/${first.id}`, a.h)).json();
    expect(after.id).toBe(first.id);
    expect(new Date(after.endAt).getTime() - new Date(first.endAt).getTime()).toBe(2 * 3600_000);
    expect(after.hours).toBe(4);
    expect(after.extensionHistory[0]).toMatchObject({ status: 'confirmed', additionalHours: 2, priceDifferencePence: 11000, taxDifferencePence: 1000 });
    expect(after.pricing.lines.some((l: any) => l.key.startsWith('extension:'))).toBe(true);
    // A second tap with the old end time changes nothing.
    expect((await post(`/api/me/bookings/${first.id}/extend`, a.h, { hours: 2, expectedEndAt: first.endAt })).json().error.code).toBe('booking_changed');
    expect((await pool.query('SELECT count(*)::int n FROM bookings')).rows[0].n).toBe(1);
  });

  it('refuses an extension into the next booking or its preparation hour, and says how much is possible', async () => {
    const { v, a, b, first } = await twoBookings();
    expect((await post('/api/me/bookings', b.h, bookingPayload(v.id, { time: '17:00', hours: 1 }))).statusCode).toBe(201); // next booking at 17:00
    // To 17:00 would run straight into it (the hour before it is kept free): refused. To 16:00 is fine.
    const q = (await post(`/api/me/bookings/${first.id}/extension-quote`, a.h, { hours: 3 })).json();
    expect(q).toMatchObject({ available: false, code: 'slot_unavailable', canRequest: true, maxAvailableHours: 2 });
    expect(q.reason).toMatch(/already reserved/);
    expect(q.reason).toMatch(/up to 2 hours/);
    expect(q.reason).toMatch(/Contact us/);
    const refused = await post(`/api/me/bookings/${first.id}/extend`, a.h, { hours: 3, expectedEndAt: first.endAt });
    expect(refused.statusCode).toBe(409);
    expect(refused.json().error).toMatchObject({ code: 'extension_unavailable', details: { maxAvailableHours: 2 } });
    expect((await pool.query('SELECT end_at FROM bookings WHERE id=$1', [first.id])).rows[0].end_at.toISOString()).toBe(new Date(first.endAt).toISOString());
    expect((await post(`/api/me/bookings/${first.id}/extend`, a.h, { hours: 2, expectedEndAt: first.endAt })).statusCode).toBe(200);
  });

  it('lets the customer ask staff when it is not possible; approval re-checks availability first', async () => {
    const { v, a, b, first } = await twoBookings();
    const staff = await makeStaff(app);
    const next = (await post('/api/me/bookings', b.h, bookingPayload(v.id, { time: '16:00', hours: 1 }))).json();
    const req = await post(`/api/me/bookings/${first.id}/extension-requests`, a.h, { hours: 2, message: 'Party is running late' });
    expect(req.statusCode, req.body).toBe(201);
    expect(req.json().status).toBe('requested');
    // A request is not an extension: the booking is unchanged and the car is still free for others after 14:00.
    expect((await get(`/api/me/bookings/${first.id}`, a.h)).json().hours).toBe(2);
    expect((await pool.query(`SELECT count(*)::int n FROM notifications WHERE staff_only AND kind='extension_requested'`)).rows[0].n).toBe(1);
    expect((await post(`/api/me/bookings/${first.id}/extension-requests`, a.h, { hours: 1 })).json().error.code).toBe('request_exists');
    const list = (await get('/api/admin/extension-requests', staff.h)).json().items;
    expect(list[0]).toMatchObject({ bookingId: first.id, additionalHours: 2, customerMessage: 'Party is running late' });
    // Still clashes with the 16:00 booking: approval fails and changes nothing.
    const blocked = await post(`/api/admin/extensions/${list[0].id}/approve`, staff.h, {});
    expect(blocked.statusCode).toBe(409);
    expect((await pool.query(`SELECT status FROM booking_extensions WHERE id=$1`, [list[0].id])).rows[0].status).toBe('requested');
    // Staff move the other customer, then approve.
    await post(`/api/admin/bookings/${next.id}/status`, staff.h, { to: 'cancelled', reason: 'Moved to another car' });
    const ok = await post(`/api/admin/extensions/${list[0].id}/approve`, staff.h, { reason: 'Approved by phone' });
    expect(ok.statusCode, ok.body).toBe(200);
    expect(ok.json()).toMatchObject({ status: 'confirmed', additionalHours: 2 });
    const detail = (await get(`/api/admin/bookings/${first.id}`, staff.h)).json();
    expect(detail.hours).toBe(4);
    expect(detail.extensions[0]).toMatchObject({ status: 'confirmed', decidedBy: 'Test Owner' });
    expect(detail.events.map((e: any) => e.action)).toEqual(expect.arrayContaining(['extension_requested', 'extended']));
  });

  it('staff can reject a request with a reason, and closed or ended bookings cannot be extended', async () => {
    const { a, first } = await twoBookings();
    const staff = await makeStaff(app);
    const rq = (await post(`/api/me/bookings/${first.id}/extension-requests`, a.h, { hours: 1 })).json();
    expect((await post(`/api/admin/extensions/${rq.id}/reject`, staff.h, {})).statusCode).toBe(400);
    expect((await post(`/api/admin/extensions/${rq.id}/reject`, staff.h, { reason: 'Car needed elsewhere' })).json().status).toBe('rejected');
    expect((await get('/api/me/notifications', a.h)).json().items.map((n: any) => n.kind)).toContain('extension_rejected');
    await post(`/api/me/bookings/${first.id}/cancel`, a.h, {});
    expect((await post(`/api/me/bookings/${first.id}/extension-quote`, a.h, { hours: 1 })).json().error.code).toBe('not_extendable');
  });

  it('respects opening hours and the car maximum for customers; staff can go beyond them but never into another booking', async () => {
    const { v, a, b, first } = await twoBookings();
    const staff = await makeStaff(app);
    const late = (await post(`/api/me/bookings/${first.id}/extension-quote`, a.h, { hours: 6 })).json(); // to 20:00, past 19:00
    expect(late).toMatchObject({ available: false, code: 'outside_hours', maxAvailableHours: 5 });
    expect((await post(`/api/admin/bookings/${first.id}/extend`, staff.h, { hours: 6, reason: 'Late event' })).statusCode).toBe(200);
    // Staff still can't extend into someone else's booking (or its preparation hour).
    const second = (await post('/api/me/bookings', a.h, bookingPayload(v.id, { date: day(11), time: '12:00', hours: 2 }))).json();
    await post('/api/me/bookings', b.h, bookingPayload(v.id, { date: day(11), time: '16:00', hours: 1 }));
    const into = await post(`/api/admin/bookings/${second.id}/extend`, staff.h, { hours: 2 });
    expect(into.json().error).toMatchObject({ code: 'extension_unavailable', details: { maxAvailableHours: 1 } });
  });

  it('two people cannot take the same time: an extension and a new booking racing for it, only one wins', async () => {
    const { v, a, b, first } = await twoBookings();
    const [ext, book] = await Promise.all([
      post(`/api/me/bookings/${first.id}/extend`, a.h, { hours: 2, expectedEndAt: first.endAt }),
      post('/api/me/bookings', b.h, bookingPayload(v.id, { time: '16:00', hours: 1 })),
    ]);
    expect([ext.statusCode, book.statusCode].filter((s) => s === 200 || s === 201)).toHaveLength(1);
    expect([ext.statusCode, book.statusCode].filter((s) => s === 409)).toHaveLength(1);
  });

  it('only the booking owner can quote, extend or ask; customers cannot use staff endpoints', async () => {
    const { a, b, first } = await twoBookings();
    expect((await post(`/api/me/bookings/${first.id}/extension-quote`, b.h, { hours: 1 })).statusCode).toBe(404);
    expect((await post(`/api/me/bookings/${first.id}/extend`, b.h, { hours: 1, expectedEndAt: first.endAt })).statusCode).toBe(404);
    expect((await post(`/api/me/bookings/${first.id}/extension-requests`, b.h, { hours: 1 })).statusCode).toBe(404);
    expect((await get(`/api/me/orders/${first.order.id}`, b.h)).statusCode).toBe(404);
    expect((await post(`/api/admin/bookings/${first.id}/extend`, a.h, { hours: 1 })).statusCode).toBe(403);
    expect((await get('/api/admin/extension-requests', a.h)).statusCode).toBe(403);
    expect((await post('/api/admin/orders', a.h, { customerId: a.id, items: [] })).statusCode).toBe(403);
  });
});

describe('concurrency and consistency', () => {
  it('two multi-vehicle orders sharing a car at the same time: only one is created', async () => {
    const [x, y, z] = await fleet();
    const a = await makeCustomer(app, 'a@test.com');
    const b = await makeCustomer(app, 'b@test.com');
    const [r1, r2] = await Promise.all([
      post('/api/me/orders', a.h, { items: [item(x.id), item(y.id)] }),
      post('/api/me/orders', b.h, { items: [item(z.id), item(y.id)] }),
    ]);
    expect([r1.statusCode, r2.statusCode].sort()).toEqual([201, 409]);
    expect((await pool.query('SELECT count(*)::int n FROM bookings')).rows[0].n).toBe(2);
  });

  it('the quote, the created order, its vehicles, the finance summary and the receipt all agree', async () => {
    await setting('tax.enabled', true);
    await setting('tax.rateBp', 2000);
    await setting('pricing.serviceFeeBp', 500);
    await offer({ title: '3+ save 10%', value: 10, min: 3, appliesTo: 'subtotal' });
    const cars = await fleet();
    const c = await makeCustomer(app);
    const staff = await makeStaff(app);
    const items = cars.slice(0, 3).map((v, i) => item(v.id, { hours: 2 + i, driverOption: 'with_driver' }));
    const q = (await post('/api/public/quote-order', c.h, { items })).json().order;
    const o = (await post('/api/me/orders', c.h, { items })).json();
    expect(o.finance.finalTotalPence).toBe(q.totalPence);
    expect(o.items.reduce((t: number, i: any) => t + i.totalPence, 0)).toBe(q.totalPence);
    expect(q.totalPence).toBe(q.subtotalPence - q.discountPence + q.taxPence + q.serviceFeePence);
    await post(`/api/admin/bookings/${o.items[0].id}/payments/manual`, staff.h, { amountPence: q.totalPence, method: 'cash' });
    const [rcpt] = (await get(`/api/me/orders/${o.id}`, c.h)).json().invoices;
    expect(rcpt).toMatchObject({ kind: 'full_payment_receipt', amountPence: q.totalPence, bookingTotalPence: q.totalPence, balancePence: 0 });
    const html = (await get(`/api/me/invoices/${rcpt.id}/document`, c.h)).body;
    expect(html).toContain('VAT at 20%');
    expect(html).toContain('Discount: 3+ save 10%');
    // A manual payment is checked against the whole order, never more.
    expect((await post(`/api/admin/bookings/${o.items[1].id}/payments/manual`, staff.h, { amountPence: 1, method: 'cash' })).json().error.code).toBe('overpayment');
  });
});

describe('app and dashboard flows', () => {
  /** The body the mobile app sends for one car (lib/quote.ts draftBody, as CheckoutScreen fills it in). */
  const appItem = (vehicleId: string, over: Record<string, unknown> = {}) => ({
    vehicleId, eventTypeId: null, date: day(), time: '11:00', hours: 2, experience: 'stationary', address: null, pickupAddress: null, dropoffAddress: null,
    addressPoint: null, pickupPoint: null, dropoffPoint: null, driverOption: 'self_drive', addons: [], children: 2, occasion: null, ...over,
  });

  it('books several cars in one order from the app checkout, priced and paid for together', async () => {
    const [v1, v2] = await fleet();
    const c = await makeCustomer(app);
    const r = await app.inject({ method: 'POST', url: '/api/me/orders', headers: { ...c.h, 'idempotency-key': 'app-checkout-1' },
      payload: { items: [appItem(v1.id), appItem(v2.id, { time: '13:00', occasion: 'Two-car birthday' })], offerCode: null, consents: { guardian: true, terms: true, marketingPhotos: false } } });
    expect(r.statusCode, r.body).toBe(201);
    const o = r.json();
    expect(o.items).toHaveLength(2);
    expect(new Set(o.items.map((i: any) => i.order.ref)).size).toBe(1);
    expect(o.items[0].finance.finalTotalPence).toBe(o.items[0].totalPence + o.items[1].totalPence); // one total for the order
    // The booking detail the app opens lists every car in the order.
    const detail = (await get(`/api/me/bookings/${o.items[1].id}`, c.h)).json();
    expect(detail.order.bookings.map((x: any) => x.id)).toEqual(o.items.map((i: any) => i.id));
  });

  it('staff can approve a request for fewer hours than asked when only that much is free', async () => {
    const v = await makeVehicle({ price_per_hour_pence: 5000, max_hours: 8 });
    const a = await makeCustomer(app, 'a@test.com');
    const b = await makeCustomer(app, 'b@test.com');
    const staff = await makeStaff(app);
    const first = (await post('/api/me/bookings', a.h, bookingPayload(v.id, { time: '12:00', hours: 2 }))).json(); // 12:00-14:00
    await post('/api/me/bookings', b.h, bookingPayload(v.id, { time: '16:00', hours: 1 })); // with the hour's buffer, 1 more hour fits
    const q = (await post(`/api/me/bookings/${first.id}/extension-quote`, a.h, { hours: 3 })).json();
    expect(q).toMatchObject({ available: false, canRequest: true, maxAvailableHours: 1 });
    await post(`/api/me/bookings/${first.id}/extension-requests`, a.h, { hours: 3 });
    const [req] = (await get('/api/admin/extension-requests', staff.h)).json().items;
    const ok = await post(`/api/admin/extensions/${req.id}/approve`, staff.h, { reason: null, hours: 1 });
    expect(ok.statusCode, ok.body).toBe(200);
    expect(ok.json()).toMatchObject({ status: 'confirmed', additionalHours: 1 });
    expect((await get(`/api/me/bookings/${first.id}`, a.h)).json().hours).toBe(3);
  });

  it('staff can add a delivered car for an occasion to an existing order', async () => {
    const [v1, v2] = await fleet();
    const ev = (await pool.query(`INSERT INTO event_types(slug,title,published) VALUES ('weddings','Weddings',true) RETURNING id`)).rows[0];
    await pool.query('INSERT INTO vehicle_event_types VALUES ($1,$2)', [v2.id, ev.id]);
    const c = await makeCustomer(app);
    const staff = await makeStaff(app);
    const first = (await post('/api/me/bookings', c.h, bookingPayload(v1.id))).json();
    const r = await post(`/api/admin/orders/${first.order.id}/items`, staff.h, {
      vehicleId: v2.id, date: day(), time: '13:00', hours: 2, experience: 'delivered', address: '1 Chapel Lane, London', eventTypeId: ev.id, driverOption: 'self_drive',
    });
    expect(r.statusCode, r.body).toBe(201);
    expect(r.json()).toMatchObject({ order_id: first.order.id, experience: 'delivered', address: '1 Chapel Lane, London', event_type_id: ev.id });
  });
});
