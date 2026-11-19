import { DerivWSAccountsService } from '@/services/derivws-accounts.service';
import { buildBestBotsFileUrl, generateOAuthURL, getDomainConfigForHost } from '../config';

jest.mock('@/services/derivws-accounts.service');

describe('runtime-only site configuration', () => {
    it('does not expose a hardcoded production hostname configuration', () => {
        expect(getDomainConfigForHost('termicafx.site')).toBeUndefined();
        expect(getDomainConfigForHost('riskmanagers.site')).toBeUndefined();
    });

    it('builds an encoded per-site bot URL', () => {
        expect(buildBestBotsFileUrl('site-id', 'My Bot.xml')).toBe('/site-id/My%20Bot.xml');
    });

    it('gets the authorization URL from the central trader gateway', async () => {
        const authorizationUrl = 'https://auth.deriv.com/oauth2/auth?state=server-generated';
        jest.mocked(DerivWSAccountsService.createAuthorizationURL).mockResolvedValue(authorizationUrl);
        await expect(generateOAuthURL()).resolves.toBe(authorizationUrl);
        expect(DerivWSAccountsService.createAuthorizationURL).toHaveBeenCalledWith('/');
    });

    // Deriv is explicit in its OAuth guide: the login form is shown unless
    // prompt=registration is sent. The header's Sign up button passes
    // 'registration' here, and it previously stopped at this function.
    it('forwards the signup prompt so Deriv shows the registration form', async () => {
        jest.mocked(DerivWSAccountsService.createAuthorizationURL).mockResolvedValue('https://auth.deriv.com/oauth2/auth');
        await generateOAuthURL('registration');
        expect(DerivWSAccountsService.createAuthorizationURL).toHaveBeenCalledWith('/', 'registration');
    });

    it('does not send a prompt for a plain login', async () => {
        jest.mocked(DerivWSAccountsService.createAuthorizationURL).mockResolvedValue('https://auth.deriv.com/oauth2/auth');
        jest.mocked(DerivWSAccountsService.createAuthorizationURL).mockClear();
        await generateOAuthURL();
        // Two arguments would put prompt: undefined on the wire; keep it to one.
        expect(jest.mocked(DerivWSAccountsService.createAuthorizationURL).mock.calls[0]).toEqual(['/']);
    });
});
