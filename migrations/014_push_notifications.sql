-- Push notifications to the customer app, sent through Expo's push service.

-- One row per phone. A phone can only belong to the customer who last signed in on it.
CREATE TABLE push_tokens (
  token text PRIMARY KEY,
  customer_id uuid NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  platform text NOT NULL CHECK (platform IN ('ios','android')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX push_tokens_customer ON push_tokens(customer_id, updated_at DESC);

-- Queued in the same transaction as the notification, and sent later, like email_outbox.
CREATE TABLE push_outbox (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  notification_id uuid NOT NULL UNIQUE REFERENCES notifications(id) ON DELETE CASCADE,
  customer_id uuid NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  booking_id uuid REFERENCES bookings(id),
  title text NOT NULL,
  body text,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','sending','sent','failed','skipped')),
  attempts int NOT NULL DEFAULT 0,
  next_attempt_at timestamptz NOT NULL DEFAULT now(),
  locked_at timestamptz,
  last_error text,
  sent_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX push_outbox_due ON push_outbox(next_attempt_at) WHERE status IN ('pending','sending');

-- Expo accepts a message first and reports whether Apple or Google took it later. These are the ones still to check.
CREATE TABLE push_tickets (
  id text PRIMARY KEY,
  outbox_id uuid NOT NULL REFERENCES push_outbox(id) ON DELETE CASCADE,
  token text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX push_tickets_created ON push_tickets(created_at);
