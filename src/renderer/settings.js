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
      if (el.tagName === 'SELECT' && v != null && ![...el.options].some((o) => o.value === String(v))) {
        el.append(new Option(el.dataset.key === 'general.zoom' ? `${Math.round(v * 100)}%` : String(v), String(v)));
      }
      el.value = v ?? '';
    }
    el.addEventListener('change', async () => {
      let value;
      if (el.type === 'checkbox') value = el.checked;
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
  await save({ location: { home: { name: $('home-name').value.trim() || 'Home', lat, lon } } });
}
async function setHome(lat, lon, label) {
  const r4 = (n) => Math.round(n * 10000) / 10000;
  await save({ location: { home: { name: $('home-name').value.trim() || 'Home', lat: r4(lat), lon: r4(lon) } } });
  renderHome();
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
    row.append(name, lat, lon, bellLabel, go, del);
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
    cfg = next;
    // Re-render the list only when it changed elsewhere (e.g. saved from the map) and isn't being edited.
    if (placesChanged && !$('places').contains(document.activeElement)) renderPlaces();
  });

  $('restart').addEventListener('click', () => api.relaunch());

  const info = await api.appInfo();
  $('about').textContent = `WeatherWise for Linux ${info.version} · Electron ${info.electron} · Chromium ${info.chrome} · config: ${info.configFile}. Unofficial wrapper, not affiliated with WeatherWise.`;
}

init();
