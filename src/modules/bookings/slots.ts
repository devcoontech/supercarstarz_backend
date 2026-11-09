import type pg from 'pg';
import { DateTime } from 'luxon';
import { conflict, badRequest } from '../../core/errors.js';
import { type Settings } from '../../core/settings.js';

/** Booking times: building a slot from a date and time, buffers, and checking a car is free. */

/*
 * Day bookings: a booking of 24 hours or more is booked in whole days, 1 day = 24 hours from the start time
 * (10:00 Saturday for 2 days ends 10:00 Monday). It must start within opening hours; the same-day closing time does
 * not apply. Shorter bookings are hourly and must start and finish within opening hours on one day.
 */
export const HOURS_PER_DAY = 24;
export const isDayBooking = (hours: number) => hours >= HOURS_PER_DAY;
export const daysOf = (hours: number) => Math.floor(hours / HOURS_PER_DAY);

/**
 * Is this length allowed for this car? Hourly bookings use the car's minimum and maximum hours; day bookings must
 * be whole days, up to the business's maximum, and only when day bookings are switched on (staff may always).
 */
export function assertDuration(s: Settings, v: { min_hours: number; max_hours: number }, hours: number, staff = false) {
  if (isDayBooking(hours)) {
    if (!staff && !s['booking.allowDailyBookings']) throw badRequest('Day bookings are not available. Choose a number of hours.', 'invalid_duration');
    if (hours % HOURS_PER_DAY !== 0) throw badRequest('Day bookings are made in whole days (24 hours each)', 'invalid_duration');
    const max = s['booking.maxDays'];
    if (daysOf(hours) > max) throw badRequest(`Cars can be booked for up to ${max} ${max === 1 ? 'day' : 'days'}`, 'invalid_duration');
    return;
  }
  if (hours < v.min_hours || hours > v.max_hours) throw badRequest(`This car can be booked for ${v.min_hours} to ${v.max_hours} hours, or by the day`, 'invalid_duration');
}

type C = pg.PoolClient;

export function localToUtc(date: string, time: string, tz: string): DateTime {
  const dt = DateTime.fromISO(`${date}T${time}`, { zone: tz });
  if (!dt.isValid) throw badRequest('Invalid date or time', 'invalid_datetime');
  return dt.toUTC();
}

/**
 * Preparation time kept free around every booking: the business setting (default 1 hour), or the car's own
 * turnaround if that is longer. Buffers are availability rules only and are never charged.
 */
export const effectiveBuffer = (s: Settings, vehicle: { buffer_minutes: number }) => Math.max(s['booking.bufferMinutes'], vehicle.buffer_minutes ?? 0);

/*
 * A booking holds [start, end + buffer) in blocked_during, and a new booking must also start at least the buffer
 * after, and end at least the buffer before, every other booking on the car (assertSlotFree). Together that keeps
 * the buffer both before and after each booking: 10:00-12:00 blocks 09:00-10:00 and 12:00-13:00 for anyone else.
 */
export type Slot = { start: DateTime; end: DateTime; blockedStart: DateTime; blockedEnd: DateTime; localDate: string; bufferMinutes: number };

export const slotFor = (start: DateTime, end: DateTime, bufferMinutes: number, tz: string): Slot => ({
  start, end, blockedStart: start, blockedEnd: end.plus({ minutes: bufferMinutes }), localDate: start.setZone(tz).toISODate()!, bufferMinutes,
});

export function buildSlot(
  s: Settings, bufferMinutes: number, date: string, time: string, hours: number, opts: { skipLead?: boolean; skipHours?: boolean } = {},
): Slot {
  const tz = s['booking.timezone'];
  const start = localToUtc(date, time, tz);
  const end = start.plus({ hours });
  const ls = start.setZone(tz);
  const le = end.setZone(tz);
  // Today onward only, for customers and staff alike; "today" is the business's date, not the caller's.
  const today = DateTime.now().setZone(tz).startOf('day');
  if (ls < today || start < DateTime.utc()) throw badRequest('Bookings cannot start in the past. Choose today or a later date.', 'past_date');
  if (ls.startOf('day') > today.plus({ days: s['booking.maxAdvanceDays'] })) {
    throw badRequest(`Bookings can be made up to ${s['booking.maxAdvanceDays']} days ahead`, 'too_far_ahead');
  }
  if (!opts.skipHours) {
    const open = s['booking.openHour'];
    const close = s['booking.closeHour'];
    if (ls.minute !== 0) throw badRequest('Bookings must start on the hour', 'invalid_start');
    const sameDay = ls.toISODate() === le.toISODate();
    if (isDayBooking(hours)) {
      if (ls.hour < open || ls.hour >= close) throw badRequest(`Day bookings must start between ${open}:00 and ${close}:00`, 'outside_hours');
    } else if (ls.hour < open || !sameDay || le.hour * 60 + le.minute > close * 60) {
      throw badRequest(`Bookings must fall between ${open}:00 and ${close}:00`, 'outside_hours');
    }
  }
  if (!opts.skipLead && start < DateTime.utc().plus({ hours: s['booking.minLeadHours'] })) {
    throw badRequest(`Bookings need at least ${s['booking.minLeadHours']} hours notice`, 'too_soon');
  }
  return slotFor(start, end, bufferMinutes, tz);
}

export const rangeParam = (a: DateTime, b: DateTime) => `[${a.toUTC().toISO()},${b.toUTC().toISO()})`;

export async function lockVehicle(c: C, vehicleId: string) {
  await c.query('SELECT pg_advisory_xact_lock(hashtext($1))', [vehicleId]);
}

export const HOLDING = `('pending','awaiting_payment','confirmed','driver_assigned','in_progress','completed','cancellation_requested')`;

/** Refuses a slot that overlaps another booking, falls inside its preparation buffer, or hits an admin block. */
export async function assertSlotFree(c: C, vehicleId: string, slot: Slot, ignoreBookingId?: string) {
  const range = rangeParam(slot.blockedStart, slot.blockedEnd);
  const withBuffer = rangeParam(slot.start.minus({ minutes: slot.bufferMinutes }), slot.end.plus({ minutes: slot.bufferMinutes }));
  const b = (await c.query(
    `SELECT tstzrange(start_at, end_at) && $4::tstzrange AS overlaps FROM bookings
      WHERE vehicle_id=$1 AND id IS DISTINCT FROM $3 AND status IN ${HOLDING}
        AND (blocked_during && $2::tstzrange OR tstzrange(start_at, end_at) && $5::tstzrange)
      ORDER BY 1 DESC LIMIT 1`,
    [vehicleId, range, ignoreBookingId ?? null, rangeParam(slot.start, slot.end), withBuffer],
  )).rows[0];
  if (b?.overlaps) throw conflict('That time is no longer available for this car', 'slot_unavailable');
  if (b) {
    const h = slot.bufferMinutes % 60 === 0 ? `${slot.bufferMinutes / 60} hour${slot.bufferMinutes === 60 ? '' : 's'}` : `${slot.bufferMinutes} minutes`;
    throw conflict(`That time is too close to another booking for this car. We keep ${h} free before and after every booking to prepare the car.`, 'slot_unavailable');
  }
  const k = await c.query('SELECT reason, kind FROM availability_blocks WHERE vehicle_id=$1 AND during && $2::tstzrange LIMIT 1', [vehicleId, range]);
  if (k.rowCount) throw conflict('This car is not available at that time', 'slot_blocked');
}
