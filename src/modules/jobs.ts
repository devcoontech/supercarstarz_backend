import { tx } from '../core/db.js';
import { expireHolds } from './bookings/status.js';
import { processOutbox } from './notifications/emails.js';
import { checkPushReceipts, processPushOutbox } from './notifications/push.js';
import { queueReminders } from './notifications/reminders.js';

/** The work src/server.ts does on timers, for hosts where timers don't run reliably. Safe to call repeatedly. */
export async function runBackgroundJobs() {
  const expiredHolds = await tx((c) => expireHolds(c));
  const remindersQueued = await tx((c) => queueReminders(c));
  const emails = await processOutbox();
  const pushes = await processPushOutbox();
  const pushReceipts = await checkPushReceipts();
  return { expiredHolds, remindersQueued, emails, pushes, pushReceipts };
}
