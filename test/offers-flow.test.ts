import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { pool } from '../src/core/db.js';
import { app as makeApp, bookingPayload, makeCustomer, makeEvent, makeStaff, makeVehicle, resetDb } from './helpers.js';

/*
 * Offers end to end, through the same API calls the dashboard and the app make: staff create an offer in the
 * dashboard, customers see it in the app, a booking picks it up, the discount is saved on the booking and its
 * documents, its use is counted, limits are enforced, and cancelling gives the use back.
 */

let app: FastifyInstance;
let staff: { h: Record<string, string> };
beforeAll(async () => { app = await makeApp(); });
afterAll(async () => { await app.close(); await pool.end(); });
beforeEach(async () => {
  await resetDb();
  await pool.query(`INSERT INTO settings(key, value) VALUES ('pricing.serviceFeeBp', '0')`); // whole numbers: easier to read
  staff = await makeStaff(app);
});

const post = (url: string, headers: any, payload?: unknown) => app.inject({ method: 'POST', url, headers, payload: payload as any });
const get = (url: string, headers: any = {}) => app.inject({ method: 'GET', url, headers });
/** An offer as the dashboard's Offers form sends it. */
const createOffer = async (o: Record<string, unknown>) => {
  const r = await post('/api/admin/offers', staff.h, {
    title: 'Offer', discountType: 'percent', discountValue: 10, active: true, autoApply: false, minVehicles: 1, minBookingPence: 0,
    appliesTo: 'rental', priority: 0, stackable: false, ...o,
  });
  expect(r.statusCode, r.body).toBe(201);
  return r.json();
};
const usage = async (id: string) => (await get('/api/admin/offers', staff.h)).json().items.find((o: any) => o.id === id);

describe('offers from the dashboard to a finished booking', () => {
  it('a promo code typed in the app discounts the booking, is saved on it, counted, and shown on its statement', async () => {
    const v = await makeVehicle(); // £200/h: 2 hours = £400
    const code = await createOffer({ title: 'Spring 25%', code: 'spring25', discountValue: 25 });
    expect(code.code).toBe('SPRING25'); // stored upper case

    // The app shows the promotion, never the code itself.
    const listed = (await get('/api/public/offers')).json().items.find((o: any) => o.id === code.id);
    expect(listed).toMatchObject({ title: 'Spring 25%', requiresCode: true, automatic: false });
    expect(JSON.stringify(listed)).not.toContain('SPRING25');

    // Checkout quote, then the booking, as the app sends them (codes are not case sensitive).
    const quote = (await post('/api/public/quote', {}, { ...bookingPayload(v.id), offerCode: 'Spring25' })).json();
    expect(quote.pricing).toMatchObject({ subtotalPence: 40000, discountPence: 10000, totalPence: 30000 });
    const c = await makeCustomer(app);
    const b = await post('/api/me/bookings', { ...c.h, 'idempotency-key': 'k1' }, { ...bookingPayload(v.id), offerCode: 'spring25' });
    expect(b.statusCode, b.body).toBe(201);
    expect(b.json()).toMatchObject({ status: 'awaiting_payment', totalPence: 30000, depositDuePence: 30000 }); // they pay the discounted price

    // Staff see it on the booking, the offer's usage, and the printed statement.
    const detail = (await get(`/api/admin/bookings/${b.json().id}`, staff.h)).json();
    expect(detail.order.offers).toEqual([expect.objectContaining({ title: 'Spring 25%', code: 'SPRING25', discountPence: 10000 })]);
    expect(detail.finance).toMatchObject({ finalTotalPence: 30000, balanceDuePence: 30000 });
    expect(await usage(code.id)).toMatchObject({ uses: 1, discountGivenPence: 10000 });
    const statement = (await get(`/api/admin/bookings/${b.json().id}/statement`, staff.h)).body;
    expect(statement).toContain('Spring 25%');
    expect(statement).toMatch(/-£100\.00|−£100\.00|\(£100\.00\)/);
  });

  it('an automatic offer applies with no code, in the app and on bookings staff create in the dashboard', async () => {
    const v = await makeVehicle();
    const auto = await createOffer({ title: 'Launch week £50 off', autoApply: true, discountType: 'fixed', discountValue: 5000 });
    expect(auto.code).toBeNull();
    const c = await makeCustomer(app);
    const mine = (await post('/api/me/bookings', c.h, bookingPayload(v.id))).json();
    expect(mine.totalPence).toBe(35000);
    // The dashboard's New booking form no longer has a code box: automatic offers still apply.
    const cust = (await pool.query('SELECT id FROM customers LIMIT 1')).rows[0];
    const other = await makeVehicle();
    const adminOrder = await post('/api/admin/orders', staff.h, { customerId: cust.id, items: [bookingPayload(other.id)] });
    expect(adminOrder.statusCode, adminOrder.body).toBe(201);
    expect(adminOrder.json()).toMatchObject({ discountPence: 5000 });
    expect(await usage(auto.id)).toMatchObject({ uses: 2, discountGivenPence: 10000 });
  });

  it('enforces usage limits, per-customer limits, minimum spend, dates, car and event restrictions', async () => {
    const v = await makeVehicle();
    const cheap = await makeVehicle({ price_per_hour_pence: 1000 });
    const birthdays = await makeEvent(v.id, 'Birthdays');
    const a = await makeCustomer(app, 'a@test.com');
    const b = await makeCustomer(app, 'b@test.com');
    const c = await makeCustomer(app, 'c@test.com');
    const book = (who: any, over: Record<string, unknown> = {}, vehicleId = v.id) => post('/api/me/bookings', who.h, { ...bookingPayload(vehicleId, over), ...over });
    const err = async (r: Promise<any>) => (await r).json().error?.message;

    await createOffer({ title: 'Once each', code: 'ONCE', perCustomerLimit: 1, usageLimit: 2 });
    expect((await book(a, { offerCode: 'ONCE' })).statusCode).toBe(201);
    expect(await err(book(a, { offerCode: 'ONCE', time: '14:00' }))).toBe('You have already used this offer');
    expect((await book(b, { offerCode: 'ONCE', time: '16:00' })).statusCode).toBe(201);
    expect(await err(book(c, { offerCode: 'ONCE', time: '14:00' }, cheap.id))).toBe('That offer has been fully redeemed');

    await createOffer({ title: 'Big spenders', code: 'BIG', minBookingPence: 50000 });
    expect(await err(post('/api/public/quote', {}, { ...bookingPayload(cheap.id), offerCode: 'BIG' }))).toMatch(/at least|minimum|£500/i);

    await createOffer({ title: 'Birthdays only', code: 'BDAY', eventTypeIds: [birthdays.id], vehicleIds: [v.id] });
    expect(await err(post('/api/public/quote', {}, { ...bookingPayload(v.id), offerCode: 'BDAY' }))).toBeTruthy(); // no event chosen
    expect((await post('/api/public/quote', {}, { ...bookingPayload(v.id, { eventTypeId: birthdays.id }), offerCode: 'BDAY' })).json().pricing.discountPence).toBe(4000);

    const old = await createOffer({ title: 'Gone', code: 'GONE' });
    await app.inject({ method: 'PATCH', url: `/api/admin/offers/${old.id}`, headers: staff.h, payload: { active: false } });
    expect(await err(post('/api/public/quote', {}, { ...bookingPayload(v.id), offerCode: 'GONE' }))).toBe('That code is not valid');
    await createOffer({ title: 'Expired', code: 'OLD', startsAt: '2020-01-01T00:00:00Z', endsAt: '2020-02-01T00:00:00Z' });
    expect(await err(post('/api/public/quote', {}, { ...bookingPayload(v.id), offerCode: 'OLD' }))).toBe('That offer has expired');
    expect(await err(post('/api/public/quote', {}, { ...bookingPayload(v.id), offerCode: 'NOSUCH' }))).toBe('That code is not valid');
  });

  it('cancelling an unpaid booking gives the use back; editing an offer never changes bookings already made', async () => {
    const v = await makeVehicle();
    const offer = await createOffer({ title: 'One only', code: 'SOLO', usageLimit: 1, discountValue: 20 });
    const c = await makeCustomer(app);
    const first = (await post('/api/me/bookings', c.h, { ...bookingPayload(v.id), offerCode: 'SOLO' })).json();
    expect(first.totalPence).toBe(32000);
    expect(await usage(offer.id)).toMatchObject({ uses: 1 });

    await app.inject({ method: 'PATCH', url: `/api/admin/offers/${offer.id}`, headers: staff.h, payload: { discountValue: 50 } });
    expect((await get(`/api/admin/bookings/${first.id}`, staff.h)).json().finance.finalTotalPence).toBe(32000); // unchanged

    expect((await post(`/api/me/bookings/${first.id}/cancel`, c.h, {})).json().status).toBe('cancelled');
    expect(await usage(offer.id)).toMatchObject({ uses: 0 });
    const again = await post('/api/me/bookings', c.h, { ...bookingPayload(v.id, { time: '14:00' }), offerCode: 'SOLO' });
    expect(again.statusCode, again.body).toBe(201);
    expect(again.json().totalPence).toBe(20000); // the edited offer (50%) applies to new bookings
  });
});
