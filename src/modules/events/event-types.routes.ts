import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { pool, tx } from '../../core/db.js';
import { conflict, notFound } from '../../core/errors.js';
import { audit, buildInsert, buildUpdate } from '../../core/util.js';


const id = z.string().uuid();
const idParams = z.object({ id });

const eventFields: Record<string, string> = {
  slug: 'slug', title: 'title', description: 'description', imageUrl: 'image_url', requirements: 'requirements', minHours: 'min_hours', published: 'published', sortOrder: 'sort_order', pricingBasis: 'pricing_basis',
};
const slugify = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 60);

export function eventTypeRoutes(app: FastifyInstance) {
  const eventBody = z.object({
    slug: z.string().regex(/^[a-z0-9-]+$/).max(60), title: z.string().trim().min(1).max(100), description: z.string().max(2000), imageUrl: z.string().url().nullish(),
    requirements: z.record(z.string(), z.unknown()), minHours: z.number().int().min(1).nullish(), published: z.boolean(), sortOrder: z.number().int(), pricingBasis: z.enum(['hourly', 'distance']),
  });

  app.get('/event-types', async () => ({
    items: (await pool.query(
      `SELECT e.*, COALESCE((SELECT json_agg(x.vehicle_id) FROM vehicle_event_types x WHERE x.event_type_id=e.id), '[]') AS vehicle_ids
         FROM event_types e ORDER BY e.archived_at NULLS FIRST, e.sort_order, e.title`)).rows,
  }));

  app.post('/event-types', async (req, reply) => {
    const raw = eventBody.partial().required({ title: true }).strict().parse(req.body);
    const data = { ...raw, slug: raw.slug ?? slugify(raw.title) };
    const ins = buildInsert('event_types', eventFields, data);
    const row = await tx(async (c) => {
      const r = (await c.query(ins.sql, ins.vals)).rows[0];
      await audit(c, req.user.sub, 'event_type', r.id, 'create', null, r);
      return r;
    });
    return reply.status(201).send(row);
  });

  app.patch('/event-types/:id', async (req) => {
    const { id: eid } = idParams.parse(req.params);
    const data = eventBody.partial().strict().parse(req.body);
    return tx(async (c) => {
      const before = (await c.query('SELECT * FROM event_types WHERE id=$1 FOR UPDATE', [eid])).rows[0];
      if (!before) throw notFound('Event type not found');
      const u = buildUpdate('event_types', eid, eventFields, data, false);
      if (u.empty) return before;
      const after = (await c.query(u.sql, u.vals)).rows[0];
      await audit(c, req.user.sub, 'event_type', eid, 'update', before, after);
      return after;
    });
  });

  /** Archive hides it from customers but keeps it on historical bookings. */
  app.post('/event-types/:id/archive', async (req) => {
    const { id: eid } = idParams.parse(req.params);
    const { archived } = z.object({ archived: z.boolean() }).parse(req.body);
    const r = await pool.query(`UPDATE event_types SET archived_at=${archived ? 'now()' : 'NULL'}, published=${archived ? 'false' : 'published'} WHERE id=$1 RETURNING *`, [eid]);
    if (!r.rowCount) throw notFound('Event type not found');
    await audit(pool, req.user.sub, 'event_type', eid, archived ? 'archive' : 'unarchive');
    return r.rows[0];
  });

  app.put('/event-types/order', async (req) => {
    const { ids } = z.object({ ids: z.array(id).min(1).max(200) }).parse(req.body);
    await tx(async (c) => { for (let i = 0; i < ids.length; i++) await c.query('UPDATE event_types SET sort_order=$2 WHERE id=$1', [ids[i], i]); });
    return { ok: true };
  });

  app.put('/event-types/:id/vehicles', async (req) => {
    const { id: eid } = idParams.parse(req.params);
    const { vehicleIds } = z.object({ vehicleIds: z.array(id).max(500) }).parse(req.body);
    return tx(async (c) => {
      if (!(await c.query('SELECT 1 FROM event_types WHERE id=$1', [eid])).rowCount) throw notFound('Event type not found');
      await c.query('DELETE FROM vehicle_event_types WHERE event_type_id=$1', [eid]);
      for (const v of vehicleIds) await c.query('INSERT INTO vehicle_event_types(vehicle_id, event_type_id) VALUES ($1,$2)', [v, eid]);
      await audit(c, req.user.sub, 'event_type', eid, 'set_vehicles', null, vehicleIds);
      return { vehicleIds };
    });
  });

  /** Only event types nobody has booked can be deleted; otherwise archive them (history keeps the label). */
  app.delete('/event-types/:id', async (req) => {
    const { id: eid } = idParams.parse(req.params);
    return tx(async (c) => {
      const ev = (await c.query('SELECT title FROM event_types WHERE id=$1 FOR UPDATE', [eid])).rows[0];
      if (!ev) throw notFound('Event type not found');
      const used = (await c.query('SELECT count(*)::int n FROM bookings WHERE event_type_id=$1', [eid])).rows[0].n;
      if (used) throw conflict(`${used} booking(s) used "${ev.title}". Archive it instead so past bookings keep their label.`, 'has_bookings');
      await c.query('DELETE FROM pricing_rules WHERE event_type_id=$1', [eid]);
      await c.query('DELETE FROM vehicle_event_types WHERE event_type_id=$1', [eid]);
      await c.query('DELETE FROM event_types WHERE id=$1', [eid]);
      await audit(c, req.user.sub, 'event_type', eid, 'delete', ev, null);
      return { ok: true };
    });
  });
}
