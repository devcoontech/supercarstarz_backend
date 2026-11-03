import fs from 'node:fs';
import path from 'node:path';
import { pool } from '../core/db.js';
import { config } from '../core/config.js';
import { putPrivate, putPublic, storageDriver } from '../lib/storage.js';

/*
 * One-off: copies files that were saved on this server's disk into Supabase Storage and points the records at the
 * new URLs. Safe to run again: records already on Supabase are skipped. Local files are left in place; delete
 * the uploads folders yourself once everything shows correctly.
 *
 *   npm run storage:migrate
 */

const MIME: Record<string, string> = { jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp' };
const mimeOf = (key: string) => MIME[path.extname(key).slice(1).toLowerCase()] ?? 'application/octet-stream';
/** The storage key inside a local /uploads/ URL, or null for anything else (Supabase, Unsplash...). */
const localKey = (url: string | null) => {
  if (!url || url.includes('/storage/v1/')) return null;
  const i = url.indexOf('/uploads/');
  return i < 0 ? null : decodeURIComponent(url.slice(i + '/uploads/'.length));
};
const readLocal = (dir: string, key: string) => {
  const full = path.join(path.resolve(dir), key);
  return fs.existsSync(full) ? fs.readFileSync(full) : null;
};

async function main() {
  if (storageDriver !== 'supabase') {
    console.error('Set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY in backend/.env first.');
    process.exitCode = 1;
    return;
  }
  const n = { moved: 0, missing: 0 };

  const images = (await pool.query('SELECT id, url FROM vehicle_images')).rows;
  for (const r of images) {
    const key = localKey(r.url);
    if (!key) continue;
    const buf = readLocal(config.uploadDir, key);
    if (!buf) { console.warn(`missing file for vehicle image ${r.id}: ${key}`); n.missing++; continue; }
    const url = await putPublic(key, buf, mimeOf(key));
    await pool.query('UPDATE vehicle_images SET url=$2, storage_key=$3 WHERE id=$1', [r.id, url, key]);
    n.moved++;
  }

  for (const table of ['event_types', 'offers', 'addons']) {
    const rows = (await pool.query(`SELECT id, image_url FROM ${table} WHERE image_url IS NOT NULL`)).rows;
    for (const r of rows) {
      const key = localKey(r.image_url);
      if (!key) continue;
      const buf = readLocal(config.uploadDir, key);
      if (!buf) { console.warn(`missing file for ${table} ${r.id}: ${key}`); n.missing++; continue; }
      await pool.query(`UPDATE ${table} SET image_url=$2 WHERE id=$1`, [r.id, await putPublic(key, buf, mimeOf(key))]);
      n.moved++;
    }
  }

  // Licence photos keep their storage key; only the bytes move to the private bucket.
  const licences = (await pool.query('SELECT id, storage_key, mime FROM driver_licence_images')).rows;
  for (const r of licences) {
    const buf = readLocal(config.privateUploadDir, r.storage_key);
    if (!buf) continue; // already on Supabase, or never saved here
    await putPrivate(r.storage_key, buf, r.mime);
    n.moved++;
  }

  console.log(`Moved ${n.moved} file(s) to Supabase Storage.${n.missing ? ` ${n.missing} record(s) point at files that are not on this server.` : ''}`);
}

main().catch((e) => { console.error(e); process.exitCode = 1; }).finally(() => pool.end());
