import { buildApp } from './app.js';
import { config } from './core/config.js';
import { pool, tx } from './core/db.js';
import { expireHolds } from './modules/bookings/status.js';
import { processOutbox } from './modules/notifications/emails.js';
import { checkPushReceipts, processPushOutbox } from './modules/notifications/push.js';
import { queueBalanceReminders, queueReminders } from './modules/notifications/reminders.js';

const app = await buildApp();

// Releases cars held for unpaid bookings. Idempotent, so running on several instances is safe.
const timer = setInterval(() => {
  tx((c) => expireHolds(c)).catch((e) => app.log.error({ err: e }, 'expireHolds failed'));
}, 60_000);

// Sends queued customer emails. Rows are claimed safely, so several instances can run this.
const mailTimer = setInterval(() => {
  processOutbox().catch((e) => app.log.error({ err: e }, 'processOutbox failed'));
}, 10_000);

// Sends queued push notifications, and later checks that Apple and Google accepted them.
const pushTimer = setInterval(() => {
  processPushOutbox().catch((e) => app.log.error({ err: e }, 'processPushOutbox failed'));
}, 10_000);
const pushReceiptTimer = setInterval(() => {
  checkPushReceipts().catch((e) => app.log.error({ err: e }, 'checkPushReceipts failed'));
}, 15 * 60_000);

// Queues "see you tomorrow" reminders for bookings starting in the next 24 hours (each sent once).
const reminderTimer = setInterval(() => {
  tx((c) => queueReminders(c)).catch((e) => app.log.error({ err: e }, 'queueReminders failed'));
  tx((c) => queueBalanceReminders(c)).catch((e) => app.log.error({ err: e }, 'queueBalanceReminders failed'));
}, 15 * 60_000);

const shutdown = async () => {
  clearInterval(timer);
  clearInterval(mailTimer);
  clearInterval(pushTimer);
  clearInterval(pushReceiptTimer);
  clearInterval(reminderTimer);
  await app.close();
  await pool.end();
  process.exit(0);
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

await app.listen({ port: config.port, host: '0.0.0.0' });
