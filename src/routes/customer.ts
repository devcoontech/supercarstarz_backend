import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { pool, tx } from '../db.js';
import { conflict, notFound } from '../errors.js';
import { changeStatus, createBooking, lockBooking, policyRefund } from '../bookings.js';
import { createOrderPaymentIntent, createPaymentIntent } from '../payments.js';
import { getSettings } from '../settings.js';
import { bookingAddons, chargesForCustomer, invoicesFor, loadFinance, renderDocument, renderStatement, summarize } from '../finance.js';
import { createOrder } from '../orders.js';
import { applyExtension, extensionsFor, quoteExtension, requestExtension } from '../extensions.js';
import { itemSchema, orderSchema, withGeo } from './schemas.js';

/**
 * Customer-safe projection of one vehicle booking: never includes admin_notes, created_by_staff, staff payment notes
 * or driver licence data. Money comes from its order (the vehicles booked and paid for together).
 */
const customerBookingSql = `
  SELECT b.id, b.ref, b.status, o.payment_status AS "paymentStatus", b.start_at AS "startAt", b.end_at AS "endAt", b.hours,
         b.experience, CASE WHEN b.experience='delivered' THEN 'delivery' ELSE 'showroom' END AS "collectionMethod", b.driver_option AS "driverOption", o.currency,
         b.address, b.pickup_address AS "pickupAddress", b.dropoff_address AS "dropoffAddress", b.route_miles AS "routeMiles", b.delivery_miles AS "deliveryMiles", b.children, b.occasion, b.chauffeur, b.addon_ids AS "addonIds", b.customer_notes AS "customerNotes",
         b.quoted_total_pence AS "quotedTotalPence",
         COALESCE((SELECT json_agg(json_build_object('kind', ch.kind, 'status', ch.status, 'amount_pence', ch.amount_pence, 'distance_miles', ch.distance_miles, 'rate_per_mile_pence', ch.rate_per_mile_pence))
                     FROM booking_charges ch WHERE ch.booking_id=b.id AND ch.status <> 'void'), '[]') AS "_charges",
         json_build_object('quoted_total_pence', o.quoted_total_pence, 'total_pence', o.total_pence, 'deposit_due_pence', o.deposit_due_pence, 'paid_pence', o.paid_pence,
           'refunded_pence', o.refunded_pence, 'payment_status', o.payment_status, 'currency', o.currency,
           'status', CASE WHEN EXISTS (SELECT 1 FROM bookings x WHERE x.order_id=o.id AND x.status NOT IN ('cancelled','rejected')) THEN 'open' ELSE 'cancelled' END) AS "_order",
         json_build_object('id', o.id, 'ref', o.ref,
           'vehicles', (SELECT count(*)::int FROM bookings x WHERE x.order_id=o.id AND x.status NOT IN ('cancelled','rejected')),
           'items', (SELECT count(*)::int FROM bookings x WHERE x.order_id=o.id)) AS "order",
         b.pricing_snapshot AS pricing, b.total_pence AS "totalPence", b.deposit_due_pence AS "depositDuePence",
         o.paid_pence AS "paidPence", o.refunded_pence AS "refundedPence", b.hold_expires_at AS "holdExpiresAt",
         b.dispatch_status AS "dispatchStatus", b.created_at AS "createdAt",
         (SELECT count(*)::int FROM booking_extensions x WHERE x.booking_id=b.id AND x.status='confirmed') AS "extensions",
         json_build_object('id', v.id, 'make', v.make, 'model', v.model, 'year', v.year, 'category', v.category, 'pricePerHourPence', v.price_per_hour_pence,
           'image', (SELECT url FROM vehicle_images i WHERE i.vehicle_id=v.id ORDER BY is_cover DESC, sort_order LIMIT 1)) AS vehicle,
         CASE WHEN e.id IS NULL THEN NULL ELSE json_build_object('id', e.id, 'title', e.title) END AS "eventType",
         CASE WHEN d.id IS NULL THEN NULL ELSE json_build_object('name', d.full_name, 'phone', d.phone) END AS driver
    FROM bookings b JOIN orders o ON o.id=b.order_id JOIN vehicles v ON v.id=b.vehicle_id
    LEFT JOIN event_types e ON e.id=b.event_type_id LEFT JOIN drivers d ON d.id=b.driver_id`;

/** Adds the server's money summary for the order (total, paid, balance) and this vehicle's delivery status. */
const withFinance = ({ _charges, _order, ...r }: any) => ({ ...r, finance: summarize(_order, _charges) });

export async function customerRoutes(app: FastifyInstance) {
  app.addHook('onRequest', app.customerOnly);

  app.get('/', async (req) => {
    const c = (await pool.query('SELECT id, email, name, phone, postcode, city FROM customers WHERE id=$1', [req.user.sub])).rows[0];
    if (!c) throw notFound('Account not found');
    return c;
  });

  app.patch('/', async (req) => {
    const b = z.object({
      name: z.string().trim().min(1).max(120).optional(), phone: z.string().max(40).nullish(),
      postcode: z.string().max(12).nullish(), city: z.string().max(80).nullish(),
    }).strict().parse(req.body);
    const r = await pool.query(
      `UPDATE customers SET name=COALESCE($2,name), phone=CASE WHEN $3::boolean THEN $4 ELSE phone END,
         postcode=CASE WHEN $5::boolean THEN $6 ELSE postcode END, city=CASE WHEN $7::boolean THEN $8 ELSE city END, updated_at=now()
       WHERE id=$1 RETURNING id, email, name, phone, postcode, city`,
      [req.user.sub, b.name ?? null, 'phone' in b, b.phone ?? null, 'postcode' in b, b.postcode ?? null, 'city' in b, b.city ?? null],
    );
    return r.rows[0];
  });

  app.get('/bookings', async (req) => {
    const { scope } = z.object({ scope: z.enum(['upcoming', 'past', 'all']).default('all') }).parse(req.query);
    const cond = scope === 'upcoming' ? `AND b.end_at >= now() AND b.status NOT IN ('cancelled','rejected','completed')`
      : scope === 'past' ? `AND (b.end_at < now() OR b.status IN ('cancelled','rejected','completed'))` : '';
    const rows = (await pool.query(`${customerBookingSql} WHERE b.customer_id=$1 ${cond} ORDER BY b.start_at DESC`, [req.user.sub])).rows;
    return { items: rows.map(withFinance) };
  });

  /** One order with all its vehicles, its price breakdown (offers, tax) and money. */
  const orderDetail = async (orderId: string, customerId: string) => {
    const o = (await pool.query('SELECT * FROM orders WHERE id=$1 AND customer_id=$2', [orderId, customerId])).rows[0];
    if (!o) throw notFound('Booking not found');
    const items = (await pool.query(`${customerBookingSql} WHERE b.order_id=$1 ORDER BY b.created_at, b.ref`, [orderId])).rows.map(withFinance);
    const offers = (await pool.query(
      `SELECT title, code, discount_type AS "discountType", discount_value AS "discountValue", discount_pence AS "discountPence", snapshot->>'conditions' AS conditions
         FROM order_offers WHERE order_id=$1 AND superseded_at IS NULL ORDER BY created_at`, [orderId])).rows;
    return {
      id: o.id, ref: o.ref, items, pricing: o.pricing_snapshot, offers,
      tax: { enabled: o.tax_enabled, rateBp: o.tax_rate_bp, policy: o.tax_policy, label: o.tax_label, taxablePence: o.taxable_pence, taxPence: o.tax_pence },
      subtotalPence: o.subtotal_pence, discountPence: o.discount_pence, serviceFeePence: o.fee_pence,
      finance: items[0]?.finance, invoices: await invoicesFor(pool, 'order', orderId),
    };
  };

  app.get('/bookings/:id', async (req) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    const row = (await pool.query(`${customerBookingSql} WHERE b.id=$1 AND b.customer_id=$2`, [id, req.user.sub])).rows[0];
    if (!row) throw notFound('Booking not found');
    const b = withFinance(row);
    const [payments, charges, addons, invoices, extensions, order] = await Promise.all([
      pool.query(
        `SELECT id, amount_pence AS "amountPence", status, method, source, purpose, COALESCE(paid_at, created_at) AS "paidAt", created_at AS "createdAt",
                (source='stripe' AND status='succeeded') AS verified
           FROM payments WHERE order_id=$1 AND status IN ('succeeded','failed') ORDER BY COALESCE(paid_at, created_at)`, [b.order.id]).then((r) => r.rows),
      chargesForCustomer(pool, id), bookingAddons(pool, id), invoicesFor(pool, 'booking', id), extensionsFor(pool, id, false),
      orderDetail(b.order.id, req.user.sub),
    ]);
    const s = await getSettings();
    return {
      ...b, payments, charges, addons, invoices, extensionHistory: extensions,
      order: { ...b.order, bookings: order.items.map((i: any) => ({ id: i.id, ref: i.ref, status: i.status, startAt: i.startAt, endAt: i.endAt, hours: i.hours, vehicle: i.vehicle, totalPence: i.totalPence, pricing: i.pricing })), pricing: order.pricing, offers: order.offers, tax: order.tax },
      canExtend: s['booking.allowExtensions'] && ['pending', 'awaiting_payment', 'confirmed', 'driver_assigned', 'in_progress'].includes(b.status) && new Date(b.endAt) > new Date(),
      cancellation: policyRefund({ start_at: b.startAt, paid_pence: b.paidPence, refunded_pence: b.refundedPence }, s),
    };
  });

  /** One vehicle (kept for the single-car flow); the order engine prices it, so it is a one-vehicle order. */
  app.post('/bookings', async (req, reply) => {
    const b = itemSchema.extend({
      offerCode: z.string().max(40).nullish(), customerNotes: z.string().max(1000).nullish(),
      consents: z.object({ guardian: z.boolean().optional(), terms: z.boolean().optional(), marketingPhotos: z.boolean().optional() }).nullish(),
    }).parse(req.body);
    const key = z.string().max(100).optional().parse(req.headers['idempotency-key']);
    const [item] = await withGeo([b]); // measured on the server, outside the transaction
    const out = await tx((c) => createBooking(c, { ...item, customerId: req.user.sub, idempotencyKey: key }));
    const full = (await pool.query(`${customerBookingSql} WHERE b.id=$1`, [out.booking.id])).rows[0];
    return reply.status(out.replay ? 200 : 201).send(withFinance(full));
  });

  /** Several vehicles in one order: one price (offers, tax) and one payment. Send an Idempotency-Key header. */
  app.post('/orders', async (req, reply) => {
    const b = orderSchema.parse(req.body);
    const key = z.string().max(100).optional().parse(req.headers['idempotency-key']);
    const items = await withGeo(b.items);
    const out = await tx((c) => createOrder(c, { customerId: req.user.sub, items, offerCode: b.offerCode, customerNotes: b.customerNotes, consents: b.consents, idempotencyKey: key }));
    return reply.status(out.replay ? 200 : 201).send(await orderDetail(out.order.id, req.user.sub));
  });

  app.get('/orders/:id', async (req) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    return orderDetail(id, req.user.sub);
  });

  /** Customer cancellation of one vehicle. Unpaid bookings cancel immediately; paid ones become a request staff must action. */
  app.post('/bookings/:id/cancel', async (req) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    const { reason } = z.object({ reason: z.string().max(500).optional() }).parse(req.body ?? {});
    const actor = { type: 'customer' as const, id: req.user.sub };
    return tx(async (c) => {
      const b = await lockBooking(c, id);
      if (b.customer_id !== req.user.sub) throw notFound('Booking not found');
      if (['cancelled', 'rejected', 'completed', 'in_progress', 'cancellation_requested'].includes(b.status)) {
        throw conflict('This booking can no longer be cancelled online', 'not_cancellable');
      }
      if (b.paid_pence === 0 && ['pending', 'awaiting_payment', 'payment_failed'].includes(b.status)) {
        await changeStatus(c, id, 'cancelled', actor, { reason: reason ?? 'Cancelled by customer' });
        return { status: 'cancelled' };
      }
      await changeStatus(c, id, 'cancellation_requested', actor, { reason: reason ?? 'Requested by customer' });
      return { status: 'cancellation_requested' };
    });
  });

  /** Starts (or resumes) a Stripe PaymentIntent for what is due on the booking's order. */
  app.post('/bookings/:id/pay', async (req) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    const { which } = z.object({ which: z.enum(['due_now', 'balance']).default('due_now') }).parse(req.body ?? {});
    return createPaymentIntent(id, req.user.sub, which);
  });

  app.post('/orders/:id/pay', async (req) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    const { which } = z.object({ which: z.enum(['due_now', 'balance']).default('due_now') }).parse(req.body ?? {});
    return createOrderPaymentIntent(id, req.user.sub, which);
  });

  /* ----- Extending a booking ----- */
  const hoursBody = z.object({ hours: z.number().int().min(1).max(12) });

  /** Is the extra time free, and what would it cost? Checked on the server; nothing is saved. */
  app.post('/bookings/:id/extension-quote', async (req) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    const { hours } = hoursBody.parse(req.body);
    return tx((c) => quoteExtension(c, id, hours, { customerId: req.user.sub }));
  });

  /**
   * Confirms an extension. Availability is checked again here, under the car's lock. `expectedEndAt` is the end time
   * the customer saw: if the booking has changed since (e.g. a double tap already extended it), nothing happens.
   */
  app.post('/bookings/:id/extend', async (req) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    const b = hoursBody.extend({ expectedEndAt: z.string().datetime({ offset: true }) }).parse(req.body);
    const r = await tx((c) => applyExtension(c, id, b.hours, { type: 'customer', id: req.user.sub }, { customerId: req.user.sub, expectedEndAt: b.expectedEndAt }));
    return { extension: r.extension, finance: await loadFinance(pool, id) };
  });

  /** "Contact us": asks staff for more time (or another car) when the extension isn't possible online. */
  app.post('/bookings/:id/extension-requests', async (req, reply) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    const b = hoursBody.extend({ message: z.string().max(1000).nullish() }).parse(req.body);
    const row = await tx((c) => requestExtension(c, id, b.hours, req.user.sub, b.message ?? null));
    return reply.status(201).send({ id: row.id, status: row.status, requestedEndAt: row.requested_end_at });
  });

  app.get('/payments', async (req) => ({
    items: (await pool.query(
      `SELECT p.id, o.ref AS "bookingRef", p.amount_pence AS "amountPence", p.status, p.method, p.source, p.purpose, COALESCE(p.paid_at, p.created_at) AS "paidAt", p.created_at AS "createdAt"
         FROM payments p JOIN orders o ON o.id=p.order_id WHERE p.customer_id=$1 AND p.status IN ('succeeded','failed') ORDER BY p.created_at DESC`, [req.user.sub])).rows,
  }));

  /* ----- Receipts. A customer only ever sees their own; anything else is "not found". ----- */
  app.get('/invoices', async (req) => ({ items: await invoicesFor(pool, 'customer', req.user.sub) }));

  app.get('/invoices/:id/document', async (req, reply) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    const doc = (await pool.query('SELECT * FROM invoices WHERE id=$1 AND customer_id=$2', [id, req.user.sub])).rows[0];
    if (!doc) throw notFound('Document not found');
    return reply.type('text/html; charset=utf-8').header('cache-control', 'no-store').send(renderDocument(doc));
  });

  app.get('/bookings/:id/statement', async (req, reply) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    if (!(await pool.query('SELECT 1 FROM bookings WHERE id=$1 AND customer_id=$2', [id, req.user.sub])).rowCount) throw notFound('Booking not found');
    return reply.type('text/html; charset=utf-8').header('cache-control', 'no-store').send(await renderStatement(pool, id));
  });

  app.get('/notifications', async (req) => ({
    items: (await pool.query(
      `SELECT id, kind, title, body, booking_id AS "bookingId", read_at AS "readAt", created_at AS "createdAt"
         FROM notifications WHERE customer_id=$1 AND NOT staff_only ORDER BY created_at DESC LIMIT 100`, [req.user.sub])).rows,
  }));

  app.post('/notifications/read', async (req) => {
    await pool.query('UPDATE notifications SET read_at=now() WHERE customer_id=$1 AND read_at IS NULL', [req.user.sub]);
    return { ok: true };
  });
}
