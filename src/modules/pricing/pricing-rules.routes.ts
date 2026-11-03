import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { pool, tx } from '../../core/db.js';
import { badRequest, notFound } from '../../core/errors.js';
import { audit, buildInsert, buildUpdate } from '../../core/util.js';


const id = z.string().uuid();
const idParams = z.object({ id });

export function pricingRuleRoutes(app: FastifyInstance) {
  const ruleBody = z.object({
    vehicleId: id.nullish(), eventTypeId: id.nullish(), kind: z.enum(['hourly', 'package', 'extra_hour', 'special_date', 'per_mile']), label: z.string().max(80).nullish(),
    hours: z.number().int().min(1).nullish(), amountPence: z.number().int().min(0).nullish(), minAmountPence: z.number().int().min(0).nullish(), multiplierBp: z.number().int().min(1).max(100000).nullish(),
    startsOn: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullish(), endsOn: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullish(), active: z.boolean().default(true),
  });
  const ruleFields = { vehicleId: 'vehicle_id', eventTypeId: 'event_type_id', kind: 'kind', label: 'label', hours: 'hours', amountPence: 'amount_pence', minAmountPence: 'min_amount_pence', multiplierBp: 'multiplier_bp', startsOn: 'starts_on', endsOn: 'ends_on', active: 'active' };

  app.get('/pricing-rules', async (req) => {
    const q = z.object({ vehicleId: id.optional(), eventTypeId: id.optional() }).parse(req.query);
    return { items: (await pool.query(
      `SELECT id, vehicle_id AS "vehicleId", event_type_id AS "eventTypeId", kind, label, hours, amount_pence AS "amountPence", min_amount_pence AS "minAmountPence", multiplier_bp AS "multiplierBp",
              to_char(starts_on,'YYYY-MM-DD') AS "startsOn", to_char(ends_on,'YYYY-MM-DD') AS "endsOn", active
         FROM pricing_rules WHERE ($1::uuid IS NULL OR vehicle_id=$1) AND ($2::uuid IS NULL OR event_type_id=$2) ORDER BY created_at DESC`,
      [q.vehicleId ?? null, q.eventTypeId ?? null])).rows };
  });

  app.post('/pricing-rules', async (req, reply) => {
    const data = ruleBody.parse(req.body);
    if (data.kind === 'special_date' && data.endsOn! < data.startsOn!) throw badRequest('End date must not be before start date');
    const ins = buildInsert('pricing_rules', ruleFields, data);
    const row = await tx(async (c) => {
      const r = (await c.query(ins.sql, ins.vals)).rows[0];
      await audit(c, req.user.sub, 'pricing_rule', r.id, 'create', null, r);
      return r;
    }).catch((e) => { if (e.code === '23514') throw badRequest('That rule is missing required fields for its type', 'invalid_rule'); throw e; });
    return reply.status(201).send(row);
  });

  app.patch('/pricing-rules/:id', async (req) => {
    const { id: rid } = idParams.parse(req.params);
    const data = ruleBody.partial().strict().parse(req.body);
    const u = buildUpdate('pricing_rules', rid, ruleFields, data, false);
    if (u.empty) throw badRequest('Nothing to update');
    const r = await pool.query(u.sql, u.vals).catch((e) => { if (e.code === '23514') throw badRequest('That rule is missing required fields for its type', 'invalid_rule'); throw e; });
    if (!r.rowCount) throw notFound('Rule not found');
    await audit(pool, req.user.sub, 'pricing_rule', rid, 'update', null, r.rows[0]);
    return r.rows[0];
  });

  app.delete('/pricing-rules/:id', async (req) => {
    const { id: rid } = idParams.parse(req.params);
    // Existing bookings keep their pricing snapshot, so deleting a rule never changes them.
    const r = await pool.query('DELETE FROM pricing_rules WHERE id=$1 RETURNING id', [rid]);
    if (!r.rowCount) throw notFound('Rule not found');
    await audit(pool, req.user.sub, 'pricing_rule', rid, 'delete');
    return { ok: true };
  });
}
