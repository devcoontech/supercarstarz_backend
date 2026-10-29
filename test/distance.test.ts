import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { pool } from '../src/db.js';
import { clearMapsCache, setMapsHttp } from '../src/maps.js';
import { resolveSmtp, setMailer } from '../src/mailer.js';
import { app as makeApp, bookingPayload, makeCustomer, makeEvent, makeStaff, makeVehicle, resetDb } from './helpers.js';

let app: FastifyInstance;
beforeAll(async () => { app = await makeApp(); });
afterAll(async () => { setMapsHttp(null); setMailer(null); await app.close(); await pool.end(); });

const PLACES: Record<string, [number, number]> = {
  'base street, london': [51.5, -0.12],
  'near house, london': [51.51, -0.1],
  'far house, reading': [51.45, -0.97],
  'pickup road, london': [51.52, -0.1],
  'drop road, brighton': [50.82, -0.14],
  'buckingham palace, london': [51.5014, -0.1419],
  'tower of london, london': [51.5081, -0.0759],
};
const haversineKm = (a: [number, number], b: [number, number]) => {
  const r = (d: number) => (d * Math.PI) / 180;
  const h = Math.sin(r(b[0] - a[0]) / 2) ** 2 + Math.cos(r(a[0])) * Math.cos(r(b[0])) * Math.sin(r(b[1] - a[1]) / 2) ** 2;
  return 2 * 6371 * Math.asin(Math.sqrt(h));
};
let down = false;
let calls: string[] = [];
const fakeMaps = async (url: string): Promise<Response> => {
  calls.push(url);
  if (down) return new Response('nope', { status: 500 });
  const u = new URL(url);
  if (u.pathname === '/search') {
    const hit = PLACES[(u.searchParams.get('q') ?? '').trim().toLowerCase()];
    return Response.json(hit ? [{ lat: String(hit[0]), lon: String(hit[1]), display_name: u.searchParams.get('q') }] : []);
  }
  if (u.pathname === '/reverse') {
    const lat = Number(u.searchParams.get('lat')), lon = Number(u.searchParams.get('lon'));
    if (lat < 49 || lat > 61) return Response.json({ error: 'Unable to geocode' }); // open sea
    const near = Object.entries(PLACES).find(([, p]) => Math.abs(p[0] - lat) < 0.002 && Math.abs(p[1] - lon) < 0.002);
    return Response.json({ lat: String(lat), lon: String(lon), display_name: near ? near[0] : `Some Road, ${lat.toFixed(3)}` });
  }
  const m = u.pathname.match(/driving\/([-\d.]+),([-\d.]+);([-\d.]+),([-\d.]+)/);
  if (m) {
    const km = haversineKm([Number(m[2]), Number(m[1])], [Number(m[4]), Number(m[3])]) * 1.3; // roads are longer than the crow flies
    return Response.json({ code: 'Ok', routes: [{ distance: km * 1000, duration: km * 90 }] });
  }
  return new Response('?', { status: 404 });
};
// The map service measures in km; the server prices in miles (0.1 mile), so expectations convert the same way.
const roadMiles = (a: string, b: string) => Math.round(((haversineKm(PLACES[a], PLACES[b]) * 1.3) / 1.609344) * 10) / 10;

beforeEach(async () => {
  await resetDb();
  down = false;
  calls = [];
  clearMapsCache();
  setMapsHttp(fakeMaps);
  setMailer(null);
});

const post = (url: string, headers: any, payload?: unknown) => app.inject({ method: 'POST', url, headers, payload: payload as any });
const put = (url: string, headers: any, payload?: unknown) => app.inject({ method: 'PUT', url, headers, payload: payload as any });
const del = (url: string, headers: any) => app.inject({ method: 'DELETE', url, headers });
const patch = (url: string, headers: any, payload?: unknown) => app.inject({ method: 'PATCH', url, headers, payload: payload as any });

async function distanceVehicle(over: Record<string, unknown> = {}) {
  return makeVehicle({
    base_address: 'base street, london', base_lat: 51.5, base_lng: -0.12, delivery_pricing: 'per_mile', delivery_per_mile_pence: 180, delivery_free_miles: 5,
    delivery_min_pence: 2000, ...over,
  });
}

describe('delivery priced by distance', () => {
  it('locates the car when staff save its base address, and rejects an address that cannot be found', async () => {
    const staff = await makeStaff(app);
    const v = await makeVehicle();
    const ok = await patch(`/api/admin/vehicles/${v.id}`, staff.h, { baseAddress: 'Base Street, London', deliveryPricing: 'per_mile', deliveryPerMilePence: 150 });
    expect(ok.statusCode).toBe(200);
    expect(ok.json()).toMatchObject({ base_lat: 51.5, base_lng: -0.12, delivery_pricing: 'per_mile', delivery_per_mile_pence: 150 });
    const bad = await patch(`/api/admin/vehicles/${v.id}`, staff.h, { baseAddress: 'Nowhere Lane, Atlantis' });
    expect(bad.statusCode).toBe(422);
    expect(bad.json().error.code).toBe('address_not_found');
    const cleared = await patch(`/api/admin/vehicles/${v.id}`, staff.h, { baseAddress: '' });
    expect(cleared.json()).toMatchObject({ base_address: null, base_lat: null });
  });

  it('never measures delivery: the quote says our team adds the charge, client distances are ignored, a map pin is kept', async () => {
    const v = await distanceVehicle();
    const c = await makeCustomer(app);
    const payload = bookingPayload(v.id, { experience: 'delivered', address: 'Far House, Reading', addressPoint: { lat: 51.45, lng: -0.97 } });
    calls = [];
    const q = await post('/api/public/quote', {}, payload);
    expect(q.statusCode).toBe(200);
    expect(calls).toHaveLength(0); // no address lookup, no route
    expect(q.json().pricing.deliveryEstimate).toMatchObject({ amountPence: null, miles: null, ratePerMilePence: null });
    expect(q.json().pricing.deliveryEstimate.label).toContain('added by our team');
    expect(q.json().pricing.lines.find((l: any) => l.key === 'delivery')).toBeUndefined();

    // A client trying to send its own distance changes nothing.
    const bk = await post('/api/me/bookings', c.h, { ...payload, geo: { distances: { deliveryMiles: 0.1, routeMiles: null } }, distances: { deliveryMiles: 0.1 }, deliveryMiles: 0.1 });
    expect(bk.statusCode, bk.body).toBe(201);
    expect(bk.json().totalPence).toBe(bk.json().quotedTotalPence); // nothing for delivery until staff add it
    const row = (await pool.query('SELECT delivery_miles, address, address_lat, address_lng FROM bookings')).rows[0];
    expect(row).toMatchObject({ delivery_miles: null, address: 'Far House, Reading', address_lat: 51.45, address_lng: -0.97 });
  });

  it('books a delivery while the map service is down, because nothing is measured', async () => {
    const v = await distanceVehicle();
    const c = await makeCustomer(app);
    down = true;
    clearMapsCache();
    const r = await post('/api/me/bookings', c.h, bookingPayload(v.id, { experience: 'delivered', address: 'No Such Road, Atlantis' }));
    expect(r.statusCode, r.body).toBe(201);
  });

  it('caches lookups so repeated quotes do not hit the map service again', async () => {
    const v = await distanceVehicle();
    const p = bookingPayload(v.id, { experience: 'delivered', address: 'Near House, London' });
    await post('/api/public/quote', {}, p);
    const first = calls.length;
    await post('/api/public/quote', {}, p);
    expect(calls.length).toBe(first);
  });

  it('serves address suggestions', async () => {
    const r = await app.inject({ method: 'GET', url: '/api/public/places?q=Near%20House,%20London' });
    expect(r.statusCode).toBe(200);
    expect(r.json().items[0]).toMatchObject({ lat: 51.51, lng: -0.1 });
    expect((await app.inject({ method: 'GET', url: '/api/public/places?q=ab' })).statusCode).toBe(400);
  });
});

describe('chauffeur and pick-up/drop-off events', () => {
  it('charges an hourly chauffeur per booked hour', async () => {
    const v = await makeVehicle({ chauffeur_charge_type: 'hourly', chauffeur_fee_pence: 3500 });
    const q = await post('/api/public/quote', {}, bookingPayload(v.id, { hours: 3, chauffeur: true }));
    expect(q.json().pricing.lines.find((l: any) => l.key === 'chauffeur').amountPence).toBe(10500);
  });

  async function pickDropSetup() {
    const staff = await makeStaff(app);
    const v = await makeVehicle({ chauffeur_charge_type: 'hourly', chauffeur_fee_pence: 3000 });
    const ev = (await post('/api/admin/event-types', staff.h, { title: 'Pick and Drop', published: true, pricingBasis: 'distance' })).json();
    await put(`/api/admin/vehicles/${v.id}/event-types`, staff.h, { eventTypeIds: [ev.id] });
    const rule = await post('/api/admin/pricing-rules', staff.h, { kind: 'per_mile', eventTypeId: ev.id, amountPence: 250, minAmountPence: 4000 });
    expect(rule.statusCode).toBe(201);
    return { staff, v, ev, payload: { eventTypeId: ev.id, pickupAddress: 'Pickup Road, London', dropoffAddress: 'Drop Road, Brighton' } };
  }

  it('prices the trip per mile between the two addresses, with the chauffeur, and records the route', async () => {
    const { v, payload } = await pickDropSetup();
    const c = await makeCustomer(app);
    const miles = roadMiles('pickup road, london', 'drop road, brighton');
    const q = await post('/api/public/quote', {}, bookingPayload(v.id, { ...payload, hours: 3 }));
    expect(q.statusCode).toBe(200);
    const lines = q.json().pricing.lines;
    expect(lines[0]).toMatchObject({ key: 'duration', amountPence: Math.round(miles * 250) });
    expect(lines[0].label).toContain(`${miles} miles`);
    expect(lines.find((l: any) => l.key === 'chauffeur').amountPence).toBe(9000); // £30/h x 3h, added automatically
    expect(q.json().places.pickup).toBe('Pickup Road, London');

    const bk = await post('/api/me/bookings', c.h, bookingPayload(v.id, { ...payload, hours: 3, experience: 'delivered', chauffeur: false }));
    expect(bk.statusCode).toBe(201);
    const row = (await pool.query('SELECT experience, chauffeur, route_miles, pickup_address, dropoff_address, pickup_lat FROM bookings')).rows[0];
    expect(row).toMatchObject({ experience: 'stationary', chauffeur: true, pickup_address: 'Pickup Road, London', dropoff_address: 'Drop Road, Brighton' });
    expect(Number(row.route_miles)).toBe(miles);
    expect(row.pickup_lat).toBeCloseTo(51.52);
  });

  it('applies the minimum charge for a short trip', async () => {
    const { v, payload } = await pickDropSetup();
    const q = await post('/api/public/quote', {}, bookingPayload(v.id, { ...payload, dropoffAddress: 'Near House, London', hours: 1 }));
    expect(q.json().pricing.lines[0].amountPence).toBe(4000);
    expect(q.json().pricing.lines[0].label).toContain('minimum');
  });

  it('needs both addresses, a driver on the car, and a per-mile rate', async () => {
    const { staff, v, ev, payload } = await pickDropSetup();
    expect((await post('/api/public/quote', {}, bookingPayload(v.id, { eventTypeId: ev.id }))).json().error.code).toBe('route_required');
    expect((await post('/api/public/quote', {}, bookingPayload(v.id, { ...payload, dropoffAddress: 'Atlantis' }))).json().error.code).toBe('address_not_found');
    const noDriver = await makeVehicle({ chauffeur_available: false });
    await put(`/api/admin/vehicles/${noDriver.id}/event-types`, staff.h, { eventTypeIds: [ev.id] });
    expect((await post('/api/public/quote', {}, bookingPayload(noDriver.id, payload))).json().error.code).toBe('event_not_supported');
    await pool.query('DELETE FROM pricing_rules');
    expect((await post('/api/public/quote', {}, bookingPayload(v.id, payload))).json().error.code).toBe('pricing_not_configured');
  });

  it('exposes the pricing basis to the customer app', async () => {
    const { v } = await pickDropSetup();
    const events = (await app.inject({ method: 'GET', url: '/api/public/event-types' })).json().items;
    expect(events.find((e: any) => e.title === 'Pick and Drop').pricingBasis).toBe('distance');
    const vehicle = (await app.inject({ method: 'GET', url: `/api/public/vehicles/${v.id}` })).json();
    expect(vehicle.events[0].pricingBasis).toBe('distance');
    expect(vehicle.pricing.rules.some((r: any) => r.kind === 'per_mile')).toBe(true);
    expect(vehicle.chauffeur_charge_type).toBe('hourly');
  });
});

describe('deleting records', () => {
  it('deletes extras, and refuses to delete used offers, drivers and events (offering deactivate or archive)', async () => {
    const staff = await makeStaff(app);
    const v = await makeVehicle();
    const c = await makeCustomer(app);
    const ev = await makeEvent(v.id, 'Races');
    const addon = (await post('/api/admin/addons', staff.h, { name: 'Balloons', pricePence: 3500 })).json();
    expect((await del(`/api/admin/addons/${addon.id}`, staff.h)).statusCode).toBe(200);
    expect((await del(`/api/admin/addons/${addon.id}`, staff.h)).statusCode).toBe(404);

    await pool.query(`INSERT INTO offers(code,title,discount_type,discount_value) VALUES ('USED','Used','percent',10)`);
    const unused = (await post('/api/admin/offers', staff.h, { title: 'Spare', discountType: 'percent', discountValue: 5, minBookingPence: 0, active: true, code: 'SPARE' })).json();
    expect((await del(`/api/admin/offers/${unused.id}`, staff.h)).statusCode).toBe(200);
    const bk = (await post('/api/me/bookings', c.h, bookingPayload(v.id, { eventTypeId: ev.id, offerCode: 'USED', chauffeur: true }))).json();
    const usedId = (await pool.query(`SELECT id FROM offers WHERE code='USED'`)).rows[0].id;
    const blocked = await del(`/api/admin/offers/${usedId}`, staff.h);
    expect(blocked.statusCode).toBe(409);
    expect(blocked.json().error.message).toMatch(/turn it off/i);

    expect((await del(`/api/admin/event-types/${ev.id}`, staff.h)).json().error.code).toBe('has_bookings');
    await post(`/api/admin/bookings/${bk.id}/status`, staff.h, { to: 'confirmed', allowUnpaid: true });
    const drv = (await post('/api/admin/drivers', staff.h, { fullName: 'Dan', phone: '07000000001' })).json();
    const spare = (await post('/api/admin/drivers', staff.h, { fullName: 'Spare', phone: '07000000002' })).json();
    await post(`/api/admin/bookings/${bk.id}/driver`, staff.h, { driverId: drv.id });
    expect((await del(`/api/admin/drivers/${drv.id}`, staff.h)).json().error.code).toBe('has_assignments');
    expect((await del(`/api/admin/drivers/${spare.id}`, staff.h)).statusCode).toBe(200);

    const ev2 = await makeEvent(v.id, 'Roadshows');
    await post('/api/admin/pricing-rules', staff.h, { kind: 'hourly', eventTypeId: ev2.id, amountPence: 1000 });
    expect((await del(`/api/admin/event-types/${ev2.id}`, staff.h)).statusCode).toBe(200); // its rules and links go with it
    expect((await pool.query('SELECT count(*)::int n FROM pricing_rules WHERE event_type_id=$1', [ev2.id])).rows[0].n).toBe(0);
  });

  it('requires staff to delete anything', async () => {
    const c = await makeCustomer(app);
    const v = await makeVehicle();
    const ev = await makeEvent(v.id);
    for (const url of [`/api/admin/event-types/${ev.id}`, `/api/admin/addons/${ev.id}`, `/api/admin/offers/${ev.id}`, `/api/admin/drivers/${ev.id}`]) {
      expect((await del(url, {})).statusCode).toBe(401);
      expect((await del(url, c.h)).statusCode).toBe(403);
    }
  });
});

describe('email and map settings', () => {
  it('saves SMTP settings, keeps the password encrypted and never returns it, and lets the mailer use it', async () => {
    const staff = await makeStaff(app);
    const r = await put('/api/admin/settings', staff.h, {
      settings: { 'email.host': 'smtp.example.com', 'email.port': 465, 'email.secure': true, 'email.user': 'mailer@example.com', 'email.fromName': 'Supercarstars', 'email.fromAddress': 'hello@example.com' },
      secrets: { emailPassword: 'S3cret-smtp-pass' },
    });
    expect(r.statusCode).toBe(200);
    expect(r.body).not.toContain('S3cret-smtp-pass');
    expect(r.json().secrets['email.password']).toEqual({ configured: true, hint: '…pass' });
    expect((await pool.query(`SELECT value FROM settings WHERE key='email.password'`)).rows[0].value).not.toContain('S3cret');
    const resolved = await resolveSmtp();
    expect(resolved).toMatchObject({ kind: 'settings', host: 'smtp.example.com', port: 465, secure: true, user: 'mailer@example.com', pass: 'S3cret-smtp-pass', from: '"Supercarstars" <hello@example.com>' });
    const cleared = await put('/api/admin/settings', staff.h, { clearSecrets: ['email.password'] });
    expect(cleared.json().secrets['email.password'].configured).toBe(false);
  });

  it('validates email and map settings', async () => {
    const staff = await makeStaff(app);
    for (const settings of [{ 'email.port': 0 }, { 'email.port': 70000 }, { 'email.fromAddress': 'not-an-email' }, { 'email.host': 'bad host!' }, { 'maps.provider': 'bing' }, { 'maps.countryCodes': 'united kingdom' }]) {
      expect((await put('/api/admin/settings', staff.h, { settings })).statusCode, JSON.stringify(settings)).toBe(400);
    }
    expect((await put('/api/admin/settings', staff.h, { secrets: { mapsGoogleKey: 'short' } })).statusCode).toBe(400);
    expect((await put('/api/admin/settings', staff.h, { settings: { 'maps.provider': 'google', 'maps.countryCodes': 'gb, ie' } })).statusCode).toBe(200);
  });

  it('reports a missing or unreachable email server plainly, and sends a test email through the configured mailer', async () => {
    const staff = await makeStaff(app);
    const none = await post('/api/admin/settings/email/verify', staff.h, {});
    expect(none.statusCode).toBe(422);
    expect(none.json().error.message).toMatch(/no email server/i);
    await put('/api/admin/settings', staff.h, { settings: { 'email.host': '127.0.0.1', 'email.port': 1, 'email.fromAddress': 'a@example.com' } });
    const refused = await post('/api/admin/settings/email/verify', staff.h, {});
    expect(refused.statusCode).toBe(422);
    expect(refused.json().error.message).toMatch(/could not connect/i);

    const sent: any[] = [];
    setMailer({ send: async (m) => (sent.push(m), { sent: true }) });
    const ok = await post('/api/admin/settings/email/test', staff.h, { to: 'owner@example.com' });
    expect(ok.statusCode).toBe(200);
    expect(sent[0]).toMatchObject({ to: 'owner@example.com' });
    setMailer({ send: async () => ({ sent: false, reason: 'auth failed' }) });
    const fail = await post('/api/admin/settings/email/test', staff.h, { to: 'owner@example.com' });
    expect(fail.statusCode).toBe(422);
    expect(fail.json().error.message).toContain('auth failed');
    expect((await post('/api/admin/settings/email/test', staff.h, { to: 'nope' })).statusCode).toBe(400);
  });

  it('tests the map provider with a known route, and only staff can', async () => {
    const staff = await makeStaff(app);
    const r = await post('/api/admin/settings/maps/test', staff.h, {});
    expect(r.statusCode).toBe(200);
    expect(r.json().example).toMatch(/miles/);
    expect((await post('/api/admin/settings/maps/test', {}, {})).statusCode).toBe(401);
    down = true;
    clearMapsCache();
    expect((await post('/api/admin/settings/maps/test', staff.h, {})).statusCode).toBe(503);
  });
});

describe('map picker support', () => {
  it('turns a map point into an address, keeping the pin where it was dropped', async () => {
    const r = await app.inject({ method: 'GET', url: '/api/public/reverse?lat=51.51&lng=-0.1' });
    expect(r.statusCode).toBe(200);
    expect(r.json()).toMatchObject({ lat: 51.51, lng: -0.1, label: 'near house, london' });
    const nowhere = await app.inject({ method: 'GET', url: '/api/public/reverse?lat=10&lng=-30' });
    expect(nowhere.statusCode).toBe(422);
    expect(nowhere.json().error.code).toBe('address_not_found');
    for (const q of ['lat=91&lng=0', 'lat=0&lng=181', 'lat=abc&lng=1', 'lat=51']) {
      expect((await app.inject({ method: 'GET', url: '/api/public/reverse?' + q })).statusCode, q).toBe(400);
    }
  });

  it('prices a pick-up and drop-off trip from two dropped pins', async () => {
    const staff = await makeStaff(app);
    const v = await makeVehicle({ chauffeur_available: true });
    const ev = (await post('/api/admin/event-types', staff.h, { title: 'Pick and Drop', published: true, pricingBasis: 'distance' })).json();
    await put(`/api/admin/vehicles/${v.id}/event-types`, staff.h, { eventTypeIds: [ev.id] });
    await post('/api/admin/pricing-rules', staff.h, { kind: 'per_mile', eventTypeId: ev.id, amountPence: 200 });
    const q = await post('/api/public/quote', {}, bookingPayload(v.id, {
      eventTypeId: ev.id, pickupAddress: 'Pin A', dropoffAddress: 'Pin B', pickupPoint: { lat: 51.52, lng: -0.1 }, dropoffPoint: { lat: 50.82, lng: -0.14 },
    }));
    expect(q.statusCode).toBe(200);
    const miles = roadMiles('pickup road, london', 'drop road, brighton');
    expect(q.json().pricing.distances.routeMiles).toBe(miles);
    expect(q.json().pricing.lines[0].amountPence).toBe(Math.round(miles * 200));
    expect(q.json().places).toMatchObject({ pickup: 'Pin A', dropoff: 'Pin B' });
  });

  it('rejects impossible coordinates in a booking request', async () => {
    const v = await distanceVehicle();
    for (const addressPoint of [{ lat: 95, lng: 0 }, { lat: 0, lng: 200 }, { lat: 'x', lng: 1 }]) {
      const r = await post('/api/public/quote', {}, bookingPayload(v.id, { experience: 'delivered', address: 'Near House, London', addressPoint }));
      expect(r.statusCode).toBe(400);
    }
  });
});
