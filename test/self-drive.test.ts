import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { DateTime } from 'luxon';
import { pool } from '../src/core/db.js';
import { app as makeApp, bookingPayload, makeCustomer, makeStaff, makeVehicle, requireSelfDriveDetails, resetDb } from './helpers.js';

let app: FastifyInstance;
beforeAll(async () => { app = await makeApp(); });
afterAll(async () => { await app.close(); await pool.end(); });
beforeEach(async () => { await resetDb(); await requireSelfDriveDetails(); });

const post = (url: string, headers: any, payload?: unknown) => app.inject({ method: 'POST', url, headers, payload: payload as any });
const get = (url: string, headers: any) => app.inject({ method: 'GET', url, headers });
const ago = (years: number) => DateTime.now().minus({ years }).toISODate()!;

const jpeg = (fill: number) => Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(64, fill)]);
function form(h: object, data: Buffer) {
  const boundary = '----t' + Math.random().toString(16).slice(2);
  const body = Buffer.concat([Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="l.jpg"\r\nContent-Type: image/jpeg\r\n\r\n`), data, Buffer.from(`\r\n--${boundary}--\r\n`)]);
  return { payload: body, headers: { ...h, 'content-type': `multipart/form-data; boundary=${boundary}` } };
}
const upload = (h: object, side: 'front' | 'back', data = jpeg(1)) => app.inject({ method: 'POST', url: `/api/me/licence-uploads/${side}`, ...form(h, data) });

const details = (frontId: string, over: Record<string, unknown> = {}) => ({
  fullName: 'Alex Morgan', dateOfBirth: ago(32), email: 'alex@example.com', phone: '07700 900123',
  addressLine1: '12 High Street', addressLine2: 'Flat 2', city: 'London', postcode: 'sw1a1aa', country: 'United Kingdom',
  licenceNumber: 'morga 657054 sm9ij', licenceCountry: 'United Kingdom', licenceIssuedOn: ago(10), licenceExpiresOn: ago(-5),
  licenceCheckCode: 'ab12cd34', penaltyPoints: 0, convictions: null, licenceFrontId: frontId, licenceBackId: null, confirmed: true, ...over,
});

describe('self-drive bookings', () => {
  it('requires the driver details and a licence photo for a self-drive booking, but not with a driver', async () => {
    const v = await makeVehicle();
    const c = await makeCustomer(app);
    const r = await post('/api/me/bookings', c.h, bookingPayload(v.id, { driverOption: 'self_drive' }));
    expect(r.statusCode).toBe(400);
    expect(r.json().error.code).toBe('self_drive_details_required');
    expect((await post('/api/me/bookings', c.h, bookingPayload(v.id, { driverOption: 'with_driver' }))).statusCode).toBe(201);
  });

  it('saves the details with the booking and shows them to staff with the licence photo', async () => {
    const v = await makeVehicle();
    const c = await makeCustomer(app);
    const staff = await makeStaff(app);
    expect((await upload(c.h, 'front', Buffer.from('definitely not a picture of a licence'))).statusCode).toBe(400);
    const front = await upload(c.h, 'front');
    expect(front.statusCode).toBe(201);
    const bk = await post('/api/me/bookings', c.h, bookingPayload(v.id, { driverOption: 'self_drive', selfDrive: details(front.json().id) }));
    expect(bk.statusCode).toBe(201);
    expect(bk.json().selfDrive).toMatchObject({ status: 'pending', fullName: 'Alex Morgan' });

    const admin = (await get(`/api/admin/bookings/${bk.json().id}`, staff.h)).json();
    expect(admin.selfDrive).toMatchObject({
      status: 'pending', fullName: 'Alex Morgan', postcode: 'SW1A 1AA', licenceNumber: 'MORGA657054SM9IJ', licenceCheckCode: 'AB12CD34', restricted: false,
    });
    expect(admin.selfDrive.licenceFront.id).toBe(front.json().id);
    expect(admin.selfDrive.licenceBack).toBeNull();

    const img = await get(`/api/admin/self-drive/${admin.selfDrive.id}/licence/front`, staff.h);
    expect(img.statusCode).toBe(200);
    expect(img.headers['content-type']).toBe('image/jpeg');
    expect(img.headers['cache-control']).toContain('no-store');
    expect((await get(`/api/admin/self-drive/${admin.selfDrive.id}/licence/back`, staff.h)).statusCode).toBe(404);
    // Customers and staff without licence access cannot open it.
    const lim = await makeStaff(app, 'booking_manager', 'bm@test.com');
    expect((await get(`/api/admin/self-drive/${admin.selfDrive.id}/licence/front`, lim.h)).statusCode).toBe(403);
    expect((await get(`/api/admin/self-drive/${admin.selfDrive.id}/licence/front`, c.h)).statusCode).not.toBe(200);
    const limited = (await get(`/api/admin/bookings/${bk.json().id}`, lim.h)).json().selfDrive;
    expect(limited).toMatchObject({ status: 'pending', restricted: true });
    expect(limited).not.toHaveProperty('licenceNumber');

    // The list can be filtered to bookings with a licence check waiting.
    const list = (await get('/api/admin/bookings?selfDrive=pending', staff.h)).json();
    expect(list.items.map((i: any) => i.id)).toEqual([bk.json().id]);
    expect(list.items[0].selfDriveStatus).toBe('pending');
  });

  it('checks age, licence dates, points and photo ownership against the booking', async () => {
    const v = await makeVehicle();
    const c = await makeCustomer(app);
    const other = await makeCustomer(app, 'other@test.com');
    const front = (await upload(c.h, 'front')).json().id;
    const book = (over: Record<string, unknown>, h = c.h) => post('/api/me/bookings', h, bookingPayload(v.id, { driverOption: 'self_drive', selfDrive: details(front, over) }));
    const code = async (over: Record<string, unknown>, h = c.h) => (await book(over, h)).json().error?.code;
    expect(await code({ dateOfBirth: ago(22), licenceIssuedOn: ago(3) })).toBe('driver_too_young');
    expect(await code({ licenceIssuedOn: ago(20) })).toBe('invalid_licence_dates');
    expect(await code({ licenceIssuedOn: ago(1) })).toBe('licence_too_new');
    expect(await code({ licenceExpiresOn: ago(1) })).toBe('licence_expired');
    expect(await code({ penaltyPoints: 9 })).toBe('too_many_points');
    expect(await code({ licenceNumber: 'ABC123' })).toBe('invalid_licence_number');
    expect(await code({ postcode: 'NOTAPOSTCODE' })).toBe('invalid_postcode');
    expect(await code({ confirmed: false })).toBe('validation_error');
    // Another customer cannot use this customer's licence photo.
    expect(await code({}, other.h)).toBe('licence_photo_required');
    // A licence from abroad keeps its own number format.
    expect((await book({ licenceCountry: 'Ireland', licenceNumber: '123456789' })).statusCode).toBe(201);
    // The rules are business settings.
    await pool.query(`INSERT INTO settings(key,value) VALUES ('selfDrive.minAge','21') ON CONFLICT (key) DO UPDATE SET value='21'`);
    const later = await post('/api/me/bookings', c.h, bookingPayload(v.id, { time: '15:00', driverOption: 'self_drive', selfDrive: details(front, { dateOfBirth: ago(22), licenceIssuedOn: ago(3) }) }));
    expect(later.statusCode).toBe(201);
  });

  it('fills in the form from the last booking and lets staff approve or turn the driver down', async () => {
    const v = await makeVehicle();
    const c = await makeCustomer(app);
    const staff = await makeStaff(app);
    expect((await get('/api/me/self-drive', c.h)).json()).toEqual({ details: null, licenceFront: null, licenceBack: null });
    const front = (await upload(c.h, 'front')).json().id;
    const back = (await upload(c.h, 'back', jpeg(2))).json().id;
    const bk = (await post('/api/me/bookings', c.h, bookingPayload(v.id, { driverOption: 'self_drive', selfDrive: details(front, { licenceBackId: back }) }))).json();

    const saved = (await get('/api/me/self-drive', c.h)).json();
    expect(saved.details).toMatchObject({ fullName: 'Alex Morgan', city: 'London', licenceNumber: 'MORGA657054SM9IJ' });
    expect(saved.details).not.toHaveProperty('status');
    expect(saved.licenceFront.id).toBe(front);
    expect(saved.licenceBack.id).toBe(back);

    const appId = (await get(`/api/admin/bookings/${bk.id}`, staff.h)).json().selfDrive.id;
    expect((await post(`/api/admin/self-drive/${appId}/review`, staff.h, { status: 'rejected' })).json().error.code).toBe('note_required');
    const ok = await post(`/api/admin/self-drive/${appId}/review`, staff.h, { status: 'approved' });
    expect(ok.statusCode).toBe(200);
    expect(ok.json()).toMatchObject({ status: 'approved', reviewedBy: 'Test Owner' });
    expect((await get(`/api/me/bookings/${bk.id}`, c.h)).json().selfDrive.status).toBe('approved');
    const notes = (await get('/api/me/notifications', c.h)).json().items;
    expect(notes.some((n: any) => n.kind === 'self_drive_approved')).toBe(true);
    const history = (await get(`/api/admin/bookings/${bk.id}`, staff.h)).json().events;
    expect(history.some((e: any) => e.action === 'self_drive_review' && e.to === 'approved')).toBe(true);

    await post(`/api/admin/self-drive/${appId}/review`, staff.h, { status: 'rejected', note: 'Licence photo is blurred' });
    expect((await get(`/api/me/bookings/${bk.id}`, c.h)).json().selfDrive).toMatchObject({ status: 'rejected', reviewNote: 'Licence photo is blurred' });
    // Photos from a rejected application are not offered again.
    expect((await get('/api/me/self-drive', c.h)).json().licenceFront).toBeNull();
  });

  it('deletes the licence photos and details with the customer account', async () => {
    const v = await makeVehicle();
    const c = await makeCustomer(app);
    const front = (await upload(c.h, 'front')).json().id;
    const bk = (await post('/api/me/bookings', c.h, bookingPayload(v.id, { driverOption: 'self_drive', selfDrive: details(front) }))).json();
    await post(`/api/me/bookings/${bk.id}/cancel`, c.h, {});
    expect((await post('/api/me/delete', c.h, { password: 'password-123' })).statusCode).toBe(200);
    expect((await pool.query('SELECT count(*)::int n FROM self_drive_applications')).rows[0].n).toBe(0);
    expect((await pool.query('SELECT count(*)::int n FROM customer_licence_uploads')).rows[0].n).toBe(0);
  });

  it('lets staff book self-drive on a customer’s behalf without the details', async () => {
    const v = await makeVehicle();
    const c = await makeCustomer(app);
    const staff = await makeStaff(app);
    const r = await post('/api/admin/orders', staff.h, { customerId: c.id, items: [bookingPayload(v.id, { driverOption: 'self_drive' })] });
    expect(r.statusCode).toBe(201);
  });
});
