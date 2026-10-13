const $ = id => document.getElementById(id);
const map = L.map('map').setView([48.8566, 2.3522], 12);
L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
  attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors', maxZoom: 19
}).addTo(map);
const trail = L.polyline([], { color: '#17695e', weight: 3 }).addTo(map);
let marker, circle, latest, session, connection, watchId, simulationTimer;
let generation = 0, activeRequest, connecting = false, lastGpsSent = 0;
const positions = [[48.8566,2.3522],[48.8571,2.3531],[48.8577,2.3540],[48.8582,2.3548],[48.8588,2.3557]];

function error(message = '') { $('error').textContent = message; $('error').hidden = !message; }
function state(message) { $('connection').textContent = message; $('connection').classList.toggle('live', message === 'Connected'); }
function updateAge() {
  if (!latest) return;
  const age = Math.max(0, Math.floor((Date.now() - Date.parse(latest.receivedAt)) / 1000));
  const capturedAge = Math.max(0, Math.floor((Date.now() - Date.parse(latest.capturedAt)) / 1000));
  const delay = (Date.parse(latest.receivedAt) - Date.parse(latest.capturedAt)) / 1000;
  $('age').textContent = `Captured ${capturedAge}s ago · received ${age}s ago · transit ${delay.toFixed(1)}s`;
  const stale = age > 15 || capturedAge > 15;
  $('freshness').textContent = stale ? 'Stale location' : 'Live location';
  $('freshness').className = `badge ${stale ? 'stale' : 'live'}`;
}
function apply(point) {
  if (!point || point.tripId !== session?.tripId || (latest && point.sequence <= latest.sequence)) return;
  latest = point;
  const latlng = [point.latitude, point.longitude];
  if (!marker) {
    marker = L.marker(latlng).addTo(map);
    circle = L.circle(latlng, { radius: point.accuracy, color: '#17695e', weight: 1, fillOpacity: .12 }).addTo(map);
    map.setView(latlng, 15);
  } else { marker.setLatLng(latlng); circle.setLatLng(latlng).setRadius(point.accuracy); map.panTo(latlng); }
  const points = trail.getLatLngs();
  points.push(L.latLng(...latlng));
  trail.setLatLngs(points.slice(-200));
  $('coordinates').textContent = `${point.latitude.toFixed(6)}, ${point.longitude.toFixed(6)}`;
  $('accuracy').textContent = `± ${point.accuracy.toFixed(1)} m`;
  $('source').textContent = point.source === 'simulation' ? 'SIMULATED · not real GPS' : 'Phone GPS';
  $('captured').textContent = new Date(point.capturedAt).toLocaleTimeString();
  $('received').textContent = new Date(point.receivedAt).toLocaleTimeString();
  updateAge();
}
async function join() {
  try {
    apply(await connection.invoke('JoinTrip', session.tripId, session.token));
    $('trip-recovery').hidden = true;
  } catch (e) {
    if (!e.message.includes('Trip is missing or expired.')) throw e;
    stop();
    $('driver-controls').hidden = true;
    $('links').hidden = true;
    $('trip-recovery').hidden = false;
    throw new Error('This test trip expired or was cleared by a server restart. Create a new test trip and share the new links.');
  }
}
async function connect() {
  if (connecting) return;
  connecting = true;
  $('retry').hidden = true;
  state('Connecting');
  try {
    if (!connection) {
      connection = new signalR.HubConnectionBuilder().withUrl('/hubs/tracking').withAutomaticReconnect().build();
      connection.on('LocationUpdated', apply);
      connection.onreconnecting(() => state('Reconnecting'));
      connection.onreconnected(async () => {
        try { await join(); state('Connected'); error(); }
        catch (e) { state('Join failed'); error(e.message); $('retry').hidden = false; }
      });
      connection.onclose(() => { state('Disconnected'); $('retry').hidden = false; });
    }
    if (connection.state === signalR.HubConnectionState.Disconnected) await connection.start();
    await join();
    state('Connected');
    error();
  } catch (e) { state('Connection failed'); error(e.message); $('retry').hidden = false; }
  finally { connecting = false; }
}
function stop() {
  generation++;
  activeRequest?.abort();
  activeRequest = undefined;
  lastGpsSent = 0;
  if (watchId !== undefined) navigator.geolocation.clearWatch(watchId);
  watchId = undefined;
  clearInterval(simulationTimer);
  simulationTimer = undefined;
  $('gps').disabled = $('simulate').disabled = false;
  $('stop').disabled = true;
  $('sharing').textContent = 'Not sharing';
}
async function publish(point, current) {
  // shortcut: samples during an upload are skipped; add offline persistence only when delivery is required.
  if (current !== generation || activeRequest || (latest && Date.parse(point.capturedAt) <= Date.parse(latest.capturedAt))) return;
  const request = new AbortController();
  activeRequest = request;
  const timeout = setTimeout(() => request.abort(), 10000);
  try {
      const response = await fetch(`/api/trips/${encodeURIComponent(session.tripId)}/locations`, {
        method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${session.token}` }, body: JSON.stringify(point), signal: request.signal
      });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || `Upload failed (${response.status})`);
      if (current !== generation) return;
      apply(result);
      if (current === generation) error();
  } catch (e) { if (current === generation) error(e.name === 'AbortError' ? 'Location upload timed out. Next sample will retry.' : `Location not sent: ${e.message}`); }
  finally { clearTimeout(timeout); if (activeRequest === request) activeRequest = undefined; }
}
function start(source) {
  if (session?.role !== 'driver') return;
  stop(); error();
  const current = generation;
  if (source === 'gps') {
    if (!window.isSecureContext || !navigator.geolocation) { error('GPS requires HTTPS (or localhost) and a browser with geolocation support.'); return; }
    $('sharing').textContent = 'Waiting for location permission / GPS…';
    try { watchId = navigator.geolocation.watchPosition(position => {
      if (current !== generation) return;
      if (Date.now() - lastGpsSent < 1000 || activeRequest || (latest && position.timestamp <= Date.parse(latest.capturedAt))) return;
      lastGpsSent = Date.now();
      $('sharing').textContent = 'Sharing phone GPS';
      publish({ latitude: position.coords.latitude, longitude: position.coords.longitude, accuracy: position.coords.accuracy, capturedAt: new Date(position.timestamp).toISOString(), source }, current);
    }, failure => {
      if (current !== generation) return;
      const messages = { 1: 'Location permission denied. Allow location in browser settings, then retry.', 2: 'GPS unavailable. Check device location services and signal.', 3: 'GPS timed out. Move to an open area and retry.' };
      stop(); error(messages[failure.code] || failure.message);
    }, { enableHighAccuracy: true, maximumAge: 0, timeout: 15000 }); }
    catch (e) { stop(); error(`Could not start GPS: ${e.message}`); return; }
  } else {
    let index = 0;
    const tick = () => {
      if (current !== generation) return;
      const [latitude, longitude] = positions[index++ % positions.length];
      publish({ latitude, longitude, accuracy: 10, capturedAt: new Date().toISOString(), source }, current);
    };
    $('sharing').textContent = 'Sharing SIMULATED Paris positions · every 2 seconds';
    tick(); simulationTimer = setInterval(tick, 2000);
  }
  $('gps').disabled = $('simulate').disabled = true;
  $('stop').disabled = false;
}
function activate(value) {
  session = value;
  $('create').hidden = true;
  $('role').textContent = value.role === 'driver' ? 'Driver · location sharing' : 'Viewer · read only';
  $('trip').textContent = `Trip ${value.tripId}`;
  $('driver-controls').hidden = value.role !== 'driver';
  connect();
}
function shareLink(tripId, role, token) {
  const url = new URL(location.pathname, location.origin);
  url.hash = new URLSearchParams({ trip: tripId, role, token }).toString();
  return url.href;
}
$('create').onclick = async () => {
  $('create').disabled = true; error();
  try {
    const response = await fetch('/api/trips', { method: 'POST' });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || `Trip creation failed (${response.status})`);
    $('driver-link').value = shareLink(result.tripId, 'driver', result.driverToken);
    $('viewer-link').value = shareLink(result.tripId, 'viewer', result.viewerToken);
    $('expiry').textContent = `Links expire ${new Date(result.expiresAt).toLocaleString()}`;
    $('links').hidden = false;
    history.replaceState(null, '', $('driver-link').value);
    activate({ tripId: result.tripId, role: 'driver', token: result.driverToken });
  } catch (e) { error(e.message); }
  finally { $('create').disabled = false; }
};
$('gps').onclick = () => start('gps');
$('simulate').onclick = () => start('simulation');
$('stop').onclick = stop;
$('retry').onclick = connect;
document.querySelectorAll('[data-copy]').forEach(button => button.onclick = async () => {
  const input = $(button.dataset.copy);
  try { await navigator.clipboard.writeText(input.value); $('copy-status').textContent = 'Link copied.'; }
  catch { input.focus(); input.select(); $('copy-status').textContent = 'Select and copy the link above.'; }
});
const fragment = new URLSearchParams(location.hash.slice(1));
if (new URLSearchParams(location.search).has('new-trip')) {
  history.replaceState(null, '', location.pathname);
  $('create').onclick();
} else if (fragment.has('trip') || fragment.has('token')) {
  const role = fragment.get('role');
  if (fragment.get('trip') && fragment.get('token') && ['driver','viewer'].includes(role)) activate({ tripId: fragment.get('trip'), token: fragment.get('token'), role });
  else error('Invalid share link. Ask the trip creator for a complete link.');
}
setInterval(updateAge, 1000);
window.addEventListener('pagehide', stop);
