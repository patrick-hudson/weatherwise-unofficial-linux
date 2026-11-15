/**
 * Desktop notifications via freedesktop org.freedesktop.Notifications (@particle/dbus-next),
 * with a fallback to Electron's Notification class when D-Bus is unavailable.
 *
 * `electron` is required lazily (only in the fallback path) so the D-Bus path also
 * runs under plain Node.
 */
import * as dbus from '@particle/dbus-next';

const BUS_NAME = 'org.freedesktop.Notifications';
const OBJ_PATH = '/org/freedesktop/Notifications';
const IFACE = 'org.freedesktop.Notifications';
const DBUS_RETRY_MS = 5 * 60_000;

export interface NotifyContent {
  summary: string;
  body: string;
  /** Critical → urgency 2 and persistent (expire_timeout 0). */
  critical: boolean;
}

export interface NotifierOptions<T> {
  iconPath: string;
  appName?: string;
  desktopEntry?: string;
  onOpenMap(item: T): void;
  onShowDetails(item: T): void;
}

/** Escape &, <, > for notification bodies (KDE/GNOME parse a markup subset). */
export function escapeBody(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

type DbusIface = dbus.ClientInterface;

export class Notifier<T> {
  private bus: dbus.MessageBus | null = null;
  private iface: DbusIface | null = null;
  private connecting: Promise<DbusIface | null> | null = null;
  /** Time of last D-Bus connect failure (retry after DBUS_RETRY_MS). */
  private dbusFailedAt = 0;
  /** D-Bus notification id → item */
  private byId = new Map<number, { key: string; item: T }>();
  /** item key → D-Bus id (for replaces_id) */
  private idByKey = new Map<string, number>();
  /** Keep Electron notifications referenced so they aren't GC'd (which drops click handlers). */
  private electronRefs = new Set<unknown>();

  constructor(private readonly opts: NotifierOptions<T>) {}

  private async connect(): Promise<DbusIface | null> {
    if (this.iface) return this.iface;
    if (this.dbusFailedAt && Date.now() - this.dbusFailedAt < DBUS_RETRY_MS) return null;
    if (!this.connecting) {
      this.connecting = (async () => {
        let bus: dbus.MessageBus | null = null;
        try {
          if (!process.env.DBUS_SESSION_BUS_ADDRESS && !process.env.XDG_RUNTIME_DIR) throw new Error('no session bus');
          bus = dbus.sessionBus();
          const thisBus = bus;
          bus.on('error', (e: unknown) => {
            console.warn('[notify] D-Bus error', e);
            if (this.bus === thisBus) this.reset();
          });
          const obj = await withTimeout(bus.getProxyObject(BUS_NAME, OBJ_PATH), 5000);
          const iface = obj.getInterface(IFACE);
          iface.on('ActionInvoked', (id: number, key: string) => this.handleAction(id, key));
          iface.on('NotificationClosed', (id: number) => this.forget(id));
          this.bus = bus;
          this.iface = iface;
          this.dbusFailedAt = 0;
          return iface;
        } catch (e) {
          console.warn('[notify] D-Bus notifications unavailable, using Electron fallback:', (e as Error)?.message ?? e);
          this.dbusFailedAt = Date.now();
          try {
            bus?.disconnect();
          } catch {
            /* ignore */
          }
          return null;
        } finally {
          this.connecting = null;
        }
      })();
    }
    return this.connecting;
  }

  private reset(): void {
    try {
      this.bus?.disconnect();
    } catch {
      /* ignore */
    }
    this.bus = null;
    this.iface = null;
    this.byId.clear();
    this.idByKey.clear();
  }

  private forget(id: number): void {
    const entry = this.byId.get(id);
    if (!entry) return;
    this.byId.delete(id);
    if (this.idByKey.get(entry.key) === id) this.idByKey.delete(entry.key);
  }

  private handleAction(id: number, key: string): void {
    const entry = this.byId.get(id);
    if (!entry) return;
    try {
      if (key === 'default' || key === 'open-map') this.opts.onOpenMap(entry.item);
      else if (key === 'details') this.opts.onShowDetails(entry.item);
    } catch (e) {
      console.error('[notify] action handler failed', e);
    }
    // Most servers close the notification after an action; drop critical ones explicitly.
    void this.closeId(id);
  }

  private async closeId(id: number): Promise<void> {
    try {
      await this.iface?.CloseNotification(id);
    } catch {
      /* ignore */
    }
  }

  /**
   * Show a notification for `item`. `key` identifies the item (e.g. alert id); a later
   * notify with the same key replaces the earlier popup if it's still open.
   */
  async notify(key: string, item: T, content: NotifyContent): Promise<void> {
    const iface = await this.connect();
    if (iface) {
      try {
        const hints: Record<string, dbus.Variant> = {
          urgency: new dbus.Variant('y', content.critical ? 2 : 1),
          'desktop-entry': new dbus.Variant('s', this.opts.desktopEntry ?? 'weatherwise-linux'),
        };
        const id: number = await iface.Notify(
          this.opts.appName ?? 'WeatherWise',
          this.idByKey.get(key) ?? 0,
          this.opts.iconPath,
          content.summary,
          escapeBody(content.body),
          ['default', 'Open map', 'open-map', 'Open map', 'details', 'Details'],
          hints,
          content.critical ? 0 : -1,
        );
        this.byId.set(id, { key, item });
        this.idByKey.set(key, id);
        return;
      } catch (e) {
        console.warn('[notify] D-Bus Notify failed, falling back', e);
      }
    }
    this.notifyElectron(item, content);
  }

  private notifyElectron(item: T, content: NotifyContent): void {
    try {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const { Notification } = require('electron') as typeof import('electron');
      if (!Notification || !Notification.isSupported()) return;
      const n = new Notification({
        title: content.summary,
        body: content.body,
        icon: this.opts.iconPath,
        urgency: content.critical ? 'critical' : 'normal',
        timeoutType: content.critical ? 'never' : 'default',
      });
      this.electronRefs.add(n);
      n.on('click', () => {
        try {
          this.opts.onOpenMap(item);
        } catch (e) {
          console.error('[notify] click handler failed', e);
        }
      });
      n.on('close', () => this.electronRefs.delete(n));
      n.show();
      // Don't hold references forever if close never fires.
      setTimeout(() => this.electronRefs.delete(n), 6 * 3600_000).unref?.();
    } catch (e) {
      console.warn('[notify] Electron notification failed', e);
    }
  }

  dispose(): void {
    this.reset();
    this.electronRefs.clear();
  }
}

function withTimeout<V>(p: Promise<V>, ms: number): Promise<V> {
  return new Promise<V>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('timeout')), ms);
    p.then(
      (v) => {
        clearTimeout(t);
        resolve(v);
      },
      (e) => {
        clearTimeout(t);
        reject(e);
      },
    );
  });
}
