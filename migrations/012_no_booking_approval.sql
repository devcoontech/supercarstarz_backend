-- Customer bookings no longer wait for staff approval: they go straight to payment and are confirmed once paid.
-- Turns the switch off where it was saved as on; staff can still turn it back on in Settings > Business.
UPDATE settings SET value = 'false'::jsonb, updated_at = now() WHERE key = 'booking.requireApproval' AND value = 'true'::jsonb;
