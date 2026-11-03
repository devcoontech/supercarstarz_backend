import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import fs from 'node:fs';
import path from 'node:path';
import { pool } from '../src/core/db.js';
import { app as makeApp, bookingPayload, makeEvent, makeStaff, makeVehicle, resetDb } from './helpers.js';

let app: FastifyInstance;
beforeAll(async () => { app = await makeApp(); });
afterAll(async () => { await app.close(); await pool.end(); });
beforeEach(resetDb);

const post = (url: string, headers: any, payload?: unknown) => app.inject({ method: 'POST', url, headers, payload: payload as any });
const patch = (url: string, headers: any, payload?: unknown) => app.inject({ method: 'PATCH', url, headers, payload: payload as any });
const put = (url: string, headers: any, payload?: unknown) => app.inject({ method: 'PUT', url, headers, payload: payload as any });
const quote = async (vehicleId: string, eventTypeId: string | null, hours = 2) => {
  const r = await post('/api/public/quote', {}, bookingPayload(vehicleId, { eventTypeId, hours }));
  expect(r.statusCode).toBe(200);
  return r.json().pricing.lines.find((l: any) => l.key === 'duration').amountPence as number;
};
const rule = (vehicleId: string | null, eventTypeId: string | null, kind: string, amountPence: number, hours: number | null = null) =>
  pool.query('INSERT INTO pricing_rules(vehicle_id, event_type_id, kind, amount_pence, hours) VALUES ($1,$2,$3,$4,$5)', [vehicleId, eventTypeId, kind, amountPence, hours]);
const migration = fs.readFileSync(path.resolve(__dirname, '../migrations/013_vehicle_pricing_and_driver_details.sql'), 'utf8');

describe('pricing lives on each vehicle', () => {
  it('moves fleet-wide and event prices onto each car without changing any quote', async () => {
    const plain = await makeVehicle(); // priced only by the fleet-wide and event rules
    const own = await makeVehicle(); // has its own hourly rate, which always beat event and fleet rules
    const mixed = await makeVehicle(); // has its own car + event package for one event only
    const birthdays = await makeEvent(plain.id, 'Birthdays');
    await pool.query('INSERT INTO vehicle_event_types VALUES ($1,$3),($2,$3)', [own.id, mixed.id, birthdays.id]);
    const weddings = await makeEvent(mixed.id, 'Weddings');
    await rule(null, null, 'hourly', 30000); // every car
    await rule(null, birthdays.id, 'hourly', 10000); // every car, for birthdays
    await rule(null, birthdays.id, 'package', 15000, 2);
    await rule(own.id, null, 'hourly', 50000);
    await rule(mixed.id, weddings.id, 'package', 7000, 2);

    const cases: [string, string | null, number][] = [];
    for (const v of [plain, own, mixed]) for (const e of [null, birthdays.id, weddings.id]) for (const h of [2, 3]) {
      if (e === weddings.id && v.id !== mixed.id) continue;
      cases.push([v.id, e, h]);
    }
    const before = await Promise.all(cases.map(([v, e, h]) => quote(v, e, h)));
    await pool.query(migration);
    const after = await Promise.all(cases.map(([v, e, h]) => quote(v, e, h)));
    expect(after).toEqual(before);
    // Nothing is priced from outside a car any more, and the old rules are kept (switched off) for history.
    expect((await pool.query('SELECT count(*)::int n FROM pricing_rules WHERE vehicle_id IS NULL AND active')).rows[0].n).toBe(0);
    expect((await pool.query('SELECT count(*)::int n FROM pricing_rules WHERE vehicle_id IS NULL')).rows[0].n).toBe(3);
    // Running it again changes nothing.
    await pool.query(migration);
    expect(await Promise.all(cases.map(([v, e, h]) => quote(v, e, h)))).toEqual(before);
  });

  it('only accepts price rules for a car, and a rule cannot be moved to another car', async () => {
    const staff = await makeStaff(app);
    const v = await makeVehicle();
    const other = await makeVehicle();
    expect((await post('/api/admin/pricing-rules', staff.h, { kind: 'hourly', amountPence: 1000 })).statusCode).toBe(400);
    expect((await post('/api/admin/pricing-rules', staff.h, { kind: 'hourly', vehicleId: '00000000-0000-4000-8000-000000000000', amountPence: 1000 })).statusCode).toBe(404);
    const r = await post('/api/admin/pricing-rules', staff.h, { kind: 'package', vehicleId: v.id, hours: 3, amountPence: 45000, label: 'Half day' });
    expect(r.statusCode).toBe(201);
    expect((await patch(`/api/admin/pricing-rules/${r.json().id}`, staff.h, { vehicleId: other.id })).statusCode).toBe(400);
    expect((await patch(`/api/admin/pricing-rules/${r.json().id}`, staff.h, { amountPence: 40000 })).statusCode).toBe(200);
    expect(await quote(v.id, null, 3)).toBe(40000);
    expect(await quote(other.id, null, 3)).toBe(60000); // the other car keeps its own hourly rate (20000/h)
  });
});

describe('business details', () => {
  it('builds the printed address from its parts and checks the emails', async () => {
    const staff = await makeStaff(app);
    const r = await put('/api/admin/settings', staff.h, { settings: {
      'company.addressLine1': '1 Park Lane', 'company.city': 'London', 'company.postcode': 'W1K 1AA', 'company.country': 'United Kingdom',
      'company.type': 'Limited company', 'company.registrationNumber': '01234567', 'company.email': 'hello@example.com', 'company.altPhone': '020 1111 2222',
    } });
    expect(r.statusCode).toBe(200);
    expect(r.json().settings['company.address']).toBe('1 Park Lane, London, W1K 1AA, United Kingdom');
    expect(r.json().settings['company.registrationNumber']).toBe('01234567');
    expect((await put('/api/admin/settings', staff.h, { settings: { 'company.email': 'not-an-email' } })).statusCode).toBe(400);
    expect((await put('/api/admin/settings', staff.h, { settings: { 'company.name': '  ' } })).statusCode).toBe(400);
    expect((await put('/api/admin/settings', staff.h, { settings: { 'company.logoUrl': 'https://evil.example/x.png' } })).statusCode).toBe(400);
  });

  it('uploads, replaces and removes the logo, and prints it on documents', async () => {
    const staff = await makeStaff(app);
    const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
    const upload = (buf: Buffer, name = 'logo.png') => {
      const b = '----x' + Math.random().toString(16).slice(2);
      const body = Buffer.concat([Buffer.from(`--${b}\r\nContent-Disposition: form-data; name="file"; filename="${name}"\r\nContent-Type: image/png\r\n\r\n`), buf, Buffer.from(`\r\n--${b}--\r\n`)]);
      return app.inject({ method: 'POST', url: '/api/admin/settings/logo', headers: { ...staff.h, 'content-type': `multipart/form-data; boundary=${b}` }, payload: body });
    };
    const first = await upload(png);
    expect(first.statusCode).toBe(200);
    const url1 = first.json().settings['company.logoUrl'];
    expect(url1).toMatch(/branding\/logo-.+\.png$/);
    const second = await upload(png);
    expect(second.json().settings['company.logoUrl']).not.toBe(url1);
    expect((await upload(Buffer.from('not an image'), 'x.png')).statusCode).toBe(400);
    const removed = await app.inject({ method: 'DELETE', url: '/api/admin/settings/logo', headers: staff.h });
    expect(removed.json().settings['company.logoUrl']).toBe('');
  });
});

describe('drivers', () => {
  it('edits any detail of an existing driver in place, including address and licence type', async () => {
    const staff = await makeStaff(app);
    const d = (await post('/api/admin/drivers', staff.h, { fullName: 'Dan', phone: '07000000001', address: '2 High St, London', licenseType: 'B' })).json();
    expect(d).toMatchObject({ address: '2 High St, London', license_type: 'B' });
    const u = await patch(`/api/admin/drivers/${d.id}`, staff.h, { fullName: 'Daniel Smith', licenseType: 'B, C1', licenseNumber: 'SMITH801017D99AB', licenseExpiry: '2031-05-01', address: '3 High St' });
    expect(u.statusCode).toBe(200);
    expect(u.json()).toMatchObject({ id: d.id, full_name: 'Daniel Smith', license_type: 'B, C1', address: '3 High St' });
    expect((await pool.query('SELECT count(*)::int n FROM drivers')).rows[0].n).toBe(1);
  });
});
