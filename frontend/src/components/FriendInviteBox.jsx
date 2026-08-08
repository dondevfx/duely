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

      {/* The raw link is not shown — the button carries it. It is revealed only
          if copying actually fails (blocked clipboard on insecure origins or in
          some in-app browsers), which is the one case where there would
          otherwise be no way to get at it. */}
      <ShareLinkButton
        link={link}
        title="Add me on Duely"
        text={`Add me on Duely — I'm ${username}. 1v1 me!`}
        className="!py-2 !text-xs !rounded-xl"
      />

      <p className="text-[10px] text-muted/70 mt-1.5">
        They're added instantly — no request to accept.
      </p>
    </div>
  );
}
