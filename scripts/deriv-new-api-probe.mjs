/**
 * Locate the applications API on Deriv's NEW platform (api.derivws.com).
 *
 * Why this exists:
 *   app_register lives on the LEGACY WebSocket API, and its documented scope is
 *   `admin` -- which the current token-creation flow does not offer. The legacy
 *   WS host (ws.derivws.com) also returns Cloudflare 520 from datacenter
 *   networks, so it is doubly unusable.
 *
 *   The platform has already moved: OAuth is on auth.deriv.com, the API base is
 *   api.derivws.com, and the current OAuth scope list includes
 *   `application_read` ("Read-only access to your registered applications").
 *   That scope would be pointless without an HTTPS endpoint that reads
 *   applications -- and HTTPS on api.derivws.com is reachable, unlike the WS
 *   host.
 *
 *   So instead of concluding "provisioning is impossible", find that endpoint.
 *   A 401/403 means the route exists and wants auth. A 404 means it does not.
 *
 * Run: node scripts/deriv-new-api-probe.mjs
 *   PROBE_TOKEN=<oauth access token>  optional; proves authenticated access
 */

import { request } from 'node:https';

const HOST = 'api.derivws.com';
const TIMEOUT_MS = 12000;
const TOKEN = process.env.PROBE_TOKEN || null;

// Candidate paths. Ordered roughly by how likely each is to be the real one,
// based on the documented base URL plus the `application_read` scope name.
const PATHS = [
  '/applications/v1/applications',
  '/applications/v1/oauth2/applications',
  '/v1/applications',
  '/applications',
  '/oauth2/applications',
  '/api/v1/applications',
  '/application/v1/applications',
  // Known-good anchors, to show the host is alive and how it reports errors.
  '/trading/v1/options/accounts',
  '/',
];

// Discovery documents that would list the real routes.
const DISCOVERY = ['/openapi.json', '/swagger.json', '/.well-known/openapi.json', '/docs'];

function get(path) {
  return new Promise(resolve => {
    const started = Date.now();
    const headers = { Accept: 'application/json' };
    if (TOKEN) headers.Authorization = `Bearer ${TOKEN}`;

    const req = request({ host: HOST, path, method: 'GET', timeout: TIMEOUT_MS, headers }, res => {
      let body = '';
      res.on('data', chunk => {
        body += chunk;
        if (body.length > 2000) res.destroy();
      });
      const finish = () =>
        resolve({
          path,
          status: res.statusCode,
          ms: Date.now() - started,
          contentType: res.headers['content-type'] || null,
          allow: res.headers.allow || null,
          body: body.replace(/\s+/g, ' ').slice(0, 220),
        });
      res.on('end', finish);
      res.on('close', finish);
    });
    req.on('error', error => resolve({ path, error: String(error?.message || error) }));
    req.on('timeout', () => {
      req.destroy();
      resolve({ path, error: 'timeout' });
    });
    req.end();
  });
}

function verdict(status) {
  if (status === 200) return 'EXISTS, open';
  if (status === 401) return 'EXISTS, needs auth';
  if (status === 403) return 'EXISTS, insufficient scope';
  if (status === 404) return 'not found';
  if (status === 405) return 'EXISTS, wrong method';
  if (status >= 300 && status < 400) return 'redirect';
  return 'other';
}

console.log(`host ${HOST}  token ${TOKEN ? 'provided' : 'none'}  node ${process.version}`);
console.log('');
console.log('### direct application endpoints');
for (const path of PATHS) {
  // eslint-disable-next-line no-await-in-loop
  const result = await get(path);
  console.log(`${String(result.status ?? 'ERR').padEnd(4)} ${verdict(result.status).padEnd(24)} ${path}`);
  if (result.body) console.log(`     ${result.body}`);
}

console.log('');
console.log('### discovery documents');
for (const path of DISCOVERY) {
  // eslint-disable-next-line no-await-in-loop
  const result = await get(path);
  console.log(`${String(result.status ?? 'ERR').padEnd(4)} ${path}  ${result.contentType || ''}`);
  if (result.body) console.log(`     ${result.body.slice(0, 400)}`);
}
