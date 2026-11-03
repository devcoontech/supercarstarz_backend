import { DateTime } from 'luxon';
import { pool } from '../../core/db.js';
import { getSettings, type Settings } from '../../core/settings.js';
import { getMailer, type Mail } from '../../lib/mailer.js';
import { DOC_TITLES, renderDocument, type DocKind } from '../finance/documents.js';
import { renderEmail, type EmailContent, type EmailSection, type Row } from './layout.js';

/*
 * Booking emails. Rows are queued by notify() (notify.ts) in the same transaction as the in-app notification;
 * this file turns them into branded messages (layout.ts) and sends them.
 *
 * Two audiences:
 *   - customer: customer-facing wording only (never internal notes, staff names or cancel reasons).
 *   - owner:    the full booking sheet for the company (customer contact details, notes, price breakdown),
 *               sent to the addresses in Settings > Business > "Owner notification emails".
 *
 * A row is only marked 'sent' when the provider says it accepted the message.
 */

const MAX_ATTEMPTS = 5;
export const gbp = (pence: number) => (pence < 0 ? '-' : '') + '£' + (Math.abs(pence) / 100).toLocaleString('en-GB', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

type Booking = {
  ref: string; item_ref: string; start_at: Date; end_at: Date; hours: number; experience: string; address: string | null;
  pickup_address: string | null; dropoff_address: string | null; status: string; driver_option: string;
  total_pence: number; paid_pence: number; refunded_pence: number; deposit_due_pence: number; vehicle: string; event: string | null;
};
type Item = {
  id: string; ref: string; status: string; start_at: Date; end_at: Date; hours: number; experience: string; address: string | null;
  pickup_address: string | null; dropoff_address: string | null; driver_option: string; children: number | null; occasion: string | null;
  customer_notes: string | null; admin_notes: string | null; pricing_snapshot: any; vehicle: string; year: number | null; event: string | null;
  driver_name: string | null; driver_phone: string | null;
};
type Order = {
  id: string; ref: string; source: string; created_at: Date; subtotal_pence: number; discount_pence: number; tax_pence: number; fee_pence: number;
  tax_label: string; payment_status: string; pricing_snapshot: any; total_pence: number; paid_pence: number; refunded_pence: number; deposit_due_pence: number;
};
type Receipt = { number: string; kind: DocKind; issued_at: Date; amount_pence: number; data: any };
type Ctx = {
  first: string; customer: { name: string; email: string; phone: string | null };
  booking: Booking; order: Order; items: Item[]; charges: { description: string; amount_pence: number }[];
  settings: Settings; payload: Record<string, unknown>; receipt?: Receipt | null;
};
export type EmailCtx = Ctx;
type Template = (x: Ctx) => EmailContent;

/* ---------- shared pieces ---------- */

const live = (x: Ctx) => {
  const l = x.items.filter((i) => !['cancelled', 'rejected'].includes(i.status));
  return l.length ? l : x.items;
};
const net = (x: Ctx) => x.booking.paid_pence - x.booking.refunded_pence;
const owed = (x: Ctx) => Math.max(0, x.booking.total_pence - net(x));

const when = (b: { start_at: Date; end_at: Date; hours: number }, tz: string) => {
  const s = DateTime.fromJSDate(b.start_at, { zone: tz });
  const e = DateTime.fromJSDate(b.end_at, { zone: tz });
  return `${s.toFormat('cccc d LLLL yyyy')}, ${s.toFormat('HH:mm')} to ${e.toFormat('HH:mm')} (${b.hours} ${b.hours === 1 ? 'hour' : 'hours'})`;
};
const shortDate = (d: Date, tz: string) => DateTime.fromJSDate(d, { zone: tz }).toFormat('ccc d LLL, HH:mm');

const where = (b: Pick<Item, 'experience' | 'address' | 'pickup_address' | 'dropoff_address'>, owner = false) =>
  b.pickup_address ? `Pick-up: ${b.pickup_address}\nDrop-off: ${b.dropoff_address ?? ''}`
  : b.experience === 'delivered' ? `Delivered to ${b.address}`
  : owner ? 'Showroom (customer collects)' : 'At our location. We will send the address before your booking.';

const driverLine = (i: Item, owner = false) =>
  i.driver_option === 'with_driver'
    ? `With a driver${i.driver_name ? `: ${i.driver_name}${owner && i.driver_phone ? ` (${i.driver_phone})` : ''}` : owner ? ' (not yet assigned)' : ''}`
    : 'Self-drive';

/** Customer view of the booking: one card, or one card per car for a booking with several cars. */
function bookingSections(x: Ctx, heading = 'Your booking'): EmailSection[] {
  const tz = x.settings['booking.timezone'];
  const items = live(x);
  const carRows = (i: Item): Row[] => [
    ...(i.event ? [['Occasion', i.event] as Row] : []),
    ['When', when(i, tz)],
    ['Where', where(i)],
    ['Driver', driverLine(i)],
  ];
  if (items.length <= 1) {
    const i = items[0];
    return [{ heading, rows: [['Booking reference', x.booking.ref], ['Car', i ? i.vehicle : x.booking.vehicle], ...(i ? carRows(i) : []), ['Total', gbp(x.booking.total_pence)]] }];
  }
  return [
    { heading, rows: [['Booking reference', x.booking.ref], ['Cars', `${items.length}`], ['Total', gbp(x.booking.total_pence)]] },
    ...items.map((i) => ({ heading: `${i.vehicle} · ${i.ref}`, rows: carRows(i) })),
  ];
}

function paymentSection(x: Ctx, heading = 'Payment'): EmailSection {
  const rows: Row[] = [['Booking total', gbp(x.booking.total_pence)], ['Paid so far', gbp(net(x))]];
  if (x.booking.refunded_pence) rows.push(['Refunded', gbp(x.booking.refunded_pence)]);
  return { heading, rows, total: ['Still to pay', gbp(owed(x))] };
}

const cancellationPolicy = (s: Settings) => {
  const late = s['booking.cancellationLateRefundPercent'];
  return `Plans changed? You can request a cancellation in the app. Cancel at least ${s['booking.cancellationFreeHours']} hours before the start for a full refund; ${
    late > 0 ? `after that, ${late}% of what you've paid is refunded.` : "after that, payments aren't refundable."}`;
};

const appCta = (s: Settings, label = 'View my booking') => (s['company.websiteUrl'] ? { label, url: s['company.websiteUrl'] } : null);
const greet = (x: Ctx) => `Hi ${x.first},`;

/* ---------- customer templates ---------- */

const CUSTOMER: Record<string, Template> = {
  booking_received: (x) => {
    const approval = x.settings['booking.requireApproval'];
    return {
      subject: approval ? `We've received your booking request (${x.booking.ref})` : `Booking created: complete payment (${x.booking.ref})`,
      preheader: approval ? "Thanks! We're checking availability and will confirm shortly." : `Pay within ${x.settings['booking.holdMinutes']} minutes to secure your car.`,
      badge: approval ? { text: 'Request received', tone: 'info' } : { text: 'Payment needed', tone: 'warn' },
      title: approval ? 'Your booking request is in' : 'Almost there: pay to confirm',
      greeting: greet(x),
      intro: [approval
        ? "Thanks for your booking request. We'll review it and email you as soon as it's confirmed. You'll be asked to pay securely in the app once it is. Nothing has been charged yet."
        : `Thanks for your booking. We're holding the car for ${x.settings['booking.holdMinutes']} minutes. Open the app and pay to confirm it.`],
      sections: bookingSections(x),
      steps: approval ? { heading: 'What happens next', items: ['We check the car and the date for you.', "You get an email when it's approved, with the amount to pay.", 'Pay in the app (My Bookings, then Pay now) and your booking is confirmed.'] } : undefined,
      cta: appCta(x.settings, approval ? 'View my request' : 'Pay now'),
    };
  },

  booking_awaiting_payment: (x) => {
    const due = Math.max(0, x.booking.deposit_due_pence - net(x));
    return {
      subject: `Your booking is approved: payment needed (${x.booking.ref})`,
      preheader: `Pay ${gbp(due)} within ${x.settings['booking.holdMinutes']} minutes to confirm your booking.`,
      badge: { text: 'Approved', tone: 'success' },
      title: 'Good news: your booking is approved',
      greeting: greet(x),
      intro: [`To confirm it, please pay ${gbp(due)} in the app (My Bookings, then Pay now). We're holding the car for ${x.settings['booking.holdMinutes']} minutes; after that it may be released to someone else.`],
      highlight: { label: due < x.booking.total_pence ? 'Deposit to pay now' : 'Amount to pay', value: gbp(due), note: `Held for ${x.settings['booking.holdMinutes']} minutes` },
      cta: appCta(x.settings, 'Pay now'),
      sections: bookingSections(x),
    };
  },

  booking_confirmed: (x) => {
    const tz = x.settings['booking.timezone'];
    const first = live(x)[0];
    return {
      subject: `Your booking is confirmed (${x.booking.ref})`,
      preheader: `See you ${first ? shortDate(first.start_at, tz) : 'soon'}! Your supercar experience is booked.`,
      badge: { text: 'Confirmed', tone: 'success' },
      title: "You're booked! Get ready to shine ⭐",
      greeting: greet(x),
      intro: ['Good news: your booking is confirmed. Here are your details. Keep this email handy for the day.'],
      sections: [...bookingSections(x), paymentSection(x)],
      callout: owed(x) > 0
        ? { tone: 'warn', title: 'Balance to pay', text: `A balance of ${gbp(owed(x))} is still to pay. You can pay it in the app under My Bookings.` }
        : { tone: 'success', title: 'Paid in full', text: 'Nothing further to pay. Your receipts are in the app under My Bookings.' },
      steps: { heading: 'Before the big day', items: [
        live(x).some((i) => i.experience === 'delivered') ? "We'll bring the car to the address above. Please make sure there's safe space to park it." : "We'll send you the exact address and arrival details before your booking.",
        'Arrive or be ready 10 minutes early so you get every minute of your time.',
        "Bring your camera: photos with the car are welcome!",
      ] },
      cta: appCta(x.settings),
      outro: [cancellationPolicy(x.settings)],
    };
  },

  booking_reminder: (x) => {
    const tz = x.settings['booking.timezone'];
    const first = live(x)[0] ?? x.items[0];
    return {
      subject: `See you tomorrow: ${x.booking.vehicle} at ${DateTime.fromJSDate(first.start_at, { zone: tz }).toFormat('HH:mm')} (${x.booking.ref})`,
      preheader: 'A quick reminder of your Supercarstars booking.',
      badge: { text: 'Coming up', tone: 'gold' },
      title: 'Your supercar day is almost here',
      greeting: greet(x),
      intro: ["Just a reminder that your booking is coming up. Here's everything you need."],
      highlight: { label: 'Starts', value: DateTime.fromJSDate(first.start_at, { zone: tz }).toFormat('HH:mm'), note: DateTime.fromJSDate(first.start_at, { zone: tz }).toFormat('cccc d LLLL yyyy') },
      sections: [...bookingSections(x), ...(owed(x) > 0 ? [paymentSection(x)] : [])],
      callout: owed(x) > 0 ? { tone: 'warn', title: 'Balance due', text: `Please pay the remaining ${gbp(owed(x))} in the app before your booking starts.` } : undefined,
      steps: { heading: 'Quick checklist', items: ['Be ready 10 minutes before the start time.', 'Comfortable clothes and flat shoes are best.', `Running late or need help? ${x.settings['company.supportPhone'] ? `Call us on ${x.settings['company.supportPhone']}.` : 'Reply to this email.'}`] },
      cta: appCta(x.settings),
    };
  },

  booking_completed: (x) => ({
    subject: `Thanks for riding with ${x.settings['company.name']} (${x.booking.ref})`,
    preheader: 'We hope it was a day to remember.',
    badge: { text: 'Completed', tone: 'success' },
    title: 'Thanks for a star day! ⭐',
    greeting: greet(x),
    intro: [
      `Your booking with the ${x.booking.vehicle} is complete. We hope everyone had an unforgettable time.`,
      "We'd love to hear how it went. Just reply to this email: your feedback helps us make every experience even better.",
    ],
    sections: [{ heading: 'Booking summary', rows: [['Booking reference', x.booking.ref], ['Car', x.booking.vehicle], ...(x.booking.event ? [['Occasion', x.booking.event] as Row] : []), ['Date', when(x.booking, x.settings['booking.timezone'])]] }, paymentSection(x)],
    callout: owed(x) > 0
      ? { tone: 'warn', title: 'Balance to pay', text: `A balance of ${gbp(owed(x))} is still outstanding. You can pay it in the app under My Bookings.` }
      : { tone: 'success', text: 'Everything is paid. Your receipts are in the app under My Bookings.' },
    cta: x.settings['company.websiteUrl'] ? { label: 'Book your next experience', url: x.settings['company.websiteUrl'] } : null,
    outro: ['Birthdays, proms, weddings or just because: we can’t wait to see you again.'],
  }),

  booking_rejected: (x) => ({
    subject: `About your booking request (${x.booking.ref})`,
    preheader: "Sorry, we couldn't accept this booking.",
    badge: { text: 'Not available', tone: 'danger' },
    title: "Sorry, we can't take this booking",
    greeting: greet(x),
    intro: [
      `Unfortunately we're unable to accept your request for the ${x.booking.vehicle} on ${when(x.booking, x.settings['booking.timezone'])}.`,
      net(x) > 0 ? "Our team will refund what you've paid and confirm it separately." : 'Nothing has been charged.',
      'Another date or car may well be free. Have a look in the app, or get in touch and we’ll help you find the perfect alternative.',
    ],
    cta: appCta(x.settings, 'Find another date'),
  }),

  booking_cancellation_requested: (x) => ({
    subject: `We've received your cancellation request (${x.booking.ref})`,
    preheader: "Our team will review it and confirm shortly.",
    badge: { text: 'Cancellation requested', tone: 'warn' },
    title: "We've got your cancellation request",
    greeting: greet(x),
    intro: [`We've received your request to cancel booking ${x.booking.ref}. Our team will review it and email you once it's done, including any refund you're due.`],
    sections: bookingSections(x),
    outro: [cancellationPolicy(x.settings).replace('Plans changed? You can request a cancellation in the app. ', 'Our policy: ')],
  }),

  booking_cancelled: (x) => ({
    subject: `Your booking ${x.booking.ref} has been cancelled`,
    preheader: net(x) > 0 ? "We'll confirm any refund separately." : 'Nothing was charged for this booking.',
    badge: { text: 'Cancelled', tone: 'danger' },
    title: 'Your booking has been cancelled',
    greeting: greet(x),
    intro: [`Your booking ${x.booking.ref} for the ${x.booking.vehicle} on ${when(x.booking, x.settings['booking.timezone'])} has been cancelled.`],
    callout: { tone: 'info', text: net(x) > 0 ? "Our team will arrange any refund you're due and confirm it separately." : 'Nothing was charged for this booking.' },
    outro: ["We'd love to see you another time. You can make a new booking in the app whenever you're ready."],
    cta: appCta(x.settings, 'Make a new booking'),
  }),

  payment_received: (x) => {
    const amount = Number(x.payload.amountPence ?? 0);
    const r = x.receipt;
    // Figures as they stood right after this payment (frozen on its receipt), not when the email happens to be sent.
    const total = r?.data?.bookingTotalPence ?? x.booking.total_pence;
    const paid = r?.data?.paidToDatePence ?? net(x);
    const left = r?.data?.balancePence ?? owed(x);
    const paidInFull = left === 0;
    const docName = r ? DOC_TITLES[r.kind].toLowerCase() : '';
    if (paidInFull) {
      // Paid in full: the invoice email. The final receipt (the paid invoice) is attached.
      return {
        subject: `Payment verified: paid in full${r ? `. Your invoice ${r.number}` : ''} (${x.booking.ref})`,
        preheader: `Thank you! Booking ${x.booking.ref} is fully paid${r ? `; invoice ${r.number} attached` : ''}.`,
        badge: { text: 'Paid in full', tone: 'success' },
        title: 'Paid in full. Thank you!',
        greeting: greet(x),
        intro: [
          `We've received and verified your payment${amount ? ` of ${gbp(amount)}` : ''}. Thank you.`,
          ...(r ? [`Your invoice (${docName} ${r.number}) is attached. Open it in a browser to print it or save it as a PDF.`] : []),
        ],
        highlight: { label: 'Total paid', value: gbp(paid), note: r ? `Invoice ${r.number}` : `Booking ${x.booking.ref}` },
        sections: [
          ...bookingSections(x),
          { heading: 'Invoice summary', rows: [
            ...(r ? [['Invoice number', r.number] as Row, ['Issued', DateTime.fromJSDate(new Date(r.issued_at), { zone: x.settings['booking.timezone'] }).toFormat('d LLL yyyy, HH:mm')] as Row] : []),
            ['This payment', gbp(amount)],
            [`Paid so far`, `${gbp(paid)} of ${gbp(total)}`],
          ], total: ['Balance', gbp(0)] },
        ],
        callout: { tone: 'success', text: 'Nothing further to pay.' },
        cta: appCta(x.settings),
      };
    }
    return {
      subject: `Payment verified for ${x.booking.ref}${r ? ` (receipt ${r.number})` : ''}`,
      preheader: `We've received ${gbp(amount)}. ${gbp(left)} left to pay.`,
      badge: { text: 'Payment received', tone: 'success' },
      title: 'Payment received',
      greeting: greet(x),
      intro: [
        `We've received and verified your payment${amount ? ` of ${gbp(amount)}` : ''}. Thank you.`,
        ...(r ? [`Your ${docName} ${r.number} is attached. Open it in a browser to print it or save it as a PDF.`] : []),
      ],
      sections: [...bookingSections(x), { heading: 'Payment', rows: [['This payment', gbp(amount)], ['Paid so far', `${gbp(paid)} of ${gbp(total)}`]], total: ['Still to pay', gbp(left)] }],
      callout: { tone: 'warn', text: `Still to pay: ${gbp(left)}. You can pay it in the app under My Bookings.` },
      cta: appCta(x.settings, 'Pay the balance'),
    };
  },

  payment_failed: (x) => ({
    subject: `Your payment didn't go through (${x.booking.ref})`,
    preheader: 'Please try again or use another card to keep your booking.',
    badge: { text: 'Payment failed', tone: 'danger' },
    title: "Your payment didn't go through",
    greeting: greet(x),
    intro: [
      "We couldn't take your payment. No money has been taken for this attempt.",
      "Please try again in the app (My Bookings, then Pay now), or use another card. If it keeps failing, your bank may need to approve the payment.",
    ],
    sections: bookingSections(x),
    cta: appCta(x.settings, 'Try again'),
  }),

  refund: (x) => {
    const amount = Number(x.payload.amountPence ?? 0);
    return {
      subject: `Refund issued for ${x.booking.ref}`,
      preheader: `${amount ? gbp(amount) + ' is' : 'Your refund is'} on its way back to you.`,
      badge: { text: 'Refund issued', tone: 'info' },
      title: 'Your refund is on its way',
      greeting: greet(x),
      intro: [`We've issued a refund${amount ? ` of ${gbp(amount)}` : ''} for booking ${x.booking.ref}. Card refunds usually take 5 to 10 working days to appear, depending on your bank.`],
      ...(amount ? { highlight: { label: 'Refund amount', value: gbp(amount) } } : {}),
      sections: [{ heading: 'Refund', rows: [['Booking reference', x.booking.ref], ['Refunded in total', gbp(x.booking.refunded_pence)]] }],
    };
  },

  charge_confirmed: (x) => {
    const amount = Number(x.payload.amountPence ?? 0);
    const previous = x.payload.previousPence == null ? null : Number(x.payload.previousPence);
    return {
      subject: `Your booking total has been updated (${x.booking.ref})`,
      preheader: `New total: ${gbp(x.booking.total_pence)}.`,
      badge: { text: 'Total updated', tone: 'info' },
      title: 'Your booking total has changed',
      greeting: greet(x),
      intro: [previous != null ? `We've updated a charge on your booking from ${gbp(previous)} to ${gbp(amount)}.` : `We've confirmed a charge of ${gbp(amount)} on your booking.`],
      sections: [{ heading: 'Your booking', rows: [['Booking reference', x.booking.ref], ['New booking total', gbp(x.booking.total_pence)], ['Paid so far', gbp(net(x))]], total: ['Still to pay', gbp(owed(x))] }],
      callout: owed(x) > 0 ? { tone: 'warn', text: `Still to pay: ${gbp(owed(x))}. You can pay it in the app under My Bookings.` } : { tone: 'success', text: 'Nothing further to pay.' },
      cta: owed(x) > 0 ? appCta(x.settings, 'Pay now') : null,
    };
  },

  charge_removed: (x) => ({
    subject: `A charge was removed from your booking (${x.booking.ref})`,
    preheader: `New total: ${gbp(x.booking.total_pence)}.`,
    badge: { text: 'Total updated', tone: 'info' },
    title: 'A charge was removed',
    greeting: greet(x),
    intro: [`We've removed ${String(x.payload.body ?? 'a charge')} from your booking.`],
    sections: [{ heading: 'Your booking', rows: [['Booking reference', x.booking.ref], ['New booking total', gbp(x.booking.total_pence)], ['Paid so far', gbp(net(x))]], total: ['Still to pay', gbp(owed(x))] }],
    callout: { tone: 'info', text: owed(x) > 0 ? `Still to pay: ${gbp(owed(x))}.` : 'Nothing further to pay. If you have paid more than the new total, our team will arrange a refund.' },
  }),

  extension_rejected: (x) => ({
    subject: `About your extension request (${x.booking.ref})`,
    preheader: "Your booking is unchanged.",
    badge: { text: 'Extension', tone: 'warn' },
    title: "We can't extend this time",
    greeting: greet(x),
    intro: ["Sorry, we can't extend your booking this time.", ...(x.payload.body ? [String(x.payload.body)] : [])],
    sections: bookingSections(x, 'Your booking is unchanged'),
  }),
};

/** A change to the booking (new time, car, driver, extension...): the notification's own wording plus the current details. */
const bookingUpdate = (fallback: string, label: string): Template => (x) => {
  const title = String(x.payload.title ?? fallback);
  return {
    subject: `${title} (${x.booking.ref})`,
    preheader: `There's an update to booking ${x.booking.ref}.`,
    badge: { text: label, tone: 'info' },
    title,
    greeting: greet(x),
    intro: [`There's an update to your booking: ${title.toLowerCase()}.`, ...(x.payload.body ? [String(x.payload.body)] : [])],
    sections: bookingSections(x, 'Your booking now'),
    cta: appCta(x.settings),
  };
};
CUSTOMER.rescheduled = bookingUpdate('Booking rescheduled', 'New time');
CUSTOMER.vehicle_changed = bookingUpdate('Your car has changed', 'Car changed');
CUSTOMER.vehicle_added = bookingUpdate('A car was added to your booking', 'Car added');
CUSTOMER.booking_extended = bookingUpdate('Booking extended', 'Extended');
CUSTOMER.driver_assigned = bookingUpdate('Driver assigned', 'Driver');

/* ---------- owner templates ---------- */

/** Everything the company needs about the booking, on one page. */
function ownerSheet(x: Ctx): EmailSection[] {
  const tz = x.settings['booking.timezone'];
  const o = x.order;
  const customer: EmailSection = { heading: 'Customer', rows: [
    ['Name', x.customer.name], ['Email', x.customer.email], ['Phone', x.customer.phone || 'Not given'],
    ['Booked via', o.source === 'admin' ? 'Dashboard (staff)' : 'Customer app'], ['Booked on', DateTime.fromJSDate(o.created_at, { zone: tz }).toFormat('d LLL yyyy, HH:mm')],
  ] };
  const cars = x.items.map((i): EmailSection => ({
    heading: `${i.vehicle}${i.year ? ` (${i.year})` : ''} · ${i.ref}`,
    rows: [
      ['Status', label(i.status)],
      ['When', when(i, tz)],
      ['Where', where(i, true)],
      ['Driver', driverLine(i, true)],
      ...(i.event ? [['Event', i.event] as Row] : []),
      ...(i.occasion ? [['Occasion', i.occasion] as Row] : []),
      ...(i.children != null ? [['Children', String(i.children)] as Row] : []),
      ...(i.customer_notes ? [['Customer notes', i.customer_notes] as Row] : []),
      ...(i.admin_notes ? [['Staff notes', i.admin_notes] as Row] : []),
    ],
  }));
  const price: Row[] = [];
  const counted = live(x);
  for (const i of counted) for (const l of (i.pricing_snapshot?.lines ?? []) as { label: string; amountPence: number }[]) price.push([counted.length > 1 ? `${l.label} (${i.ref})` : l.label, gbp(l.amountPence)]);
  if (o.discount_pence) price.push(['Discounts', gbp(-o.discount_pence)]);
  if (o.tax_pence) price.push([o.tax_label || 'Tax', gbp(o.tax_pence)]);
  if (o.fee_pence) price.push(['Service fee', gbp(o.fee_pence)]);
  for (const ch of x.charges) price.push([ch.description, gbp(ch.amount_pence)]);
  const money: EmailSection = { heading: 'Price', rows: price.length ? price : [['Subtotal', gbp(o.subtotal_pence)]], total: ['Booking total', gbp(o.total_pence)] };
  const pay: EmailSection = { heading: 'Payment', rows: [
    ['Payment status', label(o.payment_status)],
    ...(o.deposit_due_pence && o.deposit_due_pence < o.total_pence ? [['Deposit required', gbp(o.deposit_due_pence)] as Row] : []),
    ['Received', gbp(o.paid_pence)],
    ...(o.refunded_pence ? [['Refunded', gbp(o.refunded_pence)] as Row] : []),
  ], total: ['Balance due', gbp(owed(x))] };
  return [customer, ...cars, money, pay];
}

const label = (v: string) => v.charAt(0).toUpperCase() + v.slice(1).replace(/_/g, ' ');
const dashCta = (s: Settings) => (s['company.dashboardUrl'] ? { label: 'Open in dashboard', url: s['company.dashboardUrl'] } : null);
const firstStart = (x: Ctx) => shortDate((live(x)[0] ?? x.items[0]).start_at, x.settings['booking.timezone']);

const ownerAlert = (o: { subject: (x: Ctx) => string; title: string; badge: EmailContent['badge']; intro: (x: Ctx) => string[]; callout?: (x: Ctx) => EmailContent['callout'] }): Template =>
  (x) => ({
    audience: 'owner',
    subject: o.subject(x),
    preheader: `${x.customer.name} · ${x.booking.vehicle} · ${firstStart(x)}`,
    badge: o.badge, title: o.title, intro: o.intro(x),
    callout: o.callout?.(x),
    cta: dashCta(x.settings),
    sections: ownerSheet(x),
  });

const OWNER: Record<string, Template> = {
  booking_received: ownerAlert({
    subject: (x) => x.settings['booking.requireApproval'] ? `New booking request to approve: ${x.booking.ref} · ${firstStart(x)}` : `New booking (awaiting payment): ${x.booking.ref} · ${firstStart(x)}`,
    title: 'New booking request',
    badge: { text: 'New', tone: 'gold' },
    intro: (x) => [`${x.customer.name} has requested the ${x.booking.vehicle} for ${when(x.booking, x.settings['booking.timezone'])}.`],
    callout: (x) => x.settings['booking.requireApproval']
      ? { tone: 'warn', title: 'Action needed', text: `Approve or decline it in the dashboard.${x.settings['booking.pendingHoldHours'] ? ` Unapproved requests are released after ${x.settings['booking.pendingHoldHours']} hours.` : ''}` }
      : { tone: 'info', text: `The customer has ${x.settings['booking.holdMinutes']} minutes to pay before the car is released.` },
  }),
  booking_confirmed: ownerAlert({
    subject: (x) => `Booking confirmed: ${x.booking.ref} · ${x.booking.vehicle} · ${firstStart(x)}`,
    title: 'Booking confirmed',
    badge: { text: 'Confirmed', tone: 'success' },
    intro: (x) => [`Booking ${x.booking.ref} for ${x.customer.name} is confirmed. Full details are below.`],
    callout: (x) => {
      const needsDriver = live(x).some((i) => i.driver_option === 'with_driver' && !i.driver_name);
      return needsDriver ? { tone: 'warn', title: 'To do', text: 'Assign a driver to this booking.' }
        : owed(x) > 0 ? { tone: 'info', text: `${gbp(owed(x))} is still to be paid by the customer.` } : { tone: 'success', text: 'Paid in full.' };
    },
  }),
  booking_cancellation_requested: ownerAlert({
    subject: (x) => `Cancellation requested: ${x.booking.ref} · ${firstStart(x)}`,
    title: 'Cancellation requested',
    badge: { text: 'Action needed', tone: 'warn' },
    intro: (x) => [`${x.customer.name} has asked to cancel booking ${x.booking.ref}.`],
    callout: (x) => ({ tone: 'warn', title: 'Action needed', text: `Review it in the dashboard: cancel (and refund under the policy) or keep the booking. ${gbp(net(x))} has been paid.` }),
  }),
  booking_cancelled: ownerAlert({
    subject: (x) => `Booking cancelled: ${x.booking.ref} · ${firstStart(x)}`,
    title: 'Booking cancelled',
    badge: { text: 'Cancelled', tone: 'danger' },
    intro: (x) => [`Booking ${x.booking.ref} for ${x.customer.name} has been cancelled and the car is free again.`],
    callout: (x) => (net(x) > 0 ? { tone: 'warn', title: 'Refund check', text: `${gbp(net(x))} is still held for this booking. Refund whatever the customer is due.` } : undefined),
  }),
  extension_requested: ownerAlert({
    subject: (x) => `Extension requested: ${x.booking.ref}`,
    title: 'Extension requested',
    badge: { text: 'Action needed', tone: 'warn' },
    intro: (x) => [String(x.payload.title ?? 'The customer has asked to extend their booking.'), ...(x.payload.body ? [String(x.payload.body)] : [])],
    callout: () => ({ tone: 'warn', text: 'Approve or decline the extension in the dashboard.' }),
  }),
};
/** Money problems staff must act on: the notification's own title and text, plus the booking sheet. */
for (const k of ['overpaid', 'payment_after_release', 'payment_mismatch']) {
  OWNER[k] = ownerAlert({
    subject: (x) => `${String(x.payload.title ?? 'Payment needs attention')} (${x.booking.ref})`,
    title: 'Payment needs attention',
    badge: { text: 'Action needed', tone: 'danger' },
    intro: (x) => [String(x.payload.title ?? ''), ...(x.payload.body ? [String(x.payload.body)] : [])].filter(Boolean),
  });
}

export const CUSTOMER_TEMPLATE_KINDS = Object.keys(CUSTOMER);
export const OWNER_TEMPLATE_KINDS = Object.keys(OWNER);

/** Who the owner emails go to: Settings > "Owner notification emails", or the support address if that's blank. */
export const ownerRecipients = (s: Settings) =>
  (s['notifications.ownerEmails'] || s['company.supportEmail']).split(/[,;\s]+/).map((e) => e.trim()).filter((e) => /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(e));

/* ---------- loading and sending ---------- */

/** Everything a template needs, for the booking a queued email is about. Exported for previews and tests. */
export async function loadContext(bookingId: string, settings: Settings, payload: Record<string, unknown>, receipt: Receipt | null): Promise<Ctx | null> {
  const a = (await pool.query(
    `SELECT b.order_id, b.ref AS item_ref, b.start_at, b.end_at, b.hours, b.experience, b.address, b.pickup_address, b.dropoff_address, b.status, b.driver_option,
            o.ref, o.source, o.created_at AS order_created_at, o.subtotal_pence, o.discount_pence, o.tax_pence, o.fee_pence, o.tax_label, o.payment_status, o.pricing_snapshot AS order_snapshot,
            o.total_pence, o.paid_pence, o.refunded_pence, o.deposit_due_pence,
            v.make || ' ' || v.model AS vehicle_name, e.title AS event, c.name AS customer_name, c.email AS customer_email, c.phone AS customer_phone
       FROM bookings b JOIN orders o ON o.id=b.order_id JOIN customers c ON c.id=o.customer_id JOIN vehicles v ON v.id=b.vehicle_id
       LEFT JOIN event_types e ON e.id=b.event_type_id WHERE b.id=$1`, [bookingId])).rows[0];
  if (!a) return null;
  const items: Item[] = (await pool.query(
    `SELECT b.id, b.ref, b.status, b.start_at, b.end_at, b.hours, b.experience, b.address, b.pickup_address, b.dropoff_address, b.driver_option,
            b.children, b.occasion, b.customer_notes, b.admin_notes, b.pricing_snapshot, v.make || ' ' || v.model AS vehicle, v.year, e.title AS event,
            dr.full_name AS driver_name, dr.phone AS driver_phone
       FROM bookings b JOIN vehicles v ON v.id=b.vehicle_id LEFT JOIN event_types e ON e.id=b.event_type_id
       LEFT JOIN LATERAL (SELECT d.full_name, d.phone FROM driver_assignments da JOIN drivers d ON d.id=da.driver_id WHERE da.booking_id=b.id AND da.active LIMIT 1) dr ON true
      WHERE b.order_id=$1 ORDER BY b.start_at, b.ref`, [a.order_id])).rows;
  const charges = (await pool.query(`SELECT description, amount_pence FROM booking_charges WHERE order_id=$1 AND status='confirmed' ORDER BY created_at`, [a.order_id])).rows;
  const others = items.filter((i) => !['cancelled', 'rejected'].includes(i.status)).length - 1;
  const booking: Booking = {
    ref: a.ref, item_ref: a.item_ref, start_at: a.start_at, end_at: a.end_at, hours: a.hours, experience: a.experience, address: a.address,
    pickup_address: a.pickup_address, dropoff_address: a.dropoff_address, status: a.status, driver_option: a.driver_option,
    total_pence: a.total_pence, paid_pence: a.paid_pence, refunded_pence: a.refunded_pence, deposit_due_pence: a.deposit_due_pence,
    vehicle: a.vehicle_name + (others > 0 ? ` and ${others} more` : ''), event: a.event,
  };
  const order: Order = {
    id: a.order_id, ref: a.ref, source: a.source, created_at: a.order_created_at, subtotal_pence: a.subtotal_pence, discount_pence: a.discount_pence,
    tax_pence: a.tax_pence, fee_pence: a.fee_pence, tax_label: a.tax_label, payment_status: a.payment_status, pricing_snapshot: a.order_snapshot,
    total_pence: a.total_pence, paid_pence: a.paid_pence, refunded_pence: a.refunded_pence, deposit_due_pence: a.deposit_due_pence,
  };
  return {
    first: String(a.customer_name).split(' ')[0], customer: { name: a.customer_name, email: a.customer_email, phone: a.customer_phone },
    booking, order, items, charges, settings, payload, receipt,
  };
}

/** Builds the message for one queued email, or null when there is no template for it. Exported for previews. */
export function buildBookingEmail(kind: string, recipient: 'customer' | 'owner', x: Ctx) {
  const t = (recipient === 'owner' ? OWNER : CUSTOMER)[kind];
  return t ? renderEmail({ audience: recipient, ...t(x) }, x.settings) : null;
}

export type OutboxResult = { sent: number; retrying: number; failed: number; skipped: number };

/**
 * Sends due emails. Safe to run on several instances at once (rows are claimed with SKIP LOCKED) and
 * to run repeatedly. Failures retry with growing delays, then stop at MAX_ATTEMPTS.
 */
export async function processOutbox(limit = 10): Promise<OutboxResult> {
  const out: OutboxResult = { sent: 0, retrying: 0, failed: 0, skipped: 0 };
  const rows = (await pool.query(
    `UPDATE email_outbox SET status='sending', attempts = attempts + 1, locked_at = now()
      WHERE id IN (SELECT id FROM email_outbox
                    WHERE (status='pending' AND next_attempt_at <= now()) OR (status='sending' AND locked_at < now() - interval '5 minutes')
                    ORDER BY created_at LIMIT $1 FOR UPDATE SKIP LOCKED)
      RETURNING *`, [limit])).rows;
  if (!rows.length) return out;
  const settings = await getSettings();

  for (const r of rows) {
    const finish = (status: string, error: string | null = null, delayMin = 0) =>
      pool.query(
        `UPDATE email_outbox SET status=$2, last_error=$3, locked_at=NULL, sent_at = CASE WHEN $2='sent' THEN now() ELSE sent_at END,
                next_attempt_at = now() + ($4 || ' minutes')::interval WHERE id=$1`, [r.id, status, error, String(delayMin)]);
    try {
      const recipient: 'customer' | 'owner' = r.recipient === 'owner' ? 'owner' : 'customer';
      const to = recipient === 'owner'
        ? ownerRecipients(settings).join(', ')
        : (await pool.query('SELECT email FROM customers WHERE id=$1', [r.customer_id])).rows[0]?.email;
      // A payment email carries its receipt (issued in the same transaction as the payment).
      const receipt: Receipt | null = recipient === 'customer' && r.kind === 'payment_received' && r.payload?.paymentId
        ? (await pool.query('SELECT number, kind, issued_at, amount_pence, data FROM invoices WHERE payment_id=$1', [r.payload.paymentId])).rows[0] ?? null
        : null;
      const x = r.booking_id ? await loadContext(r.booking_id, settings, r.payload ?? {}, receipt) : null;
      const t = x ? buildBookingEmail(r.kind, recipient, x) : null;
      // Bookings staff make in the dashboard don't need a "new booking" alert to the same staff.
      if (recipient === 'owner' && r.kind === 'booking_received' && x?.order.source === 'admin') {
        await finish('skipped', 'created by staff');
        out.skipped++;
        continue;
      }
      if (!to || !x || !t) {
        await finish('skipped', !to ? (recipient === 'owner' ? 'no owner email configured' : 'missing customer') : 'missing booking or template');
        out.skipped++;
        continue;
      }
      const mail: Mail = {
        to, subject: t.subject, text: t.text, html: t.html, inline: t.inline,
        attachments: receipt ? [{ filename: `${receipt.number}.html`, content: renderDocument(receipt), contentType: 'text/html; charset=utf-8' }] : undefined,
      };
      const res = await getMailer().send(mail);
      if (res.sent) {
        await finish('sent');
        out.sent++;
      } else if (res.reason === 'no_mail_provider_configured') {
        // Not sending stale mail later if a provider is configured: record it plainly instead.
        await finish('skipped', 'no mail provider configured');
        out.skipped++;
      } else if (r.attempts >= MAX_ATTEMPTS) {
        await finish('failed', res.reason ?? 'send failed');
        out.failed++;
      } else {
        await finish('pending', res.reason ?? 'send failed', r.attempts * 5);
        out.retrying++;
      }
    } catch (e) {
      const msg = (e as Error).message;
      if (r.attempts >= MAX_ATTEMPTS) { await finish('failed', msg); out.failed++; } else { await finish('pending', msg, r.attempts * 5); out.retrying++; }
    }
  }
  return out;
}
