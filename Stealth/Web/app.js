/* Stealth renderer */
const $ = (s) => document.querySelector(s);
const store = {
  get(k, d) { try { const v = JSON.parse(localStorage.getItem(k)); return v ?? d; } catch { return d; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} }
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const pad = (n) => String(n).padStart(2, '0');
const fmt = (ll) => `${ll[0].toFixed(5)}, ${ll[1].toFixed(5)}`;
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

// ====================== settings ======================
const DEFAULTS = {
  speed: 5, speedVar: 0, routeMode: 'roads', loop: false, pauseWp: 0, tick: 1000, drift: 0,
  instantClick: false, fly: true, tpZoom: 14, geocode: true, autoStop: 0, stopConfirm: false, stopOnClose: true, restoreLast: true,
  mapStyle: 'dark', units: 'km', trail: true, follow: true, showCoords: false,
  accent: '#4aa3ff', compact: false, scale: 1, anim: true, sound: false, showBattery: true, alwaysOnTop: false, shortcuts: true, openReq: false
};
let cfg = { ...DEFAULTS, ...store.get('cfg', {}) };
if (store.get('spd', null) && !store.get('cfg', null)) cfg.speed = store.get('spd');
const saveCfg = () => store.set('cfg', cfg);

// ====================== state ======================
let current = null;            // simulated position
let meMarker = null, realMarker = null;
let mode = 'tp';
let wps = [], wpMarkers = [], routeLine = null, pathLine = null;
let rt = null;                 // route runtime {path, stops, seg, pos, covered, total, done}
let walking = false;
let simStart = null, simTimer = null, autoStopAt = null;
let trailPts = [], trailLine = null;
let panelOpen = null;

// ====================== helpers ======================
function toast(msg, ms = 3500) { const t = $('#toast'); t.textContent = msg; t.classList.remove('hidden'); clearTimeout(toast.t); toast.t = setTimeout(() => t.classList.add('hidden'), ms); }
let ac;
function beep(kind) {
  if (!cfg.sound) return;
  try {
    ac = ac || new (window.AudioContext || window.webkitAudioContext)();
    ({ ok: [660, 880], stop: [660, 440], err: [220, 170] }[kind] || []).forEach((f, i) => {
      const o = ac.createOscillator(), g = ac.createGain(); o.type = 'sine'; o.frequency.value = f; g.gain.value = 0.05; o.connect(g); g.connect(ac.destination);
      const t = ac.currentTime + i * 0.12; o.start(t); o.stop(t + 0.1);
    });
  } catch {}
}
const R = 6371000, rad = (d) => d * Math.PI / 180;
const dist = (a, b) => { const dl = rad(b[0] - a[0]), dn = rad(b[1] - a[1]); const x = Math.sin(dl / 2) ** 2 + Math.cos(rad(a[0])) * Math.cos(rad(b[0])) * Math.sin(dn / 2) ** 2; return 2 * R * Math.asin(Math.sqrt(x)); };
const fmtDist = (m) => cfg.units === 'mi' ? `${(m / 1609.344).toFixed(m < 160934 ? 1 : 0)} mi` : `${(m / 1000).toFixed(m < 100000 ? 1 : 0)} km`;
const speedLabel = (kmh) => cfg.units === 'mi' ? `${Math.round(kmh / 1.609344)} mph` : `${kmh} km/h`;
const fmtDur = (s) => { s = Math.round(s); const h = Math.floor(s / 3600), m = Math.floor(s / 60) % 60; return h ? `${h} h ${m} min` : m ? `${m} min` : `${s} s`; };
function hexRgb(h) { const n = parseInt(h.slice(1), 16); return [(n >> 16) & 255, (n >> 8) & 255, n & 255]; }
function drift(lat, lon) {
  const r = cfg.drift; if (!r) return [lat, lon];
  const a = Math.random() * 2 * Math.PI, d = Math.sqrt(Math.random()) * r;
  return [lat + (d * Math.cos(a)) / 111320, lon + (d * Math.sin(a)) / (111320 * Math.cos(rad(lat)))];
}
const nameCache = new Map();
async function placeName(ll) {
  if (!cfg.geocode) return '';
  const k = ll.map((v) => v.toFixed(3)).join();
  if (nameCache.has(k)) return nameCache.get(k);
  try {
    const j = await (await fetch(`https://nominatim.openstreetmap.org/reverse?format=jsonv2&zoom=12&lat=${ll[0]}&lon=${ll[1]}`)).json();
    const a = j.address || {};
    const n = [a.city || a.town || a.village || a.county, a.state, a.country].filter(Boolean).join(', ') || j.display_name || '';
    nameCache.set(k, n); return n;
  } catch { return ''; }
}

// ====================== window buttons ======================
document.querySelectorAll('#winbtns button').forEach((b) => b.onclick = () => stealth.win(b.dataset.w));

// ====================== map ======================
const lastView = store.get('last', null);
const map = L.map('map', { zoomControl: false, attributionControl: false, worldCopyJump: true, minZoom: 2 }).setView(lastView && cfg.restoreLast ? lastView : [37.5, -96], lastView && cfg.restoreLast ? 12 : 4);
L.control.attribution({ prefix: false }).addTo(map);
const ESRI = 'https://server.arcgisonline.com/ArcGIS/rest/services/';
let tileLayers = [], shownStyle = null;
function setMapStyle() {
  if (shownStyle === cfg.mapStyle) return; shownStyle = cfg.mapStyle;
  tileLayers.forEach((l) => map.removeLayer(l)); tileLayers = []; $('#map').classList.remove('osm-dark');
  const add = (u, o) => { const l = L.tileLayer(u, o).addTo(map); tileLayers.push(l); return l; };
  const st = cfg.mapStyle;
  if (st === 'dark' || st === 'darknl') {
    const base = add(ESRI + 'Canvas/World_Dark_Gray_Base/MapServer/tile/{z}/{y}/{x}', { maxNativeZoom: 16, maxZoom: 19, attribution: 'Tiles © Esri · © OpenStreetMap contributors' });
    if (st === 'dark') add(ESRI + 'Canvas/World_Dark_Gray_Reference/MapServer/tile/{z}/{y}/{x}', { maxNativeZoom: 16, maxZoom: 19 });
    let ok = 0, err = 0;
    base.on('tileload', () => ok++);
    base.on('tileerror', () => { if (++err > 6 && !ok && shownStyle === st) { tileLayers.forEach((l) => map.removeLayer(l)); tileLayers = []; $('#map').classList.add('osm-dark'); add('https://tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 19, attribution: '© OpenStreetMap contributors' }); } });
  } else if (st === 'sat') {
    add(ESRI + 'World_Imagery/MapServer/tile/{z}/{y}/{x}', { maxNativeZoom: 18, maxZoom: 19, attribution: 'Tiles © Esri' });
    add(ESRI + 'Reference/World_Boundaries_and_Places/MapServer/tile/{z}/{y}/{x}', { maxNativeZoom: 18, maxZoom: 19 });
  } else add('https://tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 19, attribution: '© OpenStreetMap contributors' });
}
$('#zi').onclick = () => map.zoomIn(); $('#zo').onclick = () => map.zoomOut();
map.on('mousemove', (e) => { if (cfg.showCoords) $('#coords').textContent = `${e.latlng.lat.toFixed(5)}, ${e.latlng.lng.toFixed(5)}`; });

const meIcon = L.divIcon({ className: '', html: '<div class="me"></div>', iconSize: [22, 22], iconAnchor: [11, 11] });
const realIcon = L.divIcon({ className: '', html: '<div class="real"></div>', iconSize: [18, 18], iconAnchor: [9, 9] });

// ---- "where am I" ----
async function locate() {
  if (current) { map.flyTo(current, Math.max(map.getZoom(), 14)); toast('Showing your simulated position'); return; }
  toast('Finding your real location…', 6000);
  let ll = stealth.realLocation ? await stealth.realLocation() : await new Promise((res) => {
    if (!navigator.geolocation) return res(null);
    navigator.geolocation.getCurrentPosition((p) => res([p.coords.latitude, p.coords.longitude]), () => res(null), { timeout: 5000, maximumAge: 60000 });
  });
  let approx = false;
  if (!ll) {
    try { const j = await (await fetch('https://ipwho.is/')).json(); if (j && j.latitude) { ll = [j.latitude, j.longitude]; approx = true; } } catch {}
  }
  if (!ll) return toast('⚠ Could not determine your location');
  if (realMarker) realMarker.setLatLng(ll); else realMarker = L.marker(ll, { icon: realIcon, interactive: false, zIndexOffset: -100 }).addTo(map);
  map.flyTo(ll, approx ? 11 : 15);
  toast(approx ? 'Approximate location (from your internet connection)' : 'Your real location', 5000);
}
$('#locate').onclick = locate;

// ====================== teleport ======================
function trailAdd(ll, reset) {
  if (reset) { trailPts = []; if (trailLine) { trailLine.remove(); trailLine = null; } }
  if (!ll || !cfg.trail) return;
  trailPts.push(ll);
  if (trailPts.length > 1) { if (trailLine) trailLine.setLatLngs(trailPts); else trailLine = L.polyline(trailPts, { color: getComputedStyle(document.documentElement).getPropertyValue('--ac').trim() || '#4aa3ff', weight: 3, opacity: 0.55 }).addTo(map); }
}
async function teleport(lat, lon, o = {}) {
  if (!o.quiet) toast('Sending location to iPhone… (the first time can take a minute)', 60000);
  const [la, lo] = drift(lat, lon);
  const r = await stealth.setLocation(la, lo);
  if (!r.ok) {
    beep('err');
    toast('⚠ ' + (/tunneld|Phone link/i.test(r.error || '') ? 'Phone link not active — click your iPhone (top left) and press Start' : (r.error || 'Failed')), 12000);
    return false;
  }
  current = [lat, lon]; if (cfg.restoreLast) store.set('last', current);
  if (meMarker) meMarker.setLatLng(current); else meMarker = L.marker(current, { icon: meIcon, interactive: false }).addTo(map);
  trailAdd(current, !o.quiet);
  if (!o.quiet) {
    if (cfg.fly) map.flyTo(current, Math.max(map.getZoom(), cfg.tpZoom));
    beep('ok'); toast(`Teleported to ${fmt(current)}`);
    addRecent(current, o.name);
  }
  simOn(!o.quiet);
  return true;
}

// ====================== simulation session ======================
function renderSim() {
  if (!simStart) return;
  const s = Math.floor((Date.now() - simStart) / 1000);
  $('#sim-time').textContent = `${pad(Math.floor(s / 3600))}:${pad(Math.floor(s / 60) % 60)}:${pad(s % 60)}`;
  if (autoStopAt) {
    const left = Math.max(0, Math.round((autoStopAt - Date.now()) / 1000));
    $('#sim-sub').textContent = `auto-stop ${pad(Math.floor(left / 60))}:${pad(left % 60)}`;
    if (left <= 0) { autoStopAt = null; stopSim({ force: true, auto: true }); }
  } else $('#sim-sub').textContent = 'elapsed';
}
async function simOn(reset) {
  if (reset || !simStart) { simStart = Date.now(); autoStopAt = cfg.autoStop ? simStart + cfg.autoStop * 60000 : null; }
  $('#simbar').classList.remove('hidden');
  if (current) {
    const at = current; $('#sim-place').textContent = fmt(at);
    if (reset) placeName(at).then((n) => { if (n && current === at) { $('#sim-place').textContent = n + ' · ' + fmt(at); pushSim(); } });
  }
  renderSim(); clearInterval(simTimer); simTimer = setInterval(renderSim, 1000); pushAppCfg(); pushSim();
}
function simOff() { simStart = null; autoStopAt = null; clearInterval(simTimer); $('#simbar').classList.add('hidden'); pushAppCfg(); pushSim(); }
async function stopSim(o = {}) {
  if (cfg.stopConfirm && !o.force && !confirm('Stop the simulation and return to your real location?')) return;
  const btn = $('#sim-stop'); walking = false; btn.disabled = true; btn.classList.add('busy'); $('#sim-stop-t').textContent = 'Stopping…';
  const r = await stealth.clearLocation();
  btn.disabled = false; btn.classList.remove('busy'); $('#sim-stop-t').textContent = 'Stop';
  if (!r.ok) { beep('err'); toast('⚠ ' + (r.error || 'Could not stop the simulation'), 10000); return; }
  simOff(); current = null; store.set('last', null);
  if (meMarker) { meMarker.remove(); meMarker = null; }
  trailAdd(null, true); trailPts = [];
  beep('stop'); toast(o.auto ? 'Auto-stop: back to your real location' : 'Stopped — your iPhone is back to its real location', 6000);
}
$('#sim-stop').onclick = () => stopSim();
$('#b-clear').onclick = () => stopSim();

function pushSim() {
  if (window.stealth && stealth.simNotify) stealth.simNotify({ active: !!simStart, start: simStart || 0, place: ($('#sim-place').textContent || '').trim() });
}
function pushAppCfg() { if (window.stealth && stealth.appConfig) stealth.appConfig({ alwaysOnTop: cfg.alwaysOnTop, scale: cfg.scale, stopOnClose: cfg.stopOnClose, simActive: !!simStart }); }

// ====================== panels ======================
const PANELS = { 'req': '#device', 'tools-p': '#b-tools', 'saved': '#b-saved', 'settings': '#b-settings', 'help': '#b-help', 'phoneapp': '#b-app' };
function openPanel(id) {
  Object.keys(PANELS).forEach((p) => { $('#' + p).classList.toggle('hidden', p !== id); $(PANELS[p]).classList.toggle('on', p === id); });
  panelOpen = id;
  if (id === 'req') recheck(); if (id === 'saved') renderSaved(); if (id === 'tools-p') renderTools(); if (id === 'settings') renderSettings();
}
function closePanels() { Object.keys(PANELS).forEach((p) => { $('#' + p).classList.add('hidden'); $(PANELS[p]).classList.remove('on'); }); panelOpen = null; }
const togglePanel = (id) => panelOpen === id ? closePanels() : openPanel(id);
$('#device').onclick = () => togglePanel('req');
$('#b-tools').onclick = () => togglePanel('tools-p'); $('#b-saved').onclick = () => togglePanel('saved');
$('#b-settings').onclick = () => togglePanel('settings'); $('#b-app').onclick = () => togglePanel('phoneapp'); $('#b-help').onclick = () => togglePanel('help');
document.querySelectorAll('[data-close]').forEach((b) => b.onclick = closePanels);
document.querySelectorAll('[data-url]').forEach((b) => b.onclick = (e) => { e.preventDefault(); stealth.openExternal(b.dataset.url); });

// ====================== requirements / device ======================
let checking = false, firstCheck = true;
async function recheck() {
  if (checking) return; checking = true; $('#b-recheck').textContent = 'Checking…';
  try {
    const r = await stealth.requirements();
    document.querySelectorAll('#checks li').forEach((li) => li.classList.toggle('ok', !!r[li.dataset.k]));
    const link = !!r.link, d = r.device;
    if (stealth.native) {
      document.querySelectorAll('#n-checks li').forEach((li) => li.classList.toggle('ok', !!r[li.dataset.nk]));
      $('#req-text').textContent = 'iOS 17.4 or later with Developer Mode turned on (Settings → Privacy & Security → Developer Mode, then restart).';
    }
    $('#dev-dot').className = 'dot ' + (link ? 'grn' : r.usb ? 'amb' : 'red');
    $('#dev-name').textContent = d ? d.name || 'iPhone' : 'No Device';
    $('#dev-sub').textContent = d ? `iOS ${d.version || '?'} · ${link ? 'Ready' : (stealth.native ? 'Setup needed' : 'Link not active')}` : 'Connect an iPhone';
    const bat = $('#bat');
    if (cfg.showBattery && d && typeof d.battery === 'number') {
      bat.classList.remove('hidden', 'low', 'mid'); if (d.battery <= 20) bat.classList.add('low'); else if (d.battery <= 40) bat.classList.add('mid');
      $('#bat-fill').style.width = Math.max(4, d.battery) + '%'; $('#bat-pct').textContent = d.battery + '%'; $('#bat-bolt').classList.toggle('hidden', !d.charging);
    } else bat.classList.add('hidden');
    $('#r-dot').className = 'dot ' + (r.usb ? 'grn' : 'red');
    $('#r-state').textContent = r.usb ? (link ? 'Connected' : 'Connected — start the phone link') : 'Not connected';
    $('#msg').textContent = !r.python ? 'Python 3 is required. Install it from python.org (tick “Add to PATH”).' : !r.pmd3 ? 'Click “Install” to download the engine.' : '';
    if (firstCheck) { firstCheck = false; if ((cfg.openReq || stealth.native) && !link) openPanel('req'); }
  } finally { checking = false; $('#b-recheck').textContent = 'Re-check'; }
}
$('#b-recheck').onclick = recheck;
$('#b-admin').onclick = () => stealth.restartAdmin();
async function installEngine() { toast('Installing / updating the engine (pymobiledevice3)…', 60000); const r = await stealth.installDeps(); toast(r.ok ? 'Engine ready' : '⚠ ' + (r.error || 'Install failed'), 6000); recheck(); }
$('#b-install').onclick = async () => { $('#msg').textContent = 'Installing pymobiledevice3…'; const r = await stealth.installDeps(); $('#msg').textContent = r.ok ? 'Installed.' : r.error; recheck(); };
async function startLink() { toast('Approve the administrator prompt to start the phone link…', 8000); await stealth.startLink(); setTimeout(recheck, 6000); }
$('#b-link').onclick = startLink;
if (stealth.native) {
  const note = async (p, ok) => { const r = await p; if (r && r.ok) { toast(ok); recheck(); } else if (r && r.error && r.error !== 'Cancelled') toast('⚠ ' + r.error, 8000); };
  $('#n-import').onclick = () => note(stealth.importPairing(), 'Pairing file imported');
  $('#n-paste').onclick = () => note(stealth.pastePairing(), 'Pairing file imported from clipboard');
  $('#n-vpn').onclick = () => stealth.openVPN();
}
if (stealth.remoteInfo) stealth.remoteInfo().then((i) => { $('#rm-url').textContent = i.urls.length ? i.urls.join('  ·  ') : 'Network unavailable'; $('#rm-pin').textContent = i.pin; });
recheck(); setInterval(() => { if (!document.hidden) recheck(); }, 10000);

// ====================== search ======================
let st; const res = $('#results');
function showResults(items) {
  res.innerHTML = '';
  items.forEach((it) => { const li = document.createElement('li'); li.textContent = it.display_name; li.onclick = () => pick(it); res.appendChild(li); });
  res.classList.toggle('hidden', !items.length); res._items = items;
}
function pick(it) { res.classList.add('hidden'); $('#search').value = it.display_name; const ll = [+it.lat, +it.lon]; map.flyTo(ll, 14); setTimeout(() => openAt(ll, it.display_name), 600); }
$('#search').addEventListener('input', (e) => {
  clearTimeout(st); const q = e.target.value.trim(); if (q.length < 3) { res.classList.add('hidden'); return; }
  st = setTimeout(async () => {
    try {
      const m = q.match(/^\s*(-?\d+(\.\d+)?)\s*[, ]\s*(-?\d+(\.\d+)?)\s*$/);
      showResults(m ? [{ display_name: `Coordinates ${m[1]}, ${m[3]}`, lat: m[1], lon: m[3] }] : await (await fetch('https://nominatim.openstreetmap.org/search?format=json&limit=6&q=' + encodeURIComponent(q))).json());
    } catch { toast('Search failed (offline?)'); }
  }, 450);
});
$('#search').addEventListener('keydown', (e) => { if (e.key === 'Enter' && res._items && res._items[0]) pick(res._items[0]); if (e.key === 'Escape') { res.classList.add('hidden'); e.target.blur(); } });
document.addEventListener('click', (e) => { if (!e.target.closest('#searchwrap')) res.classList.add('hidden'); });

// ====================== places (saved / recent) ======================
let savedTab = 'saved';
function addRecent(ll, name) {
  const l = store.get('recent', []).filter((p) => dist(p.ll, ll) > 30);
  const item = { name: name || fmt(ll), ll, t: Date.now() }; l.unshift(item); store.set('recent', l.slice(0, 25));
  if (!name) placeName(ll).then((n) => { if (!n) return; const cur = store.get('recent', []); const f = cur.find((p) => p.t === item.t); if (f) { f.name = n; store.set('recent', cur); if (panelOpen === 'saved') renderSaved(); } });
}
function renderSaved() {
  const list = store.get(savedTab, []), ul = $('#saved-list'); ul.innerHTML = '';
  document.querySelectorAll('#saved-tabs button').forEach((b) => b.classList.toggle('on', b.dataset.t === savedTab));
  list.forEach((p, i) => {
    const li = document.createElement('li');
    li.innerHTML = `<div class="nm"><b>${esc(p.name)}</b><small>${fmt(p.ll)}</small></div><button class="go" title="Teleport here">▶</button><button class="x" title="${savedTab === 'saved' ? 'Remove' : 'Save'}">${savedTab === 'saved' ? '✕' : '★'}</button>`;
    li.onclick = (e) => {
      const b = e.target.closest('button');
      if (b && b.classList.contains('go')) { setMode('tp'); teleport(p.ll[0], p.ll[1], { name: p.name }); return; }
      if (b && b.classList.contains('x')) {
        if (savedTab === 'saved') { list.splice(i, 1); store.set('saved', list); } else { const s = store.get('saved', []); s.push({ name: p.name, ll: p.ll }); store.set('saved', s); toast('Saved'); }
        renderSaved(); return;
      }
      map.flyTo(p.ll, 14); setTimeout(() => openAt(p.ll, p.name), 600);
    };
    ul.appendChild(li);
  });
  $('#saved-hint').textContent = list.length ? '' : savedTab === 'saved' ? 'Nothing saved yet. Click the map and press “★ Save”.' : 'Places you teleport to appear here.';
}
document.querySelectorAll('#saved-tabs button').forEach((b) => b.onclick = () => { savedTab = b.dataset.t; renderSaved(); });

// ====================== modes / map clicks ======================
function setMode(m) { mode = m; $('#m-tp').classList.toggle('on', m === 'tp'); $('#m-route').classList.toggle('on', m === 'route'); $('#routebar').classList.toggle('hidden', m !== 'route'); map.closePopup(); }
$('#m-tp').onclick = () => setMode('tp'); $('#m-route').onclick = () => setMode('route');

function openAt(ll, name) {
  if (mode !== 'tp') return;
  const el = document.createElement('div'); el.className = 'pop';
  const title = document.createElement('b'); title.textContent = (name || 'Selected place').slice(0, 60);
  el.append(title, document.createElement('br'));
  const sm = document.createElement('small'); sm.textContent = fmt(ll); el.append(sm, document.createElement('br'));
  if (!name) placeName(ll).then((n) => { if (n) title.textContent = n; });
  const go = Object.assign(document.createElement('button'), { textContent: 'Teleport here', onclick: () => { map.closePopup(); teleport(ll[0], ll[1], { name: name || title.textContent }); } });
  const sv = Object.assign(document.createElement('button'), { className: 's', textContent: '★ Save', onclick: () => { const l = store.get('saved', []); l.push({ name: name || title.textContent || fmt(ll), ll }); store.set('saved', l); toast('Saved'); map.closePopup(); } });
  el.append(go, sv); L.popup({ closeButton: false, offset: [0, -2] }).setLatLng(ll).setContent(el).openOn(map);
}

map.on('click', (e) => {
  const ll = [e.latlng.lat, e.latlng.lng];
  if (panelOpen && window.innerWidth <= 700) closePanels();
  if (mode === 'tp') return cfg.instantClick ? teleport(ll[0], ll[1]) : openAt(ll);
  if (walking) return;
  wps.push(ll); wpMarkers.push(L.marker(ll, { icon: L.divIcon({ className: '', html: '<div class="wp"></div>', iconSize: [12, 12] }) }).addTo(map));
  rt = null; drawLine(); routeInfo();
});
function drawLine() { if (routeLine) routeLine.remove(); routeLine = wps.length > 1 ? L.polyline(wps, { color: '#4aa3ff', weight: 3, dashArray: '6 6' }).addTo(map) : null; }
function routeInfo() {
  if (!wps.length) { $('#rinfo').textContent = 'Click the map to add waypoints'; return; }
  const d = wps.reduce((s, p, i) => i ? s + dist(wps[i - 1], p) : 0, 0);
  $('#rinfo').textContent = `${wps.length} point${wps.length > 1 ? 's' : ''}` + (d ? ` · ≥ ${fmtDist(d)} · ~${fmtDur(d / (cfg.speed / 3.6))}` : '');
}

// ====================== routes ======================
async function buildPath() {
  const prof = cfg.speed > 25 ? 'driving' : 'foot', path = [wps[0]], stops = new Set([0]);
  for (let i = 1; i < wps.length; i++) {
    let seg = [wps[i - 1], wps[i]];
    if (cfg.routeMode === 'roads') {
      try {
        const j = await (await fetch(`https://router.project-osrm.org/route/v1/${prof}/${wps[i - 1][1]},${wps[i - 1][0]};${wps[i][1]},${wps[i][0]}?overview=full&geometries=geojson`)).json();
        if (j.routes && j.routes[0]) seg = j.routes[0].geometry.coordinates.map((c) => [c[1], c[0]]);
      } catch {}
    }
    path.push(...seg.slice(1)); stops.add(path.length - 1);
  }
  return { path, stops };
}
const pathLen = (p) => p.reduce((s, q, i) => i ? s + dist(p[i - 1], q) : 0, 0);

async function runRoute() {
  if (walking) return;
  if (wps.length < 2 && !rt) return toast('Add at least 2 waypoints');
  walking = true; $('#r-go').textContent = 'Running…';
  try {
    if (!rt || rt.done) {
      $('#rinfo').textContent = 'Building route…';
      const { path, stops } = await buildPath();
      if (pathLine) pathLine.remove(); pathLine = L.polyline(path, { color: '#4aa3ff', weight: 4, opacity: 0.9 }).addTo(map);
      rt = { path, stops, seg: 0, pos: path[0], covered: 0, total: pathLen(path), done: false, lap: 0 };
      simStart = null; trailAdd(null, true);
      if (!(await teleport(path[0][0], path[0][1], { quiet: true }))) { walking = false; rt = null; return; }
      trailAdd(path[0], true);
    }
    while (walking && !rt.done) {
      const { path } = rt;
      const v = (cfg.speed * (1 + (Math.random() * 2 - 1) * cfg.speedVar / 100)) / 3.6;
      let left = v * (cfg.tick / 1000), hitStop = false;
      while (left > 0 && rt.seg < path.length - 1) {
        const d = dist(rt.pos, path[rt.seg + 1]);
        if (d <= left) { left -= d; rt.covered += d; rt.pos = path[++rt.seg]; if (rt.stops.has(rt.seg)) { hitStop = true; break; } }
        else { const f = left / d; rt.pos = [rt.pos[0] + (path[rt.seg + 1][0] - rt.pos[0]) * f, rt.pos[1] + (path[rt.seg + 1][1] - rt.pos[1]) * f]; rt.covered += left; left = 0; }
      }
      if (!(await teleport(rt.pos[0], rt.pos[1], { quiet: true }))) { walking = false; break; }
      trailAdd(rt.pos);
      if (cfg.follow) map.panTo(rt.pos, { animate: true, duration: 0.6 });
      $('#rinfo').textContent = `${Math.round(rt.covered / rt.total * 100)}% · ${fmtDist(rt.covered)} / ${fmtDist(rt.total)}`;
      if (rt.seg >= path.length - 1) {
        if (cfg.loop && walking) { rt.path = path.slice().reverse(); const n = path.length - 1; rt.stops = new Set([...rt.stops].map((i) => n - i)); rt.seg = 0; rt.pos = rt.path[0]; rt.covered = 0; rt.lap++; continue; }
        rt.done = true; break;
      }
      if (hitStop && cfg.pauseWp) { for (let s = 0; s < cfg.pauseWp && walking; s++) { $('#rinfo').textContent = `Waiting at waypoint… ${cfg.pauseWp - s}s`; await sleep(1000); } }
      else await sleep(cfg.tick);
    }
  } finally {
    walking = false; $('#r-go').textContent = rt && !rt.done ? 'Resume' : 'Start';
    if (rt && rt.done) { $('#rinfo').textContent = 'Route finished'; beep('ok'); }
  }
}
$('#r-go').onclick = runRoute;
$('#r-stop').onclick = () => { if (walking) { walking = false; $('#rinfo').textContent = 'Paused'; } };
function resetRoute() {
  walking = false; rt = null; wps = []; wpMarkers.forEach((m) => m.remove()); wpMarkers = [];
  if (routeLine) routeLine.remove(); routeLine = null; if (pathLine) pathLine.remove(); pathLine = null;
  $('#r-go').textContent = 'Start'; routeInfo();
}
$('#r-reset').onclick = resetRoute;

// ====================== iPhone app download ======================
$('#gh-repo').value = store.get('ghrepo', '');
$('#gh-repo').addEventListener('change', (e) => store.set('ghrepo', e.target.value.trim()));
$('#b-dl').onclick = async () => {
  const b = $('#b-dl'), msg = $('#dl-msg'), repo = $('#gh-repo').value.trim(); store.set('ghrepo', repo);
  b.disabled = true; b.textContent = 'Downloading…'; msg.textContent = 'Downloading Stealth.ipa from your GitHub release…';
  const r = await stealth.downloadApp(repo);
  b.disabled = false; b.textContent = 'Download';
  msg.textContent = r.ok ? `✓ ${r.name} (${(r.size / 1048576).toFixed(1)} MB) saved in your Downloads folder.` : `⚠ ${r.error}`;
};
// ====================== tools ======================
function download(name, text, type = 'application/json') {
  if (stealth.share) { stealth.share(name, text); return; } const a = document.createElement('a'); a.href = `data:${type};charset=utf-8,` + encodeURIComponent(text); a.download = name; document.body.appendChild(a); a.click(); a.remove(); }
function exportGpx() {
  const pts = rt ? rt.path : wps; if (pts.length < 2) return toast('Create a route first (Route mode)');
  download('stealth-route.gpx', `<?xml version="1.0" encoding="UTF-8"?>\n<gpx version="1.1" creator="Stealth" xmlns="http://www.topografix.com/GPX/1/1"><trk><name>Stealth route</name><trkseg>\n${pts.map((p) => `<trkpt lat="${p[0]}" lon="${p[1]}"/>`).join('\n')}\n</trkseg></trk></gpx>`, 'application/gpx+xml');
}
function exportPlaces() { download('stealth-places.json', JSON.stringify({ saved: store.get('saved', []), recent: store.get('recent', []) }, null, 2)); }
function importPlaces() {
  const i = document.createElement('input'); i.type = 'file'; i.accept = '.json,application/json';
  i.onchange = () => { const f = i.files[0]; if (!f) return; const r = new FileReader(); r.onload = () => { try { const j = JSON.parse(r.result); const s = store.get('saved', []); (j.saved || []).forEach((p) => p && p.ll && s.push({ name: String(p.name || fmt(p.ll)), ll: [+p.ll[0], +p.ll[1]] })); store.set('saved', s); toast(`Imported ${(j.saved || []).length} places`); renderSaved(); } catch { toast('⚠ Invalid file'); } }; r.readAsText(f); };
  i.click();
}
const TOOLS = [
  { ico: 'M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94z', t: 'Install / update engine', d: 'Downloads pymobiledevice3 (needs Python)', desk: true, f: installEngine },
  { ico: 'M13 2 4 14h7l-1 8 9-12h-7z', t: 'Start phone link', d: 'Opens the admin window that links your iPhone', desk: true, f: startLink },
  { ico: 'M12 2 4 6v6c0 5 3.5 8.500 8 10 4.500-1.500 8-5 8-10V6z', t: 'Restart as administrator', d: 'Some features need admin rights', desk: true, f: () => stealth.restartAdmin() },
  { ico: 'M12 22s7-6.100 7-12a7 7 0 1 0-14 0c0 5.900 7 12 7 12z', t: 'Go to coordinates…', d: 'Type latitude, longitude', f: () => { const v = prompt('Latitude, longitude (e.g. 40.6892, -74.0445)'); if (!v) return; const m = v.match(/(-?\d+(\.\d+)?)\s*[, ]\s*(-?\d+(\.\d+)?)/); if (!m) return toast('⚠ Invalid coordinates'); const ll = [+m[1], +m[3]]; closePanels(); map.flyTo(ll, 14); setTimeout(() => openAt(ll), 600); } },
  { ico: 'M8 4H6a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h8a2 2 0 0 0 2-2v-2M8 4a2 2 0 0 1 2-2h6l4 4v8a2 2 0 0 1-2 2h-8a2 2 0 0 1-2-2z', t: 'Copy current coordinates', d: 'Simulated position, or the map center', f: () => { const ll = current || [map.getCenter().lat, map.getCenter().lng]; try { navigator.clipboard.writeText(fmt(ll)); toast('Copied ' + fmt(ll)); } catch { toast(fmt(ll)); } } },
  { ico: 'M12 3v12m0 0-4-4m4 4 4-4M4 21h16', t: 'Export route (GPX)', d: 'Save the current route as a .gpx file', f: exportGpx },
  { ico: 'M12 3v12m0 0-4-4m4 4 4-4M4 21h16', t: 'Get the iPhone app', d: 'Control your location from the iPhone itself', desk: true, f: () => openPanel('phoneapp') },
  { ico: 'M12 2v4M12 18v4M2 12h4M18 12h4', t: 'Where am I', d: 'Center the map on your position', f: () => { closePanels(); locate(); } }
];
function renderTools() {
  const box = $('#tools-list'); box.innerHTML = '';
  TOOLS.forEach((t) => {
    const b = document.createElement('button'); b.className = 'tool' + (t.desk ? ' desktop' : '');
    b.innerHTML = `<span class="ti"><svg viewBox="0 0 24 24"><path d="${t.ico}"/></svg></span><span><b>${t.t}</b><small>${t.d}</small></span>`;
    b.onclick = t.f; box.appendChild(b);
  });
}

// ====================== settings UI ======================
const SCHEMA = [
  { t: 'Movement', items: [
    { type: 'presets', key: 'speed', label: 'Speed preset', opts: [['Walk', 5], ['Jog', 9], ['Bike', 18], ['Car', 50], ['Highway', 100]] },
    { type: 'range', key: 'speed', label: 'Speed', min: 1, max: 200, step: 1, fmt: speedLabel },
    { type: 'range', key: 'speedVar', label: 'Speed variation', desc: 'Random ± change of speed on every update', min: 0, max: 50, step: 1, fmt: (v) => v ? '±' + v + '%' : 'Off' },
    { type: 'seg', key: 'routeMode', label: 'Route type', opts: [['roads', 'Follow roads'], ['straight', 'Straight line']] },
    { type: 'toggle', key: 'loop', label: 'Loop route', desc: 'Walk back and forth until you pause' },
    { type: 'range', key: 'pauseWp', label: 'Pause at waypoints', min: 0, max: 60, step: 1, fmt: (v) => v ? v + ' s' : 'Off' },
    { type: 'select', key: 'tick', label: 'Update interval', desc: 'How often the position is sent', opts: [[500, '0.5 s'], [1000, '1 s'], [2000, '2 s'], [3000, '3 s']] },
    { type: 'range', key: 'drift', label: 'GPS drift', desc: 'Tiny random offset on every update, like real GPS wobble. Handy for testing apps', min: 0, max: 20, step: 1, fmt: (v) => v ? v + ' m' : 'Off' }
  ] },
  { t: 'Teleport & session', items: [
    { type: 'toggle', key: 'instantClick', label: 'Teleport on click', desc: 'Skip the confirmation popup in Teleport mode' },
    { type: 'toggle', key: 'fly', label: 'Zoom to location', desc: 'Move the map to the new position after teleporting' },
    { type: 'range', key: 'tpZoom', label: 'Zoom level', min: 8, max: 18, step: 1, fmt: (v) => String(v) },
    { type: 'select', key: 'autoStop', label: 'Auto-stop timer', desc: 'Return to your real location automatically', opts: [[0, 'Off'], [5, '5 min'], [15, '15 min'], [30, '30 min'], [60, '1 hour'], [120, '2 hours'], [240, '4 hours']] },
    { type: 'toggle', key: 'stopConfirm', label: 'Confirm before Stop' },
    { type: 'toggle', key: 'stopOnClose', label: 'Stop when closing the app', desc: 'Restores your real location on exit', desk: true },
    { type: 'toggle', key: 'geocode', label: 'Show place names', desc: 'Looks up city / country names online' },
    { type: 'toggle', key: 'restoreLast', label: 'Remember last position', desc: 'Open the map where you left it' }
  ] },
  { t: 'Map', items: [
    { type: 'select', key: 'mapStyle', label: 'Map style', opts: [['dark', 'Dark'], ['darknl', 'Dark (no labels)'], ['sat', 'Satellite'], ['light', 'Light']] },
    { type: 'seg', key: 'units', label: 'Units', opts: [['km', 'Kilometers'], ['mi', 'Miles']] },
    { type: 'toggle', key: 'trail', label: 'Show trail', desc: 'Draw the path you have moved along' },
    { type: 'toggle', key: 'follow', label: 'Follow marker on routes' },
    { type: 'toggle', key: 'showCoords', label: 'Show cursor coordinates' }
  ] },
  { t: 'Interface', items: [
    { type: 'colors', key: 'accent', label: 'Accent color', opts: ['#4aa3ff', '#8b7cff', '#34d399', '#f472b6', '#fb923c', '#f87171', '#22d3ee', '#facc15'] },
    { type: 'toggle', key: 'compact', label: 'Compact layout' },
    { type: 'range', key: 'scale', label: 'Interface size', min: 0.8, max: 1.5, step: 0.05, fmt: (v) => Math.round(v * 100) + '%', desk: true },
    { type: 'toggle', key: 'anim', label: 'Animations' },
    { type: 'toggle', key: 'sound', label: 'Sounds', desc: 'Short beeps on teleport, stop and errors' },
    { type: 'toggle', key: 'showBattery', label: 'Show iPhone battery' },
    { type: 'toggle', key: 'alwaysOnTop', label: 'Always on top', desk: true },
    { type: 'toggle', key: 'shortcuts', label: 'Keyboard shortcuts', desc: 'See Help for the full list' },
    { type: 'toggle', key: 'openReq', label: 'Open requirements on start', desc: 'Only when something is missing' }
  ] },
  { t: 'Data', items: [
    { type: 'actions', label: 'Places', btns: [['Export', exportPlaces], ['Import', importPlaces], ['Clear recent', () => { store.set('recent', []); toast('Recent places cleared'); }, 'danger']] },
    { type: 'actions', label: 'Route', btns: [['Export GPX', exportGpx]] },
    { type: 'actions', label: 'Settings', btns: [['Reset to defaults', () => { if (confirm('Reset all settings to defaults?')) { cfg = { ...DEFAULTS }; saveCfg(); applyCfg(); renderSettings(); } }, 'danger']] }
  ] }
];
function renderSettings() {
  const body = $('#set-body'); const keep = body.scrollTop; body.innerHTML = '';
  SCHEMA.forEach((g) => {
    const wrap = document.createElement('div'); wrap.className = 'sgroup'; wrap.innerHTML = `<h4>${g.t}</h4>`;
    const box = document.createElement('div'); box.className = 'sbox'; wrap.appendChild(box);
    g.items.forEach((it) => {
      const row = document.createElement('div'); row.className = 'srow' + (it.desk ? ' desktop' : '');
      const title = `<div class="t"><b>${it.label}</b>${it.desc ? `<small>${it.desc}</small>` : ''}</div>`;
      const set = (v) => { cfg[it.key] = v; saveCfg(); applyCfg(); };
      if (it.type === 'toggle') {
        row.innerHTML = title + `<span class="sw"><input type="checkbox" ${cfg[it.key] ? 'checked' : ''}><i></i></span>`;
        row.querySelector('input').onchange = (e) => set(e.target.checked);
      } else if (it.type === 'range') {
        row.classList.add('col'); row.innerHTML = `<div class="top">${title}<span class="val"></span></div><input type="range" min="${it.min}" max="${it.max}" step="${it.step}" value="${cfg[it.key]}">`;
        const inp = row.querySelector('input'), val = row.querySelector('.val');
        const upd = () => { val.textContent = it.fmt(+inp.value); inp.style.setProperty('--p', ((inp.value - it.min) / (it.max - it.min) * 100) + '%'); };
        inp.oninput = () => { upd(); set(+inp.value); if (it.key === 'speed') routeInfo(); }; upd();
      } else if (it.type === 'seg') {
        row.classList.add('col'); row.innerHTML = `<div class="top">${title}</div><div class="seg">${it.opts.map(([v, l]) => `<button data-v="${v}" class="${cfg[it.key] === v ? 'on' : ''}">${l}</button>`).join('')}</div>`;
        row.querySelectorAll('.seg button').forEach((b) => b.onclick = () => { row.querySelectorAll('.seg button').forEach((x) => x.classList.toggle('on', x === b)); set(b.dataset.v); if (it.key === 'units') renderSettings(); });
      } else if (it.type === 'select') {
        row.innerHTML = title + `<select>${it.opts.map(([v, l]) => `<option value="${v}" ${String(cfg[it.key]) === String(v) ? 'selected' : ''}>${l}</option>`).join('')}</select>`;
        row.querySelector('select').onchange = (e) => { const o = it.opts.find(([v]) => String(v) === e.target.value); set(o[0]); };
      } else if (it.type === 'presets') {
        row.classList.add('col'); row.innerHTML = `<div class="top">${title}</div><div class="chips">${it.opts.map(([l, v]) => `<button class="chip ${cfg.speed === v ? 'on' : ''}" data-v="${v}">${l} · ${speedLabel(v)}</button>`).join('')}</div>`;
        row.querySelectorAll('.chip').forEach((b) => b.onclick = () => { set(+b.dataset.v); renderSettings(); routeInfo(); });
      } else if (it.type === 'colors') {
        row.innerHTML = title + `<div class="sw-colors">${it.opts.map((c) => `<button style="background:${c}" data-v="${c}" class="${cfg[it.key] === c ? 'on' : ''}"></button>`).join('')}</div>`;
        row.querySelectorAll('.sw-colors button').forEach((b) => b.onclick = () => { row.querySelectorAll('button').forEach((x) => x.classList.toggle('on', x === b)); set(b.dataset.v); });
      } else if (it.type === 'actions') {
        row.innerHTML = title + `<div class="chips">${it.btns.map(([l], i) => `<button class="btn ${it.btns[i][2] || ''}" data-i="${i}">${l}</button>`).join('')}</div>`;
        row.querySelectorAll('button').forEach((b) => b.onclick = () => it.btns[+b.dataset.i][1]());
      }
      box.appendChild(row);
    });
    body.appendChild(wrap);
  });
  body.scrollTop = keep;
}
function applyCfg() {
  const [r, g, b] = hexRgb(cfg.accent), root = document.documentElement.style;
  root.setProperty('--ac', cfg.accent); root.setProperty('--ac-rgb', `${r},${g},${b}`);
  document.body.classList.toggle('compact', !!cfg.compact); document.body.classList.toggle('noanim', !cfg.anim);
  $('#coords').classList.toggle('hidden', !cfg.showCoords);
  if (trailLine) trailLine.setStyle({ color: cfg.accent });
  setMapStyle(); pushAppCfg();
  if (autoStopAt !== null || simStart) { autoStopAt = cfg.autoStop && simStart ? simStart + cfg.autoStop * 60000 : null; renderSim(); }
  if (!cfg.restoreLast) store.set('last', null);
  if (cfg.showBattery === false) $('#bat').classList.add('hidden');
}

// ====================== keyboard ======================
document.addEventListener('keydown', (e) => {
  const typing = /INPUT|TEXTAREA|SELECT/.test(document.activeElement.tagName);
  if (e.key === 'Escape') { closePanels(); map.closePopup(); res.classList.add('hidden'); return; }
  if (!cfg.shortcuts) return;
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') { e.preventDefault(); $('#search').focus(); return; }
  if (e.ctrlKey && e.shiftKey && e.key.toLowerCase() === 's') { e.preventDefault(); stopSim(); return; }
  if (typing || e.ctrlKey || e.metaKey || e.altKey) return;
  const k = e.key.toLowerCase();
  if (k === '/') { e.preventDefault(); $('#search').focus(); }
  else if (k === 't') setMode('tp'); else if (k === 'r') setMode('route');
  else if (k === 'l') locate(); else if (k === ',') togglePanel('settings'); else if (k === 'd') togglePanel('req'); else if (k === '?') togglePanel('help');
});

// ====================== init ======================
applyCfg(); setMapStyle(); routeInfo();
