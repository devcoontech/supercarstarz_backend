-- Emailed one-time codes for customer password reset. Only a keyed hash of the code is stored.
CREATE TABLE password_resets (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_id uuid NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  code_hash text NOT NULL,
  attempts int NOT NULL DEFAULT 0,
  expires_at timestamptz NOT NULL,
  used_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX password_resets_customer ON password_resets(customer_id, created_at DESC);

-- Tokens issued before this moment are no longer accepted (set when the password is reset).
ALTER TABLE customers ADD COLUMN password_changed_at timestamptz;
