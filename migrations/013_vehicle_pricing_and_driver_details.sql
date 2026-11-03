-- Pricing now lives on each vehicle: the separate fleet-wide Pricing page is gone.
--
-- Rules with no vehicle (for every car, or for an event on every car) are copied onto each car they price today,
-- keeping the same precedence, so every quote stays the same:
--   * an event rule becomes a car + event rule, unless that car already had its own rule of that kind
--     (a car rule always beat an event rule) or its own car + event rule for that event;
--   * a fleet-wide rule becomes a car rule, unless that car already had its own car rule of that kind.
-- "Kind" groups the rules that compete: duration (hourly, package, extra hour), per mile, and special dates
-- (special dates only compete when their dates overlap).
-- The originals are switched off, not deleted: past bookings still reference them in their price snapshot.

-- 1. Event rules -> car + event rules (only for cars that offer the event). Runs first so the fleet-wide copies
--    below are not mistaken for a car's own rules.
INSERT INTO pricing_rules (vehicle_id, event_type_id, kind, label, hours, amount_pence, min_amount_pence, multiplier_bp, starts_on, ends_on, active, created_at)
SELECT v.id, r.event_type_id, r.kind, r.label, r.hours, r.amount_pence, r.min_amount_pence, r.multiplier_bp, r.starts_on, r.ends_on, true, r.created_at
  FROM pricing_rules r
  JOIN vehicle_event_types ve ON ve.event_type_id = r.event_type_id
  JOIN vehicles v ON v.id = ve.vehicle_id AND v.deleted_at IS NULL
 WHERE r.active AND r.vehicle_id IS NULL AND r.event_type_id IS NOT NULL
   AND NOT EXISTS (
     SELECT 1 FROM pricing_rules o
      WHERE o.active AND o.vehicle_id = v.id AND (o.event_type_id IS NULL OR o.event_type_id = r.event_type_id)
        AND (CASE WHEN o.kind IN ('hourly','package','extra_hour') THEN 'duration' ELSE o.kind END)
          = (CASE WHEN r.kind IN ('hourly','package','extra_hour') THEN 'duration' ELSE r.kind END)
        AND (r.kind <> 'special_date' OR (o.starts_on <= r.ends_on AND r.starts_on <= o.ends_on)));

-- 2. Fleet-wide rules -> car rules.
INSERT INTO pricing_rules (vehicle_id, event_type_id, kind, label, hours, amount_pence, min_amount_pence, multiplier_bp, starts_on, ends_on, active, created_at)
SELECT v.id, NULL, r.kind, r.label, r.hours, r.amount_pence, r.min_amount_pence, r.multiplier_bp, r.starts_on, r.ends_on, true, r.created_at
  FROM pricing_rules r
  CROSS JOIN vehicles v
 WHERE r.active AND r.vehicle_id IS NULL AND r.event_type_id IS NULL AND v.deleted_at IS NULL
   AND NOT EXISTS (
     SELECT 1 FROM pricing_rules o
      WHERE o.active AND o.vehicle_id = v.id AND o.event_type_id IS NULL
        AND (CASE WHEN o.kind IN ('hourly','package','extra_hour') THEN 'duration' ELSE o.kind END)
          = (CASE WHEN r.kind IN ('hourly','package','extra_hour') THEN 'duration' ELSE r.kind END)
        AND (r.kind <> 'special_date' OR (o.starts_on <= r.ends_on AND r.starts_on <= o.ends_on)));

-- 3. Switch the originals off. Every rule from now on belongs to a vehicle.
UPDATE pricing_rules SET active = false WHERE vehicle_id IS NULL AND active;

-- Drivers: home address and the licence category (e.g. B, C1).
ALTER TABLE drivers ADD COLUMN IF NOT EXISTS address text;
ALTER TABLE drivers ADD COLUMN IF NOT EXISTS license_type text;
