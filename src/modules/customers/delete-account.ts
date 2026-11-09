import crypto from 'node:crypto';
import type pg from 'pg';
import { conflict, notFound, unauthorized } from '../../core/errors.js';
import { hashPassword, verifyPassword } from '../../core/security.js';

type C = pg.PoolClient;

/** Bookings that still need the customer: not finished, cancelled, rejected or failed, and not over yet. */
const LIVE = `('pending','awaiting_payment','confirmed','driver_assigned','in_progress','cancellation_requested')`;

/**
 * Deletes a customer account at the customer's request (Apple 5.1.1(v), Google Play account deletion).
 *
 * The customer row is anonymised rather than removed: bookings, receipts and payments have to be kept for accounting,
 * so they stay linked to an anonymous record. Personal details on the account are erased, the account can never
 * sign in again (new email, random password, every session ended), and phones stop getting notifications.
 * Refused while the customer has a booking that is still to come or under way, so nothing is left without a contact.
 */
export async function deleteCustomerAccount(c: C, customerId: string, password: string) {
  const row = (await c.query('SELECT id, password_hash, deleted_at FROM customers WHERE id=$1 FOR UPDATE', [customerId])).rows[0];
  if (!row || row.deleted_at) throw notFound('Account not found');
  if (!(await verifyPassword(password, row.password_hash))) throw unauthorized('That password is not correct');

  const live = (await c.query(`SELECT count(*)::int AS n FROM bookings WHERE customer_id=$1 AND status IN ${LIVE} AND end_at > now()`, [customerId])).rows[0].n;
  if (live) {
    throw conflict(
      `You have ${live} upcoming or active ${live === 1 ? 'booking' : 'bookings'}. Cancel ${live === 1 ? 'it' : 'them'}, or wait until ${live === 1 ? 'it has' : 'they have'} finished, then delete your account.`,
      'has_active_bookings',
    );
  }

  const placeholder = `deleted+${customerId}@deleted.invalid`;
  await c.query(
    `UPDATE customers SET email=$2, name='Deleted customer', phone=NULL, postcode=NULL, city=NULL, internal_notes=NULL,
            password_hash=$3, password_changed_at=now(), deleted_at=now(), updated_at=now() WHERE id=$1`,
    [customerId, placeholder, await hashPassword(crypto.randomBytes(32).toString('hex'))],
  );
  // Free-text details the customer typed on bookings; the booking itself (car, dates, price) stays for the records.
  await c.query(`UPDATE bookings SET customer_notes=NULL, occasion=NULL, children=NULL WHERE customer_id=$1`, [customerId]);
  await c.query('DELETE FROM push_tokens WHERE customer_id=$1', [customerId]);
  await c.query('DELETE FROM password_resets WHERE customer_id=$1', [customerId]);
  await c.query(`DELETE FROM notifications WHERE customer_id=$1 AND NOT staff_only`, [customerId]);
  // Nothing more is sent to this person.
  await c.query(`UPDATE email_outbox SET status='skipped', last_error='account deleted' WHERE customer_id=$1 AND status IN ('pending','sending')`, [customerId]);
  await c.query(`UPDATE push_outbox SET status='skipped', last_error='account deleted' WHERE customer_id=$1 AND status IN ('pending','sending')`, [customerId]);
}
