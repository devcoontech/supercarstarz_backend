import { HttpError } from './errors.js';
import { getSecret, getSettings } from './settings.js';

/*
 * Address search and driving distance, always called from the server so keys stay secret and
 * customers cannot tamper with distances. Two providers:
 *  - 'osm'    OpenStreetMap Nominatim (search) + OSRM (routing). Free, no key. The public servers are for light
 *             use only (about one request a second); for real traffic point NOMINATIM_URL / OSRM_URL at your own
 *             instance or switch to Google.
 *  - 'google' Google Geocoding API + Routes API, using the key saved in Admin > Settings > Maps.
 */

export type LatLng = { lat: number; lng: number };
export type Place = LatLng & { label: string };
export type Drive = { km: number; minutes: number };

export const mapsUnavailable = (m = 'The map service is not available right now. Please try again shortly.') => new HttpError(503, m, 'maps_unavailable');
export const addressNotFound = (what = 'that address') => new HttpError(422, `We couldn't find ${what}. Check the spelling or add a postcode.`, 'address_not_found');

type Http = (url: string, init?: RequestInit) => Promise<Response>;
let http: Http = (url, init) => fetch(url, init);
/** For tests: replace the network. */
export const setMapsHttp = (h: Http | null) => { http = h ?? ((u, i) => fetch(u, i)); };
export const clearMapsCache = () => cache.clear();

const NOMINATIM = process.env.NOMINATIM_URL ?? 'https://nominatim.openstreetmap.org';
const OSRM = process.env.OSRM_URL ?? 'https://router.project-osrm.org';
const MIN_INTERVAL = Number(process.env.MAPS_MIN_INTERVAL_MS ?? 1100); // public Nominatim allows ~1 request/second
const UA = 'Supercarstars-booking/1.0 (server-side address lookup)';

const cache = new Map<string, { at: number; v: unknown }>();
const TTL = 24 * 3600 * 1000;
const remember = async <T>(key: string, fn: () => Promise<T>): Promise<T> => {
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < TTL) return hit.v as T;
  const v = await fn();
  if (cache.size > 1000) cache.delete(cache.keys().next().value as string);
  cache.set(key, { at: Date.now(), v });
  return v;
};

let chain: Promise<unknown> = Promise.resolve();
let lastCall = 0;
let queued = 0;
const MAX_QUEUE = Number(process.env.MAPS_MAX_QUEUE ?? 20);
const MAX_WAIT_MS = 10_000;
/**
 * Serialises calls to the shared OSM servers so we stay inside their usage policy. The queue is bounded and a call
 * that has waited too long gives up, so a burst of lookups (e.g. anonymous quotes) cannot stall everyone else.
 */
const throttled = <T>(fn: () => Promise<T>): Promise<T> => {
  if (queued >= MAX_QUEUE) return Promise.reject(mapsUnavailable('The map service is busy right now. Please try again shortly.'));
  queued++;
  const enqueued = Date.now();
  const run = chain.then(async () => {
    if (Date.now() - enqueued > MAX_WAIT_MS) throw mapsUnavailable('The map service is busy right now. Please try again shortly.');
    const wait = lastCall + MIN_INTERVAL - Date.now();
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    lastCall = Date.now();
    return fn();
  }).finally(() => { queued--; });
  chain = run.catch(() => undefined);
  return run;
};

async function json(url: string, init?: RequestInit): Promise<any> {
  let res: Response;
  try {
    res = await http(url, { ...init, signal: AbortSignal.timeout(8000) });
  } catch {
    throw mapsUnavailable();
  }
  if (!res.ok) throw mapsUnavailable();
  return res.json().catch(() => { throw mapsUnavailable(); });
}

const norm = (q: string) => q.trim().replace(/\s+/g, ' ').toLowerCase();

/** Up to `limit` matching places for an address the customer is typing. */
export async function suggest(query: string, limit = 5): Promise<Place[]> {
  const q = query.trim();
  if (q.length < 3) return [];
  const s = await getSettings();
  const provider = s['maps.provider'];
  const countries = s['maps.countryCodes'].split(',').map((c) => c.trim().toLowerCase()).filter(Boolean);
  return remember(`s:${provider}:${countries}:${limit}:${norm(q)}`, async () => {
    if (provider === 'google') {
      const key = await getSecret('maps.googleKey');
      if (!key) throw mapsUnavailable('Address search is not set up yet.');
      const comp = countries.length ? `&components=${encodeURIComponent(countries.map((c) => 'country:' + c.toUpperCase()).join('|'))}` : '';
      const j = await json(`https://maps.googleapis.com/maps/api/geocode/json?address=${encodeURIComponent(q)}${comp}&key=${key}`);
      if (j.status === 'ZERO_RESULTS') return [];
      if (j.status !== 'OK') throw mapsUnavailable();
      return (j.results as any[]).slice(0, limit).map((r) => ({ lat: r.geometry.location.lat, lng: r.geometry.location.lng, label: r.formatted_address }));
    }
    const cc = countries.length ? `&countrycodes=${countries.join(',')}` : '';
    const j = await throttled(() => json(`${NOMINATIM}/search?q=${encodeURIComponent(q)}&format=jsonv2&limit=${limit}${cc}`, { headers: { 'User-Agent': UA, Accept: 'application/json' } }));
    return (j as any[]).map((r) => ({ lat: Number(r.lat), lng: Number(r.lon), label: String(r.display_name) }));
  });
}

/** The address at a map point (for the map picker). Null where there is nothing sensible, e.g. open sea. */
export async function reverse(p: LatLng): Promise<Place | null> {
  const s = await getSettings();
  const provider = s['maps.provider'];
  return remember(`rev:${provider}:${p.lat.toFixed(5)},${p.lng.toFixed(5)}`, async () => {
    if (provider === 'google') {
      const key = await getSecret('maps.googleKey');
      if (!key) throw mapsUnavailable('Address search is not set up yet.');
      const j = await json(`https://maps.googleapis.com/maps/api/geocode/json?latlng=${p.lat},${p.lng}&key=${key}`);
      if (j.status === 'ZERO_RESULTS') return null;
      if (j.status !== 'OK') throw mapsUnavailable();
      const r = j.results[0];
      return { lat: p.lat, lng: p.lng, label: r.formatted_address };
    }
    const j = await throttled(() => json(`${NOMINATIM}/reverse?lat=${p.lat}&lon=${p.lng}&format=jsonv2&zoom=18`, { headers: { 'User-Agent': UA, Accept: 'application/json' } }));
    if (!j || j.error || !j.display_name) return null;
    // The pin stays exactly where the customer put it; only the wording comes from the lookup.
    return { lat: p.lat, lng: p.lng, label: String(j.display_name) };
  });
}

/** The single best match, or null. */
export async function geocode(query: string): Promise<Place | null> {
  return (await suggest(query, 1))[0] ?? null;
}

/** Like geocode, but a missing match is an error the customer can act on. */
export async function mustGeocode(query: string, what?: string): Promise<Place> {
  const p = await geocode(query);
  if (!p) throw addressNotFound(what);
  return p;
}

/** Driving distance and time between two points. */
export async function drive(a: LatLng, b: LatLng): Promise<Drive> {
  const s = await getSettings();
  const provider = s['maps.provider'];
  const key = `r:${provider}:${a.lat.toFixed(5)},${a.lng.toFixed(5)}>${b.lat.toFixed(5)},${b.lng.toFixed(5)}`;
  return remember(key, async () => {
    if (provider === 'google') {
      const apiKey = await getSecret('maps.googleKey');
      if (!apiKey) throw mapsUnavailable('Distance calculation is not set up yet.');
      const j = await json('https://routes.googleapis.com/directions/v2:computeRoutes', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'X-Goog-Api-Key': apiKey, 'X-Goog-FieldMask': 'routes.distanceMeters,routes.duration' },
        body: JSON.stringify({
          origin: { location: { latLng: { latitude: a.lat, longitude: a.lng } } },
          destination: { location: { latLng: { latitude: b.lat, longitude: b.lng } } },
          travelMode: 'DRIVE',
        }),
      });
      const r = j.routes?.[0];
      if (!r) throw new HttpError(422, "We couldn't find a driving route between those places.", 'no_route');
      return { km: r.distanceMeters / 1000, minutes: Math.round(parseInt(String(r.duration), 10) / 60) };
    }
    const j = await throttled(() => json(`${OSRM}/route/v1/driving/${a.lng},${a.lat};${b.lng},${b.lat}?overview=false`, { headers: { 'User-Agent': UA } }));
    if (j.code !== 'Ok' || !j.routes?.[0]) throw new HttpError(422, "We couldn't find a driving route between those places.", 'no_route');
    return { km: j.routes[0].distance / 1000, minutes: Math.round(j.routes[0].duration / 60) };
  });
}

export const KM_PER_MILE = 1.609344;

/** Map services measure in km; the business prices in miles. Rounded to 0.1 mile so quotes and invoices show the same figure. */
export const toMiles = (km: number) => Math.round((km / KM_PER_MILE) * 10) / 10;
