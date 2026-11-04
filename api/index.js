// Vercel Function entry. Uses the compiled API from `npm run build`, so Vercel doesn't compile the TypeScript again.
// src/server.ts isn't used here: its timers don't run reliably in a function, so a scheduler calls /internal/run-jobs.
import { buildApp } from '../dist/app.js';

const ready = buildApp().then(async (app) => {
  await app.ready();
  return app;
});

export default async function handler(req, res) {
  const app = await ready;
  app.server.emit('request', req, res);
}
