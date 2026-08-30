import { usePageReady } from '../hooks/usePageReady';

export default function ToS() {
  const ready = usePageReady();
  return (
    <div className="min-h-screen bg-bg pt-16" style={{ opacity: ready ? 1 : 0, transition: 'opacity 0.35s ease' }}>
      <div className="max-w-2xl mx-auto px-4 py-12">
        <h1 className="text-4xl font-black text-white mb-2">Terms of Service</h1>
        <p className="text-muted text-sm mb-10">Last updated: {new Date().getFullYear()}</p>

        {[
          {
            title: '1. Eligibility',
            body: 'You must be at least 18 years of age to use this platform. By creating an account you confirm that you meet this requirement and that real-money wagering is legal in your jurisdiction. We reserve the right to close accounts that do not meet eligibility requirements.',
          },
          {
            title: '2. Real-Money Wagering',
            body: 'This platform facilitates skill-based 1v1 wagering using platform currency (Coins and Diamonds). Coin matches carry a 5% platform fee deducted from the prize pool. Diamond matches pay out in full. All wagers are final — there are no refunds once a match has started, except in the case of a mutual disconnect (both players disconnected) where no coins are deducted.',
          },
          {
            title: '3. Deposits & Withdrawals',
            body: 'Deposits are processed via supported crypto networks. Withdrawals require a minimum of 5 coins. The platform is not responsible for losses due to incorrect wallet addresses provided by the user. Withdrawal processing times vary by network.',
          },
          {
            title: '4. Fair Play',
            body: 'Use of bots, scripts, exploits, or any automated tools to gain an unfair advantage is strictly prohibited and will result in permanent account termination and forfeiture of balance. All game outcomes are determined server-side and are final.',
          },
          {
            title: '5. Account Security',
            body: 'You are responsible for maintaining the security of your account credentials. We strongly recommend enabling email verification. The platform will never ask for your password. Report any suspicious activity immediately.',
          },
          {
            title: '6. Platform Fees',
            body: 'The platform retains 5% of the prize pool on all coin-wagered matches. This fee is clearly displayed before entering any match. Diamond wagered matches have no platform fee.',
          },
          {
            title: '7. Prohibited Conduct',
            body: 'The following are prohibited: collusion between players, money laundering, chargebacks, abusive behavior in chat, impersonation of other users or staff, and exploiting bugs without reporting them. Violations may result in account suspension or permanent ban.',
          },
          {
            title: '8. Responsible Gaming',
            body: 'We encourage responsible gaming. If you feel you are developing a gambling problem, please seek help. You may request account closure at any time by contacting support. We do not offer self-exclusion tools at this time but plan to add them.',
          },
          {
            title: '9. Custody of Funds',
            body: 'Balances shown in your account represent an obligation owed to you by the platform. They are not a bank deposit, are not insured by any government or private deposit insurance scheme, and are not held in a segregated trust account for your individual benefit unless we state otherwise in writing. Digital assets are held in wallets controlled by the platform. You acknowledge that holding digital assets carries risk, including the risk of total loss.',
          },
          {
            title: '10. Security Incidents',
            body: 'We are not liable for loss of funds or data resulting from: compromise of your own account, device, email, or wallet; credentials you disclose to a third party; transactions you authorise, including transfers to an incorrect or fraudulent address; failure, congestion, fork, or reorganisation of any blockchain network; or the acts, insolvency, or compromise of any third-party payment processor, exchange, custodian, or infrastructure provider we rely on. Where a loss results from a security incident affecting the platform itself, our liability is limited as set out in Section 11, except that nothing in these Terms limits our liability for our own gross negligence, fraud, or wilful misconduct, or for any liability that cannot lawfully be excluded.',
          },
          {
            title: '11. Limitation of Liability',
            body: 'The platform is provided "as is" and "as available," without warranties of any kind to the fullest extent permitted by law. We are not liable for indirect, incidental, consequential, special, or punitive damages, or for lost profits, lost opportunity, or the value of anticipated winnings. Our total aggregate liability to you for all claims arising out of or relating to these Terms or your use of the platform is limited to the lesser of (a) the balance credited to your account at the time the claim arose, or (b) the total platform fees you paid in the twelve months preceding the claim. This limit does not apply to liability for our own gross negligence, fraud, or wilful misconduct, or to any liability that cannot lawfully be excluded or limited.',
          },
          {
            title: '12. Severability',
            body: 'If any provision of these Terms is held to be unenforceable or invalid, that provision will be modified to the minimum extent necessary to make it enforceable, or severed if it cannot be. The remaining provisions will continue in full force. In particular, if any limitation of liability is held unenforceable in your jurisdiction, the remaining limitations continue to apply to the fullest extent permitted.',
          },
          {
            title: '13. Changes to Terms',
            body: 'We reserve the right to update these terms at any time. Continued use of the platform after changes constitutes acceptance of the updated terms. Major changes will be communicated via the platform.',
          },
        ].map(({ title, body }) => (
          <div key={title} className="mb-8">
            <h2 className="text-lg font-bold text-white mb-2">{title}</h2>
            <p className="text-muted text-sm leading-relaxed">{body}</p>
          </div>
        ))}

        <div className="mt-12 pt-6 border-t border-border">
          <p className="text-xs text-muted">
            Questions? Contact us through the platform chat or support channels.
          </p>
        </div>
      </div>
    </div>
  );
}

