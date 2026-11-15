import * as fs from 'node:fs';
import * as path from 'node:path';
import type { Config, GeoPoint } from './config';

// dbus-next has no bundled types we rely on; keep it loosely typed.
// eslint-disable-next-line @typescript-eslint/no-require-imports
const dbus = require('@particle/dbus-next');

export interface Fix {
  lat: number;
  lon: number;
  accuracy: number; // meters
  timestamp: number;
  source: 'geoclue' | 'manual';
}

const GC = 'org.freedesktop.GeoClue2';
const ACCURACY_EXACT = 8;

/**
 * Location provider backed by geoclue2 over the system D-Bus, with the
 * manual "home" location from config as a fallback. Chromium/Electron can't
 * locate on Linux without a Google API key, so the site's geolocation calls
 * are routed here through the preload shim.
 */
export class LocationService {
  private last: Fix | null = null;
  private starting: Promise<void> | null = null;
  private client: any = null;
  private bus: any = null;
  private failedAt = 0;
  private listeners = new Set<(fix: Fix) => void>();

  /** Last device fix from a previous run, so location is known instantly at startup. */
  private cached: Fix | null = null;

  constructor(
    private readonly getConfig: () => Config,
    private readonly cacheFile?: string,
  ) {
    if (cacheFile) {
      try {
        const c = JSON.parse(fs.readFileSync(cacheFile, 'utf8')) as Fix;
        if (Number.isFinite(c.lat) && Number.isFinite(c.lon) && Date.now() - c.timestamp < 7 * 86_400_000) this.cached = c;
      } catch {
        /* none yet */
      }
      this.onUpdate((fix) => this.persist(fix));
    }
  }

  private persist(fix: Fix): void {
    if (!this.cacheFile) return;
    try {
      fs.mkdirSync(path.dirname(this.cacheFile), { recursive: true });
      fs.writeFileSync(this.cacheFile, JSON.stringify(fix));
    } catch {
      /* ignore */
    }
  }

  /** Fallback when geoclue is slow or unavailable: last saved device fix, then manual home. */
  private fallback(): Fix | null {
    return this.cached ? this.preferManual(this.cached) : this.manual();
  }

  onUpdate(cb: (fix: Fix) => void): () => void {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  }

  private manual(): Fix | null {
    const home = this.getConfig().location.home;
    if (!home) return null;
    return { lat: home.lat, lon: home.lon, accuracy: 50, timestamp: Date.now(), source: 'manual' };
  }

  /** Best known position: fresh geoclue fix, else manual home, else null. */
  async getFix(timeoutMs = 12000): Promise<Fix | null> {
    const cfg = this.getConfig();
    if (!cfg.location.useDeviceLocation) return this.manual();
    // Prefer a manual home if geoclue only has a coarse (IP-based) fix.
    if (this.last && Date.now() - this.last.timestamp < 15 * 60_000) return this.preferManual(this.last);
    if (Date.now() - this.failedAt < 5 * 60_000) return this.fallback();
    try {
      await this.ensureStarted();
      // With a cached fix from last run, answer quickly; geoclue keeps updating in the background.
      const fix = await this.waitForFix(this.cached ? Math.min(timeoutMs, 3000) : timeoutMs);
      if (fix) return this.preferManual(fix);
    } catch (e) {
      console.warn('[geo] geoclue unavailable:', (e as Error).message);
      this.failedAt = Date.now();
      this.stop();
    }
    return this.fallback();
  }

  private preferManual(fix: Fix): Fix {
    const m = this.manual();
    return m && fix.accuracy > 5000 ? m : fix;
  }

  async getPoint(): Promise<GeoPoint | null> {
    const f = await this.getFix();
    return f ? { name: f.source === 'manual' ? this.getConfig().location.home?.name || 'Home' : 'Current location', lat: f.lat, lon: f.lon } : null;
  }

  private waitForFix(timeoutMs: number): Promise<Fix | null> {
    if (this.last) return Promise.resolve(this.last);
    return new Promise((resolve) => {
      const t = setTimeout(() => {
        off();
        resolve(null);
      }, timeoutMs);
      const off = this.onUpdate((fix) => {
        clearTimeout(t);
        off();
        resolve(fix);
      });
    });
  }

  private ensureStarted(): Promise<void> {
    if (this.client) return Promise.resolve();
    if (!this.starting) {
      this.starting = this.start().finally(() => {
        this.starting = null;
      });
    }
    return this.starting;
  }

  private async start(): Promise<void> {
    this.bus = dbus.systemBus();
    const mgrObj = await this.bus.getProxyObject(GC, '/org/freedesktop/GeoClue2/Manager');
    const mgr = mgrObj.getInterface(`${GC}.Manager`);
    const clientPath: string = await mgr.GetClient();
    const cObj = await this.bus.getProxyObject(GC, clientPath);
    const props = cObj.getInterface('org.freedesktop.DBus.Properties');
    const client = cObj.getInterface(`${GC}.Client`);
    await props.Set(`${GC}.Client`, 'DesktopId', new dbus.Variant('s', 'weatherwise-linux'));
    await props.Set(`${GC}.Client`, 'RequestedAccuracyLevel', new dbus.Variant('u', ACCURACY_EXACT));
    await props.Set(`${GC}.Client`, 'DistanceThreshold', new dbus.Variant('u', 200));
    client.on('LocationUpdated', async (_old: string, newPath: string) => {
      try {
        const lo = await this.bus.getProxyObject(GC, newPath);
        const lp = lo.getInterface('org.freedesktop.DBus.Properties');
        const all = await lp.GetAll(`${GC}.Location`);
        this.last = {
          lat: all.Latitude.value,
          lon: all.Longitude.value,
          accuracy: all.Accuracy.value,
          timestamp: Date.now(),
          source: 'geoclue',
        };
        for (const l of this.listeners) l(this.last);
      } catch (e) {
        console.warn('[geo] failed to read location', e);
      }
    });
    await client.Start();
    this.client = client;
  }

  stop(): void {
    try {
      this.client?.Stop?.().catch(() => {});
    } catch {
      /* ignore */
    }
    try {
      this.bus?.disconnect?.();
    } catch {
      /* ignore */
    }
    this.client = null;
    this.bus = null;
  }
}
