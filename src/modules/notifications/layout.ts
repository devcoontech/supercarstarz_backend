import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Settings } from '../../core/settings.js';
import type { InlineImage } from '../../lib/mailer.js';

/*
 * The one branded layout every Supercarstars email uses: black header with the logo, a gold rule, a white card
 * with the message, and a dark footer with the company's contact details.
 *
 * Templates describe an email as data (EmailContent) and never write HTML themselves. renderEmail() turns that into
 * both a plain-text body and an HTML body, so the two always say the same thing. Everything is escaped here.
 *
 * Built for email clients, not browsers: tables for layout, inline styles, no web fonts or background images,
 * 600px wide, and a logo sent as an inline (cid:) attachment so it shows without the API being public.
 */

export type Tone = 'gold' | 'success' | 'info' | 'warn' | 'danger';
export type Row = [label: string, value: string];
export type EmailSection = { heading: string; rows: Row[]; total?: Row };
export type EmailContent = {
  subject: string;
  /** The grey preview line inbox lists show after the subject. */
  preheader: string;
  /** Small status pill above the title, e.g. "Confirmed". */
  badge?: { text: string; tone: Tone };
  title: string;
  /** "Hi Sam," (customers). Omitted for owner alerts. */
  greeting?: string;
  intro: string[];
  /** One big number or code in a dark box: an amount due, a reset code. */
  highlight?: { label: string; value: string; note?: string };
  sections?: EmailSection[];
  callout?: { tone: Tone; title?: string; text: string };
  /** A short checklist, e.g. "What happens next". */
  steps?: { heading: string; items: string[] };
  cta?: { label: string; url: string } | null;
  outro?: string[];
  audience?: 'customer' | 'owner';
};
export type RenderedEmail = { subject: string; text: string; html: string; inline: InlineImage[] };

/* Brand colours, from the dashboard theme (dashboard/src/styles.css). */
const C = {
  black: '#000000', ink: '#0b0c0f', panel: '#15161a', gold: '#ffc41f', goldDeep: '#e2a200', goldInk: '#1a1300', goldSoft: '#fff6d6',
  page: '#eef0f3', card: '#ffffff', text: '#15161a', dim: '#4a4d57', mute: '#7d808c', line: '#e6e7ea',
  good: '#1f9d63', goodSoft: '#e7f7ef', info: '#2f6fc0', infoSoft: '#e9f2fd', warn: '#b86e00', warnSoft: '#fff3df', bad: '#c9372c', badSoft: '#fdecea',
};
const TONE: Record<Tone, { fg: string; bg: string; border: string }> = {
  gold: { fg: C.goldInk, bg: C.goldSoft, border: C.gold },
  success: { fg: C.good, bg: C.goodSoft, border: C.good },
  info: { fg: C.info, bg: C.infoSoft, border: C.info },
  warn: { fg: C.warn, bg: C.warnSoft, border: '#f0a43a' },
  danger: { fg: C.bad, bg: C.badSoft, border: C.bad },
};
const FONT = `'Exo 2','Segoe UI',Helvetica,Arial,sans-serif`;

const LOGO_CID = 'logo@supercarstars';
const LOGO_PATH = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../assets/email/logo.jpg');
let logo: Buffer | null | undefined;
/** The logo file, read once. Missing file: the header falls back to the company name in gold. */
export function logoBytes(): Buffer | null {
  if (logo === undefined) {
    try { logo = fs.readFileSync(LOGO_PATH); } catch { logo = null; }
  }
  return logo;
}
/** For documents opened in a browser (receipts), where cid: images do not work. */
export const logoDataUri = () => { const b = logoBytes(); return b ? `data:image/jpeg;base64,${b.toString('base64')}` : null; };

export const esc = (v: unknown) => String(v ?? '').replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch]!);
const br = (v: string) => esc(v).replace(/\n/g, '<br>');
const safeUrl = (u: string) => (/^https?:\/\//i.test(u) ? u : '');

/* ---------- plain text ---------- */

function toText(c: EmailContent, s: Settings): string {
  const out: string[] = [];
  if (c.greeting) out.push(c.greeting, '');
  out.push(...c.intro.flatMap((p) => [p, '']));
  if (c.highlight) out.push(`${c.highlight.label}: ${c.highlight.value}`, ...(c.highlight.note ? [c.highlight.note] : []), '');
  for (const sec of c.sections ?? []) {
    out.push(`${sec.heading}:`, ...sec.rows.map(([l, v]) => `${l}: ${v}`), ...(sec.total ? [`${sec.total[0]}: ${sec.total[1]}`] : []), '');
  }
  if (c.callout) out.push(c.callout.title ? `${c.callout.title}: ${c.callout.text}` : c.callout.text, '');
  if (c.steps) out.push(`${c.steps.heading}:`, ...c.steps.items.map((i) => `- ${i}`), '');
  if (c.cta && safeUrl(c.cta.url)) out.push(`${c.cta.label}: ${c.cta.url}`, '');
  for (const p of c.outro ?? []) out.push(p, '');
  while (out.length && out[out.length - 1] === '') out.pop();
  const contact = [
    s['company.name'],
    ...(s['company.supportEmail'] ? [`Questions? ${s['company.supportEmail']}`] : []),
    ...(s['company.supportPhone'] ? [`Call us: ${s['company.supportPhone']}`] : []),
  ];
  return [...out, '', '', '—', ...contact].join('\n');
}

/* ---------- HTML ---------- */

const p = (text: string, extra = '') =>
  `<p style="margin:0 0 16px;font-family:${FONT};font-size:15px;line-height:24px;color:${C.dim};${extra}">${br(text)}</p>`;

function badge(b: NonNullable<EmailContent['badge']>) {
  const t = TONE[b.tone];
  return `<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin:0 0 14px"><tr>
    <td style="background:${t.bg};border:1px solid ${t.border};border-radius:999px;padding:5px 12px;font-family:${FONT};font-size:12px;font-weight:700;letter-spacing:.06em;text-transform:uppercase;color:${t.fg}">${esc(b.text)}</td></tr></table>`;
}

function highlight(h: NonNullable<EmailContent['highlight']>) {
  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin:4px 0 22px"><tr>
    <td align="center" style="background:${C.ink};border-radius:14px;padding:22px 16px;border-bottom:3px solid ${C.gold}">
      <div style="font-family:${FONT};font-size:12px;font-weight:700;letter-spacing:.12em;text-transform:uppercase;color:#b4b6bf">${esc(h.label)}</div>
      <div style="font-family:${FONT};font-size:34px;line-height:44px;font-weight:800;letter-spacing:.04em;color:${C.gold};margin-top:6px">${esc(h.value)}</div>
      ${h.note ? `<div style="font-family:${FONT};font-size:13px;line-height:20px;color:#b4b6bf;margin-top:6px">${br(h.note)}</div>` : ''}
    </td></tr></table>`;
}

function section(sec: EmailSection) {
  const rows = sec.rows.map(([l, v], i) => `<tr>
      <td valign="top" style="padding:10px 0;${i ? `border-top:1px solid ${C.line};` : ''}font-family:${FONT};font-size:13px;line-height:20px;color:${C.mute};width:38%">${esc(l)}</td>
      <td valign="top" align="right" style="padding:10px 0;${i ? `border-top:1px solid ${C.line};` : ''}font-family:${FONT};font-size:14px;line-height:20px;color:${C.text};font-weight:600">${br(v)}</td></tr>`).join('');
  const total = sec.total ? `<tr>
      <td style="padding:12px 0 2px;border-top:2px solid ${C.text};font-family:${FONT};font-size:14px;font-weight:800;color:${C.text}">${esc(sec.total[0])}</td>
      <td align="right" style="padding:12px 0 2px;border-top:2px solid ${C.text};font-family:${FONT};font-size:17px;font-weight:800;color:${C.text}">${esc(sec.total[1])}</td></tr>` : '';
  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin:0 0 20px"><tr><td style="border:1px solid ${C.line};border-radius:12px;padding:6px 18px 10px">
    <div style="font-family:${FONT};font-size:12px;font-weight:800;letter-spacing:.1em;text-transform:uppercase;color:${C.goldDeep};padding:12px 0 4px">${esc(sec.heading)}</div>
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">${rows}${total}</table></td></tr></table>`;
}

function callout(c: NonNullable<EmailContent['callout']>) {
  const t = TONE[c.tone];
  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin:0 0 20px"><tr>
    <td style="background:${t.bg};border-left:4px solid ${t.border};border-radius:8px;padding:14px 16px;font-family:${FONT};font-size:14px;line-height:22px;color:${C.text}">
      ${c.title ? `<b style="color:${t.fg}">${esc(c.title)}</b><br>` : ''}${br(c.text)}</td></tr></table>`;
}

function steps(st: NonNullable<EmailContent['steps']>) {
  const items = st.items.map((it, i) => `<tr>
      <td valign="top" width="34" style="padding:6px 0"><div style="width:24px;height:24px;line-height:24px;border-radius:12px;background:${C.gold};color:${C.goldInk};text-align:center;font-family:${FONT};font-size:12px;font-weight:800">${i + 1}</div></td>
      <td valign="top" style="padding:7px 0;font-family:${FONT};font-size:14px;line-height:22px;color:${C.dim}">${br(it)}</td></tr>`).join('');
  return `<div style="font-family:${FONT};font-size:16px;font-weight:800;color:${C.text};margin:6px 0 8px">${esc(st.heading)}</div>
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin:0 0 20px">${items}</table>`;
}

function button(cta: NonNullable<EmailContent['cta']>) {
  const url = safeUrl(cta.url);
  if (!url) return '';
  return `<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin:6px 0 24px"><tr>
    <td align="center" bgcolor="${C.gold}" style="border-radius:999px;background:${C.gold}">
      <a href="${esc(url)}" target="_blank" style="display:inline-block;padding:14px 30px;font-family:${FONT};font-size:15px;font-weight:800;color:${C.goldInk};text-decoration:none;border-radius:999px">${esc(cta.label)} &rarr;</a>
    </td></tr></table>`;
}

function toHtml(c: EmailContent, s: Settings, hasLogo: boolean): string {
  const name = s['company.name'];
  const site = safeUrl(s['company.websiteUrl']);
  const header = hasLogo
    ? `<img src="cid:${LOGO_CID}" width="240" alt="${esc(name)}" style="display:block;width:240px;max-width:70%;height:auto;border:0;margin:0 auto">`
    : `<div style="font-family:${FONT};font-size:28px;font-weight:900;font-style:italic;letter-spacing:.02em;color:#ffffff">${esc(name.toUpperCase())}</div>`;
  const contact = [
    s['company.supportPhone'] ? `<a href="tel:${esc(s['company.supportPhone'].replace(/\s+/g, ''))}" style="color:${C.gold};text-decoration:none">${esc(s['company.supportPhone'])}</a>` : '',
    s['company.supportEmail'] ? `<a href="mailto:${esc(s['company.supportEmail'])}" style="color:${C.gold};text-decoration:none">${esc(s['company.supportEmail'])}</a>` : '',
    site ? `<a href="${esc(site)}" style="color:${C.gold};text-decoration:none">${esc(site.replace(/^https?:\/\//, '').replace(/\/$/, ''))}</a>` : '',
  ].filter(Boolean).join(' &nbsp;&middot;&nbsp; ');
  const why = c.audience === 'owner'
    ? `Internal notification for the ${esc(name)} team. Recipients are set in Admin &gt; Settings &gt; Business.`
    : `You're receiving this because you have an account or booking with ${esc(name)}.`;

  return `<!doctype html>
<html lang="en" xmlns="http://www.w3.org/1999/xhtml"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta http-equiv="X-UA-Compatible" content="IE=edge">
<meta name="color-scheme" content="light only"><meta name="supported-color-schemes" content="light">
<title>${esc(c.subject)}</title>
<style>
  body{margin:0;padding:0;background:${C.page}} a{color:${C.goldDeep}}
  @media (max-width:620px){ .card{padding:26px 20px !important} .wrap{width:100% !important} h1{font-size:24px !important;line-height:30px !important} }
</style></head>
<body style="margin:0;padding:0;background:${C.page}">
<div style="display:none;max-height:0;overflow:hidden;mso-hide:all;font-size:1px;line-height:1px;color:${C.page}">${esc(c.preheader)}${'&#8204;&nbsp;'.repeat(40)}</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" bgcolor="${C.page}" style="background:${C.page}"><tr><td align="center" style="padding:24px 12px">
<table role="presentation" class="wrap" width="600" cellpadding="0" cellspacing="0" border="0" style="width:600px;max-width:600px">
  <tr><td align="center" bgcolor="${C.black}" style="background:${C.black};border-radius:18px 18px 0 0;padding:26px 24px 20px">${header}</td></tr>
  <tr><td height="4" bgcolor="${C.gold}" style="height:4px;line-height:4px;font-size:0;background:${C.gold};background-image:linear-gradient(90deg,#ffdd6e,${C.gold} 45%,${C.goldDeep})">&nbsp;</td></tr>
  <tr><td class="card" bgcolor="${C.card}" style="background:${C.card};padding:36px 40px 18px">
    ${c.badge ? badge(c.badge) : ''}
    <h1 style="margin:0 0 18px;font-family:${FONT};font-size:28px;line-height:34px;font-weight:800;color:${C.text}">${esc(c.title)}</h1>
    ${c.greeting ? p(c.greeting, `color:${C.text};font-weight:600`) : ''}
    ${c.intro.map((t) => p(t)).join('')}
    ${c.highlight ? highlight(c.highlight) : ''}
    ${c.cta ? button(c.cta) : ''}
    ${(c.sections ?? []).map(section).join('')}
    ${c.callout ? callout(c.callout) : ''}
    ${c.steps ? steps(c.steps) : ''}
    ${(c.outro ?? []).map((t) => p(t)).join('')}
  </td></tr>
  <tr><td bgcolor="${C.ink}" style="background:${C.ink};border-radius:0 0 18px 18px;padding:24px 32px;text-align:center">
    <div style="font-family:${FONT};font-size:16px;font-weight:800;font-style:italic;letter-spacing:.03em;color:#ffffff">${esc(name)}</div>
    ${contact ? `<div style="font-family:${FONT};font-size:13px;line-height:22px;color:#b4b6bf;margin-top:8px">${contact}</div>` : ''}
    ${s['company.address'] ? `<div style="font-family:${FONT};font-size:12px;line-height:18px;color:${C.mute};margin-top:6px">${esc(s['company.address'])}</div>` : ''}
    <div style="font-family:${FONT};font-size:11px;line-height:17px;color:${C.mute};margin-top:14px">${why}</div>
  </td></tr>
</table></td></tr></table>
</body></html>`;
}

export function renderEmail(c: EmailContent, s: Settings): RenderedEmail {
  const bytes = logoBytes();
  return {
    subject: c.subject,
    text: toText(c, s),
    html: toHtml(c, s, !!bytes),
    inline: bytes ? [{ cid: LOGO_CID, filename: 'supercarstars-logo.jpg', content: bytes, contentType: 'image/jpeg' }] : [],
  };
}
