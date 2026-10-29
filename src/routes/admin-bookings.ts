import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { DateTime } from 'luxon';
import { pool, tx } from '../db.js';
import { badRequest, conflict, forbidden, notFound } from '../errors.js';
import {
  assertSlotFree, buildSlot, changeStatus, createBooking, effectiveBuffer, lockBooking, lockVehicle, logEvent, notify, rangeParam, policyRefund, recalcTotal, slotFor, type BookingStatus,
} from '../bookings.js';
import { getSettings } from '../settings.js';
import { recordManualPayment, refundPayment, setManualPaymentStatus } from '../payments.js';
import { addAdjustment, bookingAddons, chargesForStaff, invoicesFor, loadFinance, loadOrderFinance, renderDocument, renderStatement, setDeliveryCharge, voidCharge } from '../finance.js';
import { audit } from '../util.js';
import { resolveGeo } from '../geo.js';
import { loadRules, priceItem } from '../pricing.js';
import { addOrderItem, createOrder, orderStatus, quoteOrder, repriceOrder } from '../orders.js';
import { applyExtension, decideExtension, extensionsFor, quoteExtension } from '../extensions.js';
import { itemSchema, orderSchema, withGeo } from './schemas.js';

/** Staff roles allowed to record money, refund, and confirm or change charges. */
const FINANCE_ROLES = ['owner', 'administrator', 'finance_manager'];
const requireFinance = (req: any) => {
  if (!FINANCE_ROLES.includes(req.user.role)) throw forbidden('Only the owner, administrators and finance managers can change payments or charges');
};

const uuid = z.string().uuid();
const statuses = ['pending', 'awaiting_payment', 'confirmed', 'driver_assigned', 'in_progress', 'completed', 'cancellation_requested', 'cancelled', 'rejected', 'payment_failed'] as const;
const DISPATCH = ['not_dispatched', 'dispatched', 'en_route', 'arrived', 'service_started', 'service_complete'] as const;

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

async function assignDriver(c: any, bookingId: string, driverId: string, staffId: string, reason?: string) {
  const b = await lockBooking(c, bookingId);
  if (!['confirmed', 'driver_assigned'].includes(b.status)) throw conflict('Drivers can only be assigned to confirmed bookings', 'invalid_state');
  const s = await getSettings(c);
  const d = (await c.query('SELECT * FROM drivers WHERE id=$1 FOR SHARE', [driverId])).rows[0];
  if (!d) throw notFound('Driver not found');
  if (!d.active) throw conflict('That driver is inactive', 'driver_inactive');
  if (d.license_expiry && DateTime.fromJSDate(d.license_expiry) < DateTime.fromJSDate(b.end_at)) throw conflict('The driver\'s licence expires before this booking ends', 'licence_expired');
  if (d.working_hours?.start && d.working_hours?.end) {
    const tz = s['booking.timezone'];
    const st = DateTime.fromJSDate(b.start_at, { zone: tz }), en = DateTime.fromJSDate(b.end_at, { zone: tz });
    const fmt = (x: DateTime) => x.toFormat('HH:mm');
    if (fmt(st) < d.working_hours.start || fmt(en) > d.working_hours.end) throw conflict(`Outside the driver's working hours (${d.working_hours.start}-${d.working_hours.end})`, 'outside_working_hours');
  }
  const prev = (await c.query('SELECT * FROM driver_assignments WHERE booking_id=$1 AND active', [bookingId])).rows[0];
  if (prev?.driver_id === driverId) return b;
  if (prev) await c.query('UPDATE driver_assignments SET active=false, ended_at=now(), ended_reason=$2 WHERE id=$1', [prev.id, reason ?? 'Reassigned']);
  const buf = s['driver.bufferMinutes'];
  const during = rangeParam(DateTime.fromJSDate(b.start_at).minus({ minutes: buf }), DateTime.fromJSDate(b.end_at).plus({ minutes: buf }));
  try {
    await c.query('INSERT INTO driver_assignments(booking_id, driver_id, during, assigned_by) VALUES ($1,$2,$3::tstzrange,$4)', [bookingId, driverId, during, staffId]);
  } catch (e: any) {
    if (e.code === '23P01') throw conflict('That driver already has an assignment that overlaps this booking (including travel buffer)', 'driver_conflict');
    throw e;
  }
  await c.query('UPDATE bookings SET driver_id=$2, updated_at=now() WHERE id=$1', [bookingId, driverId]);
  const prevName = prev ? (await c.query('SELECT full_name FROM drivers WHERE id=$1', [prev.driver_id])).rows[0]?.full_name : null;
  await logEvent(c, bookingId, { type: 'staff', id: staffId }, prev ? 'driver_reassigned' : 'driver_assigned', { from: prevName, to: d.full_name, reason, meta: { fromDriverId: prev?.driver_id ?? null, toDriverId: driverId } });
  if (b.status === 'confirmed') await changeStatus(c, bookingId, 'driver_assigned', { type: 'staff', id: staffId });
  await notify(c, { customerId: b.customer_id, bookingId, kind: 'driver_assigned', title: prev ? 'Your driver has changed' : 'Driver assigned', body: `Reference ${b.ref}`, dedupeKey: `driver:${bookingId}:${driverId}` });
  return (await c.query('SELECT * FROM bookings WHERE id=$1', [bookingId])).rows[0];
}

const POINT = z.object({ lat: z.number().min(-90).max(90), lng: z.number().min(-180).max(180) }).nullish();

export async function adminBookingRoutes(app: FastifyInstance) {
  app.addHook('onRequest', app.staffOnly);
  const actorOf = (req: any) => ({ type: 'staff' as const, id: req.user.sub as string });

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
      pool.query(`SELECT kind, status, attempts, last_error AS "lastError", sent_at AS "sentAt", created_at AS "createdAt" FROM email_outbox WHERE booking_id=$1 ORDER BY created_at`, [id]),
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

  /** Every vehicle in an order with its own price share, plus how the order total was worked out. */
  const orderOverview = async (orderId: string) => {
    const o = (await pool.query('SELECT * FROM orders WHERE id=$1', [orderId])).rows[0];
    if (!o) throw notFound('Order not found');
    const items = (await pool.query(
      `SELECT b.id, b.ref, b.status, b.start_at AS "startAt", b.end_at AS "endAt", b.hours, b.driver_option AS "driverOption", b.experience,
              b.item_subtotal_pence AS "subtotalPence", b.discount_pence AS "discountPence", b.tax_pence AS "taxPence", b.quoted_total_pence AS "quotedPence", b.total_pence AS "totalPence",
              b.pricing_snapshot->'lines' AS lines, v.id AS "vehicleId", v.make || ' ' || v.model AS vehicle, v.category, v.price_per_hour_pence AS "pricePerHourPence",
              (SELECT count(*)::int FROM booking_extensions x WHERE x.booking_id=b.id AND x.status='confirmed') AS extensions
         FROM bookings b JOIN vehicles v ON v.id=b.vehicle_id WHERE b.order_id=$1 ORDER BY b.created_at, b.ref`, [orderId])).rows;
    const offers = (await pool.query(
      `SELECT x.offer_id AS "offerId", x.title, x.code, x.discount_type AS "discountType", x.discount_value AS "discountValue", x.applies_to AS "appliesTo",
              x.discount_pence AS "discountPence", x.snapshot->>'conditions' AS conditions, x.created_at AS "appliedAt"
         FROM order_offers x WHERE x.order_id=$1 AND x.superseded_at IS NULL ORDER BY x.created_at`, [orderId])).rows;
    return {
      id: o.id, ref: o.ref, status: orderStatus(items), items, offers, pricing: o.pricing_snapshot,
      subtotalPence: o.subtotal_pence, discountPence: o.discount_pence, taxablePence: o.taxable_pence, taxPence: o.tax_pence, serviceFeePence: o.fee_pence,
      tax: { enabled: o.tax_enabled, rateBp: o.tax_rate_bp, policy: o.tax_policy, label: o.tax_label },
      quotedTotalPence: o.quoted_total_pence, totalPence: o.total_pence,
    };
  };

  app.get('/orders/:id', async (req) => {
    const { id } = z.object({ id: uuid }).parse(req.params);
    return { ...(await orderOverview(id)), finance: await loadOrderFinance(pool, id), invoices: await invoicesFor(pool, 'order', id) };
  });

  /** A booking with several vehicles for one customer. Same checks and pricing as the customer app; staff skip notice. */
  app.post('/orders', async (req, reply) => {
    const b = orderSchema.extend({ customerId: uuid, initialStatus: z.enum(['pending', 'awaiting_payment', 'confirmed']).default('awaiting_payment') }).parse(req.body);
    const items = await withGeo(b.items);
    const out = await tx(async (c) => {
      if (!(await c.query('SELECT 1 FROM customers WHERE id=$1', [b.customerId])).rowCount) throw notFound('Customer not found');
      const r = await createOrder(c, { customerId: b.customerId, items, offerCode: b.offerCode, customerNotes: b.customerNotes }, { staffId: req.user.sub, status: b.initialStatus });
      await audit(c, req.user.sub, 'order', r.order.id, 'create_on_behalf', null, { vehicles: r.bookings.length });
      return r;
    });
    return reply.status(201).send({ ...(await orderOverview(out.order.id)), bookingId: out.bookings[0].id });
  });

  /** Price check for a staff booking with one or more vehicles, before creating it. */
  app.post('/orders/quote', async (req) => {
    const b = orderSchema.pick({ items: true, offerCode: true }).extend({ customerId: uuid.nullish() }).parse(req.body);
    const items = await withGeo(b.items);
    return tx(async (c) => {
      const q = await quoteOrder(c, { customerId: b.customerId ?? '00000000-0000-0000-0000-000000000000', items, offerCode: b.offerCode }, true);
      return { order: q.price, items: q.prepared.map((p, n) => ({ vehicleId: p.vehicle.id, vehicle: `${p.vehicle.make} ${p.vehicle.model}`, ...q.price.items[n], lines: p.item.lines, available: q.availability[n].available, unavailableReason: q.availability[n].reason })) };
    });
  });

  /** Adds a vehicle to an order; the order is re-priced and logged. Remove a vehicle by cancelling its booking. */
  app.post('/orders/:id/items', async (req, reply) => {
    const { id } = z.object({ id: uuid }).parse(req.params);
    const b = itemSchema.parse(req.body);
    const [item] = await withGeo([b]);
    const row = await tx(async (c) => {
      const r = await addOrderItem(c, id, item, req.user.sub);
      await audit(c, req.user.sub, 'order', id, 'add_vehicle', null, { bookingId: r.id, vehicleId: r.vehicle_id });
      return r;
    });
    return reply.status(201).send(row);
  });

  /* ----- Extensions ----- */
  app.post('/bookings/:id/extension-quote', async (req) => {
    const { id } = z.object({ id: uuid }).parse(req.params);
    const { hours } = z.object({ hours: z.number().int().min(1).max(12) }).parse(req.body);
    return tx((c) => quoteExtension(c, id, hours, { staff: true }));
  });

  /** Staff extend directly. Availability is always enforced; opening hours and the car's maximum hours are not. */
  app.post('/bookings/:id/extend', async (req) => {
    const { id } = z.object({ id: uuid }).parse(req.params);
    const b = z.object({ hours: z.number().int().min(1).max(12), reason: z.string().max(500).nullish(), expectedEndAt: z.string().datetime({ offset: true }).optional() }).parse(req.body);
    const r = await tx((c) => applyExtension(c, id, b.hours, actorOf(req), { staff: true, reason: b.reason ?? null, expectedEndAt: b.expectedEndAt }));
    return { extension: r.extension, finance: await loadFinance(pool, id) };
  });

  app.get('/extension-requests', async (req) => {
    const { status } = z.object({ status: z.enum(['requested', 'confirmed', 'rejected']).default('requested') }).parse(req.query);
    return { items: (await pool.query(
      `SELECT x.id, x.status, x.booking_id AS "bookingId", b.ref, c.name AS customer, v.make || ' ' || v.model AS vehicle, x.previous_end_at AS "previousEndAt",
              x.requested_end_at AS "requestedEndAt", x.additional_hours AS "additionalHours", x.conflict_reason AS "conflictReason", x.customer_message AS "customerMessage",
              x.created_at AS "createdAt", x.decided_at AS "decidedAt", s.name AS "decidedBy", x.decision_reason AS "decisionReason"
         FROM booking_extensions x JOIN bookings b ON b.id=x.booking_id JOIN customers c ON c.id=b.customer_id JOIN vehicles v ON v.id=b.vehicle_id
         LEFT JOIN staff_users s ON s.id=x.decided_by WHERE x.status=$1 ORDER BY x.created_at DESC LIMIT 200`, [status])).rows };
  });

  /** Approve re-checks availability under the vehicle lock; if the time is taken it fails and nothing changes. */
  app.post('/extensions/:id/approve', async (req) => {
    const { id } = z.object({ id: uuid }).parse(req.params);
    const b = z.object({ reason: z.string().max(500).nullish(), hours: z.number().int().min(1).max(12).optional() }).parse(req.body ?? {});
    return tx((c) => decideExtension(c, id, true, req.user.sub, b.reason ?? null, { hours: b.hours }));
  });

  app.post('/extensions/:id/reject', async (req) => {
    const { id } = z.object({ id: uuid }).parse(req.params);
    const { reason } = z.object({ reason: z.string().trim().min(1).max(500) }).parse(req.body);
    return tx((c) => decideExtension(c, id, false, req.user.sub, reason));
  });

  /** Create a booking for a customer (phone/walk-in). Staff skip lead time; availability is still enforced. */
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

  /* ----- Drivers on a booking ----- */
  app.get('/bookings/:id/eligible-drivers', async (req) => {
    const { id } = z.object({ id: uuid }).parse(req.params);
    const b = (await pool.query('SELECT start_at, end_at FROM bookings WHERE id=$1', [id])).rows[0];
    if (!b) throw notFound('Booking not found');
    const s = await getSettings();
    const buf = s['driver.bufferMinutes'];
    const range = rangeParam(DateTime.fromJSDate(b.start_at).minus({ minutes: buf }), DateTime.fromJSDate(b.end_at).plus({ minutes: buf }));
    const rows = (await pool.query(
      `SELECT d.id, d.full_name AS name, d.phone, d.working_hours AS "workingHours",
              EXISTS (SELECT 1 FROM driver_assignments a WHERE a.driver_id=d.id AND a.active AND a.booking_id <> $1 AND a.during && $2::tstzrange) AS busy,
              (d.license_expiry IS NOT NULL AND d.license_expiry < $3::date) AS "licenceExpired"
         FROM drivers d WHERE d.active ORDER BY d.full_name`, [id, range, b.end_at])).rows;
    return { items: rows.map((r) => ({ ...r, eligible: !r.busy && !r.licenceExpired })) };
  });

  app.post('/bookings/:id/driver', async (req) => {
    const { id } = z.object({ id: uuid }).parse(req.params);
    const b = z.object({ driverId: uuid, reason: z.string().max(500).optional() }).parse(req.body);
    return tx((c) => assignDriver(c, id, b.driverId, req.user.sub, b.reason));
  });

  app.delete('/bookings/:id/driver', async (req) => {
    const { id } = z.object({ id: uuid }).parse(req.params);
    const { reason } = z.object({ reason: z.string().min(1).max(500) }).parse(req.body ?? {});
    return tx(async (c) => {
      const cur = await lockBooking(c, id);
      if (!cur.driver_id) throw conflict('No driver is assigned', 'no_driver');
      await c.query('UPDATE driver_assignments SET active=false, ended_at=now(), ended_reason=$2 WHERE booking_id=$1 AND active', [id, reason]);
      await c.query('UPDATE bookings SET driver_id=NULL WHERE id=$1', [id]);
      const nm = (await c.query('SELECT full_name FROM drivers WHERE id=$1', [cur.driver_id])).rows[0]?.full_name;
      await logEvent(c, id, actorOf(req), 'driver_removed', { from: nm, reason, meta: { driverId: cur.driver_id } });
      if (cur.status === 'driver_assigned') await changeStatus(c, id, 'confirmed', actorOf(req));
      return { ok: true };
    });
  });

  /** Status-based progress tracking. This is NOT GPS; no location is recorded. */
  app.post('/bookings/:id/dispatch', async (req) => {
    const { id } = z.object({ id: uuid }).parse(req.params);
    const { status } = z.object({ status: z.enum(DISPATCH) }).parse(req.body);
    return tx(async (c) => {
      const cur = await lockBooking(c, id);
      if (!['confirmed', 'driver_assigned', 'in_progress'].includes(cur.status)) throw conflict('Progress can only be updated on active bookings', 'invalid_state');
      if (DISPATCH.indexOf(status) <= DISPATCH.indexOf(cur.dispatch_status)) throw conflict('Progress can only move forward', 'invalid_transition');
      await c.query('UPDATE bookings SET dispatch_status=$2, updated_at=now() WHERE id=$1', [id, status]);
      await logEvent(c, id, actorOf(req), 'dispatch', { from: cur.dispatch_status, to: status });
      if (status === 'service_started' && cur.status !== 'in_progress') await changeStatus(c, id, 'in_progress', actorOf(req));
      if (status === 'service_complete') {
        if (cur.status !== 'in_progress') await changeStatus(c, id, 'in_progress', actorOf(req));
        await changeStatus(c, id, 'completed', actorOf(req));
      }
      return (await c.query('SELECT * FROM bookings WHERE id=$1', [id])).rows[0];
    });
  });

  /* ----- Payments on a booking ----- */
  /** Money received outside the app. Send an Idempotency-Key header so a double click records it once. */
  app.post('/bookings/:id/payments/manual', async (req, reply) => {
    requireFinance(req);
    const { id } = z.object({ id: uuid }).parse(req.params);
    const b = z.object({
      amountPence: z.number().int().positive(), method: z.enum(['cash', 'card_terminal', 'bank_transfer', 'other']), reference: z.string().max(200).optional(),
      purpose: z.enum(['payment', 'deposit', 'balance']).optional(), paidAt: z.string().datetime({ offset: true }).nullish(),
      status: z.enum(['succeeded', 'pending']).default('succeeded'), note: z.string().max(1000).nullish(),
    }).parse(req.body);
    const key = z.string().max(100).optional().parse(req.headers['idempotency-key']);
    const row = await tx((c) => recordManualPayment(c, { bookingId: id, ...b, staffId: req.user.sub, idempotencyKey: key }));
    return reply.status(201).send(row);
  });

  /** A pending manual payment is marked received, failed or cancelled. Card payments made in the app cannot be changed here. */
  app.post('/payments/:id/status', async (req) => {
    requireFinance(req);
    const { id } = z.object({ id: uuid }).parse(req.params);
    const b = z.object({ status: z.enum(['succeeded', 'failed', 'canceled']), paidAt: z.string().datetime({ offset: true }).nullish() }).parse(req.body);
    return tx((c) => setManualPaymentStatus(c, id, b.status, req.user.sub, b.paidAt));
  });

  app.post('/payments/:id/refund', async (req, reply) => {
    requireFinance(req);
    const { id } = z.object({ id: uuid }).parse(req.params);
    const b = z.object({ amountPence: z.number().int().positive(), reason: z.string().min(1).max(500) }).parse(req.body);
    return reply.status(201).send(await refundPayment(id, b.amountPence, b.reason, req.user.sub));
  });

  /* ----- Delivery charge and adjustments ----- */
  /** Confirms or amends the delivery charge: distance x rate, and the final amount staff approve. */
  app.post('/bookings/:id/delivery-charge', async (req) => {
    requireFinance(req);
    const { id } = z.object({ id: uuid }).parse(req.params);
    const b = z.object({
      distanceMiles: z.number().min(0).max(5000).nullable().transform((n) => (n == null ? null : Math.round(n * 100) / 100)), ratePerMilePence: z.number().int().min(0).max(100000),
      finalPence: z.number().int().min(0).max(10_000_000), address: z.string().max(300).nullish(), reason: z.string().max(500).nullish(),
    }).parse(req.body);
    await tx((c) => setDeliveryCharge(c, id, b, req.user.sub));
    return { finance: await loadFinance(pool, id), charges: await chargesForStaff(pool, id) };
  });

  app.post('/bookings/:id/charges/:chargeId/void', async (req) => {
    requireFinance(req);
    const p = z.object({ id: uuid, chargeId: uuid }).parse(req.params);
    const { reason } = z.object({ reason: z.string().trim().min(1).max(500) }).parse(req.body);
    await tx((c) => voidCharge(c, p.id, p.chargeId, reason, req.user.sub));
    return { finance: await loadFinance(pool, p.id) };
  });

  /** A one-off extra charge (positive) or credit (negative) on the booking, with a reason. */
  app.post('/bookings/:id/adjustments', async (req, reply) => {
    requireFinance(req);
    const { id } = z.object({ id: uuid }).parse(req.params);
    const b = z.object({ amountPence: z.number().int().min(-10_000_000).max(10_000_000).refine((n) => n !== 0, 'Must not be zero'), description: z.string().trim().min(1).max(200) }).parse(req.body);
    await tx((c) => addAdjustment(c, id, b, req.user.sub));
    return reply.status(201).send({ finance: await loadFinance(pool, id) });
  });

  /* ----- Receipts and statements (HTML: print or save as PDF) ----- */
  app.get('/invoices/:id/document', async (req, reply) => {
    const { id } = z.object({ id: uuid }).parse(req.params);
    const doc = (await pool.query('SELECT * FROM invoices WHERE id=$1', [id])).rows[0];
    if (!doc) throw notFound('Document not found');
    return reply.type('text/html; charset=utf-8').header('cache-control', 'no-store').send(renderDocument(doc));
  });

  app.get('/bookings/:id/statement', async (req, reply) => {
    const { id } = z.object({ id: uuid }).parse(req.params);
    return reply.type('text/html; charset=utf-8').header('cache-control', 'no-store').send(await renderStatement(pool, id));
  });
}
