import 'dotenv/config';

const required = (k: string): string => {
  const v = process.env[k];
  if (!v) throw new Error(`Missing required environment variable ${k}`);
  return v;
};

export function trustProxySetting(v: string | undefined): boolean | string | ((addr: string, hop: number) => boolean) {
  const s = (v ?? '').trim();
  if (!s) return 'loopback';
  if (s === 'true' || s === 'false') return s === 'true';
  if (/^\d+$/.test(s)) {
    const hops = Number(s);
    return (_addr, hop) => hop < hops; // trust the nearest N proxies
  }
  return s;
}

const isTest = process.env.NODE_ENV === 'test';
const databaseUrl = isTest ? required('TEST_DATABASE_URL') : required('DATABASE_URL');
const isLocalDb = ['localhost', '127.0.0.1', '::1', '[::1]'].includes(new URL(databaseUrl).hostname);

export const config = {
  env: process.env.NODE_ENV ?? 'development',
  port: Number(process.env.PORT ?? 4000),
  databaseUrl,
  /** TLS for hosted databases (e.g. Supabase); off for a local Docker database. Override with DATABASE_SSL=true|false. */
  databaseSsl: process.env.DATABASE_SSL ? process.env.DATABASE_SSL === 'true' : !isLocalDb,
  jwtSecret: required('JWT_SECRET'),
  settingsKey: required('SETTINGS_ENCRYPTION_KEY'),
  /**
   * Which proxies may set X-Forwarded-For (the client address used by rate limits). Default: only a proxy on this
   * machine (nginx/Caddy on the same host). TRUST_PROXY can be a hop count ("1"), addresses/CIDRs ("10.0.0.0/8"),
   * "true" (trust everyone: only if the API can never be reached except through your proxy) or "false".
   */
  trustProxy: trustProxySetting(process.env.TRUST_PROXY),
  corsOrigins:(process.env.CORS_ORIGINS ?? '').split(',').map((s) => s.trim()).filter(Boolean),
  publicApiUrl: process.env.PUBLIC_API_URL ?? `http://localhost:${process.env.PORT ?? 4000}`,
  uploadDir: process.env.UPLOAD_DIR ?? './uploads',
  /** Sensitive files (driver licences). Never served statically; keep it outside UPLOAD_DIR and back it up. */
  privateUploadDir: process.env.PRIVATE_UPLOAD_DIR ?? './private-uploads',
  /** Supabase Storage for uploads (see storage.ts). Unset: files stay on disk in the folders above. */
  supabase: {
    url: process.env.SUPABASE_URL || '',
    serviceKey: process.env.SUPABASE_SERVICE_ROLE_KEY || '',
    bucket: process.env.SUPABASE_STORAGE_BUCKET || 'images',
    privateBucket: process.env.SUPABASE_PRIVATE_BUCKET || 'private-files',
  },
  smtpUrl: process.env.SMTP_URL || '',
  mailFrom: process.env.MAIL_FROM || 'Supercarstars <no-reply@localhost>',
  /** Optional. Only needed if "Enhanced security for push notifications" is turned on in the Expo account. */
  expoAccessToken: process.env.EXPO_ACCESS_TOKEN || '',
  stripeSecretFallback: process.env.STRIPE_SECRET_KEY || '',
  stripeWebhookFallback: process.env.STRIPE_WEBHOOK_SECRET || '',
  /** Protects /internal/run-jobs. Unset: the route doesn't exist. */
  cronSecret: process.env.CRON_SECRET || '',
};
