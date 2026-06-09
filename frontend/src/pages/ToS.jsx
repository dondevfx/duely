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
            title: '9. Limitation of Liability',
            body: 'The platform is provided "as is." We are not liable for losses resulting from technical issues, server downtime, disconnections, or any other events outside our control. Maximum liability is limited to your current account balance.',
          },
          {
            title: '10. Changes to Terms',
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

