-- Free cancellation (full refund) window is now 24 hours before the booking, not 48.
-- Only replaces the old 48-hour value; any other value set in Settings is left as it is.
UPDATE settings SET value = '24'::jsonb, updated_at = now()
 WHERE key = 'booking.cancellationFreeHours' AND value = '48'::jsonb;
