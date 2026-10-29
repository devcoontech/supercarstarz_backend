-- Parent orders (one or more vehicles), configurable tax, multi-vehicle offers and booking extensions.
-- Additive: every existing booking becomes a one-vehicle order with the same id and reference, so history,
-- payments, receipts and totals are unchanged.

/* ---------- Orders ----------
 * An order is what the customer pays for. Each booking row is one vehicle in an order (an "order item"), with its own
 * times, status and price. Money (payments, refunds, receipts, totals) is tracked per order. */
CREATE TABLE orders (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  ref text NOT NULL UNIQUE,
  customer_id uuid NOT NULL REFERENCES customers(id),
  source text NOT NULL DEFAULT 'customer_app' CHECK (source IN ('customer_app','admin')),
  created_by_staff uuid REFERENCES staff_users(id),
  currency text NOT NULL DEFAULT 'gbp',
  -- Price breakdown when quoted (and after any re-pricing): items, offers, taxable amount, tax, fee.
  pricing_snapshot jsonb NOT NULL DEFAULT '{}',
  subtotal_pence int NOT NULL DEFAULT 0 CHECK (subtotal_pence >= 0),
  discount_pence int NOT NULL DEFAULT 0 CHECK (discount_pence >= 0),
  taxable_pence int NOT NULL DEFAULT 0 CHECK (taxable_pence >= 0),
  tax_pence int NOT NULL DEFAULT 0 CHECK (tax_pence >= 0),
  fee_pence int NOT NULL DEFAULT 0 CHECK (fee_pence >= 0),
  -- Tax settings in force when the order was made; later changes to the settings never alter this order.
  tax_enabled boolean NOT NULL DEFAULT false,
  tax_rate_bp int NOT NULL DEFAULT 0 CHECK (tax_rate_bp BETWEEN 0 AND 10000),
  tax_policy text NOT NULL DEFAULT 'after_discount' CHECK (tax_policy IN ('after_discount','before_discount')),
  tax_label text NOT NULL DEFAULT 'VAT',
  quoted_total_pence int NOT NULL DEFAULT 0 CHECK (quoted_total_pence >= 0),
  total_pence int NOT NULL DEFAULT 0 CHECK (total_pence >= 0),
  deposit_due_pence int NOT NULL DEFAULT 0 CHECK (deposit_due_pence >= 0),
  paid_pence int NOT NULL DEFAULT 0,
  refunded_pence int NOT NULL DEFAULT 0,
  payment_status text NOT NULL DEFAULT 'unpaid' CHECK (payment_status IN
    ('unpaid','deposit_paid','partially_paid','paid','payment_failed','refund_pending','partially_refunded','refunded')),
  idempotency_key text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (customer_id, idempotency_key)
);
CREATE INDEX orders_customer ON orders(customer_id, created_at DESC);

-- Existing bookings: one order each, sharing the booking's id and reference.
INSERT INTO orders(id, ref, customer_id, source, created_by_staff, currency, pricing_snapshot, subtotal_pence, discount_pence, taxable_pence, tax_pence, fee_pence,
                   tax_enabled, tax_rate_bp, quoted_total_pence, total_pence, deposit_due_pence, paid_pence, refunded_pence, payment_status, created_at, updated_at)
SELECT b.id, b.ref, b.customer_id, b.source, b.created_by_staff, b.currency,
       jsonb_build_object('version', 3, 'migrated', true),
       GREATEST(0, COALESCE((b.pricing_snapshot->>'subtotalPence')::int, b.quoted_total_pence)),
       GREATEST(0, COALESCE((b.pricing_snapshot->>'discountPence')::int, 0)),
       GREATEST(0, COALESCE((b.pricing_snapshot->>'subtotalPence')::int, b.quoted_total_pence) - COALESCE((b.pricing_snapshot->>'discountPence')::int, 0)),
       GREATEST(0, COALESCE((b.pricing_snapshot->>'vatPence')::int, 0)),
       GREATEST(0, COALESCE((b.pricing_snapshot->>'serviceFeePence')::int, 0)),
       COALESCE((b.pricing_snapshot->'settings'->>'vatBp')::int, 0) > 0,
       LEAST(10000, GREATEST(0, COALESCE((b.pricing_snapshot->'settings'->>'vatBp')::int, 0))),
       b.quoted_total_pence, b.total_pence, b.deposit_due_pence, b.paid_pence, b.refunded_pence, b.payment_status, b.created_at, b.updated_at
  FROM bookings b;

ALTER TABLE bookings
  ADD COLUMN order_id uuid REFERENCES orders(id),
  -- This vehicle's share of the order price: its own charges, and its allocated part of the order discount, tax and fee.
  ADD COLUMN item_subtotal_pence int NOT NULL DEFAULT 0 CHECK (item_subtotal_pence >= 0),
  ADD COLUMN discount_pence int NOT NULL DEFAULT 0 CHECK (discount_pence >= 0),
  ADD COLUMN tax_pence int NOT NULL DEFAULT 0 CHECK (tax_pence >= 0);
UPDATE bookings b SET order_id = b.id,
  item_subtotal_pence = GREATEST(0, COALESCE((b.pricing_snapshot->>'subtotalPence')::int, b.quoted_total_pence)),
  discount_pence = GREATEST(0, COALESCE((b.pricing_snapshot->>'discountPence')::int, 0)),
  tax_pence = GREATEST(0, COALESCE((b.pricing_snapshot->>'vatPence')::int, 0));
ALTER TABLE bookings ALTER COLUMN order_id SET NOT NULL;
CREATE INDEX bookings_order ON bookings(order_id);

-- Safety net: a booking inserted without an order (older code, scripts) gets its own one-vehicle order.
CREATE FUNCTION bookings_default_order() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.order_id IS NULL THEN
    INSERT INTO orders(id, ref, customer_id, source, created_by_staff, currency, quoted_total_pence, total_pence, deposit_due_pence)
    VALUES (NEW.id, NEW.ref, NEW.customer_id, NEW.source, NEW.created_by_staff, NEW.currency, NEW.quoted_total_pence, NEW.total_pence, NEW.deposit_due_pence);
    NEW.order_id := NEW.id;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER bookings_default_order BEFORE INSERT ON bookings FOR EACH ROW EXECUTE FUNCTION bookings_default_order();

/* ---------- Money rows belong to an order ----------
 * booking_id stays (the vehicle a charge is for, or the order's first booking for order-wide payments). */
ALTER TABLE payments ADD COLUMN order_id uuid REFERENCES orders(id);
ALTER TABLE refunds ADD COLUMN order_id uuid REFERENCES orders(id);
ALTER TABLE booking_charges ADD COLUMN order_id uuid REFERENCES orders(id);
ALTER TABLE invoices ADD COLUMN order_id uuid REFERENCES orders(id);
ALTER TABLE offer_redemptions ADD COLUMN order_id uuid REFERENCES orders(id);
ALTER TABLE booking_events ADD COLUMN order_id uuid REFERENCES orders(id);

-- payments_guard refuses changes to payment rows; set order_id with it switched off for this one backfill.
ALTER TABLE payments DISABLE TRIGGER payments_guard;
UPDATE payments p SET order_id = b.order_id FROM bookings b WHERE b.id = p.booking_id;
ALTER TABLE payments ENABLE TRIGGER payments_guard;
UPDATE refunds r SET order_id = b.order_id FROM bookings b WHERE b.id = r.booking_id;
UPDATE booking_charges ch SET order_id = b.order_id FROM bookings b WHERE b.id = ch.booking_id;
ALTER TABLE invoices DISABLE TRIGGER invoices_immutable;
UPDATE invoices i SET order_id = b.order_id FROM bookings b WHERE b.id = i.booking_id;
ALTER TABLE invoices ENABLE TRIGGER invoices_immutable;
UPDATE offer_redemptions o SET order_id = b.order_id FROM bookings b WHERE b.id = o.booking_id;
UPDATE booking_events e SET order_id = b.order_id FROM bookings b WHERE b.id = e.booking_id;

CREATE FUNCTION set_order_from_booking() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.order_id IS NULL AND NEW.booking_id IS NOT NULL THEN
    SELECT order_id INTO NEW.order_id FROM bookings WHERE id = NEW.booking_id;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER payments_order BEFORE INSERT ON payments FOR EACH ROW EXECUTE FUNCTION set_order_from_booking();
CREATE TRIGGER refunds_order BEFORE INSERT ON refunds FOR EACH ROW EXECUTE FUNCTION set_order_from_booking();
CREATE TRIGGER booking_charges_order BEFORE INSERT ON booking_charges FOR EACH ROW EXECUTE FUNCTION set_order_from_booking();
CREATE TRIGGER invoices_order BEFORE INSERT ON invoices FOR EACH ROW EXECUTE FUNCTION set_order_from_booking();
CREATE TRIGGER offer_redemptions_order BEFORE INSERT ON offer_redemptions FOR EACH ROW EXECUTE FUNCTION set_order_from_booking();
CREATE TRIGGER booking_events_order BEFORE INSERT ON booking_events FOR EACH ROW EXECUTE FUNCTION set_order_from_booking();

ALTER TABLE payments ALTER COLUMN order_id SET NOT NULL;
ALTER TABLE refunds ALTER COLUMN order_id SET NOT NULL;
ALTER TABLE booking_charges ALTER COLUMN order_id SET NOT NULL;
ALTER TABLE invoices ALTER COLUMN order_id SET NOT NULL;
CREATE INDEX payments_order ON payments(order_id);
CREATE INDEX refunds_order ON refunds(order_id);
CREATE INDEX booking_charges_order ON booking_charges(order_id);
CREATE INDEX invoices_order ON invoices(order_id, issued_at);
CREATE INDEX booking_events_order ON booking_events(order_id, id);

-- The payment guard also protects the order a payment belongs to.
CREATE OR REPLACE FUNCTION payments_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'Payment records cannot be deleted'; END IF;
  IF NEW.booking_id IS DISTINCT FROM OLD.booking_id OR NEW.order_id IS DISTINCT FROM OLD.order_id OR NEW.customer_id <> OLD.customer_id
     OR NEW.amount_pence <> OLD.amount_pence OR NEW.currency <> OLD.currency OR NEW.source <> OLD.source THEN
    RAISE EXCEPTION 'Payment records cannot be rewritten; record a new payment or a refund instead';
  END IF;
  IF OLD.status = 'succeeded' AND NEW.status <> 'succeeded' THEN
    RAISE EXCEPTION 'A succeeded payment cannot change status; record a refund instead';
  END IF;
  RETURN NEW;
END $$;

-- An offer is redeemed once per order (an order can use several offers when they may be combined).
ALTER TABLE offer_redemptions DROP CONSTRAINT offer_redemptions_booking_id_key;
ALTER TABLE offer_redemptions ALTER COLUMN order_id SET NOT NULL;
ALTER TABLE offer_redemptions ADD CONSTRAINT offer_redemptions_order_offer UNIQUE (order_id, offer_id);

/* ---------- Offers ----------
 * Promo codes keep working as before. Offers without a code can apply automatically (auto_apply) when their
 * conditions are met: number of vehicles, eligible vehicles or categories, required combinations, minimum subtotal,
 * dates. When several qualify, the highest priority wins (then the biggest discount); offers stack only if all of
 * them allow it. Quantity tiers (2+ = 5%, 3+ = 10%, ...) are separate offers with different minimums. */
ALTER TABLE offers
  ADD COLUMN auto_apply boolean NOT NULL DEFAULT false,
  ADD COLUMN min_vehicles int NOT NULL DEFAULT 1 CHECK (min_vehicles >= 1),
  ADD COLUMN max_vehicles int CHECK (max_vehicles IS NULL OR max_vehicles >= 1),
  ADD COLUMN vehicle_categories text[],          -- NULL = any category
  ADD COLUMN required_vehicle_ids uuid[],        -- all of these must be in the order
  ADD COLUMN required_categories text[],         -- at least one vehicle of each of these categories
  ADD COLUMN max_discount_pence int CHECK (max_discount_pence IS NULL OR max_discount_pence > 0),
  ADD COLUMN applies_to text NOT NULL DEFAULT 'subtotal' CHECK (applies_to IN ('rental','subtotal')),
  ADD COLUMN priority int NOT NULL DEFAULT 0,
  ADD COLUMN stackable boolean NOT NULL DEFAULT false,
  ADD COLUMN updated_at timestamptz NOT NULL DEFAULT now(),
  ADD CONSTRAINT offers_vehicle_range CHECK (max_vehicles IS NULL OR max_vehicles >= min_vehicles),
  ADD CONSTRAINT offers_auto_or_code CHECK (NOT (auto_apply AND code IS NOT NULL));

-- The offers applied to an order, frozen at the time (offer edits never change an order).
CREATE TABLE order_offers (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id uuid NOT NULL REFERENCES orders(id),
  offer_id uuid REFERENCES offers(id) ON DELETE SET NULL,
  title text NOT NULL,
  code text,
  discount_type text NOT NULL CHECK (discount_type IN ('percent','fixed')),
  discount_value int NOT NULL,
  applies_to text NOT NULL,
  discount_pence int NOT NULL CHECK (discount_pence >= 0),
  snapshot jsonb NOT NULL,                 -- the offer's rules when applied
  superseded_at timestamptz,               -- set when the order is re-priced; history is kept
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX order_offers_order ON order_offers(order_id) WHERE superseded_at IS NULL;
INSERT INTO order_offers(order_id, offer_id, title, code, discount_type, discount_value, applies_to, discount_pence, snapshot, created_at)
SELECT b.order_id, o.id, o.title, o.code, o.discount_type, o.discount_value, 'subtotal', (b.pricing_snapshot->'offer'->>'discountPence')::int,
       to_jsonb(o) - 'created_at', b.created_at
  FROM bookings b JOIN offers o ON o.id = b.offer_id
 WHERE b.pricing_snapshot->'offer'->>'discountPence' IS NOT NULL;

/* ---------- Tax settings ----------
 * The old single VAT percentage becomes the tax settings (enabled, rate, policy, label). */
INSERT INTO settings(key, value)
SELECT 'tax.enabled', to_jsonb((value #>> '{}')::int > 0) FROM settings WHERE key = 'pricing.vatBp'
ON CONFLICT (key) DO NOTHING;
INSERT INTO settings(key, value)
SELECT 'tax.rateBp', to_jsonb((value #>> '{}')::int) FROM settings WHERE key = 'pricing.vatBp'
ON CONFLICT (key) DO NOTHING;

/* ---------- Booking extensions ----------
 * Every extension is recorded. 'confirmed' ones changed the booking; 'requested' ones wait for staff and change
 * nothing until approved (a pending extension is never treated as confirmed). */
CREATE TABLE booking_extensions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  booking_id uuid NOT NULL REFERENCES bookings(id),
  order_id uuid NOT NULL REFERENCES orders(id),
  status text NOT NULL CHECK (status IN ('confirmed','requested','rejected','withdrawn')),
  previous_end_at timestamptz NOT NULL,
  requested_end_at timestamptz NOT NULL,
  additional_hours int NOT NULL CHECK (additional_hours > 0),
  previous_order_total_pence int,
  new_order_total_pence int,
  price_difference_pence int,
  tax_difference_pence int,
  conflict_reason text,                    -- why it could not be confirmed automatically
  customer_message text,
  requested_by_type text NOT NULL CHECK (requested_by_type IN ('customer','staff')),
  requested_by uuid,
  decided_by uuid REFERENCES staff_users(id),
  decided_at timestamptz,
  decision_reason text,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (requested_end_at > previous_end_at)
);
CREATE INDEX booking_extensions_booking ON booking_extensions(booking_id, created_at);
CREATE INDEX booking_extensions_requested ON booking_extensions(created_at) WHERE status = 'requested';
-- At most one open request per booking.
CREATE UNIQUE INDEX one_open_extension_request ON booking_extensions(booking_id) WHERE status = 'requested';
