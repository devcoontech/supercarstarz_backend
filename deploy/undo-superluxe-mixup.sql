-- Run on the LIVE Supercarstars database ONLY IF this returns rows:
--   SELECT name, applied_at FROM schema_migrations
--    WHERE name IN ('019_chauffeur_service.sql','020_payment_options.sql','021_booking_experience.sql','022_self_drive.sql');
-- (That means the mixed Superluxe build was deployed on 16 Nov 2026 and its migrations ran here.)
--
-- Puts back the Supercarstars values those Superluxe migrations changed. The extra columns/tables they added are
-- left in place: removing them could lose data, and the Supercarstars code simply ignores them.
-- Back up the database before running.

BEGIN;

-- 019 renamed the business
UPDATE settings SET value = '"Supercarstars"'::jsonb, updated_at = now()
 WHERE key = 'company.name' AND value = '"Superluxe Chauffeurs"'::jsonb;

-- 021 set the Superluxe excess-mile charge (£3). Supercarstars code ignores this key; removed only to keep things tidy.
-- Any other Superluxe-only settings (paypal.*, waiting.*, etc.) are likewise ignored and harmless.
DELETE FROM settings WHERE key = 'pricing.excessMilePence' AND value = '300'::jsonb;

-- 019 changed column defaults for a chauffeur-only service; restore the Supercarstars ones
ALTER TABLE vehicles ALTER COLUMN chauffeur_available SET DEFAULT false;
ALTER TABLE vehicles ALTER COLUMN self_drive_available SET DEFAULT true;
ALTER TABLE vehicles ALTER COLUMN max_hours SET DEFAULT 6;
ALTER TABLE bookings ALTER COLUMN driver_option SET DEFAULT 'self_drive';

-- The Supercarstars code knows these migrations by its own names; mark the self-drive one done
-- (its tables already exist from 022_self_drive.sql). 019_self_drive.sql is also safe to run again.
INSERT INTO schema_migrations(name) VALUES ('019_self_drive.sql') ON CONFLICT DO NOTHING;

COMMIT;
