history.replaceState(null, '', location.pathname);
const $ = id => document.getElementById(id);
let dark = window.matchMedia('(prefers-color-scheme: dark)').matches;
try { const saved = localStorage.getItem('gps-theme'); if (saved) dark = saved === 'dark'; } catch { }
function applyTheme() {
  document.documentElement.dataset.theme = dark ? 'dark' : 'light';
  $('theme').textContent = dark ? 'Chế độ sáng' : 'Chế độ tối'; $('theme').setAttribute('aria-pressed', String(dark));
}
$('theme').onclick = () => { dark = !dark; applyTheme(); try { localStorage.setItem('gps-theme', dark ? 'dark' : 'light'); } catch { } };
applyTheme();
const map = L.map('map').setView([10.7769, 106.7009], 13);
L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', { attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors · Routing: <a href="https://valhalla.github.io/valhalla/">Valhalla</a> / <a href="https://www.fossgis.de/">FOSSGIS</a>', maxZoom: 19 }).addTo(map);
const trail = L.polyline([], { color: '#17695e', weight: 3 }).addTo(map);
const roadRoute = L.polyline([], { color: '#c53c65', weight: 5, opacity: .9 }).addTo(map);
const connection = new signalR.HubConnectionBuilder().withUrl('/hubs/tracking').withAutomaticReconnect().build();
let latest, marker, circle, startMarker, endMarker, startPoint, endPoint, selecting;
let routeSequence = -1, watchId, generation = 0, activeRequest, lastGpsSent = 0;
let connecting = false, syncing = true, buffered = [], routeSaving = false, routePending, deferredRoute;
let directionsRequest, directionsKey;
function error(message = '') { $('error').textContent = message; $('error').hidden = !message; }
function state(message, live = false) { $('connection').textContent = message; $('connection').classList.toggle('live', live); }
function coordinates(point) { return point ? `${point.latitude.toFixed(6)}, ${point.longitude.toFixed(6)}` : 'Chưa chọn'; }
function updateAge() {
  if (!latest) return;
  const age = Math.max(0, Math.floor((Date.now() - Date.parse(latest.receivedAt)) / 1000));
  const stale = age > 15 || Date.now() - Date.parse(latest.capturedAt) > 15000;
  $('received').textContent = `${new Date(latest.receivedAt).toLocaleTimeString('vi-VN')} · ${age} giây trước`;
  $('freshness').textContent = stale ? 'GPS đã cũ' : 'GPS trực tiếp'; $('freshness').className = `badge ${stale ? 'stale' : 'live'}`;
}
function applyLocation(point) {
  if (!point || (latest && point.sequence <= latest.sequence)) return;
  latest = point; const latlng = [point.latitude, point.longitude];
  if (!marker) {
    marker = L.circleMarker(latlng, { radius: 8, color: '#fff', weight: 3, fillColor: '#2586c7', fillOpacity: 1 }).addTo(map).bindTooltip('GPS hiện tại');
    circle = L.circle(latlng, { radius: point.accuracy, color: '#2586c7', weight: 1, fillOpacity: .1 }).addTo(map); map.setView(latlng, 16);
  } else { marker.setLatLng(latlng); circle.setLatLng(latlng).setRadius(point.accuracy); }
  // shortcut: only 200 samples stay in this tab; persist history when longer tracking is needed.
  trail.setLatLngs([...trail.getLatLngs(), L.latLng(...latlng)].slice(-200));
  $('coordinates').textContent = coordinates(point); $('accuracy').textContent = `± ${point.accuracy.toFixed(1)} m`; updateAge();
}
function drawRoute() {
  for (const endpoint of ['start', 'end']) {
    const point = endpoint === 'start' ? startPoint : endPoint; let pin = endpoint === 'start' ? startMarker : endMarker;
    if (point) {
      const latlng = [point.latitude, point.longitude];
      if (pin) pin.setLatLng(latlng);
      else pin = L.marker(latlng, { icon: L.divIcon({ className: `endpoint-marker ${endpoint}`, html: `<span>${endpoint === 'start' ? 'A' : 'B'}</span>`, iconSize: [30, 30], iconAnchor: [15, 15] }) }).addTo(map).bindTooltip(endpoint === 'start' ? 'Điểm đầu' : 'Điểm cuối');
    } else if (pin) { map.removeLayer(pin); pin = undefined; }
    if (endpoint === 'start') startMarker = pin; else endMarker = pin;
    $(`${endpoint}-coordinates`).value = coordinates(point);
  }
  findDirections();
}
async function findDirections(force = false) {
  const enabled = $('routing').checked, key = JSON.stringify([enabled, startPoint, endPoint]);
  $('routing').disabled = !startPoint || !endPoint;
  if (!force && key === directionsKey) return;
  directionsKey = key; directionsRequest?.abort(); directionsRequest = undefined; roadRoute.setLatLngs([]);
  $('directions-retry').hidden = true; $('directions-status').hidden = !enabled;
  if (!enabled) return;
  if (!startPoint || !endPoint) { $('directions-status').textContent = 'Chọn đủ điểm đầu và điểm cuối.'; return; }
  const request = new AbortController(); directionsRequest = request;
  let timeout, message = 'Không tìm được tuyến ô tô. Chọn điểm gần đường hoặc thử lại.';
  $('directions-status').textContent = 'Đang tìm đường ô tô…';
  try {
    // FOSSGIS allows one request per second; debounce endpoint edits and shared updates.
    await new Promise(resolve => setTimeout(resolve, 1100));
    if (directionsRequest !== request) return;
    timeout = setTimeout(() => request.abort(), 15000);
    const query = {
      locations: [startPoint, endPoint].map(point => ({ lat: point.latitude, lon: point.longitude, search_cutoff: 200 })),
      costing: 'auto', costing_options: { auto: { shortest: true, disable_hierarchy_pruning: true } },
      format: 'osrm', shape_format: 'geojson'
    };
    // shortcut: public Valhalla caps exact shortest searches; use a private server for longer routes.
    const response = await fetch(`https://valhalla1.openstreetmap.de/route?json=${encodeURIComponent(JSON.stringify(query))}`, { signal: request.signal });
    const result = await response.json();
    if (directionsRequest !== request) return;
    if (result.warnings?.some(warning => warning.code === 205)) {
      message = 'Tuyến vượt giới hạn tìm đường ngắn nhất của dịch vụ. Chọn hai điểm gần hơn.';
      throw new Error('Shortest search limit');
    }
    const route = result.routes?.[0], points = route?.geometry?.coordinates;
    if (!response.ok || result.code !== 'Ok' || route?.geometry?.type !== 'LineString' ||
      !Array.isArray(points) || points.length < 2 || !Number.isFinite(route.distance) || route.distance < 0 ||
      !points.every(point => Array.isArray(point) && point.length >= 2 && Number.isFinite(point[0]) && Math.abs(point[0]) <= 180 && Number.isFinite(point[1]) && Math.abs(point[1]) <= 90))
      throw new Error('Invalid road route');
    const latlngs = points.map(([longitude, latitude]) => [latitude, longitude]);
    roadRoute.setLatLngs(latlngs); map.fitBounds(latlngs, { padding: [24, 24], maxZoom: 16 });
    $('directions-status').textContent = `${(route.distance / 1000).toLocaleString('vi-VN', { maximumFractionDigits: 2 })} km · Ô tô`;
  } catch {
    if (directionsRequest !== request) return;
    $('directions-status').textContent = request.signal.aborted ? 'Tìm đường quá lâu. Thử lại.' : message;
    $('directions-retry').hidden = false;
  } finally { clearTimeout(timeout); if (directionsRequest === request) directionsRequest = undefined; }
}
function applyRoute(route) {
  if (routeSaving || routePending) { if (!deferredRoute || route.sequence > deferredRoute.sequence) deferredRoute = route; return; }
  if (route.sequence <= routeSequence) return; routeSequence = route.sequence;
  startPoint = route.start; endPoint = route.end; drawRoute(); $('route-status').textContent = startPoint && endPoint ? 'Đã lưu hai điểm.' : 'Chưa có hai điểm.';
}
function receive(type, value) { if (syncing) buffered.push({ type, value }); else if (type === 'location') applyLocation(value); else applyRoute(value); }
connection.on('LocationUpdated', point => receive('location', point)); connection.on('RouteUpdated', route => receive('route', route));
async function sync() {
  syncing = true;
  try {
    const snapshot = await connection.invoke('GetState');
    latest = undefined; if (marker) map.removeLayer(marker); if (circle) map.removeLayer(circle); marker = circle = undefined; trail.setLatLngs([]);
    $('coordinates').textContent = 'Chưa có vị trí'; $('accuracy').textContent = $('received').textContent = '—'; $('freshness').textContent = 'Chưa có GPS'; $('freshness').className = 'badge';
    routeSequence = -1; applyRoute({ start: snapshot.start, end: snapshot.end, sequence: snapshot.routeSequence }); applyLocation(snapshot.location);
    for (const event of buffered.sort((a, b) => a.value.sequence - b.value.sequence)) { if (event.type === 'location') applyLocation(event.value); else applyRoute(event.value); }
  } finally { syncing = false; buffered = []; }
}
async function connected() { await sync(); state('Đã kết nối', true); error(); $('retry').hidden = true; }
connection.onreconnecting(() => { syncing = true; buffered = []; state('Đang kết nối lại'); });
connection.onreconnected(() => connected().catch(() => { state('Không tải được vị trí'); error('Không tải được dữ liệu. Thử kết nối lại.'); $('retry').hidden = false; }));
connection.onclose(() => { state('Mất kết nối'); $('retry').hidden = false; });
async function connect() {
  if (connecting) return; connecting = true; syncing = true; buffered = []; $('retry').hidden = true; state('Đang kết nối');
  try { if (connection.state === signalR.HubConnectionState.Disconnected) await connection.start(); await connected(); }
  catch { syncing = false; state('Kết nối thất bại'); error('Không kết nối được máy chủ. Thử lại khi có mạng.'); $('retry').hidden = false; }
  finally { connecting = false; }
}
function stop() {
  generation++; activeRequest?.abort(); activeRequest = undefined; lastGpsSent = 0;
  if (watchId !== undefined) navigator.geolocation.clearWatch(watchId);
  watchId = undefined; $('gps').disabled = false; $('stop').disabled = true; $('sharing').textContent = 'Đã dừng gửi GPS.';
}
async function publish(point, current) {
  if (current !== generation || activeRequest) return;
  const request = new AbortController(); activeRequest = request; const timeout = setTimeout(() => request.abort(), 10000);
  try {
    const response = await fetch('/api/location', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(point), signal: request.signal });
    if (current !== generation || response.status === 409) return;
    if (!response.ok) throw new Error();
    const result = await response.json(); if (current !== generation) return;
    receive('location', result); error();
  } catch (failure) { if (current === generation) error(failure.name === 'AbortError' ? 'Gửi GPS quá lâu. Vị trí tiếp theo sẽ thử lại.' : 'Chưa gửi được GPS. Kiểm tra mạng hoặc máy chủ.'); }
  finally { clearTimeout(timeout); if (activeRequest === request) activeRequest = undefined; }
}
function startGps() {
  if (!window.isSecureContext || !navigator.geolocation) { error('GPS cần HTTPS (hoặc localhost) và trình duyệt hỗ trợ vị trí.'); return; }
  stop(); error(); const current = generation; $('gps').disabled = true; $('stop').disabled = false; $('sharing').textContent = 'Đang chờ quyền vị trí / GPS…';
  try {
    watchId = navigator.geolocation.watchPosition(position => {
      if (current !== generation || activeRequest || Date.now() - lastGpsSent < 1000) return;
      lastGpsSent = Date.now(); $('sharing').textContent = 'Đang gửi GPS từ điện thoại.';
      publish({ latitude: position.coords.latitude, longitude: position.coords.longitude, accuracy: position.coords.accuracy, capturedAt: new Date(position.timestamp).toISOString() }, current);
    }, failure => {
      if (current !== generation) return;
      const messages = { 1: 'Quyền vị trí bị từ chối. Cho phép trong cài đặt trình duyệt rồi bật lại GPS.', 2: 'Không lấy được GPS. Kiểm tra dịch vụ vị trí và tín hiệu.', 3: 'GPS hết thời gian chờ. Ra nơi thoáng rồi bật lại.' };
      stop(); error(messages[failure.code] || 'Không lấy được vị trí.');
    }, { enableHighAccuracy: true, maximumAge: 0, timeout: 15000 });
  } catch { stop(); error('Không bật được GPS. Kiểm tra quyền vị trí.'); }
}
function choose(endpoint) {
  selecting = endpoint; $('choose-start').setAttribute('aria-pressed', String(endpoint === 'start')); $('choose-end').setAttribute('aria-pressed', String(endpoint === 'end'));
  $('route-status').textContent = `Chạm bản đồ để chọn điểm ${endpoint === 'start' ? 'đầu' : 'cuối'}.`;
}
async function saveRoute() {
  if (routeSaving) return; routeSaving = true;
  try {
    while (routePending) {
      const route = routePending; routePending = undefined; $('route-status').textContent = 'Đang lưu hai điểm…';
      const request = new AbortController(); const timeout = setTimeout(() => request.abort(), 10000);
      try {
        const response = await fetch('/api/route', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(route), signal: request.signal });
        if (!response.ok) throw new Error();
        applyRoute(await response.json()); $('route-status').textContent = 'Đã lưu hai điểm.'; error();
      } finally { clearTimeout(timeout); }
    }
  } catch { error('Chưa lưu được hai điểm. Chọn lại điểm để thử lại.'); $('route-status').textContent = 'Hai điểm chưa được lưu.'; }
  finally { routeSaving = false; if (deferredRoute) { const route = deferredRoute; deferredRoute = undefined; applyRoute(route); } if (routePending) saveRoute(); }
}
function setEndpoint(endpoint, point) {
  if (endpoint === 'start') startPoint = point; else endPoint = point;
  selecting = undefined; $('choose-start').setAttribute('aria-pressed', 'false'); $('choose-end').setAttribute('aria-pressed', 'false'); drawRoute();
  error();
  if (startPoint && endPoint) { routePending = { start: startPoint, end: endPoint }; saveRoute(); } else $('route-status').textContent = 'Chọn thêm điểm còn lại.';
}
async function useMapLink(endpoint) {
  const input = $(`${endpoint}-link`), button = $(`${endpoint}-link-form`).querySelector('button');
  if (button.disabled) return;
  const previous = JSON.stringify(endpoint === 'start' ? startPoint : endPoint);
  let message = 'Không đọc được link Google Maps. Kiểm tra mạng hoặc chọn điểm trên bản đồ.';
  button.disabled = input.disabled = true; button.textContent = 'Đang đọc…'; error();
  const request = new AbortController(), timeout = setTimeout(() => request.abort(), 12000);
  try {
    const response = await fetch('/api/maps/resolve', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ url: input.value.trim() }), signal: request.signal });
    const point = await response.json();
    if (!response.ok) { message = point.error || message; throw new Error(); }
    if (JSON.stringify(endpoint === 'start' ? startPoint : endPoint) !== previous) { error('Điểm đã thay đổi khi đọc link. Nhấn Dùng link lần nữa nếu muốn thay thế.'); return; }
    setEndpoint(endpoint, point);
    map.fitBounds([startPoint || point, endPoint || point].map(p => [p.latitude, p.longitude]), { padding: [24, 24], maxZoom: 16 });
  } catch { error(request.signal.aborted ? 'Đọc link quá lâu. Thử lại hoặc chọn điểm trên bản đồ.' : message); }
  finally { clearTimeout(timeout); button.disabled = input.disabled = false; button.textContent = 'Dùng link'; }
}
map.on('click', event => {
  if (!selecting) return;
  const point = { latitude: event.latlng.lat, longitude: event.latlng.lng };
  if (!Number.isFinite(point.latitude) || !Number.isFinite(point.longitude) || Math.abs(point.latitude) > 90 || Math.abs(point.longitude) > 180) { error('Chọn điểm trong phạm vi bản đồ thế giới.'); return; }
  setEndpoint(selecting, point);
});
for (const endpoint of ['start', 'end']) $(`${endpoint}-link-form`).onsubmit = event => { event.preventDefault(); useMapLink(endpoint); };
$('choose-start').onclick = () => choose('start'); $('choose-end').onclick = () => choose('end'); $('gps').onclick = startGps; $('stop').onclick = stop; $('retry').onclick = connect;
$('routing').onchange = () => findDirections(); $('directions-retry').onclick = () => findDirections(true);
setInterval(updateAge, 1000); window.addEventListener('pagehide', stop); connect();
