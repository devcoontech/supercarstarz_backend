import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { tx } from '../../core/db.js';
import { quoteOrder } from '../bookings/orders.js';
import { itemSchema, orderSchema, withGeo } from '../bookings/booking.schemas.js';
import { itemSnapshot } from './pricing.js';

export function quoteRoutes(app: FastifyInstance) {
  const quoteCustomer = async (req: any) => {
    try { await req.jwtVerify(); if (req.user.kind === 'customer') return req.user.sub as string; } catch { /* anonymous quote */ }
    return '00000000-0000-0000-0000-000000000000';
  };

  // Quotes can look addresses up on the map service (shared and possibly paid), so anonymous callers are limited.
  const quoteLimit = { rateLimit: { max: process.env.NODE_ENV === 'test' ? 10000 : 20, timeWindow: '1 minute' } };

  /** Server-side price quote for one car. Same engine as booking creation. Offer codes are validated but not consumed. */
  app.post('/quote', { config: quoteLimit }, async (req) => {
    const b = itemSchema.extend({ offerCode: z.string().max(40).nullish() }).parse(req.body);
    const customerId = await quoteCustomer(req);
    // Distances come from the map service, measured here on the server, before any transaction starts.
    const [item] = await withGeo([b]);
    return tx(async (c) => {
      const q = await quoteOrder(c, { customerId, items: [item], offerCode: b.offerCode });
      const p = q.prepared[0];
      return {
        pricing: itemSnapshot(p.item, q.price.items[0], q.price), order: q.price, available: q.availability[0].available, unavailableReason: q.availability[0].reason,
        driverOption: p.driverOption, startAt: p.slot.start.toISO(), endAt: p.slot.end.toISO(),
        places: { address: item.geo?.address?.label ?? null, pickup: item.geo?.pickup?.label ?? null, dropoff: item.geo?.dropoff?.label ?? null },
      };
    });
  });

  /**
   * Quote for several cars booked together: each car's own price and availability, then the order's offers, tax and
   * total, exactly as the order would be created.
   */
  app.post('/quote-order', { config: quoteLimit }, async (req) => {
    const b = orderSchema.pick({ items: true, offerCode: true }).parse(req.body);
    const customerId = await quoteCustomer(req);
    const items = await withGeo(b.items);
    return tx(async (c) => {
      const q = await quoteOrder(c, { customerId, items, offerCode: b.offerCode });
      return {
        order: q.price,
        available: q.availability.every((a) => a.available),
        items: q.prepared.map((p, n) => ({
          vehicle: { id: p.vehicle.id, make: p.vehicle.make, model: p.vehicle.model, category: p.vehicle.category, pricePerHourPence: p.vehicle.price_per_hour_pence },
          startAt: p.slot.start.toISO(), endAt: p.slot.end.toISO(), hours: items[n].hours, driverOption: p.driverOption, experience: p.experience,
          pricing: itemSnapshot(p.item, q.price.items[n], q.price), available: q.availability[n].available, unavailableReason: q.availability[n].reason,
        })),
      };
    });
  });
}
