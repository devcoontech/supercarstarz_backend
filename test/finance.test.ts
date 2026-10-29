import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import Stripe from 'stripe';
import { pool } from '../src/db.js';
import { setSecret } from '../src/settings.js';
import { app as makeApp, bookingPayload, day, makeCustomer, makeStaff, makeVehicle, resetDb } from './helpers.js';

/*
 * Acceptance scenarios for driver and collection options, the one-hour buffer, today-onward dates, add-ons,
 * manual and online payments, deposits, delivery charges, receipts and reconciliation.
 */

let app: FastifyInstance;
beforeAll(async () => { app = await makeApp(); });
afterAll(async () => { await app.close(); await pool.end(); });
beforeEach(resetDb);

const post = (url: string, headers: any, payload?: unknown) => app.inject({ method: 'POST', url, headers, payload: payload as any });
const get = (url: string, headers: any = {}) => app.inject({ method: 'GET', url, headers });
const setting = (key: string, value: unknown) =>
  pool.query(`INSERT INTO settings(key, value) VALUES ($1,$2) ON CONFLICT (key) DO UPDATE SET value=$2`, [key, JSON.stringify(value)]);
const docs = async (bookingId: string) => (await pool.query('SELECT * FROM invoices WHERE booking_id=$1 ORDER BY issued_at, number', [bookingId])).rows;

const whsec = 'whsec_financetest123';
const hook = (event: object) => {
  const payload = JSON.stringify(event);
  return app.inject({ method: 'POST', url: '/api/webhooks/stripe', headers: { 'content-type': 'application/json', 'stripe-signature': Stripe.webhooks.generateTestHeaderString({ payload, secret: whsec }) }, payload });
};
const succeeded = (eventId: string, pi: string, amount: number) => ({ id: eventId, object: 'event', type: 'payment_intent.succeeded', data: { object: { id: pi, object: 'payment_intent', amount_received: amount, currency: 'gbp' } } });
/** Stands in for the PaymentIntent the server creates through Stripe (not reachable in tests). */
const openIntent = (bookingId: string, customerId: string, amount: number, pi: string, purpose = 'payment') =>
  pool.query(`INSERT INTO payments(booking_id, customer_id, amount_pence, method, source, purpose, status, provider_ref) VALUES ($1,$2,$3,'card','stripe',$4,'pending',$5)`, [bookingId, customerId, amount, purpose, pi]);

/** The worked example from the brief: £100/hour for 2 hours, 50% deposit, no service fee, delivery at £2.70/km. */
async function exampleSetup() {
  await setSecret('stripe.webhookSecret', whsec);
  await setting('pricing.serviceFeeBp', 0);
  await setting('payment.mode', 'deposit');
  await setting('payment.depositPercentBp', 5000);
  await setting('booking.requireApproval', false);
  const v = await makeVehicle({ price_per_hour_pence: 10000, delivery_fee_pence: 0 });
  const c = await makeCustomer(app);
  const staff = await makeStaff(app);
  const bk = (await post('/api/me/bookings', c.h, bookingPayload(v.id, { experience: 'delivered', address: '1 Party Lane, London', driverOption: 'self_drive' }))).json();
  return { v, c, staff, bk };
}

describe('admin booking form', () => {
  it('creates a booking without the internal note, ignoring one sent by an older client', async () => {
    const staff = await makeStaff(app);
    const v = await makeVehicle();
    const c = await makeCustomer(app);
    const r = await post('/api/admin/bookings', staff.h, { ...bookingPayload(v.id), customerId: c.id, adminNotes: 'internal safety note' });
    expect(r.statusCode, r.body).toBe(201);
    expect((await pool.query('SELECT admin_notes, source FROM bookings WHERE id=$1', [r.json().id])).rows[0]).toEqual({ admin_notes: null, source: 'admin' });
    const mine = (await get(`/api/me/bookings/${r.json().id}`, c.h)).json();
    expect(mine).not.toHaveProperty('adminNotes');
    expect(JSON.stringify(mine)).not.toContain('internal safety note');
    const staffView = await get(`/api/admin/bookings/${r.json().id}`, staff.h);
    expect(staffView.json()).not.toHaveProperty('adminNotes');
    expect((await app.inject({ method: 'PATCH', url: `/api/admin/bookings/${r.json().id}/notes`, headers: staff.h, payload: { adminNotes: 'x' } })).statusCode).toBe(404);
  });

  it('finds existing customers by name, email or phone in any format, and never creates a duplicate', async () => {
    const staff = await makeStaff(app);
    const created = (await post('/api/admin/customers', staff.h, { name: 'Jane Smith', email: 'jane.smith@test.com', phone: '07700 900123' })).json().customer;
    await post('/api/admin/customers', staff.h, { name: 'Jane Smithers', email: 'js2@test.com', phone: '07111 222333' });
    for (const q of ['Jane Smith', 'jane.smith@', '07700900123', '+44 7700 900123', '+44 7700 900', '900123']) {
      const items = (await get(`/api/admin/customers?q=${encodeURIComponent(q)}`, staff.h)).json().items;
      expect(items.map((i: any) => i.id), q).toContain(created.id);
    }
    expect((await get(`/api/admin/customers?q=07111`, staff.h)).json().items.map((i: any) => i.email)).toEqual(['js2@test.com']);
    const dup = await post('/api/admin/customers', staff.h, { name: 'J Smith', email: 'JANE.SMITH@test.com' });
    expect(dup.statusCode).toBe(409);
    expect(dup.json().error).toMatchObject({ code: 'email_taken', details: { customer: { id: created.id } } });
    expect((await pool.query('SELECT count(*)::int n FROM customers')).rows[0].n).toBe(2);
  });
});

describe('driver and collection options', () => {
  it('saves the driver option and shows it to staff and the customer', async () => {
    const v = await makeVehicle();
    const c = await makeCustomer(app);
    const staff = await makeStaff(app);
    const bk = await post('/api/me/bookings', c.h, bookingPayload(v.id, { driverOption: 'with_driver' }));
    expect(bk.statusCode, bk.body).toBe(201);
    expect(bk.json()).toMatchObject({ driverOption: 'with_driver', chauffeur: true, collectionMethod: 'showroom' });
    expect(bk.json().pricing.lines.find((l: any) => l.key === 'chauffeur').amountPence).toBe(10000);
    expect((await get(`/api/admin/bookings/${bk.json().id}`, staff.h)).json().driverOption).toBe('with_driver');

    const selfDriveOnly = await makeVehicle({ chauffeur_available: false });
    const driverOnly = await makeVehicle({ self_drive_available: false });
    expect((await post('/api/me/bookings', c.h, bookingPayload(selfDriveOnly.id, { driverOption: 'with_driver' }))).json().error.code).toBe('driver_option_unavailable');
    expect((await post('/api/me/bookings', c.h, bookingPayload(driverOnly.id, { driverOption: 'self_drive' }))).json().error.code).toBe('driver_option_unavailable');
    const ok = await post('/api/me/bookings', c.h, bookingPayload(driverOnly.id, { driverOption: 'with_driver' }));
    expect(ok.json().driverOption).toBe('with_driver');
  });

  it('stores the delivery address, leaves delivery for staff to price, and charges nothing for it yet', async () => {
    const v = await makeVehicle();
    const c = await makeCustomer(app);
    const q = (await post('/api/public/quote', {}, bookingPayload(v.id, { experience: 'delivered', address: '1 Party Lane, London' }))).json();
    expect(q.pricing.deliveryEstimate).toMatchObject({ amountPence: null });
    expect(q.pricing.totalPence).toBe(42000);
    const bk = (await post('/api/me/bookings', c.h, bookingPayload(v.id, { experience: 'delivered', address: '1 Party Lane, London' }))).json();
    expect(bk).toMatchObject({ collectionMethod: 'delivery', address: '1 Party Lane, London', totalPence: 42000 });
    expect(bk.finance).toMatchObject({ delivery: { status: 'pending', amountPence: 0 }, finalTotalPence: 42000, balanceDuePence: 42000 });
    const showroom = (await post('/api/me/bookings', c.h, bookingPayload(v.id, { date: day(11) }))).json();
    expect(showroom.finance.delivery).toBeNull();
    expect((await pool.query(`SELECT count(*)::int n FROM booking_charges WHERE booking_id=$1`, [showroom.id])).rows[0].n).toBe(0);
  });
});

describe('one-hour preparation buffer', () => {
  it('blocks an hour before and after each booking, for customers and staff alike', async () => {
    const v = await makeVehicle({ max_hours: 4 });
    const c = await makeCustomer(app);
    const staff = await makeStaff(app);
    expect((await post('/api/me/bookings', c.h, bookingPayload(v.id, { time: '13:00', hours: 2 }))).statusCode).toBe(201); // 13:00-15:00
    const admin = await post('/api/admin/bookings', staff.h, { ...bookingPayload(v.id, { time: '15:00', hours: 1 }), customerId: c.id });
    expect(admin.statusCode).toBe(409); // starts inside the 15:00-16:00 buffer
    expect(admin.json().error.message).toMatch(/1 hour free before and after/);
    expect((await post('/api/me/bookings', c.h, bookingPayload(v.id, { time: '12:00', hours: 1 }))).statusCode).toBe(409); // ends inside 12:00-13:00
    expect((await post('/api/me/bookings', c.h, bookingPayload(v.id, { time: '16:00', hours: 1 }))).statusCode).toBe(201);
    expect((await post('/api/me/bookings', c.h, bookingPayload(v.id, { time: '11:00', hours: 1 }))).statusCode).toBe(201);
  });

  it('only offers start times that respect the buffer, and the quote agrees', async () => {
    const v = await makeVehicle();
    const c = await makeCustomer(app);
    await post('/api/me/bookings', c.h, bookingPayload(v.id, { time: '13:00', hours: 2 }));
    const slots = (await get(`/api/public/vehicles/${v.id}/availability?date=${day()}`)).json().slots;
    const at = Object.fromEntries(slots.map((s: any) => [s.time, s.maxHours]));
    expect(at['10:00']).toBe(2); // must end by 12:00
    expect(at['11:00']).toBe(1);
    for (const t of ['12:00', '13:00', '14:00', '15:00']) expect(at[t], t).toBeUndefined();
    expect(at['16:00']).toBe(3);
    const q = (await post('/api/public/quote', {}, bookingPayload(v.id, { time: '15:00', hours: 1 }))).json();
    expect(q.available).toBe(false);
    expect(q.unavailableReason).toMatch(/too close/);
  });

  it('the database refuses a booking inside the buffer even when the API is bypassed', async () => {
    const v = await makeVehicle();
    const c = await makeCustomer(app);
    const first = (await post('/api/me/bookings', c.h, bookingPayload(v.id, { time: '13:00', hours: 2 }))).json();
    const row = (await pool.query('SELECT * FROM bookings WHERE id=$1', [first.id])).rows[0];
    const start = new Date(row.end_at.getTime() + 30 * 60_000);
    const end = new Date(start.getTime() + 3600_000);
    await expect(pool.query(
      `INSERT INTO bookings(customer_id,vehicle_id,status,start_at,end_at,hours,blocked_during,experience,pricing_snapshot,total_pence)
       VALUES ($1,$2,'confirmed',$3,$4,1,tstzrange($3,$4),'stationary','{}',0)`, [row.customer_id, row.vehicle_id, start, end]),
    ).rejects.toMatchObject({ code: '23P01' });
  });

  it('lets only one of two concurrent bookings inside each other\'s buffer through, and cancelling releases the buffer', async () => {
    const v = await makeVehicle();
    const a = await makeCustomer(app, 'a@test.com');
    const b = await makeCustomer(app, 'b@test.com');
    const [r1, r2] = await Promise.all([
      post('/api/me/bookings', a.h, bookingPayload(v.id, { time: '13:00', hours: 1 })),
      post('/api/me/bookings', b.h, bookingPayload(v.id, { time: '14:00', hours: 1 })),
    ]);
    expect([r1.statusCode, r2.statusCode].sort()).toEqual([201, 409]);
    const winner = r1.statusCode === 201 ? { r: r1, c: a } : { r: r2, c: b };
    const loserTime = r1.statusCode === 201 ? '14:00' : '13:00';
    expect((await post(`/api/me/bookings/${winner.r.json().id}/cancel`, winner.c.h, {})).json().status).toBe('cancelled');
    expect((await post('/api/me/bookings', a.h, bookingPayload(v.id, { time: loserTime, hours: 1 }))).statusCode).toBe(201);
  });
});

describe('booking dates', () => {
  it('rejects past dates for customers and staff, including on reschedule, and dates beyond the advance limit', async () => {
    const v = await makeVehicle();
    const c = await makeCustomer(app);
    const staff = await makeStaff(app);
    const yesterday = day(-1);
    expect((await post('/api/me/bookings', c.h, bookingPayload(v.id, { date: yesterday }))).json().error.code).toBe('past_date');
    expect((await post('/api/public/quote', {}, bookingPayload(v.id, { date: yesterday }))).json().error.code).toBe('past_date');
    expect((await post('/api/admin/bookings', staff.h, { ...bookingPayload(v.id, { date: yesterday }), customerId: c.id })).json().error.code).toBe('past_date');
    const bk = (await post('/api/admin/bookings', staff.h, { ...bookingPayload(v.id), customerId: c.id })).json();
    expect((await post(`/api/admin/bookings/${bk.id}/reschedule`, staff.h, { date: yesterday, time: '11:00' })).json().error.code).toBe('past_date');
    expect((await post('/api/me/bookings', c.h, bookingPayload(v.id, { date: day(400) }))).json().error.code).toBe('too_far_ahead');
    await setting('booking.maxAdvanceDays', 500);
    expect((await post('/api/me/bookings', c.h, bookingPayload(v.id, { date: day(400) }))).statusCode).toBe(201);
    const days = (await get(`/api/public/vehicles/${v.id}/availability?date=${day(-2)}&days=2`)).json().days;
    expect(days.every((d: any) => d.slots.length === 0)).toBe(true);
  });
});

describe('add-on management', () => {
  it('assigns add-ons to chosen cars, offers them only there, and lets staff switch them off', async () => {
    const staff = await makeStaff(app);
    const v1 = await makeVehicle();
    const v2 = await makeVehicle();
    const c = await makeCustomer(app);
    const a = (await post('/api/admin/addons', staff.h, { name: 'Wedding decoration', pricePence: 5000, pricingType: 'per_unit', maxQuantity: 2, vehicleIds: [v1.id] })).json();
    expect(a).toMatchObject({ name: 'Wedding decoration', vehicleIds: [v1.id], allVehicles: false });
    const offered = async (vid: string) => (await get(`/api/public/addons?vehicleId=${vid}`)).json().items.map((x: any) => x.id);
    expect(await offered(v1.id)).toEqual([a.id]);
    expect(await offered(v2.id)).toEqual([]);
    expect((await post('/api/me/bookings', c.h, bookingPayload(v2.id, { addons: [{ id: a.id, quantity: 1 }] }))).json().error.code).toBe('invalid_addon');
    await app.inject({ method: 'PUT', url: `/api/admin/vehicles/${v2.id}/addons`, headers: staff.h, payload: { addonIds: [a.id] } });
    expect(await offered(v2.id)).toEqual([a.id]);
    expect((await get(`/api/admin/vehicles/${v2.id}`, staff.h)).json().addon_ids).toEqual([a.id]);
    await app.inject({ method: 'PATCH', url: `/api/admin/addons/${a.id}`, headers: staff.h, payload: { active: false } });
    expect(await offered(v1.id)).toEqual([]);
  });

  it('includes the agreed add-on price in the total and keeps it when the price changes later', async () => {
    const staff = await makeStaff(app);
    const v = await makeVehicle();
    const c = await makeCustomer(app);
    const a = (await post('/api/admin/addons', staff.h, { name: 'Photographer', pricePence: 5000, pricingType: 'per_unit', maxQuantity: 2, allVehicles: true })).json();
    expect((await post('/api/me/bookings', c.h, bookingPayload(v.id, { addons: [{ id: a.id, quantity: 3 }] }))).json().error.code).toBe('invalid_addon_quantity');
    const bk = (await post('/api/me/bookings', c.h, bookingPayload(v.id, { addons: [{ id: a.id, quantity: 2 }] }))).json();
    expect(bk.pricing.lines.find((l: any) => l.key === `addon:${a.id}`)).toMatchObject({ amountPence: 10000, label: 'Photographer × 2' });
    expect(bk.totalPence).toBe(Math.round((40000 + 10000) * 1.05));
    await app.inject({ method: 'PATCH', url: `/api/admin/addons/${a.id}`, headers: staff.h, payload: { pricePence: 9999 } });
    const detail = (await get(`/api/me/bookings/${bk.id}`, c.h)).json();
    expect(detail.addons).toEqual([expect.objectContaining({ name: 'Photographer', unitPricePence: 5000, quantity: 2, totalPence: 10000 })]);
    expect(detail.totalPence).toBe(bk.totalPence);
  });
});

describe('manual payments', () => {
  it('records a cash payment against the booking with history, balance, staff name and a receipt', async () => {
    const v = await makeVehicle();
    const c = await makeCustomer(app);
    const staff = await makeStaff(app);
    const bk = (await post('/api/me/bookings', c.h, bookingPayload(v.id))).json(); // 42000
    const paidAt = new Date(Date.now() - 3600_000).toISOString();
    const r = await post(`/api/admin/bookings/${bk.id}/payments/manual`, staff.h, { amountPence: 20000, method: 'cash', reference: 'Till 4', paidAt, note: 'Paid at the counter' });
    expect(r.statusCode, r.body).toBe(201);
    const d = (await get(`/api/admin/bookings/${bk.id}`, staff.h)).json();
    expect(d.finance).toMatchObject({ paidPence: 20000, balanceDuePence: 22000, finalTotalPence: 42000 });
    expect(d.payments[0]).toMatchObject({ method: 'cash', source: 'manual', verified: false, recordedBy: 'Test Owner', manualReference: 'Till 4', note: 'Paid at the counter' });
    expect(new Date(d.payments[0].paidAt).toISOString()).toBe(paidAt);
    expect(d.events.map((e: any) => e.action)).toContain('manual_payment_recorded');
    const [rcpt] = await docs(bk.id);
    expect(rcpt).toMatchObject({ kind: 'payment_receipt', amount_pence: 20000, booking_total_pence: 42000, paid_to_date_pence: 20000, balance_pence: 22000 });
    const html = (await get(`/api/admin/invoices/${rcpt.id}/document`, staff.h)).body;
    expect(html).toContain('Cash (recorded by staff)');
    expect(html).toContain('It is not a receipt for the full booking');
    expect(html).not.toContain('Paid at the counter'); // staff notes stay internal
    // The customer sees the money but not the staff note.
    const mine = (await get(`/api/me/bookings/${bk.id}`, c.h)).json();
    expect(mine.finance.balanceDuePence).toBe(22000);
    expect(JSON.stringify(mine)).not.toContain('Paid at the counter');
  });

  it('labels a manually recorded card payment as staff-recorded, never as a verified gateway payment', async () => {
    const v = await makeVehicle();
    const c = await makeCustomer(app);
    const staff = await makeStaff(app);
    const bk = (await post('/api/me/bookings', c.h, bookingPayload(v.id))).json();
    await post(`/api/admin/bookings/${bk.id}/payments/manual`, staff.h, { amountPence: 42000, method: 'card_terminal' });
    const [p] = (await get(`/api/admin/bookings/${bk.id}`, staff.h)).json().payments;
    expect(p).toMatchObject({ source: 'manual', verified: false });
    const [rcpt] = await docs(bk.id);
    expect(rcpt.kind).toBe('full_payment_receipt');
    const html = (await get(`/api/admin/invoices/${rcpt.id}/document`, staff.h)).body;
    expect(html).toContain('Card (recorded by staff)');
    expect(html).not.toContain('verified by the payment provider');
  });

  it('in full-payment mode a part payment is never called a deposit, even after a delivery charge raises the total', async () => {
    const v = await makeVehicle();
    const c = await makeCustomer(app);
    const staff = await makeStaff(app);
    const bk = (await post('/api/me/bookings', c.h, bookingPayload(v.id, { experience: 'delivered', address: '1 Party Lane' }))).json(); // 42000, deposit = full
    await post(`/api/admin/bookings/${bk.id}/delivery-charge`, staff.h, { distanceMiles: 20, ratePerMilePence: 270, finalPence: 5400 });
    await post(`/api/admin/bookings/${bk.id}/payments/manual`, staff.h, { amountPence: 20000, method: 'cash' });
    expect((await docs(bk.id)).map((d) => d.kind)).toEqual(['adjustment_note', 'payment_receipt']);
    await post(`/api/admin/bookings/${bk.id}/payments/manual`, staff.h, { amountPence: 22000, method: 'cash' }); // the quoted price is now paid
    expect((await get(`/api/admin/bookings/${bk.id}`, staff.h)).json()).toMatchObject({ paymentStatus: 'partially_paid', finance: { balanceDuePence: 5400, depositMode: false } });
  });

  it('records a double-submitted payment once, counts a pending one only when received, and refuses other roles', async () => {
    const v = await makeVehicle();
    const c = await makeCustomer(app);
    const staff = await makeStaff(app);
    const bk = (await post('/api/me/bookings', c.h, bookingPayload(v.id))).json();
    const h = { ...staff.h, 'idempotency-key': 'pay-1' };
    const [x, y] = [await post(`/api/admin/bookings/${bk.id}/payments/manual`, h, { amountPence: 1000, method: 'cash' }), await post(`/api/admin/bookings/${bk.id}/payments/manual`, h, { amountPence: 1000, method: 'cash' })];
    expect(y.json().id).toBe(x.json().id);
    const pending = (await post(`/api/admin/bookings/${bk.id}/payments/manual`, staff.h, { amountPence: 5000, method: 'bank_transfer', status: 'pending' })).json();
    expect((await get(`/api/admin/bookings/${bk.id}`, staff.h)).json().finance.paidPence).toBe(1000);
    expect((await docs(bk.id)).length).toBe(1);
    expect((await post(`/api/admin/payments/${pending.id}/status`, staff.h, { status: 'succeeded' })).statusCode).toBe(200);
    expect((await get(`/api/admin/bookings/${bk.id}`, staff.h)).json().finance.paidPence).toBe(6000);
    expect((await docs(bk.id)).length).toBe(2);

    const manager = await makeStaff(app, 'booking_manager', 'bm@test.com');
    expect((await post(`/api/admin/bookings/${bk.id}/payments/manual`, manager.h, { amountPence: 1000, method: 'cash' })).statusCode).toBe(403);
  });
});

describe('deposits, delivery charges and balances (the worked example)', () => {
  it('customer pays the deposit online: verified by webhook, deposit receipt shows £100 paid and £100 to go', async () => {
    const { c, bk } = await exampleSetup();
    expect(bk).toMatchObject({ status: 'awaiting_payment', totalPence: 20000, depositDuePence: 10000 });
    expect(bk.finance).toMatchObject({ dueNowPence: 10000, balanceDuePence: 20000, depositMode: true });
    await openIntent(bk.id, c.id, 10000, 'pi_dep', 'deposit');
    // Returning to the app proves nothing: the booking is untouched until the signed webhook arrives.
    expect((await get(`/api/me/bookings/${bk.id}`, c.h)).json().paidPence).toBe(0);
    expect((await hook(succeeded('evt_dep', 'pi_dep', 10000))).json()).toMatchObject({ handled: true });
    const after = (await get(`/api/me/bookings/${bk.id}`, c.h)).json();
    expect(after).toMatchObject({ status: 'confirmed', paymentStatus: 'deposit_paid', paidPence: 10000 });
    expect(after.finance).toMatchObject({ depositPaid: true, balanceDuePence: 10000, dueNowPence: 0 });
    expect(after.invoices).toHaveLength(1);
    expect(after.invoices[0]).toMatchObject({ kind: 'deposit_receipt', amountPence: 10000, bookingTotalPence: 20000, paidToDatePence: 10000, balancePence: 10000 });
    const html = (await get(`/api/me/invoices/${after.invoices[0].id}/document`, c.h)).body;
    expect(html).toContain('Deposit receipt');
    expect(html).toContain('verified by the payment provider');
    expect(html).not.toContain('paid in full');
  });

  it('a repeated webhook records no second payment and no second receipt', async () => {
    const { c, bk } = await exampleSetup();
    await openIntent(bk.id, c.id, 10000, 'pi_dep', 'deposit');
    await hook(succeeded('evt_1', 'pi_dep', 10000));
    expect((await hook(succeeded('evt_1', 'pi_dep', 10000))).json()).toMatchObject({ duplicate: true });
    await hook(succeeded('evt_2', 'pi_dep', 10000)); // Stripe can also send a second event for the same intent
    expect((await pool.query(`SELECT count(*)::int n, sum(amount_pence)::int s FROM payments WHERE booking_id=$1 AND status='succeeded'`, [bk.id])).rows[0]).toEqual({ n: 1, s: 10000 });
    expect(await docs(bk.id)).toHaveLength(1);
    expect((await pool.query('SELECT paid_pence FROM bookings WHERE id=$1', [bk.id])).rows[0].paid_pence).toBe(10000);
  });

  it('admin confirms the £54 delivery charge: total £254, balance £154, never added twice', async () => {
    const { c, staff, bk } = await exampleSetup();
    await openIntent(bk.id, c.id, 10000, 'pi_dep', 'deposit');
    await hook(succeeded('evt_dep', 'pi_dep', 10000));

    const confirm = (body: object) => post(`/api/admin/bookings/${bk.id}/delivery-charge`, staff.h, { distanceMiles: 20, ratePerMilePence: 270, finalPence: 5400, ...body });
    const r = await confirm({});
    expect(r.statusCode, r.body).toBe(200);
    expect(r.json().finance).toMatchObject({ finalTotalPence: 25400, netPaidPence: 10000, balanceDuePence: 15400, delivery: { status: 'confirmed', amountPence: 5400 } });
    const charge = r.json().charges.find((x: any) => x.status === 'confirmed');
    expect(charge).toMatchObject({ distanceMiles: 20, ratePerMilePence: 270, calculatedPence: 5400, approvedBy: 'Test Owner' });
    await confirm({}); // sent twice: nothing changes
    expect((await pool.query(`SELECT count(*)::int n FROM booking_charges WHERE booking_id=$1 AND status='confirmed'`, [bk.id])).rows[0].n).toBe(1);
    expect((await pool.query('SELECT total_pence FROM bookings WHERE id=$1', [bk.id])).rows[0].total_pence).toBe(25400);

    // Amending replaces the charge (25 km = £67.50): the total rises by the difference only.
    const amended = await confirm({ distanceMiles: 25, finalPence: 6750, reason: 'Customer moved the venue' });
    expect(amended.json().finance).toMatchObject({ finalTotalPence: 26750, balanceDuePence: 16750 });
    expect((await pool.query(`SELECT count(*)::int n FROM booking_charges WHERE booking_id=$1 AND kind='delivery' AND status<>'void'`, [bk.id])).rows[0].n).toBe(1);
    const notes = (await docs(bk.id)).filter((d) => d.kind === 'adjustment_note');
    expect(notes.map((n) => n.amount_pence)).toEqual([5400, 1350]);
    // Back to 20 km: a credit of the difference.
    const back = await confirm({});
    expect(back.json().finance.finalTotalPence).toBe(25400);
    expect((await docs(bk.id)).filter((d) => d.kind === 'credit_note').map((n) => n.amount_pence)).toEqual([-1350]);

    const history = (await get(`/api/admin/bookings/${bk.id}`, staff.h)).json().events.map((e: any) => e.action);
    expect(history).toEqual(expect.arrayContaining(['delivery_charge_confirmed', 'delivery_charge_amended', 'total_changed']));
    const mine = (await get(`/api/me/bookings/${bk.id}`, c.h)).json();
    expect(mine.finance).toMatchObject({ finalTotalPence: 25400, balanceDuePence: 15400 });
    expect((await get('/api/me/notifications', c.h)).json().items.map((n: any) => n.kind)).toContain('charge_confirmed');
  });

  it('customer pays the £154 balance online: final receipt, paid in full, and the statement reconciles', async () => {
    const { c, staff, bk } = await exampleSetup();
    await openIntent(bk.id, c.id, 10000, 'pi_dep', 'deposit');
    await hook(succeeded('evt_dep', 'pi_dep', 10000));
    await post(`/api/admin/bookings/${bk.id}/delivery-charge`, staff.h, { distanceMiles: 20, ratePerMilePence: 270, finalPence: 5400 });
    expect((await get(`/api/me/bookings/${bk.id}`, c.h)).json().finance.balanceDuePence).toBe(15400);
    await openIntent(bk.id, c.id, 15400, 'pi_bal', 'balance');
    await hook(succeeded('evt_bal', 'pi_bal', 15400));
    const after = (await get(`/api/me/bookings/${bk.id}`, c.h)).json();
    expect(after).toMatchObject({ paymentStatus: 'paid', paidPence: 25400, totalPence: 25400 });
    expect(after.finance.balanceDuePence).toBe(0);
    const kinds = after.invoices.map((i: any) => [i.kind, i.amountPence, i.balancePence]);
    expect(kinds).toEqual(expect.arrayContaining([['deposit_receipt', 10000, 10000], ['adjustment_note', 5400, 15400], ['full_payment_receipt', 15400, 0]]));
    // Earlier receipts keep what they said when issued.
    expect(after.invoices.find((i: any) => i.kind === 'deposit_receipt')).toMatchObject({ bookingTotalPence: 20000, balancePence: 10000 });
    const statement = (await get(`/api/me/bookings/${bk.id}/statement`, c.h)).body;
    expect(statement).toContain('£254.00');
    expect(statement).toContain('Outstanding balance');
    expect(statement).toMatch(/Outstanding balance<\/td><td class="num">£0\.00/);
    // Nothing more can be paid.
    expect((await post(`/api/admin/bookings/${bk.id}/payments/manual`, staff.h, { amountPence: 1, method: 'cash' })).json().error.code).toBe('overpayment');
  });

  it('takes a delivery charge staff work out by hand, emails it, and refuses delivery charges on showroom bookings', async () => {
    await setSecret('stripe.webhookSecret', whsec);
    const v = await makeVehicle({ delivery_fee_pence: 0 });
    const c = await makeCustomer(app);
    const staff = await makeStaff(app);
    const d = (await post('/api/me/bookings', c.h, bookingPayload(v.id, { experience: 'delivered', address: '2 Venue Road' }))).json();
    expect(d.finance.delivery).toMatchObject({ status: 'pending', amountPence: 0, ratePerMilePence: null });
    expect(d.finance.finalTotalPence).toBe(d.quotedTotalPence);
    // Only an amount: no distance or rate per mile.
    const added = await post(`/api/admin/bookings/${d.id}/delivery-charge`, staff.h, { distanceMiles: null, ratePerMilePence: 0, finalPence: 7500 });
    expect(added.statusCode, added.body).toBe(200);
    expect(added.json().finance).toMatchObject({ delivery: { status: 'confirmed', amountPence: 7500 }, finalTotalPence: d.quotedTotalPence + 7500 });
    expect((await pool.query(`SELECT kind FROM email_outbox WHERE booking_id=$1 AND kind='charge_confirmed'`, [d.id])).rowCount).toBe(1);
    const s = (await post('/api/me/bookings', c.h, bookingPayload(v.id, { date: day(12) }))).json();
    expect((await post(`/api/admin/bookings/${s.id}/delivery-charge`, staff.h, { distanceMiles: 5, ratePerMilePence: 270, finalPence: 1350 })).json().error.code).toBe('not_delivery');
    const manager = await makeStaff(app, 'booking_manager', 'bm@test.com');
    expect((await post(`/api/admin/bookings/${d.id}/delivery-charge`, manager.h, { distanceMiles: 5, ratePerMilePence: 270, finalPence: 1350 })).statusCode).toBe(403);
  });

  it('removing a confirmed delivery charge issues a credit note and lowers the balance', async () => {
    const { staff, bk } = await exampleSetup();
    const r = (await post(`/api/admin/bookings/${bk.id}/delivery-charge`, staff.h, { distanceMiles: 20, ratePerMilePence: 270, finalPence: 5400 })).json();
    const live = r.charges.find((x: any) => x.status === 'confirmed');
    const v = await post(`/api/admin/bookings/${bk.id}/charges/${live.id}/void`, staff.h, { reason: 'Customer will collect' });
    expect(v.json().finance).toMatchObject({ finalTotalPence: 20000, delivery: null });
    expect((await docs(bk.id)).map((x) => [x.kind, x.amount_pence])).toEqual([['adjustment_note', 5400], ['credit_note', -5400]]);
  });
});

describe('receipts, refunds and reconciliation', () => {
  it('customers can only open their own receipts and statements', async () => {
    const v = await makeVehicle();
    const a = await makeCustomer(app, 'a@test.com');
    const b = await makeCustomer(app, 'b@test.com');
    const staff = await makeStaff(app);
    const bk = (await post('/api/me/bookings', a.h, bookingPayload(v.id))).json();
    await post(`/api/admin/bookings/${bk.id}/payments/manual`, staff.h, { amountPence: 42000, method: 'cash' });
    const [rcpt] = (await get('/api/me/invoices', a.h)).json().items;
    expect(rcpt.kind).toBe('full_payment_receipt');
    const own = await get(`/api/me/invoices/${rcpt.id}/document`, a.h);
    expect(own.statusCode).toBe(200);
    expect(own.headers['content-type']).toContain('text/html');
    expect((await get(`/api/me/invoices/${rcpt.id}/document`, b.h)).statusCode).toBe(404);
    expect((await get(`/api/me/bookings/${bk.id}/statement`, b.h)).statusCode).toBe(404);
    expect((await get('/api/me/invoices', b.h)).json().items).toEqual([]);
    expect((await get(`/api/me/invoices/${rcpt.id}/document`)).statusCode).toBe(401);
    expect((await get(`/api/admin/invoices/${rcpt.id}/document`, a.h)).statusCode).toBe(403);
  });

  it('refunds update the status and amounts and issue a refund receipt; a failed first attempt shows as failed', async () => {
    await setSecret('stripe.webhookSecret', whsec);
    const v = await makeVehicle();
    const c = await makeCustomer(app);
    const staff = await makeStaff(app);
    const bk = (await post('/api/me/bookings', c.h, bookingPayload(v.id))).json();
    await openIntent(bk.id, c.id, 42000, 'pi_fail');
    await hook({ id: 'evt_f', object: 'event', type: 'payment_intent.payment_failed', data: { object: { id: 'pi_fail', object: 'payment_intent', last_payment_error: { message: 'declined' } } } });
    expect((await get(`/api/me/bookings/${bk.id}`, c.h)).json()).toMatchObject({ paymentStatus: 'payment_failed', paidPence: 0 });
    const pay = (await post(`/api/admin/bookings/${bk.id}/payments/manual`, staff.h, { amountPence: 42000, method: 'cash' })).json();
    await post(`/api/admin/payments/${pay.id}/refund`, staff.h, { amountPence: 5000, reason: 'Goodwill' });
    const d = (await get(`/api/admin/bookings/${bk.id}`, staff.h)).json();
    expect(d.paymentStatus).toBe('partially_refunded');
    expect(d.finance).toMatchObject({ paidPence: 42000, refundedPence: 5000, netPaidPence: 37000, balanceDuePence: 5000 });
    expect((await docs(bk.id)).map((x) => [x.kind, x.amount_pence])).toEqual([['full_payment_receipt', 42000], ['refund_receipt', -5000]]);
  });

  it('cancelling keeps every financial record and releases the car', async () => {
    const v = await makeVehicle();
    const c = await makeCustomer(app);
    const staff = await makeStaff(app);
    const bk = (await post('/api/me/bookings', c.h, bookingPayload(v.id))).json();
    await post(`/api/admin/bookings/${bk.id}/payments/manual`, staff.h, { amountPence: 10000, method: 'cash' });
    expect((await post(`/api/admin/bookings/${bk.id}/status`, staff.h, { to: 'cancelled', reason: 'Customer asked' })).statusCode).toBe(200);
    const d = (await get(`/api/admin/bookings/${bk.id}`, staff.h)).json();
    expect(d.payments).toHaveLength(1);
    expect(d.invoices).toHaveLength(1);
    expect(d.finance).toMatchObject({ paidPence: 10000, balanceDuePence: 0 });
    expect((await post('/api/me/bookings', c.h, bookingPayload(v.id))).statusCode).toBe(201);
  });

  it('never lets issued receipts or payment records be rewritten', async () => {
    const v = await makeVehicle();
    const c = await makeCustomer(app);
    const staff = await makeStaff(app);
    const bk = (await post('/api/me/bookings', c.h, bookingPayload(v.id))).json();
    const pay = (await post(`/api/admin/bookings/${bk.id}/payments/manual`, staff.h, { amountPence: 10000, method: 'cash' })).json();
    const [rcpt] = await docs(bk.id);
    await expect(pool.query('UPDATE invoices SET amount_pence=1 WHERE id=$1', [rcpt.id])).rejects.toThrow(/cannot be changed/);
    await expect(pool.query('DELETE FROM invoices WHERE id=$1', [rcpt.id])).rejects.toThrow(/cannot be changed/);
    await expect(pool.query('UPDATE payments SET amount_pence=1 WHERE id=$1', [pay.id])).rejects.toThrow(/cannot be rewritten/);
    await expect(pool.query(`UPDATE payments SET status='failed' WHERE id=$1`, [pay.id])).rejects.toThrow(/record a refund/);
    await expect(pool.query('DELETE FROM payments WHERE id=$1', [pay.id])).rejects.toThrow(/cannot be deleted/);
  });
});
