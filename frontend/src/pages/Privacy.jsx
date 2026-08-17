import { usePageReady } from '../hooks/usePageReady';

// Privacy policy. Written against what the app ACTUALLY does rather than from a
// template — every claim here maps to real code, and it needs to keep doing so:
//
//   account data      → Supabase Auth + profiles table
//   deposit addresses → addressService (derived per user+coin, stored in
//                       deposit_addresses so blockchainMonitor can watch them)
//   transactions      → transactions table (tx_hash, amounts, status)
//   match history     → matches + game_highscores
//   chat              → NOT stored; relayed over the socket and never written
//   errors            → Sentry, and only when SENTRY_DSN is set
//
// If any of those change, this page has to change with it. A privacy policy
// that no longer describes the system is worse than not having one.
export default function Privacy() {
  const ready = usePageReady();
  return (
    <div className="min-h-screen bg-bg pt-16" style={{ opacity: ready ? 1 : 0, transition: 'opacity 0.35s ease' }}>
      <div className="max-w-2xl mx-auto px-4 py-12">
        <h1 className="text-4xl font-black text-white mb-2">Privacy Policy</h1>
        <p className="text-muted text-sm mb-10">Last updated: {new Date().getFullYear()}</p>

        {[
          {
            title: '1. Who We Are',
            body: 'Duely operates a skill-based 1v1 gaming platform where players compete for real-money prizes. This policy explains what information we collect, why we collect it, who we share it with, and what control you have over it. It applies to the Duely website and any account you create on it.',
          },
          {
            title: '2. Information You Give Us',
            body: 'When you create an account we collect your email address and a username. Your password is handled by our authentication provider and is stored only as a cryptographic hash — we never see or store it in readable form. If you enable two-factor authentication we store the authenticator enrolment, but not your codes. If you withdraw funds you provide a destination wallet address, and optionally a memo or destination tag, which we store with the transaction record.',
          },
          {
            title: '3. Information We Generate About You',
            body: 'Playing creates records: your match history (game type, opponent, stake, outcome and timestamp), your ELO rating, win and loss totals, current streak, and personal best scores. We also store your friends list and any pending friend requests. Your balances in Coins and Diamonds are held as records in our database, along with cumulative totals of what you have deposited and withdrawn.',
          },
          {
            title: '4. Deposit Addresses and Transactions',
            body: 'We generate a permanent cryptocurrency deposit address for each account and coin, and store it so our systems can detect incoming deposits. We record every deposit and withdrawal: the amount, the coin, the on-chain transaction hash, and its status. Please note that blockchain transactions are public and permanent by design. Anyone can inspect activity associated with an address, and we cannot edit or erase on-chain records.',
          },
          {
            title: '5. Card Purchases',
            body: 'If you buy cryptocurrency with a card, that purchase is handled entirely by a third-party payment provider. They are the seller and they process the payment. We never see or store your card number, billing address, or the identity documents they may ask you for. We tell them only which address to send your purchase to. Their handling of your data is governed by their own privacy policy, which is shown to you before you buy and which we recommend reading.',
          },
          {
            title: '6. Technical Information',
            body: 'Our hosting providers record standard server logs, which include IP addresses, browser and device information, and the times of requests. These are used to operate the service, investigate abuse, and diagnose faults. If error monitoring is enabled, technical details of crashes — which can include your account identifier and the page you were on — are sent to our monitoring provider so we can fix them.',
          },
          {
            title: '7. What We Do Not Collect',
            body: 'We do not store the contents of in-game chat; messages are relayed between players in real time and are not written to our database. We do not collect your card details, government identification, physical address, or phone number. We do not use advertising trackers, and we do not sell or rent your personal information to anyone, for any purpose.',
          },
          {
            title: '8. Why We Use Your Information',
            body: 'We use it to run your account and matches, to hold and settle balances accurately, to process deposits and withdrawals, to detect cheating, collusion, multi-accounting and fraud, to keep the service secure and available, and to meet our legal and financial record-keeping obligations. We do not use your information to build advertising profiles.',
          },
          {
            title: '9. Who We Share It With',
            body: 'We share only what each provider needs to do its job: our authentication and database provider stores your account; our hosting providers run the site; a payment provider processes card purchases; cryptocurrency exchange partners convert funds during deposits and withdrawals; and public blockchain services are queried using your deposit addresses to detect incoming payments. We may also disclose information where we are legally required to, or where it is necessary to investigate fraud or protect the platform and its users.',
          },
          {
            title: '10. Public Information',
            body: 'Some information is visible to other players by design. Your username, ELO, rank, win and loss record, current streak and profile color appear on leaderboards, in matches, and on your public profile. Live and recent matches may show your username and the stake. Your email address, balance, transaction history and wallet addresses are never shown to other users.',
          },
          {
            title: '11. How Long We Keep It',
            body: 'We keep account and gameplay data for as long as your account exists. Financial records — deposits, withdrawals and match settlements — are kept for longer where we are required to retain them for accounting, tax or anti-money-laundering purposes, even after an account is closed. Server logs are retained for a short period on a rolling basis.',
          },
          {
            title: '12. Your Rights',
            body: 'You can view and update your profile in your account settings, and you can request a copy of your data or ask us to delete your account by contacting support. Two limits apply and we would rather be upfront about them: we cannot delete financial records we are legally required to keep, and we cannot delete anything recorded on a public blockchain, because that data is outside anyone’s control once it is written. Depending on where you live you may also have the right to object to certain processing or to complain to a data protection authority.',
          },
          {
            title: '13. Security',
            body: 'Passwords are hashed by our authentication provider and never stored in readable form. Two-factor authentication is available and is required for withdrawals once enabled. Traffic is encrypted in transit. Withdrawal destination addresses are validated before funds are sent. No system is perfectly secure, so please use a unique password, turn on two-factor authentication, and tell us promptly if you think your account has been accessed by someone else.',
          },
          {
            title: '14. Age Requirement',
            body: 'This platform is strictly for adults aged 18 or over. We do not knowingly collect information from anyone under 18. If we become aware that an underage person has created an account, we will close it. If you believe a minor has provided us with information, please contact us so we can remove it.',
          },
          {
            title: '15. Changes to This Policy',
            body: 'We may update this policy as the platform changes. The date at the top of this page reflects the most recent revision, and significant changes will be communicated through the platform. Continuing to use Duely after a change means you accept the updated policy.',
          },
        ].map(({ title, body }) => (
          <div key={title} className="mb-8">
            <h2 className="text-lg font-bold text-white mb-2">{title}</h2>
            <p className="text-muted text-sm leading-relaxed">{body}</p>
          </div>
        ))}

        <div className="mt-12 pt-6 border-t border-border">
          <p className="text-xs text-muted">
            Questions about your data? Contact us through the platform chat or support channels.
          </p>
        </div>
      </div>
    </div>
  );
}
