import { describe, expect, it } from 'vitest';
import { calculatePrice, type PricingRule, type PriceInput } from '../src/pricing.js';

const settings = { 'pricing.serviceFeeBp': 500, 'payment.mode': 'full', 'payment.depositPercentBp': 3000 } as const;
const vehicle = { id: 'v1', price_per_hour_pence: 20000, delivery_available: true, delivery_fee_pence: 5000, chauffeur_available: true, chauffeur_fee_pence: 10000, deposit_pence: 0 };
const rule = (r: Partial<PricingRule>): PricingRule => ({ id: 'r' + Math.random(), vehicle_id: null, event_type_id: null, kind: 'hourly', label: null, hours: null, amount_pence: null, multiplier_bp: null, starts_on: null, ends_on: null, ...r });
const base = (over: Partial<PriceInput> = {}): PriceInput => ({
  vehicle, rules: [], eventTypeId: 'e1', hours: 2, localDate: '2030-06-15', experience: 'stationary', chauffeur: false, addons: [], settings: { ...settings }, ...over,
});

describe('calculatePrice', () => {
  it('uses the vehicle rate with service fee when no rules exist', () => {
    const p = calculatePrice(base());
    expect(p.subtotalPence).toBe(40000);
    expect(p.serviceFeePence).toBe(2000);
    expect(p.totalPence).toBe(42000);
    expect(p.depositDuePence).toBe(42000);
  });

  it('vehicle+event rule beats vehicle rule beats event rule', () => {
    const rules = [
      rule({ event_type_id: 'e1', amount_pence: 10000 }),
      rule({ vehicle_id: 'v1', amount_pence: 15000 }),
      rule({ vehicle_id: 'v1', event_type_id: 'e1', amount_pence: 18000 }),
    ];
    expect(calculatePrice(base({ rules })).subtotalPence).toBe(36000);
    expect(calculatePrice(base({ rules: rules.slice(0, 2) })).subtotalPence).toBe(30000);
    expect(calculatePrice(base({ rules: rules.slice(0, 1) })).subtotalPence).toBe(20000);
  });

  it('ignores rules for other vehicles or events', () => {
    const rules = [rule({ vehicle_id: 'other', amount_pence: 1 }), rule({ event_type_id: 'other', amount_pence: 1 })];
    expect(calculatePrice(base({ rules })).subtotalPence).toBe(40000);
  });

  it('applies the largest fitting package then charges extra hours', () => {
    const rules = [
      rule({ kind: 'package', hours: 4, amount_pence: 60000, label: 'Half day' }),
      rule({ kind: 'package', hours: 8, amount_pence: 100000, label: 'Full day' }),
      rule({ kind: 'extra_hour', amount_pence: 12000 }),
    ];
    const p = calculatePrice(base({ rules, hours: 5 }));
    expect(p.subtotalPence).toBe(72000);
    expect(p.durationBasis).toBe('Half day + 1h extra');
    expect(calculatePrice(base({ rules, hours: 4 })).subtotalPence).toBe(60000);
    expect(calculatePrice(base({ rules, hours: 3 })).subtotalPence).toBe(60000); // 3h < smallest package => hourly
  });

  it('applies only one special-date multiplier, most specific then highest', () => {
    const rules = [
      rule({ kind: 'special_date', multiplier_bp: 12000, starts_on: '2030-06-01', ends_on: '2030-06-30' }),
      rule({ kind: 'special_date', multiplier_bp: 15000, starts_on: '2030-06-10', ends_on: '2030-06-20' }),
      rule({ kind: 'special_date', multiplier_bp: 11000, vehicle_id: 'v1', starts_on: '2030-06-10', ends_on: '2030-06-20' }),
    ];
    expect(calculatePrice(base({ rules })).subtotalPence).toBe(44000); // vehicle-specific 1.10 wins over higher global
    expect(calculatePrice(base({ rules, localDate: '2030-07-01' })).subtotalPence).toBe(40000);
  });

  it('adds chauffeur and add-ons, then discount before fee; delivery is left for staff to price, outside the total', () => {
    const p = calculatePrice(base({
      experience: 'delivered', chauffeur: true, addons: [{ id: 'a', name: 'Photographer', price_pence: 9500 }],
      offer: { offerId: 'o', code: 'X', title: 'T', type: 'percent', value: 10 },
    }));
    expect(p.subtotalPence).toBe(40000 + 10000 + 9500);
    expect(p.lines.find((l) => l.key === 'delivery')).toBeUndefined();
    expect(p.deliveryEstimate).toMatchObject({ amountPence: null });
    expect(p.discountPence).toBe(5950);
    expect(p.serviceFeePence).toBe(Math.round((59500 - 5950) * 0.05));
    expect(p.totalPence).toBe(59500 - 5950 + p.serviceFeePence);
  });

  it('prices add-ons per hour and by quantity', () => {
    const p = calculatePrice(base({ hours: 3, addons: [
      { id: 'a', name: 'Decoration', price_pence: 2000, pricing_type: 'per_unit', quantity: 2 },
      { id: 'b', name: 'Photographer', price_pence: 5000, pricing_type: 'per_hour', quantity: 1 },
    ] }));
    expect(p.lines.find((l) => l.key === 'addon:a')).toMatchObject({ amountPence: 4000, label: 'Decoration × 2' });
    expect(p.lines.find((l) => l.key === 'addon:b')).toMatchObject({ amountPence: 15000, label: expect.stringContaining('3h') });
  });

  it('works out the deposit on the rental price, before any delivery charge (the £200 / £100 example)', () => {
    const p = calculatePrice(base({
      vehicle: { ...vehicle, price_per_hour_pence: 10000, delivery_fee_pence: 0 }, experience: 'delivered', distances: { deliveryMiles: 20, routeMiles: null },
      settings: { 'pricing.serviceFeeBp': 0, 'payment.mode': 'deposit', 'payment.depositPercentBp': 5000, 'delivery.ratePerMilePence': 270 },
    }));
    expect(p.totalPence).toBe(20000);
    expect(p.depositDuePence).toBe(10000);
    expect(p.deliveryEstimate).toMatchObject({ amountPence: null, miles: null, ratePerMilePence: null });
  });

  it('charges showroom collection only when a fee is configured', () => {
    expect(calculatePrice(base()).lines.find((l) => l.key === 'showroom')).toBeUndefined();
    const p = calculatePrice(base({ settings: { ...settings, 'delivery.showroomFeePence': 1500 } }));
    expect(p.lines.find((l) => l.key === 'showroom')!.amountPence).toBe(1500);
  });

  it('caps a fixed discount at the subtotal', () => {
    const p = calculatePrice(base({ offer: { offerId: 'o', code: 'X', title: 'T', type: 'fixed', value: 999999 } }));
    expect(p.totalPence).toBe(0);
  });

  it('rejects delivery/chauffeur when the vehicle does not offer them', () => {
    const v = { ...vehicle, delivery_available: false, chauffeur_available: false };
    expect(() => calculatePrice(base({ vehicle: v, experience: 'delivered' }))).toThrow();
    expect(() => calculatePrice(base({ vehicle: v, chauffeur: true }))).toThrow();
  });

  it('computes the deposit due now in deposit mode', () => {
    const pct = calculatePrice(base({ settings: { ...settings, 'payment.mode': 'deposit' } }));
    expect(pct.depositDuePence).toBe(Math.round(42000 * 0.3));
    const fixed = calculatePrice(base({ vehicle: { ...vehicle, deposit_pence: 10000 }, settings: { ...settings, 'payment.mode': 'deposit' } }));
    expect(fixed.depositDuePence).toBe(10000);
  });
});

describe('distance and chauffeur pricing', () => {
  const perMile = { ...vehicle, delivery_pricing: 'per_mile' as const, delivery_per_mile_pence: 180, delivery_free_miles: 5, delivery_min_pence: 2000 };

  it('never prices delivery from a distance, whatever the car is set to: staff add the charge by hand', () => {
    for (const v of [perMile, { ...perMile, delivery_round_trip: true }, vehicle, { ...vehicle, delivery_fee_pence: 0 }]) {
      const p = calculatePrice(base({ vehicle: v, experience: 'delivered', distances: { deliveryMiles: 25, routeMiles: null } }));
      expect(p.deliveryEstimate).toMatchObject({ amountPence: null, miles: null, ratePerMilePence: null });
      expect(p.totalPence).toBe(42000);
    }
    expect(() => calculatePrice(base({ vehicle: perMile, experience: 'delivered' }))).not.toThrow(); // no distance needed
  });

  it('multiplies an hourly chauffeur charge by the booked hours, and leaves a fixed one alone', () => {
    const hourly = { ...vehicle, chauffeur_charge_type: 'hourly' as const, chauffeur_fee_pence: 3500 };
    expect(calculatePrice(base({ vehicle: hourly, chauffeur: true, hours: 4 })).lines.find((l) => l.key === 'chauffeur')).toMatchObject({ amountPence: 14000, label: expect.stringContaining('4h') });
    expect(calculatePrice(base({ vehicle: { ...vehicle, chauffeur_charge_type: 'fixed' }, chauffeur: true, hours: 4 })).lines.find((l) => l.key === 'chauffeur')!.amountPence).toBe(10000);
  });

  it('prices a pick-up and drop-off trip by distance with the most specific per-mile rule and a minimum', () => {
    const rules = [
      rule({ kind: 'per_mile', amount_pence: 150, min_amount_pence: 2500 }), // global
      rule({ kind: 'per_mile', amount_pence: 200, min_amount_pence: 3000, vehicle_id: 'v1', event_type_id: 'e1' }), // most specific
    ];
    const trip = (miles: number) => calculatePrice(base({ rules, eventBasis: 'distance', chauffeur: true, distances: { deliveryMiles: null, routeMiles: miles } }));
    expect(trip(20).lines[0]).toMatchObject({ key: 'duration', amountPence: 4000 });
    expect(trip(20).durationBasis).toContain('20 miles');
    expect(trip(5).lines[0].amountPence).toBe(3000); // minimum
    expect(trip(5).distances.routeMiles).toBe(5);
    // hourly rules are ignored for distance trips
    const withHourly = calculatePrice(base({ rules: [...rules, rule({ kind: 'hourly', amount_pence: 99999 })], eventBasis: 'distance', distances: { deliveryMiles: null, routeMiles: 20 } }));
    expect(withHourly.lines[0].amountPence).toBe(4000);
  });

  it('refuses to price a distance trip with no route or no per-mile rate', () => {
    expect(() => calculatePrice(base({ eventBasis: 'distance', rules: [rule({ kind: 'per_mile', amount_pence: 100 })] }))).toThrow(/pick-up and drop-off/i);
    expect(() => calculatePrice(base({ eventBasis: 'distance', distances: { deliveryMiles: null, routeMiles: 10 } }))).toThrow(/not set up/i);
  });
});
