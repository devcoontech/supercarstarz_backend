-- Day bookings: a car can be booked for whole days (1 day = 24 hours from the start time) as well as by the hour.
-- A 'daily' pricing rule sets the price per day; without one, each day is charged as 24 hours at the hourly rate.
ALTER TABLE pricing_rules DROP CONSTRAINT pricing_rules_kind_check;
ALTER TABLE pricing_rules DROP CONSTRAINT pricing_rules_check;
ALTER TABLE pricing_rules ADD CONSTRAINT pricing_rules_kind_check CHECK (kind IN ('hourly', 'package', 'extra_hour', 'special_date', 'per_mile', 'daily'));
ALTER TABLE pricing_rules ADD CONSTRAINT pricing_rules_check CHECK (
     (kind = 'special_date' AND multiplier_bp IS NOT NULL AND starts_on IS NOT NULL AND ends_on IS NOT NULL)
  OR (kind = 'package' AND hours IS NOT NULL AND amount_pence IS NOT NULL)
  OR (kind IN ('hourly', 'extra_hour', 'per_mile', 'daily') AND amount_pence IS NOT NULL));
