import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { pool, tx } from '../src/core/db.js';
import { setMailer, type Mail } from '../src/lib/mailer.js';
import { notify } from '../src/modules/notifications/notify.js';
import { checkPushReceipts, processPushOutbox, setPushClient, type PushMessage, type PushReceipt, type PushTicket } from '../src/modules/notifications/push.js';
import { app, bookingPayload, makeCustomer, makeVehicle, resetDb } from './helpers.js';

const PHONE_1 = 'ExponentPushToken[phone-1]';
const PHONE_2 = 'ExponentPushToken[phone-2]';

describe('push notifications', () => {
  let a: FastifyInstance;
  let sent: PushMessage[];
  let answer: (m: PushMessage) => PushTicket;
  let down: boolean;
  let receipts: Record<string, PushReceipt>;
  let ticketNo = 0;

  const post = (url: string, headers: Record<string, string>, payload: object) => a.inject({ method: 'POST', url, headers, payload });
  const addPhone = (h: Record<string, string>, token = PHONE_1, platform = 'android') => post('/api/me/push-tokens', h, { token, platform });
  const outbox = async () => (await pool.query('SELECT status, attempts, last_error, title FROM push_outbox ORDER BY created_at')).rows;
  const tokens = async () => (await pool.query('SELECT token, customer_id FROM push_tokens ORDER BY token')).rows;
  const makeDue = () => pool.query(`UPDATE push_outbox SET next_attempt_at = now() - interval '1 minute' WHERE status='pending'`);
  const alert = (customerId: string, dedupeKey = 'k1', extra: object = {}) =>
    tx((c) => notify(c, { customerId, kind: 'driver_assigned', title: 'Driver assigned', body: 'Reference SCS-1', dedupeKey, ...extra }));

  beforeAll(async () => {
    a = await app();
  });
  beforeEach(async () => {
    await resetDb();
    sent = [];
    down = false;
    receipts = {};
    answer = () => ({ status: 'ok', id: `ticket-${++ticketNo}` });
    setPushClient({
      send: async (messages) => {
        if (down) throw new Error('push service down');
        sent.push(...messages);
        return messages.map(answer);
      },
      receipts: async () => receipts,
    });
  });
  afterAll(async () => {
    setPushClient(null);
    setMailer(null);
    await a.close();
  });

  it('pushes a booking update once, with the booking to open when tapped', async () => {
    const v = await makeVehicle();
    const c = await makeCustomer(a);
    expect((await addPhone(c.h)).statusCode).toBe(200);
    const b = (await post('/api/me/bookings', c.h, bookingPayload(v.id))).json();

    expect((await processPushOutbox()).sent).toBe(1);
    expect((await processPushOutbox()).sent).toBe(0);
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ to: PHONE_1, channelId: 'default', data: { bookingId: b.id } });
    expect(sent[0].body).toContain(b.ref);
    expect(await outbox()).toEqual([expect.objectContaining({ status: 'sent', attempts: 1 })]);
  });

  it('does not queue anything for a customer with no phone registered', async () => {
    const c = await makeCustomer(a);
    await alert(c.id);
    expect(await outbox()).toEqual([]);
  });

  it('never pushes staff-only notifications', async () => {
    const c = await makeCustomer(a);
    await addPhone(c.h);
    await alert(c.id, 'staff', { staffOnly: true });
    expect(await outbox()).toEqual([]);
  });

  it('does not push again when the same notification is raised twice', async () => {
    const c = await makeCustomer(a);
    await addPhone(c.h);
    await alert(c.id);
    await alert(c.id);
    expect(await outbox()).toHaveLength(1);
  });

  it('sends to every phone the customer has', async () => {
    const c = await makeCustomer(a);
    await addPhone(c.h, PHONE_1, 'android');
    await addPhone(c.h, PHONE_2, 'ios');
    await alert(c.id);
    await processPushOutbox();
    expect(sent.map((m) => m.to).sort()).toEqual([PHONE_1, PHONE_2]);
  });

  it('retries when the push service is down, then gives up', async () => {
    const c = await makeCustomer(a);
    await addPhone(c.h);
    await alert(c.id);
    down = true;
    expect(await processPushOutbox()).toMatchObject({ retrying: 1 });
    expect((await outbox())[0]).toMatchObject({ status: 'pending', attempts: 1, last_error: 'push service down' });
    expect(await processPushOutbox()).toMatchObject({ retrying: 0 }); // not due yet
    for (let i = 0; i < 4; i++) {
      await makeDue();
      await processPushOutbox();
    }
    expect((await outbox())[0]).toMatchObject({ status: 'failed', attempts: 5 });
  });

  it('forgets a phone the app was deleted from', async () => {
    const c = await makeCustomer(a);
    await addPhone(c.h);
    await alert(c.id);
    answer = () => ({ status: 'error', details: { error: 'DeviceNotRegistered' } });
    expect(await processPushOutbox()).toMatchObject({ skipped: 1 });
    expect(await tokens()).toEqual([]);
  });

  it('does not resend to a phone that got it when another phone failed', async () => {
    const c = await makeCustomer(a);
    await addPhone(c.h, PHONE_1);
    await addPhone(c.h, PHONE_2);
    await alert(c.id);
    answer = (m) => (m.to === PHONE_1 ? { status: 'ok', id: 'ticket-ok' } : { status: 'error', details: { error: 'MessageRateExceeded' } });
    expect(await processPushOutbox()).toMatchObject({ sent: 1, retrying: 0 });
    expect((await outbox())[0]).toMatchObject({ status: 'sent', last_error: 'MessageRateExceeded' });
  });

  it('checks delivery later: forgets dead phones and records other problems', async () => {
    const c = await makeCustomer(a);
    await addPhone(c.h, PHONE_1);
    await addPhone(c.h, PHONE_2);
    await alert(c.id);
    answer = (m) => ({ status: 'ok', id: m.to === PHONE_1 ? 'dead' : 'badcreds' });
    await processPushOutbox();

    expect(await checkPushReceipts()).toEqual({ checked: 0 }); // too early to ask
    await pool.query(`UPDATE push_tickets SET created_at = now() - interval '20 minutes'`);
    receipts = {
      dead: { status: 'error', details: { error: 'DeviceNotRegistered' } },
      badcreds: { status: 'error', details: { error: 'InvalidCredentials' } },
    };
    expect(await checkPushReceipts()).toEqual({ checked: 2 });
    expect((await tokens()).map((t) => t.token)).toEqual([PHONE_2]);
    expect((await outbox())[0].last_error).toBe('InvalidCredentials');
    expect((await pool.query('SELECT 1 FROM push_tickets')).rowCount).toBe(0);
  });

  it('keeps a receipt that is not ready yet, and drops it once Expo no longer has it', async () => {
    const c = await makeCustomer(a);
    await addPhone(c.h);
    await alert(c.id);
    await processPushOutbox();
    await pool.query(`UPDATE push_tickets SET created_at = now() - interval '20 minutes'`);
    expect(await checkPushReceipts()).toEqual({ checked: 0 });
    expect((await pool.query('SELECT 1 FROM push_tickets')).rowCount).toBe(1);
    await pool.query(`UPDATE push_tickets SET created_at = now() - interval '25 hours'`);
    await checkPushReceipts();
    expect((await pool.query('SELECT 1 FROM push_tickets')).rowCount).toBe(0);
  });

  it('needs a signed-in customer and a real push token', async () => {
    const c = await makeCustomer(a);
    expect((await post('/api/me/push-tokens', {}, { token: PHONE_1, platform: 'ios' })).statusCode).toBe(401);
    expect((await addPhone(c.h, 'not-a-token')).statusCode).toBe(400);
    expect((await addPhone(c.h, PHONE_1, 'windows')).statusCode).toBe(400);
    expect(await tokens()).toEqual([]);
  });

  it('moves a phone to whoever signed in last, so nobody gets the previous customer\'s updates', async () => {
    const one = await makeCustomer(a, 'one@test.com');
    const two = await makeCustomer(a, 'two@test.com');
    await addPhone(one.h);
    await addPhone(two.h);
    expect(await tokens()).toEqual([{ token: PHONE_1, customer_id: two.id }]);
    await alert(one.id);
    expect(await outbox()).toEqual([]);
  });

  it('removes a phone on sign-out, but one customer cannot remove another\'s', async () => {
    const one = await makeCustomer(a, 'one@test.com');
    const two = await makeCustomer(a, 'two@test.com');
    await addPhone(one.h);
    expect((await post('/api/me/push-tokens/remove', two.h, { token: PHONE_1 })).statusCode).toBe(200);
    expect(await tokens()).toHaveLength(1);
    expect((await post('/api/me/push-tokens/remove', one.h, { token: PHONE_1 })).statusCode).toBe(200);
    expect(await tokens()).toEqual([]);
  });

  it('stops pushing to old phones after a password reset', async () => {
    const mails: Mail[] = [];
    setMailer({ send: async (m) => (mails.push(m), { sent: true }) });
    const c = await makeCustomer(a, 'reset@test.com');
    await addPhone(c.h);
    await post('/api/auth/customer/forgot', {}, { email: 'reset@test.com' });
    const code = mails[0].text.match(/\b\d{6}\b/)![0];
    expect((await post('/api/auth/customer/reset', {}, { email: 'reset@test.com', code, password: 'a-new-password-1' })).statusCode).toBe(200);
    expect(await tokens()).toEqual([]);
  });
});
