import type pg from 'pg';
import { badRequest } from '../../core/errors.js';
import { ruleFromOfferRow, type OfferRule } from '../pricing/pricing.js';

/** Which offers apply to a customer's order: automatic offers and promo codes. */

type C = pg.PoolClient;

const offerUsageFilter = `
  (o.usage_limit IS NULL OR (SELECT count(*) FROM offer_redemptions r WHERE r.offer_id=o.id AND r.released_at IS NULL AND r.order_id IS DISTINCT FROM $2) < o.usage_limit)
  AND (o.per_customer_limit IS NULL OR (SELECT count(*) FROM offer_redemptions r WHERE r.offer_id=o.id AND r.customer_id=$1 AND r.released_at IS NULL AND r.order_id IS DISTINCT FROM $2) < o.per_customer_limit)`;

/** Automatic offers that are switched on, in date, and not used up (for this customer). */
export async function activeAutoOffers(c: Pick<C, 'query'>, customerId: string, orderId: string | null = null): Promise<OfferRule[]> {
  const rows = (await c.query(
    `SELECT o.* FROM offers o WHERE o.active AND o.auto_apply AND (o.starts_at IS NULL OR o.starts_at <= now()) AND (o.ends_at IS NULL OR o.ends_at > now())
        AND ${offerUsageFilter}`, [customerId, orderId])).rows;
  return rows.map(ruleFromOfferRow);
}

/** A promo code the customer typed: it must exist, be switched on, be in date and not be used up. */
export async function promoCodeRule(c: Pick<C, 'query'>, code: string, customerId: string, lock: boolean): Promise<OfferRule> {
  const o = (await c.query(`SELECT * FROM offers WHERE upper(code) = upper($1) ${lock ? 'FOR UPDATE' : ''}`, [code.trim()])).rows[0];
  const bad = (m: string) => badRequest(m, 'invalid_offer');
  if (!o || !o.active) throw bad('That code is not valid');
  const now = new Date();
  if (o.starts_at && o.starts_at > now) throw bad('That offer has not started yet');
  if (o.ends_at && o.ends_at < now) throw bad('That offer has expired');
  if (o.usage_limit != null) {
    const used = (await c.query('SELECT count(*)::int n FROM offer_redemptions WHERE offer_id=$1 AND released_at IS NULL', [o.id])).rows[0].n;
    if (used >= o.usage_limit) throw bad('That offer has been fully redeemed');
  }
  if (o.per_customer_limit != null) {
    const used = (await c.query('SELECT count(*)::int n FROM offer_redemptions WHERE offer_id=$1 AND customer_id=$2 AND released_at IS NULL', [o.id, customerId])).rows[0].n;
    if (used >= o.per_customer_limit) throw bad('You have already used this offer');
  }
  return ruleFromOfferRow(o);
}
