import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { pool, tx } from '../../core/db.js';
import { badRequest, notFound } from '../../core/errors.js';
import { audit, buildInsert, buildUpdate } from '../../core/util.js';


const id = z.string().uuid();
const idParams = z.object({ id });

export function addonRoutes(app: FastifyInstance) {
  /* ---------- Add-ons ----------
   * Optional services (photographer, decoration, delivery extras, equipment, anything else). Prices here are today's
   * prices: a booking stores the price agreed when it was made (booking_addons), so changing one never alters a booking. */
  const addonBody = z.object({
    name: z.string().trim().min(1).max(100), detail: z.string().max(300).nullish(), pricePence: z.number().int().min(0).max(10_000_000), active: z.boolean(), sortOrder: z.number().int(),
    imageUrl: z.string().url().max(500).nullish(), pricingType: z.enum(['fixed', 'per_hour', 'per_unit']), maxQuantity: z.number().int().min(1).max(100),
    allVehicles: z.boolean(), vehicleIds: z.array(id).max(500),
  });
  const addonFields = {
    name: 'name', detail: 'detail', pricePence: 'price_pence', active: 'active', sortOrder: 'sort_order', imageUrl: 'image_url', pricingType: 'pricing_type',
    maxQuantity: 'max_quantity', allVehicles: 'all_vehicles',
  };
  const addonSelect = `SELECT a.id, a.name, a.detail, a.price_pence AS "pricePence", a.active, a.sort_order AS "sortOrder", a.image_url AS "imageUrl",
      a.pricing_type AS "pricingType", a.max_quantity AS "maxQuantity", a.all_vehicles AS "allVehicles",
      COALESCE((SELECT json_agg(x.vehicle_id) FROM vehicle_addons x WHERE x.addon_id=a.id), '[]') AS "vehicleIds",
      (SELECT count(*)::int FROM booking_addons ba WHERE ba.addon_id=a.id) AS "timesBooked"
    FROM addons a`;
  const setAddonVehicles = async (c: any, aid: string, vehicleIds: string[] | undefined) => {
    if (!vehicleIds) return;
    await c.query('DELETE FROM vehicle_addons WHERE addon_id=$1', [aid]);
    for (const v of new Set(vehicleIds)) await c.query('INSERT INTO vehicle_addons(vehicle_id, addon_id) VALUES ($1,$2)', [v, aid]);
  };
  app.get('/addons', async () => ({ items: (await pool.query(`${addonSelect} ORDER BY a.sort_order, a.name`)).rows }));
  app.post('/addons', async (req, reply) => {
    const { vehicleIds, ...data } = addonBody.partial().required({ name: true, pricePence: true }).strict().parse(req.body);
    const ins = buildInsert('addons', addonFields, data);
    const out = await tx(async (c) => {
      const r = (await c.query(ins.sql, ins.vals)).rows[0];
      await setAddonVehicles(c, r.id, vehicleIds);
      await audit(c, req.user.sub, 'addon', r.id, 'create', null, { ...r, vehicleIds });
      return (await c.query(`${addonSelect} WHERE a.id=$1`, [r.id])).rows[0];
    });
    return reply.status(201).send(out);
  });
  app.patch('/addons/:id', async (req) => {
    const { id: aid } = idParams.parse(req.params);
    const { vehicleIds, ...data } = addonBody.partial().strict().parse(req.body);
    const u = buildUpdate('addons', aid, addonFields, data);
    if (u.empty && !vehicleIds) throw badRequest('Nothing to update');
    return tx(async (c) => {
      const before = (await c.query(`${addonSelect} WHERE a.id=$1`, [aid])).rows[0];
      if (!before) throw notFound('Add-on not found');
      if (!u.empty) await c.query(u.sql, u.vals);
      await setAddonVehicles(c, aid, vehicleIds);
      const after = (await c.query(`${addonSelect} WHERE a.id=$1`, [aid])).rows[0];
      await audit(c, req.user.sub, 'addon', aid, 'update', before, after);
      return after;
    });
  });

  // Bookings keep their own price snapshot, so removing an extra never changes an existing booking.
  app.delete('/addons/:id', async (req) => {
    const { id: aid } = idParams.parse(req.params);
    const r = await pool.query('DELETE FROM addons WHERE id=$1 RETURNING name', [aid]);
    if (!r.rowCount) throw notFound('Add-on not found');
    await audit(pool, req.user.sub, 'addon', aid, 'delete', r.rows[0], null);
    return { ok: true };
  });
}
