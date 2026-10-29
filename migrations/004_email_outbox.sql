-- Transactional outbox for customer emails. A row is created in the same transaction as the in-app
-- notification (and shares its dedupe), so a retried webhook or double click never queues a second email.
CREATE TABLE email_outbox (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  notification_id uuid NOT NULL UNIQUE REFERENCES notifications(id) ON DELETE CASCADE,
  customer_id uuid NOT NULL REFERENCES customers(id),
  booking_id uuid REFERENCES bookings(id),
  kind text NOT NULL,
  payload jsonb NOT NULL DEFAULT '{}',
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','sending','sent','failed','skipped')),
  attempts int NOT NULL DEFAULT 0,
  next_attempt_at timestamptz NOT NULL DEFAULT now(),
  locked_at timestamptz,
  last_error text,
  sent_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX email_outbox_due ON email_outbox(next_attempt_at) WHERE status IN ('pending','sending');
CREATE INDEX email_outbox_booking ON email_outbox(booking_id);
