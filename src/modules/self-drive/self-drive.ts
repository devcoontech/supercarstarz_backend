import type pg from 'pg';
import { z } from 'zod';
import { DateTime } from 'luxon';
import { badRequest } from '../../core/errors.js';
import type { Settings } from '../../core/settings.js';
import type { Prepared } from '../bookings/bookings.js';

/*
 * Self-drive bookings. When a customer books a car without a driver they tell us who will drive: name, date of birth,
 * home address, contact details and driving licence (number, dates, points) with a photo of the licence. One
 * application covers every self-drive car in the order. Staff review it in the dashboard before the car is handed over.
 *
 * The rules (minimum age, years with a full licence, most penalty points) are business settings, checked here against
 * the booking dates so a licence that runs out before the hire ends is refused before anything is saved.
 */

type C = pg.PoolClient;

const ymd = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use the format YYYY-MM-DD').refine((s) => DateTime.fromISO(s).isValid, 'Not a real date');
const UK = /^(united kingdom|uk|great britain|gb|england|scotland|wales|northern ireland)$/i;
/** DVLA licence number: 5 letters of the surname (padded with 9), 6 digits, 2 initials (padded with 9), 1 digit, 2 check characters. */
const UK_LICENCE = /^[A-Z9]{5}\d{6}[A-Z9]{2}\d[A-Z0-9]{2}$/;
const UK_POSTCODE = /^[A-Z]{1,2}\d[A-Z\d]?\s?\d[A-Z]{2}$/i;

export const selfDriveSchema = z.object({
  fullName: z.string().trim().min(2, 'Enter the driver’s full name').max(120),
  dateOfBirth: ymd,
  email: z.string().trim().max(200).email('Enter a valid email address'),
  phone: z.string().trim().regex(/^\+?[0-9 ()-]{7,20}$/, 'Enter a valid phone number'),
  addressLine1: z.string().trim().min(3, 'Enter the first line of the address').max(200),
  addressLine2: z.string().trim().max(200).nullish(),
  city: z.string().trim().min(2, 'Enter the town or city').max(80),
  postcode: z.string().trim().min(3, 'Enter the postcode').max(12),
  country: z.string().trim().min(2).max(60).default('United Kingdom'),
  licenceNumber: z.string().trim().min(5, 'Enter the licence number').max(24).regex(/^[A-Za-z0-9 -]+$/, 'Licence numbers only use letters and numbers'),
  licenceCountry: z.string().trim().min(2).max(60).default('United Kingdom'),
  licenceIssuedOn: ymd,
  licenceExpiresOn: ymd,
  licenceCheckCode: z.string().trim().max(20).nullish(),
  penaltyPoints: z.number().int().min(0).max(20),
  convictions: z.string().trim().max(1000).nullish(),
  licenceFrontId: z.string().uuid('Add a photo of the front of the licence'),
  licenceBackId: z.string().uuid().nullish(),
  confirmed: z.literal(true, { message: 'Confirm the driver details are correct' }),
});
export type SelfDriveInput = z.infer<typeof selfDriveSchema>;

const yearsBetween = (from: string, to: DateTime) => to.diff(DateTime.fromISO(from, { zone: to.zone }), 'years').years;

/**
 * Checks a self-drive application against the cars being booked. Returns the cleaned-up details to save, or null when
 * no car in the order is self-drive. Customers must send it; staff booking on someone's behalf may leave it out.
 */
export async function checkSelfDrive(
  c: Pick<C, 'query'>, input: SelfDriveInput | null | undefined, prepared: Prepared[], customerId: string, settings: Settings, staff: boolean,
) {
  const selfDrive = prepared.filter((p) => p.driverOption === 'self_drive');
  if (!selfDrive.length) return null;
  if (!input) {
    if (staff || !settings['selfDrive.detailsRequired']) return null;
    throw badRequest('Self-drive bookings need the driver’s details and driving licence', 'self_drive_details_required');
  }
  const d = { ...input };
  const isUk = UK.test(d.licenceCountry);
  d.licenceNumber = d.licenceNumber.replace(/[\s-]/g, '').toUpperCase();
  if (isUk && !UK_LICENCE.test(d.licenceNumber)) throw badRequest('That is not a valid UK driving licence number (16 characters, as printed in section 5 of the licence)', 'invalid_licence_number');
  if (UK.test(d.country)) {
    if (!UK_POSTCODE.test(d.postcode)) throw badRequest('Enter a valid UK postcode', 'invalid_postcode');
    d.postcode = d.postcode.toUpperCase().replace(/\s+/g, '').replace(/^(.+)(\d[A-Z]{2})$/, '$1 $2');
  }

  const first = selfDrive.reduce((a, p) => (p.slot.start < a ? p.slot.start : a), selfDrive[0].slot.start);
  const last = selfDrive.reduce((a, p) => (p.slot.end > a ? p.slot.end : a), selfDrive[0].slot.end);
  const today = DateTime.now().setZone(first.zone).startOf('day');

  const minAge = settings['selfDrive.minAge'];
  const age = yearsBetween(d.dateOfBirth, first);
  if (age > 100 || DateTime.fromISO(d.dateOfBirth) > today) throw badRequest('Check the date of birth', 'invalid_date_of_birth');
  if (age < minAge) throw badRequest(`Self-drive drivers must be at least ${minAge} years old on the day of the booking`, 'driver_too_young');

  if (DateTime.fromISO(d.licenceIssuedOn) > today) throw badRequest('The licence issue date cannot be in the future', 'invalid_licence_dates');
  if (DateTime.fromISO(d.licenceIssuedOn) < DateTime.fromISO(d.dateOfBirth).plus({ years: 15 })) throw badRequest('Check the licence issue date: it is too close to the date of birth', 'invalid_licence_dates');
  const minYears = settings['selfDrive.minLicenceYears'];
  if (yearsBetween(d.licenceIssuedOn, first) < minYears) {
    throw badRequest(`Self-drive drivers must have held a full licence for at least ${minYears} ${minYears === 1 ? 'year' : 'years'}`, 'licence_too_new');
  }
  if (DateTime.fromISO(d.licenceExpiresOn, { zone: last.zone }).endOf('day') < last) {
    throw badRequest('The driving licence must be valid until the end of the booking', 'licence_expired');
  }
  const maxPoints = settings['selfDrive.maxPenaltyPoints'];
  if (d.penaltyPoints > maxPoints) throw badRequest(`We can only accept self-drive drivers with ${maxPoints} or fewer penalty points`, 'too_many_points');

  // The licence photos must be this customer's own uploads, of the right side.
  const ids = [d.licenceFrontId, d.licenceBackId].filter(Boolean) as string[];
  const found = (await c.query('SELECT id, side FROM customer_licence_uploads WHERE customer_id=$1 AND id = ANY($2::uuid[])', [customerId, ids])).rows;
  if (found.find((f) => f.id === d.licenceFrontId)?.side !== 'front') throw badRequest('Add a photo of the front of the driving licence', 'licence_photo_required');
  if (d.licenceBackId && found.find((f) => f.id === d.licenceBackId)?.side !== 'back') throw badRequest('The photo of the back of the licence could not be found. Add it again.', 'licence_photo_required');
  return d;
}

/** Saves the checked application against its order (one per order). */
export async function saveSelfDrive(c: Pick<C, 'query'>, orderId: string, customerId: string, d: SelfDriveInput) {
  await c.query(
    `INSERT INTO self_drive_applications(order_id, customer_id, full_name, date_of_birth, email, phone, address_line1, address_line2, city, postcode, country,
       licence_number, licence_country, licence_issued_on, licence_expires_on, licence_check_code, penalty_points, convictions, licence_front_id, licence_back_id)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20)`,
    [orderId, customerId, d.fullName, d.dateOfBirth, d.email.toLowerCase(), d.phone, d.addressLine1, d.addressLine2 || null, d.city, d.postcode, d.country,
     d.licenceNumber, d.licenceCountry, d.licenceIssuedOn, d.licenceExpiresOn, d.licenceCheckCode?.toUpperCase() || null, d.penaltyPoints, d.convictions || null,
     d.licenceFrontId, d.licenceBackId || null],
  );
}

/** Every detail of an application, as staff see it. Dates come back as yyyy-mm-dd. */
export const applicationSql = `
  SELECT s.id, s.order_id AS "orderId", s.status, s.review_note AS "reviewNote", s.reviewed_at AS "reviewedAt", st.name AS "reviewedBy", s.created_at AS "createdAt",
         s.full_name AS "fullName", to_char(s.date_of_birth, 'YYYY-MM-DD') AS "dateOfBirth", s.email, s.phone,
         s.address_line1 AS "addressLine1", s.address_line2 AS "addressLine2", s.city, s.postcode, s.country,
         s.licence_number AS "licenceNumber", s.licence_country AS "licenceCountry", to_char(s.licence_issued_on, 'YYYY-MM-DD') AS "licenceIssuedOn",
         to_char(s.licence_expires_on, 'YYYY-MM-DD') AS "licenceExpiresOn", s.licence_check_code AS "licenceCheckCode", s.penalty_points AS "penaltyPoints", s.convictions,
         CASE WHEN f.id IS NULL THEN NULL ELSE json_build_object('id', f.id, 'createdAt', f.created_at) END AS "licenceFront",
         CASE WHEN bk.id IS NULL THEN NULL ELSE json_build_object('id', bk.id, 'createdAt', bk.created_at) END AS "licenceBack"
    FROM self_drive_applications s LEFT JOIN staff_users st ON st.id=s.reviewed_by
    LEFT JOIN customer_licence_uploads f ON f.id=s.licence_front_id LEFT JOIN customer_licence_uploads bk ON bk.id=s.licence_back_id`;
