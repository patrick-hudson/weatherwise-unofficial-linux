import { app, dialog, shell } from 'electron';
import { autoUpdater, type UpdateInfo } from 'electron-updater';
import type { ConfigStore } from './config';

const RELEASES_URL = 'https://github.com/patrick-hudson/weatherwise-linux/releases/latest';
const CHECK_EVERY_MS = 6 * 60 * 60 * 1000;

export type UpdateState =
  | { state: 'idle' | 'checking' | 'none' | 'disabled' }
  | { state: 'available' | 'downloading' | 'ready'; version: string; percent?: number }
  | { state: 'error'; message: string };

/**
 * Updates come from GitHub Releases (built by .github/workflows/release.yml).
 *  - AppImage: electron-updater downloads the new AppImage in the background
 *    (differential, via the published blockmap) and swaps it on restart.
 *  - RPM / dev builds: we only announce new versions and link to the release.
 */
export class Updater {
  private timer: NodeJS.Timeout | null = null;
  private status: UpdateState = { state: 'idle' };
  private listeners = new Set<(s: UpdateState) => void>();
  private manual = false;
  /** Self-updating is only possible for the AppImage. */
  readonly canSelfUpdate = !!process.env.APPIMAGE;

  constructor(private readonly config: ConfigStore) {
    autoUpdater.autoDownload = this.canSelfUpdate;
    autoUpdater.autoInstallOnAppQuit = true;
    autoUpdater.allowPrerelease = false;
    autoUpdater.logger = null;

    autoUpdater.on('checking-for-update', () => this.set({ state: 'checking' }));
    autoUpdater.on('update-not-available', () => {
      this.set({ state: 'none' });
      if (this.manual) void dialog.showMessageBox({ type: 'info', title: 'WeatherWise', message: `You're up to date (${app.getVersion()}).` });
      this.manual = false;
    });
    autoUpdater.on('update-available', (info: UpdateInfo) => {
      this.set({ state: this.canSelfUpdate ? 'downloading' : 'available', version: info.version, percent: 0 });
      if (!this.canSelfUpdate) void this.announce(info.version);
      this.manual = false;
    });
    autoUpdater.on('download-progress', (p) => {
      const s = this.status;
      if (s.state === 'downloading') this.set({ ...s, percent: Math.round(p.percent) });
    });
    autoUpdater.on('update-downloaded', (info: UpdateInfo) => {
      this.set({ state: 'ready', version: info.version });
      void this.offerRestart(info.version);
    });
    autoUpdater.on('error', (err: Error) => {
      console.warn('[updater]', err.message);
      this.set({ state: 'error', message: err.message });
      if (this.manual) void dialog.showMessageBox({ type: 'warning', title: 'WeatherWise', message: 'Could not check for updates', detail: err.message });
      this.manual = false;
    });
  }

  get(): UpdateState {
    return this.status;
  }

  onChange(cb: (s: UpdateState) => void): void {
    this.listeners.add(cb);
  }

  private set(s: UpdateState): void {
    this.status = s;
    for (const l of this.listeners) l(s);
  }

  start(): void {
    if (!app.isPackaged) {
      this.set({ state: 'disabled' });
      return;
    }
    const tick = () => {
      if (this.config.get().general.autoUpdate) void this.check(false);
    };
    setTimeout(tick, 30_000); // after startup settles
    this.timer = setInterval(tick, CHECK_EVERY_MS);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
  }

  async check(manual: boolean): Promise<void> {
    if (!app.isPackaged) {
      if (manual) void dialog.showMessageBox({ type: 'info', title: 'WeatherWise', message: 'Updates are only available in the packaged app (AppImage or RPM).' });
      return;
    }
    if (this.status.state === 'ready') {
      if (manual) void this.offerRestart(this.status.version);
      return;
    }
    this.manual = manual;
    try {
      await autoUpdater.checkForUpdates();
    } catch {
      /* reported through the 'error' event */
    }
  }

  /** Restart into the downloaded update (AppImage only). */
  installNow(): boolean {
    if (this.status.state !== 'ready') return false;
    autoUpdater.quitAndInstall(false, true);
    return true;
  }

  /** Open the GitHub release page (RPM installs update from there). */
  openReleasePage(): void {
    void shell.openExternal(RELEASES_URL);
  }

  private async offerRestart(version: string): Promise<void> {
    const r = await dialog.showMessageBox({
      type: 'info',
      title: 'Update Ready',
      message: `WeatherWise ${version} is ready to install.`,
      detail: 'Restart now, or it will be installed the next time you quit.',
      buttons: ['Restart Now', 'Later'],
      defaultId: 0,
      cancelId: 1,
    });
    if (r.response === 0) autoUpdater.quitAndInstall(false, true);
  }

  private async announce(version: string): Promise<void> {
    const r = await dialog.showMessageBox({
      type: 'info',
      title: 'Update Available',
      message: `WeatherWise ${version} is available.`,
      detail: 'This install (RPM) is updated by downloading the new package from GitHub.',
      buttons: ['Open Download Page', 'Later'],
      defaultId: 0,
      cancelId: 1,
    });
    if (r.response === 0) void shell.openExternal(RELEASES_URL);
  }
}
