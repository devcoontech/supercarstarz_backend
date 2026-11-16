-- Self-drive bookings: the driver's details and driving licence, given by the customer when they book a car without a driver.
-- IF NOT EXISTS: a database that already ran this as 022_self_drive.sql (the mixed-up build) keeps its tables and data.

-- Licence photos the customer uploads from the app. Private files (never served publicly), like staff-held driver licences.
-- A photo can be reused on later bookings, so it belongs to the customer rather than to one booking.
CREATE TABLE IF NOT EXISTS customer_licence_uploads (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_id uuid NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  side text NOT NULL CHECK (side IN ('front','back')),
  storage_key text NOT NULL,
  mime text NOT NULL,
  size_bytes int NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS customer_licence_uploads_customer ON customer_licence_uploads(customer_id, side, created_at DESC);

-- One application per order: the person who will drive every self-drive car in it. Staff review it before handover.
CREATE TABLE IF NOT EXISTS self_drive_applications (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id uuid NOT NULL UNIQUE REFERENCES orders(id) ON DELETE CASCADE,
  customer_id uuid NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  full_name text NOT NULL,
  date_of_birth date NOT NULL,
  email text NOT NULL,
  phone text NOT NULL,
  address_line1 text NOT NULL,
  address_line2 text,
  city text NOT NULL,
  postcode text NOT NULL,
  country text NOT NULL DEFAULT 'United Kingdom',
  licence_number text NOT NULL,
  licence_country text NOT NULL DEFAULT 'United Kingdom',
  licence_issued_on date NOT NULL,
  licence_expires_on date NOT NULL,
  licence_check_code text,          -- DVLA "view driving licence" check code, optional
  penalty_points int NOT NULL DEFAULT 0 CHECK (penalty_points BETWEEN 0 AND 20),
  convictions text,                 -- anything the customer declares (endorsements, bans, accidents)
  licence_front_id uuid REFERENCES customer_licence_uploads(id) ON DELETE SET NULL,
  licence_back_id uuid REFERENCES customer_licence_uploads(id) ON DELETE SET NULL,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','rejected')),
  review_note text,
  reviewed_by uuid REFERENCES staff_users(id),
  reviewed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS self_drive_applications_customer ON self_drive_applications(customer_id, created_at DESC);
CREATE INDEX IF NOT EXISTS self_drive_applications_status ON self_drive_applications(status) WHERE status = 'pending';
