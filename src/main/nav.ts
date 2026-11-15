import type { Config } from './config';

export type LinkKind = 'app' | 'hazcam' | 'inapp-popup' | 'external' | 'blocked';

/** Domains that must stay inside the app (captcha, billing, 3-D Secure). */
const INAPP_DOMAINS = [
  'hcaptcha.com',
  'challenges.cloudflare.com',
  'revenuecat.com',
  'revenue.cat',
  'stripe.com',
  'stripe.network',
];

function hostMatches(host: string, domain: string): boolean {
  return host === domain || host.endsWith(`.${domain}`);
}

export function isWeatherWiseHost(host: string): boolean {
  return hostMatches(host, 'weatherwise.app');
}

export function classifyUrl(raw: string, cfg: Config): LinkKind {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return 'blocked';
  }
  if (u.protocol === 'about:' || u.protocol === 'blob:' || u.protocol === 'data:') return 'inapp-popup';
  if (u.protocol === 'mailto:' || u.protocol === 'tel:') return 'external';
  if (u.protocol !== 'https:' && u.protocol !== 'http:') return 'blocked';
  const host = u.hostname.toLowerCase();
  if (isWeatherWiseHost(host)) {
    if (u.pathname.startsWith('/hazcams')) return 'hazcam';
    // Marketing site / help docs open in the browser; the app hosts stay in-app.
    if (host === 'weatherwise.app' || host === 'www.weatherwise.app') return 'external';
    return 'app';
  }
  const extra = cfg.links.extraInAppDomains.map((d) => d.trim().toLowerCase()).filter(Boolean);
  if ([...INAPP_DOMAINS, ...extra].some((d) => hostMatches(host, d))) return 'inapp-popup';
  return 'external';
}

/** Accept a pasted/forwarded URL only if it belongs to the WeatherWise web app. */
export function normalizeAppUrl(raw: string): string | null {
  const s = raw.trim();
  if (!s) return null;
  // weatherwise-linux://open?url=<encoded>
  if (s.startsWith('weatherwise-linux://')) {
    try {
      const inner = new URL(s).searchParams.get('url');
      return inner ? normalizeAppUrl(inner) : null;
    } catch {
      return null;
    }
  }
  try {
    const u = new URL(s);
    if (u.protocol === 'https:' && isWeatherWiseHost(u.hostname) && u.hostname !== 'weatherwise.app' && u.hostname !== 'www.weatherwise.app') {
      return u.toString();
    }
  } catch {
    /* not a URL */
  }
  return null;
}
