import type { Q } from './db.js';
import type { Settings } from './settings.js';
import { badRequest, conflict } from './errors.js';

/** "£1.80" or "£240" for labels in the price breakdown. */
const gbp = (pence: number) => '£' + (pence % 100 === 0 ? String(pence / 100) : (pence / 100).toFixed(2));

/*
 * Pricing precedence (documented in docs/ARCHITECTURE.md)
 *
 * Duration charge, evaluated per scope level, most specific first:
 *   1. rule for this vehicle AND this event
 *   2. rule for this vehicle (any event)
 *   3. rule for this event (any vehicle)  -- an event default
 *   4. the vehicle's own price_per_hour (always exists)
 * The first level that has an applicable `hourly` or `package` rule wins as a whole; levels are never mixed.
 * Within that level: the largest `package` whose hours <= booked hours is used, and any remaining hours are
 * charged at that level's `extra_hour` rate (else its hourly rate, else the vehicle rate).
 * If no package fits, hours x hourly rate.
 *
 * Special-date rules multiply the duration charge. If several match the date, the most specific scope wins,
 * and ties go to the highest multiplier. Only one special-date rule is ever applied.
 *
 * Then: + chauffeur + add-ons (+ an optional showroom collection fee) = the vehicle's subtotal (priceItem).
 * Offers, tax, the service fee and the deposit are worked out for the whole order (priceOrder, below).
 *
 * Delivery is NOT part of the quoted total. It is returned as `deliveryEstimate` for the customer to see, and staff
 * confirm the final charge per booking (booking_charges), which is then added to the booking total. This way a
 * customer is never charged for an unconfirmed estimate, and the deposit is worked out on the rental price only.
 */

export type PricingRule = {
  id: string;
  vehicle_id: string | null;
  event_type_id: string | null;
  kind: 'hourly' | 'package' | 'extra_hour' | 'special_date' | 'per_mile';
  label: string | null;
  hours: number | null;
  amount_pence: number | null;
  min_amount_pence?: number | null; // per_mile only: the least a distance-priced trip costs
  multiplier_bp: number | null;
  starts_on: string | null; // yyyy-mm-dd
  ends_on: string | null;
};

export type VehiclePricingInfo = {
  id: string;
  price_per_hour_pence: number;
  delivery_available: boolean;
  delivery_fee_pence: number;
  delivery_pricing?: 'flat' | 'per_mile';
  delivery_per_mile_pence?: number;
  delivery_free_miles?: number;
  delivery_min_pence?: number;
  delivery_round_trip?: boolean;
  delivery_radius_miles?: number;
  chauffeur_available: boolean;
  chauffeur_fee_pence: number;
  chauffeur_charge_type?: 'fixed' | 'hourly';
  deposit_pence: number;
};

/** Distances measured by the server (never supplied by a client). */
export type Distances = { deliveryMiles: number | null; routeMiles: number | null };

/** "1 mile", "2.4 miles": how distances read on quotes, bookings and charges. */
export const milesLabel = (n: number) => `${n} ${n === 1 ? 'mile' : 'miles'}`;

export type AddonRow = { id: string; name: string; price_pence: number; pricing_type?: 'fixed' | 'per_hour' | 'per_unit'; quantity?: number };

/** What one add-on costs on a booking: per-hour add-ons are multiplied by the booked hours, everything by the quantity. */
export const addonTotal = (a: AddonRow, hours: number) => a.price_pence * (a.quantity ?? 1) * (a.pricing_type === 'per_hour' ? hours : 1);

export type OfferDiscount = { offerId: string; code: string | null; title: string; type: 'percent' | 'fixed'; value: number };

export type PriceInput = {
  vehicle: VehiclePricingInfo;
  rules: PricingRule[];
  eventTypeId: string | null;
  hours: number;
  localDate: string; // yyyy-mm-dd in the business timezone
  experience: 'stationary' | 'delivered';
  /** 'distance' events (pick-up and drop-off) are priced per mile instead of per hour. */
  eventBasis?: 'hourly' | 'distance';
  distances?: Distances;
  chauffeur: boolean;
  addons: AddonRow[];
  offer?: OfferDiscount | null;
  settings: Pick<Settings, 'pricing.serviceFeeBp' | 'payment.mode' | 'payment.depositPercentBp'>
    & Partial<Pick<Settings, 'delivery.ratePerMilePence' | 'delivery.showroomFeePence' | 'tax.enabled' | 'tax.rateBp' | 'tax.policy' | 'tax.label'>>;
};

/** Shown to the customer before booking; never payable until staff confirm a final charge. */
export type DeliveryEstimate = { amountPence: number | null; miles: number | null; ratePerMilePence: number | null; label: string };

export type PriceLine = { key: string; label: string; amountPence: number };
export type PricingSnapshot = {
  version: 1 | 2 | 3;
  currency: 'gbp';
  hours: number;
  lines: PriceLine[];
  durationBasis: string;
  subtotalPence: number;
  discountPence: number;
  serviceFeePence: number;
  /** The tax on this booking (named vatPence in older snapshots). */
  vatPence: number;
  taxPence?: number;
  taxablePence?: number;
  tax?: TaxConfig;
  totalPence: number;
  depositDuePence: number;
  appliedRuleIds: string[];
  distances: Distances;
  /** version 2+: delivery is quoted here, outside the total, and confirmed by staff later. */
  deliveryEstimate?: DeliveryEstimate | null;
  offer: null | { offerId: string; code: string | null; title: string; type: string; value: number; discountPence: number };
  offers?: AppliedOffer[];
  settings: { serviceFeeBp: number; vatBp: number; paymentMode: string };
};

/** One vehicle's own price: its lines, before order-level discounts, tax and fees. */
export type ItemPrice = {
  hours: number; lines: PriceLine[]; durationBasis: string; rentalPence: number; subtotalPence: number;
  appliedRuleIds: string[]; distances: Distances; deliveryEstimate: DeliveryEstimate | null;
};

const rank = (r: PricingRule, vehicleId: string, eventTypeId: string | null): number | null => {
  const v = r.vehicle_id === vehicleId;
  const e = !!eventTypeId && r.event_type_id === eventTypeId;
  if (r.vehicle_id && !v) return null;
  if (r.event_type_id && !e) return null;
  if (v && e) return 3;
  if (v) return 2;
  if (e) return 1;
  return 0; // global rule (no vehicle, no event)
};

export function priceItem(i: Omit<PriceInput, 'offer'>): ItemPrice {
  const { vehicle, hours } = i;
  if (!Number.isInteger(hours) || hours < 1) throw badRequest('Hours must be a positive whole number');

  const applicable = i.rules
    .map((r) => ({ r, rk: rank(r, vehicle.id, i.eventTypeId) }))
    .filter((x): x is { r: PricingRule; rk: number } => x.rk !== null);

  // Highest level that has hourly or package rules.
  const durationRules = applicable.filter((x) => x.r.kind === 'hourly' || x.r.kind === 'package' || x.r.kind === 'extra_hour');
  const topLevel = durationRules.reduce((m, x) => Math.max(m, x.rk), -1);
  const level = durationRules.filter((x) => x.rk === topLevel).map((x) => x.r);
  const hourlyRule = level.find((r) => r.kind === 'hourly');
  const extraRule = level.find((r) => r.kind === 'extra_hour');
  const baseRate = hourlyRule?.amount_pence ?? vehicle.price_per_hour_pence;
  const extraRate = extraRule?.amount_pence ?? baseRate;
  const pkg = level
    .filter((r) => r.kind === 'package' && r.hours! <= hours)
    .sort((a, b) => b.hours! - a.hours!)[0];

  const applied: string[] = [];
  let duration: number;
  let basis: string;
  const dist = i.distances ?? { deliveryMiles: null, routeMiles: null };
  if (i.eventBasis === 'distance') {
    // Pick-up and drop-off: the trip is priced by distance. Most specific per-mile rule wins, same as hourly rates.
    const miles = dist.routeMiles;
    if (miles == null) throw badRequest('Add a pick-up and drop-off address to price this trip', 'route_required');
    const top = applicable.filter((x) => x.r.kind === 'per_mile').sort((a, b) => b.rk - a.rk)[0]?.r;
    if (!top) throw conflict('Pricing is not set up for this event yet. Please contact us.', 'pricing_not_configured');
    duration = Math.max(top.min_amount_pence ?? 0, Math.round(miles * top.amount_pence!));
    basis = `${milesLabel(miles)} at ${gbp(top.amount_pence!)} per mile${top.min_amount_pence && duration === top.min_amount_pence ? ` (minimum ${gbp(top.min_amount_pence)})` : ''}`;
    applied.push(top.id);
  } else if (pkg) {
    const extra = hours - pkg.hours!;
    duration = pkg.amount_pence! + extra * extraRate;
    basis = extra > 0 ? `${pkg.label ?? pkg.hours + 'h package'} + ${extra}h extra` : (pkg.label ?? `${pkg.hours}h package`);
    applied.push(pkg.id);
    if (extra > 0 && extraRule) applied.push(extraRule.id);
  } else {
    duration = baseRate * hours;
    basis = `${hours}h at hourly rate`;
    if (hourlyRule) applied.push(hourlyRule.id);
  }

  const lines: PriceLine[] = [{ key: 'duration', label: basis, amountPence: duration }];

  // Special date multiplier.
  const specials = applicable
    .filter((x) => x.r.kind === 'special_date' && x.r.starts_on! <= i.localDate && i.localDate <= x.r.ends_on!)
    .sort((a, b) => b.rk - a.rk || b.r.multiplier_bp! - a.r.multiplier_bp!);
  if (specials[0]) {
    const s = specials[0].r;
    const adjusted = Math.round((duration * s.multiplier_bp!) / 10000);
    lines.push({ key: 'special_date', label: s.label ?? 'Special date pricing', amountPence: adjusted - duration });
    duration = adjusted;
    applied.push(s.id);
  }

  let deliveryEstimate: DeliveryEstimate | null = null;
  if (i.experience === 'delivered') {
    if (!vehicle.delivery_available) throw badRequest('Delivery is not available for this vehicle', 'delivery_unavailable');
    // Delivery is priced by staff for each booking (they work out the distance) and added as a separate charge.
    deliveryEstimate = { amountPence: null, miles: null, ratePerMilePence: null, label: 'Delivery charge, worked out and added by our team' };
  } else if (i.eventBasis !== 'distance' && (i.settings['delivery.showroomFeePence'] ?? 0) > 0) {
    lines.push({ key: 'showroom', label: 'Showroom collection', amountPence: i.settings['delivery.showroomFeePence']! });
  }
  if (i.chauffeur) {
    if (!vehicle.chauffeur_available) throw badRequest('A chauffeur is not available for this vehicle', 'chauffeur_unavailable');
    if (vehicle.chauffeur_fee_pence) {
      const hourly = vehicle.chauffeur_charge_type === 'hourly';
      lines.push({
        key: 'chauffeur',
        label: hourly ? `Chauffeur (${gbp(vehicle.chauffeur_fee_pence)}/h × ${hours}h)` : 'Chauffeur',
        amountPence: hourly ? vehicle.chauffeur_fee_pence * hours : vehicle.chauffeur_fee_pence,
      });
    }
  }
  for (const a of i.addons) {
    const qty = a.quantity ?? 1;
    const label = a.pricing_type === 'per_hour' ? `${a.name} (${gbp(a.price_pence)}/h × ${hours}h${qty > 1 ? ` × ${qty}` : ''})` : qty > 1 ? `${a.name} × ${qty}` : a.name;
    lines.push({ key: 'addon:' + a.id, label, amountPence: addonTotal(a, hours) });
  }

  const subtotal = lines.reduce((s, l) => s + l.amountPence, 0);
  const rental = lines.filter((l) => isRentalLine(l.key)).reduce((s, l) => s + l.amountPence, 0);
  return { hours, lines, durationBasis: basis, rentalPence: rental, subtotalPence: subtotal, appliedRuleIds: applied, distances: dist, deliveryEstimate };
}

/* =====================================================================================================================
 * Order pricing: one engine for quotes, customer and staff bookings, adding or removing vehicles, extensions,
 * checkout and receipts. Every amount is integer pence; percentages are applied to integers and rounded once.
 *
 *   1. each vehicle's own price (priceItem: its own rates and duration)
 *   2. order subtotal = sum of the vehicles
 *   3. offers: every eligible offer is evaluated on the vehicles in this order; the highest priority (then biggest
 *      discount) applies, and others are added only if every applied offer allows stacking; the total discount
 *      never exceeds the subtotal
 *   4. tax on the taxable amount: after discounts (default) or before discounts, at the rate saved on the order
 *   5. service fee on the discounted subtotal (not taxed)
 *   6. the deposit (or full amount) due now
 * Discount, tax and fee are then shared out across the vehicles so the vehicles always add up to the order exactly.
 * ===================================================================================================================== */

export const isRentalLine = (key: string) => key === 'duration' || key === 'special_date' || (key.startsWith('extension:') && key.endsWith(':rental'));

/** x * basis points, rounded to the nearest penny (half up). Integer maths only. */
export const applyBp = (pence: number, bp: number) => Math.floor((pence * bp + 5000) / 10000);

/** Splits `total` across weights in proportion, exactly (largest remainder). Zero weights get nothing. */
export function allocate(total: number, weights: number[]): number[] {
  const sum = weights.reduce((s, w) => s + w, 0);
  if (!total || sum <= 0) return weights.map(() => 0);
  const raw = weights.map((w) => (total * w) / sum);
  const out = raw.map((r) => Math.floor(r));
  let left = total - out.reduce((s, v) => s + v, 0);
  const order = raw.map((r, i) => ({ i, frac: r - Math.floor(r) })).sort((a, b) => b.frac - a.frac || a.i - b.i);
  for (const { i } of order) {
    if (left <= 0) break;
    if (weights[i] > 0) { out[i]++; left--; }
  }
  return out;
}

export type TaxConfig = { enabled: boolean; rateBp: number; policy: 'after_discount' | 'before_discount'; label: string };
export type OrderSettings = { serviceFeeBp: number; paymentMode: 'full' | 'deposit' | string; depositPercentBp: number };

/** One vehicle in an order, as the order engine sees it. */
export type OrderItemForPricing = {
  key: string;
  vehicleId: string;
  category: string;
  eventTypeId: string | null;
  vehicleDepositPence: number;
  lines: PriceLine[];
  rentalPence: number;
  subtotalPence: number;
};

/** An offer's rules, as evaluated against an order. Promo codes and automatic offers use the same shape. */
export type OfferRule = {
  offerId: string | null;
  code: string | null;
  title: string;
  type: 'percent' | 'fixed';
  value: number;
  appliesTo: 'rental' | 'subtotal';
  minVehicles: number;
  maxVehicles: number | null;
  vehicleIds: string[] | null;
  categories: string[] | null;
  eventTypeIds: string[] | null;
  requiredVehicleIds: string[] | null;
  requiredCategories: string[] | null;
  minSubtotalPence: number;
  maxDiscountPence: number | null;
  priority: number;
  stackable: boolean;
};

export type AppliedOffer = {
  offerId: string | null; code: string | null; title: string; type: 'percent' | 'fixed'; value: number; appliesTo: 'rental' | 'subtotal';
  eligibleVehicles: number; basePence: number; discountPence: number; conditions: string;
};

export type OrderPrice = {
  version: 3;
  currency: 'gbp';
  items: { key: string; subtotalPence: number; rentalPence: number; discountPence: number; taxablePence: number; taxPence: number; feePence: number; totalPence: number; depositPence: number }[];
  rentalSubtotalPence: number;
  subtotalPence: number;
  offers: AppliedOffer[];
  /** A promo code that was valid but not used, because a better offer applied and they cannot be combined. */
  notApplied: { title: string; code: string | null; reason: string }[];
  discountPence: number;
  taxablePence: number;
  tax: TaxConfig;
  taxPence: number;
  serviceFeePence: number;
  totalPence: number;
  depositDuePence: number;
  settings: OrderSettings;
};

export const offerConditions = (o: OfferRule) => [
  o.minVehicles > 1 ? `${o.minVehicles}${o.maxVehicles ? `-${o.maxVehicles}` : '+'} vehicles` : o.maxVehicles ? `up to ${o.maxVehicles} vehicles` : null,
  o.categories?.length ? `${o.categories.join(' or ')} cars` : null,
  o.requiredCategories?.length ? `with a ${o.requiredCategories.join(' and a ')}` : null,
  o.minSubtotalPence ? `orders over ${gbp(o.minSubtotalPence)}` : null,
  o.appliesTo === 'rental' ? 'on vehicle rental' : null,
].filter(Boolean).join(', ') || 'any booking';

/** Is this offer allowed for these vehicles, and what does it give? A reason is returned when it does not apply. */
export function evaluateOffer(o: OfferRule, items: OrderItemForPricing[]): { ok: true; eligible: number[]; base: number; discount: number } | { ok: false; reason: string } {
  const eligible = items.map((it, i) => ({ it, i })).filter(({ it }) =>
    (!o.vehicleIds?.length || o.vehicleIds.includes(it.vehicleId))
    && (!o.categories?.length || o.categories.includes(it.category))
    && (!o.eventTypeIds?.length || (!!it.eventTypeId && o.eventTypeIds.includes(it.eventTypeId))));
  if (!eligible.length) {
    if (o.eventTypeIds?.length && !items.some((it) => it.eventTypeId && o.eventTypeIds!.includes(it.eventTypeId))) return { ok: false, reason: 'That offer does not apply to this event' };
    return { ok: false, reason: items.length === 1 ? 'That offer does not apply to this car' : 'That offer does not apply to these cars' };
  }
  if (eligible.length < o.minVehicles) {
    const which = o.categories?.length ? `${o.categories.join(' or ')} cars` : o.vehicleIds?.length ? 'of the cars it covers' : 'vehicles';
    return { ok: false, reason: `That offer needs ${o.minVehicles} or more ${which} in one booking (${eligible.length} here)` };
  }
  if (o.maxVehicles != null && eligible.length > o.maxVehicles) return { ok: false, reason: `That offer is for up to ${o.maxVehicles} vehicles` };
  if (o.requiredVehicleIds?.length && !o.requiredVehicleIds.every((id) => items.some((it) => it.vehicleId === id))) return { ok: false, reason: 'That offer needs particular cars booked together' };
  if (o.requiredCategories?.length && !o.requiredCategories.every((cat) => items.some((it) => it.category === cat))) return { ok: false, reason: `That offer needs a ${o.requiredCategories.join(' and a ')} in the same booking` };
  const base = eligible.reduce((s, { it }) => s + (o.appliesTo === 'rental' ? it.rentalPence : it.subtotalPence), 0);
  if (base < o.minSubtotalPence) return { ok: false, reason: 'Your booking is below the minimum for this offer' };
  let discount = o.type === 'percent' ? Math.floor((base * o.value) / 100) : o.value;
  if (o.maxDiscountPence != null) discount = Math.min(discount, o.maxDiscountPence);
  discount = Math.min(discount, base);
  return { ok: true, eligible: eligible.map((e) => e.i), base, discount };
}

export function priceOrder(items: OrderItemForPricing[], offers: OfferRule[], tax: TaxConfig, s: OrderSettings): OrderPrice {
  if (!items.length) throw badRequest('An order needs at least one vehicle', 'no_items');
  if (!Number.isInteger(tax.rateBp) || tax.rateBp < 0 || tax.rateBp > 10000) throw badRequest('Tax rate must be between 0% and 100%', 'invalid_tax');
  const subtotal = items.reduce((t, it) => t + it.subtotalPence, 0);
  const rentalSubtotal = items.reduce((t, it) => t + it.rentalPence, 0);

  // Offers: evaluate everything, then pick by priority and size; stack only offers that all allow it.
  const evaluated = offers.map((o) => ({ o, r: evaluateOffer(o, items) }));
  const cands = evaluated.filter((x): x is { o: OfferRule; r: Extract<ReturnType<typeof evaluateOffer>, { ok: true }> } => x.r.ok && x.r.discount > 0)
    .sort((a, b) => b.o.priority - a.o.priority || b.r.discount - a.r.discount || (a.o.title < b.o.title ? -1 : 1));
  const chosen = cands.length ? [cands[0], ...(cands[0].o.stackable ? cands.slice(1).filter((x) => x.o.stackable) : [])] : [];
  const itemDiscount = items.map(() => 0);
  const applied: AppliedOffer[] = [];
  let room = subtotal;
  for (const { o, r } of chosen) {
    const d = Math.min(r.discount, room);
    if (d <= 0) continue;
    room -= d;
    const weights = items.map((it, i) => (r.eligible.includes(i) ? (o.appliesTo === 'rental' ? it.rentalPence : it.subtotalPence) : 0));
    allocate(d, weights).forEach((v, i) => { itemDiscount[i] += v; });
    applied.push({ offerId: o.offerId, code: o.code, title: o.title, type: o.type, value: o.value, appliesTo: o.appliesTo, eligibleVehicles: r.eligible.length, basePence: r.base, discountPence: d, conditions: offerConditions(o) });
  }
  // Never discount a vehicle below zero: move any excess to vehicles with room (only possible with stacked offers).
  for (let i = 0; i < items.length; i++) {
    let excess = itemDiscount[i] - items[i].subtotalPence;
    if (excess <= 0) continue;
    itemDiscount[i] -= excess;
    for (let j = 0; j < items.length && excess > 0; j++) {
      const free = items[j].subtotalPence - itemDiscount[j];
      const move = Math.min(free, excess);
      if (move > 0) { itemDiscount[j] += move; excess -= move; }
    }
  }
  const discount = itemDiscount.reduce((t, v) => t + v, 0);
  // Every offer that was considered but not used, with why (coupon codes and automatic offers alike), so staff can
  // see, for example, that an automatic offer needs one more car of the right category.
  const notApplied = evaluated.filter(({ o }) => !applied.some((a) => a.offerId === o.offerId))
    .map(({ o, r }) => ({ title: o.title, code: o.code, reason: r.ok ? 'A better offer is already applied and offers cannot be combined' : r.reason }));

  // Tax on the taxable amount, at the order's rate; fee on the discounted amount, not taxed.
  const itemTaxable = items.map((it, i) => (tax.enabled ? (tax.policy === 'before_discount' ? it.subtotalPence : it.subtotalPence - itemDiscount[i]) : 0));
  const taxable = itemTaxable.reduce((t, v) => t + v, 0);
  const taxTotal = tax.enabled ? applyBp(taxable, tax.rateBp) : 0;
  const itemTax = allocate(taxTotal, itemTaxable);
  const net = subtotal - discount;
  const fee = applyBp(net, s.serviceFeeBp);
  const itemFee = allocate(fee, items.map((it, i) => it.subtotalPence - itemDiscount[i]));
  const out = items.map((it, i) => {
    const total = it.subtotalPence - itemDiscount[i] + itemTax[i] + itemFee[i];
    const deposit = s.paymentMode === 'deposit'
      ? Math.min(total, it.vehicleDepositPence > 0 ? it.vehicleDepositPence : applyBp(total, s.depositPercentBp))
      : total;
    return { key: it.key, subtotalPence: it.subtotalPence, rentalPence: it.rentalPence, discountPence: itemDiscount[i], taxablePence: itemTaxable[i], taxPence: itemTax[i], feePence: itemFee[i], totalPence: total, depositPence: deposit };
  });
  return {
    version: 3,
    currency: 'gbp',
    items: out,
    rentalSubtotalPence: rentalSubtotal,
    subtotalPence: subtotal,
    offers: applied,
    notApplied,
    discountPence: discount,
    taxablePence: taxable,
    tax: { ...tax, rateBp: tax.enabled ? tax.rateBp : 0 },
    taxPence: taxTotal,
    serviceFeePence: fee,
    totalPence: out.reduce((t, v) => t + v.totalPence, 0),
    depositDuePence: out.reduce((t, v) => t + v.depositPence, 0),
    settings: s,
  };
}

/** The tax settings in force now, for a new order. */
export const taxFrom = (s: Partial<Pick<Settings, 'tax.enabled' | 'tax.rateBp' | 'tax.policy' | 'tax.label'>>): TaxConfig => ({
  enabled: !!s['tax.enabled'], rateBp: s['tax.rateBp'] ?? 0, policy: s['tax.policy'] === 'before_discount' ? 'before_discount' : 'after_discount', label: s['tax.label'] || 'VAT',
});

/** A promo code entered by the customer, as an order offer (no extra conditions beyond the old coupon rules). */
export const ruleFromOfferRow = (o: any): OfferRule => ({
  offerId: o.id, code: o.code, title: o.title, type: o.discount_type, value: o.discount_value, appliesTo: o.applies_to ?? 'subtotal',
  minVehicles: o.min_vehicles ?? 1, maxVehicles: o.max_vehicles ?? null, vehicleIds: o.vehicle_ids ?? null, categories: o.vehicle_categories ?? null,
  eventTypeIds: o.event_type_ids ?? null, requiredVehicleIds: o.required_vehicle_ids ?? null, requiredCategories: o.required_categories ?? null,
  minSubtotalPence: o.min_booking_pence ?? 0, maxDiscountPence: o.max_discount_pence ?? null, priority: o.priority ?? 0, stackable: !!o.stackable,
});

/** The per-vehicle snapshot stored on a booking: its lines plus its share of the order's discount, tax and fee. */
export function itemSnapshot(item: ItemPrice, alloc: OrderPrice['items'][number], order: OrderPrice): PricingSnapshot {
  const first = order.offers[0];
  return {
    version: 3,
    currency: 'gbp',
    hours: item.hours,
    lines: item.lines,
    durationBasis: item.durationBasis,
    subtotalPence: alloc.subtotalPence,
    discountPence: alloc.discountPence,
    serviceFeePence: alloc.feePence,
    vatPence: alloc.taxPence,
    taxPence: alloc.taxPence,
    taxablePence: alloc.taxablePence,
    tax: order.tax,
    totalPence: alloc.totalPence,
    depositDuePence: alloc.depositPence,
    appliedRuleIds: item.appliedRuleIds,
    distances: item.distances,
    deliveryEstimate: item.deliveryEstimate,
    offer: first ? { offerId: first.offerId ?? '', code: first.code, title: first.title, type: first.type, value: first.value, discountPence: alloc.discountPence } : null,
    offers: order.offers,
    settings: { serviceFeeBp: order.settings.serviceFeeBp, vatBp: order.tax.rateBp, paymentMode: order.settings.paymentMode },
  };
}

/** One vehicle priced on its own, with an optional promo code: the single-booking view of the order engine. */
export function calculatePrice(i: PriceInput): PricingSnapshot {
  const item = priceItem(i);
  const rules = i.offer ? [{
    offerId: i.offer.offerId, code: i.offer.code, title: i.offer.title, type: i.offer.type, value: i.offer.value, appliesTo: 'subtotal' as const,
    minVehicles: 1, maxVehicles: null, vehicleIds: null, categories: null, eventTypeIds: null, requiredVehicleIds: null, requiredCategories: null,
    minSubtotalPence: 0, maxDiscountPence: null, priority: 0, stackable: false,
  }] : [];
  const order = priceOrder(
    [{ key: 'item', vehicleId: i.vehicle.id, category: '', eventTypeId: i.eventTypeId, vehicleDepositPence: i.vehicle.deposit_pence, lines: item.lines, rentalPence: item.rentalPence, subtotalPence: item.subtotalPence }],
    rules, taxFrom(i.settings), { serviceFeeBp: i.settings['pricing.serviceFeeBp'], paymentMode: i.settings['payment.mode'], depositPercentBp: i.settings['payment.depositPercentBp'] },
  );
  return itemSnapshot(item, order.items[0], order);
}

export async function loadRules(q: Q, vehicleId: string, eventTypeId: string | null): Promise<PricingRule[]> {
  const r = await q.query(
    `SELECT id, vehicle_id, event_type_id, kind, label, hours, amount_pence, min_amount_pence, multiplier_bp,
            to_char(starts_on,'YYYY-MM-DD') AS starts_on, to_char(ends_on,'YYYY-MM-DD') AS ends_on
       FROM pricing_rules
      WHERE active AND (vehicle_id IS NULL OR vehicle_id = $1) AND (event_type_id IS NULL OR event_type_id = $2)
      ORDER BY created_at DESC, id`, // when two rules of the same kind tie for a car, the newest one is used
    [vehicleId, eventTypeId],
  );
  return r.rows;
}
