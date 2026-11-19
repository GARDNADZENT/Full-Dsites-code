/**
 * Third-stage probe: Deriv's WebSocket endpoint answers through Cloudflare with
 * a 520, which means Cloudflare received the request and its own connection to
 * Deriv's origin failed -- not that this host is blackholed.
 *
 * This narrows it down: is the 520 specific to the WebSocket path, or does every
 * Deriv host return it from a datacenter network? A plain HTTPS status sweep,
 * no WebSocket involved, is enough to tell.
 *
 * Run: node scripts/deriv-egress-sweep.mjs
 */

import { request } from 'node:https';

const TIMEOUT_MS = 12000;

const TARGETS = [
  { host: 'ws.derivws.com', path: '/websockets/v3?app_id=1089' , note: 'WS endpoint, GET (no upgrade)' },
  { host: 'ws.derivws.com', path: '/', note: 'WS host root' },
  { host: 'api.deriv.com', path: '/', note: 'Deriv REST API root' },
  { host: 'api.deriv.com', path: '/trading/v1/options/accounts', note: 'REST, auth required (401 is a pass)' },
  { host: 'developers.deriv.com', path: '/docs/intro/oauth/', note: 'Deriv docs site (CMS/Cloudflare)' },
  { host: 'app.deriv.com', path: '/', note: 'Deriv trading app' },
  { host: 'oauth.deriv.com', path: '/oauth2/authorize?app_id=1089', note: 'OAuth authorize' },
];

function sweep({ host, path }) {
  return new Promise(resolve => {
    const started = Date.now();
    const req = request(
      {
        host,
        path,
        method: 'GET',
        timeout: TIMEOUT_MS,
        headers: {
          'User-Agent':
            'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36',
          Accept: '*/*',
        },
      },
      res => {
        let body = '';
        res.on('data', chunk => {
          body += chunk;
          if (body.length > 400) res.destroy();
        });
        const done = () =>
          resolve({
            host,
            path,
            ms: Date.now() - started,
            status: res.statusCode,
            server: res.headers.server || null,
            cfRay: res.headers['cf-ray'] || null,
            body: body.slice(0, 120).replace(/\s+/g, ' ').trim(),
          });
        res.on('end', done);
        res.on('close', done);
      }
    );
    req.on('error', error => resolve({ host, path, ms: Date.now() - started, error: String(error?.message || error) }));
    req.on('timeout', () => {
      req.destroy();
      resolve({ host, path, ms: Date.now() - started, error: 'timeout' });
    });
    req.end();
  });
}

// Verification targets: prove the login chain now resolves an app for tenants.
// These are read-only GETs against the platform's own public endpoints.
const VERIFY_REQUESTS = [
  {
    host: 'fanrhtqyjajhacrmrbfv.supabase.co',
    path: '/functions/v1/public-site-config?hostname=clinchyderiv1.vercel.app',
    note: 'clinchy public-site-config (expect deriv.appId)',
  },
  {
    host: 'fanrhtqyjajhacrmrbfv.supabase.co',
    path: '/functions/v1/public-site-config?hostname=dtrader-vercel.vercel.app',
    note: 'dtrader public-site-config (expect deriv.appId)',
  },
];

async function checkSiteConfig({ host, path }) {
  return new Promise(resolve => {
    const started = Date.now();
    const req = request(
      { host, path, method: 'GET', timeout: TIMEOUT_MS, headers: { Accept: 'application/json' } },
      res => {
        let body = '';
        res.on('data', chunk => {
          body += chunk;
          if (body.length > 8000) res.destroy();
        });
        res.on('end', () => {
          let summary = null;
          try {
            const parsed = JSON.parse(body);
            const deriv = parsed?.deriv || parsed?.config?.deriv || {};
            summary = {
              status: res.statusCode,
              ms: Date.now() - started,
              deriv: {
                appId: deriv.appId ?? null,
                oauthClientId: deriv.oauthClientId ?? null,
                gatewayUrl: deriv.gatewayUrl ?? null,
                managedByPlatform: deriv.managedByPlatform ?? null,
                markupPercentage: deriv.markupPercentage ?? null,
              },
            };
          } catch (_) {
            summary = { status: res.statusCode, ms: Date.now() - started, body: body.slice(0, 300) };
          }
          resolve(summary);
        });
      }
    );
    req.on('error', error => resolve({ host, path, error: String(error?.message || error) }));
    req.on('timeout', () => {
      req.destroy();
      resolve({ host, path, error: 'timeout' });
    });
    req.end();
  });
}

console.log('');
console.log('### login chain verification');
for (const target of VERIFY_REQUESTS) {
  // eslint-disable-next-line no-await-in-loop
  const result = await checkSiteConfig(target);
  console.log(target.note, '->', JSON.stringify(result));
}

const rows = [];
for (const target of TARGETS) {
  // Sequential: keep timings comparable and the run easy to read.
  // eslint-disable-next-line no-await-in-loop
  const row = await sweep(target);
  rows.push({ ...row, note: target.note });
  console.log(JSON.stringify({ ...row, note: target.note }));
}

const statuses = rows.map(row => row.status).filter(Boolean);
const all520 = statuses.length > 0 && statuses.every(status => status === 520);
console.log('');
console.log('summary');
console.log('  statuses   ', statuses.join(', ') || 'none');
console.log('  all_520    ', all520);
console.log(
  '  reading    ',
  all520
    ? 'Every Deriv host fails at Cloudflare->origin for this client, so the 520 is not specific to the WebSocket path.'
    : 'Some Deriv hosts answer normally, so the 520 is specific to the WebSocket path/origin.'
);
