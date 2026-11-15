import * as fs from 'node:fs';
import * as path from 'node:path';

export interface GeoPoint {
  name: string;
  lat: number;
  lon: number;
}

/** A place saved in the app (works without a WeatherWise account). */
export interface Place extends GeoPoint {
  id: string;
  /** Map zoom to use when jumping to this place. */
  zoom: number;
  /** Also watch this place for severe weather alerts. */
  alerts: boolean;
}

export type CloseAction = 'ask' | 'tray' | 'quit';
export type Severity = 'Extreme' | 'Severe' | 'Moderate' | 'Minor';
export type GpuMode = 'auto' | 'ignore-blocklist' | 'nvidia' | 'disable-gpu';
export type OzonePlatform = 'auto' | 'wayland' | 'x11';

export interface Config {
  general: {
    closeAction: CloseAction;
    /** Destroy the browser window after it has been hidden this many minutes (0 = never). */
    unloadWhenHiddenMinutes: number;
    /** Reload the site when shown after being hidden this many minutes (0 = never). */
    reloadWhenHiddenMinutes: number;
    startMinimized: boolean;
    autostart: boolean;
    zoom: number;
    alwaysOnTop: boolean;
    /** Check GitHub Releases for updates (AppImage installs them automatically). */
    autoUpdate: boolean;
  };
  /** Saved places (managed in Settings → Places and from the map's right-click "Save Location"). */
  places: Place[];
  map: {
    /** Reopen the map where you left it (position, zoom, layers). */
    restoreLastView: boolean;
    /** Map zoom used when an alert opens the map (mapbox zoom level, ~4 = region, 8 = county, 11 = city). */
    alertZoom: number;
  };
  location: {
    /** Use geoclue (system location service) for the site and for alerts. */
    useDeviceLocation: boolean;
    /** Manual location; used when device location is off or unavailable. */
    home: GeoPoint | null;
  };
  alerts: {
    enabled: boolean;
    /** Watch the current location (device or home). */
    watchCurrentLocation: boolean;
    /** Additional fixed places to watch (derived from saved places with alerts on). */
    extraLocations: GeoPoint[];
    minSeverity: Severity;
    /** Only notify for events whose name ends with "Warning" (plus "Particularly Dangerous Situation" etc.). */
    onlyWarnings: boolean;
    /** If non-empty, only these NWS event names notify (e.g. "Tornado Warning"). */
    eventFilter: string[];
    sound: boolean;
    /** Custom sound file path; null = bundled sound. */
    soundFile: string | null;
    quietHours: {
      enabled: boolean;
      /** "HH:MM" local time */
      start: string;
      end: string;
      extremeBreaksThrough: boolean;
    };
    pollSeconds: number;
  };
  links: {
    hazcamsInApp: boolean;
    extraInAppDomains: string[];
  };
  advanced: {
    gpuMode: GpuMode;
    ozonePlatform: OzonePlatform;
    userAgentOverride: string;
    devtools: boolean;
  };
}

export const DEFAULT_CONFIG: Config = {
  general: {
    closeAction: 'ask',
    unloadWhenHiddenMinutes: 10,
    reloadWhenHiddenMinutes: 15,
    startMinimized: false,
    autostart: false,
    zoom: 1,
    alwaysOnTop: false,
    autoUpdate: true,
  },
  places: [],
  map: {
    restoreLastView: true,
    alertZoom: 8,
  },
  location: {
    useDeviceLocation: true,
    home: null,
  },
  alerts: {
    enabled: true,
    watchCurrentLocation: true,
    extraLocations: [],
    minSeverity: 'Severe',
    onlyWarnings: false,
    eventFilter: [],
    sound: true,
    soundFile: null,
    quietHours: { enabled: false, start: '22:00', end: '07:00', extremeBreaksThrough: true },
    pollSeconds: 60,
  },
  links: {
    hazcamsInApp: true,
    extraInAppDomains: [],
  },
  advanced: {
    gpuMode: 'auto',
    ozonePlatform: 'auto',
    userAgentOverride: '',
    devtools: false,
  },
};

export type DeepPartial<T> = { [K in keyof T]?: T[K] extends object ? (T[K] extends unknown[] ? T[K] : DeepPartial<T[K]>) : T[K] };

/** Object-valued keys that may be set back to null. */
const NULLABLE_KEYS = new Set(['home']);

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** Merge `patch` onto `base`, keeping only keys that exist in `base` and values of matching type. */
function mergeKnown<T>(base: T, patch: unknown): T {
  if (!isPlainObject(base) || !isPlainObject(patch)) return base;
  const out: Record<string, unknown> = { ...(base as Record<string, unknown>) };
  for (const [k, bv] of Object.entries(base as Record<string, unknown>)) {
    if (!(k in patch)) continue;
    const pv = patch[k];
    if (isPlainObject(bv)) out[k] = pv === null && NULLABLE_KEYS.has(k) ? null : mergeKnown(bv, pv);
    else if (bv === null) out[k] = pv === null || isPlainObject(pv) ? pv : bv; // nullable objects (home)
    else if (Array.isArray(bv)) out[k] = Array.isArray(pv) ? pv : bv;
    else if (typeof pv === typeof bv) out[k] = pv;
  }
  return out as T;
}

export class ConfigStore {
  private data: Config;
  private listeners = new Set<(cfg: Config, prev: Config) => void>();

  constructor(private readonly file: string) {
    this.data = this.load();
  }

  private load(): Config {
    try {
      const raw = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      return mergeKnown(structuredClone(DEFAULT_CONFIG), raw);
    } catch {
      return structuredClone(DEFAULT_CONFIG);
    }
  }

  get(): Config {
    return this.data;
  }

  update(patch: DeepPartial<Config>): Config {
    const prev = this.data;
    this.data = mergeKnown(structuredClone(prev), patch);
    this.save();
    for (const l of this.listeners) {
      try {
        l(this.data, prev);
      } catch (e) {
        console.error('config listener failed', e);
      }
    }
    return this.data;
  }

  onChange(listener: (cfg: Config, prev: Config) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private save(): void {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const tmp = `${this.file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(this.data, null, 2));
    fs.renameSync(tmp, this.file);
  }
}
