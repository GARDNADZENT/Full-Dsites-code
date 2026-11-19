/**
 * Second-stage Deriv WebSocket probe: the handshake is refused with "non-101",
 * which means TCP works and something in the HTTP upgrade is being rejected
 * (WAF, origin check, missing header) rather than the network blackholing.
 *
 * This checks, in order:
 *   1. plain HTTPS to the same path, to read the actual status and body
 *   2. WebSocket with no headers (Node's default)
 *   3. WebSocket with a browser-like Origin + User-Agent (the `ws` package)
 *
 * Run: node scripts/deriv-egress-handshake.mjs
 */

import { request } from 'node:https';

const HOST = process.env.PROBE_HOST || 'ws.derivws.com';
const PATH = '/websockets/v3?app_id=1089&l=EN';
const TIMEOUT_MS = 8000;

function httpsProbe() {
  return new Promise(resolve => {
    const started = Date.now();
    const req = request(
      { host: HOST, path: PATH, method: 'GET', headers: { 'User-Agent': 'deriv-egress-handshake/1.0' }, timeout: TIMEOUT_MS },
      res => {
        let body = '';
        res.on('data', chunk => {
          body += chunk;
          if (body.length > 600) res.destroy();
        });
        res.on('end', () =>
          resolve({ ms: Date.now() - started, status: res.statusCode, headers: res.headers, body: body.slice(0, 400) })
        );
      }
    );
    req.on('error', error => resolve({ ms: Date.now() - started, error: String(error?.message || error) }));
    req.on('timeout', () => {
      req.destroy();
      resolve({ ms: Date.now() - started, error: 'timeout' });
    });
    req.end();
  });
}

async function wsProbe({ label, headers, WebSocketImpl }) {
  const url = `wss://${HOST}${PATH}`;
  return new Promise(resolve => {
    const started = Date.now();
    let done = false;
    let socket;
    const finish = result => {
      if (done) return;
      done = true;
      try {
        if (socket) socket.close();
      } catch (_) {
        /* already closed */
      }
      resolve({ label, ms: Date.now() - started, ...result });
    };
    const timer = setTimeout(() => finish({ ok: false, failure: 'timeout' }), TIMEOUT_MS);

    try {
      socket = headers ? new WebSocketImpl(url, { headers }) : new WebSocketImpl(url);
    } catch (error) {
      clearTimeout(timer);
      finish({ ok: false, failure: 'constructor_threw', error: String(error?.message || error) });
      return;
    }

    socket.addEventListener('open', () => {
      try {
        socket.send(JSON.stringify({ ping: 1 }));
      } catch (_) {
        /* timeout covers it */
      }
    });
    socket.addEventListener('message', event => {
      clearTimeout(timer);
      const text = typeof event.data === 'string' ? event.data : String(event.data);
      let parsed = null;
      try {
        parsed = JSON.parse(text);
      } catch (_) {
        parsed = null;
      }
      finish({
        ok: true,
        failure: null,
        note: parsed?.ping || parsed?.msg_type === 'ping' ? 'ping replied' : text.slice(0, 200),
      });
    });
    socket.addEventListener('error', event => {
      clearTimeout(timer);
      const message = event?.message || event?.error?.message || '';
      finish({ ok: false, failure: 'socket_error', error: String(message) });
    });
    socket.addEventListener('close', event => {
      clearTimeout(timer);
      finish({ ok: false, failure: 'closed', code: event?.code, reason: event?.reason || '' });
    });
  });
}

const results = { host: HOST, node: process.version, https: await httpsProbe() };

// Stage 3 needs the `ws` package, which accepts headers; the built-in one does not.
try {
  const { default: WS } = await import('ws');
  results.wsBrowserHeaders = await wsProbe({
    label: 'bare',
    headers: undefined,
    WebSocketImpl: WS,
  });
  results.wsWithOrigin = await wsProbe({
    label: 'origin',
    headers: {
      Origin: 'https://app.deriv.com',
      'User-Agent':
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36',
    },
    WebSocketImpl: WS,
  });
  results.wsBinaryOrigin = await wsProbe({
    label: 'binary-origin',
    headers: { Origin: 'https://app.deriv.com' },
    WebSocketImpl: WS,
  });
} catch (error) {
  results.wsPackageError = String(error?.message || error);
}

console.log(JSON.stringify(results, null, 2));
