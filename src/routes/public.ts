import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { DateTime } from 'luxon';
import { pool, tx } from '../db.js';
import { HttpError, notFound } from '../errors.js';
import { applicableAddons, buildSlot, rangeParam } from '../bookings.js';
import { quoteOrder } from '../orders.js';
import { itemSchema, orderSchema, withGeo } from './schemas.js';
import { itemSnapshot, offerConditions, ruleFromOfferRow } from '../pricing.js';
import { getSettings } from '../settings.js';
import { resolveGeo } from '../geo.js';
import { reverse, suggest } from '../maps.js';

const ACTIVE = `('pending','awaiting_payment','confirmed','driver_assigned','in_progress','completed','cancellation_requested')`;

/**
 * The hourly rate the price engine actually charges when no event-specific rule applies: the car's own hourly rule,
 * else a business-wide hourly rule, else the car's listed price. Shown to customers so listings match quotes.
 */
const HOURLY_RATE = `COALESCE(
  (SELECT r.amount_pence FROM pricing_rules r WHERE r.active AND r.kind = 'hourly' AND r.vehicle_id = v.id AND r.event_type_id IS NULL ORDER BY r.created_at DESC, r.id LIMIT 1),
  (SELECT r.amount_pence FROM pricing_rules r WHERE r.active AND r.kind = 'hourly' AND r.vehicle_id IS NULL AND r.event_type_id IS NULL ORDER BY r.created_at DESC, r.id LIMIT 1),
  v.price_per_hour_pence)`;

const vehicleSelect = `
  v.id, v.make, v.model, v.year, v.category, v.colour, v.transmission, v.seats, v.power, v.top_speed, v.city, v.area,
  v.description, v.amenities, v.specs, ${HOURLY_RATE} AS price_per_hour_pence, v.delivery_available, v.delivery_fee_pence, v.delivery_radius_miles, v.delivery_pricing, v.delivery_per_mile_pence, v.delivery_free_miles, v.delivery_min_pence, v.delivery_round_trip, v.chauffeur_charge_type,
  v.stationary_available, v.min_hours, v.max_hours, v.chauffeur_available, v.chauffeur_fee_pence, v.self_drive_available, v.deposit_pence,
  COALESCE((SELECT json_agg(json_build_object('id', i.id, 'url', i.url, 'isCover', i.is_cover) ORDER BY i.is_cover DESC, i.sort_order, i.created_at)
            FROM vehicle_images i WHERE i.vehicle_id = v.id), '[]') AS images,
  COALESCE((SELECT json_agg(json_build_object('id', e.id, 'slug', e.slug, 'title', e.title, 'pricingBasis', e.pricing_basis) ORDER BY e.sort_order)
            FROM vehicle_event_types x JOIN event_types e ON e.id = x.event_type_id
            WHERE x.vehicle_id = v.id AND e.published AND e.archived_at IS NULL), '[]') AS events`;

const publicWhere = `v.published AND v.operational_status='active' AND v.deleted_at IS NULL`;

const POINT = z.object({ lat: z.number().min(-90).max(90), lng: z.number().min(-180).max(180) }).nullish();

export async function publicRoutes(app: FastifyInstance) {
  app.get('/vehicles', async (req) => {
    const q = z.object({
      category: z.string().optional(), city: z.string().optional(), make: z.string().optional(),
      seats: z.coerce.number().int().optional(), event: z.string().optional(),
      minPrice: z.coerce.number().int().optional(), maxPrice: z.coerce.number().int().optional(), // pence per hour
      experience: z.enum(['stationary', 'delivered']).optional(),
      q: z.string().max(80).optional(),
      sort: z.enum(['price_asc', 'price_desc', 'newest']).default('newest'),
      date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(), time: z.string().regex(/^\d{2}:\d{2}$/).optional(),
      hours: z.coerce.number().int().min(1).max(24).optional(),
      limit: z.coerce.number().int().min(1).max(100).default(50), offset: z.coerce.number().int().min(0).default(0),
    }).parse(req.query);

    const where = [publicWhere];
    const p: unknown[] = [];
    const add = (sql: string, v: unknown) => { p.push(v); where.push(sql.replace('?', '$' + p.length)); };
    if (q.category) add('v.category = ?', q.category);
    if (q.city) add('lower(v.city) = lower(?)', q.city);
    if (q.make) add('lower(v.make) = lower(?)', q.make);
    if (q.seats) add('v.seats >= ?', q.seats);
    if (q.minPrice != null) add(`${HOURLY_RATE} >= ?`, q.minPrice);
    if (q.maxPrice != null) add(`${HOURLY_RATE} <= ?`, q.maxPrice);
    if (q.experience === 'delivered') where.push('v.delivery_available');
    if (q.experience === 'stationary') where.push('v.stationary_available');
    if (q.q) add(`(v.make || ' ' || v.model || ' ' || v.city) ILIKE ?`, `%${q.q}%`);
    if (q.event) {
      p.push(q.event);
      where.push(`EXISTS (SELECT 1 FROM vehicle_event_types x JOIN event_types e ON e.id=x.event_type_id
                   WHERE x.vehicle_id=v.id AND e.published AND e.archived_at IS NULL AND (e.slug = $${p.length} OR e.id::text = $${p.length}))`);
    }
    if (q.date && q.time && q.hours) {
      const s = await getSettings();
      const slot = buildSlot(s, 0, q.date, q.time, q.hours, { skipHours: true, skipLead: true });
      p.push(slot.start.toJSDate(), slot.end.toJSDate(), s['booking.bufferMinutes']);
      const a = p.length - 2, b = p.length - 1, buf = `make_interval(mins => GREATEST($${p.length}::int, v.buffer_minutes))`;
      where.push(`v.min_hours <= ${q.hours} AND v.max_hours >= ${q.hours}`);
      // Same rule as booking creation: clear of other bookings and of the preparation buffer around them.
      const held = `tstzrange($${a}::timestamptz, $${b}::timestamptz + ${buf}, '[)')`;
      const around = `tstzrange($${a}::timestamptz - ${buf}, $${b}::timestamptz + ${buf}, '[)')`;
      where.push(`NOT EXISTS (SELECT 1 FROM bookings bk WHERE bk.vehicle_id=v.id AND bk.status IN ${ACTIVE} AND (bk.blocked_during && ${held} OR tstzrange(bk.start_at, bk.end_at) && ${around}))`);
      where.push(`NOT EXISTS (SELECT 1 FROM availability_blocks ab WHERE ab.vehicle_id=v.id AND ab.during && ${held})`);
    }
    const order = q.sort === 'price_asc' ? `${HOURLY_RATE} ASC` : q.sort === 'price_desc' ? `${HOURLY_RATE} DESC` : 'v.created_at DESC';
    p.push(q.limit, q.offset);
    const rows = (await pool.query(
      `SELECT ${vehicleSelect}, count(*) OVER() AS total FROM vehicles v WHERE ${where.join(' AND ')} ORDER BY ${order} LIMIT $${p.length - 1} OFFSET $${p.length}`, p,
    )).rows;
    return { items: rows.map(({ total, ...r }) => r), total: rows[0]?.total ?? 0 };
  });

  app.get('/vehicles/:id', async (req) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    const v = (await pool.query(`SELECT ${vehicleSelect} FROM vehicles v WHERE v.id=$1 AND ${publicWhere}`, [id])).rows[0];
    if (!v) throw notFound('Vehicle not found');
    const rules = (await pool.query(
      `SELECT kind, label, hours, amount_pence, min_amount_pence, event_type_id FROM pricing_rules WHERE active AND kind IN ('hourly','package','extra_hour','per_mile') AND (vehicle_id=$1 OR vehicle_id IS NULL)`, [id],
    )).rows;
    const s = await getSettings();
    return { ...v, pricing: { rules, serviceFeeBp: s['pricing.serviceFeeBp'], paymentMode: s['payment.mode'], cancellationFreeHours: s['booking.cancellationFreeHours'] } };
  });

  /**
   * Free start times for each day in a range (default 1 day), with the longest booking from each. Uses the same rules
   * as booking creation: today onward in the business timezone, notice period, and the preparation buffer around
   * other bookings. Days before today are returned empty, never as bookable.
   */
  app.get('/vehicles/:id/availability', async (req) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    const q = z.object({ date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/), days: z.coerce.number().int().min(1).max(60).default(1) }).parse(req.query);
    const v = (await pool.query(`SELECT id, min_hours, max_hours, buffer_minutes FROM vehicles v WHERE v.id=$1 AND ${publicWhere}`, [id])).rows[0];
    if (!v) throw notFound('Vehicle not found');
    const s = await getSettings();
    const tz = s['booking.timezone'];
    const buf = Math.max(s['booking.bufferMinutes'], v.buffer_minutes);
    const first = DateTime.fromISO(q.date, { zone: tz }).startOf('day');
    const range = rangeParam(first.minus({ days: 1 }), first.plus({ days: q.days + 1 }));
    const bookings = (await pool.query(
      `SELECT lower(blocked_during) AS hs, upper(blocked_during) AS he, start_at AS s, end_at AS e FROM bookings
        WHERE vehicle_id=$1 AND status IN ${ACTIVE} AND tstzrange(start_at - interval '1 day', upper(blocked_during) + interval '1 day') && $2::tstzrange`, [id, range],
    )).rows as { hs: Date; he: Date; s: Date; e: Date }[];
    const blocks = (await pool.query(`SELECT lower(during) AS s, upper(during) AS e FROM availability_blocks WHERE vehicle_id=$1 AND during && $2::tstzrange`, [id, range])).rows as { s: Date; e: Date }[];
    const overlaps = (a: number, b: number, x: Date, y: Date) => x.getTime() < b && y.getTime() > a;
    const today = DateTime.now().setZone(tz).startOf('day');
    const lastDay = today.plus({ days: s['booking.maxAdvanceDays'] });
    const earliest = DateTime.utc().plus({ hours: s['booking.minLeadHours'] });
    const days = Array.from({ length: q.days }, (_, i) => {
      const dayStart = first.plus({ days: i });
      const slots: { time: string; maxHours: number }[] = [];
      if (dayStart < today || dayStart > lastDay) return { date: dayStart.toISODate()!, slots };
      for (let h = s['booking.openHour']; h < s['booking.closeHour']; h++) {
        const start = dayStart.set({ hour: h }).toUTC();
        if (start < earliest) continue;
        let max = 0;
        for (let n = 1; n <= v.max_hours && h + n <= s['booking.closeHour']; n++) {
          const st = start.toMillis();
          const en = start.plus({ hours: n }).toMillis();
          const held = (x: Date, y: Date) => overlaps(st, en + buf * 60_000, x, y);
          if (bookings.some((b) => held(b.hs, b.he) || overlaps(st - buf * 60_000, en + buf * 60_000, b.s, b.e)) || blocks.some((k) => held(k.s, k.e))) break;
          max = n;
        }
        if (max >= v.min_hours) slots.push({ time: String(h).padStart(2, '0') + ':00', maxHours: max });
      }
      return { date: dayStart.toISODate()!, slots };
    });
    // Single-day shape kept for simple callers.
    return { timezone: tz, today: today.toISODate(), bufferMinutes: buf, minHours: v.min_hours, maxHours: v.max_hours, date: days[0].date, slots: days[0].slots, days };
  });

  /** Everything the customer app needs to know about business rules, with no secrets. */
  app.get('/config', async () => {
    const s = await getSettings();
    return {
      company: { name: s['company.name'], supportEmail: s['company.supportEmail'] || null, supportPhone: s['company.supportPhone'] || null },
      booking: {
        timezone: s['booking.timezone'], openHour: s['booking.openHour'], closeHour: s['booking.closeHour'], minLeadHours: s['booking.minLeadHours'],
        requireApproval: s['booking.requireApproval'], holdMinutes: s['booking.holdMinutes'],
        cancellationFreeHours: s['booking.cancellationFreeHours'], cancellationLateRefundPercent: s['booking.cancellationLateRefundPercent'],
        bufferMinutes: s['booking.bufferMinutes'], maxAdvanceDays: s['booking.maxAdvanceDays'],
        today: DateTime.now().setZone(s['booking.timezone']).toISODate(),
      },
      delivery: { ratePerMilePence: s['delivery.ratePerMilePence'], showroomFeePence: s['delivery.showroomFeePence'] },
      tax: { enabled: s['tax.enabled'], rateBp: s['tax.enabled'] ? s['tax.rateBp'] : 0, policy: s['tax.policy'], label: s['tax.label'] },
      orders: { maxVehicles: s['booking.maxVehiclesPerOrder'], allowExtensions: s['booking.allowExtensions'] },
      payment: { mode: s['payment.mode'], depositPercentBp: s['payment.depositPercentBp'], serviceFeeBp: s['pricing.serviceFeeBp'] },
      stripe: { publishableKey: s['stripe.publishableKey'] || null },
    };
  });

  app.get('/event-types', async () => {
    const rows = (await pool.query(
      `SELECT id, slug, title, description, image_url AS "imageUrl", requirements, min_hours AS "minHours", pricing_basis AS "pricingBasis"
         FROM event_types WHERE published AND archived_at IS NULL ORDER BY sort_order, title`,
    )).rows;
    return { items: rows };
  });

  /** Active add-ons. With ?vehicleId only those offered on that car. */
  app.get('/addons', async (req) => {
    const { vehicleId } = z.object({ vehicleId: z.string().uuid().optional() }).parse(req.query);
    const rows = vehicleId ? await applicableAddons(pool, vehicleId)
      : (await pool.query('SELECT id, name, detail, price_pence, pricing_type, max_quantity, image_url FROM addons WHERE active ORDER BY sort_order, name')).rows;
    return { items: rows.map((a) => ({ id: a.id, name: a.name, detail: a.detail, pricePence: a.price_pence, pricingType: a.pricing_type, maxQuantity: a.max_quantity, imageUrl: a.image_url })) };
  });

  /** Active promotions to show on the home page. Coupon codes are never listed. */
  app.get('/offers', async () => ({
    items: (await pool.query(
      `SELECT * FROM offers WHERE active AND (starts_at IS NULL OR starts_at <= now()) AND (ends_at IS NULL OR ends_at > now())
        ORDER BY auto_apply DESC, priority DESC, created_at DESC`,
    )).rows.map((o) => ({
      id: o.id, title: o.title, description: o.description, imageUrl: o.image_url, discountType: o.discount_type, discountValue: o.discount_value,
      endsAt: o.ends_at, requiresCode: o.code != null, automatic: o.auto_apply, minVehicles: o.min_vehicles, maxVehicles: o.max_vehicles,
      maxDiscountPence: o.max_discount_pence, conditions: offerConditions(ruleFromOfferRow(o)),
    })),
  }));

  app.get('/home', async () => {
    const [featured, recent, events, offers] = await Promise.all([
      pool.query(`SELECT ${vehicleSelect} FROM vehicles v WHERE ${publicWhere}
                  ORDER BY (SELECT count(*) FROM bookings b WHERE b.vehicle_id=v.id AND b.status IN ('confirmed','completed')) DESC, v.created_at DESC LIMIT 6`),
      pool.query(`SELECT ${vehicleSelect} FROM vehicles v WHERE ${publicWhere} ORDER BY v.created_at DESC LIMIT 6`),
      pool.query(`SELECT id, slug, title, description, image_url AS "imageUrl" FROM event_types WHERE published AND archived_at IS NULL ORDER BY sort_order LIMIT 12`),
      pool.query(`SELECT id, title, description, image_url AS "imageUrl", discount_type AS "discountType", discount_value AS "discountValue"
                    FROM offers WHERE active AND (starts_at IS NULL OR starts_at <= now()) AND (ends_at IS NULL OR ends_at > now()) ORDER BY created_at DESC LIMIT 6`),
    ]);
    return { featured: featured.rows, recent: recent.rows, events: events.rows, offers: offers.rows };
  });

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
