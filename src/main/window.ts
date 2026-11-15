import {
  app,
  BaseWindow,
  BrowserWindow,
  clipboard,
  dialog,
  ipcMain,
  Menu,
  MenuItemConstructorOptions,
  net,
  screen,
  shell,
  WebContents,
  WebContentsView,
} from 'electron';
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { ActiveAlert } from './alerts';
import type { ConfigStore } from './config';
import { classifyUrl } from './nav';
import { iconPath, preloadDir, rendererDir, sessionFile, SITE_ORIGIN, SITE_URL, windowStateFile } from './paths';

export const PARTITION = 'persist:weatherwise';
const BG = '#17274f';
const TITLEBAR_HEIGHT = 38;

interface WindowState {
  x?: number;
  y?: number;
  width: number;
  height: number;
  maximized: boolean;
  fullscreen: boolean;
}

function loadState(): WindowState {
  try {
    const s = JSON.parse(fs.readFileSync(windowStateFile, 'utf8')) as WindowState;
    if (typeof s.width === 'number' && typeof s.height === 'number') return s;
  } catch {
    /* default */
  }
  return { width: 1400, height: 900, maximized: false, fullscreen: false };
}

function visibleOnSomeDisplay(s: WindowState): boolean {
  if (s.x === undefined || s.y === undefined) return false;
  return screen.getAllDisplays().some((d) => {
    const a = d.workArea;
    return s.x! < a.x + a.width - 50 && s.x! + s.width > a.x + 50 && s.y! < a.y + a.height - 50 && s.y! + s.height > a.y + 20;
  });
}

export interface MainWindowHooks {
  openSettings(): void;
  quit(): void;
  /** True if a tray icon exists to restore the window from. */
  hasTray(): boolean;
  onVisibilityChanged(): void;
  getAlerts(): ActiveAlert[];
  showAlert(a: ActiveAlert): void;
}

export interface TitlebarState {
  title: string;
  maximized: boolean;
  focused: boolean;
  fullscreen: boolean;
  canGoBack: boolean;
  canGoForward: boolean;
  loading: boolean;
  alerts: { count: number; top: string | null; severity: string | null };
  buttons: { left: string; right: string };
}

/** Window-button layout from KDE's kwinrc (Breeze default: menu left; minimize, maximize, close right). */
let cachedLayout: { left: string; right: string } | null = null;
function kwinButtonLayout(): { left: string; right: string } {
  if (cachedLayout) return cachedLayout;
  const layout = { left: 'M', right: 'IAX' };
  try {
    const home = process.env.XDG_CONFIG_HOME || path.join(app.getPath('home'), '.config');
    const text = fs.readFileSync(path.join(home, 'kwinrc'), 'utf8');
    const section = /\[org\.kde\.kdecoration2\]([^[]*)/.exec(text)?.[1] ?? '';
    const keep = (v: string) => [...v].filter((c) => 'MIAX'.includes(c)).join('');
    const l = /^ButtonsOnLeft=(.*)$/m.exec(section)?.[1];
    const r = /^ButtonsOnRight=(.*)$/m.exec(section)?.[1];
    if (l !== undefined) layout.left = keep(l);
    if (r !== undefined) layout.right = keep(r);
  } catch {
    /* defaults */
  }
  cachedLayout = layout;
  return layout;
}

/**
 * The main window: a frameless BaseWindow holding two views — our own
 * titlebar (local page) on top and the WeatherWise site below it.
 */
export class MainWindow {
  win: BaseWindow | null = null;
  site: WebContentsView | null = null;
  bar: WebContentsView | null = null;
  private hiddenAt = 0;
  private stale = false;
  private loading = false;
  private unloadTimer: NodeJS.Timeout | null = null;
  private offlineTimer: NodeJS.Timeout | null = null;
  private saveTimer: NodeJS.Timeout | null = null;
  private lastUrl: string | null = null;
  private pendingPan: { lat: number; lon: number; zoom?: number } | null = null;
  private sessionTimer: NodeJS.Timeout | null = null;
  private savedHash: string | null = null;
  quitting = false;

  constructor(
    private readonly config: ConfigStore,
    private readonly hooks: MainWindowHooks,
  ) {
    this.setupTitlebarIpc();
    try {
      const h = JSON.parse(fs.readFileSync(sessionFile, 'utf8')).hash;
      if (typeof h === 'string' && h.length < 4000) this.savedHash = h;
    } catch {
      /* first run */
    }
  }

  /** Where the map opens: the last saved view (position, zoom, layers) or the default. */
  private startUrl(): string {
    if (this.config.get().map.restoreLastView && this.savedHash) return `${SITE_URL}#${this.savedHash}`;
    return SITE_URL;
  }

  /** Remember the map view; the site keeps it in the URL hash of the root page. */
  private rememberView(url: string): void {
    let u: URL;
    try {
      u = new URL(url);
    } catch {
      return;
    }
    if (u.origin !== SITE_ORIGIN || u.pathname !== '/' || !u.hash.includes('map=')) return;
    const hash = u.hash.slice(1);
    if (hash === this.savedHash) return;
    this.savedHash = hash;
    if (this.sessionTimer) clearTimeout(this.sessionTimer);
    this.sessionTimer = setTimeout(() => this.saveSession(), 2000);
  }

  saveSession(): void {
    if (this.sessionTimer) clearTimeout(this.sessionTimer);
    this.sessionTimer = null;
    if (!this.savedHash) return;
    try {
      fs.mkdirSync(path.dirname(sessionFile), { recursive: true });
      fs.writeFileSync(sessionFile, JSON.stringify({ hash: this.savedHash, savedAt: new Date().toISOString() }));
    } catch (e) {
      console.warn('[window] failed to save session', e);
    }
  }

  get exists(): boolean {
    return !!this.win && !this.win.isDestroyed();
  }

  private get wc(): WebContents | null {
    return this.exists && this.site && !this.site.webContents.isDestroyed() ? this.site.webContents : null;
  }

  isVisible(): boolean {
    return this.exists && this.win!.isVisible() && !this.win!.isMinimized();
  }

  create(show: boolean, url?: string): BaseWindow {
    cachedLayout = null;
    const cfg = this.config.get();
    const st = loadState();
    const placed = visibleOnSomeDisplay(st);
    const win = new BaseWindow({
      title: 'WeatherWise',
      icon: iconPath,
      width: st.width,
      height: st.height,
      x: placed ? st.x : undefined,
      y: placed ? st.y : undefined,
      minWidth: 900,
      minHeight: 600,
      show: false,
      frame: false,
      backgroundColor: BG,
      alwaysOnTop: cfg.general.alwaysOnTop,
    });
    this.win = win;
    Menu.setApplicationMenu(null);

    const bar = new WebContentsView({
      webPreferences: {
        preload: path.join(preloadDir, 'titlebar.js'),
        contextIsolation: true,
        sandbox: true,
        nodeIntegration: false,
        spellcheck: false,
      },
    });
    bar.setBackgroundColor(BG);
    const site = new WebContentsView({
      webPreferences: {
        preload: path.join(preloadDir, 'site.js'),
        partition: PARTITION,
        contextIsolation: true,
        sandbox: true,
        nodeIntegration: false,
        spellcheck: false,
        backgroundThrottling: true,
        zoomFactor: cfg.general.zoom,
      },
    });
    site.setBackgroundColor(BG);
    win.contentView.addChildView(site);
    win.contentView.addChildView(bar);
    this.bar = bar;
    this.site = site;

    if (st.maximized) win.maximize();
    if (st.fullscreen) win.setFullScreen(true);
    this.layout();

    let shown = false;
    const showOnce = () => {
      if (shown || !show || win.isDestroyed()) return;
      shown = true;
      win.show();
      win.focus();
      site.webContents.focus();
    };
    bar.webContents.once('did-finish-load', () => {
      this.pushTitlebarState();
      showOnce();
    });
    setTimeout(showOnce, 3000);

    win.on('resize', () => this.layout());
    win.on('close', (e) => this.onClose(e));
    win.on('closed', () => {
      for (const v of [bar, site]) if (!v.webContents.isDestroyed()) v.webContents.close();
      if (this.win === win) {
        this.win = null;
        this.site = null;
        this.bar = null;
      }
      this.hooks.onVisibilityChanged();
    });
    win.on('hide', () => this.onHidden());
    win.on('minimize', () => this.onHidden());
    win.on('show', () => this.onShown());
    win.on('restore', () => this.onShown());
    for (const ev of ['maximize', 'unmaximize', 'enter-full-screen', 'leave-full-screen', 'focus', 'blur'] as const) {
      win.on(ev as any, () => {
        this.layout();
        this.pushTitlebarState();
      });
    }
    for (const ev of ['resize', 'move', 'maximize', 'unmaximize', 'enter-full-screen', 'leave-full-screen'] as const) {
      win.on(ev as any, () => this.scheduleSaveState());
    }

    bar.webContents.on('before-input-event', (e, input) => {
      if (input.type === 'keyDown' && this.handleShortcut(input)) e.preventDefault();
    });
    bar.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    bar.webContents.on('will-navigate', (e) => e.preventDefault());
    bar.webContents.loadFile(path.join(rendererDir, 'titlebar.html')).catch(() => {});

    this.wireSite(site.webContents);
    site.webContents.loadURL(url ?? this.lastUrl ?? this.startUrl()).catch(() => {});
    return win;
  }

  private layout(): void {
    if (!this.exists || !this.bar || !this.site) return;
    const [w, h] = this.win!.getContentSize();
    const tb = this.win!.isFullScreen() ? 0 : TITLEBAR_HEIGHT;
    this.bar.setVisible(tb > 0);
    this.bar.setBounds({ x: 0, y: 0, width: w, height: tb });
    this.site.setBounds({ x: 0, y: tb, width: w, height: Math.max(0, h - tb) });
  }

  // ---------------------------------------------------------------- titlebar
  private titlebarState(): TitlebarState {
    const wc = this.wc;
    const alerts = this.hooks.getAlerts();
    const rank: Record<string, number> = { Extreme: 4, Severe: 3, Moderate: 2, Minor: 1 };
    const top = alerts.slice().sort((a, b) => (rank[b.severity] ?? 0) - (rank[a.severity] ?? 0))[0];
    return {
      title: 'WeatherWise',
      maximized: !!this.win?.isMaximized(),
      focused: !!this.win?.isFocused(),
      fullscreen: !!this.win?.isFullScreen(),
      canGoBack: !!wc?.navigationHistory.canGoBack(),
      canGoForward: !!wc?.navigationHistory.canGoForward(),
      loading: this.loading,
      alerts: { count: alerts.length, top: top?.event ?? null, severity: top?.severity ?? null },
      buttons: kwinButtonLayout(),
    };
  }

  pushTitlebarState(): void {
    const b = this.bar?.webContents;
    if (b && !b.isDestroyed()) b.send('tb:state', this.titlebarState());
  }

  private setupTitlebarIpc(): void {
    ipcMain.on('tb:action', (e, action: string, arg?: { x: number; y: number }) => {
      if (!this.bar || e.sender !== this.bar.webContents || !this.exists) return;
      const win = this.win!;
      switch (action) {
        case 'minimize':
          win.minimize();
          break;
        case 'maximize':
          if (win.isMaximized()) win.unmaximize();
          else win.maximize();
          break;
        case 'close':
          win.close();
          break;
        case 'back':
          this.wc?.navigationHistory.goBack();
          break;
        case 'forward':
          this.wc?.navigationHistory.goForward();
          break;
        case 'reload':
          this.reload(false);
          break;
        case 'home':
          this.loadUrl(SITE_URL);
          break;
        case 'settings':
          this.hooks.openSettings();
          break;
        case 'alerts':
          this.popupAlerts(arg);
          break;
        case 'menu':
          this.popupAppMenu(arg);
          break;
        case 'places':
          this.popupPlaces(arg);
          break;
      }
    });
    ipcMain.handle('tb:get-state', (e) => (this.bar && e.sender === this.bar.webContents ? this.titlebarState() : null));
  }

  private popupAlerts(at?: { x: number; y: number }): void {
    const alerts = this.hooks.getAlerts();
    const items: MenuItemConstructorOptions[] = alerts.length
      ? alerts.slice(0, 15).map((a) => ({ label: `${a.event} — ${a.areaDesc.length > 50 ? `${a.areaDesc.slice(0, 49)}…` : a.areaDesc}`, click: () => this.hooks.showAlert(a) }))
      : [{ label: 'No active alerts', enabled: false }];
    Menu.buildFromTemplate(items).popup({ window: this.win!, x: at?.x, y: at?.y });
  }

  private popupPlaces(at?: { x: number; y: number }): void {
    const places = this.config.get().places;
    const items: MenuItemConstructorOptions[] = places.length
      ? places.map((p) => ({ label: p.alerts ? `${p.name}  🔔` : p.name, click: () => this.panTo(p.lat, p.lon, p.zoom) }))
      : [{ label: 'No saved places yet', enabled: false }, { label: 'Right-click the map → Save Location', enabled: false }];
    items.push(
      { type: 'separator' },
      { label: 'Save Current View…', accelerator: 'Ctrl+D', click: () => this.promptSaveCurrentView() },
      { label: 'Manage Places…', click: () => this.hooks.openSettings() },
    );
    Menu.buildFromTemplate(items).popup({ window: this.win!, x: at?.x, y: at?.y });
  }

  /** Ask the page to show the "Save location" dialog for the current map center. */
  promptSaveCurrentView(): void {
    const c = this.getMapCenter();
    const wc = this.wc;
    if (!c || !wc || !wc.getURL().startsWith('https://')) return;
    wc.send('places:prompt', { lat: c.lat, lon: c.lon, zoom: Math.round(c.zoom * 10) / 10 });
  }

  private popupAppMenu(at?: { x: number; y: number }): void {
    const win = this.win!;
    const cfg = this.config.get();
    const items: MenuItemConstructorOptions[] = [
      { label: 'Home', click: () => this.loadUrl(SITE_URL) },
      { label: 'Reload', accelerator: 'F5', click: () => this.reload(false) },
      { label: 'Hard Reload', accelerator: 'Ctrl+Shift+R', click: () => this.reload(true) },
      { type: 'separator' },
      { label: 'Zoom In', accelerator: 'Ctrl+=', click: () => this.zoomBy(0.1) },
      { label: 'Zoom Out', accelerator: 'Ctrl+-', click: () => this.zoomBy(-0.1) },
      { label: `Actual Size (${Math.round(cfg.general.zoom * 100)}%)`, accelerator: 'Ctrl+0', click: () => this.setZoom(1) },
      { label: 'Full Screen', accelerator: 'F11', type: 'checkbox', checked: win.isFullScreen(), click: () => win.setFullScreen(!win.isFullScreen()) },
      {
        label: 'Always on Top',
        type: 'checkbox',
        checked: cfg.general.alwaysOnTop,
        click: (i) => {
          this.config.update({ general: { alwaysOnTop: i.checked } });
          win.setAlwaysOnTop(i.checked);
        },
      },
      { type: 'separator' },
      { label: 'Copy Page Link', click: () => this.wc && clipboard.writeText(this.wc.getURL()) },
      { label: 'Open Page in Browser', click: () => this.wc && shell.openExternal(this.wc.getURL()).catch(() => {}) },
      { type: 'separator' },
      { label: 'Settings…', accelerator: 'Ctrl+,', click: () => this.hooks.openSettings() },
    ];
    if (this.devtoolsAllowed()) items.push({ label: 'Developer Tools', accelerator: 'Ctrl+Shift+I', click: () => this.wc?.toggleDevTools() });
    items.push({ type: 'separator' }, { label: 'Quit WeatherWise', accelerator: 'Ctrl+Q', click: () => this.hooks.quit() });
    Menu.buildFromTemplate(items).popup({ window: win, x: at?.x, y: at?.y });
  }

  // ---------------------------------------------------------------- site
  private wireSite(wc: WebContents): void {
    wc.setWindowOpenHandler(({ url }) => {
      const kind = classifyUrl(url, this.config.get());
      if (kind === 'app') {
        this.loadUrl(url);
        return { action: 'deny' };
      }
      if (kind === 'hazcam') {
        if (this.config.get().links.hazcamsInApp) return { action: 'allow', overrideBrowserWindowOptions: this.childOptions(1100, 760) };
        shell.openExternal(url).catch(() => {});
        return { action: 'deny' };
      }
      if (kind === 'inapp-popup') return { action: 'allow', overrideBrowserWindowOptions: this.childOptions(560, 720) };
      if (kind === 'external') shell.openExternal(url).catch(() => {});
      return { action: 'deny' };
    });
    wc.on('did-create-window', (child) => {
      child.setMenuBarVisibility(false);
      this.wireChild(child.webContents);
    });

    wc.on('will-navigate', (e, url) => {
      const kind = classifyUrl(url, this.config.get());
      if (kind === 'app' || kind === 'inapp-popup') return;
      e.preventDefault();
      if (kind === 'external' || kind === 'hazcam') shell.openExternal(url).catch(() => {});
    });

    wc.on('did-fail-load', (_e, code, desc, url, isMainFrame) => {
      // -3 = aborted (e.g. superseded navigation)
      if (!isMainFrame || code === -3 || url.startsWith('file:')) return;
      console.warn(`[window] load failed ${code} ${desc} ${url}`);
      this.showOffline(url, desc);
    });
    wc.on('did-start-loading', () => {
      this.loading = true;
      this.pushTitlebarState();
    });
    wc.on('did-stop-loading', () => {
      this.loading = false;
      this.pushTitlebarState();
    });
    wc.on('did-navigate', (_e, url) => {
      if (url.startsWith('https://')) this.lastUrl = url;
      this.rememberView(url);
      this.pushTitlebarState();
    });
    wc.on('did-navigate-in-page', (_e, url, isMainFrame) => {
      if (isMainFrame && url.startsWith('https://')) this.lastUrl = url;
      if (isMainFrame) this.rememberView(url);
      this.pushTitlebarState();
    });
    wc.on('did-finish-load', () => {
      if (this.pendingPan) {
        const p = this.pendingPan;
        this.pendingPan = null;
        setTimeout(() => this.panTo(p.lat, p.lon, p.zoom), 2500);
      }
    });
    wc.on('render-process-gone', (_e, details) => {
      console.warn('[window] renderer gone', details.reason);
      if (details.reason !== 'clean-exit') setTimeout(() => this.wc?.reload(), 1000);
    });
    wc.on('zoom-changed', (_e, dir) => this.zoomBy(dir === 'in' ? 0.1 : -0.1));
    wc.on('before-input-event', (e, input) => {
      if (input.type !== 'keyDown') return;
      if (this.handleShortcut(input)) e.preventDefault();
    });
    wc.on('context-menu', (_e, params) => this.showContextMenu(wc, params));
  }

  private wireChild(wc: WebContents): void {
    wc.setWindowOpenHandler(({ url }) => {
      const kind = classifyUrl(url, this.config.get());
      if (kind === 'inapp-popup' || kind === 'hazcam') return { action: 'allow', overrideBrowserWindowOptions: this.childOptions(560, 720) };
      if (kind === 'app') {
        this.loadUrl(url);
        return { action: 'deny' };
      }
      if (kind === 'external') shell.openExternal(url).catch(() => {});
      return { action: 'deny' };
    });
    wc.on('context-menu', (_e, params) => this.showContextMenu(wc, params));
    wc.on('before-input-event', (e, input) => {
      if (input.type === 'keyDown' && input.key === 'Escape') {
        const w = BrowserWindow.fromWebContents(wc);
        if (w && !w.isFullScreen()) {
          e.preventDefault();
          w.close();
        }
      }
    });
  }

  private childOptions(width: number, height: number): Electron.BrowserWindowConstructorOptions {
    return {
      width,
      height,
      icon: iconPath,
      backgroundColor: BG,
      autoHideMenuBar: true,
      webPreferences: { partition: PARTITION, contextIsolation: true, sandbox: true, nodeIntegration: false },
    };
  }

  // ---------------------------------------------------------------- input
  private handleShortcut(i: Electron.Input): boolean {
    const ctrl = i.control || i.meta;
    const k = i.key;
    const lower = k.toLowerCase();
    if (k === 'F5' || (ctrl && !i.shift && lower === 'r')) return this.reload(false), true;
    if (ctrl && i.shift && lower === 'r') return this.reload(true), true;
    if (k === 'F11') {
      this.win?.setFullScreen(!this.win.isFullScreen());
      return true;
    }
    if (k === 'Escape' && this.win?.isFullScreen()) {
      this.win.setFullScreen(false);
      return false; // let the page see Escape too
    }
    if (ctrl && (k === '=' || k === '+')) return this.zoomBy(0.1), true;
    if (ctrl && (k === '-' || k === '_')) return this.zoomBy(-0.1), true;
    if (ctrl && k === '0') return this.setZoom(1), true;
    if (i.alt && k === 'ArrowLeft') return this.wc?.navigationHistory.goBack(), true;
    if (i.alt && k === 'ArrowRight') return this.wc?.navigationHistory.goForward(), true;
    if (ctrl && k === ',') return this.hooks.openSettings(), true;
    if (ctrl && !i.shift && lower === 'd') return this.promptSaveCurrentView(), true;
    if (ctrl && lower === 'q') return this.hooks.quit(), true;
    if (ctrl && !i.shift && lower === 'w') return this.win?.close(), true;
    if ((ctrl && i.shift && lower === 'i') || k === 'F12') {
      if (this.devtoolsAllowed()) this.wc?.toggleDevTools();
      return true;
    }
    return false;
  }

  private devtoolsAllowed(): boolean {
    return !app.isPackaged || this.config.get().advanced.devtools;
  }

  private showContextMenu(wc: WebContents, p: Electron.ContextMenuParams): void {
    const items: MenuItemConstructorOptions[] = [];
    if (p.linkURL) {
      items.push(
        { label: 'Open Link in Browser', click: () => shell.openExternal(p.linkURL).catch(() => {}) },
        { label: 'Copy Link', click: () => clipboard.writeText(p.linkURL) },
        { type: 'separator' },
      );
    }
    if (p.isEditable) {
      items.push({ role: 'cut' }, { role: 'copy' }, { role: 'paste' }, { role: 'selectAll' }, { type: 'separator' });
    } else if (p.selectionText) {
      items.push({ role: 'copy' }, { type: 'separator' });
    }
    if (p.mediaType === 'image' && p.srcURL) {
      items.push({ label: 'Copy Image', click: () => wc.copyImageAt(p.x, p.y) }, { type: 'separator' });
    }
    items.push(
      { label: 'Back', enabled: wc.navigationHistory.canGoBack(), click: () => wc.navigationHistory.goBack() },
      { label: 'Forward', enabled: wc.navigationHistory.canGoForward(), click: () => wc.navigationHistory.goForward() },
      { label: 'Reload', click: () => wc.reload() },
      { type: 'separator' },
      { label: 'Copy Page Link', click: () => clipboard.writeText(wc.getURL()) },
      { label: 'Open Page in Browser', click: () => shell.openExternal(wc.getURL()).catch(() => {}) },
      { type: 'separator' },
      { label: 'Settings…', click: () => this.hooks.openSettings() },
    );
    if (this.devtoolsAllowed()) items.push({ label: 'Inspect', click: () => wc.inspectElement(p.x, p.y) });
    Menu.buildFromTemplate(items).popup();
  }

  // ---------------------------------------------------------------- zoom
  zoomBy(delta: number): void {
    this.setZoom(Math.round((this.config.get().general.zoom + delta) * 10) / 10);
  }

  setZoom(z: number): void {
    const zoom = Math.min(3, Math.max(0.5, z));
    this.wc?.setZoomFactor(zoom);
    this.config.update({ general: { zoom } });
  }

  // ---------------------------------------------------------------- visibility
  show(): void {
    if (!this.exists) {
      this.create(true);
      this.hooks.onVisibilityChanged();
      return;
    }
    const w = this.win!;
    if (w.isMinimized()) w.restore();
    w.show();
    w.focus();
    this.wc?.focus();
  }

  hide(): void {
    if (this.exists) this.win!.hide();
  }

  toggle(): void {
    if (this.isVisible() && this.win!.isFocused()) this.hide();
    else this.show();
  }

  private onHidden(): void {
    this.hiddenAt = Date.now();
    const mins = this.config.get().general.unloadWhenHiddenMinutes;
    if (this.unloadTimer) clearTimeout(this.unloadTimer);
    if (mins > 0 && this.hooks.hasTray()) {
      this.unloadTimer = setTimeout(() => this.unload(), mins * 60_000);
    }
    this.hooks.onVisibilityChanged();
  }

  private onShown(): void {
    if (this.unloadTimer) clearTimeout(this.unloadTimer);
    this.unloadTimer = null;
    const mins = this.config.get().general.reloadWhenHiddenMinutes;
    const hiddenFor = this.hiddenAt ? Date.now() - this.hiddenAt : 0;
    if (this.stale || (mins > 0 && hiddenFor > mins * 60_000)) {
      this.stale = false;
      this.reload(false);
    }
    this.hiddenAt = 0;
    this.hooks.onVisibilityChanged();
  }

  /** Destroy the renderer to free memory/GPU while living in the tray. */
  unload(): void {
    if (!this.exists || this.isVisible()) return;
    console.log('[window] unloading hidden window');
    this.saveState();
    this.win!.destroy();
  }

  markStale(): void {
    if (this.isVisible()) this.reload(false);
    else this.stale = true;
  }

  // ---------------------------------------------------------------- close
  private async onClose(e: Electron.Event): Promise<void> {
    this.saveState();
    if (this.quitting) return;
    const cfg = this.config.get();
    let action = cfg.general.closeAction;
    if (action === 'quit') {
      this.hooks.quit();
      return;
    }
    e.preventDefault();
    if (action === 'ask') {
      const r = await dialog.showMessageBox(this.win!, {
        type: 'question',
        title: 'Close WeatherWise',
        message: 'Keep WeatherWise running in the background?',
        detail: 'In the background it keeps checking for severe weather alerts and shows a tray icon. You can change this later in Settings.',
        buttons: ['Keep Running', 'Quit', 'Cancel'],
        defaultId: 0,
        cancelId: 2,
        checkboxLabel: 'Remember my choice',
        checkboxChecked: true,
      });
      if (r.response === 2) return;
      action = r.response === 0 ? 'tray' : 'quit';
      if (r.checkboxChecked) this.config.update({ general: { closeAction: action } });
      if (action === 'quit') {
        this.hooks.quit();
        return;
      }
    }
    // tray
    if (this.hooks.hasTray()) this.win?.hide();
    else this.win?.minimize();
  }

  // ---------------------------------------------------------------- navigation
  reload(hard: boolean): void {
    const wc = this.wc;
    if (!wc) return;
    if (wc.getURL().startsWith('file:')) {
      this.loadUrl(this.lastUrl ?? SITE_URL);
      return;
    }
    if (hard) wc.reloadIgnoringCache();
    else wc.reload();
  }

  loadUrl(url: string): void {
    this.stopOfflineRetry();
    if (!this.exists) {
      this.create(true, url);
      this.hooks.onVisibilityChanged();
      return;
    }
    this.wc?.loadURL(url).catch(() => {});
    this.show();
  }

  getUrl(): string | null {
    return this.wc?.getURL() ?? this.lastUrl;
  }

  /**
   * Show the window and move the map. The site keeps the map position in the
   * URL hash (`#map=<zoom>/<lat>/<lon>&...`, mapbox-gl's hash option), and
   * mapbox follows hash changes, so we just rewrite that parameter.
   */
  panTo(lat: number, lon: number, zoom = this.config.get().map.alertZoom): void {
    if (!this.exists) {
      this.pendingPan = { lat, lon, zoom };
      this.create(true);
      this.hooks.onVisibilityChanged();
      return;
    }
    this.show();
    const wc = this.wc;
    if (!wc) return;
    const cur = wc.getURL();
    if (wc.isLoading() || !cur.startsWith('https://')) {
      this.pendingPan = { lat, lon, zoom };
      return;
    }
    const value = `${zoom}/${lat.toFixed(4)}/${lon.toFixed(4)}`;
    const js = `(() => {
      const p = new URLSearchParams(location.hash.slice(1));
      p.set('map', ${JSON.stringify(value)});
      location.hash = p.toString().replaceAll('%2F', '/');
      return true;
    })()`;
    wc.executeJavaScript(js, true).catch(() => {
      const u = new URL(SITE_URL);
      u.hash = `map=${value}`;
      wc.loadURL(u.toString()).catch(() => {});
    });
    wc.send('pan-to', { lat, lon, zoom });
  }

  /** Current map center, read from the site's URL hash. */
  getMapCenter(): { lat: number; lon: number; zoom: number } | null {
    const url = this.getUrl();
    if (!url) return null;
    try {
      const m = new URLSearchParams(new URL(url).hash.slice(1)).get('map');
      const [z, lat, lon] = (m ?? '').split('/').map(Number);
      if ([z, lat, lon].every(Number.isFinite)) return { zoom: z, lat, lon };
    } catch {
      /* ignore */
    }
    return null;
  }

  // ---------------------------------------------------------------- offline
  private showOffline(failedUrl: string, reason: string): void {
    const wc = this.wc;
    if (!wc) return;
    if (failedUrl.startsWith('https://')) this.lastUrl = failedUrl;
    wc.loadFile(path.join(rendererDir, 'offline.html'), { query: { reason } }).catch(() => {});
    this.stopOfflineRetry();
    this.offlineTimer = setInterval(async () => {
      try {
        const r = await net.fetch(SITE_URL, { method: 'HEAD', cache: 'no-store' });
        if (r.ok) this.retry();
      } catch {
        /* still offline */
      }
    }, 10_000);
  }

  private stopOfflineRetry(): void {
    if (this.offlineTimer) clearInterval(this.offlineTimer);
    this.offlineTimer = null;
  }

  retry(): void {
    this.stopOfflineRetry();
    this.wc?.loadURL(this.lastUrl ?? this.startUrl()).catch(() => {});
  }

  // ---------------------------------------------------------------- state
  private scheduleSaveState(): void {
    if (this.saveTimer) clearTimeout(this.saveTimer);
    this.saveTimer = setTimeout(() => this.saveState(), 800);
  }

  saveState(): void {
    this.saveSession();
    if (!this.exists) return;
    const w = this.win!;
    const b = w.getNormalBounds();
    const st: WindowState = { x: b.x, y: b.y, width: b.width, height: b.height, maximized: w.isMaximized(), fullscreen: w.isFullScreen() };
    try {
      fs.mkdirSync(path.dirname(windowStateFile), { recursive: true });
      fs.writeFileSync(windowStateFile, JSON.stringify(st));
    } catch (e) {
      console.warn('[window] failed to save state', e);
    }
  }

  setAlwaysOnTop(v: boolean): void {
    this.win?.setAlwaysOnTop(v);
  }

  /** Evaluate in the site page (main world); null if the map isn't open. */
  async siteEval(js: string): Promise<unknown> {
    const wc = this.wc;
    if (!wc || !wc.getURL().startsWith(SITE_ORIGIN)) return null;
    try {
      return await wc.executeJavaScript(js, true);
    } catch {
      return null;
    }
  }

  sendToSite(channel: string, data: unknown): void {
    const wc = this.wc;
    if (wc && wc.getURL().startsWith(SITE_ORIGIN)) wc.send(channel, data);
  }

  /** Whether `wc` is the site view (used to validate IPC from the site preload). */
  isSite(wc: WebContents): boolean {
    return this.wc === wc;
  }
}
