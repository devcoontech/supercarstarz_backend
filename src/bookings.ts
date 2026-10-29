import type pg from 'pg';
import { DateTime } from 'luxon';
import { conflict, badRequest, notFound, HttpError } from './errors.js';
import { loadRules, priceItem, type AddonRow, type ItemPrice } from './pricing.js';
import { getSettings, type Settings } from './settings.js';
import type { Geo } from './geo.js';
import { applyOrderPaymentState, createOrder, isLiveItem, orderIdOf, recalcOrderTotal, repriceOrder } from './orders.js';

type C = pg.PoolClient;

export type Actor = { type: 'staff' | 'customer' | 'system' | 'stripe'; id?: string | null };

/* ---------- Status lifecycle ---------- */

export type BookingStatus =
  | 'pending' | 'awaiting_payment' | 'confirmed' | 'driver_assigned' | 'in_progress'
  | 'completed' | 'cancellation_requested' | 'cancelled' | 'rejected' | 'payment_failed';

/** Allowed manual transitions. Payment success moves awaiting_payment -> confirmed separately (see applyPaymentState). */
export const TRANSITIONS: Record<BookingStatus, BookingStatus[]> = {
  pending: ['awaiting_payment', 'confirmed', 'rejected', 'cancelled', 'cancellation_requested'],
  awaiting_payment: ['confirmed', 'payment_failed', 'cancelled', 'cancellation_requested'],
  payment_failed: ['awaiting_payment', 'cancelled'],
  confirmed: ['driver_assigned', 'in_progress', 'cancellation_requested', 'cancelled'],
  driver_assigned: ['confirmed', 'in_progress', 'cancellation_requested', 'cancelled'],
  in_progress: ['completed'],
  cancellation_requested: ['cancelled', 'confirmed', 'driver_assigned'],
  completed: [],
  cancelled: [],
  rejected: [],
};
export const RELEASING: BookingStatus[] = ['cancelled', 'rejected', 'payment_failed'];

/* ---------- Time ---------- */

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
    if (ls.hour < open || !sameDay || le.hour * 60 + le.minute > close * 60) {
      throw badRequest(`Bookings must fall between ${open}:00 and ${close}:00`, 'outside_hours');
    }
  }
  if (!opts.skipLead && start < DateTime.utc().plus({ hours: s['booking.minLeadHours'] })) {
    throw badRequest(`Bookings need at least ${s['booking.minLeadHours']} hours notice`, 'too_soon');
  }
  return slotFor(start, end, bufferMinutes, tz);
}

export const rangeParam = (a: DateTime, b: DateTime) => `[${a.toUTC().toISO()},${b.toUTC().toISO()})`;

/* ---------- Logging & notifications ---------- */

export async function logEvent(
  c: C, bookingId: string, actor: Actor, action: string,
  o: { from?: string | null; to?: string | null; reason?: string | null; meta?: unknown } = {},
) {
  await c.query(
    `INSERT INTO booking_events(booking_id, actor_type, actor_id, action, from_value, to_value, reason, meta)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
    [bookingId, actor.type, actor.id ?? null, action, o.from ?? null, o.to ?? null, o.reason ?? null, o.meta ? JSON.stringify(o.meta) : null],
  );
}

/** Booking events a customer is also emailed about. Add a kind here and a template in emails.ts to extend. */
export const EMAIL_KINDS = new Set([
  'booking_received', 'booking_awaiting_payment', 'booking_confirmed', 'payment_received', 'booking_cancelled', 'refund', 'charge_confirmed', 'charge_removed',
  // Changes to a booking: emailed with the notification's own title and text.
  'rescheduled', 'vehicle_changed', 'vehicle_added', 'booking_extended', 'extension_rejected', 'driver_assigned',
]);

/**
 * In-app notification, plus (for EMAIL_KINDS) a queued email in the same transaction. The dedupe key makes
 * retried webhooks / double clicks a no-op for both. Sending happens later, in emails.ts, and only after commit.
 */
export async function notify(
  c: C, p: { customerId?: string | null; bookingId?: string; kind: string; title: string; body?: string; dedupeKey: string; staffOnly?: boolean; data?: Record<string, unknown> },
) {
  const r = await c.query(
    `INSERT INTO notifications(customer_id, booking_id, kind, title, body, dedupe_key, staff_only)
     VALUES ($1,$2,$3,$4,$5,$6,$7) ON CONFLICT (dedupe_key) DO NOTHING RETURNING id`,
    [p.customerId ?? null, p.bookingId ?? null, p.kind, p.title, p.body ?? null, p.dedupeKey, p.staffOnly ?? false],
  );
  if (r.rowCount && p.customerId && !p.staffOnly && EMAIL_KINDS.has(p.kind)) {
    await c.query(
      `INSERT INTO email_outbox(notification_id, customer_id, booking_id, kind, payload) VALUES ($1,$2,$3,$4,$5) ON CONFLICT (notification_id) DO NOTHING`,
      [r.rows[0].id, p.customerId, p.bookingId ?? null, p.kind, JSON.stringify({ title: p.title, body: p.body ?? null, ...p.data })],
    );
  }
}

export async function lockVehicle(c: C, vehicleId: string) {
  await c.query('SELECT pg_advisory_xact_lock(hashtext($1))', [vehicleId]);
}

/* ---------- Quote & create ---------- */

export type BookingInput = {
  customerId: string;
  vehicleId: string;
  eventTypeId?: string | null;
  date: string; // yyyy-mm-dd, business timezone
  time: string; // HH:MM
  hours: number;
  experience: 'stationary' | 'delivered';
  address?: string | null;
  children?: number | null;
  occasion?: string | null;
  /** With a driver or self-drive. Older clients send `chauffeur` instead, which maps to the same thing. */
  driverOption?: DriverOption | null;
  chauffeur?: boolean;
  /** Add-ons with a quantity. `addonIds` (quantity 1 each) is still accepted. */
  addons?: { id: string; quantity?: number }[];
  addonIds?: string[];
  offerCode?: string | null;
  customerNotes?: string | null;
  consents?: { guardian?: boolean; terms?: boolean; marketingPhotos?: boolean } | null;
  idempotencyKey?: string | null;
  /** Pick-up and drop-off, for distance-priced events (pick and drop). */
  pickupAddress?: string | null;
  dropoffAddress?: string | null;
  /** Set only by the server (see geo.ts) before the transaction; never read from a request body. */
  geo?: Geo;
};

export type DriverOption = 'with_driver' | 'self_drive';

/** One vehicle checked and priced on its own (order-level offers, tax and fees come later, in orders.ts). */
export type Prepared = {
  vehicle: any; slot: Slot; item: ItemPrice; settings: Settings; addonIds: string[]; addons: AddonRow[];
  chauffeur: boolean; driverOption: DriverOption; experience: 'stationary' | 'delivered'; eventTypeId: string | null;
};

/** Add-ons that are switched on and offered on this car (all cars, or chosen for it in Fleet). */
export async function applicableAddons(c: Pick<C, 'query'>, vehicleId: string, ids?: string[]) {
  return (await c.query(
    `SELECT a.id, a.name, a.detail, a.price_pence, a.pricing_type, a.max_quantity, a.image_url FROM addons a
      WHERE a.active AND (a.all_vehicles OR EXISTS (SELECT 1 FROM vehicle_addons va WHERE va.addon_id=a.id AND va.vehicle_id=$1))
        AND ($2::uuid[] IS NULL OR a.id = ANY($2)) ORDER BY a.sort_order, a.name`, [vehicleId, ids ?? null])).rows;
}

/** Validates one vehicle and prices it on its own. Used by quotes and booking creation, so they cannot disagree. */
export async function prepareItem(c: C, i: BookingInput, staff = false): Promise<Prepared> {
  const settings = await getSettings(c);
  const v = (await c.query('SELECT * FROM vehicles WHERE id=$1 AND deleted_at IS NULL', [i.vehicleId])).rows[0];
  if (!v) throw notFound('Vehicle not found');
  if (!staff && (!v.published || v.operational_status !== 'active')) throw conflict('This car is not available for booking', 'vehicle_unavailable');
  if (v.operational_status !== 'active') throw conflict('This car is not currently in service', 'vehicle_unavailable');
  if (i.hours < v.min_hours || i.hours > v.max_hours) throw badRequest(`This car can be booked for ${v.min_hours} to ${v.max_hours} hours`, 'invalid_duration');

  let eventTypeId: string | null = i.eventTypeId ?? null;
  let eventBasis: 'hourly' | 'distance' = 'hourly';
  if (eventTypeId) {
    const e = (await c.query(
      `SELECT e.*, EXISTS(SELECT 1 FROM vehicle_event_types x WHERE x.vehicle_id=$2 AND x.event_type_id=e.id) AS linked
         FROM event_types e WHERE e.id=$1`, [eventTypeId, v.id])).rows[0];
    if (!e || e.archived_at || (!staff && !e.published)) throw badRequest('That event type is not available', 'invalid_event');
    if (!e.linked) throw badRequest('This car is not offered for that event', 'event_not_supported');
    if (e.min_hours && i.hours < e.min_hours) throw badRequest(`This event needs at least ${e.min_hours} hours`, 'invalid_duration');
    eventBasis = e.pricing_basis;
    if (eventBasis === 'distance' && !v.chauffeur_available) throw badRequest('This car is not offered for pick-up and drop-off trips (it needs a driver)', 'event_not_supported');
  }
  // Pick-up and drop-off trips are always driven by a chauffeur and never delivered.
  const experience: 'stationary' | 'delivered' = eventBasis === 'distance' ? 'stationary' : i.experience;
  const driverOption: DriverOption = eventBasis === 'distance' ? 'with_driver' : i.driverOption ?? (i.chauffeur ? 'with_driver' : 'self_drive');
  if (driverOption === 'with_driver' && !v.chauffeur_available) throw badRequest('This car is only offered self-drive', 'driver_option_unavailable');
  if (driverOption === 'self_drive' && !v.self_drive_available) throw badRequest('This car is only offered with a driver', 'driver_option_unavailable');
  const chauffeur = driverOption === 'with_driver';
  if (eventBasis !== 'distance') {
    if (experience === 'stationary' && !v.stationary_available) throw badRequest('This car is not offered for collection from the showroom', 'experience_unavailable');
    if (experience === 'delivered' && !i.address?.trim()) throw badRequest('An address is required for delivery', 'address_required');
  }

  // Quantities per add-on; the same add-on listed twice is merged.
  const qty = new Map<string, number>();
  for (const id of i.addonIds ?? []) qty.set(id, (qty.get(id) ?? 0) + 1);
  for (const a of i.addons ?? []) qty.set(a.id, (qty.get(a.id) ?? 0) + (a.quantity ?? 1));
  const addonIds = [...qty.keys()];
  const found = addonIds.length ? await applicableAddons(c, v.id, addonIds) : [];
  if (found.length !== addonIds.length) throw badRequest('One of the selected add-ons is not available for this car', 'invalid_addon');
  const addons: AddonRow[] = found.map((a) => {
    const q = qty.get(a.id)!;
    if (!Number.isInteger(q) || q < 1 || q > a.max_quantity) throw badRequest(`${a.name} can be added up to ${a.max_quantity} ${a.max_quantity === 1 ? 'time' : 'times'}`, 'invalid_addon_quantity');
    return { id: a.id, name: a.name, price_pence: a.price_pence, pricing_type: a.pricing_type, quantity: q };
  });

  const slot = buildSlot(settings, effectiveBuffer(settings, v), i.date, i.time, i.hours, { skipLead: staff, skipHours: false });
  const rules = await loadRules(c, v.id, eventTypeId);
  const base = {
    vehicle: v, rules, eventTypeId, hours: i.hours, localDate: slot.localDate, experience, eventBasis,
    distances: i.geo?.distances, chauffeur, addons, settings,
  };
  return { vehicle: v, slot, item: priceItem(base), settings, addonIds, addons, chauffeur, driverOption, experience, eventTypeId };
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

/** A single-vehicle booking: a one-vehicle order. Kept for the existing single-booking endpoints. */
export async function createBooking(
  c: C, i: BookingInput, by: { staffId?: string; status?: 'pending' | 'awaiting_payment' | 'confirmed' } = {},
) {
  if (i.idempotencyKey) {
    // Bookings made before orders existed kept their key on the booking.
    const ex = await c.query('SELECT * FROM bookings WHERE customer_id=$1 AND idempotency_key=$2', [i.customerId, i.idempotencyKey]);
    if (ex.rows[0]) return { booking: ex.rows[0], replay: true };
  }
  const { customerId, offerCode, idempotencyKey, customerNotes, consents, ...item } = i;
  const r = await createOrder(c, { customerId, items: [item], offerCode, idempotencyKey, customerNotes, consents }, by);
  return { booking: r.bookings[0], replay: r.replay };
}

/* ---------- Status changes ---------- */

export async function lockBooking(c: C, id: string) {
  const b = (await c.query('SELECT * FROM bookings WHERE id=$1 FOR UPDATE', [id])).rows[0];
  if (!b) throw notFound('Booking not found');
  return b;
}

async function releaseResources(c: C, b: any, reason: string) {
  await c.query(
    `UPDATE driver_assignments SET active=false, ended_at=now(), ended_reason=$2 WHERE booking_id=$1 AND active`, [b.id, reason],
  );
}

export async function changeStatus(
  c: C, id: string, to: BookingStatus, actor: Actor,
  o: { reason?: string | null; allowUnpaid?: boolean; asCustomer?: boolean } = {},
) {
  const b = await lockBooking(c, id);
  const from = b.status as BookingStatus;
  if (from === to) return b;
  if (!TRANSITIONS[from].includes(to)) throw conflict(`A ${from.replace('_', ' ')} booking cannot become ${to.replace('_', ' ')}`, 'invalid_transition');
  if (to === 'confirmed' && !o.allowUnpaid && from !== 'cancellation_requested' && from !== 'driver_assigned') {
    // The deposit (or full amount) is paid per order, so check the order.
    const ord = (await c.query('SELECT paid_pence, refunded_pence, deposit_due_pence FROM orders WHERE id=$1', [b.order_id])).rows[0];
    if (ord.paid_pence - ord.refunded_pence < ord.deposit_due_pence) {
      throw conflict('Payment has not been received. Confirm anyway by allowing unpaid confirmation with a reason.', 'payment_required');
    }
  }
  if (['cancelled', 'rejected', 'payment_failed', 'cancellation_requested'].includes(to) && !o.reason && actor.type === 'staff' && to !== 'payment_failed') {
    throw badRequest('A reason is required', 'reason_required');
  }
  if (to === 'in_progress' && !b.started_at) await c.query('UPDATE bookings SET started_at=now() WHERE id=$1', [id]);
  if (to === 'completed') await c.query('UPDATE bookings SET completed_at=now(), dispatch_status=\'service_complete\' WHERE id=$1', [id]);
  if (to === 'cancelled' || to === 'rejected') {
    await c.query('UPDATE bookings SET cancelled_at=now(), cancel_reason=$2 WHERE id=$1', [id, o.reason ?? null]);
  }
  const hold = to === 'awaiting_payment' ? DateTime.utc().plus({ minutes: (await getSettings(c))['booking.holdMinutes'] }).toJSDate() : null;
  if (to === 'awaiting_payment' || from === 'awaiting_payment' || from === 'pending') {
    await c.query('UPDATE bookings SET hold_expires_at=$2 WHERE id=$1', [id, hold]);
  }
  let updated;
  try {
    updated = (await c.query('UPDATE bookings SET status=$2, updated_at=now() WHERE id=$1 RETURNING *', [id, to])).rows[0];
  } catch (e: any) {
    if (e.code === '23P01') throw conflict('That time has since been taken by another booking', 'slot_unavailable');
    throw e;
  }
  if (RELEASING.includes(to)) await releaseResources(c, b, `Booking ${to}`);
  await logEvent(c, id, actor, 'status_changed', { from, to, reason: o.reason });
  if (!isLiveItem(to) && isLiveItem(from)) {
    const siblings = (await c.query('SELECT status FROM bookings WHERE order_id=$1 AND id<>$2', [b.order_id, id])).rows;
    if (siblings.some((x) => isLiveItem(x.status))) {
      // One vehicle of a bigger order: the others carry on, re-priced without it (offers and tax may change).
      await repriceOrder(c, b.order_id, actor, `${to === 'rejected' ? 'Vehicle rejected' : 'Vehicle cancelled'}: ${b.ref}`);
    } else {
      // The whole order is closed: give back any offer uses.
      await c.query('UPDATE offer_redemptions SET released_at = now() WHERE order_id=$1 AND released_at IS NULL', [b.order_id]);
    }
  }
  const titles: Partial<Record<BookingStatus, string>> = {
    awaiting_payment: 'Booking approved: payment needed', confirmed: 'Booking confirmed', rejected: 'Booking declined',
    cancelled: 'Booking cancelled', in_progress: 'Your experience has started', completed: 'Booking completed',
  };
  if (titles[to]) {
    await notify(c, { customerId: b.customer_id, bookingId: id, kind: 'booking_' + to, title: titles[to]!, body: `Reference ${b.ref}`, dedupeKey: `status:${id}:${to}:${from}` });
  }
  return updated;
}

/** Recalculates the total of the order this booking belongs to (see orders.ts). Returns the order. */
export async function recalcTotal(c: C, bookingId: string, actor: Actor) {
  return recalcOrderTotal(c, await orderIdOf(c, bookingId), actor);
}

/** Works out the payment state of the order this booking belongs to (see orders.ts). Returns the order. */
export async function applyPaymentState(c: C, bookingId: string, actor: Actor) {
  return applyOrderPaymentState(c, await orderIdOf(c, bookingId), actor);
}

/**
 * Cancels unpaid bookings whose hold ran out: an unpaid 'awaiting_payment' booking, or a customer request that
 * staff did not approve in time. Safe to run repeatedly.
 */
export async function expireHolds(c: C): Promise<number> {
  const rows = (await c.query(
    `SELECT id, status FROM bookings WHERE status IN ('awaiting_payment','pending') AND hold_expires_at < now() AND paid_pence = 0
       AND NOT EXISTS (SELECT 1 FROM payments p WHERE p.order_id = bookings.order_id AND p.status='pending' AND p.created_at > now() - interval '10 minutes')`,
  )).rows;
  for (const r of rows) {
    const reason = r.status === 'pending' ? 'Request expired before it was approved' : 'Payment hold expired';
    await changeStatus(c, r.id, 'cancelled', { type: 'system' }, { reason });
  }
  return rows.length;
}

/** Refund the customer is due under the cancellation policy if they cancel now (preview only). */
export function policyRefund(b: { start_at: Date; paid_pence: number; refunded_pence: number }, s: Settings, now = new Date()) {
  const hoursAhead = (b.start_at.getTime() - now.getTime()) / 3_600_000;
  const net = b.paid_pence - b.refunded_pence;
  const pct = hoursAhead >= s['booking.cancellationFreeHours'] ? 100 : s['booking.cancellationLateRefundPercent'];
  return { percent: pct, refundPence: Math.floor((net * pct) / 100), hoursAhead: Math.floor(hoursAhead) };
}

export { HttpError };
