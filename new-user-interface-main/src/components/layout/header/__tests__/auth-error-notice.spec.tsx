import { render, screen } from '@testing-library/react';
import AuthErrorNotice from '../auth-error-notice';

const setUrl = (search: string) => {
    window.history.replaceState({}, '', `/${search}`);
};

describe('AuthErrorNotice', () => {
    afterEach(() => {
        setUrl('');
    });

    it('shows nothing when the callback reported no error', () => {
        setUrl('?auth=connected');
        const { container } = render(<AuthErrorNotice />);
        expect(container).toBeEmptyDOMElement();
    });

    it('explains a redirect URI rejection as a site configuration problem', () => {
        setUrl('?auth_error=redirect_uri_not_registered&correlation_id=abc');
        render(<AuthErrorNotice />);
        expect(screen.getByRole('alert')).toHaveTextContent('not registered yet');
        // The trader cannot fix this, so the wording must not blame them.
        expect(screen.getByRole('alert')).toHaveTextContent('operator needs to finish registering it');
    });

    it('strips the error from the URL so a refresh does not repeat it', () => {
        setUrl('?auth_error=redirect_uri_not_registered&correlation_id=abc');
        render(<AuthErrorNotice />);
        expect(window.location.search).not.toContain('auth_error');
        expect(window.location.search).not.toContain('correlation_id');
    });

    it('stays quiet for an error code it does not know', () => {
        setUrl('?auth_error=some_future_code');
        const { container } = render(<AuthErrorNotice />);
        expect(container).toBeEmptyDOMElement();
    });
});
