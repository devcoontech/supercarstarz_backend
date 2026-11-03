import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { HttpError } from '../../core/errors.js';
import { reverse, suggest } from '../../lib/maps.js';

export function placeRoutes(app: FastifyInstance) {
  /** The address at a map point, for the map picker. */
  app.get('/reverse', { config: { rateLimit: { max: process.env.NODE_ENV === 'test' ? 10000 : 60, timeWindow: '1 minute' } } }, async (req) => {
    const q = z.object({ lat: z.coerce.number().min(-90).max(90), lng: z.coerce.number().min(-180).max(180) }).parse(req.query);
    const place = await reverse(q);
    if (!place) throw new HttpError(422, 'There is no address at that spot. Move the pin to a road or building.', 'address_not_found');
    return place;
  });

  /** Address search for the booking form. Server-side so the map provider's key stays secret. */
  app.get('/places', { config: { rateLimit: { max: process.env.NODE_ENV === 'test' ? 10000 : 60, timeWindow: '1 minute' } } }, async (req) => {
    const { q } = z.object({ q: z.string().trim().min(3).max(200) }).parse(req.query);
    return { items: await suggest(q, 5) };
  });
}
