import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { DateTime } from 'luxon';
import { pool } from '../../core/db.js';
import { notFound } from '../../core/errors.js';
import { getSettings } from '../../core/settings.js';
import { audit } from '../../core/util.js';

const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

const LIVE = `('confirmed','driver_assigned','in_progress','completed')`;

const csvCell = (v: unknown) => {
  let s = v == null ? '' : v instanceof Date ? v.toISOString() : typeof v === 'object' ? JSON.stringify(v) : String(v);
  if (/^[=+\-@\t\r]/.test(s)) s = "'" + s; // neutralise spreadsheet formula injection
  // Quote any cell with a line break (CR too): unquoted, a spreadsheet could start a new row there with a formula.
  return /[",\r\n]/.test(s) ? '"' + s.replaceAll('"', '""') + '"' : s;
};

export const toCsv = (rows: Record<string, unknown>[]) =>
  rows.length ? [Object.keys(rows[0]).join(','), ...rows.map((r) => Object.values(r).map(csvCell).join(','))].join('\n') : '';

export function reportsRoutes(app: FastifyInstance) {
  /* ---------- Dashboard ---------- */
  app.get('/dashboard', async (req) => {
    const q = z.object({ from: date.optional(), to: date.optional() }).parse(req.query);
    const s = await getSettings();
    const tz = s['booking.timezone'];
    const to = q.to ? DateTime.fromISO(q.to, { zone: tz }).plus({ days: 1 }) : DateTime.now().setZone(tz).plus({ days: 1 }).startOf('day');
    const from = q.from ? DateTime.fromISO(q.from, { zone: tz }) : to.minus({ days: 30 });
    const range = [from.toUTC().toJSDate(), to.toUTC().toJSDate()];
    const one = async (sql: string, params: unknown[] = []) => (await pool.query(sql, params)).rows[0];

    const [fleet, counts, money, outstanding, refunds, attention, upcoming, availableNow] = await Promise.all([
      one(`SELECT count(*)::int total, count(*) FILTER (WHERE operational_status='active')::int active,
                  count(*) FILTER (WHERE operational_status<>'active')::int inactive, count(*) FILTER (WHERE published)::int published
             FROM vehicles WHERE deleted_at IS NULL`),
      pool.query(`SELECT status, count(*)::int n FROM bookings WHERE start_at >= $1 AND start_at < $2 GROUP BY status`, range),
      one(`SELECT COALESCE(sum(total_pence) FILTER (WHERE status IN ${LIVE}),0)::int AS "grossBookingValuePence" FROM bookings WHERE start_at >= $1 AND start_at < $2`, range),
      one(`SELECT COALESCE(sum(o.total_pence - (o.paid_pence - o.refunded_pence)) FILTER (WHERE o.total_pence > o.paid_pence - o.refunded_pence),0)::int AS p
             FROM orders o WHERE EXISTS (SELECT 1 FROM bookings b WHERE b.order_id=o.id AND b.status IN ('confirmed','driver_assigned','in_progress','completed'))`),
      one(`SELECT COALESCE(sum(amount_pence) FILTER (WHERE status IN ('succeeded','pending')),0)::int AS "refundedPence" FROM refunds WHERE created_at >= $1 AND created_at < $2`, range),
      one(`SELECT count(*)::int n FROM bookings WHERE chauffeur AND driver_id IS NULL AND status IN ('confirmed','driver_assigned') AND start_at > now() AND start_at < now() + interval '7 days'`),
      pool.query(`SELECT b.id, b.ref, b.start_at AS "startAt", b.status, v.make || ' ' || v.model AS vehicle, c.name AS customer FROM bookings b JOIN vehicles v ON v.id=b.vehicle_id JOIN customers c ON c.id=b.customer_id
                   WHERE b.start_at > now() AND b.start_at < now() + interval '7 days' AND b.status IN ('confirmed','driver_assigned','pending','awaiting_payment') ORDER BY b.start_at LIMIT 20`),
      one(`SELECT count(*)::int n FROM vehicles v WHERE v.deleted_at IS NULL AND v.operational_status='active'
             AND NOT EXISTS (SELECT 1 FROM bookings b WHERE b.vehicle_id=v.id AND b.status IN ('confirmed','driver_assigned','in_progress') AND tstzrange(b.start_at,b.end_at) @> now())
             AND NOT EXISTS (SELECT 1 FROM availability_blocks k WHERE k.vehicle_id=v.id AND k.during @> now())`),
    ]);
    const collected = await one(`SELECT COALESCE(sum(amount_pence),0)::int AS p FROM payments WHERE status='succeeded' AND COALESCE(paid_at, created_at) >= $1 AND COALESCE(paid_at, created_at) < $2`, range);
    const byStatus = Object.fromEntries(counts.rows.map((r) => [r.status, r.n]));
    const perDay = (await pool.query(
      `SELECT to_char(d.day,'YYYY-MM-DD') AS day,
              (SELECT count(*)::int FROM bookings b WHERE (b.start_at AT TIME ZONE $3)::date = d.day AND b.status NOT IN ('cancelled','rejected','payment_failed')) AS bookings,
              (SELECT COALESCE(sum(p.amount_pence),0)::int FROM payments p WHERE p.status='succeeded' AND (COALESCE(p.paid_at, p.created_at) AT TIME ZONE $3)::date = d.day) AS "collectedPence"
         FROM generate_series(($1::timestamptz AT TIME ZONE $3)::date, (($2::timestamptz AT TIME ZONE $3)::date - 1), interval '1 day') AS d(day) ORDER BY d.day`, [...range, tz])).rows;
    const util = (await pool.query(
      `SELECT v.id, v.make || ' ' || v.model AS name,
              COALESCE(sum(EXTRACT(EPOCH FROM (LEAST(b.end_at,$2) - GREATEST(b.start_at,$1)))/3600) FILTER (WHERE b.id IS NOT NULL),0)::float AS "bookedHours"
         FROM vehicles v LEFT JOIN bookings b ON b.vehicle_id=v.id AND b.status IN ${LIVE} AND b.start_at < $2 AND b.end_at > $1
        WHERE v.deleted_at IS NULL AND v.operational_status='active' GROUP BY v.id ORDER BY "bookedHours" DESC LIMIT 10`, range)).rows;
    const days = Math.max(1, Math.round(to.diff(from, 'days').days));
    const openHoursPerDay = s['booking.closeHour'] - s['booking.openHour'];
    return {
      range: { from: from.toISODate(), to: to.minus({ days: 1 }).toISODate(), timezone: tz },
      // Definitions: gross = value of live bookings starting in range; collected = succeeded payments received in range;
      // refunded = refunds issued in range; net = collected - refunded; outstanding = unpaid balance on live bookings (all time).
      money: {
        grossBookingValuePence: money.grossBookingValuePence, collectedPence: collected.p, refundedPence: refunds.refundedPence,
        netCollectedPence: collected.p - refunds.refundedPence, outstandingPence: outstanding.p,
      },
      fleet: { ...fleet, availableNow: availableNow.n },
      bookings: {
        byStatus, pending: byStatus.pending ?? 0, confirmed: (byStatus.confirmed ?? 0) + (byStatus.driver_assigned ?? 0), ongoing: byStatus.in_progress ?? 0,
        completed: byStatus.completed ?? 0, cancelled: (byStatus.cancelled ?? 0) + (byStatus.rejected ?? 0),
      },
      attention: { driverAssignmentsNeeded: attention.n },
      upcoming: upcoming.rows,
      perDay,
      utilization: util.map((u) => ({ ...u, percent: Math.min(100, Math.round((u.bookedHours / (days * openHoursPerDay)) * 1000) / 10) })),
    };
  });

  /* ---------- Reports ---------- */
  const reports: Record<string, string> = {
    'bookings-by-event': `SELECT COALESCE(e.title,'(no event)') AS event, count(*)::int AS bookings, COALESCE(sum(b.total_pence) FILTER (WHERE b.status IN ${LIVE}),0)::int AS "valuePence"
        FROM bookings b LEFT JOIN event_types e ON e.id=b.event_type_id WHERE b.start_at >= $1 AND b.start_at < $2 GROUP BY e.title ORDER BY bookings DESC`,
    'bookings-by-vehicle': `SELECT v.make || ' ' || v.model AS vehicle, count(*)::int AS bookings, COALESCE(sum(b.total_pence) FILTER (WHERE b.status IN ${LIVE}),0)::int AS "valuePence"
        FROM bookings b JOIN vehicles v ON v.id=b.vehicle_id WHERE b.start_at >= $1 AND b.start_at < $2 AND b.status NOT IN ('cancelled','rejected','payment_failed') GROUP BY v.id ORDER BY bookings DESC`,
    'payments-collected': `SELECT to_char(COALESCE(p.paid_at, p.created_at),'YYYY-MM-DD') AS day, p.source, p.method, count(*)::int AS payments, sum(p.amount_pence)::int AS "amountPence"
        FROM payments p WHERE p.status='succeeded' AND COALESCE(p.paid_at, p.created_at) >= $1 AND COALESCE(p.paid_at, p.created_at) < $2 GROUP BY 1,2,3 ORDER BY 1`,
    'outstanding-balances': `SELECT o.ref, c.name AS customer, (SELECT count(*)::int FROM bookings x WHERE x.order_id=o.id AND x.status NOT IN ('cancelled','rejected')) AS vehicles,
        (SELECT min(x.start_at) FROM bookings x WHERE x.order_id=o.id) AS "startAt", o.total_pence AS "totalPence", (o.paid_pence-o.refunded_pence) AS "netPaidPence",
        (o.total_pence-(o.paid_pence-o.refunded_pence)) AS "outstandingPence" FROM orders o JOIN customers c ON c.id=o.customer_id
        WHERE EXISTS (SELECT 1 FROM bookings x WHERE x.order_id=o.id AND x.status IN ('confirmed','driver_assigned','in_progress','completed') AND x.start_at >= $1 AND x.start_at < $2)
          AND o.total_pence > o.paid_pence-o.refunded_pence ORDER BY 4`,
    'offers-applied': `SELECT x.title, x.code, count(DISTINCT x.order_id)::int AS orders, COALESCE(sum(x.discount_pence),0)::int AS "discountPence" FROM order_offers x
        WHERE x.superseded_at IS NULL AND x.created_at >= $1 AND x.created_at < $2 GROUP BY x.title, x.code ORDER BY "discountPence" DESC`,
    'tax-collected': `SELECT o.ref, o.tax_label AS label, o.tax_rate_bp AS "rateBp", o.taxable_pence AS "taxablePence", o.tax_pence AS "taxPence", o.created_at AS "createdAt"
        FROM orders o WHERE o.tax_pence > 0 AND o.created_at >= $1 AND o.created_at < $2
          AND EXISTS (SELECT 1 FROM bookings x WHERE x.order_id=o.id AND x.status NOT IN ('cancelled','rejected')) ORDER BY o.created_at`,
    refunds: `SELECT r.created_at AS "createdAt", b.ref, r.amount_pence AS "amountPence", r.status, r.reason FROM refunds r JOIN bookings b ON b.id=r.booking_id WHERE r.created_at >= $1 AND r.created_at < $2 ORDER BY r.created_at`,
    cancellations: `SELECT b.ref, b.status, b.cancelled_at AS "cancelledAt", b.cancel_reason AS reason, b.total_pence AS "totalPence" FROM bookings b WHERE b.status IN ('cancelled','rejected','cancellation_requested') AND b.start_at >= $1 AND b.start_at < $2 ORDER BY b.start_at`,
    'popular-events': `SELECT COALESCE(e.title,'(no event)') AS event, count(*)::int AS bookings FROM bookings b LEFT JOIN event_types e ON e.id=b.event_type_id
        WHERE b.status IN ${LIVE} AND b.start_at >= $1 AND b.start_at < $2 GROUP BY e.title ORDER BY bookings DESC`,
    offers: `SELECT o.title, o.code, count(r.id)::int AS uses, COALESCE(sum(r.discount_pence),0)::int AS "discountGivenPence" FROM offers o
        LEFT JOIN offer_redemptions r ON r.offer_id=o.id AND r.released_at IS NULL AND r.created_at >= $1 AND r.created_at < $2 GROUP BY o.id ORDER BY uses DESC`,
    'driver-workload': `SELECT d.full_name AS driver, count(a.id)::int AS assignments, COALESCE(round(sum(EXTRACT(EPOCH FROM (b.end_at-b.start_at))/3600)::numeric,1),0)::float AS hours
        FROM drivers d LEFT JOIN driver_assignments a ON a.driver_id=d.id AND a.active LEFT JOIN bookings b ON b.id=a.booking_id AND b.start_at >= $1 AND b.start_at < $2 AND b.status NOT IN ('cancelled','rejected')
        GROUP BY d.id ORDER BY hours DESC`,
  };

  app.get('/reports/:name', async (req) => {
    const { name } = z.object({ name: z.string() }).parse(req.params);
    const q = z.object({ from: date, to: date, format: z.enum(['json', 'csv']).default('json') }).parse(req.query);
    const sql = reports[name];
    if (!sql) throw notFound('Unknown report');
    const tz = (await getSettings())['booking.timezone'];
    const range = [DateTime.fromISO(q.from, { zone: tz }).toUTC().toJSDate(), DateTime.fromISO(q.to, { zone: tz }).plus({ days: 1 }).toUTC().toJSDate()];
    const rows = (await pool.query(sql, range)).rows;
    if (q.format === 'csv') { await audit(pool, req.user.sub, 'report', name, 'export_csv', null, { rows: rows.length }); return { csv: toCsv(rows) }; }
    return { name, from: q.from, to: q.to, rows };
  });
}
