/**
 * Try every WebSocket endpoint Deriv is known to expose.
 *
 * Context: `app_register` is WebSocket-only, and the host the legacy docs name
 * (ws.derivws.com) answers Cloudflare 520 from datacenter networks. But the
 * platform is mid-migration, and this codebase already references other sockets
 * on the NEW base host:
 *
 *   wss://api.derivws.com/socket
 *   wss://api.derivws.com/trading/v1/options/ws/public
 *
 * HTTPS on api.derivws.com works from the same networks (401 on a protected
 * route, not a 520), so a WebSocket there may well work too. If any candidate
 * completes a handshake, `app_register` becomes possible again and provisioning
 * can be automatic -- so this is worth measuring rather than assuming.
 *
 * Run: node scripts/deriv-ws-candidates.mjs
 */

const APP_ID = process.env.PROBE_APP_ID || '1089';
const TIMEOUT_MS = Number(process.env.PROBE_TIMEOUT_MS || 8000);

const CANDIDATES = [
  // New platform base host, socket paths already used by this codebase.
  { url: 'wss://api.derivws.com/socket', note: 'new: api socket' },
  { url: 'wss://api.derivws.com/trading/v1/options/ws/public', note: 'new: options ws public' },
  { url: 'wss://api.derivws.com/websockets/v3', note: 'new host, legacy path' },
  { url: `wss://api.derivws.com/websockets/v3?app_id=${APP_ID}`, note: 'new host, legacy path + app_id' },
  // Legacy hosts, for comparison in the same run.
  { url: `wss://ws.derivws.com/websockets/v3?app_id=${APP_ID}`, note: 'legacy ws host' },
  { url: `wss://ws.binaryws.com/websockets/v3?app_id=${APP_ID}`, note: 'legacy binaryws host' },
  { url: `wss://frontend.deriv.com/websockets/v3?app_id=${APP_ID}`, note: 'legacy frontend.deriv.com' },
];

function probe(entry) {
  return new Promise(resolve => {
    const started = Date.now();
    let done = false;
    let socket;
    let messages = 0;
    let raw = '';

    const finish = result => {
      if (done) return;
      done = true;
      try {
        if (socket) socket.close();
      } catch (_) {
        /* already closed */
      }
      resolve({ ...entry, ms: Date.now() - started, messages, ...result });
    };

    const timer = setTimeout(() => finish({ ok: false, failure: 'timeout' }), TIMEOUT_MS);

    try {
      socket = new WebSocket(entry.url);
    } catch (error) {
      clearTimeout(timer);
      finish({ ok: false, failure: 'constructor_threw', error: String(error?.message || error) });
      return;
    }

    socket.addEventListener('open', () => {
      try {
        // Legacy methods use a one-key request object; ping is the cheapest.
        socket.send(JSON.stringify({ ping: 1 }));
      } catch (_) {
        /* timeout covers it */
      }
    });

    socket.addEventListener('message', event => {
      messages += 1;
      const text = typeof event.data === 'string' ? event.data : String(event.data);
      raw += text;
      let parsed = null;
      try {
        parsed = JSON.parse(text);
      } catch (_) {
        parsed = null;
      }
      if (!parsed) return;
      if (parsed.ping || parsed.msg_type === 'ping') {
        clearTimeout(timer);
        finish({ ok: true, failure: null, note: 'ping replied — legacy protocol works here' });
        return;
      }
      if (parsed.error) {
        clearTimeout(timer);
        finish({ ok: true, failure: null, note: `answered: ${parsed.error.code} ${parsed.error.message}` });
        return;
      }
      // Unknown-but-real traffic still proves the socket is live.
      clearTimeout(timer);
      finish({ ok: true, failure: null, note: `reply: ${text.slice(0, 120)}` });
    });

    socket.addEventListener('error', event => {
      clearTimeout(timer);
      const message = event?.message || event?.error?.message || '';
      finish({ ok: false, failure: 'socket_error', error: String(message) });
    });

    socket.addEventListener('close', event => {
      clearTimeout(timer);
      finish({ ok: false, failure: 'closed', code: event?.code, reason: event?.reason || '', body: raw.slice(0, 120) });
    });
  });
}

const results = [];
for (const candidate of CANDIDATES) {
  // Sequential: keep timings comparable and the log easy to read.
  // eslint-disable-next-line no-await-in-loop
  const result = await probe(candidate);
  results.push(result);
  const status = result.ok ? 'OPEN ' : 'fail ';
  console.log(`${status} ${candidate.note.padEnd(28)} ${candidate.url}`);
  console.log(`      ${JSON.stringify({ ...result, url: undefined, note: undefined })}`);
}

const winners = results.filter(result => result.ok);
console.log('');
console.log('summary');
console.log('  reachable  ', winners.length ? winners.map(w => `${w.note} (${w.url})`).join('; ') : 'none');
console.log(
  '  reading    ',
  winners.length
    ? 'At least one WebSocket works, so app_register can run server-side against it.'
    : 'No Deriv WebSocket works from this network on any host, new or legacy.'
);
