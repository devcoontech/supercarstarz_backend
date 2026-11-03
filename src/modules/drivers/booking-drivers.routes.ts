import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { DateTime } from 'luxon';
import { pool, tx } from '../../core/db.js';
import { conflict, notFound } from '../../core/errors.js';
import { notify } from '../notifications/notify.js';
import { changeStatus, lockBooking } from '../bookings/status.js';
import { rangeParam } from '../bookings/slots.js';
import { logEvent } from '../bookings/history.js';
import { getSettings } from '../../core/settings.js';
import { actorOf } from '../bookings/history.js';


const uuid = z.string().uuid();
const DISPATCH = ['not_dispatched', 'dispatched', 'en_route', 'arrived', 'service_started', 'service_complete'] as const;

async function assignDriver(c: any, bookingId: string, driverId: string, staffId: string, reason?: string) {
  const b = await lockBooking(c, bookingId);
  if (!['confirmed', 'driver_assigned'].includes(b.status)) throw conflict('Drivers can only be assigned to confirmed bookings', 'invalid_state');
  const s = await getSettings(c);
  const d = (await c.query('SELECT * FROM drivers WHERE id=$1 FOR SHARE', [driverId])).rows[0];
  if (!d) throw notFound('Driver not found');
  if (!d.active) throw conflict('That driver is inactive', 'driver_inactive');
  if (d.license_expiry && DateTime.fromJSDate(d.license_expiry) < DateTime.fromJSDate(b.end_at)) throw conflict('The driver\'s licence expires before this booking ends', 'licence_expired');
  if (d.working_hours?.start && d.working_hours?.end) {
    const tz = s['booking.timezone'];
    const st = DateTime.fromJSDate(b.start_at, { zone: tz }), en = DateTime.fromJSDate(b.end_at, { zone: tz });
    const fmt = (x: DateTime) => x.toFormat('HH:mm');
    if (fmt(st) < d.working_hours.start || fmt(en) > d.working_hours.end) throw conflict(`Outside the driver's working hours (${d.working_hours.start}-${d.working_hours.end})`, 'outside_working_hours');
  }
  const prev = (await c.query('SELECT * FROM driver_assignments WHERE booking_id=$1 AND active', [bookingId])).rows[0];
  if (prev?.driver_id === driverId) return b;
  if (prev) await c.query('UPDATE driver_assignments SET active=false, ended_at=now(), ended_reason=$2 WHERE id=$1', [prev.id, reason ?? 'Reassigned']);
  const buf = s['driver.bufferMinutes'];
  const during = rangeParam(DateTime.fromJSDate(b.start_at).minus({ minutes: buf }), DateTime.fromJSDate(b.end_at).plus({ minutes: buf }));
  try {
    await c.query('INSERT INTO driver_assignments(booking_id, driver_id, during, assigned_by) VALUES ($1,$2,$3::tstzrange,$4)', [bookingId, driverId, during, staffId]);
  } catch (e: any) {
    if (e.code === '23P01') throw conflict('That driver already has an assignment that overlaps this booking (including travel buffer)', 'driver_conflict');
    throw e;
  }
  await c.query('UPDATE bookings SET driver_id=$2, updated_at=now() WHERE id=$1', [bookingId, driverId]);
  const prevName = prev ? (await c.query('SELECT full_name FROM drivers WHERE id=$1', [prev.driver_id])).rows[0]?.full_name : null;
  await logEvent(c, bookingId, { type: 'staff', id: staffId }, prev ? 'driver_reassigned' : 'driver_assigned', { from: prevName, to: d.full_name, reason, meta: { fromDriverId: prev?.driver_id ?? null, toDriverId: driverId } });
  if (b.status === 'confirmed') await changeStatus(c, bookingId, 'driver_assigned', { type: 'staff', id: staffId });
  await notify(c, { customerId: b.customer_id, bookingId, kind: 'driver_assigned', title: prev ? 'Your driver has changed' : 'Driver assigned', body: `Reference ${b.ref}`, dedupeKey: `driver:${bookingId}:${driverId}` });
  return (await c.query('SELECT * FROM bookings WHERE id=$1', [bookingId])).rows[0];
}

export function bookingDriverRoutes(app: FastifyInstance) {
  app.get('/bookings/:id/eligible-drivers', async (req) => {
    const { id } = z.object({ id: uuid }).parse(req.params);
    const b = (await pool.query('SELECT start_at, end_at FROM bookings WHERE id=$1', [id])).rows[0];
    if (!b) throw notFound('Booking not found');
    const s = await getSettings();
    const buf = s['driver.bufferMinutes'];
    const range = rangeParam(DateTime.fromJSDate(b.start_at).minus({ minutes: buf }), DateTime.fromJSDate(b.end_at).plus({ minutes: buf }));
    const rows = (await pool.query(
      `SELECT d.id, d.full_name AS name, d.phone, d.working_hours AS "workingHours",
              EXISTS (SELECT 1 FROM driver_assignments a WHERE a.driver_id=d.id AND a.active AND a.booking_id <> $1 AND a.during && $2::tstzrange) AS busy,
              (d.license_expiry IS NOT NULL AND d.license_expiry < $3::date) AS "licenceExpired"
         FROM drivers d WHERE d.active ORDER BY d.full_name`, [id, range, b.end_at])).rows;
    return { items: rows.map((r) => ({ ...r, eligible: !r.busy && !r.licenceExpired })) };
  });

  app.post('/bookings/:id/driver', async (req) => {
    const { id } = z.object({ id: uuid }).parse(req.params);
    const b = z.object({ driverId: uuid, reason: z.string().max(500).optional() }).parse(req.body);
    return tx((c) => assignDriver(c, id, b.driverId, req.user.sub, b.reason));
  });

  app.delete('/bookings/:id/driver', async (req) => {
    const { id } = z.object({ id: uuid }).parse(req.params);
    const { reason } = z.object({ reason: z.string().min(1).max(500) }).parse(req.body ?? {});
    return tx(async (c) => {
      const cur = await lockBooking(c, id);
      if (!cur.driver_id) throw conflict('No driver is assigned', 'no_driver');
      await c.query('UPDATE driver_assignments SET active=false, ended_at=now(), ended_reason=$2 WHERE booking_id=$1 AND active', [id, reason]);
      await c.query('UPDATE bookings SET driver_id=NULL WHERE id=$1', [id]);
      const nm = (await c.query('SELECT full_name FROM drivers WHERE id=$1', [cur.driver_id])).rows[0]?.full_name;
      await logEvent(c, id, actorOf(req), 'driver_removed', { from: nm, reason, meta: { driverId: cur.driver_id } });
      if (cur.status === 'driver_assigned') await changeStatus(c, id, 'confirmed', actorOf(req));
      return { ok: true };
    });
  });

  /** Status-based progress tracking. This is NOT GPS; no location is recorded. */
  app.post('/bookings/:id/dispatch', async (req) => {
    const { id } = z.object({ id: uuid }).parse(req.params);
    const { status } = z.object({ status: z.enum(DISPATCH) }).parse(req.body);
    return tx(async (c) => {
      const cur = await lockBooking(c, id);
      if (!['confirmed', 'driver_assigned', 'in_progress'].includes(cur.status)) throw conflict('Progress can only be updated on active bookings', 'invalid_state');
      if (DISPATCH.indexOf(status) <= DISPATCH.indexOf(cur.dispatch_status)) throw conflict('Progress can only move forward', 'invalid_transition');
      await c.query('UPDATE bookings SET dispatch_status=$2, updated_at=now() WHERE id=$1', [id, status]);
      await logEvent(c, id, actorOf(req), 'dispatch', { from: cur.dispatch_status, to: status });
      if (status === 'service_started' && cur.status !== 'in_progress') await changeStatus(c, id, 'in_progress', actorOf(req));
      if (status === 'service_complete') {
        if (cur.status !== 'in_progress') await changeStatus(c, id, 'in_progress', actorOf(req));
        await changeStatus(c, id, 'completed', actorOf(req));
      }
      return (await c.query('SELECT * FROM bookings WHERE id=$1', [id])).rows[0];
    });
  });
}
