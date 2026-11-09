-- Customers can delete their account from the app (Apple 5.1.1(v), Google Play account deletion policy).
-- The row is kept but anonymised, because bookings, receipts and payments must be kept for accounting.
ALTER TABLE customers ADD COLUMN deleted_at timestamptz;
