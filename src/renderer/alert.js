const api = window.wwLocal;
const $ = (id) => document.getElementById(id);
const fmt = (s) => (s ? new Date(s).toLocaleString(undefined, { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }) : '—');

async function init() {
  const id = new URLSearchParams(location.search).get('id');
  const a = id ? await api.getAlert(id) : null;
  if (!a) {
    $('event').textContent = 'Alert no longer available';
    $('instruction-card').style.display = 'none';
    $('map').style.display = $('web').style.display = 'none';
    return;
  }
  document.title = a.event;
  $('event').textContent = a.event;
  $('area').textContent = a.areaDesc;
  const sev = $('sev');
  sev.textContent = a.severity;
  sev.classList.add(`sev-${a.severity}`);
  $('headline').textContent = a.headline || '';
  $('times').textContent = `Issued ${fmt(a.sent)} · Effective ${fmt(a.effective)} · Expires ${fmt(a.ends || a.expires)} · ${a.urgency} / ${a.certainty}`;
  if (a.instruction) $('instruction').textContent = a.instruction;
  else $('instruction-card').style.display = 'none';
  $('description').textContent = a.description || '';
  $('sender').textContent = a.senderName ? `Issued by ${a.senderName}. Watching: ${a.location.name}.` : '';
  $('map').addEventListener('click', () => {
    const c = a.centroid || a.location;
    api.openMapAt(c.lat, c.lon);
  });
  const web = a.web || a.id;
  if (web && /^https:/.test(web)) $('web').addEventListener('click', () => api.openExternal(web));
  else $('web').style.display = 'none';
}

init();
