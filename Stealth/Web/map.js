// Vector map engine (MapLibre GL) behind a small Leaflet-like API, so the rest of the app
// does not care which engine is used. If WebGL is not available, app.js falls back to Leaflet.
(function () {
  window.GL_OK = false;
  try {
    if (!window.maplibregl) return;
    const c = document.createElement('canvas');
    if (!(c.getContext('webgl2') || c.getContext('webgl'))) return;
  } catch { return; }
  window.GL_OK = true;

  const ZOFF = 1;                                   // Leaflet zoom -> MapLibre zoom (512 px tiles)
  const lnglat = (ll) => [ll[1], ll[0]];
  const CARTO = 'https://basemaps.cartocdn.com/gl/';
  const ESRI = 'https://server.arcgisonline.com/ArcGIS/rest/services/';
  const STYLES = {
    standard: CARTO + 'voyager-gl-style/style.json',
    light: CARTO + 'positron-gl-style/style.json',
    dark: CARTO + 'dark-matter-gl-style/style.json',
    darknl: CARTO + 'dark-matter-nolabels-gl-style/style.json'
  };
  const raster = (id, tiles, extra) => ({ type: 'raster', tiles, tileSize: 256, maxzoom: 19, ...extra });
  const SAT_STYLE = {
    version: 8,
    sources: {
      sat: raster('sat', [ESRI + 'World_Imagery/MapServer/tile/{z}/{y}/{x}'], { attribution: 'Tiles © Esri' }),
      ref: raster('ref', [ESRI + 'Reference/World_Boundaries_and_Places/MapServer/tile/{z}/{y}/{x}'])
    },
    layers: [{ id: 'sat', type: 'raster', source: 'sat' }, { id: 'ref', type: 'raster', source: 'ref' }]
  };
  const OSM_STYLE = {
    version: 8,
    sources: { osm: raster('osm', ['https://tile.openstreetmap.org/{z}/{x}/{y}.png'], { attribution: '© OpenStreetMap contributors' }) },
    layers: [{ id: 'osm', type: 'raster', source: 'osm' }]
  };
  const BLANK = { version: 8, sources: {}, layers: [{ id: 'bg', type: 'background', paint: { 'background-color': '#171717' } }] };

  // Adds extruded (3D) buildings under the labels when the style has building data.
  function addBuildings(style, kind) {
    const src = Object.entries(style.sources || {}).find(([, s]) => s.type === 'vector');
    if (!src || !style.layers.some((l) => l['source-layer'] === 'building')) return;
    const dark = kind === 'dark' || kind === 'darknl';
    const layer = {
      id: 'bld3d', type: 'fill-extrusion', source: src[0], 'source-layer': 'building', minzoom: 14.5,
      paint: {
        'fill-extrusion-color': dark ? '#2d3139' : '#e7e3da',
        'fill-extrusion-height': ['coalesce', ['get', 'render_height'], ['get', 'height'], 8],
        'fill-extrusion-base': ['coalesce', ['get', 'render_min_height'], ['get', 'min_height'], 0],
        'fill-extrusion-opacity': 0.92,
        'fill-extrusion-vertical-gradient': true
      }
    };
    const at = style.layers.findIndex((l) => l.type === 'symbol');
    style.layers.splice(at < 0 ? style.layers.length : at, 0, layer);
  }

  async function fetchJson(url, ms) {
    const ctl = new AbortController(); const t = setTimeout(() => ctl.abort(), ms);
    try { const r = await fetch(url, { signal: ctl.signal }); if (!r.ok) throw new Error(r.status); return await r.json(); }
    finally { clearTimeout(t); }
  }

  // ---------- overlays ----------
  let seq = 0;
  class Poly {
    constructor(pts, o) { this.pts = pts; this.o = o || {}; this.id = 'poly' + (++seq); this.map = null; }
    _data() { return { type: 'Feature', geometry: { type: 'LineString', coordinates: this.pts.map(lnglat) } }; }
    _mount() {
      const gl = this.map && this.map.gl; if (!gl) return;
      try {
        if (gl.getSource(this.id)) return;
        const w = this.o.weight || 3;
        const paint = { 'line-color': this.o.color || '#4aa3ff', 'line-width': w, 'line-opacity': this.o.opacity == null ? 1 : this.o.opacity };
        if (this.o.dashArray) paint['line-dasharray'] = String(this.o.dashArray).split(/[ ,]+/).map((n) => (+n || 4) / w);
        gl.addSource(this.id, { type: 'geojson', data: this._data() });
        gl.addLayer({ id: this.id, type: 'line', source: this.id, layout: { 'line-cap': 'round', 'line-join': 'round' }, paint });
      } catch { /* style not ready yet: mounted again on style.load */ }
    }
    addTo(map) { this.map = map; map._polys.add(this); this._mount(); return this; }
    setStyle(o) { Object.assign(this.o, o); try { if (o.color) this.map.gl.setPaintProperty(this.id, 'line-color', o.color); } catch {} return this; }
    setLatLngs(pts) { this.pts = pts; try { const s = this.map.gl.getSource(this.id); if (s) s.setData(this._data()); } catch {} return this; }
    remove() {
      if (!this.map) return this;
      try { if (this.map.gl.getLayer(this.id)) this.map.gl.removeLayer(this.id); if (this.map.gl.getSource(this.id)) this.map.gl.removeSource(this.id); } catch {}
      this.map._polys.delete(this); this.map = null; return this;
    }
  }

  class Marker {
    constructor(ll, o) {
      o = o || {}; const icon = o.icon || {}; const size = icon.iconSize || [12, 12];
      this.ll = ll; this.el = document.createElement('div');
      this.el.innerHTML = icon.html || ''; this.el.style.width = size[0] + 'px'; this.el.style.height = size[1] + 'px';
      if (o.interactive === false) this.el.style.pointerEvents = 'none';
      if (o.zIndexOffset) this.el.style.zIndex = String(o.zIndexOffset < 0 ? 0 : 5);
      this.mk = new maplibregl.Marker({ element: this.el, anchor: 'center' });
    }
    addTo(map) { this.mk.setLngLat(lnglat(this.ll)).addTo(map.gl); return this; }
    setLatLng(ll) { this.ll = ll; this.mk.setLngLat(lnglat(ll)); return this; }
    remove() { this.mk.remove(); return this; }
  }

  class Popup {
    constructor() { this.p = new maplibregl.Popup({ closeButton: false, closeOnClick: false, anchor: 'bottom', offset: 12, maxWidth: '330px' }); }
    setLatLng(ll) { this.ll = ll; return this; }
    setContent(el) { this.el = el; return this; }
    openOn(map) {
      map.closePopup();
      ['click', 'dblclick', 'mousedown', 'touchstart', 'touchend', 'pointerdown'].forEach((ev) => this.el.addEventListener(ev, (e) => e.stopPropagation()));
      this.p.setLngLat(lnglat(this.ll)).setDOMContent(this.el).addTo(map.gl);
      map._popup = this.p; return this;
    }
  }

  // ---------- the map ----------
  class GLMap {
    constructor(id, o) {
      this._polys = new Set(); this._popup = null; this._tok = 0; this._viewCbs = [];
      this.gl = new maplibregl.Map({
        container: id, style: BLANK, center: lnglat(o.center), zoom: o.zoom - ZOFF, minZoom: (o.minZoom || 2) - ZOFF, maxPitch: 70,
        attributionControl: false, fadeDuration: 150, pitchWithRotate: true, dragRotate: true
      });
      this.gl.addControl(new maplibregl.AttributionControl({ compact: true }), 'bottom-right');
      this.gl.on('style.load', () => this._polys.forEach((p) => p._mount()));
      const fire = () => this._viewCbs.forEach((f) => f(this.gl.getBearing(), this.gl.getPitch()));
      this.gl.on('rotate', fire); this.gl.on('pitch', fire); this.gl.on('moveend', fire);
    }
    async setBase(kind) {
      const tok = ++this._tok; let style;
      if (kind === 'sat') style = SAT_STYLE;
      else {
        try { style = await fetchJson(STYLES[kind] || STYLES.standard, 9000); addBuildings(style, kind); }
        catch { style = OSM_STYLE; }
      }
      if (tok !== this._tok) return;
      this.gl.setStyle(style, { diff: false });
    }
    onView(fn) { this._viewCbs.push(fn); }
    toggleTilt() { const on = this.gl.getPitch() < 5; this.gl.easeTo({ pitch: on ? 60 : 0, duration: 600 }); return on; }
    resetNorth() { this.gl.easeTo({ bearing: 0, pitch: 0, duration: 500 }); }
    flyTo(ll, z) { this.gl.flyTo({ center: lnglat(ll), zoom: (z == null ? this.getZoom() : z) - ZOFF, essential: true }); }
    panTo(ll) { this.gl.easeTo({ center: lnglat(ll), duration: 600 }); }
    getZoom() { return this.gl.getZoom() + ZOFF; }
    getCenter() { const c = this.gl.getCenter(); return { lat: c.lat, lng: c.lng }; }
    zoomIn() { this.gl.zoomIn(); } zoomOut() { this.gl.zoomOut(); }
    closePopup() { if (this._popup) { this._popup.remove(); this._popup = null; } }
    on(ev, fn) {
      if (ev === 'click') this.gl.on('click', (e) => { this.closePopup(); fn({ latlng: { lat: e.lngLat.lat, lng: e.lngLat.lng } }); });
      else if (ev === 'mousemove') this.gl.on('mousemove', (e) => fn({ latlng: { lat: e.lngLat.lat, lng: e.lngLat.lng } }));
      return this;
    }
  }

  window.GLMap = GLMap;
  window.LGL = {
    divIcon: (o) => o,
    marker: (ll, o) => new Marker(ll, o),
    polyline: (pts, o) => new Poly(pts, o),
    popup: () => new Popup()
  };
})();
