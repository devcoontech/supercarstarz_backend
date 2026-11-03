import type { Settings } from '../../core/settings.js';
import type { Mail } from '../../lib/mailer.js';
import { renderEmail, type EmailContent } from './layout.js';

/** Account emails sent straight away (not through the booking outbox): welcome, password reset code, test message. */

const mail = (to: string, c: EmailContent, s: Settings): Mail => {
  const r = renderEmail(c, s);
  return { to, subject: r.subject, text: r.text, html: r.html, inline: r.inline };
};

export const welcomeEmail = (to: string, name: string, s: Settings): Mail => mail(to, {
  subject: `Welcome to ${s['company.name']} ⭐`,
  preheader: 'Your account is ready. Time to pick your dream car.',
  badge: { text: 'Welcome', tone: 'gold' },
  title: `Welcome to ${s['company.name']}!`,
  greeting: `Hi ${name.split(' ')[0]},`,
  intro: [
    'Your account is ready. You can now browse our supercars, pick a date and book unforgettable experiences for birthdays, proms, weddings and every star moment in between.',
  ],
  steps: { heading: 'How it works', items: [
    'Choose a car and an occasion in the app.',
    'Pick your date and time, and whether we deliver the car to you.',
    'Pay securely in the app. We email you a confirmation and your receipt.',
  ] },
  cta: s['company.websiteUrl'] ? { label: 'Explore the cars', url: s['company.websiteUrl'] } : null,
  outro: ['Questions before you book? Just reply to this email and our team will help.'],
}, s);

/** The code must stay the first 6-digit number in the text body (the app and tests read it from there). */
export const resetCodeEmail = (to: string, name: string, code: string, s: Settings): Mail => mail(to, {
  subject: `Your ${s['company.name']} password reset code`,
  preheader: `Your code is ${code}. It expires in 15 minutes.`,
  badge: { text: 'Security', tone: 'info' },
  title: 'Reset your password',
  greeting: `Hi ${name.split(' ')[0]},`,
  intro: [`Your password reset code is ${code}`],
  highlight: { label: 'Your code', value: code, note: 'Works once · expires in 15 minutes' },
  outro: ["Enter it in the app to choose a new password. If you didn't ask for this, you can ignore this email; your password hasn't changed."],
}, s);

export const testEmail = (to: string, s: Settings): Mail => mail(to, {
  subject: `Test email from ${s['company.name']}`,
  preheader: 'Your email connection works.',
  badge: { text: 'Test', tone: 'success' },
  title: 'Your email connection works',
  intro: [
    `This is a test message from the ${s['company.name']} admin dashboard.`,
    'If you can read it, your email connection works and customers will receive booking emails and password reset codes.',
  ],
  callout: { tone: 'info', text: 'This is how every customer email will look: logo, colours and your contact details in the footer come from Settings > Business.' },
  audience: 'owner',
}, s);
