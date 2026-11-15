import { Menu, MenuItemConstructorOptions, nativeImage, Tray } from 'electron';
import type { ActiveAlert } from './alerts';
import type { ConfigStore } from './config';
import { trayAlertIconPath, trayIconPath } from './paths';

export interface TrayActions {
  toggleWindow(): void;
  isWindowVisible(): boolean;
  reload(): void;
  openSettings(): void;
  openLinkFromClipboard(): void;
  refreshAlerts(): void;
  showAlert(a: ActiveAlert): void;
  setAlwaysOnTop(v: boolean): void;
  quit(): void;
}

type AlertStatus = 'ok' | 'offline' | 'disabled' | 'no-location';

export class AppTray {
  private tray: Tray | null = null;
  private alerts: ActiveAlert[] = [];
  private status: AlertStatus = 'ok';

  constructor(
    private readonly config: ConfigStore,
    private readonly actions: TrayActions,
  ) {}

  create(): boolean {
    try {
      this.tray = new Tray(nativeImage.createFromPath(trayIconPath));
      this.tray.setToolTip('WeatherWise');
      this.tray.on('click', () => this.actions.toggleWindow());
      this.rebuild();
      return true;
    } catch (e) {
      console.warn('[tray] unavailable', e);
      this.tray = null;
      return false;
    }
  }

  get available(): boolean {
    return !!this.tray && !this.tray.isDestroyed();
  }

  setAlerts(alerts: ActiveAlert[]): void {
    this.alerts = alerts;
    this.rebuild();
  }

  setStatus(s: AlertStatus): void {
    if (s === this.status) return;
    this.status = s;
    this.rebuild();
  }

  rebuild(): void {
    if (!this.available) return;
    const cfg = this.config.get();
    const n = this.alerts.length;
    this.tray!.setImage(nativeImage.createFromPath(n > 0 ? trayAlertIconPath : trayIconPath));
    const statusText =
      this.status === 'offline'
        ? 'Alerts unavailable (offline)'
        : this.status === 'disabled'
          ? 'Alerts off'
          : this.status === 'no-location'
            ? 'Alerts: no location set'
            : n === 0
              ? 'No active alerts'
              : `${n} active alert${n === 1 ? '' : 's'}`;
    this.tray!.setToolTip(n > 0 ? `WeatherWise — ${this.alerts.map((a) => a.event).join(', ')}` : `WeatherWise — ${statusText}`);

    const alertItems: MenuItemConstructorOptions[] =
      n === 0
        ? [{ label: statusText, enabled: false }]
        : this.alerts.slice(0, 15).map((a) => ({
            label: `${a.event} — ${truncate(a.areaDesc, 48)}`,
            click: () => this.actions.showAlert(a),
          }));

    const tpl: MenuItemConstructorOptions[] = [
      { label: this.actions.isWindowVisible() ? 'Hide WeatherWise' : 'Show WeatherWise', click: () => this.actions.toggleWindow() },
      { label: 'Reload', click: () => this.actions.reload() },
      { type: 'separator' },
      { label: n > 0 ? `Active Alerts (${n})` : 'Active Alerts', submenu: alertItems },
      {
        label: 'Severe Weather Alerts',
        type: 'checkbox',
        checked: cfg.alerts.enabled,
        click: (item) => this.config.update({ alerts: { enabled: item.checked } }),
      },
      { label: 'Check for Alerts Now', enabled: cfg.alerts.enabled, click: () => this.actions.refreshAlerts() },
      { type: 'separator' },
      {
        label: 'Always on Top',
        type: 'checkbox',
        checked: cfg.general.alwaysOnTop,
        click: (item) => {
          this.config.update({ general: { alwaysOnTop: item.checked } });
          this.actions.setAlwaysOnTop(item.checked);
        },
      },
      { label: 'Open WeatherWise Link from Clipboard', click: () => this.actions.openLinkFromClipboard() },
      { label: 'Settings…', click: () => this.actions.openSettings() },
      { type: 'separator' },
      { label: 'Quit WeatherWise', click: () => this.actions.quit() },
    ];
    this.tray!.setContextMenu(Menu.buildFromTemplate(tpl));
  }

  destroy(): void {
    this.tray?.destroy();
    this.tray = null;
  }
}

function truncate(s: string, n: number): string {
  return s.length > n ? `${s.slice(0, n - 1)}…` : s;
}
