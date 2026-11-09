import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { DateTime } from 'luxon';
import { pool } from '../../core/db.js';
import { notFound } from '../../core/errors.js';
import { applicableAddons } from '../bookings/bookings.js';
import { buildSlot, rangeParam } from '../bookings/slots.js';
import { offerConditions, ruleFromOfferRow } from '../pricing/pricing.js';
import { getSettings } from '../../core/settings.js';
import { quoteRoutes } from '../pricing/quote.routes.js';
import { placeRoutes } from './places.routes.js';


const ACTIVE = `('pending','awaiting_payment','confirmed','driver_assigned','in_progress','completed','cancellation_requested')`;

/**
 * The hourly rate the price engine actually charges when no event-specific rule applies: the car's own hourly rule,
 * else a business-wide hourly rule, else the car's listed price. Shown to customers so listings match quotes.
 */
const HOURLY_RATE = `COALESCE(
  (SELECT r.amount_pence FROM pricing_rules r WHERE r.active AND r.kind = 'hourly' AND r.vehicle_id = v.id AND r.event_type_id IS NULL ORDER BY r.created_at DESC, r.id LIMIT 1),
  (SELECT r.amount_pence FROM pricing_rules r WHERE r.active AND r.kind = 'hourly' AND r.vehicle_id IS NULL AND r.event_type_id IS NULL ORDER BY r.created_at DESC, r.id LIMIT 1),
  v.price_per_hour_pence)`;

/** The car's price per day, when it has a daily rate (its own, else a business-wide one); null = 24 x hourly. */
const DAILY_RATE = `COALESCE(
  (SELECT r.amount_pence FROM pricing_rules r WHERE r.active AND r.kind = 'daily' AND r.vehicle_id = v.id AND r.event_type_id IS NULL ORDER BY r.created_at DESC, r.id LIMIT 1),
  (SELECT r.amount_pence FROM pricing_rules r WHERE r.active AND r.kind = 'daily' AND r.vehicle_id IS NULL AND r.event_type_id IS NULL ORDER BY r.created_at DESC, r.id LIMIT 1))`;

const vehicleSelect = `
  v.id, v.make, v.model, v.year, v.category, v.colour, v.transmission, v.seats, v.power, v.top_speed, v.city, v.area,
  v.description, v.amenities, v.specs, ${HOURLY_RATE} AS price_per_hour_pence, ${DAILY_RATE} AS price_per_day_pence, v.delivery_available, v.delivery_fee_pence, v.delivery_radius_miles, v.delivery_pricing, v.delivery_per_mile_pence, v.delivery_free_miles, v.delivery_min_pence, v.delivery_round_trip, v.chauffeur_charge_type,
  v.stationary_available, v.min_hours, v.max_hours, v.chauffeur_available, v.chauffeur_fee_pence, v.self_drive_available, v.deposit_pence,
  COALESCE((SELECT json_agg(json_build_object('id', i.id, 'url', i.url, 'isCover', i.is_cover) ORDER BY i.is_cover DESC, i.sort_order, i.created_at)
            FROM vehicle_images i WHERE i.vehicle_id = v.id), '[]') AS images,
  COALESCE((SELECT json_agg(json_build_object('id', e.id, 'slug', e.slug, 'title', e.title, 'pricingBasis', e.pricing_basis) ORDER BY e.sort_order)
            FROM vehicle_event_types x JOIN event_types e ON e.id = x.event_type_id
            WHERE x.vehicle_id = v.id AND e.published AND e.archived_at IS NULL), '[]') AS events`;

const publicWhere = `v.published AND v.operational_status='active' AND v.deleted_at IS NULL`;

export async function publicRoutes(app: FastifyInstance) {
  // Price quotes and address lookups for the booking form.
  quoteRoutes(app);
  placeRoutes(app);

  app.get('/vehicles', async (req) => {
    const q = z.object({
      category: z.string().optional(), city: z.string().optional(), make: z.string().optional(),
      seats: z.coerce.number().int().optional(), event: z.string().optional(),
      minPrice: z.coerce.number().int().optional(), maxPrice: z.coerce.number().int().optional(), // pence per hour
      experience: z.enum(['stationary', 'delivered']).optional(),
      q: z.string().max(80).optional(),
      sort: z.enum(['price_asc', 'price_desc', 'newest']).default('newest'),
      date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(), time: z.string().regex(/^\d{2}:\d{2}$/).optional(),
      hours: z.coerce.number().int().min(1).max(24 * 60).optional(),
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
      if (q.hours < 24) where.push(`v.min_hours <= ${q.hours} AND v.max_hours >= ${q.hours}`);
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
      `SELECT kind, label, hours, amount_pence, min_amount_pence, event_type_id FROM pricing_rules WHERE active AND kind IN ('hourly','package','extra_hour','per_mile','daily') AND (vehicle_id=$1 OR vehicle_id IS NULL)`, [id],
    )).rows;
    const s = await getSettings();
    return { ...v, pricing: { rules, serviceFeeBp: s['pricing.serviceFeeBp'], paymentMode: s['payment.mode'], cancellationFreeHours: s['booking.cancellationFreeHours'] } };
  });

  /**
   * Free start times for each day in a range (default 1 day), with the longest booking from each. Uses the same rules
   * as booking creation: today onward in the business timezone, notice period, and the preparation buffer around
   * other bookings. Days before today are returned empty, never as bookable.
   * With `hours` of 24 or more (a day booking), only start times where the car is free for that whole time are listed.
   */
  app.get('/vehicles/:id/availability', async (req) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    const q = z.object({ date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/), days: z.coerce.number().int().min(1).max(60).default(1), hours: z.coerce.number().int().min(24).max(24 * 60).optional() }).parse(req.query);
    const v = (await pool.query(`SELECT id, min_hours, max_hours, buffer_minutes FROM vehicles v WHERE v.id=$1 AND ${publicWhere}`, [id])).rows[0];
    if (!v) throw notFound('Vehicle not found');
    const s = await getSettings();
    const tz = s['booking.timezone'];
    const buf = Math.max(s['booking.bufferMinutes'], v.buffer_minutes);
    const first = DateTime.fromISO(q.date, { zone: tz }).startOf('day');
    const span = Math.ceil((q.hours ?? 0) / 24);
    const range = rangeParam(first.minus({ days: 1 }), first.plus({ days: q.days + 1 + span }));
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
        if (q.hours) {
          // Day booking: the car must be free for the whole stay.
          const st = start.toMillis(), en = start.plus({ hours: q.hours }).toMillis();
          const held = (x: Date, y: Date) => overlaps(st, en + buf * 60_000, x, y);
          const clash = bookings.some((b) => held(b.hs, b.he) || overlaps(st - buf * 60_000, en + buf * 60_000, b.s, b.e)) || blocks.some((k) => held(k.s, k.e));
          if (!clash) slots.push({ time: String(h).padStart(2, '0') + ':00', maxHours: q.hours });
          continue;
        }
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
      company: { name: s['company.name'], supportEmail: s['company.supportEmail'] || null, supportPhone: s['company.supportPhone'] || null, privacyUrl: s['company.privacyUrl'] || null, websiteUrl: s['company.websiteUrl'] || null },
      booking: {
        timezone: s['booking.timezone'], openHour: s['booking.openHour'], closeHour: s['booking.closeHour'], minLeadHours: s['booking.minLeadHours'],
        requireApproval: s['booking.requireApproval'], holdMinutes: s['booking.holdMinutes'],
        cancellationFreeHours: s['booking.cancellationFreeHours'], cancellationLateRefundPercent: s['booking.cancellationLateRefundPercent'],
        bufferMinutes: s['booking.bufferMinutes'], maxAdvanceDays: s['booking.maxAdvanceDays'],
        allowDailyBookings: s['booking.allowDailyBookings'], maxDays: s['booking.maxDays'],
        today: DateTime.now().setZone(s['booking.timezone']).toISODate(),
      },
      delivery: { ratePerMilePence: s['delivery.ratePerMilePence'], showroomFeePence: s['delivery.showroomFeePence'] },
      tax: { enabled: s['tax.enabled'], rateBp: s['tax.enabled'] ? s['tax.rateBp'] : 0, policy: s['tax.policy'], label: s['tax.label'] },
      orders: { maxVehicles: s['booking.maxVehiclesPerOrder'], allowExtensions: s['booking.allowExtensions'] },
      payment: { mode: s['payment.mode'], depositPercentBp: s['payment.depositPercentBp'], serviceFeeBp: s['pricing.serviceFeeBp'] },
      stripe: { publishableKey: s['stripe.publishableKey'] || null },
    };
  });

  /**
   * Public page explaining how to delete a Supercarstars account (Google Play asks for a web link as well as the
   * in-app option). https://api.supercarstars.com/api/public/account-deletion
   */
  app.get('/account-deletion', async (_req, reply) => {
    const s = await getSettings();
    const esc = (v: string) => v.replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch]!);
    const name = esc(s['company.name'] || 'Supercarstars');
    const email = s['company.supportEmail'].trim();
    const contact = email ? `<a href="mailto:${esc(email)}?subject=Delete%20my%20account">${esc(email)}</a>` : 'our support team';
    const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Delete your ${name} account</title><style>body{font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;max-width:680px;margin:0 auto;padding:32px 20px;color:#15161a;line-height:1.55}
h1{font-size:26px}h2{font-size:18px;margin-top:28px}li{margin:6px 0}.box{background:#fff8e1;border:1px solid #f0d27a;border-radius:10px;padding:14px 16px}</style></head><body>
<h1>Delete your ${name} account</h1>
<h2>In the app (quickest)</h2>
<ol><li>Open the ${name} app and sign in.</li><li>Go to <b>Profile</b>, then <b>Delete account</b>.</li><li>Enter your password to confirm. Your account is deleted straight away.</li></ol>
<h2>Without the app</h2>
<p>Email ${contact} from the email address on your account and ask us to delete it. We'll confirm within 30 days.</p>
<h2>What is deleted, and what is kept</h2>
<ul><li><b>Deleted:</b> your name, email address, phone number, postcode and city, your password, notes and occasion details you added to bookings, your notifications and the phones registered for notifications.</li>
<li><b>Kept, without your name or contact details:</b> booking, payment and receipt records, because UK law requires businesses to keep financial records (usually for 6 years).</li></ul>
<p class="box">If you have a booking that is still to come or under way, cancel it or wait until it has finished before deleting your account.</p>
</body></html>`;
    return reply.type('text/html; charset=utf-8').send(html);
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
}
