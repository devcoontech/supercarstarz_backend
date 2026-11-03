import { pool } from '../core/db.js';
import { hashPassword } from '../core/security.js';
import { migrate } from './migrate.js';

/**
 * Creates the first company-owner account (idempotent). Pass --demo to also load sample catalogue data
 * for local development. Never run --demo against production.
 */
const demo = process.argv.includes('--demo');

async function main() {
  await migrate();
  const email = (process.env.SEED_OWNER_EMAIL ?? '').toLowerCase();
  const pw = process.env.SEED_OWNER_PASSWORD ?? '';
  if (!email || pw.length < 10) throw new Error('Set SEED_OWNER_EMAIL and a SEED_OWNER_PASSWORD of at least 10 characters');
  const r = await pool.query(
    `INSERT INTO staff_users(email, name, password_hash, role) VALUES ($1,'Company Owner',$2,'owner') ON CONFLICT (email) DO NOTHING RETURNING id`,
    [email, await hashPassword(pw)],
  );
  console.log(r.rowCount ? `created owner ${email}` : `owner ${email} already exists`);

  if (!demo) return;

  // Event types (safe to re-run: existing ones are kept, missing ones are added and offered on every car).
  const EVENTS: [slug: string, title: string, description: string, basis: 'hourly' | 'distance'][] = [
    ['birthdays', 'Birthdays', "A supercar for a child's birthday party", 'hourly'],
    ['photoshoots', 'Photoshoots', 'Family and portrait photography with the car', 'hourly'],
    ['weddings', 'Weddings', 'Arrive in style', 'hourly'],
    ['road-show', 'Road show', 'Bring the car to your event, launch or promotion', 'hourly'],
    ['race-event', 'Race event', 'Supercars for race days and track events', 'hourly'],
    ['children-photoshoot', 'Children photoshoot', 'A safe, fun photoshoot with the car for children', 'hourly'],
    ['pick-and-drop', 'Pick and drop', 'A driver takes you from your pick-up to your drop-off, priced by distance', 'distance'],
  ];
  const eventIds: Record<string, string> = {};
  for (const [i, [slug, title, description, basis]] of EVENTS.entries()) {
    const r = await pool.query(
      `INSERT INTO event_types(slug, title, description, published, sort_order, pricing_basis) VALUES ($1,$2,$3,true,$4,$5)
       ON CONFLICT (slug) DO UPDATE SET slug = EXCLUDED.slug RETURNING id`, [slug, title, description, i + 1, basis]);
    eventIds[slug] = r.rows[0].id;
  }
  // Pick and drop is priced per mile: £4.02/mile with a £30 minimum (edit under Pricing).
  if (!(await pool.query(`SELECT 1 FROM pricing_rules WHERE kind='per_mile' AND event_type_id=$1`, [eventIds['pick-and-drop']])).rowCount) {
    await pool.query(`INSERT INTO pricing_rules(kind, event_type_id, amount_pence, min_amount_pence, label) VALUES ('per_mile',$1,402,3000,'Pick and drop')`, [eventIds['pick-and-drop']]);
  }
  for (const v of (await pool.query('SELECT id FROM vehicles WHERE deleted_at IS NULL')).rows) {
    for (const id of Object.values(eventIds)) await pool.query('INSERT INTO vehicle_event_types(vehicle_id, event_type_id) VALUES ($1,$2) ON CONFLICT DO NOTHING', [v.id, id]);
  }
  if ((await pool.query('SELECT 1 FROM vehicles LIMIT 1')).rowCount) { console.log('vehicles exist, event types ensured, skipping the rest of the demo data'); return; }

  const img = (id: string) => `https://images.unsplash.com/${id}?auto=format&fit=crop&w=1200&q=80`; // demo placeholders only
  const cars = [
    ['Lamborghini', 'Huracán EVO Spyder', 2022, 'Convertible', 'Giallo Belenus', 'London', 24000, true, 8500, '631 hp', '202 mph', 'photo-1544636331-e26879cd4d9b'],
    ['McLaren', '720S', 2021, 'Supercar', 'Papaya Spark', 'Manchester', 21000, true, 7000, '710 hp', '212 mph', 'photo-1621135802920-133df287f89c'],
    ['Ferrari', 'F8 Tributo', 2021, 'Supercar', 'Rosso Corsa', 'Birmingham', 23000, false, 0, '710 hp', '211 mph', 'photo-1503376780353-7e6692767b70'],
  ] as const;
  // Demo base locations (city centres). Set a real base address per car in the dashboard.
  const CITY: Record<string, [string, number, number]> = {
    London: ['Trafalgar Square, London', 51.508, -0.128],
    Manchester: ['Piccadilly Gardens, Manchester', 53.481, -2.237],
    Birmingham: ['Victoria Square, Birmingham', 52.480, -1.903],
  };
  for (const [make, model, year, category, colour, city, rate, delivery, fee, power, top, photo] of cars) {
    const v = (await pool.query(
      `INSERT INTO vehicles(make, model, year, category, colour, city, seats, power, top_speed, price_per_hour_pence, delivery_available, delivery_fee_pence, description, published, chauffeur_available, chauffeur_fee_pence, buffer_minutes, chauffeur_charge_type, base_address, base_lat, base_lng, delivery_pricing, delivery_per_mile_pence, delivery_free_miles, delivery_min_pence, delivery_radius_miles)
       VALUES ($1,$2,$3,$4,$5,$6,2,$7,$8,$9,$10,$11,$12,true,true,3500,30,'hourly',$13,$14,$15,'per_mile',241,3,2000,50) RETURNING id`,
      [make, model, year, category, colour, city, power, top, rate, delivery, fee, `${make} ${model} (demo listing)`, ...(CITY[city] ?? CITY.London)])).rows[0].id;
    await pool.query('INSERT INTO vehicle_images(vehicle_id, url, sort_order, is_cover) VALUES ($1,$2,0,true)', [v, img(photo)]);
    for (const id of Object.values(eventIds)) await pool.query('INSERT INTO vehicle_event_types(vehicle_id, event_type_id) VALUES ($1,$2) ON CONFLICT DO NOTHING', [v, id]);
  }
  await pool.query(`INSERT INTO addons(name, detail, price_pence, sort_order) VALUES
    ('Professional photographer','40+ edited images within 48 hours',9500,1),('Printed photo album','A4 hardback, 20 pages',4500,2),('Birthday styling','Name banner, ribbon and balloon arch',3500,3)`);
  console.log('demo catalogue loaded');
}

main().then(() => pool.end()).catch((e) => { console.error(e); process.exit(1); });
