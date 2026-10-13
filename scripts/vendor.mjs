import { cpSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const vendor = `${root}wwwroot/vendor`;
mkdirSync(vendor, { recursive: true });
cpSync(`${root}node_modules/@microsoft/signalr/dist/browser/signalr.min.js`, `${vendor}/signalr.min.js`);
for (const file of ['leaflet.js', 'leaflet.css', 'images'])
  cpSync(`${root}node_modules/leaflet/dist/${file}`, `${vendor}/${file}`, { recursive: true });
cpSync(`${root}node_modules/leaflet/LICENSE`, `${vendor}/leaflet-LICENSE.txt`);
cpSync(`${root}scripts/signalr-LICENSE.txt`, `${vendor}/signalr-LICENSE.txt`);
