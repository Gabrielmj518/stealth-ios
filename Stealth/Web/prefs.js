// Defaults + settings schema (rendered automatically by app.js)
const DEFAULTS = {
  speed: 5, speedVar: 0, jitter: 0, keepFresh: false, routeProfile: 'auto', loop: 'off', pause: 0, tickMs: 1000,
  instant: false, autoCenter: true, fly: true, zoomTo: 14, autoStopMin: 0, restoreOnExit: true, confirmStop: false, effect: 'ripple',
  mapStyle: 'dark', showCoords: true, showScale: true, trail: true, trailClear: true, markerStyle: 'pulse', markerColor: '#ffffff',
  accent: '#5aa9ff', scale: 100, compact: false, reduceMotion: false, blur: true, units: 'metric', coordFmt: 'dec', timeFmt: 'clock',
  showBattery: true, showPlace: true, showLocalTime: true, pollSec: 12, sound: false, haptics: true, shortcuts: true, alwaysOnTop: false
};
const ACCENTS = ['#5aa9ff', '#8b7bff', '#3ddc97', '#ffb84a', '#ff6fa8', '#ff5d6c', '#2dd4e6', '#e5e7eb'];
const MARKER_COLORS = ['#ffffff', '#5aa9ff', '#3ddc97', '#ffb84a', '#ff6fa8', '#ff5d6c'];

const SETTINGS = [
  { id: 'move', title: 'Movement', icon: '➜', items: [
    { k: 'speed', t: 'range', label: 'Route speed', min: 1, max: 200, step: 1, fmt: (v, P) => fmtSpeed(v, P) },
    { k: 'speed', t: 'chips', label: 'Presets', chips: [['Walk', 5], ['Run', 10], ['Bike', 18], ['Car', 50], ['Train', 120]] },
    { k: 'speedVar', t: 'range', label: 'Speed variation', desc: 'Random ± change of speed on every step', min: 0, max: 50, step: 1, fmt: (v) => v ? `±${v}%` : 'Off' },
    { k: 'jitter', t: 'range', label: 'GPS jitter', desc: 'Tiny random offset on each update, like a real GPS', min: 0, max: 30, step: 1, fmt: (v, P) => v ? fmtDist(v, P) : 'Off' },
    { k: 'keepFresh', t: 'toggle', label: 'Keep position alive', desc: 'Re-send the location every 10 s while idle (small drift)' },
    { k: 'routeProfile', t: 'select', label: 'Route type', opts: [['auto', 'Automatic (by speed)'], ['foot', 'Walking paths'], ['driving', 'Roads'], ['straight', 'Straight lines']] },
    { k: 'loop', t: 'select', label: 'When route ends', opts: [['off', 'Stop at the end'], ['loop', 'Restart from the beginning'], ['pingpong', 'Go back and forth']] },
    { k: 'pause', t: 'range', label: 'Pause at waypoints', min: 0, max: 60, step: 1, fmt: (v) => v ? `${v} s` : 'Off' },
    { k: 'tickMs', t: 'select', label: 'Update interval', num: true, opts: [[500, '0.5 s (smoothest)'], [1000, '1 s'], [2000, '2 s'], [5000, '5 s']] }
  ]},
  { id: 'tp', title: 'Teleport & session', icon: '⚡', items: [
    { k: 'instant', t: 'toggle', label: 'One-click teleport', desc: 'Teleport as soon as you click the map (no popup)' },
    { k: 'autoCenter', t: 'toggle', label: 'Follow the marker', desc: 'Center the map on every new position' },
    { k: 'fly', t: 'toggle', label: 'Fly animation', desc: 'Smooth camera movement when jumping' },
    { k: 'zoomTo', t: 'range', label: 'Zoom after teleport', min: 3, max: 18, step: 1, fmt: (v) => `Level ${v}` },
    { k: 'autoStopMin', t: 'range', label: 'Auto-stop timer', desc: 'Restore your real location automatically', min: 0, max: 240, step: 5, fmt: (v) => v ? `${v} min` : 'Off' },
    { k: 'confirmStop', t: 'toggle', label: 'Confirm before stopping' },
    { k: 'restoreOnExit', t: 'toggle', label: 'Restore location on exit', desc: 'Closing Stealth gives your real location back', pc: true },
    { k: 'effect', t: 'select', label: 'Teleport effect', opts: [['ripple', 'Ripple'], ['flash', 'Flash'], ['none', 'None']] }
  ]},
  { id: 'map', title: 'Map', icon: '◍', items: [
    { k: 'mapStyle', t: 'select', label: 'Map style', opts: [['dark', 'Dark'], ['darknl', 'Dark (no labels)'], ['sat', 'Satellite'], ['streets', 'Streets'], ['streetsdark', 'Streets (night)']] },
    { k: 'showCoords', t: 'toggle', label: 'Cursor coordinates', desc: 'Live readout at the bottom-left' },
    { k: 'showScale', t: 'toggle', label: 'Scale bar' },
    { k: 'trail', t: 'toggle', label: 'Draw trail', desc: 'Line showing where you have been' },
    { k: 'trailClear', t: 'toggle', label: 'Clear trail on stop' },
    { k: 'markerStyle', t: 'select', label: 'Marker style', opts: [['pulse', 'Pulsing dot'], ['dot', 'Dot'], ['pin', 'Pin'], ['arrow', 'Arrow']] },
    { k: 'markerColor', t: 'swatch', label: 'Marker color', colors: MARKER_COLORS },
    { t: 'button', label: 'Clear trail now', act: 'clearTrail', btn: 'Clear' }
  ]},
  { id: 'look', title: 'Appearance', icon: '✦', items: [
    { k: 'accent', t: 'swatch', label: 'Accent color', colors: ACCENTS },
    { k: 'scale', t: 'range', label: 'Interface size', min: 80, max: 130, step: 5, fmt: (v) => `${v}%` },
    { k: 'compact', t: 'toggle', label: 'Compact layout' },
    { k: 'blur', t: 'toggle', label: 'Glass blur', desc: 'Turn off if the app feels slow' },
    { k: 'reduceMotion', t: 'toggle', label: 'Reduce animations' },
    { k: 'units', t: 'select', label: 'Units', opts: [['metric', 'Metric (km, km/h)'], ['imperial', 'Imperial (mi, mph)']] },
    { k: 'coordFmt', t: 'select', label: 'Coordinate format', opts: [['dec', '40.71280, -74.00600'], ['dms', `40°42'46"N 74°0'22"W`]] },
    { k: 'timeFmt', t: 'select', label: 'Timer format', opts: [['clock', '01:02:03'], ['words', '1h 02m 03s']] }
  ]},
  { id: 'dev', title: 'Device & info', icon: '▯', items: [
    { k: 'showBattery', t: 'toggle', label: 'Show battery' },
    { k: 'showPlace', t: 'toggle', label: 'Show place name', desc: 'Looks up the address of the spoofed spot' },
    { k: 'showLocalTime', t: 'toggle', label: 'Show local time', desc: 'Approximate time at the spoofed place' },
    { k: 'pollSec', t: 'select', label: 'Device check interval', num: true, opts: [[5, 'Every 5 s'], [12, 'Every 12 s'], [30, 'Every 30 s'], [60, 'Every minute']] },
    { k: 'alwaysOnTop', t: 'toggle', label: 'Always on top', pc: true }
  ]},
  { id: 'fx', title: 'Sound & feel', icon: '♪', items: [
    { k: 'sound', t: 'toggle', label: 'Sound effects', desc: 'Soft beeps on teleport and stop' },
    { k: 'haptics', t: 'toggle', label: 'Vibration', desc: 'On phones that support it' },
    { k: 'shortcuts', t: 'toggle', label: 'Keyboard shortcuts', desc: 'Ctrl+K search · Ctrl+. stop · L locate · T teleport · R route · Esc close' }
  ]},
  { id: 'data', title: 'Data', icon: '▤', items: [
    { t: 'button', label: 'Export places & settings', act: 'export', btn: 'Export' },
    { t: 'button', label: 'Import from file', act: 'import', btn: 'Import' },
    { t: 'button', label: 'Clear recent history', act: 'clearHist', btn: 'Clear' },
    { t: 'button', label: 'Delete all saved places', act: 'clearSaved', btn: 'Delete', danger: true },
    { t: 'button', label: 'Reset all settings', act: 'resetPrefs', btn: 'Reset', danger: true }
  ]}
];

function fmtSpeed(kmh, P) { return (P && P.units === 'imperial') ? `${Math.round(kmh * 0.621371)} mph` : `${kmh} km/h`; }
function fmtDist(m, P) {
  if (P && P.units === 'imperial') { const ft = m * 3.28084; return ft < 1000 ? `${Math.round(ft)} ft` : `${(m / 1609.344).toFixed(1)} mi`; }
  return m < 1000 ? `${Math.round(m)} m` : `${(m / 1000).toFixed(1)} km`;
}
