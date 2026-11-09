import PDFDocument from 'pdfkit';
import { DateTime } from 'luxon';
import { gbp } from './finance.js';
import { logoBytes } from '../notifications/layout.js';
import { DOC_TITLES, type DocKind } from './documents.js';

/*
 * Receipts and notes as PDF files: attached to the receipt email and downloaded from the app. Drawn from the same
 * frozen data as the HTML version (invoices.data), so the PDF always matches what was issued. Uses pdfkit's built-in
 * Helvetica, so no fonts or browser are needed on the server.
 */

type Doc = { number: string; kind: DocKind; issued_at: Date | string; amount_pence: number; data: any };

const INK = '#15161a';
const MUTE = '#5b5e66';
const LINE = '#e6e7ea';
const GOLD = '#ffc41f';
const PAGE_W = 595.28; // A4
const M = 48; // margin
const W = PAGE_W - M * 2;

const fmt = (iso: string | Date, tz: string, f = 'd LLL yyyy, HH:mm') => DateTime.fromJSDate(new Date(iso)).setZone(tz || 'Europe/London').toFormat(f);
const days = (h: number) => (h >= 24 && h % 24 === 0 ? `${h / 24} ${h === 24 ? 'day' : 'days'}` : `${h} h`);

export function renderDocumentPdf(doc: Doc): Promise<Buffer> {
  const d = doc.data ?? {};
  const t = d.transaction ?? {};
  const tz = d.timezone ?? 'Europe/London';
  const title = DOC_TITLES[doc.kind] ?? 'Receipt';
  const pdf = new PDFDocument({ size: 'A4', margin: M, info: { Title: `${title} ${doc.number}`, Author: d.business?.name ?? 'Supercarstars' } });
  const chunks: Buffer[] = [];
  pdf.on('data', (c: Buffer) => chunks.push(c));
  const done = new Promise<Buffer>((resolve, reject) => {
    pdf.on('end', () => resolve(Buffer.concat(chunks)));
    pdf.on('error', reject);
  });

  const ensure = (h: number) => { if (pdf.y + h > pdf.page.height - M) pdf.addPage(); };
  const heading = (s: string) => {
    ensure(40);
    pdf.moveDown(0.8).font('Helvetica-Bold').fontSize(12).fillColor(INK).text(s, M, pdf.y, { width: W });
    pdf.moveDown(0.3);
  };
  /** A label on the left and an amount on the right, with a rule under it. */
  const row = (label: string, value: string, strong = false) => {
    const font = strong ? 'Helvetica-Bold' : 'Helvetica';
    pdf.font(font).fontSize(10);
    const VW = 230; // value column
    const h = Math.max(pdf.heightOfString(label, { width: W - VW - 10 }), pdf.heightOfString(value, { width: VW }), 12);
    ensure(h + 8);
    const y = pdf.y;
    if (strong) pdf.moveTo(M, y - 2).lineTo(M + W, y - 2).lineWidth(1.2).strokeColor(INK).stroke();
    pdf.fillColor(INK).text(label, M, y + 3, { width: W - VW - 10 });
    pdf.text(value, M + W - VW, y + 3, { width: VW, align: 'right' });
    pdf.x = M;
    const end = y + h + 6;
    pdf.moveTo(M, end).lineTo(M + W, end).lineWidth(0.5).strokeColor(LINE).stroke();
    pdf.y = end + 1;
  };
  const small = (s: string, color = MUTE) => pdf.font('Helvetica').fontSize(9).fillColor(color).text(s, M, pdf.y, { width: W });

  // Brand bar: black with the logo, gold rule underneath.
  const logo = logoBytes();
  pdf.rect(M, M, W, 78).fill('#000000');
  if (logo) pdf.image(logo, M + (W - 110) / 2, M + 6, { fit: [110, 66], align: 'center', valign: 'center' });
  else pdf.font('Helvetica-BoldOblique').fontSize(20).fillColor(GOLD).text(d.business?.name ?? 'Supercarstars', M, M + 28, { width: W, align: 'center' });
  pdf.rect(M, M + 78, W, 4).fill(GOLD);
  pdf.y = M + 98;

  // Title and number on the left, business details on the right.
  const top = pdf.y;
  pdf.font('Helvetica-Bold').fontSize(20).fillColor(INK).text(title, M, top, { width: W / 2 });
  pdf.font('Helvetica-Bold').fontSize(11).text(`No. ${doc.number}`, { width: W / 2 });
  small(`Issued ${fmt(doc.issued_at, tz)}`);
  const leftEnd = pdf.y;
  const biz = d.business ?? {};
  pdf.y = top;
  pdf.font('Helvetica-Bold').fontSize(11).fillColor(INK).text(biz.name ?? '', M + W / 2, top, { width: W / 2, align: 'right' });
  for (const line of [biz.address, biz.email, biz.phone, biz.vatNumber ? `VAT ${biz.vatNumber}` : null].filter(Boolean)) {
    pdf.font('Helvetica').fontSize(9).fillColor(MUTE).text(String(line), M + W / 2, pdf.y, { width: W / 2, align: 'right' });
  }
  pdf.y = Math.max(leftEnd, pdf.y) + 8;
  pdf.moveTo(M, pdf.y).lineTo(M + W, pdf.y).lineWidth(2).strokeColor(GOLD).stroke();
  pdf.y += 6;

  // Billed to.
  heading('Billed to');
  pdf.font('Helvetica').fontSize(10).fillColor(INK).text(d.customer?.name ?? '', { width: W });
  small([d.customer?.email, d.customer?.phone].filter(Boolean).join(' · '));

  // What was booked (orders list every vehicle; older documents had one booking).
  const items: any[] = d.items ?? (d.booking?.vehicle ? [{ ...d.booking, counted: true }] : []);
  heading(`Booking ${d.order?.ref ?? d.booking?.ref ?? ''}${items.length > 1 ? ` · ${items.length} vehicles` : ''}`);
  for (const it of items) {
    ensure(46);
    const where = it.pickupAddress ? `Pick-up ${it.pickupAddress}, drop-off ${it.dropoffAddress}` : it.collection === 'delivery' ? `Delivered to ${it.address}` : 'Collected from the showroom';
    pdf.font('Helvetica-Bold').fontSize(10).fillColor(INK).text(`${it.vehicle?.make ?? ''} ${it.vehicle?.model ?? ''}  (${it.ref})${it.counted === false ? '  · cancelled, not charged' : ''}`, { width: W });
    const end = it.hours >= 24 ? fmt(it.endAt, tz, 'cccc d LLLL yyyy, HH:mm') : fmt(it.endAt, tz, 'HH:mm');
    small(`${fmt(it.startAt, tz, 'cccc d LLLL yyyy, HH:mm')} to ${end} (${days(it.hours)})`);
    small(`${it.driverOption === 'with_driver' ? 'With driver' : 'Self-drive'} · ${where}${it.event ? ` · ${it.event}` : ''}`);
    pdf.moveDown(0.4);
  }

  // A short note for deposits, part payments, full payment and adjustments.
  const isPayment = ['deposit_receipt', 'payment_receipt', 'full_payment_receipt'].includes(doc.kind);
  const ref = d.booking?.ref ?? '';
  const note = doc.kind === 'deposit_receipt' || (doc.kind === 'payment_receipt' && d.balancePence > 0)
    ? `This receipt is for ${gbp(doc.amount_pence)} paid towards booking ${ref}. ${gbp(d.balancePence)} is still to pay.`
    : doc.kind === 'full_payment_receipt' ? `Booking ${ref} is now paid in full. Thank you.`
    : doc.kind === 'adjustment_note' || doc.kind === 'credit_note'
      ? `${t.description ?? ''}${t.previousPence != null ? ` (was ${gbp(t.previousPence)}, now ${gbp(t.newPence)})` : ''}. The booking total is now ${gbp(d.bookingTotalPence)}.` : null;
  if (note) {
    ensure(44);
    pdf.moveDown(0.5);
    pdf.font('Helvetica').fontSize(10);
    const h = pdf.heightOfString(note, { width: W - 24 }) + 18;
    const y = pdf.y;
    pdf.roundedRect(M, y, W, h, 6).fillAndStroke('#fff8e1', '#f0d27a');
    pdf.fillColor(INK).text(note, M + 12, y + 9, { width: W - 24 });
    pdf.y = y + h;
  }

  // This transaction.
  heading('This transaction');
  row(isPayment ? 'Paid in this transaction' : doc.kind === 'refund_receipt' ? 'Refunded in this transaction' : 'Change to the booking total', gbp(doc.amount_pence), true);
  if (t.method) row('Payment method', String(t.method));
  if (t.reference) row('Reference', String(t.reference));
  if (t.paidAt) row(isPayment ? 'Payment date' : 'Date', fmt(t.paidAt, tz));
  if (t.status) row('Status', String(t.status));

  // Booking charges.
  heading('Booking charges');
  const counted = items.filter((i) => i.counted !== false);
  if (d.items) {
    for (const it of counted) {
      if (counted.length > 1) { ensure(18); pdf.font('Helvetica-Bold').fontSize(10).fillColor(INK).text(`${it.vehicle?.make} ${it.vehicle?.model} (${it.ref})`, M, pdf.y + 4, { width: W }); }
      for (const l of it.lines ?? []) row(l.label, gbp(l.amountPence));
    }
    row('Subtotal', gbp(d.subtotalPence ?? 0), true);
    for (const o of d.offers ?? []) row(`Discount: ${o.title}${o.code ? ` (${o.code})` : ''}`, gbp(-o.discountPence));
    if (d.tax?.enabled) {
      row(`Taxable amount${d.tax.policy === 'before_discount' ? ' (before discounts)' : ''}`, gbp(d.taxablePence ?? 0));
      row(`${d.tax.label} at ${(d.tax.rateBp / 100).toFixed(d.tax.rateBp % 100 ? 2 : 0)}%`, gbp(d.taxPence ?? 0));
    }
  } else {
    for (const l of d.lines ?? []) row(l.label, gbp(l.amountPence));
    if (d.discountPence) row(`Discount${d.offerTitle ? ` (${d.offerTitle})` : ''}`, gbp(-d.discountPence));
    if (d.vatPence) row('VAT', gbp(d.vatPence));
  }
  if (d.serviceFeePence) row('Service fee', gbp(d.serviceFeePence));
  for (const ch of d.charges ?? []) row(ch.description, gbp(ch.amountPence));
  row('Booking total', gbp(d.bookingTotalPence ?? 0), true);

  // Balance.
  heading('Balance');
  row('Booking total', gbp(d.bookingTotalPence ?? 0));
  row('Paid to date (after refunds)', gbp(d.paidToDatePence ?? 0));
  row('Outstanding balance', gbp(d.balancePence ?? 0), true);

  ensure(24);
  pdf.y += 10;
  small(`Amounts in ${String(d.currency ?? 'gbp').toUpperCase()}.${t.verified === false ? ' This payment was recorded by our staff.' : ''} Thank you for booking with ${biz.name ?? 'us'}.`);

  pdf.end();
  return done;
}

/** "RCT-1042.pdf" */
export const pdfFileName = (doc: Pick<Doc, 'number'>) => `${doc.number}.pdf`;
