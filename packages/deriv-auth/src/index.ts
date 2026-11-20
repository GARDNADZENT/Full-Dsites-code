import type { DerivFeature, DerivScope } from '@reef-sites/shared-types';

export const DERIV_AUTHORIZATION_URL = 'https://auth.deriv.com/oauth2/auth';
export const DERIV_API_BASE_URL = 'https://api.derivws.com';
export const DERIV_PUBLIC_OPTIONS_WS = 'wss://api.derivws.com/trading/v1/options/ws/public';

export interface ScopeRequirement {
    feature: DerivFeature;
    requiredScopes: DerivScope[];
    reason: string;
}

export const SCOPE_REGISTRY: Readonly<Record<DerivFeature, ScopeRequirement>> = {
    public_market_data: {
        feature: 'public_market_data',
        requiredScopes: [],
        reason: 'Public price and market streams do not require trader authorization.',
    },
    account_list: {
        feature: 'account_list',
        requiredScopes: ['trade'],
        reason: 'Deriv requires trade permission to list eligible Options accounts.',
    },
    options_trading: {
        feature: 'options_trading',
        requiredScopes: ['trade'],
        reason: 'Trade permission is required to create an authenticated Options WebSocket session and trade.',
    },
    account_creation: {
        feature: 'account_creation',
        requiredScopes: ['account_manage'],
        reason: 'Account management permission is required to create or manage an Options account.',
    },
    wallet_balances: {
        feature: 'wallet_balances',
        requiredScopes: ['payment'],
        reason: 'Payment permission is required for wallet data.',
    },
    wallet_transactions: {
        feature: 'wallet_transactions',
        requiredScopes: ['payment'],
        reason: 'Payment permission is required for wallet transaction data.',
    },
    markup_statistics: {
        feature: 'markup_statistics',
        requiredScopes: ['application_read'],
        reason: 'Application read permission is required to view registered-application markup statistics.',
    },
    application_management: {
        feature: 'application_management',
        requiredScopes: ['application_read'],
        reason: 'Application read permission is required to inspect registered application metadata.',
    },
};

export function requiredScopesForFeatures(features: Iterable<DerivFeature>): DerivScope[] {
    const scopes = new Set<DerivScope>();
    for (const feature of features) {
        for (const scope of SCOPE_REGISTRY[feature].requiredScopes) scopes.add(scope);
    }
    return [...scopes].sort();
}

export function missingScopes(granted: Iterable<string>, required: Iterable<DerivScope>): DerivScope[] {
    const grantedSet = new Set(granted);
    return [...required].filter(scope => !grantedSet.has(scope));
}

export type TraderSessionStatus = {
    authenticated: boolean;
    siteId: string;
    scopes: DerivScope[];
    expiresAt?: string;
    csrfToken?: string;
};

export type TraderAccount = {
    account_id: string;
    balance: number | string;
    currency: string;
    group: string;
    status: string;
    account_type: 'demo' | 'real';
};

export type DemoTradeInput = {
    accountId: string;
    symbol?: string;
    contractType?: string;
    stake?: number;
    duration?: number;
    durationUnit?: string;
    currency?: string;
    barrier?: string;
};

export type DemoTradeResult = {
    contractId: string;
    accountId: string;
    accountType: 'demo';
    symbol: string;
    contractType: string;
    buyPrice: number;
    payout: number;
    balanceAfter: number | null;
    startTime: string | null;
    /** 'allocated' means the per-tenant amount is ours, not Deriv-reported. */
    markupBasis: 'allocated';
    ledger: {
        recorded: boolean;
        ledgerId: string | null;
        siteName: string;
        grossMarkup: number;
        platformFee: number;
        ownerNet: number;
        markupRate: number;
        markupBasis: 'allocated';
        truncatedToZero: boolean;
        payable: false;
    };
};

export class TraderGatewayClient {
    private csrfToken: string | null = null;

    constructor(private readonly gatewayUrl: string, private readonly siteId: string) {}

    private async request<T>(path: string, init?: RequestInit): Promise<T> {
        const response = await fetch(`${this.gatewayUrl.replace(/\/$/, '')}${path}`, {
            ...init,
            credentials: 'include',
            headers: {
                'Content-Type': 'application/json',
                'X-Reef-Site-ID': this.siteId,
                ...(init?.headers || {}),
            },
        });
        const body = await response.json().catch(() => ({}));
        if (!response.ok) {
            const error = new Error(body?.error?.message || body?.error || 'Trader gateway request failed');
            Object.assign(error, { code: body?.error?.code, status: response.status, correlationId: body?.correlationId });
            throw error;
        }
        return body as T;
    }

    async createAuthorization(
        scopes: DerivScope[],
        returnPath = '/',
        prompt?: 'login' | 'registration'
    ): Promise<{ authorizationUrl: string }> {
        return this.request('/deriv-oauth-start', {
            method: 'POST',
            body: JSON.stringify({ siteId: this.siteId, scopes, returnPath, ...(prompt ? { prompt } : {}) }),
        });
    }

    async session(): Promise<TraderSessionStatus> {
        const status = await this.request<TraderSessionStatus>('/deriv-trader-session', { method: 'GET' });
        this.csrfToken = status.csrfToken || null;
        return status;
    }

    async accounts(): Promise<{ data: TraderAccount[] }> {
        return this.request('/deriv-trader-accounts', { method: 'GET' });
    }

    async websocketUrl(accountId: string): Promise<{ data: { url: string } }> {
        if (!this.csrfToken) await this.session();
        return this.request('/deriv-trader-otp', {
            method: 'POST',
            headers: { 'X-CSRF-Token': this.csrfToken || '' },
            body: JSON.stringify({ accountId }),
        });
    }

    /**
     * Place one real contract on a DEMO account and record it for the tenant.
     *
     * The server refuses any account Deriv reports as non-demo, so this cannot be
     * used to trade real money even by mistake. The response says the per-tenant
     * markup is 'allocated' rather than Deriv-reported, because both tenants share
     * one Deriv app and Deriv pays app markup per application.
     */
    async placeDemoTrade(input: DemoTradeInput): Promise<{ data: DemoTradeResult; correlationId: string }> {
        if (!this.csrfToken) await this.session();
        return this.request('/deriv-demo-trade', {
            method: 'POST',
            headers: { 'X-CSRF-Token': this.csrfToken || '' },
            body: JSON.stringify(input),
        });
    }

    async logout(): Promise<void> {
        if (!this.csrfToken) await this.session();
        await this.request('/deriv-trader-session', {
            method: 'DELETE',
            headers: { 'X-CSRF-Token': this.csrfToken || '' },
        });
        this.csrfToken = null;
    }
}
