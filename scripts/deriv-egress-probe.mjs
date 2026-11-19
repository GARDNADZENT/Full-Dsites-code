/**
 * Deriv WebSocket egress probe.
 *
 * Question: can this host reach Deriv's WebSocket API?
 *
 * Why it matters: app_register / app_list / app_update are WebSocket-only, with
 * no REST equivalent. From Supabase Edge Functions every known Deriv WS host
 * silently blackholes (socket dropped after ~3.5s, no reply). That block is the
 * reason App IDs are still created by hand in DevHub. If other networks can
 * reach WS, provisioning can be automated there instead.
 *
 * A Deriv *error* reply counts as success: it proves the round trip. So no
 * valid App ID or token is required.
 *
 * Run: node scripts/deriv-egress-probe.mjs
 */

const HOSTS = [
  'ws.derivws.com',
  'ws.binaryws.com',
  'frontend.deriv.com',
  'frontend.binaryws.com',
  'api.derivws.com',
];

// Deriv's public demo app ID. Public by design; a rejection is still a result.
const APP_ID = process.env.PROBE_APP_ID || '1089';
const TIMEOUT_MS = Number(process.env.PROBE_TIMEOUT_MS || 8000);

function probe(host) {
  const url = `wss://${host}/websockets/v3?app_id=${encodeURIComponent(APP_ID)}&l=EN`;

  return new Promise(resolve => {
    const started = Date.now();
    let done = false;
    let phase = 'connecting';
    let ws;
    let messages = 0;
    let raw = '';

    const finish = result => {
      if (done) return;
      done = true;
      try {
        if (ws) ws.close();
      } catch (_) {
        /* already closed */
      }
      resolve({ host, ms: Date.now() - started, messages, phase, ...result });
    };

    const timer = setTimeout(() => finish({ ok: false, failure: 'timeout' }), TIMEOUT_MS);

    try {
      ws = new WebSocket(url);
    } catch (error) {
      clearTimeout(timer);
      finish({ ok: false, failure: 'constructor_threw', error: String(error?.message || error) });
      return;
    }

    ws.addEventListener('open', () => {
      phase = 'open';
      try {
        ws.send(JSON.stringify({ ping: 1 }));
      } catch (_) {
        /* handled by the timeout */
      }
    });

    ws.addEventListener('message', event => {
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
        finish({ ok: true, failure: null, note: 'ping replied — round trip works' });
        return;
      }
      if (parsed.error) {
        clearTimeout(timer);
        finish({ ok: true, failure: null, note: `${parsed.error.code} ${parsed.error.message}` });
      }
    });

    ws.addEventListener('error', () => {
      clearTimeout(timer);
      finish({ ok: false, failure: 'socket_error' });
    });

    ws.addEventListener('close', event => {
      clearTimeout(timer);
      finish({
        ok: false,
        failure: 'closed_before_reply',
        code: event?.code,
        reason: event?.reason || '',
        body: raw.slice(0, 200),
      });
    });
  });
}

const results = [];
for (const host of HOSTS) {
  // Sequential on purpose: a blocking host must not skew the others' timings.
  // eslint-disable-next-line no-await-in-loop
  results.push(await probe(host));
}

const anyOk = results.some(result => result.ok);

console.log('node      ', process.version);
console.log('app_id    ', APP_ID);
console.log('verdict   ', anyOk ? 'egress_open' : 'egress_blocked');
console.log('');
for (const result of results) {
  console.log(JSON.stringify(result));
}

process.exit(anyOk ? 0 : 0);
