import type { Q } from '../../core/db.js';
import { notFound } from '../../core/errors.js';
import { orderStatus } from '../bookings/orders.js';

/*
 * Booking money, in one place. Money belongs to the order (one or more vehicles booked together); a vehicle's screens
 * show its order's figures. Every screen, receipt and payment request reads from here, so the displayed total,
 * the amount sent to the gateway, the recorded payments and the receipts always agree.
 *
 *   final total  = quoted price (rental + driver + add-ons + fees - discount, frozen at booking)
 *                + confirmed charges (delivery, adjustments; credits are negative)
 *   net paid     = succeeded payments - refunds (pending refunds count, to be safe)
 *   balance due  = final total - net paid, never below zero (an overpayment shows as a credit instead)
 *
 * Pending delivery estimates are shown but never counted. All amounts are integer pence.
 */

export const CLOSED = ['cancelled', 'rejected'];
export const gbp = (pence: number) => (pence < 0 ? '-' : '') + '£' + (Math.abs(pence) / 100).toLocaleString('en-GB', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

export type Finance = {
  currency: string;
  quotedTotalPence: number;
  confirmedChargesPence: number;
  delivery: null | { status: 'pending' | 'confirmed'; amountPence: number; distanceMiles: number | null; ratePerMilePence: number | null };
  finalTotalPence: number;
  depositRequiredPence: number;
  depositMode: boolean;
  depositPaid: boolean;
  paidPence: number;
  refundedPence: number;
  netPaidPence: number;
  balanceDuePence: number;
  /** The part of the deposit (or full amount, without deposits) still to pay before the booking is secured. */
  dueNowPence: number;
  creditPence: number;
  paymentStatus: string;
};

type BookingMoney = {
  status: string; currency: string; quoted_total_pence: number; total_pence: number; deposit_due_pence: number;
  paid_pence: number; refunded_pence: number; payment_status: string;
};
type ChargeRow = { kind: string; status: string; amount_pence: number; distance_miles: number | null; rate_per_mile_pence: number | null };

export function summarize(b: BookingMoney, charges: ChargeRow[]): Finance {
  const net = b.paid_pence - b.refunded_pence;
  const closed = CLOSED.includes(b.status);
  const live = charges.filter((c) => c.status !== 'void');
  const d = live.find((c) => c.kind === 'delivery');
  const depositMode = b.deposit_due_pence < b.quoted_total_pence;
  return {
    currency: b.currency,
    quotedTotalPence: b.quoted_total_pence,
    confirmedChargesPence: live.filter((c) => c.status === 'confirmed').reduce((s, c) => s + c.amount_pence, 0),
    delivery: d ? { status: d.status as 'pending' | 'confirmed', amountPence: d.amount_pence, distanceMiles: d.distance_miles == null ? null : Number(d.distance_miles), ratePerMilePence: d.rate_per_mile_pence } : null,
    finalTotalPence: b.total_pence,
    depositRequiredPence: b.deposit_due_pence,
    depositMode,
    depositPaid: depositMode && net >= b.deposit_due_pence,
    paidPence: b.paid_pence,
    refundedPence: b.refunded_pence,
    netPaidPence: net,
    balanceDuePence: closed ? 0 : Math.max(0, b.total_pence - net),
    dueNowPence: closed ? 0 : Math.max(0, Math.min(b.deposit_due_pence, b.total_pence) - net),
    creditPence: closed ? 0 : Math.max(0, net - b.total_pence),
    paymentStatus: b.payment_status,
  };
}

/** The order's money, as seen from one of its vehicles (delivery shows that vehicle's delivery charge). */
export async function loadFinance(q: Q, bookingId: string): Promise<Finance> {
  const b = (await q.query('SELECT order_id FROM bookings WHERE id=$1', [bookingId])).rows[0];
  if (!b) throw notFound('Booking not found');
  return loadOrderFinance(q, b.order_id, bookingId);
}

export async function loadOrderFinance(q: Q, orderId: string, bookingId?: string): Promise<Finance> {
  const o = (await q.query('SELECT * FROM orders WHERE id=$1', [orderId])).rows[0];
  if (!o) throw notFound('Order not found');
  const items = (await q.query('SELECT status FROM bookings WHERE order_id=$1', [orderId])).rows;
  const charges = (await q.query(
    `SELECT kind, status, amount_pence, distance_miles, rate_per_mile_pence FROM booking_charges WHERE ${bookingId ? 'booking_id' : 'order_id'}=$1 ORDER BY created_at`, [bookingId ?? orderId])).rows;
  return summarize({ ...o, status: orderStatus(items) }, charges);
}

export async function bookingAddons(q: Q, bookingId: string) {
  return (await q.query(
    `SELECT id, addon_id AS "addonId", name, pricing_type AS "pricingType", unit_price_pence AS "unitPricePence", quantity, hours, total_pence AS "totalPence"
       FROM booking_addons WHERE booking_id=$1 ORDER BY created_at, name`, [bookingId])).rows;
}
