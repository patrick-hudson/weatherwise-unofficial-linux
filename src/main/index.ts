import { app, BrowserWindow, clipboard, dialog, ipcMain, powerMonitor, session, shell } from 'electron';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { AlertService, type ActiveAlert } from './alerts';
import { setAutostart } from './autostart';
import { randomUUID } from 'node:crypto';
import { ConfigStore, type Config, type DeepPartial, type Place } from './config';
import { searchLocation } from './geocode';
import { LocationService } from './geo';
import { normalizeAppUrl } from './nav';
import {
  alertSoundPath,
  alertStateFile,
  configFile,
  dataDir,
  iconPath,
  locationCacheFile,
  preloadDir,
  rendererDir,
  SITE_ORIGIN,
} from './paths';
import { AppTray } from './tray';
import { Updater } from './updater';
import { MainWindow, PARTITION } from './window';

// ------------------------------------------------------------------ early setup
app.setName('WeatherWise');
app.setPath('userData', path.join(dataDir, 'electron'));
fs.mkdirSync(dataDir, { recursive: true });

const config = new ConfigStore(configFile);
const startCfg = config.get();

// Chromium switches (must be set before 'ready').
app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');
if (startCfg.advanced.ozonePlatform !== 'auto') app.commandLine.appendSwitch('ozone-platform', startCfg.advanced.ozonePlatform);
switch (startCfg.advanced.gpuMode) {
  case 'ignore-blocklist':
    app.commandLine.appendSwitch('ignore-gpu-blocklist');
    break;
  case 'nvidia':
    process.env.__NV_PRIME_RENDER_OFFLOAD = '1';
    process.env.__GLX_VENDOR_LIBRARY_NAME = 'nvidia';
    process.env.__VK_LAYER_NV_optimus = 'NVIDIA_only';
    app.commandLine.appendSwitch('ignore-gpu-blocklist');
    break;
  case 'disable-gpu':
    app.disableHardwareAcceleration();
    break;
}

/** A Chrome-like UA: drop Electron/app tokens, add our own small marker. */
function userAgent(cfg: Config): string {
  if (cfg.advanced.userAgentOverride.trim()) return cfg.advanced.userAgentOverride.trim();
  return app.userAgentFallback
    .replace(/\sElectron\/\S+/, '')
    .replace(/\s(WeatherWise|weatherwise-linux)\/\S+/gi, '')
    .concat(` WeatherWiseLinux/${app.getVersion()}`);
}

const startHidden = process.argv.includes('--hidden');
const argvUrl = (argv: string[]) => argv.map(normalizeAppUrl).find((u): u is string => !!u) ?? null;

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', (_e, argv) => {
    const url = argvUrl(argv);
    if (url) mainWindow.loadUrl(url);
    else mainWindow.show();
  });
  app.whenReady().then(main);
}

// ------------------------------------------------------------------ app objects
const location = new LocationService(() => config.get(), locationCacheFile);
let tray: AppTray;
let alerts: AlertService;
let settingsWin: BrowserWindow | null = null;
let updater: Updater;
const alertWins = new Map<string, BrowserWindow>();

const mainWindow = new MainWindow(config, {
  openSettings: () => openSettings(),
  quit: () => quit(),
  hasTray: () => !!tray?.available,
  onVisibilityChanged: () => tray?.rebuild(),
  getAlerts: () => (alerts ? alerts.getActive() : []),
  showAlert: (a) => showAlertDetails(a),
});

function quit(): void {
  mainWindow.quitting = true;
  mainWindow.saveState();
  app.quit();
}

// ------------------------------------------------------------------ local windows
function localWindow(file: string, opts: Electron.BrowserWindowConstructorOptions, query?: Record<string, string>): BrowserWindow {
  const w = new BrowserWindow({
    icon: iconPath,
    backgroundColor: '#17274f',
    autoHideMenuBar: true,
    show: false,
    ...opts,
    webPreferences: {
      preload: path.join(preloadDir, 'local.js'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
    },
  });
  w.setMenuBarVisibility(false);
  w.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/.test(url)) shell.openExternal(url).catch(() => {});
    return { action: 'deny' };
  });
  w.webContents.on('will-navigate', (e) => e.preventDefault());
  w.once('ready-to-show', () => w.show());
  w.loadFile(path.join(rendererDir, file), { query }).catch(() => {});
  return w;
}

function openSettings(): void {
  if (settingsWin && !settingsWin.isDestroyed()) {
    settingsWin.show();
    settingsWin.focus();
    return;
  }
  settingsWin = localWindow('settings.html', { title: 'WeatherWise Settings', width: 760, height: 820, minWidth: 560, minHeight: 500 });
  settingsWin.on('closed', () => (settingsWin = null));
}

function showAlertDetails(a: ActiveAlert): void {
  const existing = alertWins.get(a.id);
  if (existing && !existing.isDestroyed()) {
    existing.show();
    existing.focus();
    return;
  }
  const w = localWindow('alert.html', { title: a.event, width: 680, height: 760 }, { id: a.id });
  alertWins.set(a.id, w);
  w.on('closed', () => alertWins.delete(a.id));
}

function openMapForAlert(a: ActiveAlert): void {
  const c = a.centroid ?? { lat: a.location.lat, lon: a.location.lon };
  mainWindow.panTo(c.lat, c.lon);
}

async function openLinkFromClipboard(): Promise<void> {
  const url = normalizeAppUrl(await clipboard.readText());
  if (url) {
    mainWindow.loadUrl(url);
    return;
  }
  dialog
    .showMessageBox({
      type: 'info',
      title: 'Open WeatherWise Link',
      message: 'No WeatherWise link on the clipboard',
      detail: 'Copy a link that starts with https://web.weatherwise.app/ (for example from a password-reset email), then try again.',
    })
    .catch(() => {});
}

// ------------------------------------------------------------------ session
function setupSession(): void {
  const ses = session.fromPartition(PARTITION);
  ses.setUserAgent(userAgent(config.get()));
  ses.setSpellCheckerEnabled(false);

  const allowed = new Set(['geolocation', 'notifications', 'clipboard-sanitized-write', 'fullscreen', 'pointerLock', 'persistent-storage', 'storage-access', 'top-level-storage-access', 'screen-wake-lock']);
  ses.setPermissionRequestHandler((_wc, permission, cb, details) => {
    const origin = details.requestingUrl ?? '';
    if (permission === 'openExternal') {
      const ext = (details as Electron.OpenExternalPermissionRequest).externalURL;
      if (ext) shell.openExternal(ext).catch(() => {});
      return cb(false);
    }
    if (permission === 'geolocation') return cb(config.get().location.useDeviceLocation || !!config.get().location.home);
    cb(allowed.has(permission) && /^https:\/\//.test(origin));
  });
  ses.setPermissionCheckHandler((_wc, permission, origin) => {
    if (permission === 'geolocation') return true;
    return allowed.has(permission) && origin.startsWith('https://');
  });
  // Downloads (e.g. "save image"): ask where to save.
  ses.on('will-download', (_e, item) => {
    item.setSaveDialogOptions({ title: 'Save File', defaultPath: path.join(app.getPath('downloads'), item.getFilename()) });
  });
}

// ------------------------------------------------------------------ IPC
function setupIpc(): void {
  const fromLocal = (e: Electron.IpcMainInvokeEvent) => e.senderFrame?.url.startsWith('file:') ?? false;
  const fromSite = (e: Electron.IpcMainInvokeEvent) => e.senderFrame?.url.startsWith(SITE_ORIGIN) ?? false;
  const local = <A extends unknown[], R>(fn: (...args: A) => R) =>
    (e: Electron.IpcMainInvokeEvent, ...args: A): R | null => (fromLocal(e) ? fn(...args) : null);

  // Site + local
  ipcMain.handle('geo:get', async (e) => {
    if (!fromSite(e) && !fromLocal(e)) return null;
    const fix = await location.getFix();
    return fix ? { lat: fix.lat, lon: fix.lon, accuracy: fix.accuracy, timestamp: fix.timestamp, source: fix.source } : null;
  });
  ipcMain.handle('share', (e, data: { url?: string; text?: string; title?: string }) => {
    if (!fromSite(e)) return false;
    const s = [data?.text, data?.url].filter((x) => typeof x === 'string' && x).join(' ');
    if (!s) return false;
    clipboard.writeText(s);
    return true;
  });

  ipcMain.handle('places:save', (e, p: { name?: unknown; lat?: unknown; lon?: unknown; zoom?: unknown }) => {
    if (!fromSite(e)) return null;
    const lat = Number(p?.lat);
    const lon = Number(p?.lon);
    if (!Number.isFinite(lat) || !Number.isFinite(lon) || Math.abs(lat) > 90 || Math.abs(lon) > 180) throw new Error('bad coordinates');
    const zoom = Number.isFinite(Number(p?.zoom)) ? Math.min(18, Math.max(3, Number(p.zoom))) : config.get().map.alertZoom;
    const place: Place = {
      id: randomUUID(),
      name: String(p?.name ?? '').trim().slice(0, 80) || `${lat.toFixed(3)}, ${lon.toFixed(3)}`,
      lat: Math.round(lat * 10000) / 10000,
      lon: Math.round(lon * 10000) / 10000,
      zoom,
      alerts: false,
    };
    config.update({ places: [...config.get().places, place] });
    return place;
  });

  ipcMain.handle('location:set-home', (e, p: { name?: unknown; lat?: unknown; lon?: unknown }) => {
    if (!fromSite(e) && !fromLocal(e)) return false;
    const lat = Number(p?.lat);
    const lon = Number(p?.lon);
    if (!Number.isFinite(lat) || !Number.isFinite(lon) || Math.abs(lat) > 90 || Math.abs(lon) > 180) return false;
    config.update({ location: { home: { name: String(p?.name ?? 'Home').slice(0, 80) || 'Home', lat, lon }, useDeviceLocation: false } });
    return true;
  });

  // Address / town search for setting your location (only the typed text is sent).
  ipcMain.handle('geo:search', local((q: string) => searchLocation(q)));

  // WeatherWise (site) preferences, mirrored in Settings.
  ipcMain.handle('wwprefs:get', local(() => mainWindow.siteEval('window.__wwPrefs ? window.__wwPrefs.get() : null')));
  ipcMain.handle(
    'wwprefs:set',
    local((key: string, value: unknown) => mainWindow.siteEval(`window.__wwPrefs ? window.__wwPrefs.set(${JSON.stringify(String(key))}, ${JSON.stringify(value)}) : false`)),
  );
  ipcMain.handle(
    'wwprefs:open',
    local((label: string) => {
      const allowed = ['My Preferences', 'Map Settings', 'Keyboard Shortcuts'];
      if (!allowed.includes(label)) return false;
      mainWindow.show();
      return mainWindow.siteEval(`window.__wwPrefs ? window.__wwPrefs.open(${JSON.stringify(label)}) : false`);
    }),
  );
  ipcMain.on('wwprefs:changed', (e, snap) => {
    if (!e.senderFrame?.url.startsWith(SITE_ORIGIN)) return;
    if (settingsWin && !settingsWin.isDestroyed()) settingsWin.webContents.send('wwprefs:changed', snap);
  });

  ipcMain.handle('places:list', (e) => (fromSite(e) || fromLocal(e) ? config.get().places : []));
  ipcMain.handle('places:remove', (e, id: string) => {
    if (!fromSite(e)) return false;
    config.update({ places: config.get().places.filter((p) => p.id !== id) });
    return true;
  });
  ipcMain.handle('places:alerts', (e, id: string, on: boolean) => {
    if (!fromSite(e)) return false;
    config.update({ places: config.get().places.map((p) => (p.id === id ? { ...p, alerts: !!on } : p)) });
    return true;
  });

  // Local pages only
  ipcMain.handle('config:get', local(() => config.get()));
  ipcMain.handle('config:set', local((patch: DeepPartial<Config>) => config.update(patch)));
  ipcMain.handle('map:center', local(() => mainWindow.getMapCenter()));
  ipcMain.handle('alerts:test', local(() => alerts.sendTestAlert()));
  ipcMain.handle('alerts:refresh', local(() => alerts.refreshNow()));
  ipcMain.handle('alerts:active', local(() => alerts.getActive()));
  ipcMain.handle('alerts:get', local((id: string) => alerts.getActive().find((a) => a.id === id) ?? lastShown.get(id) ?? null));
  ipcMain.handle('map:open-at', local((lat: number, lon: number, zoom?: number) => mainWindow.panTo(lat, lon, typeof zoom === 'number' ? zoom : undefined)));
  ipcMain.handle('open-external', local((url: string) => (/^(https?|mailto):/.test(url) ? shell.openExternal(url) : undefined)));
  ipcMain.handle('site:retry', local(() => mainWindow.retry()));
  ipcMain.handle(
    'dialog:pick-sound',
    local(async () => {
      const r = await dialog.showOpenDialog({ title: 'Choose Alert Sound', properties: ['openFile'], filters: [{ name: 'Audio', extensions: ['wav', 'ogg', 'oga', 'mp3', 'flac'] }] });
      return r.canceled ? null : r.filePaths[0];
    }),
  );
  ipcMain.handle('update:check', local(() => updater.check(false)));
  ipcMain.handle('update:install', local(() => updater.installNow()));
  ipcMain.handle('update:open-release', local(() => updater.openReleasePage()));
  ipcMain.handle('update:state', local(() => ({ ...updater.get(), canSelfUpdate: updater.canSelfUpdate })));
  ipcMain.handle('app:info', local(() => ({ version: app.getVersion(), electron: process.versions.electron, chrome: process.versions.chrome, configFile, ozone: process.env.XDG_SESSION_TYPE })));
  ipcMain.handle(
    'app:relaunch',
    local(() => {
      app.relaunch();
      quit();
    }),
  );
}

/** Saved places with alerts turned on feed the alert service's extra locations. */
function syncAlertPlaces(): void {
  const want = config.get().places.filter((p) => p.alerts).map((p) => ({ name: p.name, lat: p.lat, lon: p.lon }));
  if (JSON.stringify(want) !== JSON.stringify(config.get().alerts.extraLocations)) config.update({ alerts: { extraLocations: want } });
}

/** Keep alerts that were shown so detail windows still work after they expire. */
const lastShown = new Map<string, ActiveAlert>();

// ------------------------------------------------------------------ main
function main(): void {
  setupSession();
  setupIpc();

  updater = new Updater(config);
  updater.onChange((st) => {
    if (settingsWin && !settingsWin.isDestroyed()) settingsWin.webContents.send('update:state', { ...st, canSelfUpdate: updater.canSelfUpdate });
  });
  updater.start();

  tray = new AppTray(config, {
    checkForUpdates: () => void updater.check(true),
    toggleWindow: () => mainWindow.toggle(),
    isWindowVisible: () => mainWindow.isVisible(),
    reload: () => (mainWindow.exists ? mainWindow.reload(false) : mainWindow.show()),
    openSettings,
    openLinkFromClipboard: () => void openLinkFromClipboard(),
    refreshAlerts: () => void alerts.refreshNow(),
    showAlert: showAlertDetails,
    setAlwaysOnTop: (v) => mainWindow.setAlwaysOnTop(v),
    quit,
  });
  tray.create();

  alerts = new AlertService({
    getConfig: () => config.get(),
    onConfigChange: (cb) => config.onChange(cb),
    getCurrentLocation: () => location.getPoint(),
    stateFile: alertStateFile,
    defaultSoundFile: alertSoundPath,
    appVersion: app.getVersion(),
    iconPath,
    onOpenMap: openMapForAlert,
    onShowDetails: (a) => {
      lastShown.set(a.id, a);
      showAlertDetails(a);
    },
    onActiveAlertsChanged: (list) => {
      for (const a of list) lastShown.set(a.id, a);
      tray.setAlerts(list);
      mainWindow.pushTitlebarState();
    },
    onStatus: (s) => tray.setStatus(s),
  });
  alerts.start();
  // Refresh (and save) the device location every launch.
  void location.getFix();

  const cfg = config.get();
  const hidden = (startHidden || cfg.general.startMinimized) && tray.available;
  const url = argvUrl(process.argv) ?? undefined;
  if (!hidden) mainWindow.create(true, url);
  else if (url) mainWindow.create(true, url);

  setAutostart(cfg.general.autostart);
  syncAlertPlaces();
  config.onChange((next, prev) => {
    if (JSON.stringify(next.location) !== JSON.stringify(prev.location)) mainWindow.sendToSite('geo:changed', null);
    if (JSON.stringify(next.places) !== JSON.stringify(prev.places)) {
      syncAlertPlaces();
      mainWindow.sendToSite('places:changed', next.places);
    }
    if (settingsWin && !settingsWin.isDestroyed()) settingsWin.webContents.send('config:changed', next);
    if (next.general.autostart !== prev.general.autostart) setAutostart(next.general.autostart);
    if (next.advanced.userAgentOverride !== prev.advanced.userAgentOverride) session.fromPartition(PARTITION).setUserAgent(userAgent(next));
    if (next.general.alwaysOnTop !== prev.general.alwaysOnTop) mainWindow.setAlwaysOnTop(next.general.alwaysOnTop);
    tray.rebuild();
  });

  powerMonitor.on('resume', () => {
    mainWindow.markStale();
    setTimeout(() => void alerts.refreshNow(), 5000);
  });
}

app.on('window-all-closed', () => {
  // Keep running for tray + alerts unless there's no tray to come back from.
  if (!tray?.available) quit();
});
app.on('before-quit', () => {
  mainWindow.quitting = true;
  alerts?.stop();
  updater?.stop();
  location.stop();
});
