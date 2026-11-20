import { useState } from 'react';
import Button from '@/components/shared_ui/button';
import { DerivWSAccountsService } from '@/services/derivws-accounts.service';
import type { DemoTradeResult } from '@reef-sites/deriv-auth';

/**
 * Places one real contract on the trader's DEMO account and shows what happened.
 *
 * This is a genuine trade: the contract id, buy price and payout below come back
 * from Deriv, and the contract exists on the account afterwards. It is not a
 * simulation and it is not a pretend fill.
 *
 * Two things it is careful about:
 *
 *  1. Demo only. If Deriv has no demo account in this session nothing is traded,
 *     and the server independently refuses any account Deriv reports as real, so
 *     this control cannot reach real money even if the UI were wrong.
 *
 *  2. It does not claim Deriv told us the markup. Both tenants currently share one
 *     Deriv app, so Deriv pays markup per application and cannot say which tenant
 *     a contract belonged to. The per-site figure is Deriv's published rule
 *     applied to the real payout at the site's own rate, and it is labelled
 *     'allocated' rather than presented as Deriv's record.
 */
const DEMO_TRADE_STAKE = 1;
const DEMO_TRADE_DURATION = 5;

const money = (value: number, currency = 'USD') =>
    `${currency} ${value.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

const DemoTradePanel = () => {
    const [result, setResult] = useState<DemoTradeResult | null>(null);
    const [error, setError] = useState<string | null>(null);
    const [pending, setPending] = useState(false);

    const demoAccount = DerivWSAccountsService.getSelectedDemoAccount();

    const placeTrade = async () => {
        setPending(true);
        setError(null);
        setResult(null);
        try {
            setResult(
                await DerivWSAccountsService.placeDemoTrade({
                    symbol: 'R_100',
                    contractType: 'CALL',
                    stake: DEMO_TRADE_STAKE,
                    duration: DEMO_TRADE_DURATION,
                    durationUnit: 't',
                }),
            );
        } catch (cause) {
            setError(cause instanceof Error ? cause.message : 'The demo trade could not be placed.');
        } finally {
            setPending(false);
        }
    };

    return (
        <div className='demo-trade-panel'>
            <div className='demo-trade-panel__header'>
                <h2>Demo trade</h2>
                <span className='demo-trade-panel__badge'>DEMO — no real money</span>
            </div>

            <p className='demo-trade-panel__hint'>
                Places one real {money(DEMO_TRADE_STAKE)} Rise contract for {DEMO_TRADE_DURATION} ticks on Volatility 100
                Index using your Deriv demo account. The contract is real; the account is virtual, so nothing can be lost.
            </p>

            {demoAccount ? (
                <p className='demo-trade-panel__account'>
                    Trading as <strong>{demoAccount.account_id}</strong>
                    {demoAccount.currency ? ` (${demoAccount.currency})` : ''}
                </p>
            ) : (
                <p className='demo-trade-panel__error'>
                    No demo account is available in this Deriv session. Switch to a demo account before trading.
                </p>
            )}

            <Button
                type='button'
                primary
                has_effect
                is_loading={pending}
                is_disabled={pending || !demoAccount}
                onClick={placeTrade}
            >
                {pending ? 'Placing trade…' : 'Place demo trade'}
            </Button>

            {error && <p className='demo-trade-panel__error'>{error}</p>}

            {result && (
                <div className='demo-trade-panel__result'>
                    <p className='demo-trade-panel__result-title'>Trade placed</p>
                    <dl>
                        <dt>Contract</dt>
                        <dd>{result.contractId}</dd>
                        <dt>Bought for</dt>
                        <dd>{money(result.buyPrice)}</dd>
                        <dt>Payout</dt>
                        <dd>{money(result.payout)}</dd>
                        {result.balanceAfter !== null && (
                            <>
                                <dt>Demo balance after</dt>
                                <dd>{money(result.balanceAfter)}</dd>
                            </>
                        )}
                        <dt>Tenant markup</dt>
                        <dd>
                            {money(result.ledger.grossMarkup)} at {result.ledger.markupRate}%
                            <span className='demo-trade-panel__basis'>
                                {' '}
                                — allocated from this contract&apos;s payout, not reported by Deriv
                            </span>
                        </dd>
                        <dt>Platform fee</dt>
                        <dd>{money(result.ledger.platformFee)}</dd>
                        <dt>Tenant net</dt>
                        <dd>{money(result.ledger.ownerNet)}</dd>
                    </dl>
                    <p className='demo-trade-panel__note'>
                        Recorded for {result.ledger.siteName}. Demo trades are never payable, so this will not appear as
                        money owed.
                    </p>
                </div>
            )}
        </div>
    );
};

export default DemoTradePanel;
