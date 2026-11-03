import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { pool, tx } from '../../core/db.js';
import { notFound } from '../../core/errors.js';
import { loadOrderFinance } from '../finance/finance.js';
import { invoicesFor } from '../finance/documents.js';
import { audit } from '../../core/util.js';
import { addOrderItem, createOrder, quoteOrder } from './orders.js';
import { itemSchema, orderSchema, withGeo } from './booking.schemas.js';
import { orderOverview } from './orders.js';


const uuid = z.string().uuid();

export function orderRoutes(app: FastifyInstance) {
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
}
