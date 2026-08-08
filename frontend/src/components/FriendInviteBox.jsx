import ShareLinkButton from './ShareLinkButton';

// "Add me as a friend" link, for the profile friends panel.
//
// Keyed by username so there is nothing to generate or store — the link works
// the moment an account exists. Anyone who opens it while signed in becomes a
// friend immediately; see the /friend-invite route on the server for why that
// skips the usual pending step.
export default function FriendInviteBox({ username }) {
  if (!username) return null;

  const link = `${window.location.origin}/add-friend/${encodeURIComponent(username)}`;

  return (
    <div className="bg-surface border border-border rounded-2xl p-4 mb-4">
      <h3 className="text-base font-black text-white mb-1">Invite a friend</h3>
      <p className="text-muted text-xs mb-3">
        Send this link. When they open it they are added to your friends — no request to accept.
      </p>

      <ShareLinkButton
        link={link}
        title="Add me on Duely"
        text={`Add me on Duely — I'm ${username}. 1v1 me!`}
      />

      {/* Always visible, so the link is recoverable if the clipboard is blocked
          (insecure origins, some in-app browsers) or the share sheet is cancelled. */}
      <button
        onClick={() => navigator.clipboard?.writeText(link).catch(() => {})}
        className="w-full text-left mt-3"
      >
        <code className="block text-[11px] font-mono text-muted break-all bg-bg border border-border rounded-lg px-3 py-2 hover:border-primary transition-colors">
          {link}
        </code>
      </button>
    </div>
  );
}
