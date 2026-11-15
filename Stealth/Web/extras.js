// Extra tools: wait-time timer, quick places, move pad and the floating action menu.
// Loaded after app.js (shares its globals: cfg, store, map, current, teleport, ...).

// ---------- suggested wait time between far-apart teleports ----------
const CD_TABLE = [[1, 1], [5, 2], [10, 6], [25, 11], [30, 14], [65, 22], [81, 25], [100, 35], [250, 45], [500, 60], [750, 80], [1000, 100], [1500, 120]];
function cooldownMin(km) {
  if (km < 1) return 0;
  for (let i = 1; i < CD_TABLE.length; i++) {
    if (km <= CD_TABLE[i][0]) { const [x0, y0] = CD_TABLE[i - 1], [x1, y1] = CD_TABLE[i]; return y0 + (y1 - y0) * (km - x0) / (x1 - x0); }
  }
  return 120;
}
let cdEnd = 0, cdTimer = null;
function renderCd() {
  const el = $('#sim-cd'); if (!el) return;
  const left = Math.round((cdEnd - Date.now()) / 1000);
  if (!cdEnd || cfg.cooldown === false) { el.classList.add('hidden'); return; }
  el.classList.remove('hidden');
  if (left > 0) { el.className = 'sim-cd'; const h = Math.floor(left / 3600), m = Math.floor(left / 60) % 60, sec = left % 60; el.textContent = `Wait ${h ? h + ':' + pad(m) : pad(m)}:${pad(sec)} before the next jump`; return; }
  el.className = 'sim-cd done'; el.textContent = 'Ready for the next jump';
  clearInterval(cdTimer); cdTimer = null;
  setTimeout(() => { if (Date.now() >= cdEnd) { cdEnd = 0; renderCd(); } }, 8000);
}
window.onTeleported = (prev, next) => {
  if (!prev || cfg.cooldown === false) return;
  const m = cooldownMin(dist(prev, next) / 1000);
  if (m < 1) return;
  cdEnd = Date.now() + m * 60000; renderCd();
  clearInterval(cdTimer); cdTimer = setInterval(renderCd, 1000);
};

// ---------- quick places (saved places as chips) ----------
const quick = document.createElement('div'); quick.id = 'quick'; quick.className = 'hidden'; document.body.appendChild(quick);
let quickKey = '';
function renderQuick() {
  const list = store.get('saved', []).slice(0, 14);
  const key = JSON.stringify(list.map((p) => p.name + p.ll));
  if (key === quickKey) return; quickKey = key;
  quick.innerHTML = '';
  list.forEach((p) => {
    const b = document.createElement('button'); b.className = 'qchip'; b.textContent = (p.name || fmt(p.ll)).split(',')[0].slice(0, 22);
    b.onclick = () => { buzz('tap'); setMode('tp'); map.flyTo(p.ll, Math.max(map.getZoom(), 14)); setTimeout(() => openAt(p.ll, p.name), 500); };
    quick.appendChild(b);
  });
  quick.classList.toggle('hidden', !list.length);
}
renderQuick(); setInterval(renderQuick, 1500);

// ---------- move pad ----------
const padEl = document.createElement('div'); padEl.id = 'pad'; padEl.className = 'glass hidden';
padEl.innerHTML = `
  <div class="pad-top"><b>Move</b><button class="pad-x" aria-label="Close">&#10005;</button></div>
  <div class="pad-grid">
    <span></span><button data-d="n" aria-label="North">&#9650;</button><span></span>
    <button data-d="w" aria-label="West">&#9664;</button><i></i><button data-d="e" aria-label="East">&#9654;</button>
    <span></span><button data-d="s" aria-label="South">&#9660;</button><span></span>
  </div>
  <div class="pad-steps"></div>`;
document.body.appendChild(padEl);
let padStep = store.get('padStep', 25), padBusy = false;
const stepsBox = padEl.querySelector('.pad-steps');
[5, 25, 100, 500].forEach((m) => {
  const b = document.createElement('button'); b.textContent = m >= 1000 ? m / 1000 + ' km' : m + ' m'; b.dataset.m = m;
  b.onclick = () => { padStep = m; store.set('padStep', m); markSteps(); buzz('tap'); };
  stepsBox.appendChild(b);
});
function markSteps() { stepsBox.querySelectorAll('button').forEach((b) => b.classList.toggle('on', +b.dataset.m === padStep)); }
markSteps();
async function moveBy(dir) {
  if (padBusy) return;
  if (!current || !simStart) { toast('Teleport somewhere first'); return; }
  if (walking) { toast('Pause the route first'); return; }
  padBusy = true;
  const dN = dir === 'n' ? padStep : dir === 's' ? -padStep : 0, dE = dir === 'e' ? padStep : dir === 'w' ? -padStep : 0;
  const lat = current[0] + dN / 111320, lon = current[1] + dE / (111320 * Math.cos(rad(current[0])));
  buzz('tap');
  const ok = await teleport(lat, lon, { quiet: true });
  if (ok) { map.panTo(current); $('#sim-place').textContent = fmt(current); $('#sim-coords').textContent = ''; }
  padBusy = false;
}
padEl.querySelectorAll('.pad-grid button').forEach((b) => {
  let hold = null, rep = null;
  const stop = () => { clearTimeout(hold); clearInterval(rep); hold = rep = null; };
  b.addEventListener('pointerdown', (e) => { e.preventDefault(); moveBy(b.dataset.d); hold = setTimeout(() => { rep = setInterval(() => moveBy(b.dataset.d), 700); }, 500); });
  ['pointerup', 'pointerleave', 'pointercancel'].forEach((ev) => b.addEventListener(ev, stop));
});
padEl.querySelector('.pad-x').onclick = () => padEl.classList.add('hidden');

// ---------- floating action menu ----------
const fab = document.createElement('button'); fab.id = 'fab'; fab.className = 'glass'; fab.setAttribute('aria-label', 'Actions');
fab.innerHTML = '<svg viewBox="0 0 24 24"><path d="M12 5v14M5 12h14"/></svg>';
const fm = document.createElement('div'); fm.id = 'fabmenu'; fm.className = 'glass hidden';
document.body.append(fab, fm);
function fabItems() {
  const on = !!(current && simStart);
  return [
    { t: 'Move pad', d: 'Nudge your position', on, fn: () => { padEl.classList.toggle('hidden'); } },
    { t: 'Center on me', d: 'Fly to the simulated spot', on, fn: () => map.flyTo(current, Math.max(map.getZoom(), 15)) },
    { t: 'Save this spot', d: 'Add the current place to Saved', on, fn: () => { const l = store.get('saved', []); l.push({ name: ($('#sim-place').textContent || '').trim() || fmt(current), ll: current }); store.set('saved', l); toast('Saved'); renderQuick(); } },
    { t: 'Copy coordinates', d: on ? fmt(current) : 'No simulation yet', on, fn: () => copyText(fmt(current)) },
    { t: cfg.cooldown === false ? 'Wait-time timer: off' : 'Wait-time timer: on', d: 'Suggested wait after long jumps', on: true, fn: () => { cfg.cooldown = cfg.cooldown === false; saveCfg(); if (cfg.cooldown === false) { cdEnd = 0; } renderCd(); toast(cfg.cooldown === false ? 'Wait-time timer off' : 'Wait-time timer on'); } },
    { t: 'Stop simulation', d: 'Back to your real location', on, danger: true, fn: () => stopSim() }
  ];
}
function renderFab() {
  fm.innerHTML = '';
  fabItems().forEach((it) => {
    const b = document.createElement('button'); b.className = 'fi' + (it.danger ? ' danger' : ''); b.disabled = !it.on;
    b.innerHTML = `<b>${esc(it.t)}</b><small>${esc(it.d)}</small>`;
    b.onclick = () => { fm.classList.add('hidden'); fab.classList.remove('on'); it.fn(); };
    fm.appendChild(b);
  });
}
fab.onclick = (e) => { e.stopPropagation(); buzz('tap'); renderFab(); fm.classList.toggle('hidden'); fab.classList.toggle('on', !fm.classList.contains('hidden')); };
document.addEventListener('click', (e) => { if (!e.target.closest('#fabmenu') && !e.target.closest('#fab')) { fm.classList.add('hidden'); fab.classList.remove('on'); } });
// the pad only makes sense while a simulation is running
setInterval(() => { if (!simStart) padEl.classList.add('hidden'); }, 1000);

// ---------- keep the floating buttons clear of the simulation bar (phone layout) ----------
function layoutFloating() {
  if (window.innerWidth > 700) { [fab, fm, padEl].forEach((e) => { e.style.bottom = ''; e.style.top = ''; }); return; }
  const sb = $('#simbar'), vis = !sb.classList.contains('hidden');
  const above = vis ? Math.round(window.innerHeight - sb.getBoundingClientRect().top + 10) : null;
  const css = (n) => (vis ? `${n}px` : `calc(env(safe-area-inset-bottom) + ${n}px)`);
  const fabB = vis ? above : 170;
  fab.style.top = 'auto'; fab.style.bottom = css(fabB);
  fm.style.top = 'auto'; fm.style.bottom = css(fabB + 58);
  padEl.style.top = 'auto'; padEl.style.bottom = css(vis ? above : 84);
}
layoutFloating(); setInterval(layoutFloating, 400); window.addEventListener('resize', layoutFloating);
