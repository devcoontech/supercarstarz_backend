-- Delivery radius in kilometres, to match per-kilometre pricing. The old miles column is kept (unused) so nothing is lost.
ALTER TABLE vehicles ADD COLUMN delivery_radius_km numeric NOT NULL DEFAULT 0 CHECK (delivery_radius_km >= 0);
UPDATE vehicles SET delivery_radius_km = round((delivery_radius_miles * 1.609344)::numeric, 1);
