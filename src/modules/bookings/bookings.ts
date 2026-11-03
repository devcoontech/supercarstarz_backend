import type pg from 'pg';
import { conflict, badRequest, notFound } from '../../core/errors.js';
import { loadRules, priceItem, type AddonRow, type ItemPrice } from '../pricing/pricing.js';
import { getSettings, type Settings } from '../../core/settings.js';
import type { Geo } from './geo.js';
import { createOrder } from './orders.js';
import { effectiveBuffer, type Slot, buildSlot } from './slots.js';

type C = pg.PoolClient;

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
