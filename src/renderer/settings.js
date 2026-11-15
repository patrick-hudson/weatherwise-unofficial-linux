/* global wwLocal */
const api = window.wwLocal;
let cfg = null;

const $ = (id) => document.getElementById(id);
const get = (obj, key) => key.split('.').reduce((o, k) => (o == null ? o : o[k]), obj);
const patchFor = (key, value) => key.split('.').reduceRight((acc, k) => ({ [k]: acc }), value);

let savedTimer;
function flashSaved() {
  const s = $('saved');
  s.classList.add('show');
  clearTimeout(savedTimer);
  savedTimer = setTimeout(() => s.classList.remove('show'), 1200);
}

async function save(patch) {
  cfg = await api.setConfig(patch);
  flashSaved();
}

function bindInputs() {
  for (const el of document.querySelectorAll('[data-key]')) {
    const key = el.dataset.key;
    const v = get(cfg, key);
    if (el.type === 'checkbox') el.checked = !!v;
    else {
      if (el.dataset.type === 'boolean') {
        el.value = String(!!v);
      } else {
        if (el.tagName === 'SELECT' && v != null && ![...el.options].some((o) => o.value === String(v))) {
          el.append(new Option(el.dataset.key === 'general.zoom' ? `${Math.round(v * 100)}%` : String(v), String(v)));
        }
        el.value = v ?? '';
      }
    }
    el.addEventListener('change', async () => {
      let value;
      if (el.type === 'checkbox') value = el.checked;
      else if (el.dataset.type === 'boolean') value = el.value === 'true';
      else if (el.type === 'number' || el.dataset.type === 'number') {
        value = Number(el.value);
        if (!Number.isFinite(value)) return;
        if (el.min !== '' && value < Number(el.min)) value = Number(el.min);
        if (el.max !== '' && value > Number(el.max)) value = Number(el.max);
        el.value = String(value);
      } else value = el.value;
      await save(patchFor(key, value));
      if (el.hasAttribute('data-restart')) $('restart-notice').classList.add('show');
    });
  }
}

// ----- home location
function renderHome() {
  const h = cfg.location.home;
  $('home-name').value = h?.name ?? '';
  $('home-lat').value = h ? String(h.lat) : '';
  $('home-lon').value = h ? String(h.lon) : '';
}
function parseCoord(s, max) {
  const n = Number(String(s).trim());
  return Number.isFinite(n) && Math.abs(n) <= max ? n : null;
}
async function saveHomeFromInputs() {
  const lat = parseCoord($('home-lat').value, 90);
  const lon = parseCoord($('home-lon').value, 180);
  if (lat === null || lon === null) {
    $('loc-status').textContent = 'Enter a valid latitude and longitude.';
    return;
  }
  $('loc-status').textContent = '';
  await save({ location: { home: { name: $('home-name').value.trim() || 'Home', lat, lon }, useDeviceLocation: false } });
  syncSourceSelect();
}
function syncSourceSelect() {
  const sel = document.querySelector('[data-key="location.useDeviceLocation"]');
  if (sel) sel.value = String(!!cfg.location.useDeviceLocation);
}
async function setHome(lat, lon, label, name) {
  const r4 = (n) => Math.round(n * 10000) / 10000;
  await save({ location: { home: { name: name || $('home-name').value.trim() || 'Home', lat: r4(lat), lon: r4(lon) }, useDeviceLocation: false } });
  renderHome();
  syncSourceSelect();
  $('loc-status').textContent = label;
}

// ----- places
function renderPlaces() {
  const box = $('places');
  box.textContent = '';
  if (!cfg.places.length) {
    const empty = document.createElement('p');
    empty.className = 'hint';
    empty.textContent = 'No saved places yet.';
    box.append(empty);
    return;
  }
  cfg.places.forEach((p, i) => {
    const row = document.createElement('div');
    row.className = 'loc';
    const name = Object.assign(document.createElement('input'), { type: 'text', value: p.name, placeholder: 'Name' });
    const lat = Object.assign(document.createElement('input'), { type: 'text', value: String(p.lat), placeholder: 'Latitude', className: 'coord' });
    const lon = Object.assign(document.createElement('input'), { type: 'text', value: String(p.lon), placeholder: 'Longitude', className: 'coord' });
    const bellLabel = document.createElement('label');
    bellLabel.title = 'Send severe weather alerts for this place';
    bellLabel.style.cssText = 'display:flex;align-items:center;gap:4px;white-space:nowrap';
    const bell = Object.assign(document.createElement('input'), { type: 'checkbox', checked: !!p.alerts });
    bellLabel.append(bell, document.createTextNode('🔔'));
    const mine = Object.assign(document.createElement('button'), { textContent: '📍', title: 'Use as my location' });
    mine.addEventListener('click', () => setHome(p.lat, p.lon, `Using "${p.name}" as your location.`, p.name));
    const go = Object.assign(document.createElement('button'), { textContent: 'Show', title: 'Show on map' });
    const del = Object.assign(document.createElement('button'), { textContent: 'Remove', className: 'danger' });
    const update = async (changes) => {
      const list = cfg.places.slice();
      list[i] = { ...list[i], ...changes };
      await save({ places: list });
    };
    name.addEventListener('change', () => update({ name: name.value.trim() || p.name }));
    for (const el of [lat, lon]) {
      el.addEventListener('change', () => {
        const la = parseCoord(lat.value, 90);
        const lo = parseCoord(lon.value, 180);
        if (la !== null && lo !== null) update({ lat: la, lon: lo });
      });
    }
    bell.addEventListener('change', () => update({ alerts: bell.checked }));
    go.addEventListener('click', () => api.openMapAt(p.lat, p.lon, p.zoom));
    del.addEventListener('click', async () => {
      const list = cfg.places.slice();
      list.splice(i, 1);
      await save({ places: list });
      renderPlaces();
    });
    row.append(name, lat, lon, bellLabel, mine, go, del);
    box.append(row);
  });
}

function csv(s) {
  return s.split(',').map((x) => x.trim()).filter(Boolean);
}

function renderSound() {
  $('sound-file').textContent = cfg.alerts.soundFile || 'Built-in alert tone';
}

async function init() {
  cfg = await api.getConfig();
  bindInputs();
  renderHome();
  renderPlaces();
  renderSound();
  $('event-filter').value = cfg.alerts.eventFilter.join(', ');
  $('extra-domains').value = cfg.links.extraInAppDomains.join(', ');

  for (const id of ['home-name', 'home-lat', 'home-lon']) $(id).addEventListener('change', saveHomeFromInputs);
  $('home-clear').addEventListener('click', async () => {
    await save({ location: { home: null } });
    renderHome();
  });
  $('home-from-device').addEventListener('click', async () => {
    $('loc-status').textContent = 'Locating…';
    const p = await api.getLocation();
    if (!p) $('loc-status').textContent = 'Device location unavailable.';
    else if (p.source === 'manual') $('loc-status').textContent = 'Device location unavailable (only the saved home is known).';
    else await setHome(p.lat, p.lon, `Set from device (±${Math.round(p.accuracy / 1000)} km).`);
  });
  $('home-from-map').addEventListener('click', async () => {
    const c = await api.getMapCenter();
    if (!c) $('loc-status').textContent = 'Open the map first, then try again.';
    else await setHome(c.lat, c.lon, 'Set from the map center.');
  });

  $('add-place').addEventListener('click', async () => {
    const c = await api.getMapCenter();
    if (!c) {
      $('places-status').textContent = 'Open the map first, then try again.';
      return;
    }
    const r4 = (n) => Math.round(n * 10000) / 10000;
    const place = { id: crypto.randomUUID(), name: `Place ${cfg.places.length + 1}`, lat: r4(c.lat), lon: r4(c.lon), zoom: Math.max(8, c.zoom), alerts: false };
    await save({ places: cfg.places.concat([place]) });
    $('places-status').textContent = '';
    renderPlaces();
  });

  $('event-filter').addEventListener('change', () => save({ alerts: { eventFilter: csv($('event-filter').value) } }));
  $('extra-domains').addEventListener('change', () => save({ links: { extraInAppDomains: csv($('extra-domains').value) } }));

  $('sound-pick').addEventListener('click', async () => {
    const f = await api.pickSoundFile();
    if (f) {
      await save({ alerts: { soundFile: f } });
      renderSound();
    }
  });
  $('sound-reset').addEventListener('click', async () => {
    await save({ alerts: { soundFile: null } });
    renderSound();
  });

  $('test-alert').addEventListener('click', async () => {
    $('alert-status').textContent = 'Sending…';
    try {
      await api.testAlert();
      $('alert-status').textContent = 'Test alert sent.';
    } catch (e) {
      $('alert-status').textContent = `Failed: ${e.message || e}`;
    }
  });
  $('check-now').addEventListener('click', async () => {
    $('alert-status').textContent = 'Checking…';
    await api.refreshAlerts();
    const active = await api.getActiveAlerts();
    $('alert-status').textContent = active.length ? `${active.length} active alert(s).` : 'No active alerts.';
  });

  api.onConfigChanged((next) => {
    const placesChanged = JSON.stringify(next.places) !== JSON.stringify(cfg.places);
    const locationChanged = JSON.stringify(next.location) !== JSON.stringify(cfg.location);
    cfg = next;
    if (locationChanged) {
      if (!['home-name', 'home-lat', 'home-lon'].includes(document.activeElement?.id)) renderHome();
      syncSourceSelect();
    }
    // Re-render the list only when it changed elsewhere (e.g. saved from the map) and isn't being edited.
    if (placesChanged && !$('places').contains(document.activeElement)) renderPlaces();
  });

  // ----- town search
  const doSearch = async () => {
    const q = $('loc-search').value.trim();
    const box = $('loc-results');
    box.textContent = '';
    if (!q) return;
    $('loc-status').textContent = 'Searching…';
    const results = await api.searchPlace(q);
    $('loc-status').textContent = results && results.length ? '' : 'No matches.';
    for (const r of results || []) {
      const b = Object.assign(document.createElement('button'), { textContent: (r.kind === 'address' ? '🏠 ' : '📍 ') + r.label });
      b.style.margin = '2px 6px 2px 0';
      b.addEventListener('click', async () => {
        const exact = r.kind === 'address';
        $('home-name').value = r.name;
        await setHome(r.lat, r.lon, exact ? `Home set to ${r.label}.` : `Set to ${r.label} (town center). Search your street address for an exact spot.`, r.name);
        box.textContent = '';
        api.openMapAt(r.lat, r.lon, exact ? 16 : 11);
      });
      box.append(b);
    }
  };
  $('loc-search-btn').addEventListener('click', doSearch);
  $('loc-search').addEventListener('keydown', (e) => e.key === 'Enter' && doSearch());

  // ----- WeatherWise (site) preferences
  const prefEls = [...document.querySelectorAll('[data-site-pref]')];
  const renderPrefs = (prefs) => {
    const ok = !!prefs;
    $('ww-prefs-body').style.opacity = ok ? '1' : '.45';
    $('ww-prefs-hint').innerHTML = ok
      ? "The same settings as the site's <b>My Preferences</b> and <b>Map Settings</b>; Map options reload the map to apply (your view is kept)."
      : 'Open the map window to change WeatherWise preferences.';
    for (const el of prefEls) {
      el.disabled = !ok;
      if (!ok) continue;
      const v = prefs[el.dataset.sitePref];
      if (el.type === 'checkbox') el.checked = !!v;
      else if (v != null) el.value = String(v);
    }
  };
  for (const el of prefEls) {
    el.addEventListener('change', async () => {
      const value = el.type === 'checkbox' ? el.checked : el.value;
      const ok = await api.setSitePref(el.dataset.sitePref, value);
      if (ok) flashSaved();
    });
  }
  for (const b of document.querySelectorAll('[data-site-dialog]')) {
    b.addEventListener('click', () => api.openSiteDialog(b.dataset.siteDialog));
  }
  api.onSitePrefsChanged(renderPrefs);
  renderPrefs(await api.getSitePrefs());
  window.addEventListener('focus', async () => renderPrefs(await api.getSitePrefs()));

  // ----- updates
  const renderUpdate = (u) => {
    if (!u) return;
    const base = u.canSelfUpdate ? 'The AppImage updates itself from GitHub Releases.' : 'This install gets update notices from GitHub Releases.';
    const msg = {
      checking: 'Checking for updates…',
      none: 'You have the latest version.',
      disabled: 'Updates are off in development builds.',
      available: `Version ${u.version} is available.`,
      downloading: `Downloading ${u.version}… ${u.percent ?? 0}%`,
      ready: `Version ${u.version} is ready — restart to install.`,
      error: `Update check failed: ${u.message}`,
    }[u.state];
    $('update-status').textContent = msg ? `${msg} ${u.state === 'none' || u.state === 'idle' ? base : ''}`.trim() : base;
  };
  $('update-check').addEventListener('click', () => api.checkForUpdates());
  api.onUpdateState(renderUpdate);
  renderUpdate(await api.getUpdateState());

  $('restart').addEventListener('click', () => api.relaunch());

  const info = await api.appInfo();
  $('about').textContent = `WeatherWise for Linux ${info.version} · Electron ${info.electron} · Chromium ${info.chrome} · config: ${info.configFile}. Unofficial wrapper, not affiliated with WeatherWise.`;
}

init();
