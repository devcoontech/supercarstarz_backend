import type pg from 'pg';
import { DateTime } from 'luxon';
import { badRequest, conflict, HttpError, notFound } from './errors.js';
import { getSettings, type Settings } from './settings.js';
import { loadRules, priceItem, type PriceLine } from './pricing.js';
import { assertSlotFree, effectiveBuffer, lockBooking, lockVehicle, logEvent, notify, rangeParam, slotFor, type Actor } from './bookings.js';
import { lockOrder, previewOrderPrice, repriceOrder } from './orders.js';

type C = pg.PoolClient;

/*
 * Extending a booking: more time on the same vehicle, added to the same booking (never a new one).
 *
 * - Customers can extend upcoming and active bookings that have not ended yet. The whole new period must be free under
 *   the normal rules (other bookings, the preparation buffer, admin blocks, the assigned driver, opening hours and the
 *   car's maximum hours). Availability is checked when the customer asks and again, under the vehicle lock, when the
 *   extension is saved, so two people can never take the same time.
 * - When it isn't possible online the customer can send a request; staff see it, and approving it re-checks everything.
 *   A requested extension changes nothing until it is approved.
 * - Extra time is charged at the car's current rates for the extra hours (plus per-hour driver and add-ons at the
 *   prices agreed on the booking); the order's offers and tax are then worked out again. The difference is added to
 *   the balance, which the customer pays like any other balance.
 */

const EXTENDABLE = ['pending', 'awaiting_payment', 'confirmed', 'driver_assigned', 'in_progress'];
const MAX_EXTENSION_HOURS = 12;
const hhmm = (d: DateTime, tz: string) => d.setZone(tz).toFormat('HH:mm');

type Check = { ok: true } | { ok: false; code: string; reason: string };

/** Things that rule an extension out completely (no request possible either). */
function eligibility(b: any, event: any, s: Settings, staff: boolean) {
  if (!staff && !s['booking.allowExtensions']) throw conflict('Extensions are not available online. Please contact us.', 'extensions_disabled');
  if (!EXTENDABLE.includes(b.status)) throw conflict(`A ${b.status.replaceAll('_', ' ')} booking cannot be extended`, 'not_extendable');
  if (!staff && new Date(b.end_at) <= new Date()) throw conflict('This booking has already ended', 'not_extendable');
  if (event?.pricing_basis === 'distance') throw conflict('Pick-up and drop-off trips are priced by distance and cannot be extended by time', 'not_extendable');
}

/** Can this booking run `hours` longer? Same rules as a new booking; staff may go past opening hours and the car's maximum. */
async function check(c: C, b: any, v: any, s: Settings, hours: number, staff: boolean): Promise<Check> {
  const tz = s['booking.timezone'];
  const start = DateTime.fromJSDate(b.start_at);
  const newEnd = DateTime.fromJSDate(b.end_at).plus({ hours });
  if (!staff) {
    if (b.hours + hours > v.max_hours) return { ok: false, code: 'too_long', reason: `This car can be booked for up to ${v.max_hours} hours in one go.` };
    const ls = start.setZone(tz), le = newEnd.setZone(tz);
    if (ls.toISODate() !== le.toISODate() || le.hour * 60 + le.minute > s['booking.closeHour'] * 60) {
      return { ok: false, code: 'outside_hours', reason: `Bookings must finish by ${s['booking.closeHour']}:00.` };
    }
  }
  try {
    await assertSlotFree(c, v.id, slotFor(start, newEnd, effectiveBuffer(s, v), tz), b.id);
  } catch (e) {
    if (e instanceof HttpError && e.status === 409) return { ok: false, code: 'slot_unavailable', reason: 'The car is already reserved during that time.' };
    throw e;
  }
  if (b.driver_id) {
    const buf = s['driver.bufferMinutes'];
    const busy = (await c.query(
      `SELECT 1 FROM driver_assignments WHERE driver_id=$1 AND active AND booking_id<>$2 AND during && $3::tstzrange LIMIT 1`,
      [b.driver_id, b.id, rangeParam(start.minus({ minutes: buf }), newEnd.plus({ minutes: buf }))])).rowCount;
    if (busy) return { ok: false, code: 'driver_unavailable', reason: 'Your driver has another job straight after this booking.' };
  }
  return { ok: true };
}

/** The longest extension (in whole hours) that passes every check, up to the limit. */
async function longestPossible(c: C, b: any, v: any, s: Settings, staff: boolean) {
  let n = 0;
  while (n < MAX_EXTENSION_HOURS && (await check(c, b, v, s, n + 1, staff)).ok) n++;
  return n;
}

/** The extra charge for `hours` more: rental at the car's current rates, plus per-hour driver and add-ons. */
async function extraLines(c: C, b: any, v: any, s: Settings, hours: number, key: string, newEnd: DateTime): Promise<PriceLine[]> {
  const tz = s['booking.timezone'];
  const rules = await loadRules(c, v.id, b.event_type_id);
  const base = { vehicle: v, rules, eventTypeId: b.event_type_id, localDate: DateTime.fromJSDate(b.start_at).setZone(tz).toISODate()!, experience: 'stationary' as const, chauffeur: false, addons: [], settings: { ...s, 'delivery.showroomFeePence': 0 } };
  const rental = priceItem({ ...base, hours: b.hours + hours }).rentalPence - priceItem({ ...base, hours: b.hours }).rentalPence;
  let extras = 0;
  if (b.chauffeur && v.chauffeur_charge_type === 'hourly') extras += v.chauffeur_fee_pence * hours;
  const perHour = (await c.query(`SELECT COALESCE(sum(unit_price_pence * quantity),0)::int s FROM booking_addons WHERE booking_id=$1 AND pricing_type='per_hour'`, [b.id])).rows[0].s;
  extras += perHour * hours;
  const lines: PriceLine[] = [{ key: `extension:${key}:rental`, label: `Extension: ${hours} more ${hours === 1 ? 'hour' : 'hours'} (to ${hhmm(newEnd, tz)})`, amountPence: Math.max(0, rental) }];
  if (extras) lines.push({ key: `extension:${key}:extras`, label: `Extension: driver and add-ons for ${hours} more ${hours === 1 ? 'hour' : 'hours'}`, amountPence: extras });
  return lines;
}

async function load(c: C, bookingId: string, customerId?: string) {
  const b = (await c.query('SELECT * FROM bookings WHERE id=$1', [bookingId])).rows[0];
  if (!b || (customerId && b.customer_id !== customerId)) throw notFound('Booking not found');
  const v = (await c.query('SELECT * FROM vehicles WHERE id=$1', [b.vehicle_id])).rows[0];
  const event = b.event_type_id ? (await c.query('SELECT pricing_basis FROM event_types WHERE id=$1', [b.event_type_id])).rows[0] : null;
  return { b, v, event };
}

/**
 * What extending by `hours` would mean: whether it's possible (and if not, why, and the most that is), the new end
 * time, and how the order's price, tax and balance change. Nothing is saved.
 */
export async function quoteExtension(c: C, bookingId: string, hours: number, o: { customerId?: string; staff?: boolean } = {}) {
  if (!Number.isInteger(hours) || hours < 1 || hours > MAX_EXTENSION_HOURS) throw badRequest(`Extend by 1 to ${MAX_EXTENSION_HOURS} hours`, 'invalid_hours');
  const s = await getSettings(c);
  const { b, v, event } = await load(c, bookingId, o.customerId);
  eligibility(b, event, s, !!o.staff);
  const tz = s['booking.timezone'];
  const newEnd = DateTime.fromJSDate(b.end_at).plus({ hours });
  const result = await check(c, b, v, s, hours, !!o.staff);
  const max = result.ok ? null : await longestPossible(c, b, v, s, !!o.staff);
  const order = (await c.query('SELECT * FROM orders WHERE id=$1', [b.order_id])).rows[0];
  const lines = await extraLines(c, b, v, s, hours, 'preview', newEnd);
  const preview = await previewOrderPrice(c, order, { bookingId: b.id, lines: [...(b.pricing_snapshot?.lines ?? []), ...lines], hours: b.hours + hours });
  const newTotal = order.total_pence - order.quoted_total_pence + (preview?.totalPence ?? order.quoted_total_pence);
  const net = order.paid_pence - order.refunded_pence;
  let reason: string | null = null;
  if (!result.ok) {
    reason = result.code === 'slot_unavailable' || result.code === 'driver_unavailable'
      ? `${result.reason} ${max ? `You can extend by up to ${max} ${max === 1 ? 'hour' : 'hours'} (until ${hhmm(DateTime.fromJSDate(b.end_at).plus({ hours: max }), tz)}).` : 'It cannot be extended online.'} Contact us to ask for more time or another car.`
      : `${result.reason} ${max ? `You can extend by up to ${max} ${max === 1 ? 'hour' : 'hours'}.` : ''} Contact us if you need longer.`.replace(/\s+/g, ' ').trim();
  }
  return {
    available: result.ok, code: result.ok ? null : result.code, reason, canRequest: !result.ok, maxAvailableHours: result.ok ? null : max,
    currentEndAt: b.end_at, newEndAt: newEnd.toISO(), additionalHours: hours,
    lines, additionalPence: lines.reduce((t, l) => t + l.amountPence, 0),
    previousTotalPence: order.total_pence, newTotalPence: newTotal, priceDifferencePence: newTotal - order.total_pence,
    previousDiscountPence: order.discount_pence, newDiscountPence: preview?.discountPence ?? order.discount_pence,
    previousTaxPence: order.tax_pence, newTaxPence: preview?.taxPence ?? order.tax_pence, taxDifferencePence: (preview?.taxPence ?? order.tax_pence) - order.tax_pence,
    taxLabel: order.tax_label, paidPence: net, balanceAfterPence: Math.max(0, newTotal - net),
  };
}

/**
 * Extends the booking, after checking everything again under the vehicle lock. Throws `extension_unavailable` (409)
 * with the longest possible extension if the time is no longer free; nothing is changed in that case.
 */
export async function applyExtension(c: C, bookingId: string, hours: number, actor: Actor, o: { customerId?: string; staff?: boolean; requestId?: string; reason?: string | null; expectedEndAt?: string } = {}) {
  if (!Number.isInteger(hours) || hours < 1 || hours > MAX_EXTENSION_HOURS) throw badRequest(`Extend by 1 to ${MAX_EXTENSION_HOURS} hours`, 'invalid_hours');
  const pre = (await c.query('SELECT vehicle_id, customer_id FROM bookings WHERE id=$1', [bookingId])).rows[0];
  if (!pre || (o.customerId && pre.customer_id !== o.customerId)) throw notFound('Booking not found');
  await lockVehicle(c, pre.vehicle_id);
  await lockBooking(c, bookingId);
  const s = await getSettings(c);
  const { b, v, event } = await load(c, bookingId);
  // The end time the person saw: if it has moved (a double tap already extended it), change nothing.
  if (o.expectedEndAt && +b.end_at !== +new Date(o.expectedEndAt)) throw conflict('This booking has changed since you looked. Check the new end time.', 'booking_changed');
  eligibility(b, event, s, !!o.staff);
  const order = await lockOrder(c, b.order_id);
  const result = await check(c, b, v, s, hours, !!o.staff);
  if (!result.ok) {
    const max = await longestPossible(c, b, v, s, !!o.staff);
    throw conflict(`${result.reason} ${max ? `It can be extended by up to ${max} ${max === 1 ? 'hour' : 'hours'}.` : 'It cannot be extended at the moment.'}`, 'extension_unavailable', { code: result.code, maxAvailableHours: max });
  }
  const tz = s['booking.timezone'];
  const start = DateTime.fromJSDate(b.start_at);
  const prevEnd = DateTime.fromJSDate(b.end_at);
  const newEnd = prevEnd.plus({ hours });
  const ext = o.requestId
    ? (await c.query(`UPDATE booking_extensions SET status='confirmed', decided_by=$2, decided_at=now(), decision_reason=$3 WHERE id=$1 AND status='requested' RETURNING *`, [o.requestId, actor.type === 'staff' ? actor.id : null, o.reason ?? null])).rows[0]
    : (await c.query(
      `INSERT INTO booking_extensions(booking_id, order_id, status, previous_end_at, requested_end_at, additional_hours, requested_by_type, requested_by, decided_by, decided_at)
       VALUES ($1,$2,'confirmed',$3,$4,$5,$6,$7,$8,CASE WHEN $8::uuid IS NULL THEN NULL ELSE now() END) RETURNING *`,
      [b.id, b.order_id, prevEnd.toJSDate(), newEnd.toJSDate(), hours, actor.type === 'staff' ? 'staff' : 'customer', actor.id ?? null, actor.type === 'staff' ? actor.id : null])).rows[0];
  if (!ext) throw conflict('This request has already been decided', 'already_decided');

  try {
    await c.query('UPDATE bookings SET end_at=$2, hours=$3, blocked_during=$4::tstzrange, updated_at=now() WHERE id=$1',
      [b.id, newEnd.toJSDate(), b.hours + hours, rangeParam(start, newEnd.plus({ minutes: effectiveBuffer(s, v) }))]);
    if (b.driver_id) {
      const buf = s['driver.bufferMinutes'];
      await c.query('UPDATE driver_assignments SET during=$2::tstzrange WHERE booking_id=$1 AND active', [b.id, rangeParam(start.minus({ minutes: buf }), newEnd.plus({ minutes: buf }))]);
    }
  } catch (e: any) {
    if (e.code === '23P01') throw conflict('That time has just been taken. Please try a shorter extension.', 'extension_unavailable', { code: 'slot_unavailable', maxAvailableHours: 0 });
    throw e;
  }
  const lines = await extraLines(c, b, v, s, hours, ext.id, newEnd);
  await c.query(`UPDATE bookings SET pricing_snapshot = jsonb_set(pricing_snapshot, '{lines}', (COALESCE(pricing_snapshot->'lines','[]'::jsonb) || $2::jsonb)), updated_at=now() WHERE id=$1`,
    [b.id, JSON.stringify(lines)]);
  const after = await repriceOrder(c, b.order_id, actor, `Extended ${b.ref} by ${hours} ${hours === 1 ? 'hour' : 'hours'}`);
  const fresh = (await c.query('SELECT tax_pence FROM orders WHERE id=$1', [b.order_id])).rows[0];
  await c.query(
    `UPDATE booking_extensions SET previous_order_total_pence=$2, new_order_total_pence=$3, price_difference_pence=$4, tax_difference_pence=$5 WHERE id=$1`,
    [ext.id, order.total_pence, after.total_pence, after.total_pence - order.total_pence, fresh.tax_pence - order.tax_pence]);
  await logEvent(c, b.id, actor, 'extended', {
    from: prevEnd.toISO(), to: newEnd.toISO(), reason: o.reason ?? null,
    meta: { extensionId: ext.id, hours, priceDifferencePence: after.total_pence - order.total_pence, approvedBy: actor.type === 'staff' ? actor.id : null },
  });
  const owed = Math.max(0, after.total_pence - (after.paid_pence - after.refunded_pence));
  await notify(c, {
    customerId: b.customer_id, bookingId: b.id, kind: 'booking_extended', dedupeKey: `extended:${ext.id}`,
    title: 'Booking extended', body: `${b.ref} now ends at ${hhmm(newEnd, tz)}.${owed ? ` £${(owed / 100).toFixed(2)} left to pay.` : ''}`,
  });
  return { extension: (await c.query('SELECT * FROM booking_extensions WHERE id=$1', [ext.id])).rows[0], order: after };
}

/** When the time isn't free online, the customer asks staff (contact admin). Nothing changes until it is approved. */
export async function requestExtension(c: C, bookingId: string, hours: number, customerId: string, message: string | null) {
  if (!Number.isInteger(hours) || hours < 1 || hours > MAX_EXTENSION_HOURS) throw badRequest(`Ask for 1 to ${MAX_EXTENSION_HOURS} hours`, 'invalid_hours');
  const s = await getSettings(c);
  const { b, v, event } = await load(c, bookingId, customerId);
  if (!EXTENDABLE.includes(b.status)) throw conflict(`A ${b.status.replaceAll('_', ' ')} booking cannot be extended`, 'not_extendable');
  if (event?.pricing_basis === 'distance') throw conflict('Pick-up and drop-off trips cannot be extended by time', 'not_extendable');
  const result = await check(c, b, v, s, hours, false);
  const newEnd = DateTime.fromJSDate(b.end_at).plus({ hours });
  let row;
  try {
    row = (await c.query(
      `INSERT INTO booking_extensions(booking_id, order_id, status, previous_end_at, requested_end_at, additional_hours, conflict_reason, customer_message, requested_by_type, requested_by)
       VALUES ($1,$2,'requested',$3,$4,$5,$6,$7,'customer',$8) RETURNING *`,
      [b.id, b.order_id, b.end_at, newEnd.toJSDate(), hours, result.ok ? null : result.reason, message?.trim() || null, customerId])).rows[0];
  } catch (e: any) {
    if (e.code === '23505') throw conflict('You have already asked to extend this booking. We will be in touch.', 'request_exists');
    throw e;
  }
  const actor: Actor = { type: 'customer', id: customerId };
  await logEvent(c, b.id, actor, 'extension_requested', { to: newEnd.toISO(), reason: message?.trim() || null, meta: { extensionId: row.id, hours, conflict: result.ok ? null : result.code } });
  await notify(c, {
    bookingId: b.id, staffOnly: true, kind: 'extension_requested', dedupeKey: `extreq:${row.id}`,
    title: `Extension request for ${b.ref}`, body: `${hours} more ${hours === 1 ? 'hour' : 'hours'}${result.ok ? '' : `: ${result.reason}`}`,
  });
  await notify(c, {
    customerId, bookingId: b.id, kind: 'extension_requested', dedupeKey: `extreq-c:${row.id}`,
    title: 'Extension request sent', body: `We'll look at ${b.ref} and get back to you. Your booking hasn't changed yet.`,
  });
  return row;
}

/** Staff approve (everything is checked again first) or reject a requested extension. */
export async function decideExtension(c: C, extensionId: string, approve: boolean, staffId: string, reason: string | null, override?: { hours?: number }) {
  const ext = (await c.query('SELECT * FROM booking_extensions WHERE id=$1 FOR UPDATE', [extensionId])).rows[0];
  if (!ext) throw notFound('Extension request not found');
  if (ext.status !== 'requested') throw conflict('This request has already been decided', 'already_decided');
  const actor: Actor = { type: 'staff', id: staffId };
  if (!approve) {
    if (!reason?.trim()) throw badRequest('Give the customer a reason', 'reason_required');
    await c.query(`UPDATE booking_extensions SET status='rejected', decided_by=$2, decided_at=now(), decision_reason=$3 WHERE id=$1`, [extensionId, staffId, reason.trim()]);
    const b = (await c.query('SELECT id, ref, customer_id FROM bookings WHERE id=$1', [ext.booking_id])).rows[0];
    await logEvent(c, b.id, actor, 'extension_rejected', { reason: reason.trim(), meta: { extensionId } });
    await notify(c, { customerId: b.customer_id, bookingId: b.id, kind: 'extension_rejected', dedupeKey: `extrej:${extensionId}`, title: 'Extension not possible', body: reason.trim() });
    return (await extensionsFor(c, '', true, extensionId))[0];
  }
  const hours = override?.hours ?? ext.additional_hours;
  if (hours !== ext.additional_hours) await c.query('UPDATE booking_extensions SET additional_hours=$2, requested_end_at=previous_end_at + make_interval(hours => $2) WHERE id=$1', [extensionId, hours]);
  const cur = (await c.query('SELECT end_at FROM bookings WHERE id=$1', [ext.booking_id])).rows[0];
  if (+cur.end_at !== +ext.previous_end_at) {
    await c.query('UPDATE booking_extensions SET previous_end_at=$2, requested_end_at=$2::timestamptz + make_interval(hours => $3) WHERE id=$1', [extensionId, cur.end_at, hours]);
  }
  await applyExtension(c, ext.booking_id, hours, actor, { staff: true, requestId: extensionId, reason });
  return (await extensionsFor(c, '', true, extensionId))[0];
}

export async function extensionsFor(c: Pick<C, 'query'>, bookingId: string, forStaff: boolean, extensionId?: string) {
  return (await c.query(
    `SELECT x.id, x.booking_id AS "bookingId", x.status, x.previous_end_at AS "previousEndAt", x.requested_end_at AS "requestedEndAt", x.additional_hours AS "additionalHours",
            x.price_difference_pence AS "priceDifferencePence", x.tax_difference_pence AS "taxDifferencePence", x.previous_order_total_pence AS "previousTotalPence",
            x.new_order_total_pence AS "newTotalPence", x.requested_by_type AS "requestedBy", x.created_at AS "createdAt", x.decided_at AS "decidedAt",
            x.decision_reason AS "decisionReason", x.customer_message AS "customerMessage"
            ${forStaff ? ', x.conflict_reason AS "conflictReason", s.name AS "decidedBy"' : ''}
       FROM booking_extensions x LEFT JOIN staff_users s ON s.id=x.decided_by WHERE ${extensionId ? 'x.id=$1' : 'x.booking_id=$1'} ORDER BY x.created_at`, [extensionId ?? bookingId])).rows;
}
