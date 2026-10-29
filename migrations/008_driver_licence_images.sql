-- Photos of a driver's licence (front and back). The files are kept in a private folder that is never served
-- publicly; staff allowed to see licence details fetch them through an authenticated endpoint.
CREATE TABLE driver_licence_images (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  driver_id uuid NOT NULL REFERENCES drivers(id) ON DELETE CASCADE,
  side text NOT NULL CHECK (side IN ('front','back')),
  storage_key text NOT NULL,
  mime text NOT NULL,
  size_bytes int NOT NULL,
  uploaded_by uuid REFERENCES staff_users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (driver_id, side)
);
