import ShareLinkButton from './ShareLinkButton';

// "Add me as a friend" link, at the foot of the profile friends panel.
//
// Keyed by username so there is nothing to generate or store — the link works
// the moment an account exists. Anyone who opens it while signed in becomes a
// friend immediately; see the /friend-invite route on the server for why that
// skips the usual pending step.
//
// Sized to match the rows above it rather than the page: this is a footer on a
// narrow sidebar panel, so it uses the same [10px]/xs type and tight padding as
// the friends list, and sits behind a divider instead of its own card.
export default function FriendInviteBox({ username }) {
  if (!username) return null;

  const link = `${window.location.origin}/add-friend/${encodeURIComponent(username)}`;

  return (
    <div className="mt-4 pt-4 border-t border-surfaceLight">
      <div className="text-[10px] text-muted font-bold uppercase tracking-wider mb-2">
        Invite Link
      </div>

      <ShareLinkButton
        link={link}
        text={`Add me on Duely — I'm ${username}. 1v1 me!`}
        className="!py-2 !text-xs !rounded-xl"
      />

      {/* Always visible, so the link is recoverable if the clipboard is blocked
          (insecure origins, some in-app browsers) or the share sheet is cancelled. */}
      <button
        onClick={() => navigator.clipboard?.writeText(link).catch(() => {})}
        className="w-full text-left mt-1.5"
      >
        <code className="block text-[9px] leading-tight font-mono text-muted/70 break-all bg-bg border border-border rounded-lg px-2 py-1.5 hover:border-primary transition-colors">
          {link}
        </code>
      </button>

      <p className="text-[10px] text-muted/70 mt-1.5">
        They're added instantly — no request to accept.
      </p>
    </div>
  );
}
