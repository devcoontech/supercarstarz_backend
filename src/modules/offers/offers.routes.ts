import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { pool, tx } from '../../core/db.js';
import { badRequest, conflict, notFound } from '../../core/errors.js';
import { audit, buildInsert, buildUpdate } from '../../core/util.js';

const uuid = z.string().uuid();

export function offersRoutes(app: FastifyInstance) {
  const offerBody = z.object({
    code: z.string().trim().min(3).max(40).regex(/^[A-Za-z0-9_-]+$/).nullish(), title: z.string().trim().min(1).max(120), description: z.string().max(1000).nullish(), imageUrl: z.string().url().nullish(),
    discountType: z.enum(['percent', 'fixed']), discountValue: z.number().int().min(1), startsAt: z.string().datetime({ offset: true }).nullish(), endsAt: z.string().datetime({ offset: true }).nullish(),
    usageLimit: z.number().int().min(1).nullish(), perCustomerLimit: z.number().int().min(1).nullish(), minBookingPence: z.number().int().min(0), vehicleIds: z.array(uuid).nullish(), eventTypeIds: z.array(uuid).nullish(), active: z.boolean(),
    // Multi-vehicle offers
    autoApply: z.boolean(), minVehicles: z.number().int().min(1).max(50), maxVehicles: z.number().int().min(1).max(50).nullish(),
    vehicleCategories: z.array(z.enum(['Supercar', 'Convertible', 'SUV', 'Luxury'])).nullish(), requiredVehicleIds: z.array(uuid).max(20).nullish(),
    requiredCategories: z.array(z.enum(['Supercar', 'Convertible', 'SUV', 'Luxury'])).nullish(), maxDiscountPence: z.number().int().min(1).nullish(),
    appliesTo: z.enum(['rental', 'subtotal']), priority: z.number().int().min(-100).max(100), stackable: z.boolean(),
  });
  const offerFields = {
    code: 'code', title: 'title', description: 'description', imageUrl: 'image_url', discountType: 'discount_type', discountValue: 'discount_value', startsAt: 'starts_at', endsAt: 'ends_at',
    usageLimit: 'usage_limit', perCustomerLimit: 'per_customer_limit', minBookingPence: 'min_booking_pence', vehicleIds: 'vehicle_ids', eventTypeIds: 'event_type_ids', active: 'active',
    autoApply: 'auto_apply', minVehicles: 'min_vehicles', maxVehicles: 'max_vehicles', vehicleCategories: 'vehicle_categories', requiredVehicleIds: 'required_vehicle_ids',
    requiredCategories: 'required_categories', maxDiscountPence: 'max_discount_pence', appliesTo: 'applies_to', priority: 'priority', stackable: 'stackable',
  };
  const emptyToNull = (a: unknown) => (Array.isArray(a) && !a.length ? null : a);
  const normOffer = (d: any) => ({
    ...d, code: d.code ? d.code.toUpperCase() : d.code,
    ...(d.autoApply ? { code: null } : {}), // automatic offers have no code
    ...('vehicleIds' in d ? { vehicleIds: emptyToNull(d.vehicleIds) } : {}), ...('eventTypeIds' in d ? { eventTypeIds: emptyToNull(d.eventTypeIds) } : {}),
    ...('vehicleCategories' in d ? { vehicleCategories: emptyToNull(d.vehicleCategories) } : {}), ...('requiredVehicleIds' in d ? { requiredVehicleIds: emptyToNull(d.requiredVehicleIds) } : {}),
    ...('requiredCategories' in d ? { requiredCategories: emptyToNull(d.requiredCategories) } : {}),
  });
  /** Rules that span several fields: checked against the offer as it will be saved. */
  const checkOffer = (o: any) => {
    if (o.discount_type === 'percent' && o.discount_value > 100) throw badRequest('A percentage discount cannot exceed 100', 'invalid_offer');
    if (o.max_vehicles != null && o.max_vehicles < o.min_vehicles) throw badRequest('The maximum number of vehicles must be at least the minimum', 'invalid_offer');
    if (o.starts_at && o.ends_at && new Date(o.ends_at) <= new Date(o.starts_at)) throw badRequest('The offer must end after it starts', 'invalid_offer');
    if (o.auto_apply && o.code) throw badRequest('An automatic offer has no code', 'invalid_offer');
  };
  const offerError = (e: any) => { if (e.code === '23514') throw badRequest('Those offer settings are not valid', 'invalid_offer'); throw e; };

  app.get('/offers', async () => ({
    items: (await pool.query(
      `SELECT o.*, COALESCE(r.uses,0)::int AS uses, COALESCE(r.discount,0)::int AS "discountGivenPence"
         FROM offers o LEFT JOIN (SELECT offer_id, count(*) uses, sum(discount_pence) discount FROM offer_redemptions WHERE released_at IS NULL GROUP BY offer_id) r ON r.offer_id=o.id ORDER BY o.created_at DESC`)).rows,
  }));

  app.post('/offers', async (req, reply) => {
    const data = offerBody.partial().required({ title: true, discountType: true, discountValue: true }).strict().parse(req.body);
    const ins = buildInsert('offers', offerFields, normOffer(data));
    const r = await tx(async (c) => {
      const row = (await c.query(ins.sql, ins.vals).catch(offerError)).rows[0];
      checkOffer(row);
      await audit(c, req.user.sub, 'offer', row.id, 'create', null, row);
      return row;
    });
    return reply.status(201).send(r);
  });

  app.patch('/offers/:id', async (req) => {
    const { id } = z.object({ id: uuid }).parse(req.params);
    const data = offerBody.partial().strict().parse(req.body);
    const u = buildUpdate('offers', id, offerFields, normOffer(data));
    if (u.empty) throw badRequest('Nothing to update');
    // Orders keep the offer as it was when applied (order_offers), so editing an offer never changes existing bookings.
    return tx(async (c) => {
      const before = (await c.query('SELECT * FROM offers WHERE id=$1 FOR UPDATE', [id])).rows[0];
      if (!before) throw notFound('Offer not found');
      const after = (await c.query(u.sql, u.vals).catch(offerError)).rows[0];
      checkOffer(after);
      await audit(c, req.user.sub, 'offer', id, 'update', before, after);
      return after;
    });
  });

  /** Offers that have been used keep their history; deactivate those instead. */
  app.delete('/offers/:id', async (req) => {
    const { id } = z.object({ id: uuid }).parse(req.params);
    const used = (await pool.query('SELECT count(*)::int n FROM offer_redemptions WHERE offer_id=$1', [id])).rows[0].n
      + (await pool.query('SELECT count(*)::int n FROM bookings WHERE offer_id=$1', [id])).rows[0].n;
    if (used) throw conflict('This offer has been used on bookings. Turn it off instead; its history is kept.', 'has_bookings');
    const r = await pool.query('DELETE FROM offers WHERE id=$1 RETURNING title, code', [id]);
    if (!r.rowCount) throw notFound('Offer not found');
    await audit(pool, req.user.sub, 'offer', id, 'delete', r.rows[0], null);
    return { ok: true };
  });
}
