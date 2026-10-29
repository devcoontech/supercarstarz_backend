import fs from 'node:fs';
import path from 'node:path';
import { config } from './config.js';
import { HttpError } from './errors.js';

/*
 * Where uploaded files live.
 *
 * With SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY set, files go to Supabase Storage:
 *  - public images (cars, events, offers, extras) to the public bucket (SUPABASE_STORAGE_BUCKET, default "images"),
 *    so the app and dashboard load them straight from Supabase;
 *  - driver licences to a private bucket (SUPABASE_PRIVATE_BUCKET, default "private-files"), created on first use.
 *    Nobody can open those by URL: the API downloads them for the staff roles allowed to see licences.
 * Without them (local development, tests), files are kept on disk as before: UPLOAD_DIR served at /uploads/,
 * PRIVATE_UPLOAD_DIR never served.
 *
 * Only the server holds the service role key; the app and dashboard never talk to Storage directly.
 */

const supabase = config.supabase.url && config.supabase.serviceKey && config.env !== 'test' ? config.supabase : null;
export const storageDriver = supabase ? 'supabase' : 'local';

const api = (p: string) => `${supabase!.url.replace(/\/+$/, '')}/storage/v1${p}`;
const headers = (extra: Record<string, string> = {}) => ({ apikey: supabase!.serviceKey, authorization: `Bearer ${supabase!.serviceKey}`, ...extra });
const encodeKey = (key: string) => key.split('/').map(encodeURIComponent).join('/');

async function fail(res: Response, what: string): Promise<never> {
  const body = await res.text().catch(() => '');
  console.error(`[storage] ${what} failed: ${res.status} ${body.slice(0, 300)}`);
  throw new HttpError(502, `Could not ${what} in file storage. Try again shortly.`, 'storage_error');
}

async function upload(bucket: string, key: string, buf: Buffer, mime: string, cache: string) {
  const res = await fetch(api(`/object/${bucket}/${encodeKey(key)}`), {
    method: 'POST', headers: headers({ 'content-type': mime, 'cache-control': cache, 'x-upsert': 'false' }), body: new Uint8Array(buf),
  });
  if (res.ok) return;
  // Keys are random and never reused, so "already exists" means this exact file was saved before (a retried run).
  const body = await res.clone().text().catch(() => '');
  if (res.status === 409 || /duplicate|already exists/i.test(body)) return;
  await fail(res, 'save the file');
}

async function remove(bucket: string, key: string) {
  const res = await fetch(api(`/object/${bucket}`), { method: 'DELETE', headers: headers({ 'content-type': 'application/json' }), body: JSON.stringify({ prefixes: [key] }) });
  if (!res.ok) console.error(`[storage] could not delete ${bucket}/${key}: ${res.status}`); // a leftover file is harmless
}

let privateBucketReady = false;
/** Makes sure the private bucket exists and is private. Safe to call often. */
async function ensurePrivateBucket() {
  if (privateBucketReady) return;
  const id = supabase!.privateBucket;
  const res = await fetch(api('/bucket'), { method: 'POST', headers: headers({ 'content-type': 'application/json' }), body: JSON.stringify({ id, name: id, public: false }) });
  if (!res.ok && res.status !== 409 && !/already exists/i.test(await res.text().catch(() => ''))) await fail(res, 'prepare private storage');
  const info = await fetch(api(`/bucket/${id}`), { headers: headers() });
  if (info.ok && (await info.json()).public) {
    throw new HttpError(500, `The storage bucket "${id}" is public. Make it private in Supabase before saving licence photos.`, 'storage_bucket_public');
  }
  privateBucketReady = true;
}

/* ---------- Public images ---------- */

/** Saves a public image and returns the URL to store on the record. */
export async function putPublic(key: string, buf: Buffer, mime: string): Promise<string> {
  if (supabase) {
    await upload(supabase.bucket, key, buf, mime, 'max-age=31536000'); // keys are unique, so the file never changes
    return publicUrl(key);
  }
  const full = path.join(path.resolve(config.uploadDir), key);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, buf);
  return `${config.publicApiUrl}/uploads/${key}`;
}

export const publicUrl = (key: string) =>
  supabase ? api(`/object/public/${supabase.bucket}/${encodeKey(key)}`) : `${config.publicApiUrl}/uploads/${key}`;

/** Deletes a public image by its storage key. Images saved before the switch to Supabase are removed from disk. */
export async function removePublic(key: string, url?: string | null) {
  if (supabase && (!url || url.includes('/storage/v1/'))) return remove(supabase.bucket, key);
  fs.rmSync(path.join(path.resolve(config.uploadDir), key), { force: true });
}

/* ---------- Private files (driver licences) ---------- */

export async function putPrivate(key: string, buf: Buffer, mime: string) {
  if (supabase) {
    await ensurePrivateBucket();
    return upload(supabase.privateBucket, key, buf, mime, 'no-store');
  }
  const full = path.join(path.resolve(config.privateUploadDir), key);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, buf, { mode: 0o600 });
}

/** The file's bytes, or null when it is missing. */
export async function getPrivate(key: string): Promise<Buffer | null> {
  if (supabase) {
    const res = await fetch(api(`/object/authenticated/${supabase.privateBucket}/${encodeKey(key)}`), { headers: headers() });
    if (res.status === 404 || res.status === 400) return getLocalPrivate(key); // saved before the switch to Supabase
    if (!res.ok) await fail(res, 'read the file');
    return Buffer.from(await res.arrayBuffer());
  }
  return getLocalPrivate(key);
}

const getLocalPrivate = (key: string) => {
  const full = path.join(path.resolve(config.privateUploadDir), key);
  return fs.existsSync(full) ? fs.readFileSync(full) : null;
};

export async function removePrivate(key: string) {
  if (supabase) await remove(supabase.privateBucket, key);
  fs.rmSync(path.join(path.resolve(config.privateUploadDir), key), { force: true });
}
