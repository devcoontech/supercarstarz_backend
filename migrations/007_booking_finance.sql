-- Driver choice, showroom collection or delivery, admin-confirmed delivery charges, add-on management,
-- a booking adjustments ledger, richer payment records and issued receipts.
-- Additive only: existing bookings, payments and prices are kept as they are.

/* ---------- Driving arrangement ---------- */

-- Which arrangements a car supports. chauffeur_available already says whether it can come with a driver.
ALTER TABLE vehicles ADD COLUMN self_drive_available boolean NOT NULL DEFAULT true;

ALTER TABLE bookings
  ADD COLUMN driver_option text NOT NULL DEFAULT 'self_drive' CHECK (driver_option IN ('with_driver','self_drive')),
  ADD COLUMN currency text NOT NULL DEFAULT 'gbp',
  ADD COLUMN source text NOT NULL DEFAULT 'customer_app' CHECK (source IN ('customer_app','admin')),
  -- The quoted price at booking time (rental, driver, add-ons, fees, discount). total_pence = this + confirmed charges.
  ADD COLUMN quoted_total_pence int NOT NULL DEFAULT 0 CHECK (quoted_total_pence >= 0);
UPDATE bookings SET driver_option = CASE WHEN chauffeur THEN 'with_driver' ELSE 'self_drive' END,
                    source = CASE WHEN created_by_staff IS NULL THEN 'customer_app' ELSE 'admin' END,
                    quoted_total_pence = total_pence;
-- chauffeur is kept for existing reports and screens; it always matches driver_option.
ALTER TABLE bookings ADD CONSTRAINT bookings_driver_option_matches CHECK (chauffeur = (driver_option = 'with_driver'));

/* ---------- Payment status ---------- */

ALTER TABLE bookings DROP CONSTRAINT bookings_payment_status_check;
ALTER TABLE bookings ADD CONSTRAINT bookings_payment_status_check CHECK (payment_status IN
  ('unpaid','deposit_paid','partially_paid','paid','payment_failed','refund_pending','partially_refunded','refunded'));

/* ---------- One-hour preparation buffer ----------
 * Each holding booking now blocks [start, end + buffer), so two bookings on one car are always at least the buffer apart
 * (the API also checks the gap before a new booking). Upcoming bookings are moved to the new range where they fit;
 * any that are already closer than the buffer to a neighbour keep their old range and are reported here. */
DO $$
DECLARE
  r record;
  setting_buffer int := COALESCE((SELECT (value #>> '{}')::int FROM settings WHERE key = 'booking.bufferMinutes'), 60);
BEGIN
  FOR r IN
    SELECT b.id, b.ref, b.start_at, b.end_at, GREATEST(setting_buffer, v.buffer_minutes) AS buf
      FROM bookings b JOIN vehicles v ON v.id = b.vehicle_id
     WHERE b.end_at > now() AND b.status IN ('pending','awaiting_payment','confirmed','driver_assigned','in_progress','cancellation_requested')
     ORDER BY b.start_at
  LOOP
    BEGIN
      UPDATE bookings SET blocked_during = tstzrange(r.start_at, r.end_at + make_interval(mins => r.buf), '[)') WHERE id = r.id;
    EXCEPTION WHEN exclusion_violation THEN
      RAISE NOTICE 'Booking % kept its previous buffer: it is closer than % minutes to another booking on the same car', r.ref, r.buf;
    END;
  END LOOP;
END $$;

/* ---------- Add-ons ---------- */

ALTER TABLE addons
  ADD COLUMN image_url text,
  ADD COLUMN pricing_type text NOT NULL DEFAULT 'fixed' CHECK (pricing_type IN ('fixed','per_hour','per_unit')),
  ADD COLUMN max_quantity int NOT NULL DEFAULT 1 CHECK (max_quantity BETWEEN 1 AND 100),
  ADD COLUMN all_vehicles boolean NOT NULL DEFAULT false,
  ADD COLUMN created_at timestamptz NOT NULL DEFAULT now(),
  ADD COLUMN updated_at timestamptz NOT NULL DEFAULT now();
-- Extras created before this were offered on every car; keep that.
UPDATE addons SET all_vehicles = true;

CREATE TABLE vehicle_addons (
  vehicle_id uuid NOT NULL REFERENCES vehicles(id) ON DELETE CASCADE,
  addon_id uuid NOT NULL REFERENCES addons(id) ON DELETE CASCADE,
  PRIMARY KEY (vehicle_id, addon_id)
);
CREATE INDEX vehicle_addons_addon ON vehicle_addons(addon_id);

-- The add-ons on a booking at the price agreed when it was made. Later price changes never touch these rows.
CREATE TABLE booking_addons (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  booking_id uuid NOT NULL REFERENCES bookings(id),
  addon_id uuid REFERENCES addons(id) ON DELETE SET NULL,
  name text NOT NULL,
  pricing_type text NOT NULL CHECK (pricing_type IN ('fixed','per_hour','per_unit')),
  unit_price_pence int NOT NULL CHECK (unit_price_pence >= 0),
  quantity int NOT NULL CHECK (quantity > 0),
  hours int,
  total_pence int NOT NULL CHECK (total_pence >= 0),
  currency text NOT NULL DEFAULT 'gbp',
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX booking_addons_booking ON booking_addons(booking_id);
INSERT INTO booking_addons(booking_id, addon_id, name, pricing_type, unit_price_pence, quantity, total_pence, created_at)
SELECT b.id, a.id, l->>'label', 'fixed', (l->>'amountPence')::int, 1, (l->>'amountPence')::int, b.created_at
  FROM bookings b
  CROSS JOIN LATERAL jsonb_array_elements(COALESCE(b.pricing_snapshot->'lines', '[]'::jsonb)) l
  LEFT JOIN addons a ON a.id::text = substring(l->>'key' FROM 7)
 WHERE l->>'key' LIKE 'addon:%';

/* ---------- Charges added after booking (delivery, adjustments) ----------
 * Rows are never deleted. A change voids the old row and adds a new one that points at it, so the history stays readable. */
CREATE TABLE booking_charges (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  booking_id uuid NOT NULL REFERENCES bookings(id),
  kind text NOT NULL CHECK (kind IN ('delivery','adjustment')),
  status text NOT NULL CHECK (status IN ('pending','confirmed','void')),
  amount_pence int NOT NULL,                 -- signed: a credit adjustment is negative
  currency text NOT NULL DEFAULT 'gbp',
  description text NOT NULL,
  address text,                              -- delivery: where the car goes
  distance_km numeric(8,2) CHECK (distance_km >= 0),
  rate_per_km_pence int CHECK (rate_per_km_pence >= 0),
  calculated_pence int CHECK (calculated_pence >= 0),
  supersedes_id uuid REFERENCES booking_charges(id),
  created_by uuid REFERENCES staff_users(id), -- for a confirmed charge, the staff member who approved it
  created_at timestamptz NOT NULL DEFAULT now(),
  voided_at timestamptz,
  voided_by uuid REFERENCES staff_users(id),
  void_reason text,
  CHECK (kind <> 'delivery' OR amount_pence >= 0),
  CHECK ((status = 'void') = (voided_at IS NOT NULL))
);
CREATE INDEX booking_charges_booking ON booking_charges(booking_id, created_at);
-- A booking can never carry two live delivery charges, so a charge cannot be added twice.
CREATE UNIQUE INDEX one_live_delivery_charge ON booking_charges(booking_id) WHERE kind = 'delivery' AND status <> 'void';

/* ---------- Payments ---------- */

ALTER TABLE payments
  ADD COLUMN paid_at timestamptz,            -- when the money was received (staff enter it for manual payments)
  ADD COLUMN note text,                      -- staff only
  ADD COLUMN idempotency_key text,
  ADD COLUMN status_changed_by uuid REFERENCES staff_users(id);
UPDATE payments SET paid_at = updated_at WHERE status = 'succeeded';
CREATE UNIQUE INDEX payments_idempotency ON payments(booking_id, idempotency_key) WHERE idempotency_key IS NOT NULL;

-- A payment record is never rewritten to represent a different payment, and money received is never un-received
-- (that is what refunds are for). Status may only move forward from pending.
CREATE FUNCTION payments_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'Payment records cannot be deleted'; END IF;
  IF NEW.booking_id <> OLD.booking_id OR NEW.customer_id <> OLD.customer_id OR NEW.amount_pence <> OLD.amount_pence
     OR NEW.currency <> OLD.currency OR NEW.source <> OLD.source THEN
    RAISE EXCEPTION 'Payment records cannot be rewritten; record a new payment or a refund instead';
  END IF;
  IF OLD.status = 'succeeded' AND NEW.status <> 'succeeded' THEN
    RAISE EXCEPTION 'A succeeded payment cannot change status; record a refund instead';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER payments_guard BEFORE UPDATE OR DELETE ON payments FOR EACH ROW EXECUTE FUNCTION payments_guard();

/* ---------- Issued receipts and notes ---------- */

CREATE SEQUENCE invoice_number_seq START 1001;
CREATE TABLE invoices (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  number text NOT NULL UNIQUE,
  booking_id uuid NOT NULL REFERENCES bookings(id),
  customer_id uuid NOT NULL REFERENCES customers(id),
  kind text NOT NULL CHECK (kind IN ('deposit_receipt','payment_receipt','full_payment_receipt','refund_receipt','adjustment_note','credit_note')),
  payment_id uuid REFERENCES payments(id),
  refund_id uuid REFERENCES refunds(id),
  charge_id uuid REFERENCES booking_charges(id),
  currency text NOT NULL DEFAULT 'gbp',
  amount_pence int NOT NULL,                 -- this transaction only (negative for a credit)
  booking_total_pence int NOT NULL,          -- the booking total when it was issued
  paid_to_date_pence int NOT NULL,           -- net of refunds, including this transaction
  balance_pence int NOT NULL,                -- still to pay after this transaction (0 if none)
  data jsonb NOT NULL,                       -- frozen copy of everything printed on the document
  issued_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX invoices_payment ON invoices(payment_id) WHERE payment_id IS NOT NULL;
CREATE UNIQUE INDEX invoices_refund ON invoices(refund_id) WHERE refund_id IS NOT NULL;
CREATE UNIQUE INDEX invoices_charge_action ON invoices(charge_id, (data->>'action')) WHERE charge_id IS NOT NULL;
CREATE INDEX invoices_booking ON invoices(booking_id, issued_at);
CREATE INDEX invoices_customer ON invoices(customer_id, issued_at DESC);

-- Issued documents are append-only: a later change issues a new document instead.
CREATE FUNCTION invoices_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'Issued receipts and invoices cannot be changed or deleted';
END $$;
CREATE TRIGGER invoices_immutable BEFORE UPDATE OR DELETE ON invoices FOR EACH ROW EXECUTE FUNCTION invoices_immutable();
