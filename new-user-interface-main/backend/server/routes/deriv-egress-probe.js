/**
 * Deriv egress probe (diagnostic).
 *
 * One question only: can a Vercel serverless function open a connection to
 * Deriv's WebSocket API and complete a request/response round trip?
 *
 * Why it exists: every Deriv WebSocket host silently blackholes from Supabase
 * Edge Functions (the socket is dropped after ~3.5s and no reply ever arrives).
 * That is the block that forced manual App ID creation in DevHub, because
 * app_register / app_list / app_update are WebSocket-only methods with no REST
 * equivalent. If Vercel's egress is not blocked, app provisioning can move here
 * and become fully automatic; if it is blocked too, that idea is dead and we
 * stop guessing.
 *
 * It deliberately does NOT require a valid App ID or token. Deriv replying
 * "Invalid application" or "InvalidToken" is a *success* for this probe: it
 * proves the round trip works, which is the entire point.
 *
 * GET /api/deriv-egress-probe
 *   ?appId=...       optional; defaults to 1089 (Deriv's public demo app)
 *   ?token=...       optional; if given, app_list is attempted after ping
 *   ?host=...        optional; probe a single host instead of all
 *   ?timeoutMs=6000  optional; 1000..15000 per host
 *
 * Nothing sensitive is stored or logged. The token, if supplied, is only ever
 * sent to Deriv over the socket and is not echoed back in the response.
 */

const express = require('express');

const router = express.Router();

const HOSTS = [
    'ws.derivws.com',
    'ws.binaryws.com',
    'frontend.deriv.com',
    'frontend.binaryws.com',
    'api.derivws.com',
];

const DEMO_APP_ID = '1089';

function probeHost(host, { appId, token }, timeoutMs) {
    const url = `wss://${host}/websockets/v3?app_id=${encodeURIComponent(appId)}&l=EN`;

    return new Promise(resolve => {
        const started = Date.now();
        let settled = false;
        let socket;
        let phase = 'connecting';
        let messages = 0;

        const finish = result => {
            if (settled) return;
            settled = true;
            try {
                if (socket) socket.close();
            } catch (_) {
                /* already gone */
            }
            resolve({ host, elapsedMs: Date.now() - started, messages, ...result });
        };

        const timer = setTimeout(() => {
            finish({
                ok: false,
                failure: 'timeout',
                phase,
                note:
                    phase === 'connecting'
                        ? 'Never reached OPEN. Same silent blackhole Supabase Edge hits.'
                        : 'Connected but Deriv never replied to ping.',
            });
        }, timeoutMs);

        try {
            socket = new WebSocket(url);
        } catch (error) {
            clearTimeout(timer);
            finish({ ok: false, failure: 'constructor_threw', error: String(error?.message || error) });
            return;
        }

        socket.addEventListener('open', () => {
            phase = 'open';
            try {
                socket.send(JSON.stringify({ ping: 1 }));
            } catch (error) {
                clearTimeout(timer);
                finish({ ok: false, failure: 'send_threw', phase, error: String(error?.message || error) });
            }
        });

        socket.addEventListener('message', event => {
            messages += 1;
            const text = typeof event.data === 'string' ? event.data : String(event.data);
            let parsed = null;
            try {
                parsed = JSON.parse(text);
            } catch (_) {
                parsed = null;
            }
            if (!parsed) return;

            // The ping reply is the handshake. If a token was supplied, follow up
            // with app_list so the probe exercises a scoped call, not just ping.
            if (parsed.ping || parsed.msg_type === 'ping') {
                if (token) {
                    try {
                        socket.send(JSON.stringify({ app_list: 1, req_id: 99 }));
                        phase = 'app_list_sent';
                    } catch (error) {
                        clearTimeout(timer);
                        finish({ ok: true, failure: null, phase, error: String(error?.message || error) });
                    }
                    return;
                }
                clearTimeout(timer);
                finish({ ok: true, failure: null, phase: 'ping_ok', note: 'Handshake completed. Round trip works.' });
                return;
            }

            if (parsed.req_id === 99 || parsed.msg_type === 'app_list') {
                clearTimeout(timer);
                finish({
                    ok: true,
                    failure: null,
                    phase: 'app_list_replied',
                    note: parsed.error
                        ? `app_list rejected: ${parsed.error.code} ${parsed.error.message}`
                        : 'app_list succeeded.',
                    applications: Array.isArray(parsed.app_list)
                        ? parsed.app_list.map(app => ({ app_id: app.app_id, name: app.name }))
                        : undefined,
                });
                return;
            }

            if (parsed.error) {
                clearTimeout(timer);
                finish({
                    ok: true,
                    failure: null,
                    phase: 'error_reply',
                    note: `Deriv answered with an error, which still proves the path: ${parsed.error.code} ${parsed.error.message}`,
                });
            }
        });

        socket.addEventListener('error', () => {
            clearTimeout(timer);
            finish({
                ok: false,
                failure: 'socket_error',
                phase,
                note:
                    phase === 'connecting'
                        ? 'Connection refused/dropped during handshake - same class of block as Supabase.'
                        : 'Socket errored after opening.',
            });
        });

        socket.addEventListener('close', event => {
            clearTimeout(timer);
            finish({
                ok: false,
                failure: 'closed_before_reply',
                phase,
                code: event?.code,
                reason: event?.reason || '',
                note: 'Socket closed without a usable reply.',
            });
        });
    });
}

router.get('/', async (req, res) => {
    const appId = String(req.query.appId || DEMO_APP_ID).slice(0, 64);
    const token = req.query.token ? String(req.query.token).slice(0, 200) : null;
    const timeoutMs = Math.min(Math.max(Number(req.query.timeoutMs) || 6000, 1000), 15000);
    const hosts = req.query.host ? [String(req.query.host)] : HOSTS;

    const results = [];
    // Sequential on purpose: one blocking host must not distort the timings of
    // the others, and this keeps total runtime bounded and predictable.
    for (const host of hosts) {
        // eslint-disable-next-line no-await-in-loop
        const result = await probeHost(host, { appId, token }, timeoutMs);
        results.push(result);
    }

    const anyOk = results.some(result => result.ok);

    res.json({
        verdict: anyOk ? 'egress_open' : 'egress_blocked',
        meaning: anyOk
            ? 'At least one Deriv WS host answered from Vercel. app provisioning can run server-side here.'
            : 'No Deriv WS host answered from Vercel either. The block is broader than Supabase Edge.',
        appIdUsed: appId,
        tokenProvided: Boolean(token),
        node: process.version,
        region: process.env.VERCEL_REGION || null,
        results,
    });
});

module.exports = router;
