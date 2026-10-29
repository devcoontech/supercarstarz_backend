-- Consents the customer ticked at checkout (guardian present, terms, optional photo marketing).
ALTER TABLE bookings ADD COLUMN consents jsonb;
