-- Supercarstars: company-managed fleet. All money is integer pence (GBP).
CREATE EXTENSION IF NOT EXISTS btree_gist;
CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE staff_users (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email text NOT NULL UNIQUE,
  name text NOT NULL,
  password_hash text NOT NULL,
  role text NOT NULL DEFAULT 'owner' CHECK (role IN ('owner','administrator','booking_manager','fleet_manager','driver_coordinator','finance_manager')),
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE customers (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email text NOT NULL UNIQUE,
  name text NOT NULL,
  phone text,
  postcode text,
  city text,
  password_hash text NOT NULL,
  internal_notes text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE vehicles (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  fleet_ref text UNIQUE,
  make text NOT NULL,
  model text NOT NULL,
  year int NOT NULL,
  category text NOT NULL CHECK (category IN ('Supercar','Convertible','SUV','Luxury')),
  colour text,
  transmission text,
  seats int NOT NULL CHECK (seats > 0),
  power text,
  top_speed text,
  city text NOT NULL,
  area text,
  description text NOT NULL DEFAULT '',
  amenities text[] NOT NULL DEFAULT '{}',
  specs jsonb NOT NULL DEFAULT '{}',
  price_per_hour_pence int NOT NULL CHECK (price_per_hour_pence >= 0),
  delivery_available boolean NOT NULL DEFAULT false,
  delivery_fee_pence int NOT NULL DEFAULT 0,
  delivery_radius_miles int NOT NULL DEFAULT 0,
  stationary_available boolean NOT NULL DEFAULT true,
  min_hours int NOT NULL DEFAULT 1 CHECK (min_hours >= 1),
  max_hours int NOT NULL DEFAULT 6 CHECK (max_hours >= min_hours),
  buffer_minutes int NOT NULL DEFAULT 0 CHECK (buffer_minutes >= 0),
  chauffeur_available boolean NOT NULL DEFAULT false,
  chauffeur_fee_pence int NOT NULL DEFAULT 0,
  deposit_pence int NOT NULL DEFAULT 0,
  operational_status text NOT NULL DEFAULT 'active' CHECK (operational_status IN ('active','inactive','maintenance')),
  published boolean NOT NULL DEFAULT false,
  deleted_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE vehicle_images (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  vehicle_id uuid NOT NULL REFERENCES vehicles(id) ON DELETE CASCADE,
  url text NOT NULL,
  storage_key text,
  sort_order int NOT NULL DEFAULT 0,
  is_cover boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX one_cover_per_vehicle ON vehicle_images(vehicle_id) WHERE is_cover;

CREATE TABLE event_types (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  slug text NOT NULL UNIQUE,
  title text NOT NULL,
  description text NOT NULL DEFAULT '',
  image_url text,
  requirements jsonb NOT NULL DEFAULT '{}',
  min_hours int,
  published boolean NOT NULL DEFAULT false,
  sort_order int NOT NULL DEFAULT 0,
  archived_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE vehicle_event_types (
  vehicle_id uuid NOT NULL REFERENCES vehicles(id) ON DELETE CASCADE,
  event_type_id uuid NOT NULL REFERENCES event_types(id),
  PRIMARY KEY (vehicle_id, event_type_id)
);

-- Precedence (highest first) is implemented in src/pricing.ts and documented in docs/ARCHITECTURE.md.
CREATE TABLE pricing_rules (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  vehicle_id uuid REFERENCES vehicles(id) ON DELETE CASCADE,
  event_type_id uuid REFERENCES event_types(id),
  kind text NOT NULL CHECK (kind IN ('hourly','package','extra_hour','special_date')),
  label text,
  hours int CHECK (hours > 0),               -- package length (half-day, full-day, custom)
  amount_pence int CHECK (amount_pence >= 0), -- hourly rate, package price, or extra-hour rate
  multiplier_bp int CHECK (multiplier_bp > 0), -- special_date: basis points applied to the base (12000 = +20%)
  starts_on date,
  ends_on date,
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK ((kind = 'special_date' AND multiplier_bp IS NOT NULL AND starts_on IS NOT NULL AND ends_on IS NOT NULL)
      OR (kind = 'package' AND hours IS NOT NULL AND amount_pence IS NOT NULL)
      OR (kind IN ('hourly','extra_hour') AND amount_pence IS NOT NULL))
);

CREATE TABLE addons (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL,
  detail text,
  price_pence int NOT NULL CHECK (price_pence >= 0),
  active boolean NOT NULL DEFAULT true,
  sort_order int NOT NULL DEFAULT 0
);

CREATE TABLE availability_blocks (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  vehicle_id uuid NOT NULL REFERENCES vehicles(id) ON DELETE CASCADE,
  during tstzrange NOT NULL,
  kind text NOT NULL DEFAULT 'blocked' CHECK (kind IN ('blocked','maintenance')),
  reason text,
  created_by uuid REFERENCES staff_users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (NOT isempty(during))
);
CREATE INDEX availability_blocks_gist ON availability_blocks USING gist (vehicle_id, during);

CREATE TABLE drivers (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  internal_ref text UNIQUE,
  full_name text NOT NULL,
  phone text NOT NULL,
  email text,
  license_number text,        -- sensitive: only returned to owner role
  license_expiry date,
  employment text NOT NULL DEFAULT 'employee' CHECK (employment IN ('employee','contractor')),
  working_hours jsonb,        -- optional {"start":"08:00","end":"20:00"}
  notes text,
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE SEQUENCE booking_ref_seq START 50001;

CREATE TABLE offers (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code text UNIQUE,
  title text NOT NULL,
  description text,
  image_url text,
  discount_type text NOT NULL CHECK (discount_type IN ('percent','fixed')),
  discount_value int NOT NULL CHECK (discount_value > 0), -- percent (1-100) or pence
  starts_at timestamptz,
  ends_at timestamptz,
  usage_limit int,
  per_customer_limit int,
  min_booking_pence int NOT NULL DEFAULT 0,
  vehicle_ids uuid[],      -- NULL = all vehicles
  event_type_ids uuid[],   -- NULL = all events
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (discount_type <> 'percent' OR discount_value <= 100)
);

CREATE TABLE bookings (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  ref text NOT NULL UNIQUE DEFAULT ('SCS-' || nextval('booking_ref_seq')),
  customer_id uuid NOT NULL REFERENCES customers(id),
  vehicle_id uuid NOT NULL REFERENCES vehicles(id),
  event_type_id uuid REFERENCES event_types(id),
  status text NOT NULL CHECK (status IN ('pending','awaiting_payment','confirmed','driver_assigned','in_progress','completed','cancellation_requested','cancelled','rejected','payment_failed')),
  payment_status text NOT NULL DEFAULT 'unpaid' CHECK (payment_status IN ('unpaid','partially_paid','paid','partially_refunded','refunded')),
  start_at timestamptz NOT NULL,
  end_at timestamptz NOT NULL,
  hours int NOT NULL CHECK (hours > 0),
  -- start/end widened by the vehicle's turnaround buffer; this is what availability checks use
  blocked_during tstzrange NOT NULL,
  experience text NOT NULL CHECK (experience IN ('stationary','delivered')),
  address text,
  children int,
  occasion text,
  chauffeur boolean NOT NULL DEFAULT false,
  addon_ids uuid[] NOT NULL DEFAULT '{}',
  offer_id uuid REFERENCES offers(id),
  customer_notes text,
  admin_notes text,
  driver_id uuid REFERENCES drivers(id),
  dispatch_status text NOT NULL DEFAULT 'not_dispatched' CHECK (dispatch_status IN ('not_dispatched','dispatched','en_route','arrived','service_started','service_complete')),
  pricing_snapshot jsonb NOT NULL,
  total_pence int NOT NULL CHECK (total_pence >= 0),
  deposit_due_pence int NOT NULL DEFAULT 0,
  paid_pence int NOT NULL DEFAULT 0,
  refunded_pence int NOT NULL DEFAULT 0,
  hold_expires_at timestamptz,
  idempotency_key text,
  started_at timestamptz,
  completed_at timestamptz,
  cancelled_at timestamptz,
  cancel_reason text,
  created_by_staff uuid REFERENCES staff_users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (end_at > start_at),
  UNIQUE (customer_id, idempotency_key),
  -- The database itself refuses overlapping holds on one vehicle.
  CONSTRAINT no_vehicle_overlap EXCLUDE USING gist (vehicle_id WITH =, blocked_during WITH &&)
    WHERE (status IN ('pending','awaiting_payment','confirmed','driver_assigned','in_progress','completed','cancellation_requested'))
);
CREATE INDEX bookings_customer ON bookings(customer_id);
CREATE INDEX bookings_vehicle_start ON bookings(vehicle_id, start_at);
CREATE INDEX bookings_status ON bookings(status);

CREATE TABLE offer_redemptions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  offer_id uuid NOT NULL REFERENCES offers(id),
  booking_id uuid NOT NULL REFERENCES bookings(id),
  customer_id uuid NOT NULL REFERENCES customers(id),
  discount_pence int NOT NULL,
  released_at timestamptz,   -- set when the booking is cancelled/rejected so the use is returned
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (booking_id)
);

-- Driver assignment history. At most one *active* assignment per driver per time range.
CREATE TABLE driver_assignments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  booking_id uuid NOT NULL REFERENCES bookings(id),
  driver_id uuid NOT NULL REFERENCES drivers(id),
  during tstzrange NOT NULL,
  active boolean NOT NULL DEFAULT true,
  assigned_by uuid REFERENCES staff_users(id),
  ended_reason text,
  created_at timestamptz NOT NULL DEFAULT now(),
  ended_at timestamptz,
  CONSTRAINT no_driver_overlap EXCLUDE USING gist (driver_id WITH =, during WITH &&) WHERE (active)
);

CREATE TABLE payments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  booking_id uuid NOT NULL REFERENCES bookings(id),
  customer_id uuid NOT NULL REFERENCES customers(id),
  amount_pence int NOT NULL CHECK (amount_pence > 0),
  currency text NOT NULL DEFAULT 'gbp',
  method text NOT NULL,                       -- card, apple_pay, cash, bank_transfer, ...
  source text NOT NULL CHECK (source IN ('stripe','manual')),
  purpose text NOT NULL DEFAULT 'payment' CHECK (purpose IN ('payment','deposit','balance')),
  status text NOT NULL CHECK (status IN ('pending','succeeded','failed','canceled')),
  provider_ref text UNIQUE,                   -- Stripe PaymentIntent id
  manual_reference text,
  recorded_by uuid REFERENCES staff_users(id), -- set for manual payments
  reconciled_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (source <> 'manual' OR recorded_by IS NOT NULL),
  CHECK (source <> 'stripe' OR provider_ref IS NOT NULL)
);
CREATE INDEX payments_booking ON payments(booking_id);

CREATE TABLE refunds (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  payment_id uuid NOT NULL REFERENCES payments(id),
  booking_id uuid NOT NULL REFERENCES bookings(id),
  amount_pence int NOT NULL CHECK (amount_pence > 0),
  reason text,
  status text NOT NULL CHECK (status IN ('pending','succeeded','failed')),
  provider_ref text UNIQUE,
  recorded_by uuid REFERENCES staff_users(id),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE booking_events (
  id bigserial PRIMARY KEY,
  booking_id uuid NOT NULL REFERENCES bookings(id),
  actor_type text NOT NULL CHECK (actor_type IN ('staff','customer','system','stripe')),
  actor_id uuid,
  action text NOT NULL,
  from_value text,
  to_value text,
  reason text,
  meta jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX booking_events_booking ON booking_events(booking_id, id);

CREATE TABLE audit_log (
  id bigserial PRIMARY KEY,
  staff_id uuid REFERENCES staff_users(id),
  entity text NOT NULL,
  entity_id text,
  action text NOT NULL,
  before jsonb,
  after jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE settings (
  key text PRIMARY KEY,
  value jsonb NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- Idempotency for webhooks and notifications: a retried Stripe event is a no-op.
CREATE TABLE webhook_events (
  provider text NOT NULL,
  event_id text NOT NULL,
  type text NOT NULL,
  received_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (provider, event_id)
);

CREATE TABLE notifications (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_id uuid REFERENCES customers(id),
  staff_only boolean NOT NULL DEFAULT false,
  booking_id uuid REFERENCES bookings(id),
  kind text NOT NULL,
  title text NOT NULL,
  body text,
  dedupe_key text UNIQUE,
  read_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX notifications_customer ON notifications(customer_id, created_at DESC);
