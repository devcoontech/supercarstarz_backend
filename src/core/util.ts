import type { Q } from './db.js';

export async function audit(q: Q, staffId: string, entity: string, entityId: string | null, action: string, before?: unknown, after?: unknown) {
  await q.query('INSERT INTO audit_log(staff_id, entity, entity_id, action, before, after) VALUES ($1,$2,$3,$4,$5,$6)', [
    staffId, entity, entityId, action, before === undefined ? null : JSON.stringify(before), after === undefined ? null : JSON.stringify(after),
  ]);
}

/** Maps camelCase API fields to snake_case columns. Only fields present in `data` are touched. */
export function buildInsert(table: string, fields: Record<string, string>, data: Record<string, unknown>, extra: Record<string, unknown> = {}) {
  const cols: string[] = [];
  const vals: unknown[] = [];
  for (const [api, col] of Object.entries(fields)) if (api in data && data[api] !== undefined) { cols.push(col); vals.push(data[api]); }
  for (const [col, v] of Object.entries(extra)) { cols.push(col); vals.push(v); }
  return { sql: `INSERT INTO ${table}(${cols.join(',')}) VALUES (${cols.map((_, i) => '$' + (i + 1)).join(',')}) RETURNING *`, vals };
}

export function buildUpdate(table: string, id: string, fields: Record<string, string>, data: Record<string, unknown>, touch = true) {
  const sets: string[] = [];
  const vals: unknown[] = [];
  for (const [api, col] of Object.entries(fields)) if (api in data && data[api] !== undefined) { vals.push(data[api]); sets.push(`${col}=$${vals.length}`); }
  if (touch) sets.push('updated_at=now()');
  vals.push(id);
  return { sql: `UPDATE ${table} SET ${sets.join(',')} WHERE id=$${vals.length} RETURNING *`, vals, empty: sets.length === (touch ? 1 : 0) };
}

/** Sniffs the real image type from the first bytes; never trusts the client-supplied mimetype or extension. */
export function sniffImage(buf: Buffer): { ext: 'jpg' | 'png' | 'webp'; mime: string } | null {
  if (buf.length > 12 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return { ext: 'jpg', mime: 'image/jpeg' };
  if (buf.length > 8 && buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return { ext: 'png', mime: 'image/png' };
  if (buf.length > 12 && buf.subarray(0, 4).toString() === 'RIFF' && buf.subarray(8, 12).toString() === 'WEBP') return { ext: 'webp', mime: 'image/webp' };
  return null;
}
