/**
 * NWS active-alert poller (api.weather.gov) with dedupe state, filtering,
 * quiet hours, desktop notifications and sound.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { Config, GeoPoint } from './config';
import { Notifier, type NotifyContent } from './notify';
import { playSound } from './sound';

export interface ActiveAlert {
  id: string; // NWS feature id/URL
  event: string; // e.g. "Tornado Warning"
  headline: string;
  areaDesc: string;
  severity: string; // Extreme|Severe|Moderate|Minor|Unknown
  urgency: string;
  certainty: string;
  sent: string;
  effective: string;
  expires: string;
  ends: string | null;
  description: string;
  instruction: string | null;
  senderName: string;
  messageType: string;
  web: string | null;
  location: GeoPoint; // which watched location matched
  centroid: { lat: number; lon: number } | null;
}

/** Minimal notifier interface (the real one is `Notifier<ActiveAlert>` from notify.ts). */
export interface AlertNotifier {
  notify(key: string, alert: ActiveAlert, content: NotifyContent): Promise<void>;
  dispose?(): void;
}

export interface AlertServiceDeps {
  getConfig(): Config;
  onConfigChange(cb: (cfg: Config, prev: Config) => void): void;
  /** Current location (device or manual home), or null. Called every poll. */
  getCurrentLocation(): Promise<GeoPoint | null>;
  stateFile: string; // JSON path for dedupe state (persist across restarts)
  defaultSoundFile: string; // bundled WAV path
  appVersion: string;
  iconPath: string; // absolute PNG path for notification icon
  onOpenMap(alert: ActiveAlert): void;
  onShowDetails(alert: ActiveAlert): void;
  onActiveAlertsChanged(alerts: ActiveAlert[]): void;
  onStatus(status: 'ok' | 'offline' | 'disabled' | 'no-location'): void;
  /** Optional: override the notifier (tests). Defaults to the D-Bus/Electron Notifier. */
  notifier?: AlertNotifier;
}

type Status = 'ok' | 'offline' | 'disabled' | 'no-location';

const API = 'https://api.weather.gov/alerts/active';
const MIN_POLL_S = 30;
const MAX_BACKOFF_MS = 10 * 60_000;
const FETCH_TIMEOUT_MS = 20_000;
const MAX_NOTIFY_PER_POLL = 5;
/** Keep dedupe entries this long after an alert was last seen *and* has expired. */
const STATE_GRACE_MS = 12 * 3600_000;

const SEVERITY_RANK: Record<string, number> = { Extreme: 4, Severe: 3, Moderate: 2, Minor: 1, Unknown: 1 };
export function severityRank(sev: string | null | undefined): number {
  return SEVERITY_RANK[sev ?? 'Unknown'] ?? 1;
}

interface StateEntry {
  /** Highest severity rank we've notified for this alert chain. */
  rank: number;
  /** ms epoch: max(expires, ends) */
  expires: number;
  /** ms epoch */
  lastSeen: number;
  /** NWS identifier (urn:oid:...) for matching `references`. */
  identifier?: string;
}
interface StateFile {
  version: 1;
  notified: Record<string, StateEntry>;
}

interface LocCache {
  etag: string | null;
  lastModified: string | null;
  alerts: ActiveAlert[];
  /** raw references per alert id: [{ '@id', identifier }] */
  refs: Map<string, { atId: string | null; identifier: string | null }[]>;
  identifiers: Map<string, string>;
}

const round4 = (n: number) => Math.round(n * 10_000) / 10_000;
const locKey = (p: GeoPoint) => `${round4(p.lat)},${round4(p.lon)}`;

function parseTime(s: string | null | undefined): number {
  if (!s) return NaN;
  const t = Date.parse(s);
  return Number.isFinite(t) ? t : NaN;
}
function alertEndMs(a: ActiveAlert): number {
  const ts = [parseTime(a.expires), parseTime(a.ends)].filter(Number.isFinite);
  return ts.length ? Math.max(...ts) : Date.now() + 3600_000;
}

function hm(s: string): number | null {
  const m = /^(\d{1,2}):(\d{2})$/.exec(s.trim());
  if (!m) return null;
  const h = Number(m[1]);
  const mi = Number(m[2]);
  if (h > 23 || mi > 59) return null;
  return h * 60 + mi;
}
export function inQuietHours(q: Config['alerts']['quietHours'], now = new Date()): boolean {
  if (!q.enabled) return false;
  const s = hm(q.start);
  const e = hm(q.end);
  if (s === null || e === null || s === e) return false;
  const cur = now.getHours() * 60 + now.getMinutes();
  return s < e ? cur >= s && cur < e : cur >= s || cur < e;
}

export function passesFilter(a: ActiveAlert, cfg: Config['alerts']): boolean {
  if (severityRank(a.severity) < severityRank(cfg.minSeverity)) return false;
  const ev = (a.event || '').toLowerCase();
  if (cfg.onlyWarnings && !(ev.endsWith('warning') || ev.includes('emergency'))) return false;
  const allow = cfg.eventFilter.map((s) => s.trim().toLowerCase()).filter(Boolean);
  if (allow.length && !allow.includes(ev)) return false;
  return true;
}

function centroidOf(geom: unknown): { lat: number; lon: number } | null {
  try {
    const g = geom as { type?: string; coordinates?: unknown } | null;
    if (!g || !g.coordinates) return null;
    let rings: number[][][] = [];
    if (g.type === 'Polygon') rings = [(g.coordinates as number[][][])[0]];
    else if (g.type === 'MultiPolygon') rings = (g.coordinates as number[][][][]).map((p) => p[0]);
    else if (g.type === 'Point') {
      const [lon, lat] = g.coordinates as number[];
      return { lat, lon };
    } else return null;
    let sx = 0;
    let sy = 0;
    let n = 0;
    for (const ring of rings) {
      if (!ring) continue;
      // Skip the closing vertex (same as first).
      const pts = ring.length > 1 ? ring.slice(0, -1) : ring;
      for (const [lon, lat] of pts) {
        sx += lon;
        sy += lat;
        n++;
      }
    }
    return n ? { lat: round4(sy / n), lon: round4(sx / n) } : null;
  } catch {
    return null;
  }
}

function str(v: unknown, d = ''): string {
  return typeof v === 'string' ? v : d;
}

function shortArea(areaDesc: string): string {
  const parts = areaDesc
    .split(';')
    .map((s) => s.trim())
    .filter(Boolean);
  if (parts.length <= 1) return parts[0] ?? '';
  return `${parts[0]} +${parts.length - 1} more`;
}

function fmtTime(iso: string | null): string {
  const t = parseTime(iso);
  if (!Number.isFinite(t)) return '';
  const d = new Date(t);
  const sameDay = d.toDateString() === new Date().toDateString();
  return d.toLocaleString(undefined, sameDay ? { hour: 'numeric', minute: '2-digit' } : { weekday: 'short', hour: 'numeric', minute: '2-digit' });
}

export function notificationContent(a: ActiveAlert): NotifyContent {
  const area = shortArea(a.areaDesc);
  const until = fmtTime(a.ends ?? a.expires);
  const lines = [a.headline || a.event];
  const meta = [until ? `Until ${until}` : '', a.location?.name ? `Watching: ${a.location.name}` : ''].filter(Boolean).join(' · ');
  if (meta) lines.push(meta);
  const rank = severityRank(a.severity);
  return {
    summary: area ? `${a.event} – ${area}` : a.event,
    body: lines.join('\n'),
    critical: rank >= 3,
  };
}

export class AlertService {
  private readonly deps: AlertServiceDeps;
  private readonly notifier: AlertNotifier;
  private timer: NodeJS.Timeout | null = null;
  private running = false;
  private inFlight: Promise<void> | null = null;
  private failures = 0;
  private retryAfterMs = 0;
  private cache = new Map<string, LocCache>();
  private active: ActiveAlert[] = [];
  private lastActiveKey: string | null = null;
  private lastStatus: Status | null = null;
  private state: StateFile;
  private configHooked = false;

  constructor(deps: AlertServiceDeps) {
    this.deps = deps;
    this.notifier =
      deps.notifier ??
      new Notifier<ActiveAlert>({
        iconPath: deps.iconPath,
        onOpenMap: (a) => deps.onOpenMap(a),
        onShowDetails: (a) => deps.onShowDetails(a),
      });
    this.state = this.loadState();
  }

  // ---------- lifecycle ----------

  start(): void {
    if (this.running) return;
    this.running = true;
    if (!this.configHooked) {
      this.configHooked = true;
      this.deps.onConfigChange((cfg, prev) => {
        if (!this.running) return;
        if (
          JSON.stringify(cfg.alerts) !== JSON.stringify(prev.alerts) ||
          JSON.stringify(cfg.location) !== JSON.stringify(prev.location)
        ) {
          this.failures = 0;
          this.retryAfterMs = 0;
          this.schedule(0);
        }
      });
    }
    this.schedule(0);
  }

  stop(): void {
    this.running = false;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  getActive(): ActiveAlert[] {
    return [...this.active];
  }

  refreshNow(): Promise<void> {
    if (this.inFlight) return this.inFlight;
    this.inFlight = this.poll()
      .catch((e) => console.error('[alerts] poll failed', e))
      .finally(() => {
        this.inFlight = null;
      });
    return this.inFlight;
  }

  private schedule(delayMs: number): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    if (!this.running) return;
    this.timer = setTimeout(async () => {
      this.timer = null;
      await this.refreshNow();
      if (this.running && !this.timer) this.schedule(this.nextDelay());
    }, delayMs);
  }

  private nextDelay(): number {
    const base = Math.max(MIN_POLL_S, Number(this.deps.getConfig().alerts.pollSeconds) || 60) * 1000;
    if (this.failures === 0) return base;
    const backoff = Math.min(MAX_BACKOFF_MS, base * 2 ** Math.min(this.failures, 10));
    return Math.max(backoff, Math.min(this.retryAfterMs, MAX_BACKOFF_MS));
  }

  // ---------- polling ----------

  private setStatus(s: Status): void {
    if (s === this.lastStatus) return;
    this.lastStatus = s;
    try {
      this.deps.onStatus(s);
    } catch (e) {
      console.error('[alerts] onStatus failed', e);
    }
  }

  private setActive(list: ActiveAlert[]): void {
    list.sort((a, b) => severityRank(b.severity) - severityRank(a.severity) || parseTime(b.sent) - parseTime(a.sent));
    this.active = list;
    const key = list
      .map((a) => a.id)
      .sort()
      .join('\n');
    if (key === this.lastActiveKey) return;
    this.lastActiveKey = key;
    try {
      this.deps.onActiveAlertsChanged([...list]);
    } catch (e) {
      console.error('[alerts] onActiveAlertsChanged failed', e);
    }
  }

  private async locations(cfg: Config): Promise<GeoPoint[]> {
    const out: GeoPoint[] = [];
    const seen = new Set<string>();
    const add = (p: GeoPoint | null | undefined) => {
      if (!p || !Number.isFinite(p.lat) || !Number.isFinite(p.lon)) return;
      const k = locKey(p);
      if (seen.has(k)) return;
      seen.add(k);
      out.push({ name: p.name || k, lat: round4(p.lat), lon: round4(p.lon) });
    };
    if (cfg.alerts.watchCurrentLocation) {
      try {
        add(await this.deps.getCurrentLocation());
      } catch (e) {
        console.warn('[alerts] getCurrentLocation failed', e);
      }
    }
    for (const p of cfg.alerts.extraLocations ?? []) add(p);
    return out;
  }

  private async poll(): Promise<void> {
    const cfg = this.deps.getConfig();
    if (!cfg.alerts.enabled) {
      this.setStatus('disabled');
      this.setActive([]);
      return;
    }
    const locs = await this.locations(cfg);
    // Drop caches for locations no longer watched.
    const keys = new Set(locs.map(locKey));
    for (const k of [...this.cache.keys()]) if (!keys.has(k)) this.cache.delete(k);
    if (!locs.length) {
      this.setStatus('no-location');
      this.setActive([]);
      return;
    }

    let ok = 0;
    let netFail = 0;
    let httpFail = 0;
    this.retryAfterMs = 0;
    for (const loc of locs) {
      const r = await this.fetchLocation(loc);
      if (r === 'ok') ok++;
      else if (r === 'network') netFail++;
      else httpFail++;
    }
    if (netFail + httpFail > 0) this.failures++;
    else this.failures = 0;
    this.setStatus(ok > 0 ? 'ok' : 'offline');

    // Merge across locations by id (first location wins), dropping expired cached entries.
    const now = Date.now();
    const merged = new Map<string, ActiveAlert>();
    const refs = new Map<string, { atId: string | null; identifier: string | null }[]>();
    const idents = new Map<string, string>();
    for (const loc of locs) {
      const c = this.cache.get(locKey(loc));
      if (!c) continue;
      for (const a of c.alerts) {
        if (merged.has(a.id)) continue;
        if (alertEndMs(a) < now) continue;
        merged.set(a.id, a);
        refs.set(a.id, c.refs.get(a.id) ?? []);
        const ident = c.identifiers.get(a.id);
        if (ident) idents.set(a.id, ident);
      }
    }

    const filtered = [...merged.values()].filter((a) => passesFilter(a, cfg.alerts));
    this.setActive(filtered);
    await this.processNotifications(filtered, refs, idents, cfg);
  }

  private async fetchLocation(loc: GeoPoint): Promise<'ok' | 'network' | 'http'> {
    const key = locKey(loc);
    const prev = this.cache.get(key);
    const headers: Record<string, string> = {
      Accept: 'application/geo+json',
      'User-Agent': `weatherwise-linux/${this.deps.appVersion} (unofficial desktop client)`,
    };
    if (prev?.etag) headers['If-None-Match'] = prev.etag;
    if (prev?.lastModified) headers['If-Modified-Since'] = prev.lastModified;
    let res: Response;
    try {
      res = await fetch(`${API}?point=${key}`, { headers, signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
    } catch (e) {
      console.warn(`[alerts] fetch ${key} failed:`, (e as Error)?.message ?? e);
      return 'network';
    }
    if (res.status === 304 && prev) {
      // Refresh location name on cached alerts (user may have renamed it).
      for (const a of prev.alerts) a.location = loc;
      return 'ok';
    }
    if (!res.ok) {
      if (res.status === 429 || res.status >= 500) {
        const ra = Number(res.headers.get('retry-after'));
        if (Number.isFinite(ra) && ra > 0) this.retryAfterMs = Math.max(this.retryAfterMs, ra * 1000);
      }
      console.warn(`[alerts] NWS ${key} HTTP ${res.status}`);
      try {
        await res.body?.cancel();
      } catch {
        /* ignore */
      }
      return 'http';
    }
    let json: { features?: unknown[] };
    try {
      json = (await res.json()) as { features?: unknown[] };
    } catch (e) {
      console.warn(`[alerts] bad JSON for ${key}`, e);
      return 'http';
    }
    const entry: LocCache = {
      etag: res.headers.get('etag'),
      lastModified: res.headers.get('last-modified'),
      alerts: [],
      refs: new Map(),
      identifiers: new Map(),
    };
    for (const f of json.features ?? []) {
      const parsed = this.parseFeature(f, loc);
      if (!parsed) continue;
      entry.alerts.push(parsed.alert);
      entry.refs.set(parsed.alert.id, parsed.refs);
      if (parsed.identifier) entry.identifiers.set(parsed.alert.id, parsed.identifier);
    }
    this.cache.set(key, entry);
    return 'ok';
  }

  private parseFeature(
    f: unknown,
    loc: GeoPoint,
  ): { alert: ActiveAlert; refs: { atId: string | null; identifier: string | null }[]; identifier: string | null } | null {
    if (!f || typeof f !== 'object') return null;
    const feat = f as { id?: unknown; properties?: Record<string, unknown>; geometry?: unknown };
    const p = feat.properties;
    if (!p) return null;
    const id = str(feat.id) || str(p['@id']) || str(p.id);
    if (!id) return null;
    if (str(p.status, 'Actual') !== 'Actual') return null;
    const messageType = str(p.messageType, 'Alert');
    if (messageType === 'Cancel') return null;
    const refsRaw = Array.isArray(p.references) ? (p.references as Record<string, unknown>[]) : [];
    const refs = refsRaw.map((r) => ({ atId: str(r?.['@id']) || null, identifier: str(r?.identifier) || null }));
    const event = str(p.event, 'Weather Alert');
    const alert: ActiveAlert = {
      id,
      event,
      headline: str(p.headline) || event,
      areaDesc: str(p.areaDesc),
      severity: str(p.severity, 'Unknown'),
      urgency: str(p.urgency, 'Unknown'),
      certainty: str(p.certainty, 'Unknown'),
      sent: str(p.sent),
      effective: str(p.effective),
      expires: str(p.expires),
      ends: str(p.ends) || null,
      description: str(p.description),
      instruction: str(p.instruction) || null,
      senderName: str(p.senderName),
      messageType,
      web: /^https?:\/\//.test(id) ? id : str(p['@id']) || null,
      location: loc,
      centroid: centroidOf(feat.geometry) ?? { lat: loc.lat, lon: loc.lon },
    };
    return { alert, refs, identifier: str(p.id) || null };
  }

  // ---------- notifications & dedupe ----------

  private async processNotifications(
    alerts: ActiveAlert[],
    refs: Map<string, { atId: string | null; identifier: string | null }[]>,
    idents: Map<string, string>,
    cfg: Config,
  ): Promise<void> {
    const now = Date.now();
    const notified = this.state.notified;
    const byIdentifier = new Map<string, string>();
    for (const [k, v] of Object.entries(notified)) if (v.identifier) byIdentifier.set(v.identifier, k);

    const toNotify: ActiveAlert[] = [];
    let dirty = false;
    for (const a of alerts) {
      const rank = severityRank(a.severity);
      const existing = notified[a.id];
      if (existing) {
        existing.lastSeen = now;
        existing.expires = Math.max(existing.expires, alertEndMs(a));
        dirty = true;
        continue;
      }
      // Find the highest rank already notified among referenced (superseded) alerts.
      let prevRank = 0;
      for (const r of refs.get(a.id) ?? []) {
        const k = (r.atId && notified[r.atId] ? r.atId : null) ?? (r.identifier ? byIdentifier.get(r.identifier) : undefined);
        if (k && notified[k]) prevRank = Math.max(prevRank, notified[k].rank);
      }
      const shouldNotify = prevRank === 0 || rank > prevRank;
      notified[a.id] = {
        rank: Math.max(rank, prevRank),
        expires: alertEndMs(a),
        lastSeen: now,
        identifier: idents.get(a.id),
      };
      dirty = true;
      if (shouldNotify) toNotify.push(a);
    }

    // Prune entries that are expired and haven't been seen for a while.
    for (const [k, v] of Object.entries(notified)) {
      if (v.expires < now && now - v.lastSeen > STATE_GRACE_MS) {
        delete notified[k];
        dirty = true;
      }
    }
    if (dirty) this.saveState();

    if (!toNotify.length) return;
    toNotify.sort((a, b) => severityRank(b.severity) - severityRank(a.severity) || parseTime(b.sent) - parseTime(a.sent));
    const quiet = inQuietHours(cfg.alerts.quietHours);
    const batch = toNotify
      .slice(0, MAX_NOTIFY_PER_POLL)
      .filter((a) => !quiet || (cfg.alerts.quietHours.extremeBreaksThrough && severityRank(a.severity) >= 4));
    if (toNotify.length > MAX_NOTIFY_PER_POLL) {
      console.info(`[alerts] ${toNotify.length} new alerts; notifying the ${MAX_NOTIFY_PER_POLL} most severe`);
    }
    if (!batch.length) return;
    await this.present(batch, cfg);
  }

  private async present(batch: ActiveAlert[], cfg: Config): Promise<void> {
    for (const a of batch) {
      try {
        await this.notifier.notify(a.id, a, notificationContent(a));
      } catch (e) {
        console.error('[alerts] notify failed', e);
      }
    }
    if (cfg.alerts.sound) {
      const custom = cfg.alerts.soundFile;
      playSound(custom && fs.existsSync(custom) ? custom : this.deps.defaultSoundFile);
    }
  }

  async sendTestAlert(): Promise<void> {
    const cfg = this.deps.getConfig();
    let loc: GeoPoint | null = null;
    try {
      loc = await this.deps.getCurrentLocation();
    } catch {
      /* ignore */
    }
    loc ??= cfg.alerts.extraLocations[0] ?? { name: 'Test location', lat: 39.8333, lon: -98.5855 };
    const now = new Date();
    const ends = new Date(now.getTime() + 30 * 60_000);
    const alert: ActiveAlert = {
      id: `weatherwise-linux:test:${now.getTime()}`,
      event: 'Test Warning',
      headline: 'This is a test of WeatherWise desktop alerts. No action is needed.',
      areaDesc: loc.name || 'Your area',
      severity: 'Severe',
      urgency: 'Immediate',
      certainty: 'Observed',
      sent: now.toISOString(),
      effective: now.toISOString(),
      expires: ends.toISOString(),
      ends: ends.toISOString(),
      description:
        'This is a test alert generated by WeatherWise for Linux to verify that desktop notifications, actions and sound work. It is not a real warning.',
      instruction: 'No action is needed. Use "Open map" or "Details" to check that the notification actions work.',
      senderName: 'WeatherWise (test)',
      messageType: 'Alert',
      web: null,
      location: { name: loc.name, lat: round4(loc.lat), lon: round4(loc.lon) },
      centroid: { lat: round4(loc.lat), lon: round4(loc.lon) },
    };
    // Test bypasses filters and quiet hours, but honors the sound setting.
    await this.present([alert], cfg);
  }

  // ---------- state file ----------

  private loadState(): StateFile {
    try {
      const raw = JSON.parse(fs.readFileSync(this.deps.stateFile, 'utf8'));
      if (raw && raw.version === 1 && raw.notified && typeof raw.notified === 'object') {
        const notified: Record<string, StateEntry> = {};
        for (const [k, v] of Object.entries(raw.notified as Record<string, Partial<StateEntry>>)) {
          if (!v || typeof v.rank !== 'number' || typeof v.expires !== 'number') continue;
          notified[k] = {
            rank: v.rank,
            expires: v.expires,
            lastSeen: typeof v.lastSeen === 'number' ? v.lastSeen : v.expires,
            identifier: typeof v.identifier === 'string' ? v.identifier : undefined,
          };
        }
        return { version: 1, notified };
      }
    } catch {
      /* missing or corrupt → fresh */
    }
    return { version: 1, notified: {} };
  }

  private saveState(): void {
    try {
      fs.mkdirSync(path.dirname(this.deps.stateFile), { recursive: true });
      const tmp = `${this.deps.stateFile}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(this.state, null, 1));
      fs.renameSync(tmp, this.deps.stateFile);
    } catch (e) {
      console.error('[alerts] failed to save state', e);
    }
  }
}
