// iOS app (WKWebView): talk to the native engine through the message handler.
if (!window.stealth && window.webkit && window.webkit.messageHandlers && window.webkit.messageHandlers.stealth) {
  const pending = new Map(); let seq = 0;
  window.__stealthReply = (id, data) => { const f = pending.get(id); if (f) { pending.delete(id); f(data); } };
  const call = (cmd, args) => new Promise((resolve) => {
    const id = ++seq; pending.set(id, resolve);
    try { window.webkit.messageHandlers.stealth.postMessage(Object.assign({ id, cmd }, args || {})); } catch (e) { pending.delete(id); resolve({ ok: false, error: String(e) }); }
    setTimeout(() => { if (pending.has(id)) { pending.delete(id); resolve({ ok: false, error: 'The iPhone did not answer in time' }); } }, 120000);
  });
  window.stealth = {
    native: true,
    requirements: () => call('requirements'),
    setLocation: (lat, lon) => call('set', { lat, lon }),
    clearLocation: () => call('clear'),
    importPairing: () => call('importPairing'),
    pastePairing: () => call('pastePairing'),
    openVPN: () => call('openVPN'),
    realLocation: async () => { const r = await call('realLocation'); return r && r.ok ? [r.lat, r.lon] : null; },
    share: (name, text) => call('share', { name, text }),
    appConfig: (c) => call('appConfig', c || {}),
    openExternal: (url) => call('openExternal', { url }),
    installDeps: async () => ({ ok: false, error: 'Not needed on iPhone' }), startLink: async () => ({ ok: false }),
    restartAdmin() {}, win() {}
  };
  document.documentElement.classList.add('remote', 'native');
}
// When opened in a browser (iPhone) instead of the Electron app, talk to the PC over the LAN.
if (!window.stealth) {
  const KEY = 'stealth-pin';
  const ls = { get: () => { try { return localStorage.getItem(KEY); } catch { return null; } }, set: (v) => { try { localStorage.setItem(KEY, v); } catch {} }, del: () => { try { localStorage.removeItem(KEY); } catch {} } };
  const call = async (name, body) => {
    let pin = ls.get();
    for (let tries = 0; tries < 4; tries++) {
      if (!pin) { pin = prompt('Enter the 6-digit PIN shown in Stealth on your PC'); if (!pin) return { ok: false, error: 'PIN required' }; }
      let r;
      try { r = await fetch('/api/' + name, { method: 'POST', headers: { 'content-type': 'application/json', 'x-pin': pin.trim() }, body: JSON.stringify(body || {}) }); }
      catch { return { ok: false, error: 'Cannot reach Stealth on your PC (same Wi-Fi?)' }; }
      if (r.status === 401) { ls.del(); pin = null; continue; }
      if (r.status === 429) return { ok: false, error: 'Too many wrong PINs, wait a minute' };
      ls.set(pin.trim()); return r.json();
    }
    return { ok: false, error: 'Wrong PIN' };
  };
  window.stealth = {
    requirements: async () => { const r = await call('requirements'); return r && r.usb !== undefined ? r : { admin: true, driver: true, pmd3: true, usb: false, internet: true, link: false, device: null }; },
    setLocation: (lat, lon) => call('set-location', { lat, lon }),
    clearLocation: () => call('clear-location'),
    installDeps: async () => ({ ok: false, error: 'Use the PC app' }), startLink: async () => ({ ok: false, error: 'Use the PC app' }),
    restartAdmin() {}, setPrefs() {}, openExternal: (u) => window.open(u, '_blank'), win() {}
  };
  document.documentElement.classList.add('remote');
}
