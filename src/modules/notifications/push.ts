import { config } from '../../core/config.js';
import { pool } from '../../core/db.js';

/*
 * Push notifications, sent through Expo's push service (which passes them to Apple and Google). Rows are queued by
 * notify() in the same transaction as the in-app notification, so a push problem can never affect a booking or payment.
 */

const EXPO_API = 'https://exp.host/--/api/v2/push';
const MAX_ATTEMPTS = 5;
/** A customer rarely has more than a couple of phones; this stops one account fanning out to many. */
const MAX_DEVICES = 10;
/** Expo's advice: delivery results are ready after about 15 minutes, and are gone after 24 hours. */
const RECEIPT_DELAY = `interval '15 minutes'`;
const RECEIPT_EXPIRY = `interval '24 hours'`;

export type PushMessage = { to: string; title: string; body?: string; sound: 'default'; priority: 'high'; channelId: 'default'; data: Record<string, unknown> };
type PushError = { status: 'error'; message?: string; details?: { error?: string } };
export type PushTicket = { status: 'ok'; id: string } | PushError;
export type PushReceipt = { status: 'ok' } | PushError;
export interface PushClient {
  send(messages: PushMessage[]): Promise<PushTicket[]>;
  receipts(ids: string[]): Promise<Record<string, PushReceipt>>;
}

async function expoRequest<T>(path: string, body: unknown): Promise<T> {
  const res = await fetch(`${EXPO_API}/${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json', ...(config.expoAccessToken ? { authorization: `Bearer ${config.expoAccessToken}` } : {}) },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(15_000),
  });
  const json = (await res.json().catch(() => null)) as { data?: T; errors?: { message?: string }[] } | null;
  if (!res.ok || !json?.data) throw new Error(json?.errors?.[0]?.message ?? `Expo push service answered ${res.status}`);
  return json.data;
}

const expoClient: PushClient = {
  send: (messages) => expoRequest<PushTicket[]>('send', messages),
  receipts: (ids) => expoRequest<Record<string, PushReceipt>>('getReceipts', { ids }),
};

let client = expoClient;
/** For tests: capture outgoing pushes instead of sending them. */
export const setPushClient = (c: PushClient | null) => {
  client = c ?? expoClient;
};

const errorText = (e: PushError) => (e.details?.error ?? e.message ?? 'push rejected').slice(0, 300);
const forgetDevice = (token: string) => pool.query('DELETE FROM push_tokens WHERE token=$1', [token]);

export type PushResult = { sent: number; retrying: number; failed: number; skipped: number };

/** Sends due pushes. Safe to run on several instances at once and to run repeatedly, like processOutbox for email. */
export async function processPushOutbox(limit = 10): Promise<PushResult> {
  const out: PushResult = { sent: 0, retrying: 0, failed: 0, skipped: 0 };
  const rows = (await pool.query(
    `UPDATE push_outbox SET status='sending', attempts = attempts + 1, locked_at = now()
      WHERE id IN (SELECT id FROM push_outbox
                    WHERE (status='pending' AND next_attempt_at <= now()) OR (status='sending' AND locked_at < now() - interval '5 minutes')
                    ORDER BY created_at LIMIT $1 FOR UPDATE SKIP LOCKED)
      RETURNING *`, [limit])).rows;

  for (const r of rows) {
    const finish = (status: string, error: string | null = null, delayMin = 0) =>
      pool.query(
        `UPDATE push_outbox SET status=$2, last_error=$3, locked_at=NULL, sent_at = CASE WHEN $2='sent' THEN now() ELSE sent_at END,
                next_attempt_at = now() + ($4 || ' minutes')::interval WHERE id=$1`, [r.id, status, error, String(delayMin)]);
    const retry = async (error: string) => {
      if (r.attempts >= MAX_ATTEMPTS) { await finish('failed', error); out.failed++; } else { await finish('pending', error, r.attempts * 5); out.retrying++; }
    };
    try {
      const tokens: string[] = (await pool.query('SELECT token FROM push_tokens WHERE customer_id=$1 ORDER BY updated_at DESC LIMIT $2', [r.customer_id, MAX_DEVICES])).rows.map((t) => t.token);
      if (!tokens.length) { await finish('skipped', 'no device registered'); out.skipped++; continue; }

      const tickets = await client.send(tokens.map((to) => ({
        to, title: r.title, ...(r.body ? { body: r.body } : {}), sound: 'default', priority: 'high', channelId: 'default',
        data: { notificationId: r.notification_id, bookingId: r.booking_id },
      })));
      if (tickets.length !== tokens.length) throw new Error('Expo push service answered with the wrong number of tickets');

      const errors: string[] = [];
      let accepted = 0;
      for (const [i, t] of tickets.entries()) {
        if (t.status === 'ok') {
          accepted++;
          await pool.query('INSERT INTO push_tickets(id, outbox_id, token) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING', [t.id, r.id, tokens[i]]);
        } else if (t.details?.error === 'DeviceNotRegistered') {
          await forgetDevice(tokens[i]); // The app was removed from this phone.
        } else {
          errors.push(errorText(t));
        }
      }
      // Once any phone has it, a retry would send a duplicate to that phone, so only retry when none did.
      if (accepted) { await finish('sent', errors[0] ?? null); out.sent++; }
      else if (errors.length) await retry(errors[0]);
      else { await finish('skipped', 'no device registered'); out.skipped++; }
    } catch (e) {
      await retry((e as Error).message);
    }
  }
  return out;
}

/**
 * Asks Expo whether Apple and Google took the messages. Removes phones the app was deleted from, and records other
 * problems (such as wrong Firebase or Apple credentials) on the outbox row, so a silent failure can be found.
 */
export async function checkPushReceipts(limit = 300) {
  const rows = (await pool.query(`SELECT id, outbox_id, token FROM push_tickets WHERE created_at < now() - ${RECEIPT_DELAY} ORDER BY created_at LIMIT $1`, [limit])).rows;
  if (!rows.length) return { checked: 0 };
  const receipts = await client.receipts(rows.map((t) => t.id));
  let checked = 0;
  for (const t of rows) {
    const receipt = receipts[t.id];
    if (!receipt) continue; // Not ready yet; the clean-up below drops it once Expo no longer has it.
    if (receipt.status === 'error') {
      if (receipt.details?.error === 'DeviceNotRegistered') await forgetDevice(t.token);
      else await pool.query('UPDATE push_outbox SET last_error=$2 WHERE id=$1', [t.outbox_id, errorText(receipt)]);
    }
    await pool.query('DELETE FROM push_tickets WHERE id=$1', [t.id]);
    checked++;
  }
  await pool.query(`DELETE FROM push_tickets WHERE created_at < now() - ${RECEIPT_EXPIRY}`);
  return { checked };
}
