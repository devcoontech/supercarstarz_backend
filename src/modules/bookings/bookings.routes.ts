import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { DateTime } from 'luxon';
import { pool, tx } from '../../core/db.js';
import { badRequest, conflict, forbidden, notFound } from '../../core/errors.js';
import { createBooking } from './bookings.js';
import { notify } from '../notifications/notify.js';
import { changeStatus, lockBooking, policyRefund, recalcTotal, type BookingStatus } from './status.js';
import { assertSlotFree, buildSlot, effectiveBuffer, lockVehicle, rangeParam, slotFor } from './slots.js';
import { logEvent } from './history.js';
import { getSettings } from '../../core/settings.js';
import { bookingAddons, loadFinance } from '../finance/finance.js';
import { invoicesFor } from '../finance/documents.js';
import { chargesForStaff } from '../finance/charges.js';
import { audit } from '../../core/util.js';
import { resolveGeo } from './geo.js';
import { loadRules, priceItem } from '../pricing/pricing.js';
import { repriceOrder } from './orders.js';
import { extensionsFor } from './extensions.js';
import { actorOf } from './history.js';
import { orderOverview } from './orders.js';
import { FINANCE_ROLES } from '../finance/permissions.js';
import { orderRoutes } from './orders.routes.js';
import { extensionRoutes } from './extensions.routes.js';
import { bookingDriverRoutes } from '../drivers/booking-drivers.routes.js';
import { bookingPaymentRoutes } from '../payments/booking-payments.routes.js';
import { chargeRoutes } from '../finance/charges.routes.js';
import { documentRoutes } from '../finance/documents.routes.js';


const uuid = z.string().uuid();
const statuses = ['pending', 'awaiting_payment', 'confirmed', 'driver_assigned', 'in_progress', 'completed', 'cancellation_requested', 'cancelled', 'rejected', 'payment_failed'] as const;
const listSql = `
  SELECT b.id, b.ref, b.status, o.payment_status AS "paymentStatus", b.start_at AS "startAt", b.end_at AS "endAt", b.hours, b.experience, b.address,
         b.total_pence AS "totalPence", o.paid_pence AS "paidPence", o.refunded_pence AS "refundedPence", b.deposit_due_pence AS "depositDuePence",
         b.dispatch_status AS "dispatchStatus", b.chauffeur, b.driver_option AS "driverOption", b.source, o.currency, b.created_at AS "createdAt",
         json_build_object('id', o.id, 'ref', o.ref, 'totalPence', o.total_pence,
           'balancePence', CASE WHEN EXISTS (SELECT 1 FROM bookings x WHERE x.order_id=o.id AND x.status NOT IN ('cancelled','rejected'))
                                THEN GREATEST(0, o.total_pence - (o.paid_pence - o.refunded_pence)) ELSE 0 END,
           'vehicles', (SELECT count(*)::int FROM bookings x WHERE x.order_id=o.id AND x.status NOT IN ('cancelled','rejected')),
           'items', (SELECT count(*)::int FROM bookings x WHERE x.order_id=o.id)) AS "order",
         (SELECT count(*)::int FROM booking_extensions x WHERE x.booking_id=b.id AND x.status='confirmed') AS "extensions",
         EXISTS (SELECT 1 FROM booking_extensions x WHERE x.booking_id=b.id AND x.status='requested') AS "extensionRequested",
         json_build_object('id', c.id, 'name', c.name, 'email', c.email, 'phone', c.phone) AS customer,
         json_build_object('id', v.id, 'name', v.make || ' ' || v.model) AS vehicle,
         CASE WHEN e.id IS NULL THEN NULL ELSE json_build_object('id', e.id, 'title', e.title) END AS "eventType",
         CASE WHEN d.id IS NULL THEN NULL ELSE json_build_object('id', d.id, 'name', d.full_name) END AS driver
    FROM bookings b JOIN orders o ON o.id=b.order_id JOIN customers c ON c.id=b.customer_id JOIN vehicles v ON v.id=b.vehicle_id
    LEFT JOIN event_types e ON e.id=b.event_type_id LEFT JOIN drivers d ON d.id=b.driver_id`;

const POINT = z.object({ lat: z.number().min(-90).max(90), lng: z.number().min(-180).max(180) }).nullish();

export async function adminBookingRoutes(app: FastifyInstance) {
  app.addHook('onRequest', app.staffOnly);

  // Feature route groups share this instance, so the hooks above apply to all of them.
  orderRoutes(app);
  extensionRoutes(app);
  bookingDriverRoutes(app);
  bookingPaymentRoutes(app);
  chargeRoutes(app);
  documentRoutes(app);

  app.get('/bookings', async (req) => {
    const q = z.object({
      q: z.string().max(80).optional(), status: z.enum(statuses).optional(), paymentStatus: z.string().optional(), vehicleId: uuid.optional(),
      eventTypeId: uuid.optional(), customerId: uuid.optional(), driverId: uuid.optional(), extensionRequests: z.enum(['true']).optional(),
      from: z.string().optional(), to: z.string().optional(),
      sort: z.enum(['start_asc', 'start_desc', 'created_desc']).default('start_desc'),
      limit: z.coerce.number().int().min(1).max(200).default(50), offset: z.coerce.number().int().min(0).default(0),
      group: z.enum(['order']).optional(),
    }).parse(req.query);
    const w: string[] = [];
    const p: unknown[] = [];
    const add = (sql: string, v: unknown) => { p.push(v); w.push(sql.replaceAll('?', '$' + p.length)); };
    if (q.q) add(`(b.ref ILIKE ? OR c.name ILIKE ? OR c.email ILIKE ?)`, `%${q.q}%`);
    if (q.status) add('b.status = ?', q.status);
    if (q.paymentStatus) add('o.payment_status = ?', q.paymentStatus);
    if (q.extensionRequests) w.push(`EXISTS (SELECT 1 FROM booking_extensions x WHERE x.booking_id=b.id AND x.status='requested')`);
    if (q.vehicleId) add('b.vehicle_id = ?', q.vehicleId);
    if (q.eventTypeId) add('b.event_type_id = ?', q.eventTypeId);
    if (q.customerId) add('b.customer_id = ?', q.customerId);
    if (q.driverId) add('b.driver_id = ?', q.driverId);
    if (q.from) add('b.start_at >= ?', q.from);
    if (q.to) add('b.start_at < ?', q.to);
    const where = w.length ? 'WHERE ' + w.join(' AND ') : '';
    const order = q.sort === 'start_asc' ? 'b.start_at ASC' : q.sort === 'created_desc' ? 'b.created_at DESC' : 'b.start_at DESC';
    if (q.group === 'order') {
      // Pages over orders that have a matching booking; `items` holds every vehicle of those orders, `total` counts orders.
      const from = `FROM bookings b JOIN orders o ON o.id=b.order_id JOIN customers c ON c.id=b.customer_id ${where}`;
      const orderBy = q.sort === 'start_asc' ? 'min(b.start_at) ASC' : q.sort === 'created_desc' ? 'max(b.created_at) DESC' : 'max(b.start_at) DESC';
      const total = (await pool.query(`SELECT count(DISTINCT b.order_id)::int n ${from}`, p)).rows[0].n;
      p.push(q.limit, q.offset);
      const ids = (await pool.query(`SELECT b.order_id ${from} GROUP BY b.order_id ORDER BY ${orderBy}, b.order_id LIMIT $${p.length - 1} OFFSET $${p.length}`, p)).rows.map((r) => r.order_id);
      const rows = ids.length ? (await pool.query(`${listSql} WHERE b.order_id = ANY($1) ORDER BY b.created_at, b.ref`, [ids])).rows : [];
      const items = ids.flatMap((id) => rows.filter((r) => r.order.id === id));
      return { items, total };
    }
    const total = (await pool.query(`SELECT count(*)::int n FROM bookings b JOIN orders o ON o.id=b.order_id JOIN customers c ON c.id=b.customer_id ${where}`, p)).rows[0].n;
    p.push(q.limit, q.offset);
    const items = (await pool.query(`${listSql} ${where} ORDER BY ${order} LIMIT $${p.length - 1} OFFSET $${p.length}`, p)).rows;
    return { items, total };
  });

  app.get('/bookings/:id', async (req) => {
    const { id } = z.object({ id: uuid }).parse(req.params);
    const b = (await pool.query(`${listSql} WHERE b.id=$1`, [id])).rows[0];
    if (!b) throw notFound('Booking not found');
    const full = (await pool.query('SELECT order_id, customer_notes, occasion, children, pricing_snapshot, addon_ids, hold_expires_at, cancel_reason, offer_id, consents, pickup_address, dropoff_address, route_miles, delivery_miles, address_lat, address_lng, pickup_lat, pickup_lng, dropoff_lat, dropoff_lng, created_by_staff FROM bookings WHERE id=$1', [id])).rows[0];
    const orderId = full.order_id;
    const [events, payments, refunds, assignments, emails, charges, addons, invoices, finance, createdBy, order, extensions] = await Promise.all([
      // History of every vehicle in the order, so order-wide changes (payments, re-pricing) show up here too.
      pool.query(`SELECT e.id, e.actor_type AS "actorType", e.action, e.from_value AS "from", e.to_value AS "to", e.reason, e.meta, e.created_at AS "createdAt", s.name AS "actorName", bk.ref AS "bookingRef"
                    FROM booking_events e JOIN bookings bk ON bk.id=e.booking_id LEFT JOIN staff_users s ON e.actor_type='staff' AND s.id=e.actor_id
                   WHERE e.order_id=$1 ORDER BY e.id`, [orderId]),
      pool.query(`SELECT p.id, p.amount_pence AS "amountPence", p.currency, p.method, p.source, p.purpose, p.status, p.provider_ref AS "providerRef", p.manual_reference AS "manualReference",
                         p.note, p.paid_at AS "paidAt", (p.source='stripe' AND p.status='succeeded') AS verified, p.reconciled_at AS "reconciledAt",
                         p.created_at AS "createdAt", s.name AS "recordedBy", cs.name AS "statusChangedBy", i.id AS "receiptId", i.number AS "receiptNumber"
                    FROM payments p LEFT JOIN staff_users s ON s.id=p.recorded_by LEFT JOIN staff_users cs ON cs.id=p.status_changed_by LEFT JOIN invoices i ON i.payment_id=p.id
                   WHERE p.order_id=$1 ORDER BY COALESCE(p.paid_at, p.created_at)`, [orderId]),
      pool.query(`SELECT id, payment_id AS "paymentId", amount_pence AS "amountPence", reason, status, created_at AS "createdAt" FROM refunds WHERE order_id=$1 ORDER BY created_at`, [orderId]),
      pool.query(`SELECT a.id, a.driver_id AS "driverId", d.full_name AS "driverName", a.active, a.created_at AS "createdAt", a.ended_at AS "endedAt", a.ended_reason AS "endedReason"
                    FROM driver_assignments a JOIN drivers d ON d.id=a.driver_id WHERE a.booking_id=$1 ORDER BY a.created_at`, [id]),
      pool.query(`SELECT kind, recipient, status, attempts, last_error AS "lastError", sent_at AS "sentAt", created_at AS "createdAt" FROM email_outbox WHERE booking_id=$1 ORDER BY created_at`, [id]),
      chargesForStaff(pool, id), bookingAddons(pool, id), invoicesFor(pool, 'booking', id), loadFinance(pool, id),
      full.created_by_staff ? pool.query('SELECT name FROM staff_users WHERE id=$1', [full.created_by_staff]).then((r) => r.rows[0]?.name ?? null) : Promise.resolve(null),
      orderOverview(orderId), extensionsFor(pool, id, true),
    ]);
    const s = await getSettings();
    const row = (await pool.query('SELECT start_at, paid_pence, refunded_pence FROM bookings WHERE id=$1', [id])).rows[0];
    return {
      ...b, customerNotes: full.customer_notes, occasion: full.occasion, children: full.children, pricing: full.pricing_snapshot,
      consents: full.consents, pickupAddress: full.pickup_address, dropoffAddress: full.dropoff_address, routeMiles: full.route_miles, deliveryMiles: full.delivery_miles, points: { address: full.address_lat == null ? null : { lat: full.address_lat, lng: full.address_lng }, pickup: full.pickup_lat == null ? null : { lat: full.pickup_lat, lng: full.pickup_lng }, dropoff: full.dropoff_lat == null ? null : { lat: full.dropoff_lat, lng: full.dropoff_lng } }, addonIds: full.addon_ids, holdExpiresAt: full.hold_expires_at, cancelReason: full.cancel_reason,
      events: events.rows, emails: emails.rows, payments: payments.rows, refunds: refunds.rows, driverAssignments: assignments.rows, cancellationPolicy: policyRefund(row, s),
      charges, addons, invoices, finance, createdByName: createdBy, defaultDeliveryRatePence: s['delivery.ratePerMilePence'], order, extensions,
    };
  });

  app.post('/bookings', async (req, reply) => {
    const b = z.object({
      customerId: uuid, vehicleId: uuid, eventTypeId: uuid.nullish(), date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/), time: z.string().regex(/^\d{2}:\d{2}$/),
      hours: z.number().int().min(1).max(24), experience: z.enum(['stationary', 'delivered']), address: z.string().max(300).nullish(), children: z.number().int().min(0).nullish(),
      occasion: z.string().max(200).nullish(), driverOption: z.enum(['with_driver', 'self_drive']).nullish(), chauffeur: z.boolean().optional(),
      addonIds: z.array(uuid).optional(), addons: z.array(z.object({ id: uuid, quantity: z.number().int().min(1).max(100).default(1) })).max(20).optional(), offerCode: z.string().max(40).nullish(),
      customerNotes: z.string().max(1000).nullish(), initialStatus: z.enum(['pending', 'awaiting_payment', 'confirmed']).default('awaiting_payment'),
      pickupAddress: z.string().max(300).nullish(), dropoffAddress: z.string().max(300).nullish(),
      addressPoint: POINT, pickupPoint: POINT, dropoffPoint: POINT,
    }).parse(req.body);
    const geo = await resolveGeo(b);
    const out = await tx(async (c) => {
      if (!(await c.query('SELECT 1 FROM customers WHERE id=$1', [b.customerId])).rowCount) throw notFound('Customer not found');
      const r = await createBooking(c, { ...b, geo }, { staffId: req.user.sub, status: b.initialStatus });
      await audit(c, req.user.sub, 'booking', r.booking.id, 'create_on_behalf');
      return r.booking;
    });
    return reply.status(201).send(out);
  });

  app.post('/bookings/:id/status', async (req) => {
    const { id } = z.object({ id: uuid }).parse(req.params);
    const b = z.object({ to: z.enum(statuses), reason: z.string().max(500).optional(), allowUnpaid: z.boolean().optional() }).parse(req.body);
    const updated = await tx((c) => changeStatus(c, id, b.to as BookingStatus, actorOf(req), { reason: b.reason, allowUnpaid: b.allowUnpaid }));
    return updated;
  });

  app.post('/bookings/:id/reschedule', async (req) => {
    const { id } = z.object({ id: uuid }).parse(req.params);
    const b = z.object({ date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/), time: z.string().regex(/^\d{2}:\d{2}$/), hours: z.number().int().min(1).max(24).optional(), reason: z.string().max(500).optional() }).parse(req.body);
    return tx(async (c) => {
      const cur = await lockBooking(c, id);
      await lockVehicle(c, cur.vehicle_id);
      if (!['pending', 'awaiting_payment', 'confirmed', 'driver_assigned'].includes(cur.status)) throw conflict('This booking cannot be rescheduled in its current state', 'invalid_state');
      const v = (await c.query('SELECT * FROM vehicles WHERE id=$1', [cur.vehicle_id])).rows[0];
      const s = await getSettings(c);
      const hours = b.hours ?? cur.hours;
      if (hours < v.min_hours || hours > v.max_hours) throw badRequest(`This car can be booked for ${v.min_hours} to ${v.max_hours} hours`, 'invalid_duration');
      const slot = buildSlot(s, effectiveBuffer(s, v), b.date, b.time, hours, { skipLead: true });
      await assertSlotFree(c, v.id, slot, id);
      if (cur.driver_id) {
        const buf = s['driver.bufferMinutes'];
        try {
          await c.query('UPDATE driver_assignments SET during=$2::tstzrange WHERE booking_id=$1 AND active', [id, rangeParam(slot.start.minus({ minutes: buf }), slot.end.plus({ minutes: buf }))]);
        } catch (e: any) {
          if (e.code === '23P01') throw conflict('The assigned driver is not free at the new time. Reassign the driver first.', 'driver_conflict');
          throw e;
        }
      }
      // Price snapshot is kept: a reschedule never silently reprices an existing booking.
      const r = (await c.query(
        `UPDATE bookings SET start_at=$2, end_at=$3, hours=$4, blocked_during=$5::tstzrange, updated_at=now() WHERE id=$1 RETURNING *`,
        [id, slot.start.toJSDate(), slot.end.toJSDate(), hours, rangeParam(slot.blockedStart, slot.blockedEnd)])).rows[0];
      await logEvent(c, id, actorOf(req), 'rescheduled', { from: cur.start_at.toISOString(), to: slot.start.toISO(), reason: b.reason, meta: { hoursFrom: cur.hours, hoursTo: hours } });
      await notify(c, { customerId: cur.customer_id, bookingId: id, kind: 'rescheduled', title: 'Booking rescheduled', body: `Reference ${cur.ref}`, dedupeKey: `resched:${id}:${slot.start.toMillis()}` });
      return r;
    });
  });

  app.post('/bookings/:id/change-vehicle', async (req) => {
    const { id } = z.object({ id: uuid }).parse(req.params);
    const b = z.object({ vehicleId: uuid, reprice: z.boolean().default(false), reason: z.string().min(1).max(500) }).parse(req.body);
    // Keeping the old price on a different car, or a reprice that lowers what the customer owes, is a money change,
    // so only finance roles may do it. Everyone else changes car at the new car's price, or a higher one.
    const isFinance = FINANCE_ROLES.includes(req.user.role!);
    if (!b.reprice && !isFinance) throw forbidden('Only the owner, administrators and finance managers can keep the old price when changing car. Turn on repricing.');
    // Delivery is priced by staff as a separate charge, so changing car never measures a distance.
    const newDeliveryMiles: number | null = null;
    return tx(async (c) => {
      const cur = await lockBooking(c, id);
      if (!['pending', 'awaiting_payment', 'confirmed', 'driver_assigned'].includes(cur.status)) throw conflict('This booking cannot change vehicle in its current state', 'invalid_state');
      if (cur.vehicle_id === b.vehicleId) throw badRequest('That is already the booking vehicle');
      await lockVehicle(c, b.vehicleId);
      const s = await getSettings(c);
      const v = (await c.query('SELECT * FROM vehicles WHERE id=$1 AND deleted_at IS NULL', [b.vehicleId])).rows[0];
      if (!v || v.operational_status !== 'active') throw conflict('That vehicle is not in service', 'vehicle_unavailable');
      if (cur.hours < v.min_hours || cur.hours > v.max_hours) throw badRequest('That vehicle cannot be booked for this duration', 'invalid_duration');
      if (cur.event_type_id && !(await c.query('SELECT 1 FROM vehicle_event_types WHERE vehicle_id=$1 AND event_type_id=$2', [v.id, cur.event_type_id])).rowCount) throw badRequest('That vehicle is not offered for this event', 'event_not_supported');
      if (cur.driver_option === 'with_driver' && !v.chauffeur_available) throw badRequest('That vehicle is not offered with a driver', 'driver_option_unavailable');
      if (cur.driver_option === 'self_drive' && !v.self_drive_available) throw badRequest('That vehicle is not offered self-drive', 'driver_option_unavailable');
      const slot = slotFor(DateTime.fromJSDate(cur.start_at), DateTime.fromJSDate(cur.end_at), effectiveBuffer(s, v), s['booking.timezone']);
      await assertSlotFree(c, v.id, slot, id);
      let snapshot = cur.pricing_snapshot;
      let deliveryMiles: number | null = cur.delivery_miles == null ? null : Number(cur.delivery_miles);
      if (b.reprice) {
        // The new car's own rates for the rental and driver; add-ons keep the price agreed at booking. The order's
        // offers and tax are then worked out again with the other vehicles.
        const addons = (await c.query('SELECT addon_id AS id, name, unit_price_pence AS price_pence, pricing_type, quantity FROM booking_addons WHERE booking_id=$1', [id])).rows;
        const basis = cur.event_type_id ? (await c.query('SELECT pricing_basis FROM event_types WHERE id=$1', [cur.event_type_id])).rows[0]?.pricing_basis : 'hourly';
        deliveryMiles = newDeliveryMiles ?? (cur.delivery_miles == null ? null : Number(cur.delivery_miles));
        const item = priceItem({ vehicle: v, rules: await loadRules(c, v.id, cur.event_type_id), eventTypeId: cur.event_type_id, hours: cur.hours, localDate: slot.localDate,
          experience: cur.experience, eventBasis: basis, distances: { deliveryMiles, routeMiles: cur.route_miles == null ? null : Number(cur.route_miles) },
          chauffeur: cur.chauffeur, addons, settings: s });
        snapshot = { ...cur.pricing_snapshot, lines: item.lines, durationBasis: item.durationBasis, appliedRuleIds: item.appliedRuleIds, distances: item.distances, deliveryEstimate: item.deliveryEstimate };
      }
      await c.query(
        `UPDATE bookings SET vehicle_id=$2, blocked_during=$3::tstzrange, pricing_snapshot=$4, delivery_miles=$5, updated_at=now() WHERE id=$1`,
        [id, v.id, rangeParam(slot.blockedStart, slot.blockedEnd), JSON.stringify(snapshot), deliveryMiles]);
      const oldV = (await c.query("SELECT make || ' ' || model AS n FROM vehicles WHERE id=$1", [cur.vehicle_id])).rows[0]?.n;
      const before = (await c.query('SELECT total_pence FROM orders WHERE id=$1', [cur.order_id])).rows[0].total_pence;
      const r = b.reprice ? await repriceOrder(c, cur.order_id, actorOf(req), `Car changed to ${v.make} ${v.model}`) : await recalcTotal(c, id, actorOf(req));
      if (!isFinance && r.total_pence < before) throw forbidden('This change would lower the price. Only the owner, administrators and finance managers can do that.'); // rolls the change back
      await logEvent(c, id, actorOf(req), 'vehicle_changed', { from: oldV, to: `${v.make} ${v.model}`, reason: b.reason, meta: { repriced: b.reprice, totalFrom: cur.total_pence, orderTotalTo: r.total_pence } });
      await notify(c, { customerId: cur.customer_id, bookingId: id, kind: 'vehicle_changed', title: 'Your car has changed', body: `${oldV} has been changed to the ${v.make} ${v.model}.`, dedupeKey: `vehchg:${id}:${v.id}:${Date.now()}` });
      return (await c.query('SELECT * FROM bookings WHERE id=$1', [id])).rows[0];
    });
  });
}
