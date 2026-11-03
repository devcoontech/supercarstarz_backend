import { pool } from '../../core/db.js';
import { badRequest } from '../../core/errors.js';
import { drive, geocode, mustGeocode, toMiles, type LatLng, type Place } from '../../lib/maps.js';
import type { Distances } from '../pricing/pricing.js';

/** Distances and coordinates measured by the server. Only this module creates one; a client can never supply it. */
export type Geo = { distances: Distances; address?: Place | null; pickup?: Place | null; dropoff?: Place | null };

export type GeoInput = {
  vehicleId: string;
  eventTypeId?: string | null;
  experience: 'stationary' | 'delivered';
  address?: string | null;
  pickupAddress?: string | null;
  dropoffAddress?: string | null;
  /** Exact points chosen on the map. When present they are used instead of looking the text up again. */
  addressPoint?: LatLng | null;
  pickupPoint?: LatLng | null;
  dropoffPoint?: LatLng | null;
};

/** How far a map pin may be from where its address text points before we refuse it as a different place. */
const PIN_TOLERANCE_KM = 10;

const crowKm = (a: LatLng, b: LatLng) => {
  const r = (d: number) => (d * Math.PI) / 180;
  const h = Math.sin(r(b.lat - a.lat) / 2) ** 2 + Math.cos(r(a.lat)) * Math.cos(r(b.lat)) * Math.sin(r(b.lng - a.lng) / 2) ** 2;
  return 2 * 6371 * Math.asin(Math.sqrt(h));
};

/**
 * A place from the map pin if there is one, otherwise from the typed text. A pin may stand in for an address the
 * map service cannot find (a driveway, a field), but when the text does name a findable place the pin has to be
 * near it: the price is measured from the pin while staff go to the address, so the two must agree.
 */
const placeFor = async (text: string, point: LatLng | null | undefined, what: string): Promise<Place> => {
  if (!point) return mustGeocode(text, what);
  const named = await geocode(text);
  if (named && crowKm(named, point) > PIN_TOLERANCE_KM) {
    throw badRequest(`The map pin for ${what} is not near the address you typed. Move the pin or correct the address.`, 'pin_mismatch');
  }
  return { lat: point.lat, lng: point.lng, label: text.trim() };
};

/**
 * Works out whatever distances a booking needs. Runs BEFORE the booking transaction (it makes network calls),
 * and returns undefined when the booking needs no measuring.
 */
export async function resolveGeo(i: GeoInput): Promise<Geo | undefined> {
  const v = (await pool.query(
    'SELECT delivery_available FROM vehicles WHERE id=$1 AND deleted_at IS NULL', [i.vehicleId])).rows[0];
  if (!v) return undefined; // prepareBooking reports "vehicle not found"
  const ev = i.eventTypeId ? (await pool.query('SELECT pricing_basis FROM event_types WHERE id=$1', [i.eventTypeId])).rows[0] : null;

  if (ev?.pricing_basis === 'distance') {
    if (!i.pickupAddress?.trim() || !i.dropoffAddress?.trim()) throw badRequest('Enter a pick-up and a drop-off address', 'route_required');
    const [pickup, dropoff] = await Promise.all([placeFor(i.pickupAddress, i.pickupPoint, 'the pick-up address'), placeFor(i.dropoffAddress, i.dropoffPoint, 'the drop-off address')]);
    const miles = toMiles((await drive(pickup, dropoff)).km);
    return { distances: { deliveryMiles: null, routeMiles: miles }, pickup, dropoff };
  }

  // Delivery is not measured: staff work out the delivery charge and add it to the booking. A map pin the customer
  // dropped is still kept so the driver can find the place.
  if (i.experience === 'delivered' && i.address?.trim() && v.delivery_available && i.addressPoint) {
    return { distances: { deliveryMiles: null, routeMiles: null }, address: { lat: i.addressPoint.lat, lng: i.addressPoint.lng, label: i.address.trim() } };
  }
  return undefined;
}
