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
const iconMarkup = '<svg><use href="/icons.svg#sun"></use></svg>';
function frontend(saved = null, systemDark = true) {
  const elements = new Map(), storage = new Map(saved ? [['gps-theme', saved]] : []);
  const document = {
    documentElement: { dataset: {} }, getElementById(id) {
      if (!elements.has(id)) elements.set(id, {
        value: '', checked: id === 'follow-gps', innerHTML: iconMarkup,
        set textContent(value) { this.text = value; this.innerHTML = ''; }, get textContent() { return this.text || ''; },
        button: { innerHTML: iconMarkup, set textContent(value) { this.text = value; this.innerHTML = ''; }, setAttribute(name, value) { this[name] = value; } },
        querySelector() { return this.button; }, addEventListener() { }, setAttribute(name, value) { this[name] = value; }, classList: { toggle() { } }
      });
      return elements.get(id);
    }
  };
  const layer = (points = []) => ({
    points, addTo() { return this; }, bindTooltip() { return this; },
    on(event, handler) { this[event] = handler; return this; }, setStyle(style) { this.style = style; return this; }, bringToFront() { this.front = true; return this; },
    setLatLng(value) { this.points = value; return this; }, setRadius() { return this; },
    setLatLngs(value) { this.points = value; return this; }, getLatLngs() { return this.points; }
  });
  const map = { on(event, handler) { this[event] = handler; return this; }, setView(points) { this.center = points; return this; }, panTo(points) { this.center = points; return this; }, fitBounds(points) { this.bounds = points; return this; }, removeLayer(value) { value.removed = true; } };
  const hub = { state: 'Disconnected', start: () => new Promise(() => { }), on() { }, onreconnecting() { }, onreconnected() { }, onclose() { }, invoke: async () => ({ start: null, end: null, location: null, routeSequence: 0 }) };
  const context = createContext({
    document, history: { replaceState() { } }, location: { pathname: '/' },
    window: { matchMedia: () => ({ matches: systemDark }), addEventListener() { } }, setInterval() { }, setTimeout: (callback, delay) => setTimeout(callback, delay === 1100 ? 0 : delay), clearTimeout, AbortController, URL,
    localStorage: { getItem: key => storage.get(key), setItem: (key, value) => storage.set(key, value) },
    L: { map: () => map, tileLayer: layer, polyline: layer, circleMarker: layer, circle: layer, marker: layer, divIcon: value => value, latLng: (lat, lng) => ({ lat, lng }) },
    signalR: { HubConnectionState: { Disconnected: 'Disconnected' }, HubConnectionBuilder: class { withUrl() { return this; } withAutomaticReconnect() { return this; } build() { return hub; } } }
  });
  runInContext(app, context);
  return { context, document, storage, hub, map, theme: document.getElementById('theme') };
}
async function checkFrontend() {
  const ui = frontend();
  assert.equal(ui.document.documentElement.dataset.theme, 'dark', 'system theme');
  assert.equal(ui.theme['aria-pressed'], 'true');
  assert.equal(ui.theme.innerHTML, iconMarkup, 'initial theme keeps icon');
  assert.equal(ui.theme.title, 'Chế độ sáng');
  assert.equal(ui.theme['aria-label'], ui.theme.title);
  ui.theme.onclick();
  assert.equal(ui.document.documentElement.dataset.theme, 'light');
  assert.equal(ui.theme['aria-pressed'], 'false');
  assert.equal(ui.theme.innerHTML, iconMarkup, 'theme toggle keeps icon');
  assert.equal(ui.theme.title, 'Chế độ tối');
  assert.equal(ui.theme['aria-label'], ui.theme.title);
  assert.equal(ui.storage.get('gps-theme'), 'light');
  assert.equal(frontend(ui.storage.get('gps-theme')).document.documentElement.dataset.theme, 'light', 'restored theme');
  assert.equal(frontend(null, false).document.documentElement.dataset.theme, 'light', 'system light theme');
  const point = { latitude: 10, longitude: 106, accuracy: 5, capturedAt: new Date().toISOString(), receivedAt: new Date().toISOString(), sequence: 1 };
  ui.context.point = point;
  runInContext('applyLocation(point)', ui.context);
  assert.deepEqual(Array.from(ui.map.center), [point.latitude, point.longitude], 'follow GPS centers first location');
  const follow = ui.document.getElementById('follow-gps');
  follow.checked = false; follow.onchange();
  runInContext('applyLocation({ ...point, latitude: 10.5, sequence: 2 })', ui.context);
  assert.deepEqual(Array.from(ui.map.center), [point.latitude, point.longitude], 'disabled follow preserves map center');
  follow.checked = true; follow.onchange();
  assert.deepEqual(Array.from(ui.map.center), [10.5, point.longitude], 'enabling follow centers latest GPS');
  runInContext('applyLocation({ ...point, latitude: 10.6, sequence: 3 })', ui.context);
  assert.deepEqual(Array.from(ui.map.center), [10.6, point.longitude], 'follow tracks later GPS');
  ui.map.dragstart();
  assert.equal(follow.checked, false, 'manual map drag disables GPS follow');
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
  const imported = frontend(), routes = [];
  const endpoints = [{ latitude: 10.7769, longitude: 106.7009 }, { latitude: 10.779, longitude: 106.705 }];
  imported.context.fetch = async (path, options) => {
    const body = JSON.parse(options.body);
    if (path === '/api/maps/resolve') return { ok: true, json: async () => endpoints[body.url.endsWith('start') ? 0 : 1] };
    assert.equal(path, '/api/route'); routes.push(body);
    return { ok: true, json: async () => ({ ...body, sequence: routes.length }) };
  };
  for (const endpoint of ['start', 'end']) {
    imported.document.getElementById(`${endpoint}-link`).value = `https://maps.app.goo.gl/${endpoint}`;
    await runInContext(`useMapLink('${endpoint}')`, imported.context);
    await new Promise(resolve => setImmediate(resolve));
    const button = imported.document.getElementById(`${endpoint}-link-form`).button;
    assert.equal(button.innerHTML, iconMarkup, 'successful import keeps icon');
    assert.equal(button['aria-busy'], 'false', 'successful import clears busy state');
  }
  assert.deepEqual(routes, [{ start: endpoints[0], end: endpoints[1] }], 'imported A/B autosave');
  assert.equal(runInContext('startMarker.points[0]', imported.context), endpoints[0].latitude);
  assert.equal(runInContext('endMarker.points[1]', imported.context), endpoints[1].longitude);
  assert.deepEqual(JSON.parse(JSON.stringify(imported.map.bounds)), endpoints.map(p => [p.latitude, p.longitude]), 'import frames both endpoints');
  const before = runInContext('JSON.stringify([startPoint, endPoint])', imported.context);
  imported.context.fetch = async () => ({ ok: false, status: 400, json: async () => ({ error: 'Invalid link' }) });
  await runInContext("useMapLink('start')", imported.context);
  assert.equal(imported.document.getElementById('start-link-form').button.innerHTML, iconMarkup, 'failed import keeps icon');
  assert.equal(imported.document.getElementById('start-link-form').button['aria-busy'], 'false', 'failed import clears busy state');
  assert.equal(runInContext('JSON.stringify([startPoint, endPoint])', imported.context), before, 'failed import preserves endpoints');
  assert.equal(routes.length, 1, 'failed import does not save route');
  let finishResolve;
  imported.context.fetch = () => new Promise(resolve => { finishResolve = resolve; });
  const resolving = runInContext("useMapLink('start')", imported.context);
  assert.equal(imported.document.getElementById('start-link-form').button.innerHTML, iconMarkup, 'pending import keeps icon');
  assert.equal(imported.document.getElementById('start-link-form').button['aria-busy'], 'true', 'pending import exposes busy state');
  runInContext('startPoint = { latitude: 21, longitude: 105 }; drawRoute();', imported.context);
  finishResolve({ ok: true, json: async () => endpoints[0] });
  await resolving;
  assert.equal(runInContext('startPoint.latitude', imported.context), 21, 'late link does not overwrite newer point');
  assert.equal(imported.document.getElementById('start-link-form').button.disabled, false, 'resolve releases button');
  assert.equal(imported.document.getElementById('start-link-form').button.innerHTML, iconMarkup, 'late import keeps icon');
  assert.equal(imported.document.getElementById('start-link-form').button['aria-busy'], 'false', 'late import clears busy state');
  const directions = frontend(), requests = [], routing = directions.document.getElementById('routing');
  const road = () => JSON.parse(runInContext('JSON.stringify(roadRoute.getLatLngs())', directions.context));
  const flush = () => new Promise(resolve => setTimeout(resolve, 5));
  directions.context.fetch = (url, options) => new Promise((resolve, reject) => requests.push({ url, options, resolve, reject }));
  const response = (coordinates = [[106.701, 10.777], [106.703, 10.778], [106.704, 10.779]]) => ({ ok: true, json: async () => ({ code: 'Ok', routes: [{ geometry: { type: 'LineString', coordinates }, distance: 1234 }] }) });
  runInContext('drawRoute()', directions.context);
  assert.equal(routing.disabled, true, 'routing needs both endpoints');
  directions.context.endpoints = endpoints;
  runInContext('[startPoint, endPoint] = endpoints; drawRoute()', directions.context);
  assert.equal(routing.disabled, false);
  assert.equal(requests.length, 0, 'routing defaults off');
  assert.deepEqual(road(), [], 'no straight endpoint line');
  routing.checked = true;
  routing.onchange(); await flush();
  assert.equal(requests.length, 1);
  const url = new URL(requests[0].url), query = JSON.parse(url.searchParams.get('json'));
  assert.equal(url.origin + url.pathname, 'https://valhalla1.openstreetmap.de/route');
  assert.deepEqual(query.locations, endpoints.map(point => ({ lat: point.latitude, lon: point.longitude, search_cutoff: 200 })));
  assert.equal(query.costing, 'auto');
  assert.deepEqual(query.costing_options.auto, { shortest: true });
  assert.equal(query.format, 'osrm');
  assert.equal(query.shape_format, 'geojson');
  assert.equal(query.alternates, 1, 'asks provider for one genuine alternative');
  runInContext('drawRoute()', directions.context);
  assert.equal(requests.length, 1, 'same endpoints do not duplicate requests');
  requests[0].resolve(response()); await flush();
  assert.deepEqual(road(), [[10.777, 106.701], [10.778, 106.703], [10.779, 106.704]], 'only provider geometry with coordinate order reversed');
  runInContext('drawRoute()', directions.context);
  assert.equal(requests.length, 1, 'completed route survives duplicate endpoint echo');
  const retry = directions.document.getElementById('directions-retry');
  retry.onclick(); await flush();
  assert.equal(requests.length, 2, 'retry fetches unchanged endpoints');
  assert.deepEqual(road(), [], 'retry clears old route');
  runInContext('endPoint = { latitude: 10.8, longitude: 106.8 }; drawRoute()', directions.context);
  await flush();
  assert.equal(requests[1].options.signal.aborted, true, 'endpoint edit aborts request');
  assert.equal(requests.length, 3);
  requests[1].resolve(response()); await flush();
  assert.deepEqual(road(), [], 'late old endpoint result cannot repaint');
  requests[2].resolve(response()); await flush();
  assert.equal(road().length, 3);
  retry.onclick(); await flush();
  routing.checked = false; routing.onchange();
  assert.equal(requests[3].options.signal.aborted, true, 'disabling routing aborts request');
  requests[3].resolve(response()); await flush();
  assert.deepEqual(road(), [], 'late result cannot repaint disabled routing');
  routing.checked = true; routing.onchange(); await flush();
  requests[4].resolve({ ok: false, status: 503 }); await flush();
  assert.deepEqual(road(), [], 'HTTP failure leaves no route');
  assert.equal(retry.hidden, false, 'HTTP failure offers retry');
  for (const result of [{ code: 'NoRoute', routes: [] }, { code: 'Ok', routes: [] },
  { code: 'Ok', routes: [{ geometry: { type: 'LineString', coordinates: [] }, distance: 0 }] },
  { code: 'Ok', routes: [{ geometry: { type: 'LineString', coordinates: [[106, 10], [181, 10]] }, distance: 10 }] },
  { code: 'Ok', routes: [{ geometry: { type: 'LineString', coordinates: [[106, 10], [107, 11]] }, distance: -1 }] }]) {
    retry.onclick(); await flush(); requests.at(-1).resolve({ ok: true, json: async () => result }); await flush();
    assert.deepEqual(road(), [], 'missing provider route leaves no geometry');
    assert.equal(retry.hidden, false, 'missing route offers retry');
  }
  retry.onclick(); await flush(); requests.at(-1).reject(new Error('network unavailable')); await flush();
  assert.deepEqual(road(), [], 'network failure leaves no route');
  assert.equal(retry.hidden, false, 'network failure offers retry');
  const alternate = () => JSON.parse(runInContext('JSON.stringify(alternativeRoute.getLatLngs())', directions.context));
  const shorter = { geometry: { type: 'LineString', coordinates: [[106.71, 10.77], [106.72, 10.78], [106.73, 10.79]] }, distance: 1000 };
  const longer = { geometry: { type: 'LineString', coordinates: [[106.74, 10.77], [106.75, 10.78], [106.76, 10.79]] }, distance: 1500 };
  const completeRoutes = async (routes, warnings = []) => {
    retry.onclick(); await flush();
    assert.deepEqual(road(), [], 'refresh clears primary');
    assert.deepEqual(alternate(), [], 'refresh clears alternative');
    requests.at(-1).resolve({ ok: true, json: async () => ({ code: 'Ok', routes, warnings }) }); await flush();
  };
  const crossBorder = { geometry: { type: 'LineString', coordinates: [[106.7009, 10.7769], [106.173, 11.081], [105.806, 11.267], [104.9282, 11.5564]] }, distance: 230000 };
  await completeRoutes([crossBorder], [{ code: 205 }]);
  assert.deepEqual(road(), crossBorder.geometry.coordinates.map(([lon, lat]) => [lat, lon]), 'long route retains provider geometry despite shortest-search warning');
  assert.equal(retry.hidden, true, 'warning does not reject valid long route');
  await completeRoutes([longer, shorter]);
  assert.deepEqual(road(), shorter.geometry.coordinates.map(([lon, lat]) => [lat, lon]), 'primary is shortest supplied route');
  assert.deepEqual(alternate(), longer.geometry.coordinates.map(([lon, lat]) => [lat, lon]), 'alternative uses genuine provider geometry');
  assert.equal(directions.document.getElementById('route-options').hidden, false);
  assert.equal(directions.document.getElementById('secondary-option').hidden, false);
  assert.equal(directions.document.getElementById('route-primary').checked, true);
  const primaryColor = runInContext('roadRoute.style.color', directions.context);
  const secondaryColor = runInContext('alternativeRoute.style.color', directions.context);
  assert.notEqual(primaryColor, secondaryColor, 'selected route visibly differs');
  directions.document.getElementById('route-secondary').onchange();
  assert.equal(runInContext('selectedRoute', directions.context), 1);
  assert.equal(runInContext('alternativeRoute.style.color', directions.context), primaryColor, 'radio highlights alternate');
  assert.equal(directions.document.getElementById('route-secondary').checked, true);
  runInContext('roadRoute.click()', directions.context);
  assert.equal(runInContext('selectedRoute', directions.context), 0, 'clicking route selects it');
  assert.equal(directions.document.getElementById('route-primary').checked, true);
  assert.equal(runInContext('roadRoute.style.color', directions.context), primaryColor);
  runInContext('selectRoadRoute(9)', directions.context);
  assert.equal(runInContext('selectedRoute', directions.context), 0, 'invalid selection ignored');
  await completeRoutes([shorter]);
  assert.deepEqual(alternate(), [], 'single route does not invent alternative');
  assert.equal(directions.document.getElementById('secondary-option').hidden, true);
  await completeRoutes([shorter, shorter]);
  assert.deepEqual(alternate(), [], 'duplicate geometry does not count as alternative');
  assert.equal(directions.document.getElementById('secondary-option').hidden, true);
  await completeRoutes([shorter, { ...longer, distance: -1 }]);
  assert.deepEqual(road(), [], 'invalid alternative rejects whole provider response');
  assert.deepEqual(alternate(), []);
  assert.equal(retry.hidden, false);
  directions.context.point = point;
  runInContext('applyLocation(point)', directions.context);
  const bounds = JSON.stringify(directions.map.bounds);
  await completeRoutes([shorter, longer]);
  assert.equal(JSON.stringify(directions.map.bounds), bounds, 'route response preserves fresh GPS follow');
  directions.document.getElementById('follow-gps').checked = false;
  await completeRoutes([longer, shorter]);
  assert.deepEqual(JSON.parse(JSON.stringify(directions.map.bounds)), [shorter, longer].flatMap(route => route.geometry.coordinates.map(([lon, lat]) => [lat, lon])), 'route frames both geometries with GPS follow disabled');
  retry.onclick(); await flush();
  requests.at(-1).resolve({ ok: true, json: async () => ({ code: 'DistanceExceeded', routes: [] }) }); await flush();
  assert.deepEqual(road(), [], 'provider distance limit clears primary');
  assert.deepEqual(alternate(), [], 'provider distance limit clears alternative');
  assert.equal(retry.hidden, false, 'provider distance limit offers retry');
}

try {
  await checkFrontend();
  for (const path of ['/api/health', '/', '/app.js', '/style.css', '/icons.svg', '/vendor/leaflet.js', '/vendor/signalr.min.js'])
    assert.equal((await request(path)).status, 200, path);
  for (const url of ['https://www.google.com/maps/place/Test/@1,2,17z/data=!3d10.7769!4d106.7009',
    'https://www.google.com/maps/place/Test/@1,2,17z/data=!3d10.7769!4d106.7009?entry=ttu',
    ...['q', 'query', 'll', 'center'].map(key => `https://www.google.com/maps?${key}=10.7769,106.7009`),
    'https://www.google.com/maps/@10.7769,106.7009,17z']) {
    const response = await request('/api/maps/resolve', { url });
    assert.equal(response.status, 200, url);
    assert.deepEqual(await response.json(), { latitude: 10.7769, longitude: 106.7009 });
  }
  for (const url of ['http://www.google.com/maps?q=1,2', 'https://example.com/maps?q=1,2',
    'https://www.google.com/maps?q=NaN,2', 'https://www.google.com/maps?q=91,2',
    'https://www.google.com/maps?q=1,181', 'https://www.google.com/maps/place/Test',
    'https://www.google.com/maps/place/Test/@1,2,17z', 'https://www.google.com/maps/dir/1,2/3,4',
    'https://user@www.google.com/maps?q=1,2', 'https://www.google.com:444/maps?q=1,2',
    'https://www.google.com/maps/search/?query=1,2&query_place_id=place-id'])
    assert.equal((await request('/api/maps/resolve', { url })).status, 400, url);
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
  console.log('PASS: road routing geometry, long routes, cancellation/retry, Google Maps links, A/B import, theme, frontend reconnect, assets, route/GPS validation, two viewers.');
} finally {
  await Promise.all(connections.map(connection => connection.stop()));
}
