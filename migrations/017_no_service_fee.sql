-- No service fee is charged on bookings any more. Bookings already made keep the price they were quoted.
INSERT INTO settings(key, value) VALUES ('pricing.serviceFeeBp', '0'::jsonb)
ON CONFLICT (key) DO UPDATE SET value = '0'::jsonb, updated_at = now();
