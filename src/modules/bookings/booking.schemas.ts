import { z } from 'zod';
import { resolveGeo } from './geo.js';
import { badRequest } from '../../core/errors.js';
import { getSettings } from '../../core/settings.js';

const POINT = z.object({ lat: z.number().min(-90).max(90), lng: z.number().min(-180).max(180) }).nullish();

/** One vehicle in a booking request. The same shape for quotes, customer bookings and staff bookings. */
export const itemSchema = z.object({
  vehicleId: z.string().uuid(), eventTypeId: z.string().uuid().nullish(), date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  time: z.string().regex(/^\d{2}:\d{2}$/), hours: z.number().int().min(1).max(24), experience: z.enum(['stationary', 'delivered']),
  address: z.string().max(300).nullish(), children: z.number().int().min(0).max(50).nullish(), occasion: z.string().max(200).nullish(),
  driverOption: z.enum(['with_driver', 'self_drive']).nullish(), chauffeur: z.boolean().optional(),
  addonIds: z.array(z.string().uuid()).max(20).optional(), addons: z.array(z.object({ id: z.string().uuid(), quantity: z.number().int().min(1).max(100).default(1) })).max(20).optional(),
  pickupAddress: z.string().max(300).nullish(), dropoffAddress: z.string().max(300).nullish(),
  addressPoint: POINT, pickupPoint: POINT, dropoffPoint: POINT,
});
export type ItemBody = z.infer<typeof itemSchema>;

export const orderSchema = z.object({
  items: z.array(itemSchema).min(1).max(20),
  offerCode: z.string().max(40).nullish(),
  customerNotes: z.string().max(1000).nullish(),
  consents: z.object({ guardian: z.boolean().optional(), terms: z.boolean().optional(), marketingPhotos: z.boolean().optional() }).nullish(),
});

/**
 * Distances for every vehicle, measured on the server before any transaction starts (they are network calls).
 * The vehicles-per-order limit is checked first, so an oversized request makes no map calls at all.
 */
export async function withGeo<T extends ItemBody>(items: T[]) {
  const max = (await getSettings())['booking.maxVehiclesPerOrder'];
  if (items.length > max) throw badRequest(`Up to ${max} vehicles can be booked together`, 'too_many_items');
  const out = [];
  for (const i of items) out.push({ ...i, geo: await resolveGeo(i) });
  return out;
}
