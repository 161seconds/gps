import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createContext, runInContext } from 'node:vm';
import { HubConnectionBuilder, HttpTransportType, LogLevel } from '@microsoft/signalr';

const origin = process.env.GPS_URL || 'http://localhost:5085';
const connections = [];
const request = (path, body) => fetch(`${origin}${path}`, {
  ...(body === undefined ? {} : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }),
  signal: AbortSignal.timeout(5000)
});
async function viewer() {
  const connection = new HubConnectionBuilder().withUrl(`${origin}/hubs/tracking`, {
    transport: HttpTransportType.WebSockets, skipNegotiation: true
  }).configureLogging(LogLevel.None).build();
  connections.push(connection);
  await connection.start();
  return connection;
}
function receive(connection, event) {
  return new Promise((resolve, reject) => {
    const listener = value => { clearTimeout(timer); connection.off(event, listener); resolve(value); };
    const timer = setTimeout(() => { connection.off(event, listener); reject(new Error(`${event} timed out`)); }, 3000);
    connection.on(event, listener);
  });
}
async function publish(path, body, event) {
  const events = connections.map(connection => receive(connection, event));
  const response = await request(path, body);
  assert.equal(response.status, 200, `publish ${path}`);
  const result = await response.json();
  for (const received of await Promise.all(events)) assert.deepEqual(received, result, event);
  return result;
}

const app = readFileSync(new URL('../wwwroot/app.js', import.meta.url), 'utf8');
function frontend(saved = null, systemDark = true) {
  const elements = new Map(), storage = new Map(saved ? [['gps-theme', saved]] : []);
  const document = { documentElement: { dataset: {} }, getElementById(id) {
    if (!elements.has(id)) elements.set(id, { setAttribute(name, value) { this[name] = value; }, classList: { toggle() {} } });
    return elements.get(id);
  } };
  const layer = (points = []) => ({ points, addTo() { return this; }, bindTooltip() { return this; },
    setLatLng(value) { this.points = value; return this; }, setRadius() { return this; },
    setLatLngs(value) { this.points = value; return this; }, getLatLngs() { return this.points; } });
  const map = { setView() { return this; }, removeLayer(value) { value.removed = true; } };
  const hub = { on() {}, invoke: async () => ({ start: null, end: null, location: null, routeSequence: 0 }) };
  const context = createContext({ document, history: { replaceState() {} }, location: { pathname: '/' },
    window: { matchMedia: () => ({ matches: systemDark }) },
    localStorage: { getItem: key => storage.get(key), setItem: (key, value) => storage.set(key, value) },
    L: { map: () => map, tileLayer: layer, polyline: layer, circleMarker: layer, circle: layer, marker: layer, divIcon: value => value, latLng: (lat, lng) => ({ lat, lng }) },
    signalR: { HubConnectionBuilder: class { withUrl() { return this; } withAutomaticReconnect() { return this; } build() { return hub; } } } });
  runInContext(app.slice(0, app.indexOf('async function connected()')), context);
  return { context, document, storage, hub, theme: document.getElementById('theme') };
}
async function checkFrontend() {
  const ui = frontend();
  assert.equal(ui.document.documentElement.dataset.theme, 'dark', 'system theme');
  assert.equal(ui.theme['aria-pressed'], 'true');
  ui.theme.onclick();
  assert.equal(ui.document.documentElement.dataset.theme, 'light');
  assert.equal(ui.theme['aria-pressed'], 'false');
  assert.equal(ui.storage.get('gps-theme'), 'light');
  assert.equal(frontend(ui.storage.get('gps-theme')).document.documentElement.dataset.theme, 'light', 'restored theme');
  assert.equal(frontend(null, false).document.documentElement.dataset.theme, 'light', 'system light theme');
  const point = { latitude: 10, longitude: 106, accuracy: 5, capturedAt: new Date().toISOString(), receivedAt: new Date().toISOString(), sequence: 1 };
  ui.context.point = point;
  runInContext('applyLocation(point)', ui.context);
  const replacement = { ...point, latitude: 11 };
  ui.hub.invoke = async () => ({ start: null, end: null, location: replacement, routeSequence: 0 });
  await runInContext('sync()', ui.context);
  assert.equal(runInContext('marker.points[0]', ui.context), 11, 'equal sequence snapshot replaces old point');
  assert.equal(runInContext('trail.getLatLngs().length', ui.context), 1, 'snapshot resets trail');
  ui.hub.invoke = async () => ({ start: null, end: null, location: null, routeSequence: 0 });
  await runInContext('sync()', ui.context);
  assert.equal(runInContext('latest === undefined && marker === undefined && circle === undefined && trail.getLatLngs().length === 0', ui.context), true, 'empty snapshot clears GPS');
  const newer = { ...point, latitude: 12, sequence: 2 };
  ui.context.newer = newer;
  ui.hub.invoke = async () => { runInContext("receive('location', newer)", ui.context); return { start: null, end: null, location: point, routeSequence: 0 }; };
  await runInContext('sync()', ui.context);
  assert.equal(runInContext('latest.sequence', ui.context), 2, 'buffered newer GPS survives snapshot');
  assert.equal(runInContext('marker.points[0]', ui.context), 12);
}

try {
  await checkFrontend();
  for (const path of ['/api/health', '/', '/app.js', '/style.css', '/vendor/leaflet.js', '/vendor/signalr.min.js'])
    assert.equal((await request(path)).status, 200, path);
  const a = await viewer(), b = await viewer();
  const initial = await (await request('/api/state')).json();
  for (const connection of connections) assert.deepEqual(await connection.invoke('GetState'), initial);
  const route = { start: { latitude: 10.7769, longitude: 106.7009 }, end: { latitude: 10.779, longitude: 106.705 } };
  for (const invalid of [{}, { start: route.start }, { ...route, start: {} },
    { ...route, start: { latitude: 91, longitude: 0 } }, { ...route, end: { latitude: 0, longitude: -181 } },
    { ...route, end: { latitude: null, longitude: 0 } }])
    assert.equal((await request('/api/route', invalid)).status, 400, 'invalid route');
  const savedRoute = await publish('/api/route', route, 'RouteUpdated');
  assert.deepEqual(savedRoute, { ...route, sequence: initial.routeSequence + 1 });
  const captured = Math.max(Date.now(), initial.location ? Date.parse(initial.location.capturedAt) + 1 : 0);
  const point = { latitude: 10.777, longitude: 106.702, accuracy: 8, capturedAt: new Date(captured).toISOString() };
  for (const invalid of [{ latitude: 91 }, { longitude: -181 }, { latitude: null }, { accuracy: -1 },
    { accuracy: null }, { capturedAt: 'invalid' }, { capturedAt: new Date(Date.now() - 660000).toISOString() },
    { capturedAt: new Date(Date.now() + 60000).toISOString() }])
    assert.equal((await request('/api/location', { ...point, ...invalid })).status, 400, 'invalid GPS');
  for (const field of Object.keys(point)) {
    const missing = { ...point };
    delete missing[field];
    assert.equal((await request('/api/location', missing)).status, 400, `required ${field}`);
  }
  const first = await publish('/api/location', point, 'LocationUpdated');
  assert.deepEqual([first.latitude, first.longitude, first.accuracy], [point.latitude, point.longitude, point.accuracy]);
  assert.equal(Date.parse(first.capturedAt), Date.parse(point.capturedAt));
  assert.ok(Number.isFinite(Date.parse(first.receivedAt)));
  assert.equal(first.sequence, (initial.location?.sequence || 0) + 1);
  assert.equal((await request('/api/location', point)).status, 409, 'duplicate GPS');
  assert.equal((await request('/api/location', { ...point, capturedAt: new Date(captured - 1).toISOString() })).status, 409, 'older GPS');
  const changedRoute = await publish('/api/route', { ...route, end: route.start }, 'RouteUpdated');
  assert.equal(changedRoute.sequence, savedRoute.sequence + 1);
  assert.deepEqual((await (await request('/api/state')).json()).location, first, 'route preserves GPS');
  const next = await publish('/api/location', { ...point, latitude: 10.778, capturedAt: new Date(captured + 1).toISOString() }, 'LocationUpdated');
  assert.equal(next.sequence, first.sequence + 1);
  const expected = { start: changedRoute.start, end: changedRoute.end, location: next, routeSequence: changedRoute.sequence };
  assert.deepEqual(await (await request('/api/state')).json(), expected);
  for (const connection of [a, b]) assert.deepEqual(await connection.invoke('GetState'), expected);
  await a.stop();
  await a.start();
  assert.deepEqual(await a.invoke('GetState'), expected, 'reconnect snapshot');
  console.log('PASS: theme persistence, frontend reconnect/reset, assets, route/GPS validation, two viewers, ordering, snapshots.');
} finally {
  await Promise.all(connections.map(connection => connection.stop()));
}
