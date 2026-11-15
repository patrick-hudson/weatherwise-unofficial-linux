const tb = window.wwTitlebar;
const $ = (id) => document.getElementById(id);
let placed = null;

// Window-button layout follows KDE's kwin settings (passed in by main), Breeze defaults otherwise.
function placeButtons(layout) {
  const map = { M: 'tpl-menu', I: 'tpl-minimize', A: 'tpl-maximize', X: 'tpl-close' };
  for (const [side, codes] of [['left', layout.left], ['right', layout.right]]) {
    const box = $(side);
    box.textContent = '';
    for (const c of codes) {
      const tpl = map[c] && document.getElementById(map[c]);
      if (tpl) box.append(tpl.content.cloneNode(true));
    }
  }
  for (const b of document.querySelectorAll('[data-act]')) {
    b.addEventListener('click', (e) => {
      const act = b.dataset.act;
      if (act === 'menu') {
        const r = b.getBoundingClientRect();
        tb.action('menu', { x: Math.round(r.left), y: Math.round(r.bottom) });
      } else tb.action(act);
      e.stopPropagation();
    });
  }
}

function render(s) {
  if (!s) return;
  document.body.classList.toggle('maximized', s.maximized);
  document.body.classList.toggle('inactive', !s.focused);
  document.body.classList.toggle('loading', s.loading);
  $('back').disabled = !s.canGoBack;
  $('forward').disabled = !s.canGoForward;
  const chip = $('alerts');
  if (s.alerts.count > 0) {
    chip.hidden = false;
    chip.className = `alert-chip sev-${s.alerts.severity || 'Severe'}`;
    $('alerts-text').textContent = s.alerts.count === 1 ? s.alerts.top : `${s.alerts.top} +${s.alerts.count - 1}`;
  } else chip.hidden = true;
  const key = s.buttons && JSON.stringify(s.buttons);
  if (key && key !== placed) {
    placed = key;
    placeButtons(s.buttons);
  }
}

$('back').addEventListener('click', () => tb.action('back'));
$('forward').addEventListener('click', () => tb.action('forward'));
$('reload').addEventListener('click', () => tb.action('reload'));
$('settings').addEventListener('click', () => tb.action('settings'));
$('places').addEventListener('click', () => {
  const r = $('places').getBoundingClientRect();
  tb.action('places', { x: Math.round(r.left), y: Math.round(r.bottom) });
});
$('alerts').addEventListener('click', () => {
  const r = $('alerts').getBoundingClientRect();
  tb.action('alerts', { x: Math.round(r.left), y: Math.round(r.bottom) });
});
// Double-click the title area: maximize/restore (drag regions don't get DOM events, so the
// title text area is the drag region and this is a fallback for the non-drag gaps).
document.getElementById('bar').addEventListener('dblclick', (e) => {
  if (e.target === e.currentTarget) tb.action('maximize');
});

tb.onState(render);
tb.getState().then(render);
