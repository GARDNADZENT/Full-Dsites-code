/**
 * Which methods does the reachable Deriv WebSocket serve?
 *
 * wss://api.derivws.com/trading/v1/options/ws/public completes a handshake from
 * datacenter networks and answers `ping`. The legacy hosts (ws.derivws.com,
 * ws.binaryws.com) return Cloudflare 520 from the same network, so this is the
 * only socket available server-side.
 *
 * The question that decides whether provisioning can be automated: does this
 * endpoint route the application methods (app_register / app_list / app_update)?
 *
 * It can be answered without any credential. Send each method and read the
 * error:
 *   "AuthorizationRequired" / "InvalidToken" -> the method is ROUTED, just gated
 *   "UnknownMethod" / "Unrecognised request"  -> the method does not exist here
 * A deliberately bogus method is included as the control that produces the
 * unknown-method wording for comparison.
 *
 * Run: node scripts/deriv-ws-methods.mjs
 */

const URL_WS = process.env.PROBE_WS_URL || 'wss://api.derivws.com/trading/v1/options/ws/public';
const TIMEOUT_MS = Number(process.env.PROBE_TIMEOUT_MS || 8000);

const REQUESTS = [
  { label: 'control: ping', payload: { ping: 1 } },
  { label: 'control: bogus method', payload: { this_method_does_not_exist: 1 } },
  { label: 'authorize (invalid token)', payload: { authorize: 'invalid-token-for-probe' } },
  { label: 'app_list (no auth)', payload: { app_list: 1 } },
  { label: 'app_register (no auth)', payload: { app_register: 1, name: 'probe', redirect_uri: 'https://example.com/cb' } },
  { label: 'app_update (no auth)', payload: { app_update: 1 } },
  { label: 'app_get (no auth)', payload: { app_get: 1 } },
  { label: 'balance (no auth)', payload: { balance: 1 } },
  { label: 'active_symbols (public)', payload: { active_symbols: 'brief' } },
];

function ask(payload) {
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
      resolve({ ms: Date.now() - started, ...result });
    };

    const timer = setTimeout(() => finish({ reply: null, note: 'timeout, no reply' }), TIMEOUT_MS);

    try {
      socket = new WebSocket(URL_WS);
    } catch (error) {
      clearTimeout(timer);
      finish({ reply: null, note: `constructor threw: ${error?.message || error}` });
      return;
    }

    socket.addEventListener('open', () => {
      try {
        socket.send(JSON.stringify(payload));
      } catch (error) {
        clearTimeout(timer);
        finish({ reply: null, note: `send threw: ${error?.message || error}` });
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
      if (!parsed) {
        finish({ reply: null, note: `non-JSON reply: ${text.slice(0, 120)}` });
        return;
      }
      // Prefer the error, which is what this probe is reading.
      finish({
        reply: parsed,
        note: parsed.error
          ? `${parsed.error.code}: ${parsed.error.message}`
          : `ok, keys: ${Object.keys(parsed).join(',')}`,
      });
    });

    socket.addEventListener('error', event => {
      clearTimeout(timer);
      finish({ reply: null, note: `socket error: ${event?.message || event?.error?.message || 'unknown'}` });
    });

    socket.addEventListener('close', () => {
      // Resolved by the message handler in the normal case.
      finish({ reply: null, note: 'closed without reply' });
    });
  });
}

console.log('endpoint', URL_WS);
console.log('');

const rows = [];
for (const request of REQUESTS) {
  // Sequential: the endpoint is a shared public socket, so keep it gentle.
  // eslint-disable-next-line no-await-in-loop
  const result = await ask(request.payload);
  rows.push({ label: request.label, ...result });
  console.log(`${request.label.padEnd(28)} ${result.ms}ms  ${result.note}`);
}

console.log('');
console.log('### verdict');
const bogus = rows.find(row => row.label === 'control: bogus method');
const bogusCode = bogus?.reply?.error?.code || 'none';
const routed = rows.filter(
  row => row.label.startsWith('app_') && row.reply?.error && row.reply.error.code !== bogusCode
);

console.log(`  unknown-method wording from control: ${bogusCode}`);
for (const label of ['app_list', 'app_register', 'app_update', 'app_get', 'authorize']) {
  const row = rows.find(r => r.label.startsWith(label));
  const code = row?.reply?.error?.code || (row?.reply ? 'no error' : 'no reply');
  const exists = code !== bogusCode && code !== 'no reply';
  console.log(`  ${label.padEnd(14)} ${String(code).padEnd(26)} ${exists ? 'ROUTED here' : 'not available'}`);
}
console.log('');
console.log(
  routed.length
    ? '  Application methods are routed on this endpoint; they are gated by auth/scope, not by routing.'
    : '  Application methods are not routed on this endpoint.'
);
