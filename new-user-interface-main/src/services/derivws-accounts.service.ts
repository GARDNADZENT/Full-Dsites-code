import { getRuntimeSiteConfig } from '@/config/runtime-site-config';
import { TraderGatewayClient, type DemoTradeInput, type DemoTradeResult, type TraderAccount, type TraderSessionStatus } from '@reef-sites/deriv-auth';
import type { DerivScope } from '@reef-sites/shared-types';

export type DerivAccount = TraderAccount;

/**
 * Browser-safe facade for trader session, account and OTP operations.
 * OAuth bearer/refresh tokens never enter this application. The only persisted
 * values are non-secret account metadata and the selected account identifier.
 */
export class DerivWSAccountsService {
    private static accountsFetchPromise: Promise<DerivAccount[]> | null = null;
    private static otpFetchPromises = new Map<string, Promise<string>>();
    private static gateway: TraderGatewayClient | null = null;

    private static getGateway(): TraderGatewayClient {
        const runtime = getRuntimeSiteConfig();
        if (!runtime?.deriv.gatewayUrl || !runtime.site.id) {
            throw new Error('This site does not have a trader gateway configuration');
        }
        if (!this.gateway) this.gateway = new TraderGatewayClient(runtime.deriv.gatewayUrl, runtime.site.id);
        return this.gateway;
    }

    static clearCache(): void {
        this.accountsFetchPromise = null;
        this.otpFetchPromises.clear();
    }

    static storeAccounts(accounts: DerivAccount[]): void {
        sessionStorage.setItem('deriv_accounts', JSON.stringify(accounts));
    }

    static getStoredAccounts(): DerivAccount[] | null {
        try {
            const value = sessionStorage.getItem('deriv_accounts');
            return value ? (JSON.parse(value) as DerivAccount[]) : null;
        } catch {
            sessionStorage.removeItem('deriv_accounts');
            return null;
        }
    }

    static getDefaultAccount(): DerivAccount | null {
        return this.getStoredAccounts()?.[0] || null;
    }

    static clearStoredAccounts(): void {
        sessionStorage.removeItem('deriv_accounts');
    }

    static async getSession(): Promise<TraderSessionStatus> {
        return this.getGateway().session();
    }

    static async createAuthorizationURL(returnPath = '/', prompt?: 'login' | 'registration'): Promise<string> {
        const runtime = getRuntimeSiteConfig();
        const scopes: DerivScope[] = runtime?.deriv.requiredScopes?.length ? runtime.deriv.requiredScopes : ['trade'];
        const response = await this.getGateway().createAuthorization(scopes, returnPath, prompt);
        return response.authorizationUrl;
    }

    static async fetchAccountsList(): Promise<DerivAccount[]> {
        if (this.accountsFetchPromise) return this.accountsFetchPromise;
        this.accountsFetchPromise = this.getGateway()
            .accounts()
            .then(response => {
                const accounts = Array.isArray(response.data) ? response.data : [];
                this.storeAccounts(accounts);
                return accounts;
            })
            .finally(() => {
                this.accountsFetchPromise = null;
            });
        return this.accountsFetchPromise;
    }

    static async fetchOTPWebSocketURL(accountId: string): Promise<string> {
        const existing = this.otpFetchPromises.get(accountId);
        if (existing) return existing;
        const request = this.getGateway()
            .websocketUrl(accountId)
            .then(response => {
                if (!response.data?.url?.startsWith('wss://api.derivws.com/')) {
                    throw new Error('The trader gateway returned an invalid WebSocket URL');
                }
                return response.data.url;
            })
            .finally(() => this.otpFetchPromises.delete(accountId));
        this.otpFetchPromises.set(accountId, request);
        return request;
    }

    static async getAuthenticatedWebSocketURL(): Promise<string> {
        const session = await this.getSession();
        if (!session.authenticated || !session.scopes.includes('trade')) {
            throw new Error('Reconnect with Deriv trade permission');
        }
        const accounts = this.getStoredAccounts() || (await this.fetchAccountsList());
        if (!accounts.length) throw new Error('No eligible Options accounts are available');
        const selectedId = localStorage.getItem('active_loginid');
        const selected = accounts.find(account => account.account_id === selectedId) || accounts[0];
        localStorage.setItem('active_loginid', selected.account_id);
        localStorage.setItem('account_type', selected.account_type);
        return this.fetchOTPWebSocketURL(selected.account_id);
    }

    /**
     * The demo account this browser is currently trading as, or null.
     *
     * Demo only: this is used to place practice trades, so a real account is never
     * returned even if one is selected. The server re-checks with Deriv and
     * refuses anything it reports as real.
     */
    static getSelectedDemoAccount(): DerivAccount | null {
        const accounts = this.getStoredAccounts() || [];
        const selectedId = localStorage.getItem('active_loginid');
        const selected =
            accounts.find(account => account.account_id === selectedId && account.account_type === 'demo') ||
            accounts.find(account => account.account_type === 'demo') ||
            null;
        return selected;
    }

    /** Place one real contract on the selected demo account. */
    static async placeDemoTrade(input: Omit<DemoTradeInput, 'accountId'>): Promise<DemoTradeResult> {
        const account = this.getSelectedDemoAccount();
        if (!account) {
            throw new Error('No demo account is available in this Deriv session. Switch to a demo account and try again.');
        }
        const response = await this.getGateway().placeDemoTrade({ ...input, accountId: account.account_id });
        return response.data;
    }

    static async logout(): Promise<void> {
        try {
            await this.getGateway().logout();
        } finally {
            this.clearStoredAccounts();
            this.clearCache();
            this.gateway = null;
        }
    }
}
