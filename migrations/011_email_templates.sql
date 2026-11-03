-- Owner (company) emails share the outbox with customer emails. One notification can now queue one email per
-- recipient: the customer's and the owner's. Owner rows have no customer; their addresses come from settings.
ALTER TABLE email_outbox ALTER COLUMN customer_id DROP NOT NULL;
ALTER TABLE email_outbox ADD COLUMN recipient text NOT NULL DEFAULT 'customer' CHECK (recipient IN ('customer','owner'));
ALTER TABLE email_outbox DROP CONSTRAINT email_outbox_notification_id_key;
ALTER TABLE email_outbox ADD CONSTRAINT email_outbox_notification_recipient_key UNIQUE (notification_id, recipient);
