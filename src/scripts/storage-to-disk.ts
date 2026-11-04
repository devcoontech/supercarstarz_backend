import { pool } from '../core/db.js';
import { getPrivate, putPrivate, putPublic, storageDriver } from '../lib/storage.js';

/*
 * One-off: the reverse of storage-migrate. Copies files from Supabase Storage to this server's disk and points the
 * records at the new URLs. Safe to run again: records already moved are skipped. Nothing is deleted from Supabase.
 *
 * The source is given only for this run, so backend/.env stays free of Supabase settings:
 *   SOURCE_SUPABASE_URL=... SOURCE_SUPABASE_SERVICE_ROLE_KEY=... npm run storage:to-disk
 */

const url = (process.env.SOURCE_SUPABASE_URL ?? '').replace(/\/+$/, '');
const serviceKey = process.env.SOURCE_SUPABASE_SERVICE_ROLE_KEY ?? '';
const privateBucket = process.env.SOURCE_SUPABASE_PRIVATE_BUCKET || 'private-files';

const MIME: Record<string, string> = { jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp' };
const mimeOf = (key: string) => MIME[key.split('.').pop()?.toLowerCase() ?? ''] ?? 'application/octet-stream';

/** The storage key inside a Supabase public URL, or null for anything else (already on disk, Unsplash...). */
const supabaseKey = (fileUrl: string | null) => {
  const m = fileUrl?.match(/\/storage\/v1\/object\/public\/[^/]+\/(.+)$/);
  return m ? m[1].split('/').map(decodeURIComponent).join('/') : null;
};

async function main() {
  if (storageDriver !== 'local') throw new Error('Remove SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY from backend/.env first.');
  if (!url || !serviceKey) throw new Error('Set SOURCE_SUPABASE_URL and SOURCE_SUPABASE_SERVICE_ROLE_KEY for this run.');
  const n = { moved: 0, failed: 0 };

  const download = async (fileUrl: string, label: string, headers?: Record<string, string>) => {
    const res = await fetch(fileUrl, { headers });
    if (res.ok) return Buffer.from(await res.arrayBuffer());
    console.warn(`could not download ${label}: HTTP ${res.status}`);
    n.failed++;
    return null;
  };

  const images = (await pool.query('SELECT id, url FROM vehicle_images')).rows;
  for (const r of images) {
    const key = supabaseKey(r.url);
    if (!key) continue;
    const buf = await download(r.url, `vehicle image ${r.id}`);
    if (!buf) continue;
    await pool.query('UPDATE vehicle_images SET url=$2, storage_key=$3 WHERE id=$1', [r.id, await putPublic(key, buf, mimeOf(key)), key]);
    n.moved++;
  }

  for (const table of ['event_types', 'offers', 'addons']) {
    const rows = (await pool.query(`SELECT id, image_url FROM ${table} WHERE image_url IS NOT NULL`)).rows;
    for (const r of rows) {
      const key = supabaseKey(r.image_url);
      if (!key) continue;
      const buf = await download(r.image_url, `${table} image ${r.id}`);
      if (!buf) continue;
      await pool.query(`UPDATE ${table} SET image_url=$2 WHERE id=$1`, [r.id, await putPublic(key, buf, mimeOf(key))]);
      n.moved++;
    }
  }

  // Licence photos keep their storage key; only the bytes move. Files already on disk are left alone.
  const licences = (await pool.query('SELECT id, storage_key, mime FROM driver_licence_images')).rows;
  for (const r of licences) {
    if (await getPrivate(r.storage_key)) continue;
    const encoded = r.storage_key.split('/').map(encodeURIComponent).join('/');
    const buf = await download(`${url}/storage/v1/object/authenticated/${privateBucket}/${encoded}`, `licence ${r.id}`, {
      apikey: serviceKey,
      authorization: `Bearer ${serviceKey}`,
    });
    if (!buf) continue;
    await putPrivate(r.storage_key, buf, r.mime);
    n.moved++;
  }

  console.log(`Moved ${n.moved} file(s) to disk. ${n.failed} failed.`);
  if (n.failed) process.exitCode = 1;
}

main().catch((e) => { console.error(e); process.exitCode = 1; }).finally(() => pool.end());
