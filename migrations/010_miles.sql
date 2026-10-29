-- Distances in miles instead of kilometres. Rates are converted so every price stays the same
-- (e.g. £2.70/km becomes £4.35/mile); distances, free distances and delivery radii are converted to miles.
-- Issued receipts (invoices) are never changed; they keep exactly what was printed.

/* ---------- helpers used only by this migration ---------- */
CREATE FUNCTION pg_temp.mi(km numeric, places int) RETURNS numeric LANGUAGE sql IMMUTABLE AS
  $$ SELECT round(km / 1.609344, places) $$;
CREATE FUNCTION pg_temp.per_mile(pence_per_km numeric) RETURNS int LANGUAGE sql IMMUTABLE AS
  $$ SELECT round(pence_per_km * 1.609344)::int $$;
CREATE FUNCTION pg_temp.num(n numeric) RETURNS text LANGUAGE sql IMMUTABLE AS  -- 2.70 -> '2.7', 3.0 -> '3'
  $$ SELECT regexp_replace(regexp_replace(n::text, '(\.[0-9]*?)0+$', '\1'), '\.$', '') $$;

/** Rewrites "4.4 km", "£1.50/km" and "£2.50 per km" in stored wording to miles. */
CREATE FUNCTION pg_temp.text_to_miles(t text) RETURNS text LANGUAGE plpgsql IMMUTABLE AS $$
DECLARE m text[]; rate numeric; d numeric;
BEGIN
  IF t IS NULL THEN RETURN NULL; END IF;
  LOOP
    m := regexp_match(t, '£([0-9]+(?:\.[0-9]+)?)(/km| per km)');
    EXIT WHEN m IS NULL;
    rate := round(m[1]::numeric * 1.609344, 2);
    t := regexp_replace(t, '£([0-9]+(?:\.[0-9]+)?)(/km| per km)',
      '£' || CASE WHEN rate = trunc(rate) THEN trunc(rate)::text ELSE to_char(rate, 'FM999999990.00') END || CASE m[2] WHEN '/km' THEN '/mile' ELSE ' per mile' END);
  END LOOP;
  LOOP
    m := regexp_match(t, '([0-9]+(?:\.[0-9]+)?) km\M');
    EXIT WHEN m IS NULL;
    d := round(m[1]::numeric / 1.609344, 1);
    t := regexp_replace(t, '([0-9]+(?:\.[0-9]+)?) km\M', pg_temp.num(d) || CASE WHEN d = 1 THEN ' mile' ELSE ' miles' END);
  END LOOP;
  RETURN t;
END $$;

/** Walks a stored price snapshot: km keys become miles keys with converted values, and wording is rewritten. */
CREATE FUNCTION pg_temp.json_to_miles(j jsonb) RETURNS jsonb LANGUAGE plpgsql IMMUTABLE AS $$
DECLARE k text; v jsonb; out jsonb;
BEGIN
  IF j IS NULL THEN RETURN NULL; END IF;
  CASE jsonb_typeof(j)
    WHEN 'object' THEN
      out := '{}'::jsonb;
      FOR k, v IN SELECT * FROM jsonb_each(j) LOOP
        IF k IN ('deliveryKm', 'routeKm', 'distanceKm', 'km') AND jsonb_typeof(v) = 'number' THEN
          out := out || jsonb_build_object(CASE k WHEN 'deliveryKm' THEN 'deliveryMiles' WHEN 'routeKm' THEN 'routeMiles' WHEN 'distanceKm' THEN 'distanceMiles' ELSE 'miles' END,
                                           pg_temp.mi((v #>> '{}')::numeric, 1));
        ELSIF k IN ('deliveryKm', 'routeKm', 'distanceKm', 'km') THEN
          out := out || jsonb_build_object(CASE k WHEN 'deliveryKm' THEN 'deliveryMiles' WHEN 'routeKm' THEN 'routeMiles' WHEN 'distanceKm' THEN 'distanceMiles' ELSE 'miles' END, v);
        ELSIF k IN ('ratePerKmPence', 'delivery.ratePerKmPence') THEN
          out := out || jsonb_build_object(replace(k, 'Km', 'Mile'),
                                           CASE WHEN jsonb_typeof(v) = 'number' THEN to_jsonb(pg_temp.per_mile((v #>> '{}')::numeric)) ELSE v END);
        ELSE
          out := out || jsonb_build_object(k, pg_temp.json_to_miles(v));
        END IF;
      END LOOP;
      RETURN out;
    WHEN 'array' THEN
      RETURN COALESCE((SELECT jsonb_agg(pg_temp.json_to_miles(e) ORDER BY n) FROM jsonb_array_elements(j) WITH ORDINALITY AS a(e, n)), '[]'::jsonb);
    WHEN 'string' THEN
      RETURN to_jsonb(pg_temp.text_to_miles(j #>> '{}'));
    ELSE
      RETURN j;
  END CASE;
END $$;

/* ---------- vehicles ---------- */
ALTER TABLE vehicles DROP CONSTRAINT vehicles_delivery_pricing_check;
UPDATE vehicles SET delivery_pricing = 'per_mile' WHERE delivery_pricing = 'per_km';
ALTER TABLE vehicles ADD CONSTRAINT vehicles_delivery_pricing_check CHECK (delivery_pricing IN ('flat', 'per_mile'));

-- 001 had a whole-miles radius that 006 replaced with km but kept; it is out of date, so keep it out of the way.
ALTER TABLE vehicles RENAME COLUMN delivery_radius_miles TO delivery_radius_miles_before_006;
ALTER TABLE vehicles RENAME COLUMN delivery_per_km_pence TO delivery_per_mile_pence;
ALTER TABLE vehicles RENAME COLUMN delivery_free_km TO delivery_free_miles;
ALTER TABLE vehicles RENAME COLUMN delivery_radius_km TO delivery_radius_miles;
ALTER TABLE vehicles RENAME CONSTRAINT vehicles_delivery_per_km_pence_check TO vehicles_delivery_per_mile_pence_check;
ALTER TABLE vehicles RENAME CONSTRAINT vehicles_delivery_free_km_check TO vehicles_delivery_free_miles_check;
ALTER TABLE vehicles RENAME CONSTRAINT vehicles_delivery_radius_km_check TO vehicles_delivery_radius_miles_check;
UPDATE vehicles SET
  delivery_per_mile_pence = pg_temp.per_mile(delivery_per_mile_pence),
  delivery_free_miles = pg_temp.mi(delivery_free_miles, 1),
  delivery_radius_miles = pg_temp.mi(delivery_radius_miles, 1);

/* ---------- pricing rules: 'per_km' trips become 'per_mile' ---------- */
ALTER TABLE pricing_rules DROP CONSTRAINT pricing_rules_kind_check;
ALTER TABLE pricing_rules DROP CONSTRAINT pricing_rules_check;
UPDATE pricing_rules SET kind = 'per_mile', amount_pence = pg_temp.per_mile(amount_pence) WHERE kind = 'per_km';
UPDATE pricing_rules SET label = pg_temp.text_to_miles(label) WHERE label ~ 'km';
ALTER TABLE pricing_rules ADD CONSTRAINT pricing_rules_kind_check CHECK (kind IN ('hourly', 'package', 'extra_hour', 'special_date', 'per_mile'));
ALTER TABLE pricing_rules ADD CONSTRAINT pricing_rules_check CHECK (
     (kind = 'special_date' AND multiplier_bp IS NOT NULL AND starts_on IS NOT NULL AND ends_on IS NOT NULL)
  OR (kind = 'package' AND hours IS NOT NULL AND amount_pence IS NOT NULL)
  OR (kind IN ('hourly', 'extra_hour', 'per_mile') AND amount_pence IS NOT NULL));

/* ---------- bookings, orders and delivery charges ---------- */
ALTER TABLE bookings RENAME COLUMN delivery_km TO delivery_miles;
ALTER TABLE bookings RENAME COLUMN route_km TO route_miles;
UPDATE bookings SET delivery_miles = pg_temp.mi(delivery_miles, 1) WHERE delivery_miles IS NOT NULL;
UPDATE bookings SET route_miles = pg_temp.mi(route_miles, 1) WHERE route_miles IS NOT NULL;
UPDATE bookings SET pricing_snapshot = pg_temp.json_to_miles(pricing_snapshot) WHERE pricing_snapshot IS NOT NULL;
UPDATE orders SET pricing_snapshot = pg_temp.json_to_miles(pricing_snapshot) WHERE pricing_snapshot IS NOT NULL;

ALTER TABLE booking_charges RENAME COLUMN distance_km TO distance_miles;
ALTER TABLE booking_charges RENAME COLUMN rate_per_km_pence TO rate_per_mile_pence;
ALTER TABLE booking_charges RENAME CONSTRAINT booking_charges_distance_km_check TO booking_charges_distance_miles_check;
ALTER TABLE booking_charges RENAME CONSTRAINT booking_charges_rate_per_km_pence_check TO booking_charges_rate_per_mile_pence_check;
UPDATE booking_charges SET
  distance_miles = pg_temp.mi(distance_miles, 2),
  rate_per_mile_pence = pg_temp.per_mile(rate_per_mile_pence),
  description = pg_temp.text_to_miles(description)
WHERE distance_miles IS NOT NULL OR rate_per_mile_pence IS NOT NULL OR description ~ 'km';

/* ---------- settings: the business delivery rate ---------- */
UPDATE settings SET key = 'delivery.ratePerMilePence', value = to_jsonb(pg_temp.per_mile((value #>> '{}')::numeric))
 WHERE key = 'delivery.ratePerKmPence';
