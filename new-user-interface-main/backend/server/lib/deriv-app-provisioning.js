/**
 * Programmatic Deriv application provisioning.
 *
 * Registers a Deriv app (an OAuth 2.0 client ID) over the WebSocket API using
 * app_register, so a platform operator never has to click through DevHub for
 * each tenant.
 *
 * Why WebSocket and why this file is defensive:
 *
 *  - app_register / app_list / app_update exist ONLY on the WebSocket API.
 *    Every documented REST variant returns 404, so there is no HTTP fallback.
 *  - From Supabase Edge Functions no Deriv WebSocket host is reachable, which
 *    is why provisioning was abandoned as "impossible" and moved to manual
 *    DevHub entry. See scripts/deriv-egress-probe.mjs for the measurement.
 *    From other networks the same connection is reachable, so this code is
 *    written to run anywhere and to report clearly when it cannot connect.
 *  - A Deriv app registered through app_register needs an account with the
 *    `admin` scope. A PAT for that must belong to a PAT-type app; the OAuth
 *    2.0 client ID used for end-user login is a different app, and using it
 *    here fails with "Invalid application".
 *
 * The registration response shape has changed over time (numeric app_id in
 * older docs, alphanumeric OAuth client IDs today), so the result is parsed
 * from several plausible fields rather than assuming one. If none is present
 * the raw response is returned so the caller can see what Deriv actually said
 * instead of guessing.
 */

const DEFAULT_WS_HOSTS = [
    'ws.derivws.com',
    'ws.binaryws.com',
    'frontend.deriv.com',
    'frontend.binaryws.com',
];

const APP_ID_PATTERN = /^[A-Za-z0-9_-]{4,64}$/;

class DerivProvisioningError extends Error {
    constructor(code, message, details = {}) {
        super(message);
        this.name = 'DerivProvisioningError';
        this.code = code;
        this.details = details;
    }
}

/**
 * Open a socket, authorize, send one request, resolve with its reply, close.
 * Resolves { reply, request } or rejects with DerivProvisioningError.
 */
function wsCall({ host, payload, timeoutMs = 15000 }) {
    const url = `wss://${host}/websockets/v3?app_id=1089&l=EN`;

    return new Promise((resolve, reject) => {
        let settled = false;
        let socket;
        let authorised = false;
        let reqId = 0;
        const pending = new Map();

        const cleanup = () => {
            try {
                if (socket) socket.close();
            } catch (_) {
                /* already closed */
            }
        };

        const fail = (code, message, details) => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            cleanup();
            reject(new DerivProvisioningError(code, message, details));
        };

        const succeed = value => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            cleanup();
            resolve(value);
        };

        // The socket is closed after the reply we asked for, so the timeout only
        // has to cover the whole exchange.
        const timer = setTimeout(() => {
            fail('timeout', `Deriv did not answer within ${timeoutMs}ms while calling ${payload.call}`, {
                phase: authorised ? 'authorised' : 'connecting',
                host,
            });
        }, timeoutMs);

        try {
            socket = new WebSocket(url);
        } catch (error) {
            fail('socket_unavailable', `WebSocket is not available in this runtime: ${error?.message || error}`);
            return;
        }

        socket.addEventListener('open', () => {
            reqId += 1;
            pending.set(reqId, 'authorize');
            socket.send(JSON.stringify({ authorize: payload.token, req_id: reqId }));
        });

        socket.addEventListener('error', event => {
            const message = event?.message || event?.error?.message || '';
            const blocked = /non-101|network error|ECONN|ENOTFOUND|ETIMEDOUT|refused/i.test(String(message));
            fail(
                blocked ? 'network_blocked' : 'socket_error',
                blocked
                    ? `Could not connect to ${host}. If this runs on Supabase Edge that is expected: no Deriv WebSocket host is reachable from there.`
                    : `WebSocket error talking to ${host}${message ? `: ${message}` : ''}`,
                { host }
            );
        });

        socket.addEventListener('close', event => {
            if (settled) return;
            fail('socket_closed', `Connection to ${host} closed before a reply arrived`, {
                code: event?.code,
                reason: event?.reason || '',
            });
        });

        socket.addEventListener('message', event => {
            let reply = null;
            try {
                reply = JSON.parse(typeof event.data === 'string' ? event.data : String(event.data));
            } catch (_) {
                return;
            }
            if (!reply) return;

            if (reply.error) {
                const derivCode = reply.error.code;
                const derivMessage = reply.error.message || 'unknown error';
                if (derivCode === 'InvalidToken') {
                    fail('invalid_token', `Deriv rejected the token: ${derivMessage}`, { derivCode });
                    return;
                }
                if (/admin/i.test(derivMessage) || derivCode === 'PermissionDenied') {
                    fail('insufficient_scope', `This token cannot register apps: ${derivMessage}. app_register needs a token with the admin scope on a PAT-type app.`, {
                        derivCode,
                    });
                    return;
                }
                if (/invalid application/i.test(derivMessage)) {
                    fail('invalid_application', `Deriv rejected the app ID this call authenticated under: ${derivMessage}`, { derivCode });
                    return;
                }
                fail('deriv_error', `Deriv returned ${derivCode}: ${derivMessage}`, { derivCode, reply });
                return;
            }

            const what = pending.get(reply.req_id);

            // authorize reply: { authorize: { email, scopes, ... } }
            if (what === 'authorize' || reply.msg_type === 'authorize') {
                authorised = true;
                const scopes = reply.authorize?.scopes || [];
                if (!scopes.includes('admin')) {
                    fail(
                        'insufficient_scope',
                        `The token authorised successfully but does not carry the admin scope (granted: ${
                            scopes.length ? scopes.join(', ') : 'none'
                        }). app_register requires admin.`,
                        { scopes }
                    );
                    return;
                }

                // Authorised and scoped — now do the actual work.
                reqId += 1;
                pending.set(reqId, payload.call);
                const request = { ...payload.body, req_id: reqId };
                request[payload.call] = 1;
                socket.send(JSON.stringify(request));
                return;
            }

            if (what === payload.call || reply.msg_type === payload.call) {
                succeed({ reply, call: payload.call });
            }
        });
    });
}

/**
 * Normalise the app_register reply into { appId, oauthClientId, ... }.
 * Tolerant of shape changes on purpose: the field names have moved around and
 * an unrecognised shape is more useful returned as-is than silently dropped.
 */
function normaliseRegisteredApp(reply) {
    const registered = reply.app_register || reply;
    const candidates = [
        registered.oauth_client_id,
        registered.client_id,
        registered.app_id,
        registered.application_id,
    ].filter(Boolean);

    const appId = candidates.find(candidate => APP_ID_PATTERN.test(String(candidate))) || null;

    return {
        appId,
        // For OAuth 2.0 apps the client ID and the app ID are the same value in
        // current Deriv; kept as a distinct field so callers do not assume it.
        oauthClientId: registered.oauth_client_id || registered.client_id || appId,
        name: registered.name || null,
        redirectUri: registered.redirect_uri || null,
        homepages: registered.homepage ? [registered.homepage] : [],
        scopes: registered.scopes || [],
        verificationUri: registered.verification_uri || null,
        markupPercentage: registered.app_markup_percentage ?? null,
        raw: registered,
    };
}

/**
 * Register a Deriv application.
 *
 * @returns {Promise<{appId: string|null, oauthClientId: string|null, raw: object}>}
 * @throws {DerivProvisioningError} with a `.code` callers can switch on:
 *   network_blocked | timeout | invalid_token | insufficient_scope |
 *   invalid_application | deriv_error | socket_error | socket_closed
 */
async function registerDerivApp({
    token,
    name,
    redirectUri,
    scopes = ['trade', 'account_manage', 'application_read'],
    homepage,
    markupPercentage,
    verificationUri,
    hosts = DEFAULT_WS_HOSTS,
    timeoutMs = 20000,
}) {
    if (!token) throw new DerivProvisioningError('missing_token', 'A Deriv API token with the admin scope is required.');
    if (!name) throw new DerivProvisioningError('missing_name', 'An application name is required.');
    if (!redirectUri) throw new DerivProvisioningError('missing_redirect_uri', 'A redirect URI is required.');

    const body = {
        name,
        redirect_uri: redirectUri,
        scopes: scopes.join(','),
        // 1 = require the user to be authenticated by the app owner, which is
        // what a tenant site wants: traders log in, not anonymous visitors.
        auth_required: 1,
    };
    if (homepage) body.homepage = homepage;
    if (markupPercentage != null) body.app_markup_percentage = String(markupPercentage);
    if (verificationUri) body.verification_uri = verificationUri;

    const attempts = [];

    for (const host of hosts) {
        try {
            // eslint-disable-next-line no-await-in-loop
            const { reply } = await wsCall({ host, payload: { token, call: 'app_register', body }, timeoutMs });
            return { ...normaliseRegisteredApp(reply), host, attempts };
        } catch (error) {
            attempts.push({ host, code: error.code, message: error.message });

            // Only a network problem justifies trying the next host. An auth or
            // validation error will be identical everywhere, so stop and report.
            if (error.code !== 'network_blocked' && error.code !== 'socket_error' && error.code !== 'socket_closed') {
                error.details = { ...error.details, attempts };
                throw error;
            }
        }
    }

    throw new DerivProvisioningError(
        'network_blocked',
        `No Deriv WebSocket host was reachable (tried ${hosts.join(', ')}).`,
        { attempts }
    );
}

/** List apps registered on the account — a cheap way to confirm admin scope works. */
async function listDerivApps({ token, hosts = DEFAULT_WS_HOSTS, timeoutMs = 20000 }) {
    const attempts = [];
    for (const host of hosts) {
        try {
            // eslint-disable-next-line no-await-in-loop
            const { reply } = await wsCall({ host, payload: { token, call: 'app_list', body: {} }, timeoutMs });
            return { apps: reply.app_list || [], host, attempts };
        } catch (error) {
            attempts.push({ host, code: error.code, message: error.message });
            if (error.code !== 'network_blocked' && error.code !== 'socket_error' && error.code !== 'socket_closed') {
                error.details = { ...error.details, attempts };
                throw error;
            }
        }
    }
    throw new DerivProvisioningError('network_blocked', `No Deriv WebSocket host was reachable (tried ${hosts.join(', ')}).`, {
        attempts,
    });
}

module.exports = {
    APP_ID_PATTERN,
    DerivProvisioningError,
    DEFAULT_WS_HOSTS,
    registerDerivApp,
    listDerivApps,
    normaliseRegisteredApp,
};
