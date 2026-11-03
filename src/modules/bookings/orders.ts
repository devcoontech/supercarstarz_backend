import type pg from 'pg';
import { DateTime } from 'luxon';
import { badRequest, conflict, notFound } from '../../core/errors.js';
import { getSettings, type Settings } from '../../core/settings.js';
import {
  addonTotal, isRentalLine, itemSnapshot, priceOrder, ruleFromOfferRow, taxFrom,
  type ItemPrice, type OfferRule, type OrderItemForPricing, type OrderPrice, type OrderSettings, type PriceLine, type TaxConfig,
} from '../pricing/pricing.js';
import { prepareItem, type BookingInput, type Prepared } from './bookings.js';
import { notify } from '../notifications/notify.js';
import { changeStatus } from './status.js';
import { assertSlotFree, lockVehicle, rangeParam } from './slots.js';
import { logEvent, type Actor } from './history.js';
import { activeAutoOffers, promoCodeRule } from '../offers/offer-rules.js';
import { pool } from '../../core/db.js';

type C = pg.PoolClient;

/*
 * Orders. An order is what a customer books and pays for; each booking row is one vehicle in it (an order item) with its
 * own times, status and price. The order holds the money: its total is the sum of its vehicles, and payments, refunds
 * and receipts belong to it. A one-vehicle order behaves exactly like the single bookings that came before.
 *
 * Vehicles that are cancelled or rejected stop counting towards the order (unless every vehicle is, in which case the
 * order keeps its last total for the record), and the remaining vehicles are re-priced so offers and tax stay right.
 */

export const CLOSED_ITEM = ['cancelled', 'rejected'];
export const isLiveItem = (status: string) => !CLOSED_ITEM.includes(status);

/** The overall status of an order, from its vehicles. */
export function orderStatus(items: { status: string }[]): string {
  const live = items.filter((i) => isLiveItem(i.status));
  if (!live.length) return items.some((i) => i.status === 'rejected') && items.every((i) => i.status === 'rejected') ? 'rejected' : 'cancelled';
  const has = (s: string) => live.some((i) => i.status === s);
  if (has('in_progress')) return 'in_progress';
  if (has('cancellation_requested')) return 'cancellation_requested';
  if (has('payment_failed')) return 'payment_failed';
  if (has('pending')) return 'pending';
  if (has('awaiting_payment')) return 'awaiting_payment';
  if (live.every((i) => i.status === 'completed')) return 'completed';
  return 'confirmed';
}

export const orderSettingsFrom = (s: Settings): OrderSettings => ({ serviceFeeBp: s['pricing.serviceFeeBp'], paymentMode: s['payment.mode'], depositPercentBp: s['payment.depositPercentBp'] });

/* ---------- Pricing a new order (with offers) ---------- */
const itemForPricing = (key: string, p: { vehicle: any; eventTypeId: string | null; item: Pick<ItemPrice, 'lines' | 'rentalPence' | 'subtotalPence'> }): OrderItemForPricing => ({
  key, vehicleId: p.vehicle.id, category: p.vehicle.category, eventTypeId: p.eventTypeId, vehicleDepositPence: p.vehicle.deposit_pence,
  lines: p.item.lines, rentalPence: p.item.rentalPence, subtotalPence: p.item.subtotalPence,
});

/**
 * Prices vehicles that are about to be booked together, with automatic offers and an optional promo code. A code that
 * is not valid for these vehicles is an error; a valid code beaten by a better offer is reported in `notApplied`.
 */
export async function priceNewOrder(c: Pick<C, 'query'>, prepared: Prepared[], o: { code?: string | null; customerId: string; lockCode: boolean }) {
  const settings = prepared[0].settings;
  const promo = o.code?.trim() ? await promoCodeRule(c, o.code, o.customerId, o.lockCode) : null;
  const offers = [...(await activeAutoOffers(c, o.customerId)), ...(promo ? [promo] : [])];
  const price = priceOrder(prepared.map((p, i) => itemForPricing(String(i), p)), offers, taxFrom(settings), orderSettingsFrom(settings));
  if (promo) {
    const miss = price.notApplied.find((n) => n.code === promo.code);
    if (miss && !price.offers.length) throw badRequest(miss.reason, 'invalid_offer');
    if (miss && !/better offer/.test(miss.reason)) throw badRequest(miss.reason, 'invalid_offer');
  }
  return price;
}

/* ---------- Creating an order ---------- */

export type OrderItemInput = Omit<BookingInput, 'customerId' | 'offerCode' | 'idempotencyKey'>;
export type OrderInput = {
  customerId: string;
  items: OrderItemInput[];
  offerCode?: string | null;
  customerNotes?: string | null;
  consents?: BookingInput['consents'];
  idempotencyKey?: string | null;
};

const insertBookingSql = `
  INSERT INTO bookings(ref, order_id, customer_id, vehicle_id, event_type_id, status, start_at, end_at, hours, blocked_during, experience, address,
    children, occasion, chauffeur, addon_ids, offer_id, customer_notes, driver_option, pricing_snapshot, total_pence, quoted_total_pence, deposit_due_pence,
    item_subtotal_pence, discount_pence, tax_pence, hold_expires_at, idempotency_key, created_by_staff, consents,
    address_lat, address_lng, pickup_address, pickup_lat, pickup_lng, dropoff_address, dropoff_lat, dropoff_lng, delivery_miles, route_miles, source, currency)
  VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::tstzrange,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$21,$22,$23,$24,$25,$26,$27,$28,$29,
          $30,$31,$32,$33,$34,$35,$36,$37,$38,$39,$40,$41) RETURNING *`;

/** Inserts one vehicle of an order, after checking its time is still free (earlier vehicles of the same order count). */
async function insertItem(
  c: C, p: Prepared, i: OrderItemInput, o: { order: any; ref: string; customerId: string; status: string; hold: Date | null; staffId?: string; idempotencyKey: string | null; notes: string | null; consents: OrderInput['consents'] },
  snapshot: ReturnType<typeof itemSnapshot>,
) {
  await assertSlotFree(c, p.vehicle.id, p.slot);
  try {
    return (await c.query(insertBookingSql, [
      o.ref, o.order.id, o.customerId, p.vehicle.id, p.eventTypeId, o.status, p.slot.start.toJSDate(), p.slot.end.toJSDate(), i.hours,
      rangeParam(p.slot.blockedStart, p.slot.blockedEnd), p.experience, p.experience === 'delivered' ? i.address?.trim() || null : null, i.children ?? null,
      i.occasion?.trim() || null, p.chauffeur, p.addonIds, snapshot.offer?.offerId || null, o.notes, p.driverOption, JSON.stringify(snapshot),
      snapshot.totalPence, snapshot.depositDuePence, snapshot.subtotalPence, snapshot.discountPence, snapshot.vatPence, o.hold, o.idempotencyKey, o.staffId ?? null,
      o.consents ? JSON.stringify({ ...o.consents, at: new Date().toISOString() }) : null,
      i.geo?.address?.lat ?? null, i.geo?.address?.lng ?? null,
      i.geo?.pickup ? i.pickupAddress!.trim() : null, i.geo?.pickup?.lat ?? null, i.geo?.pickup?.lng ?? null,
      i.geo?.dropoff ? i.dropoffAddress!.trim() : null, i.geo?.dropoff?.lat ?? null, i.geo?.dropoff?.lng ?? null,
      i.geo?.distances.deliveryMiles ?? null, i.geo?.distances.routeMiles ?? null, o.staffId ? 'admin' : 'customer_app', 'gbp',
    ])).rows[0];
  } catch (e: any) {
    if (e.code === '23P01') throw conflict('That time is no longer available for this car', 'slot_unavailable');
    throw e;
  }
}

/** Add-ons at the agreed price, and delivery as a pending estimate (never payable until staff confirm it). */
async function insertItemExtras(c: C, row: any, p: Prepared, hours: number) {
  for (const a of p.addons) {
    await c.query(
      `INSERT INTO booking_addons(booking_id, addon_id, name, pricing_type, unit_price_pence, quantity, hours, total_pence, currency) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'gbp')`,
      [row.id, a.id, a.name, a.pricing_type ?? 'fixed', a.price_pence, a.quantity ?? 1, a.pricing_type === 'per_hour' ? hours : null, addonTotal(a, hours)]);
  }
  if (p.experience === 'delivered' && p.item.deliveryEstimate) {
    const e = p.item.deliveryEstimate;
    await c.query(
      `INSERT INTO booking_charges(booking_id, order_id, kind, status, amount_pence, currency, description, address, distance_miles, rate_per_mile_pence, calculated_pence)
       VALUES ($1,$2,'delivery','pending',$3,'gbp',$4,$5,$6,$7,$3)`,
      [row.id, row.order_id, e.amountPence ?? 0, e.label, row.address, e.miles, e.ratePerMilePence]);
  }
}

/** Records the offers an order uses (frozen), and counts their use. Earlier records are kept, marked as superseded. */
async function saveOrderOffers(c: C, orderId: string, firstBookingId: string, customerId: string, price: OrderPrice, rules: OfferRule[]) {
  await c.query('UPDATE order_offers SET superseded_at=now() WHERE order_id=$1 AND superseded_at IS NULL', [orderId]);
  const kept = new Set<string>();
  for (const a of price.offers) {
    const rule = rules.find((r) => r.offerId === a.offerId);
    await c.query(
      `INSERT INTO order_offers(order_id, offer_id, title, code, discount_type, discount_value, applies_to, discount_pence, snapshot) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
      [orderId, a.offerId, a.title, a.code, a.type, a.value, a.appliesTo, a.discountPence, JSON.stringify(rule ?? a)]);
    if (a.offerId) {
      kept.add(a.offerId);
      await c.query(
        `INSERT INTO offer_redemptions(offer_id, order_id, booking_id, customer_id, discount_pence) VALUES ($1,$2,$3,$4,$5)
         ON CONFLICT (order_id, offer_id) DO UPDATE SET discount_pence=EXCLUDED.discount_pence, released_at=NULL`,
        [a.offerId, orderId, firstBookingId, customerId, a.discountPence]);
    }
  }
  await c.query(`UPDATE offer_redemptions SET released_at=now() WHERE order_id=$1 AND released_at IS NULL AND NOT (offer_id = ANY($2::uuid[]))`, [orderId, [...kept]]);
}

/**
 * Creates an order with one or more vehicles, in one transaction. Every vehicle is checked and priced on the server;
 * the cars are locked in a fixed order, so two orders can't take the same car at once (the database constraint backs this up).
 */
export async function createOrder(c: C, o: OrderInput, by: { staffId?: string; status?: 'pending' | 'awaiting_payment' | 'confirmed' } = {}) {
  if (!o.items.length) throw badRequest('Choose at least one vehicle', 'no_items');
  if (o.idempotencyKey) {
    const ex = (await c.query('SELECT * FROM orders WHERE customer_id=$1 AND idempotency_key=$2', [o.customerId, o.idempotencyKey])).rows[0];
    if (ex) return { order: ex, bookings: (await c.query('SELECT * FROM bookings WHERE order_id=$1 ORDER BY created_at, ref', [ex.id])).rows, replay: true };
  }
  const settings = await getSettings(c);
  if (o.items.length > settings['booking.maxVehiclesPerOrder']) throw badRequest(`Up to ${settings['booking.maxVehiclesPerOrder']} vehicles can be booked together`, 'too_many_items');
  const maxOpen = settings['booking.maxOpenUnpaidOrders'];
  if (!by.staffId && maxOpen > 0) {
    // Serialise this customer's order creation so parallel requests cannot slip past the limit.
    await c.query('SELECT 1 FROM customers WHERE id=$1 FOR UPDATE', [o.customerId]);
    const open = (await c.query(
      `SELECT count(*)::int n FROM orders o WHERE o.customer_id=$1 AND o.paid_pence = 0
         AND EXISTS (SELECT 1 FROM bookings b WHERE b.order_id=o.id AND b.status IN ('pending','awaiting_payment'))`, [o.customerId])).rows[0].n;
    if (open >= maxOpen) throw conflict(`You already have ${open} unpaid booking requests. Pay for or cancel one before making another.`, 'too_many_open_orders');
  }
  for (const id of [...new Set(o.items.map((i) => i.vehicleId))].sort()) await lockVehicle(c, id);
  const prepared: Prepared[] = [];
  for (const i of o.items) prepared.push(await prepareItem(c, { ...i, customerId: o.customerId }, !!by.staffId));
  const price = await priceNewOrder(c, prepared, { code: o.offerCode, customerId: o.customerId, lockCode: true });

  const status = by.status ?? (settings['booking.requireApproval'] ? 'pending' : 'awaiting_payment');
  // An unpaid customer request holds cars for everyone else, so it expires (expireHolds) unless staff act first.
  // Requests staff enter themselves are left alone.
  const pendingHours = settings['booking.pendingHoldHours'];
  const hold = status === 'awaiting_payment' ? DateTime.utc().plus({ minutes: settings['booking.holdMinutes'] }).toJSDate()
    : status === 'pending' && !by.staffId && pendingHours > 0 ? DateTime.utc().plus({ hours: pendingHours }).toJSDate() : null;
  const ref = 'SCS-' + (await c.query(`SELECT nextval('booking_ref_seq') AS n`)).rows[0].n;
  const order = (await c.query(
    `INSERT INTO orders(ref, customer_id, source, created_by_staff, currency, pricing_snapshot, subtotal_pence, discount_pence, taxable_pence, tax_pence, fee_pence,
       tax_enabled, tax_rate_bp, tax_policy, tax_label, quoted_total_pence, total_pence, deposit_due_pence, idempotency_key)
     VALUES ($1,$2,$3,$4,'gbp',$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$15,$16,$17) RETURNING *`,
    [ref, o.customerId, by.staffId ? 'admin' : 'customer_app', by.staffId ?? null, JSON.stringify(price), price.subtotalPence, price.discountPence, price.taxablePence,
     price.taxPence, price.serviceFeePence, price.tax.enabled, price.tax.rateBp, price.tax.policy, price.tax.label, price.totalPence, price.depositDuePence, o.idempotencyKey ?? null])).rows[0];

  const rows: any[] = [];
  for (let n = 0; n < prepared.length; n++) {
    const p = prepared[n];
    const row = await insertItem(c, p, o.items[n], {
      order, ref: n === 0 ? ref : `${ref}-${n + 1}`, customerId: o.customerId, status, hold, staffId: by.staffId,
      idempotencyKey: n === 0 ? o.idempotencyKey ?? null : null, notes: o.customerNotes ?? o.items[n].customerNotes ?? null, consents: o.consents ?? o.items[n].consents,
    }, itemSnapshot(p.item, price.items[n], price));
    await insertItemExtras(c, row, p, o.items[n].hours);
    rows.push(row);
  }
  const rules = [...(await activeAutoOffers(c, o.customerId)), ...(o.offerCode?.trim() ? [await promoCodeRule(c, o.offerCode, o.customerId, false).catch(() => null)].filter(Boolean) as OfferRule[] : [])];
  await saveOrderOffers(c, order.id, rows[0].id, o.customerId, price, rules);

  const actor: Actor = by.staffId ? { type: 'staff', id: by.staffId } : { type: 'customer', id: o.customerId };
  for (const r of rows) {
    await logEvent(c, r.id, actor, 'created', { to: status, meta: { totalPence: r.total_pence, orderRef: ref, vehicles: rows.length } });
  }
  // A booking staff create as already confirmed gets the confirmation email, not "please pay to confirm".
  const confirmedNow = status === 'confirmed';
  await notify(c, {
    customerId: o.customerId, bookingId: rows[0].id, kind: confirmedNow ? 'booking_confirmed' : 'booking_received', dedupeKey: `booking_received:${rows[0].id}`,
    title: confirmedNow ? 'Booking confirmed' : status === 'pending' ? 'Booking request received' : 'Booking created',
    body: rows.length > 1 ? `Reference ${ref} (${rows.length} vehicles)` : `Reference ${ref}`,
  });
  return { order, bookings: rows, replay: false };
}

/** What an order would cost, without saving anything: the same checks and the same engine as createOrder. */
export async function quoteOrder(c: C, o: OrderInput, staff = false) {
  if (!o.items.length) throw badRequest('Choose at least one vehicle', 'no_items');
  const prepared: Prepared[] = [];
  for (const i of o.items) prepared.push(await prepareItem(c, { ...i, customerId: o.customerId }, staff));
  const price = await priceNewOrder(c, prepared, { code: o.offerCode, customerId: o.customerId, lockCode: false });
  // Each vehicle's availability, checked with the same rules as booking (earlier vehicles in this order count too).
  const availability: { available: boolean; reason: string | null }[] = [];
  for (let n = 0; n < prepared.length; n++) {
    const p = prepared[n];
    let reason: string | null = null;
    try {
      await assertSlotFree(c, p.vehicle.id, p.slot);
      const clash = prepared.slice(0, n).find((q) => q.vehicle.id === p.vehicle.id && q.slot.start < p.slot.end.plus({ minutes: p.slot.bufferMinutes }) && p.slot.start < q.slot.end.plus({ minutes: q.slot.bufferMinutes }));
      if (clash) reason = 'This car is already in your booking at that time';
    } catch (e: any) {
      if (e.status !== 409) throw e;
      reason = e.message;
    }
    availability.push({ available: !reason, reason });
  }
  return { price, prepared, availability };
}

/* ---------- Money for an order ---------- */

export async function lockOrder(c: C, orderId: string) {
  const o = (await c.query('SELECT * FROM orders WHERE id=$1 FOR UPDATE', [orderId])).rows[0];
  if (!o) throw notFound('Order not found');
  return o;
}

export async function orderIdOf(c: Pick<C, 'query'>, bookingId: string): Promise<string> {
  const r = (await c.query('SELECT order_id FROM bookings WHERE id=$1', [bookingId])).rows[0];
  if (!r) throw notFound('Booking not found');
  return r.order_id;
}

/**
 * The only place an order's total changes after it is made: each vehicle's quoted share plus its confirmed charges
 * (delivery, adjustments), summed over the vehicles still in the order. Then the payment state is worked out again.
 */
export async function recalcOrderTotal(c: C, orderId: string, actor: Actor) {
  await lockOrder(c, orderId);
  const items = (await c.query('SELECT id, status, quoted_total_pence, total_pence, deposit_due_pence FROM bookings WHERE order_id=$1 ORDER BY created_at, ref FOR UPDATE', [orderId])).rows;
  const charges = new Map<string, number>((await c.query(
    `SELECT booking_id, COALESCE(sum(amount_pence),0)::int s FROM booking_charges WHERE order_id=$1 AND status='confirmed' GROUP BY booking_id`, [orderId])).rows.map((r) => [r.booking_id, r.s]));
  for (const it of items) {
    const t = it.quoted_total_pence + (charges.get(it.id) ?? 0);
    if (t < 0) throw conflict('Credits cannot take the booking total below zero', 'negative_total');
    if (t !== it.total_pence) {
      await c.query('UPDATE bookings SET total_pence=$2, updated_at=now() WHERE id=$1', [it.id, t]);
      await logEvent(c, it.id, actor, 'total_changed', { from: String(it.total_pence), to: String(t), meta: { quotedPence: it.quoted_total_pence, chargesPence: charges.get(it.id) ?? 0 } });
      it.total_pence = t;
    }
  }
  const live = items.filter((i) => isLiveItem(i.status));
  const counted = live.length ? live : items;
  const total = counted.reduce((s, i) => s + i.total_pence, 0);
  const quoted = counted.reduce((s, i) => s + i.quoted_total_pence, 0);
  const deposit = Math.min(quoted, counted.reduce((s, i) => s + i.deposit_due_pence, 0));
  await c.query('UPDATE orders SET total_pence=$2, quoted_total_pence=$3, deposit_due_pence=$4, updated_at=now() WHERE id=$1', [orderId, total, quoted, deposit]);
  return applyOrderPaymentState(c, orderId, actor);
}

/**
 * Works out what has been paid on an order from its payments and refunds (only succeeded payments count), sets the
 * payment status, copies it to every vehicle, and confirms vehicles that were waiting for payment once the deposit
 * (or full amount) is in. Returns the order.
 */
export async function applyOrderPaymentState(c: C, orderId: string, actor: Actor) {
  const o = await lockOrder(c, orderId);
  const items = (await c.query('SELECT id, ref, status FROM bookings WHERE order_id=$1 ORDER BY created_at, ref', [orderId])).rows;
  const first = items[0];
  const paid = (await c.query(`SELECT COALESCE(sum(amount_pence),0)::int s FROM payments WHERE order_id=$1 AND status='succeeded'`, [orderId])).rows[0].s;
  const r = (await c.query(
    `SELECT COALESCE(sum(amount_pence),0)::int s, COALESCE(bool_or(status='pending'), false) AS pending FROM refunds WHERE order_id=$1 AND status IN ('pending','succeeded')`, [orderId])).rows[0];
  const refunded = r.s;
  const lastAttempt = (await c.query(`SELECT status FROM payments WHERE order_id=$1 ORDER BY created_at DESC LIMIT 1`, [orderId])).rows[0];
  const net = paid - refunded;
  const ps = r.pending ? 'refund_pending'
    : paid === 0 ? (lastAttempt?.status === 'failed' ? 'payment_failed' : 'unpaid')
    : refunded >= paid ? 'refunded'
    : refunded > 0 ? 'partially_refunded'
    : net >= o.total_pence ? 'paid'
    : o.deposit_due_pence < o.quoted_total_pence && net >= o.deposit_due_pence ? 'deposit_paid'
    : 'partially_paid';
  await c.query('UPDATE orders SET paid_pence=$2, refunded_pence=$3, payment_status=$4, updated_at=now() WHERE id=$1', [orderId, paid, refunded, ps]);
  // Each vehicle shows its order's payment state (amounts are the order's, not per vehicle).
  await c.query('UPDATE bookings SET paid_pence=$2, refunded_pence=$3, payment_status=$4, updated_at=now() WHERE order_id=$1', [orderId, paid, refunded, ps]);
  if (o.payment_status !== ps && first) await logEvent(c, first.id, actor, 'payment_status', { from: o.payment_status, to: ps });

  const allClosed = items.every((i) => !isLiveItem(i.status));
  if (net >= o.deposit_due_pence && o.deposit_due_pence > 0) {
    for (const it of items) if (it.status === 'awaiting_payment') await changeStatus(c, it.id, 'confirmed', actor);
  }
  if (allClosed && paid > o.paid_pence && first) {
    // Money arrived for an order that was already released (e.g. the payment hold expired mid-checkout).
    await logEvent(c, first.id, actor, 'payment_after_release', { meta: { paidPence: paid } });
    await notify(c, { bookingId: first.id, staffOnly: true, kind: 'payment_after_release', title: `Payment received for released booking ${o.ref}`, body: 'Refund or reinstate it.', dedupeKey: `late:${orderId}:${paid}` });
  }
  if (net > o.total_pence && !allClosed && first) {
    await notify(c, { bookingId: first.id, staffOnly: true, kind: 'overpaid', title: `Booking ${o.ref} is overpaid by £${((net - o.total_pence) / 100).toFixed(2)}`, body: 'Refund the difference.', dedupeKey: `overpaid:${orderId}:${net}:${o.total_pence}` });
  }
  return (await c.query('SELECT * FROM orders WHERE id=$1', [orderId])).rows[0];
}

/* ---------- Re-pricing an order (vehicle added or removed, extension) ---------- */

/** A stored vehicle as the order engine sees it, optionally with changed lines (e.g. an extension being priced). */
async function storedItems(c: Pick<C, 'query'>, orderId: string, override?: { bookingId: string; lines: PriceLine[]; hours: number }) {
  const rows = (await c.query(
    `SELECT b.*, v.category, v.deposit_pence AS vehicle_deposit_pence FROM bookings b JOIN vehicles v ON v.id=b.vehicle_id
      WHERE b.order_id=$1 ORDER BY b.created_at, b.ref`, [orderId])).rows;
  return rows.filter((r) => isLiveItem(r.status)).map((r) => {
    const snap = r.pricing_snapshot ?? {};
    const o = override && override.bookingId === r.id ? override : null;
    const lines: PriceLine[] = o ? o.lines : snap.lines ?? [];
    const item: ItemPrice = {
      hours: o ? o.hours : r.hours, lines, durationBasis: snap.durationBasis ?? '', appliedRuleIds: snap.appliedRuleIds ?? [],
      distances: snap.distances ?? { deliveryMiles: null, routeMiles: null }, deliveryEstimate: snap.deliveryEstimate ?? null,
      rentalPence: lines.filter((l) => isRentalLine(l.key)).reduce((s, l) => s + l.amountPence, 0),
      subtotalPence: lines.reduce((s, l) => s + l.amountPence, 0),
    };
    return { row: r, item, forPricing: itemForPricing(r.id, { vehicle: { id: r.vehicle_id, category: r.category, deposit_pence: r.vehicle_deposit_pence }, eventTypeId: r.event_type_id, item }) };
  });
}

/**
 * Offers an existing order is priced with: the automatic offers on now, plus every offer it already had (as saved,
 * so an offer that has since expired or been edited still honours what the customer was given).
 */
async function repriceOffers(c: Pick<C, 'query'>, order: any): Promise<OfferRule[]> {
  const kept = (await c.query('SELECT offer_id, snapshot FROM order_offers WHERE order_id=$1 AND superseded_at IS NULL', [order.id])).rows
    .map((r) => (r.snapshot?.minVehicles != null ? r.snapshot as OfferRule : ruleFromOfferRow({ ...r.snapshot, id: r.offer_id })));
  const auto = (await activeAutoOffers(c, order.customer_id, order.id)).filter((a) => !kept.some((k) => k.offerId === a.offerId));
  return [...kept, ...auto];
}

const orderTax = (o: any): TaxConfig => ({ enabled: o.tax_enabled, rateBp: o.tax_rate_bp, policy: o.tax_policy, label: o.tax_label });

/** The price the order would have with these changes, without saving (used to preview extensions). */
export async function previewOrderPrice(c: Pick<C, 'query'>, order: any, override?: { bookingId: string; lines: PriceLine[]; hours: number }) {
  const items = await storedItems(c, order.id, override);
  if (!items.length) return null;
  const s = order.pricing_snapshot?.settings ?? orderSettingsFrom(await getSettings(c));
  return priceOrder(items.map((i) => i.forPricing), await repriceOffers(c, order), orderTax(order), s);
}

/**
 * Prices the vehicles still in an order again, with the order's own tax settings and offers, and saves each vehicle's
 * new share. Earlier charges and payments are untouched; the change is logged and the balance recalculated.
 */
export async function repriceOrder(c: C, orderId: string, actor: Actor, reason: string, override?: { bookingId: string; lines: PriceLine[]; hours: number }) {
  const order = await lockOrder(c, orderId);
  const items = await storedItems(c, orderId, override);
  if (!items.length) return recalcOrderTotal(c, orderId, actor);
  const rules = await repriceOffers(c, order);
  const s = order.pricing_snapshot?.settings ?? orderSettingsFrom(await getSettings(c));
  const price = priceOrder(items.map((i) => i.forPricing), rules, orderTax(order), s);
  for (let n = 0; n < items.length; n++) {
    const { row, item } = items[n];
    const snap = { ...row.pricing_snapshot, ...itemSnapshot(item, price.items[n], price) };
    await c.query(
      `UPDATE bookings SET pricing_snapshot=$2, quoted_total_pence=$3, deposit_due_pence=$4, item_subtotal_pence=$5, discount_pence=$6, tax_pence=$7, offer_id=$8, updated_at=now() WHERE id=$1`,
      [row.id, JSON.stringify(snap), price.items[n].totalPence, price.items[n].depositPence, price.items[n].subtotalPence, price.items[n].discountPence, price.items[n].taxPence, snap.offer?.offerId || null]);
  }
  await c.query(
    `UPDATE orders SET pricing_snapshot=$2, subtotal_pence=$3, discount_pence=$4, taxable_pence=$5, tax_pence=$6, fee_pence=$7, updated_at=now() WHERE id=$1`,
    [orderId, JSON.stringify(price), price.subtotalPence, price.discountPence, price.taxablePence, price.taxPence, price.serviceFeePence]);
  await saveOrderOffers(c, orderId, items[0].row.id, order.customer_id, price, rules);
  await logEvent(c, items[0].row.id, actor, 'order_repriced', {
    from: String(order.quoted_total_pence), to: String(price.totalPence), reason,
    meta: { discountPence: price.discountPence, taxPence: price.taxPence, offers: price.offers.map((o) => o.title) },
  });
  return recalcOrderTotal(c, orderId, actor);
}

/** Adds a vehicle to an existing order (staff), with the same checks as a new booking, then re-prices the order. */
export async function addOrderItem(c: C, orderId: string, i: OrderItemInput, staffId: string) {
  const order = await lockOrder(c, orderId);
  const existing = (await c.query('SELECT * FROM bookings WHERE order_id=$1 ORDER BY created_at, ref', [orderId])).rows;
  const live = existing.filter((r) => isLiveItem(r.status));
  if (!live.length) throw conflict('This order is closed', 'order_closed');
  if (existing.length >= (await getSettings(c))['booking.maxVehiclesPerOrder']) throw badRequest('This order already has the most vehicles allowed', 'too_many_items');
  await lockVehicle(c, i.vehicleId);
  const p = await prepareItem(c, { ...i, customerId: order.customer_id }, true);
  // Priced alone first; the order re-price below works out its share of discounts and tax.
  const solo = priceOrder([itemForPricing('new', p)], [], orderTax(order), order.pricing_snapshot?.settings ?? orderSettingsFrom(p.settings));
  const status = ['pending', 'awaiting_payment', 'confirmed'].includes(live[0].status) ? live[0].status : 'confirmed';
  const suffix = existing.length + 1;
  const row = await insertItem(c, p, i, {
    order, ref: `${order.ref}-${suffix}`, customerId: order.customer_id, status, hold: live[0].hold_expires_at ?? null, staffId, idempotencyKey: null,
    notes: i.customerNotes ?? null, consents: i.consents ?? null,
  }, itemSnapshot(p.item, solo.items[0], solo));
  await insertItemExtras(c, row, p, i.hours);
  const actor: Actor = { type: 'staff', id: staffId };
  await logEvent(c, row.id, actor, 'added_to_order', { to: status, meta: { orderRef: order.ref } });
  await logEvent(c, live[0].id, actor, 'vehicle_added', { to: `${p.vehicle.make} ${p.vehicle.model}`, meta: { bookingId: row.id, ref: row.ref } });
  await repriceOrder(c, orderId, actor, `Vehicle added: ${p.vehicle.make} ${p.vehicle.model}`);
  await notify(c, { customerId: row.customer_id, bookingId: row.id, kind: 'vehicle_added', title: 'A car was added to your booking', body: `The ${p.vehicle.make} ${p.vehicle.model} is now part of booking ${order.ref}.`, dedupeKey: `vehadd:${row.id}` });
  return (await c.query('SELECT * FROM bookings WHERE id=$1', [row.id])).rows[0];
}

/** Every vehicle in an order with its own price share, plus how the order total was worked out. */
export const orderOverview = async (orderId: string) => {
  const o = (await pool.query('SELECT * FROM orders WHERE id=$1', [orderId])).rows[0];
  if (!o) throw notFound('Order not found');
  const items = (await pool.query(
    `SELECT b.id, b.ref, b.status, b.start_at AS "startAt", b.end_at AS "endAt", b.hours, b.driver_option AS "driverOption", b.experience,
            b.item_subtotal_pence AS "subtotalPence", b.discount_pence AS "discountPence", b.tax_pence AS "taxPence", b.quoted_total_pence AS "quotedPence", b.total_pence AS "totalPence",
            b.pricing_snapshot->'lines' AS lines, v.id AS "vehicleId", v.make || ' ' || v.model AS vehicle, v.category, v.price_per_hour_pence AS "pricePerHourPence",
            (SELECT count(*)::int FROM booking_extensions x WHERE x.booking_id=b.id AND x.status='confirmed') AS extensions
       FROM bookings b JOIN vehicles v ON v.id=b.vehicle_id WHERE b.order_id=$1 ORDER BY b.created_at, b.ref`, [orderId])).rows;
  const offers = (await pool.query(
    `SELECT x.offer_id AS "offerId", x.title, x.code, x.discount_type AS "discountType", x.discount_value AS "discountValue", x.applies_to AS "appliesTo",
            x.discount_pence AS "discountPence", x.snapshot->>'conditions' AS conditions, x.created_at AS "appliedAt"
       FROM order_offers x WHERE x.order_id=$1 AND x.superseded_at IS NULL ORDER BY x.created_at`, [orderId])).rows;
  return {
    id: o.id, ref: o.ref, status: orderStatus(items), items, offers, pricing: o.pricing_snapshot,
    subtotalPence: o.subtotal_pence, discountPence: o.discount_pence, taxablePence: o.taxable_pence, taxPence: o.tax_pence, serviceFeePence: o.fee_pence,
    tax: { enabled: o.tax_enabled, rateBp: o.tax_rate_bp, policy: o.tax_policy, label: o.tax_label },
    quotedTotalPence: o.quoted_total_pence, totalPence: o.total_pence,
  };
};
