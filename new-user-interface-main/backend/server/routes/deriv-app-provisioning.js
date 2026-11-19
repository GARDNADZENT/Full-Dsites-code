/**
 * Programmatic Deriv app provisioning for the platform operator.
 *
 * The admin UI used to say automatic creation was impossible. It is not
 * impossible; it was unreachable from Supabase Edge. This endpoint performs the
 * registration server-side, so no Deriv token is ever handled in React.
 *
 * Auth: PLATFORM_ADMIN_TOKEN (server-side only). Both routes require it, because
 * they act with the operator's Deriv credentials.
 *
 *   GET  /api/deriv-app-provisioning/apps
 *     Lists apps on the authorized account. Also the cheapest way to prove the
 *     token has admin scope, since app_list needs only Read but a wrong app
 *     type fails here too.
 *
 *   POST /api/deriv-app-provisioning/apps
 *     { siteId?, name, redirectUri, scopes?, homepage?, markupPercentage? }
 *     Registers an app and returns its app_id / oauth_client_id.
 *
 * The Deriv token is supplied per request from the server-side store, never
 * from the browser. Results are not persisted here: the caller writes the app
 * into platform_deriv_apps so a failure halfway cannot leave a half-bound site.
 */

const express = require('express');
const { registerDerivApp, listDerivApps, DerivProvisioningError } = require('../lib/deriv-app-provisioning');

const router = express.Router();

function requireAdminToken(req, res, next) {
    const expected = process.env.PLATFORM_ADMIN_TOKEN;
    if (!expected) {
        res.status(503).json({
            error: 'provisioning_not_configured',
            message: 'PLATFORM_ADMIN_TOKEN is not set on this deployment, so provisioning is disabled.',
        });
        return;
    }
    const supplied = req.get('x-platform-admin-token') || '';
    if (supplied !== expected) {
        res.status(401).json({ error: 'unauthorized' });
        return;
    }
    next();
}

/** The Deriv token with admin scope. Read from env so it never leaves the server. */
function resolveDerivToken() {
    return process.env.DERIV_ADMIN_API_TOKEN || process.env.DERIV_SUPERUSER_TOKEN || null;
}

function sendProvisioningError(res, error) {
    if (error instanceof DerivProvisioningError) {
        // 503 for "this network cannot reach Deriv" so the caller knows it is an
        // infrastructure limit, not a bad request.
        const status = error.code === 'network_blocked' ? 503 : error.code === 'missing_token' ? 500 : 400;
        res.status(status).json({
            error: error.code,
            message: error.message,
            details: error.details || {},
        });
        return;
    }
    res.status(500).json({ error: 'unexpected_error', message: error?.message || String(error) });
}

router.use(requireAdminToken);

router.get('/apps', async (_req, res) => {
    const token = resolveDerivToken();
    if (!token) {
        res.status(503).json({
            error: 'deriv_token_missing',
            message: 'No Deriv admin token is configured (DERIV_ADMIN_API_TOKEN).',
        });
        return;
    }

    try {
        const result = await listDerivApps({ token });
        res.json({
            host: result.host,
            count: result.apps.length,
            apps: result.apps.map(app => ({
                appId: app.app_id,
                name: app.name,
                redirectUri: app.redirect_uri,
                scopes: app.scopes,
            })),
        });
    } catch (error) {
        sendProvisioningError(res, error);
    }
});

router.post('/apps', async (req, res) => {
    const token = resolveDerivToken();
    if (!token) {
        res.status(503).json({
            error: 'deriv_token_missing',
            message: 'No Deriv admin token is configured (DERIV_ADMIN_API_TOKEN).',
        });
        return;
    }

    const { name, redirectUri, scopes, homepage, markupPercentage } = req.body || {};
    if (!name || !redirectUri) {
        res.status(400).json({ error: 'missing_fields', message: 'name and redirectUri are required.' });
        return;
    }

    try {
        const app = await registerDerivApp({
            token,
            name: String(name).slice(0, 64),
            redirectUri: String(redirectUri),
            scopes: Array.isArray(scopes) && scopes.length ? scopes : undefined,
            homepage: homepage ? String(homepage) : undefined,
            markupPercentage,
        });

        res.status(201).json({
            host: app.host,
            // appId is what goes into Deriv-App-ID / client_id. Null here means
            // Deriv answered in a shape we do not recognise: raw is returned so
            // the actual payload is visible rather than guessed at.
            appId: app.appId,
            oauthClientId: app.oauthClientId,
            name: app.name,
            redirectUri: app.redirectUri,
            scopes: app.scopes,
            verificationUri: app.verificationUri,
            raw: app.appId ? undefined : app.raw,
        });
    } catch (error) {
        sendProvisioningError(res, error);
    }
});

module.exports = router;
