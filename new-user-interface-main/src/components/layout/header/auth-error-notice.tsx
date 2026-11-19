import { useEffect, useState } from 'react';

/**
 * Explains a failed Deriv login on the page the trader comes back to.
 *
 * When the OAuth callback redirects with `auth_error`, nothing else reads it, so
 * a rejected login looked identical to a trader who simply never signed in. That
 * left the operator reading Deriv's own error page to guess what happened.
 *
 * The callback now also returns `redirect_uri_not_registered`, which is a
 * configuration problem rather than anything the trader did, so the wording
 * deliberately avoids implying they made a mistake.
 */

type Failure = {
    title: string;
    detail: string;
    actionable: boolean;
};

const FAILURES: Record<string, Failure> = {
    redirect_uri_not_registered: {
        title: 'This site’s Deriv login is not registered yet',
        detail:
            'Deriv rejected the login because the site’s callback address is not verified on its Deriv application. The site operator needs to finish registering it; trying again will not help until then.',
        actionable: false,
    },
    // Deriv's own code, propagated verbatim by the callback: it refuses the
    // authorization request outright, before issuing a code. This is transient in
    // practice -- plausible logins on the same application succeed minutes apart
    // -- so it is not reported as a permanent misconfiguration.
    request_forbidden: {
        title: 'Deriv refused this login',
        detail:
            'Deriv declined the sign-in request before issuing a credential. Trying again usually works; if it keeps happening, the site operator needs to check the Deriv application.',
        actionable: true,
    },
    invalid_request: {
        title: 'Deriv rejected this site’s login request',
        detail:
            'Deriv could not accept the request as sent, typically because the site’s callback address is not accepted by its Deriv application. The site operator needs to correct it.',
        actionable: false,
    },
    token_exchange_failed: {
        title: 'Deriv could not complete the sign-in',
        detail:
            'Deriv approved the login but the last step did not finish, usually because the sign-in link had already been used or expired. Please try again.',
        actionable: true,
    },
    required_scope_missing: {
        title: 'This site needs extra permission',
        detail:
            'The login succeeded but Deriv did not grant every permission this site needs. The site operator needs to add the missing permission to the Deriv application.',
        actionable: false,
    },
    login_cancelled: {
        title: 'Sign-in was cancelled',
        detail: 'You closed or cancelled the Deriv sign-in. You can try again whenever you are ready.',
        actionable: true,
    },
    access_denied: {
        title: 'Sign-in was declined',
        detail: 'The Deriv sign-in was declined, so this site was not given access. You can try again.',
        actionable: true,
    },
    code_missing: {
        title: 'Deriv did not return a sign-in',
        detail: 'The reply from Deriv had no authorization code. Please start the login again.',
        actionable: true,
    },
    callback_replayed: {
        title: 'This sign-in link was already used',
        detail: 'Each sign-in link works once. Please start the login again.',
        actionable: true,
    },
    handoff_failed: {
        title: 'Could not finish the sign-in on this site',
        detail: 'Deriv signed you in but the session could not be set up here. Please log in again.',
        actionable: true,
    },
    // The session was created centrally, then handed to this domain to become a
    // first-party cookie. If that hop is refused the trader is signed in on the
    // platform but not here, which is worth saying plainly.
    handoff_host_mismatch: {
        title: 'Signed in, but not on this address',
        detail:
            'Deriv approved the login, but this site could not accept the session on the address you used. Open the site on its main domain and try again.',
        actionable: true,
    },
};

const AuthErrorNotice = () => {
    const [failure, setFailure] = useState<Failure | null>(null);
    const [dismissed, setDismissed] = useState(false);

    useEffect(() => {
        if (typeof window === 'undefined') return;
        const params = new URLSearchParams(window.location.search);
        const code = params.get('auth_error');
        if (!code) return;

        setFailure(FAILURES[code] ?? null);

        // Drop the parameter so a refresh, or a shared link, does not keep
        // showing a stale error that has already been handled.
        params.delete('auth_error');
        params.delete('correlation_id');
        const query = params.toString();
        const nextUrl = `${window.location.pathname}${query ? `?${query}` : ''}${window.location.hash}`;
        window.history.replaceState({}, '', nextUrl);
    }, []);

    if (!failure || dismissed) return null;

    return (
        <div className='auth-error-notice' role='alert'>
            <div className='auth-error-notice__content'>
                <p className='auth-error-notice__title'>{failure.title}</p>
                <p className='auth-error-notice__detail'>{failure.detail}</p>
            </div>
            <button
                type='button'
                className='auth-error-notice__dismiss'
                onClick={() => setDismissed(true)}
                aria-label='Dismiss'
            >
                ×
            </button>
        </div>
    );
};

export default AuthErrorNotice;
