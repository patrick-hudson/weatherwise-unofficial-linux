/**
 * Preload for the WeatherWise site (sandboxed, context-isolated).
 *
 * Fills gaps in embedded Chromium on Linux:
 *  - navigator.geolocation → geoclue / manual location from the main process
 *  - navigator.share → copy link to clipboard + toast
 *  - "pan to" requests from native alert notifications
 *
 * IMPORTANT: never define `window.todesktop` — the site treats that as its
 * paid official desktop app and locks itself behind login + subscription.
 */
import { contextBridge, ipcRenderer } from 'electron';

interface Pos {
  lat: number;
  lon: number;
  accuracy: number;
  timestamp: number;
}

contextBridge.exposeInMainWorld('wwDesktop', {
  platform: 'linux',
  getPosition: (): Promise<Pos | null> => ipcRenderer.invoke('geo:get'),
  share: (data: { url?: string; text?: string; title?: string }): Promise<boolean> => ipcRenderer.invoke('share', data),
  onPanTo: (cb: (p: { lat: number; lon: number; zoom?: number }) => void) => {
    ipcRenderer.on('pan-to', (_e, p) => cb(p));
  },
  reportMapState: (s: unknown) => ipcRenderer.send('map-state', s),
  savePlace: (p: { name: string; lat: number; lon: number; zoom: number }) => ipcRenderer.invoke('places:save', p),
  onPromptSave: (cb: (p: { lat: number; lon: number; zoom: number; name?: string }) => void) => {
    ipcRenderer.on('places:prompt', (_e, p) => cb(p));
  },
  getPlaces: () => ipcRenderer.invoke('places:list'),
  onPlacesChanged: (cb: (places: unknown[]) => void) => {
    ipcRenderer.on('places:changed', (_e, p) => cb(p));
  },
  removePlace: (id: string) => ipcRenderer.invoke('places:remove', id),
  setPlaceAlerts: (id: string, on: boolean) => ipcRenderer.invoke('places:alerts', id, on),
  prefsChanged: (snapshot: unknown) => ipcRenderer.send('wwprefs:changed', snapshot),
  onGeoChanged: (cb: () => void) => {
    ipcRenderer.on('geo:changed', () => cb());
  },
  setHome: (p: { name: string; lat: number; lon: number }) => ipcRenderer.invoke('location:set-home', p),
});

contextBridge.executeInMainWorld({
  func: () => {
    const w = window as any;
    const bridge = w.wwDesktop;
    if (!bridge) return;

    // ---------- toast ----------
    const toast = (msg: string) => {
      const show = () => {
        const el = document.createElement('div');
        el.textContent = msg;
        el.setAttribute(
          'style',
          'position:fixed;left:50%;bottom:28px;transform:translateX(-50%);z-index:2147483647;' +
            'background:#17274f;color:#fff;border:1px solid #f6b91a;border-radius:8px;padding:10px 16px;' +
            'font:14px system-ui,sans-serif;box-shadow:0 6px 24px rgba(0,0,0,.35);transition:opacity .3s',
        );
        document.body.appendChild(el);
        setTimeout(() => (el.style.opacity = '0'), 2200);
        setTimeout(() => el.remove(), 2600);
      };
      if (document.body) show();
      else addEventListener('DOMContentLoaded', show, { once: true });
    };

    // ---------- geolocation ----------
    const mkPosition = (p: { lat: number; lon: number; accuracy: number; timestamp: number }) => {
      const coords = {
        latitude: p.lat,
        longitude: p.lon,
        accuracy: p.accuracy,
        altitude: null,
        altitudeAccuracy: null,
        heading: null,
        speed: null,
        toJSON() {
          return { latitude: p.lat, longitude: p.lon, accuracy: p.accuracy };
        },
      };
      return { coords, timestamp: p.timestamp, toJSON: () => ({ coords: coords.toJSON(), timestamp: p.timestamp }) };
    };
    const mkError = (code: number, message: string) => ({ code, message, PERMISSION_DENIED: 1, POSITION_UNAVAILABLE: 2, TIMEOUT: 3 });

    const getCurrentPosition = (ok: (p: unknown) => void, err?: (e: unknown) => void) => {
      bridge
        .getPosition()
        .then((p: any) => {
          if (p) ok(mkPosition(p));
          else err?.(mkError(2, 'Location unavailable. Set a home location in WeatherWise for Linux settings.'));
        })
        .catch(() => err?.(mkError(2, 'Location unavailable')));
    };
    const watches = new Map<number, { timer: ReturnType<typeof setInterval>; ok: (p: unknown) => void }>();
    let nextWatch = 1;
    const watchPosition = (ok: (p: unknown) => void, err?: (e: unknown) => void) => {
      const id = nextWatch++;
      getCurrentPosition(ok, err);
      watches.set(id, { ok, timer: setInterval(() => getCurrentPosition(ok, () => {}), 30_000) });
      return id;
    };
    const clearWatch = (id: number) => {
      const t = watches.get(id);
      if (t) clearInterval(t.timer);
      watches.delete(id);
    };
    // Location changed in the app (e.g. "Set as my location"): update the dot right away.
    bridge.onGeoChanged(() => {
      for (const { ok } of watches.values()) getCurrentPosition(ok, () => {});
    });
    const geo = { getCurrentPosition, watchPosition, clearWatch };
    try {
      Object.defineProperty(Navigator.prototype, 'geolocation', { configurable: true, get: () => geo });
    } catch {
      /* ignore */
    }

    // Report geolocation permission as granted (the native side handles consent).
    if (navigator.permissions?.query) {
      const origQuery = navigator.permissions.query.bind(navigator.permissions);
      navigator.permissions.query = ((desc: PermissionDescriptor) => {
        if (desc && (desc as any).name === 'geolocation') {
          return Promise.resolve({ state: 'granted', name: 'geolocation', onchange: null, addEventListener() {}, removeEventListener() {}, dispatchEvent: () => false } as unknown as PermissionStatus);
        }
        return origQuery(desc);
      }) as typeof navigator.permissions.query;
    }

    // ---------- share ----------
    (navigator as any).share = async (data: { url?: string; text?: string; title?: string }) => {
      const ok = await bridge.share({ url: data?.url, text: data?.text, title: data?.title });
      toast(ok ? 'Link copied to clipboard' : 'Nothing to share');
    };
    (navigator as any).canShare = () => true;

    // ---------- pan-to (from alert notifications) ----------
    bridge.onPanTo((p: { lat: number; lon: number; zoom?: number }) => {
      w.dispatchEvent(new CustomEvent('wwdesktop:pan-to', { detail: p }));
      const fn = w.__wwDesktopPanTo;
      if (typeof fn === 'function') {
        try {
          fn(p);
          return;
        } catch {
          /* fall through */
        }
      }
    });

    // ---------- saved places (local, no account needed) ----------
    const currentZoom = () => {
      const m = new URLSearchParams(location.hash.slice(1)).get('map');
      const z = Number((m ?? '').split('/')[0]);
      return Number.isFinite(z) ? Math.max(z, 8) : 9;
    };

    /** Small in-page dialog asking for a place name. Resolves to the name or null. */
    const askName = (title: string, suggestion: string): Promise<string | null> =>
      new Promise((resolve) => {
        const wrap = document.createElement('div');
        wrap.setAttribute(
          'style',
          'position:fixed;inset:0;z-index:2147483646;background:rgba(0,0,0,.45);display:grid;place-items:center;font:14px system-ui,sans-serif',
        );
        const box = document.createElement('form');
        box.setAttribute(
          'style',
          'background:#17274f;color:#eef2fb;border:1px solid #2f4b8a;border-radius:12px;padding:18px;width:min(360px,90vw);box-shadow:0 12px 40px rgba(0,0,0,.5)',
        );
        const h = document.createElement('div');
        h.textContent = title;
        h.setAttribute('style', 'font-weight:700;font-size:16px;margin-bottom:4px');
        const sub = document.createElement('div');
        sub.textContent = 'Saved on this computer — no account needed.';
        sub.setAttribute('style', 'color:#a9b6d6;font-size:12px;margin-bottom:12px');
        const input = document.createElement('input');
        input.value = suggestion;
        input.setAttribute(
          'style',
          'width:100%;box-sizing:border-box;background:#0f1c3d;color:#eef2fb;border:1px solid #2f4b8a;border-radius:6px;padding:8px;font:inherit;outline:none',
        );
        const row = document.createElement('div');
        row.setAttribute('style', 'display:flex;justify-content:flex-end;gap:8px;margin-top:14px');
        const btn = (label: string, primary: boolean) => {
          const b = document.createElement('button');
          b.textContent = label;
          b.type = primary ? 'submit' : 'button';
          b.setAttribute(
            'style',
            `border-radius:6px;padding:7px 14px;font:inherit;cursor:pointer;border:1px solid ${primary ? '#f6b91a' : '#2f4b8a'};` +
              `background:${primary ? '#f6b91a' : 'transparent'};color:${primary ? '#17274f' : '#eef2fb'};font-weight:${primary ? 600 : 400}`,
          );
          return b;
        };
        const cancel = btn('Cancel', false);
        const save = btn('Save', true);
        row.append(cancel, save);
        box.append(h, sub, input, row);
        wrap.append(box);
        const done = (v: string | null) => {
          wrap.remove();
          resolve(v);
        };
        cancel.onclick = () => done(null);
        wrap.addEventListener('mousedown', (e) => e.target === wrap && done(null));
        box.addEventListener('keydown', (e) => {
          if (e.key === 'Escape') done(null);
          e.stopPropagation();
        });
        box.onsubmit = (e) => {
          e.preventDefault();
          done(input.value.trim() || suggestion);
        };
        document.body.append(wrap);
        setTimeout(() => {
          input.focus();
          input.select();
        }, 0);
      });

    const savePlace = async (lat: number, lon: number, zoom: number, suggestion = '') => {
      const name = await askName('Save location', suggestion || `${lat.toFixed(3)}, ${lon.toFixed(3)}`);
      if (!name) return;
      try {
        await bridge.savePlace({ name, lat, lon, zoom });
        toast(`Saved "${name}"`);
      } catch {
        toast('Could not save location');
      }
    };
    bridge.onPromptSave((p: { lat: number; lon: number; zoom: number; name?: string }) => void savePlace(p.lat, p.lon, p.zoom, p.name));

    /** Parse the coordinate line in the site's map context menu, e.g. 29°49.07'N, 95°43.16'W. */
    const parseCoords = (text: string): { lat: number; lon: number } | null => {
      const dm = /(\d+)°\s*([\d.]+)'\s*([NS])[,\s]+(\d+)°\s*([\d.]+)'\s*([EW])/.exec(text);
      if (dm) {
        const lat = (Number(dm[1]) + Number(dm[2]) / 60) * (dm[3] === 'S' ? -1 : 1);
        const lon = (Number(dm[4]) + Number(dm[5]) / 60) * (dm[6] === 'W' ? -1 : 1);
        return { lat, lon };
      }
      const dms = /(\d+)°\s*(\d+)'\s*([\d.]+)"\s*([NS])[,\s]+(\d+)°\s*(\d+)'\s*([\d.]+)"\s*([EW])/.exec(text);
      if (dms) {
        const lat = (Number(dms[1]) + Number(dms[2]) / 60 + Number(dms[3]) / 3600) * (dms[4] === 'S' ? -1 : 1);
        const lon = (Number(dms[5]) + Number(dms[6]) / 60 + Number(dms[7]) / 3600) * (dms[8] === 'W' ? -1 : 1);
        return { lat, lon };
      }
      const dec = /(-?\d{1,2}\.\d+)°?\s*([NS])?[,\s]+(-?\d{1,3}\.\d+)°?\s*([EW])?/.exec(text);
      if (dec) {
        const lat = Number(dec[1]) * (dec[2] === 'S' ? -1 : 1);
        const lon = Number(dec[3]) * (dec[4] === 'W' ? -1 : 1);
        if (Math.abs(lat) <= 90 && Math.abs(lon) <= 180) return { lat, lon };
      }
      return null;
    };

    // The site's "Save Location" needs a WeatherWise account. When it answers with
    // "Please log in to save locations", save the spot locally instead. The site's
    // menu swallows pointer events, so we remember the coordinates shown in the most
    // recent right-click menu and use them when the warning appears.
    let lastMenu: { lat: number; lon: number; at: number } | null = null;
    const loginWarning = /log in to save locations/i;
    new MutationObserver((records) => {
      const menu = document.querySelector('[data-pc-name=contextmenu]') as HTMLElement | null;
      if (menu) {
        const c = parseCoords(menu.innerText || '');
        if (c) lastMenu = { ...c, at: Date.now() };
      }
      if (!lastMenu || Date.now() - lastMenu.at > 15_000) return;
      for (const r of records) {
        for (const n of Array.from(r.addedNodes)) {
          const el = n as HTMLElement;
          if (el.nodeType !== 1 || !loginWarning.test(el.innerText || el.textContent || '')) continue;
          const p = lastMenu;
          lastMenu = null;
          el.style.display = 'none'; // hide the site's "please log in" toast; we're handling it
          void savePlace(p.lat, p.lon, currentZoom());
          return;
        }
      }
    }).observe(document, { childList: true, subtree: true });

    // ---------- WeatherWise preferences mirror ----------
    // The site keeps its preferences in Pinia stores. We expose a small, fixed set of
    // them to the app's Settings window (read + write) and report changes back.
    type PrefSpec = { store: string; path: string; action?: string; reload?: boolean };
    const PREFS: Record<string, PrefSpec> = {
      darkMode: { store: 'settings/preferences', path: 'darkMode', action: 'setDarkMode' },
      timeFormat: { store: 'settings/preferences', path: 'timeFormat', action: 'setTimeFormat' },
      leftHanded: { store: 'settings/preferences', path: 'leftHanded' },
      stayAwake: { store: 'settings/preferences', path: 'stayAwake' },
      inspectorMode: { store: 'settings/preferences', path: 'inspector_mode' },
      popupItemsMode: { store: 'settings/preferences', path: 'popupItemsMode', action: 'setPopupItemsMode' },
      scaleControl: { reload: true, store: 'settings/map', path: 'scale_control' },
      scaleUnit: { reload: true, store: 'settings/map', path: 'scale_control_unit' },
      projection: { reload: true, store: 'settings/map', path: 'projection' },
      rotation: { reload: true, store: 'settings/map', path: 'rotation.enabled', action: 'setRotationEnabled' },
      pitch: { reload: true, store: 'settings/map', path: 'pitch.enabled', action: 'setPitchEnabled' },
      dayNight: { reload: true, store: 'settings/map', path: 'day_night.enabled', action: 'setDayNightEnabled' },
      poiLabels: { reload: true, store: 'settings/map', path: 'poi_labels.enabled' },
    };
    const pinia = () => {
      const el = Array.from(document.querySelectorAll('body, body > *, #app')).find((e: any) => e.__vue_app__) as any;
      return el?.__vue_app__?.config?.globalProperties?.$pinia ?? null;
    };
    const getPath = (o: any, path: string) => path.split('.').reduce((a, k) => (a == null ? a : a[k]), o);
    const prefsSnapshot = () => {
      const p = pinia();
      if (!p) return null;
      const out: Record<string, unknown> = {};
      for (const [key, spec] of Object.entries(PREFS)) {
        const st = p._s.get(spec.store);
        if (st) out[key] = getPath(st.$state, spec.path);
      }
      return out;
    };
    // Map options are applied by the site's own settings screen (or on map load), so
    // after changing those we reload the page; the stores persist and the URL keeps the view.
    let reloadTimer: ReturnType<typeof setTimeout> | null = null;
    const scheduleReload = () => {
      if (reloadTimer) clearTimeout(reloadTimer);
      reloadTimer = setTimeout(() => location.reload(), 900);
    };
    const setPref = (key: string, value: unknown) => {
      const spec = PREFS[key];
      const p = pinia();
      const st = spec && p?._s.get(spec.store);
      if (!st) return false;
      if (spec.reload) setTimeout(scheduleReload, 0);
      if (spec.action && typeof st[spec.action] === 'function') {
        st[spec.action](value);
        return true;
      }
      const parts = spec.path.split('.');
      st.$patch((state: any) => {
        if (parts.length === 1) state[parts[0]] = value;
        else {
          // Replace the parent object so the site's watchers see the change.
          const [head, ...rest] = parts;
          const copy = JSON.parse(JSON.stringify(state[head] ?? {}));
          let cur = copy;
          for (const k of rest.slice(0, -1)) cur = cur[k] ??= {};
          cur[rest[rest.length - 1]] = value;
          state[head] = copy;
        }
      });
      return true;
    };
    /** Open one of the site's own dialogs from its WeatherWise menu (e.g. "My Preferences"). */
    const openSiteMenuItem = async (label: string) => {
      const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
      const findItem = () =>
        Array.from(document.querySelectorAll('a, button, [role=menuitem], li, div')).find(
          (e) => (e as HTMLElement).children.length === 0 && (e as HTMLElement).innerText?.trim() === label,
        ) as HTMLElement | undefined;
      let item = findItem();
      if (!item) {
        const logo = Array.from(document.querySelectorAll('button, [role=button], a')).find((e) =>
          /^\s*Weather\s*Wise\s*$/i.test((e as HTMLElement).innerText || ''),
        ) as HTMLElement | undefined;
        logo?.click();
        for (let i = 0; i < 20 && !item; i++) {
          await sleep(100);
          item = findItem();
        }
      }
      if (!item) return false;
      (item.closest('a, button, [role=menuitem], li') as HTMLElement | null ?? item).click();
      return true;
    };
    w.__wwPrefs = { get: prefsSnapshot, set: setPref, open: openSiteMenuItem };
    // Report changes made inside the site (its own dialogs) back to the app.
    let lastPrefs = '';
    const reportPrefs = () => {
      const snap = prefsSnapshot();
      const json = snap ? JSON.stringify(snap) : '';
      if (json && json !== lastPrefs) {
        lastPrefs = json;
        bridge.prefsChanged(snap);
      }
    };
    const watchPrefs = () => {
      const p = pinia();
      if (!p) return setTimeout(watchPrefs, 1000);
      for (const id of new Set(Object.values(PREFS).map((s) => s.store))) {
        p._s.get(id)?.$subscribe(() => reportPrefs(), { detached: true });
      }
      reportPrefs();
    };
    addEventListener('load', () => setTimeout(watchPrefs, 500));

    // ---------- saved places on the map ----------
    // The site bundles mapbox-gl as a private module, so there's no global to reach the
    // map. mapbox's Map constructor calls bindAll(..., this), i.e. Function.prototype.bind
    // with the map as `this` argument — we watch for that to pick up each map instance.
    type Place = { id: string; name: string; lat: number; lon: number; zoom: number; alerts: boolean };
    const SRC = 'wwlinux-places';
    const DOT = 'wwlinux-places-dot';
    const LABEL = 'wwlinux-places-label';
    const maps = new Set<any>();
    let places: Place[] = [];
    let placesVersion = 0;

    const looksLikeMap = (o: any) =>
      o && typeof o === 'object' && typeof o.addLayer === 'function' && typeof o.getCanvasContainer === 'function' && typeof o.queryRenderedFeatures === 'function';

    const origBind = Function.prototype.bind;
    const patchedBind = function (this: (...a: unknown[]) => unknown, thisArg: unknown, ...args: unknown[]) {
      if (thisArg && !maps.has(thisArg) && looksLikeMap(thisArg)) {
        maps.add(thisArg);
        setTimeout(() => attachMap(thisArg), 0);
      }
      return origBind.apply(this, [thisArg, ...args] as [unknown, ...unknown[]]);
    };
    Object.defineProperty(Function.prototype, 'bind', { value: patchedBind, writable: true, configurable: true });

    const featureCollection = () => ({
      type: 'FeatureCollection',
      features: places.map((p) => ({
        type: 'Feature',
        properties: { id: p.id, name: p.name, alerts: p.alerts },
        geometry: { type: 'Point', coordinates: [p.lon, p.lat] },
      })),
    });

    const draw = (map: any) => {
      try {
        if (map._removed || !map.isStyleLoaded?.()) return;
        const src = map.getSource(SRC);
        if (!src) {
          map.addSource(SRC, { type: 'geojson', data: featureCollection() });
          map.__wwlinuxVer = placesVersion;
        } else if (map.__wwlinuxVer !== placesVersion) {
          // Only push data when places changed — setData triggers a repaint (and another 'idle').
          src.setData(featureCollection());
          map.__wwlinuxVer = placesVersion;
        }
        if (!map.getLayer(DOT)) {
          map.addLayer({
            id: DOT,
            type: 'circle',
            source: SRC,
            paint: {
              'circle-radius': ['interpolate', ['linear'], ['zoom'], 3, 4, 8, 7, 12, 9],
              'circle-color': '#f6b91a',
              'circle-stroke-color': '#17274f',
              'circle-stroke-width': ['case', ['get', 'alerts'], 3.5, 2.5],
            },
          });
        }
        if (!map.getLayer(LABEL)) {
          map.addLayer({
            id: LABEL,
            type: 'symbol',
            source: SRC,
            minzoom: 5,
            layout: {
              'text-field': ['get', 'name'],
              'text-font': ['DIN Pro Medium', 'Arial Unicode MS Regular'],
              'text-size': ['interpolate', ['linear'], ['zoom'], 5, 11, 10, 14],
              'text-offset': [0, 1.1],
              'text-anchor': 'top',
              'text-optional': true,
            },
            paint: { 'text-color': '#ffffff', 'text-halo-color': '#17274f', 'text-halo-width': 2 },
          });
        }
        // Keep our markers above layers the site adds later (radar, warnings…).
        const layers = map.getStyle()?.layers ?? [];
        const top = layers[layers.length - 1]?.id;
        if (top !== LABEL) {
          map.moveLayer(DOT);
          map.moveLayer(LABEL);
        }
      } catch (e) {
        console.warn('[wwlinux] could not draw places', e);
      }
    };

    // ---- marker popup ----
    let popup: HTMLElement | null = null;
    const closePopup = () => {
      popup?.remove();
      popup = null;
    };
    const openPopup = (map: any, place: Place, point: { x: number; y: number }) => {
      closePopup();
      const el = document.createElement('div');
      el.setAttribute(
        'style',
        `position:absolute;left:${point.x}px;top:${point.y}px;transform:translate(-50%,calc(-100% - 14px));z-index:5;` +
          'background:#17274f;color:#eef2fb;border:1px solid #2f4b8a;border-radius:10px;padding:10px 12px;min-width:190px;' +
          'font:13px system-ui,sans-serif;box-shadow:0 8px 28px rgba(0,0,0,.45)',
      );
      const title = document.createElement('div');
      title.textContent = place.name;
      title.setAttribute('style', 'font-weight:700;font-size:14px;margin-bottom:2px;padding-right:18px');
      const sub = document.createElement('div');
      sub.textContent = `${place.lat.toFixed(4)}, ${place.lon.toFixed(4)} · saved on this computer`;
      sub.setAttribute('style', 'color:#a9b6d6;font-size:11px;margin-bottom:8px');
      const x = document.createElement('button');
      x.textContent = '×';
      x.setAttribute('style', 'position:absolute;right:6px;top:4px;background:none;border:0;color:#a9b6d6;font-size:18px;cursor:pointer');
      x.onclick = closePopup;
      const row = document.createElement('div');
      row.setAttribute('style', 'display:flex;gap:6px');
      const mk = (label: string, danger = false) => {
        const b = document.createElement('button');
        b.textContent = label;
        b.setAttribute(
          'style',
          `flex:1;border-radius:6px;padding:5px 8px;font:inherit;font-size:12px;cursor:pointer;background:transparent;` +
            `border:1px solid ${danger ? '#7a2b35' : '#2f4b8a'};color:${danger ? '#ffb4b1' : '#eef2fb'}`,
        );
        return b;
      };
      const bell = mk(place.alerts ? '🔔 Alerts on' : '🔕 Alerts off');
      bell.title = 'Severe weather notifications for this place';
      bell.onclick = async () => {
        await bridge.setPlaceAlerts(place.id, !place.alerts);
        closePopup();
        toast(place.alerts ? `Alerts off for "${place.name}"` : `Alerts on for "${place.name}"`);
      };
      const del = mk('Remove', true);
      del.onclick = async () => {
        await bridge.removePlace(place.id);
        closePopup();
        toast(`Removed "${place.name}"`);
      };
      const home = mk('📍 My location');
      home.title = 'Use this place as my location (the blue dot and alerts)';
      home.onclick = async () => {
        await bridge.setHome({ name: place.name, lat: place.lat, lon: place.lon });
        closePopup();
        toast(`"${place.name}" is now your location`);
      };
      row.append(home, bell, del);
      row.style.flexWrap = 'wrap';
      el.append(x, title, sub, row);
      el.addEventListener('mousedown', (e) => e.stopPropagation());
      el.addEventListener('click', (e) => e.stopPropagation());
      map.getContainer().append(el);
      popup = el;
      map.once('movestart', closePopup);
    };

    const attachMap = (map: any) => {
      if (map.__wwlinux) return;
      map.__wwlinux = true;
      map.on('style.load', () => draw(map));
      map.on('load', () => draw(map));
      map.on('idle', () => draw(map)); // re-add after the site swaps styles, keep markers on top
      map.on('click', DOT, (e: any) => {
        const f = e.features?.[0];
        const p = f && places.find((x) => x.id === f.properties.id);
        if (p) openPopup(map, p, e.point);
      });
      map.on('mouseenter', DOT, () => (map.getCanvas().style.cursor = 'pointer'));
      map.on('mouseleave', DOT, () => (map.getCanvas().style.cursor = ''));
      map.on('click', (e: any) => {
        if (!popup) return;
        const hits = map.queryRenderedFeatures(e.point, { layers: [DOT] });
        if (!hits.length) closePopup();
      });
      draw(map);
    };

    const redrawAll = () => {
      for (const m of maps) {
        if (m._removed) maps.delete(m);
        else draw(m);
      }
    };
    bridge.getPlaces().then((p: Place[]) => {
      places = Array.isArray(p) ? p : [];
      placesVersion++;
      redrawAll();
    });
    bridge.onPlacesChanged((p: Place[]) => {
      places = Array.isArray(p) ? p : [];
      placesVersion++;
      closePopup();
      redrawAll();
    });
  },
});
