-- Distance-based delivery, hourly or fixed chauffeur charges, per-km pricing and distance-priced events.

ALTER TABLE vehicles
  ADD COLUMN base_address text,                       -- where the car is kept; delivery distance is measured from here
  ADD COLUMN base_lat double precision,
  ADD COLUMN base_lng double precision,
  ADD COLUMN delivery_pricing text NOT NULL DEFAULT 'flat' CHECK (delivery_pricing IN ('flat','per_km')),
  ADD COLUMN delivery_per_km_pence int NOT NULL DEFAULT 0 CHECK (delivery_per_km_pence >= 0),
  ADD COLUMN delivery_free_km numeric NOT NULL DEFAULT 0 CHECK (delivery_free_km >= 0),
  ADD COLUMN delivery_min_pence int NOT NULL DEFAULT 0 CHECK (delivery_min_pence >= 0),
  ADD COLUMN delivery_round_trip boolean NOT NULL DEFAULT false,   -- true: charge the distance both ways
  ADD COLUMN chauffeur_charge_type text NOT NULL DEFAULT 'fixed' CHECK (chauffeur_charge_type IN ('fixed','hourly'));

ALTER TABLE event_types
  ADD COLUMN pricing_basis text NOT NULL DEFAULT 'hourly' CHECK (pricing_basis IN ('hourly','distance'));

ALTER TABLE pricing_rules DROP CONSTRAINT pricing_rules_kind_check;
ALTER TABLE pricing_rules DROP CONSTRAINT pricing_rules_check;
ALTER TABLE pricing_rules ADD COLUMN min_amount_pence int CHECK (min_amount_pence >= 0);
ALTER TABLE pricing_rules ADD CONSTRAINT pricing_rules_kind_check CHECK (kind IN ('hourly','package','extra_hour','special_date','per_km'));
ALTER TABLE pricing_rules ADD CONSTRAINT pricing_rules_check CHECK (
     (kind = 'special_date' AND multiplier_bp IS NOT NULL AND starts_on IS NOT NULL AND ends_on IS NOT NULL)
  OR (kind = 'package' AND hours IS NOT NULL AND amount_pence IS NOT NULL)
  OR (kind IN ('hourly','extra_hour','per_km') AND amount_pence IS NOT NULL));

ALTER TABLE bookings
  ADD COLUMN address_lat double precision,
  ADD COLUMN address_lng double precision,
  ADD COLUMN pickup_address text,
  ADD COLUMN pickup_lat double precision,
  ADD COLUMN pickup_lng double precision,
  ADD COLUMN dropoff_address text,
  ADD COLUMN dropoff_lat double precision,
  ADD COLUMN dropoff_lng double precision,
  ADD COLUMN delivery_km numeric,   -- one-way distance from the car's base to the delivery address
  ADD COLUMN route_km numeric;      -- pick-up to drop-off distance for distance-priced events
