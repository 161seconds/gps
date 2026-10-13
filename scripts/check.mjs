import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { setTimeout as delay } from 'node:timers/promises';
import { HubConnectionBuilder, HttpTransportType, LogLevel } from '@microsoft/signalr';

const origin = process.env.GPS_URL || 'http://localhost:5085';
const connections = [];
let checks = 0;
function check(actual, expected, message) {
  assert.deepEqual(actual, expected, message);
  checks++;
}
async function request(path, options = {}) {
  return fetch(`${origin}${path}`, { ...options, signal: AbortSignal.timeout(5000) });
}
async function create() {
  const response = await request('/api/trips', { method: 'POST' });
  check(response.status, 200, 'create trip');
  return response.json();
}
async function viewer() {
  const connection = new HubConnectionBuilder().withUrl(`${origin}/hubs/tracking`, {
    transport: HttpTransportType.WebSockets, skipNegotiation: true
  }).configureLogging(LogLevel.None).build();
  connections.push(connection);
  await connection.start();
  return connection;
}
function upload(trip, point, token = trip.driverToken) {
  return request(`/api/trips/${trip.tripId}/locations`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify(point)
  });
}
function receive(connection) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { connection.off('LocationUpdated', listener); reject(new Error('Realtime update timed out')); }, 3000);
    const listener = point => { clearTimeout(timer); connection.off('LocationUpdated', listener); resolve(point); };
    connection.on('LocationUpdated', listener);
  });
}

try {
  const script = readFileSync(new URL('../wwwroot/app.js', import.meta.url), 'utf8');
  const joinSource = script.slice(script.indexOf('async function join()'), script.indexOf('\nasync function connect()'));
  const elements = Object.fromEntries(['trip-recovery', 'driver-controls', 'links'].map(id => [id, { hidden: id === 'trip-recovery' }]));
  let stopped = 0, applied;
  const context = { $: id => elements[id], stop: () => stopped++, apply: value => { applied = value; },
    session: { tripId: 'old-trip', token: 'old-key' }, connection: {} };
  const join = runInNewContext(`(${joinSource})`, context);
  context.connection.invoke = async () => { throw new Error("An unexpected error occurred invoking 'JoinTrip' on the server. HubException: Trip is missing or expired. Create a new test trip."); };
  await assert.rejects(join(), /This test trip expired or was cleared by a server restart/);
  checks++;
  check(stopped, 1, 'expired trip stops sharing');
  check(elements['trip-recovery'].hidden, false, 'expired trip offers a new session');
  check(elements['driver-controls'].hidden, true, 'expired driver controls hidden');
  check(elements.links.hidden, true, 'expired share links hidden');
  context.connection.invoke = async () => ({ sequence: 1 });
  await join();
  check(applied, { sequence: 1 }, 'valid join still applies snapshot');
  check(elements['trip-recovery'].hidden, true, 'successful join hides recovery');
  context.connection.invoke = async () => { throw new Error('HubException: Invalid viewing key.'); };
  await assert.rejects(join(), /Invalid viewing key/);
  checks++;
  check(stopped, 1, 'authorization error not mistaken for expiry');
  check(elements['trip-recovery'].hidden, true, 'authorization error preserved');
  const recoverySource = script.slice(script.indexOf("if (new URLSearchParams(location.search).has('new-trip'))"), script.indexOf('\nsetInterval(updateAge'));
  let created = 0, cleanUrl, activated = 0;
  const recoveryContext = { URLSearchParams, location: { search: '?new-trip', pathname: '/' },
    fragment: new URLSearchParams('trip=old-trip&role=driver&token=old-key'), activate: () => activated++,
    history: { replaceState: (_state, _title, url) => { cleanUrl = url; } },
    $: () => ({ onclick: () => created++ }) };
  runInNewContext(recoverySource, recoveryContext);
  check(created, 1, 'recovery creates trip immediately on fresh page');
  check(cleanUrl, '/', 'recovery clears query so refresh does not create again');
  check(activated, 0, 'new trip recovery ignores stale share fragment');
  recoveryContext.location.search = '';
  recoveryContext.fragment = new URLSearchParams('');
  runInNewContext(recoverySource, recoveryContext);
  check(created, 1, 'ordinary page does not create automatically');
  check((await request('/api/health')).status, 200, 'health');
  for (const file of ['/', '/app.js', '/style.css', '/vendor/leaflet.js', '/vendor/signalr.min.js'])
    check((await request(file)).status, 200, `asset ${file}`);
  const trip = await create();
  const other = await create();
  assert.notEqual(trip.driverToken, trip.viewerToken);
  assert.ok(Date.parse(trip.expiresAt) > Date.now());
  checks += 2;

  const a = await viewer();
  const b = await viewer();
  check(await a.invoke('JoinTrip', trip.tripId, trip.viewerToken), null, 'empty snapshot');
  check(await b.invoke('JoinTrip', other.tripId, other.viewerToken), null, 'other empty snapshot');
  await assert.rejects(a.invoke('JoinTrip', trip.tripId, other.viewerToken), /Invalid viewing key/);
  checks++;
  await assert.rejects(a.invoke('JoinTrip', '00000000-0000-0000-0000-000000000000', trip.viewerToken), /Trip is missing or expired/);
  checks++;
  let leaked = 0;
  b.on('LocationUpdated', () => leaked++);
  const point = { latitude: 48.8566, longitude: 2.3522, accuracy: 10,
    capturedAt: new Date(Date.now() - 2000).toISOString(), source: 'simulation' };
  check((await upload(trip, point, trip.viewerToken)).status, 403, 'viewer cannot publish');
  check((await upload(trip, point, other.driverToken)).status, 403, 'cross-trip publish denied');
  check((await upload(trip, point, '')).status, 403, 'missing key denied');
  for (const invalid of [{ latitude: 91 }, { longitude: -181 }, { accuracy: -1 },
    { latitude: null }, { source: 'unknown' }, { capturedAt: new Date(Date.now() + 60000).toISOString() },
    { capturedAt: new Date(Date.now() - 660000).toISOString() }])
    check((await upload(trip, { ...point, ...invalid })).status, 400, `invalid input ${Object.keys(invalid)[0]}`);
  const missing = { ...point };
  delete missing.latitude;
  check((await upload(trip, missing)).status, 400, 'required latitude');

  const firstEvent = receive(a);
  const response = await upload(trip, point);
  check(response.status, 200, 'publish valid point');
  const first = await response.json();
  check(await firstEvent, first, 'SignalR receives committed point');
  check(first.sequence, 1, 'initial sequence');
  check(first.source, 'simulation', 'simulation labelled');
  check((await upload(trip, point)).status, 409, 'duplicate cannot replace latest');
  check((await upload(trip, { ...point, capturedAt: new Date(Date.parse(point.capturedAt) - 1).toISOString() })).status, 409, 'older point cannot replace latest');
  check((await upload(trip, { ...point, capturedAt: new Date().toISOString() })).status, 429, 'publish rate limited');
  check(await a.invoke('JoinTrip', trip.tripId, trip.driverToken), first, 'driver can view snapshot');

  await delay(300);
  const nextEvent = receive(a);
  const nextResponse = await upload(trip, { ...point, latitude: 48.8571,
    capturedAt: new Date().toISOString(), source: 'gps' });
  check(nextResponse.status, 200, 'newer point accepted');
  const next = await nextResponse.json();
  check(await nextEvent, next, 'next realtime point');
  check(next.sequence, 2, 'monotonic sequence');
  check(next.source, 'gps', 'real GPS labelled');
  await a.stop();
  await a.start();
  check(await a.invoke('JoinTrip', trip.tripId, trip.viewerToken), next, 'reconnect gets latest snapshot');
  await delay(100);
  check(leaked, 0, 'trip groups isolated');

  check(await a.invoke('JoinTrip', other.tripId, other.viewerToken), null, 'switch group');
  let switchedLeak = 0;
  a.on('LocationUpdated', () => switchedLeak++);
  await delay(300);
  check((await upload(trip, { ...point, capturedAt: new Date().toISOString() })).status, 200, 'publish after group switch');
  await delay(100);
  check(switchedLeak, 0, 'previous group removed');

  console.log(`PASS ${checks} checks: expiry recovery, assets, validation, trip permissions, realtime, ordering, rate limit, isolation, reconnect.`);
} finally {
  await Promise.all(connections.map(connection => connection.stop()));
}
