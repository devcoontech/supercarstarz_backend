import { DateTime } from 'luxon';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import { pool } from '../src/core/db.js';
import { hashPassword } from '../src/core/security.js';

export async function resetDb() {
  const { rows } = await pool.query(`SELECT tablename FROM pg_tables WHERE schemaname='public' AND tablename <> 'schema_migrations'`);
  await pool.query(`TRUNCATE ${rows.map((r) => '"' + r.tablename + '"').join(',')} RESTART IDENTITY CASCADE`);
}

export const app = async (): Promise<FastifyInstance> => buildApp();

/** yyyy-mm-dd in London, `n` days from now (default far enough to clear lead time). */
export const day = (n = 10) => DateTime.now().setZone('Europe/London').plus({ days: n }).toISODate()!;

export async function makeStaff(a: FastifyInstance, role = 'owner', email = 'owner@test.com') {
  await pool.query('INSERT INTO staff_users(email, name, password_hash, role) VALUES ($1,$2,$3,$4)', [email, 'Test Owner', await hashPassword('password-123'), role]);
  const r = await a.inject({ method: 'POST', url: '/api/auth/staff/login', payload: { email, password: 'password-123' } });
  return { token: r.json().token as string, h: { authorization: 'Bearer ' + r.json().token } };
}

export async function makeCustomer(a: FastifyInstance, email = 'cust@test.com') {
  const r = await a.inject({ method: 'POST', url: '/api/auth/customer/register', payload: { email, password: 'password-123', name: 'Test Customer' } });
  return { id: r.json().customer.id as string, h: { authorization: 'Bearer ' + r.json().token } };
}

export async function makeVehicle(over: Record<string, unknown> = {}) {
  const v = (await pool.query(
    `INSERT INTO vehicles(make, model, year, category, city, seats, price_per_hour_pence, published, delivery_available, delivery_fee_pence, chauffeur_available, chauffeur_fee_pence, buffer_minutes, deposit_pence)
     VALUES ('Lamborghini','Huracan',2022,'Supercar','London',2,20000,true,true,5000,true,10000,0,0) RETURNING *`)).rows[0];
  await pool.query('INSERT INTO vehicle_images(vehicle_id,url,is_cover) VALUES ($1,$2,true)', [v.id, 'http://x/y.jpg']);
  for (const [k, val] of Object.entries(over)) await pool.query(`UPDATE vehicles SET ${k}=$1 WHERE id=$2`, [val, v.id]);
  return (await pool.query('SELECT * FROM vehicles WHERE id=$1', [v.id])).rows[0];
}

export async function makeEvent(vehicleId: string, title = 'Birthdays') {
  const e = (await pool.query(`INSERT INTO event_types(slug,title,published) VALUES ($1,$2,true) RETURNING *`, [title.toLowerCase(), title])).rows[0];
  await pool.query('INSERT INTO vehicle_event_types VALUES ($1,$2)', [vehicleId, e.id]);
  return e;
}

export const bookingPayload = (vehicleId: string, over: Record<string, unknown> = {}) => ({
  vehicleId, date: day(), time: '11:00', hours: 2, experience: 'stationary', ...over,
});
