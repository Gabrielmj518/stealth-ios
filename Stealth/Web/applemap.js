// Apple Maps (native MKMapView) engine. The map itself is drawn by iOS *behind* this transparent page;
// this file exposes the same small API as map.js (GLMap) so the rest of the app does not care.
// Markers and popups stay in the page: iOS tells us where to draw them on every camera change.
(function () {
  const H = window.webkit && window.webkit.messageHandlers && window.webkit.messageHandlers.applemap;
  window.AM_OK = !!H;
  if (!H) return;
  const send = (m) => { try { H.postMessage(m); } catch (e) { /* ignore */ } };

  let seq = 0;
  const items = new Map();                 // id -> { el, place(x, y) }
  const state = { lat: 37.5, lng: -96, z: 4, hd: 0, pt: 0, ready: false };
  const viewCbs = [], clickCbs = [];
  let failTimer = null;

  // ---------- events from iOS ----------
  window.__am = {
    ev(e) {
      if (!e) return;
      if (e.t === 'ready') {
        state.ready = true; clearTimeout(failTimer);
        document.documentElement.classList.add('apple-ready'); reportRects();
      } else if (e.t === 'fail') {
        giveUp();
      } else if (e.t === 'frame') {
        state.lat = e.lat; state.lng = e.lng; state.z = e.z; state.hd = e.hd; state.pt = e.pt;
        (e.p || []).forEach((p) => { const it = items.get(p[0]); if (it) it.place(p[1], p[2]); });
        viewCbs.forEach((f) => f(e.hd, e.pt));
      } else if (e.t === 'click') {
        clickCbs.forEach((f) => f({ latlng: { lat: e.lat, lng: e.lng } }));
      }
    }
  };
  function giveUp() {
    // Safe fallback: switch the beta off and reload with the normal map.
    try {
      const c = JSON.parse(localStorage.getItem('cfg') || '{}'); c.appleMap = false; localStorage.setItem('cfg', JSON.stringify(c));
    } catch (e) { /* ignore */ }
    location.reload();
  }

  // ---------- regions where the page wants the touches (everything else goes to the map) ----------
  const SEL = ['#tools', '#device', '#req', '#phoneapp', '#tools-p', '#saved', '#settings', '#help', '#searchwrap', '#results',
    '#modes', '#routebar', '#mapctl', '#stylemenu', '#zoom', '#locate', '#simbar', '#toast', '#quick', '#fab', '#fabmenu', '#pad', '.apopup'].join(',');
  let lastRects = '', rectTimer = null;
  function reportRects() {
    const out = [];
    document.querySelectorAll(SEL).forEach((el) => {
      if (el.classList.contains('hidden')) return;
      const cs = getComputedStyle(el);
      if (cs.display === 'none' || cs.visibility === 'hidden' || cs.pointerEvents === 'none') return;
      const r = el.getBoundingClientRect();
      if (r.width < 1 || r.height < 1) return;
      out.push([Math.round(r.left), Math.round(r.top), Math.round(r.width), Math.round(r.height)]);
    });
    const key = JSON.stringify(out);
    if (key !== lastRects) { lastRects = key; send({ op: 'rects', r: out }); }
  }
  function scheduleRects() { if (!rectTimer) rectTimer = setTimeout(() => { rectTimer = null; reportRects(); }, 60); }
  new MutationObserver(scheduleRects).observe(document.documentElement, { subtree: true, childList: true, attributes: true, attributeFilter: ['class', 'style', 'hidden'] });
  window.addEventListener('resize', scheduleRects);
  setInterval(reportRects, 500);

  // ---------- overlays ----------
  class Marker {
    constructor(ll, o) {
      o = o || {}; const icon = o.icon || {}; const size = icon.iconSize || [12, 12];
      this.ll = ll; this.id = 'm' + (++seq);
      this.el = document.createElement('div'); this.el.className = 'amarker';
      this.el.innerHTML = icon.html || ''; this.el.style.width = size[0] + 'px'; this.el.style.height = size[1] + 'px';
      this.el.style.pointerEvents = 'none';
      if (o.zIndexOffset) this.el.style.zIndex = String(o.zIndexOffset < 0 ? 1 : 3);
      this.el.style.display = 'none'; this.w = size[0]; this.h = size[1];
    }
    addTo() {
      document.body.appendChild(this.el);
      items.set(this.id, { el: this.el, place: (x, y) => {
        const off = x < -60 || y < -60 || x > innerWidth + 60 || y > innerHeight + 60;
        this.el.style.display = off ? 'none' : '';
        if (!off) this.el.style.transform = `translate3d(${(x - this.w / 2).toFixed(1)}px,${(y - this.h / 2).toFixed(1)}px,0)`;
      } });
      send({ op: 'track', id: this.id, lat: this.ll[0], lng: this.ll[1] });
      return this;
    }
    setLatLng(ll) { this.ll = ll; send({ op: 'track', id: this.id, lat: ll[0], lng: ll[1] }); return this; }
    remove() { items.delete(this.id); send({ op: 'untrack', id: this.id }); this.el.remove(); return this; }
  }

  class Popup {
    setLatLng(ll) { this.ll = ll; return this; }
    setContent(el) { this.content = el; return this; }
    openOn(map) {
      map.closePopup();
      const wrap = document.createElement('div'); wrap.className = 'apopup'; wrap.style.display = 'none';
      const box = document.createElement('div'); box.className = 'apopup-c'; box.appendChild(this.content);
      const tip = document.createElement('div'); tip.className = 'apopup-tip';
      wrap.append(box, tip); document.body.appendChild(wrap);
      this.id = 'p' + (++seq); this.wrap = wrap;
      items.set(this.id, { el: wrap, place: (x, y) => {
        const off = x < -200 || y < -50 || x > innerWidth + 200 || y > innerHeight + 300;
        wrap.style.display = off ? 'none' : '';
        if (!off) wrap.style.transform = `translate3d(${x.toFixed(1)}px,${y.toFixed(1)}px,0) translate(-50%,-100%) translateY(-12px)`;
      } });
      send({ op: 'track', id: this.id, lat: this.ll[0], lng: this.ll[1] });
      map._popup = this; scheduleRects(); return this;
    }
    close() { items.delete(this.id); send({ op: 'untrack', id: this.id }); if (this.wrap) this.wrap.remove(); scheduleRects(); }
  }

  class Poly {
    constructor(pts, o) { this.pts = pts; this.o = o || {}; this.id = 'l' + (++seq); this.on = false; }
    _push() {
      const o = this.o, dash = o.dashArray ? String(o.dashArray).split(/[ ,]+/).map(Number).filter((n) => n > 0) : null;
      send({ op: 'poly', id: this.id, pts: this.pts, color: o.color || '#4aa3ff', w: o.weight || 3, a: o.opacity == null ? 1 : o.opacity, dash });
    }
    addTo() { this.on = true; this._push(); return this; }
    setStyle(o) { Object.assign(this.o, o); if (this.on) this._push(); return this; }
    setLatLngs(pts) { this.pts = pts; if (this.on) this._push(); return this; }
    remove() { if (this.on) send({ op: 'polyRm', id: this.id }); this.on = false; return this; }
  }

  // ---------- the map ----------
  class AppleMap {
    constructor(id, o) {
      state.lat = o.center[0]; state.lng = o.center[1]; state.z = o.zoom;
      document.documentElement.classList.add('apple');
      send({ op: 'init', lat: o.center[0], lng: o.center[1], zoom: o.zoom });
      failTimer = setTimeout(() => { if (!state.ready) giveUp(); }, 3500);
      this._popup = null;
    }
    setBase(kind) { send({ op: 'style', kind: kind || 'standard' }); return Promise.resolve(); }
    onView(fn) { viewCbs.push(fn); }
    toggleTilt() { send({ op: 'tilt' }); return state.pt < 5; }
    resetNorth() { send({ op: 'north' }); }
    flyTo(ll, z) { send({ op: 'cam', lat: ll[0], lng: ll[1], zoom: z == null ? state.z : z, anim: true }); }
    panTo(ll) { send({ op: 'cam', lat: ll[0], lng: ll[1], zoom: state.z, anim: true }); }
    getZoom() { return state.z; }
    getCenter() { return { lat: state.lat, lng: state.lng }; }
    zoomIn() { send({ op: 'zoomBy', d: 1 }); } zoomOut() { send({ op: 'zoomBy', d: -1 }); }
    closePopup() { if (this._popup) { this._popup.close(); this._popup = null; } }
    on(ev, fn) {
      if (ev === 'click') clickCbs.push((e) => { this.closePopup(); fn(e); });
      return this;
    }
  }

  window.AppleMap = AppleMap;
  window.LGA = {
    divIcon: (o) => o,
    marker: (ll, o) => new Marker(ll, o),
    polyline: (pts, o) => new Poly(pts, o),
    popup: () => new Popup()
  };
})();
