import GlowButton from './GlowButton';
import ChallengeLinkBox from './ChallengeLinkBox';

/**
 * The screen shown after sending a friend invite, or after opening a private
 * room and waiting for someone to use the link.
 *
 * Shared because it had drifted into five slightly different screens: different
 * spinner sizes, different headings, one with no spinner at all, and the order
 * of the link box and the waiting line swapped between games. It is the same
 * moment in every game and should look like it — and like the Searching screen
 * the normal queue uses, since from the player's side it is the same wait.
 */
export default function PrivateWaiting({
  invitedFriend,   // username when a friend was invited directly
  code,            // room code when waiting on a shared link
  gameType,        // room id, for the shareable link
  onCancel,
  // Some pages render this INSIDE an already-centred, already-full-height
  // container. Nesting a second one there stacks the min-heights and pushes the
  // card off centre, so those callers ask for the card on its own.
  inline = false,
}) {
  const card = (
    <div className="text-center animate-fade-in w-full max-w-md">
        {/* Same spinner as the Searching screen, at the same size. */}
        <div className="w-16 h-16 border-4 border-primary border-t-transparent rounded-full animate-spin mx-auto mb-6" />

        {invitedFriend ? (
          <>
            <h2 className="text-2xl font-bold text-white mb-2">Invite Sent</h2>
            <p className="text-muted text-sm mb-6">
              Waiting for <span className="text-white font-bold">{invitedFriend}</span> to accept…
            </p>
          </>
        ) : (
          <>
            <h2 className="text-2xl font-bold text-white mb-6">Challenge Ready</h2>
            {code && <ChallengeLinkBox code={code} gameType={gameType} />}
            <p className="text-muted text-sm mb-6">Waiting for opponent to join…</p>
          </>
        )}

      <GlowButton variant="ghost" onClick={onCancel}>Cancel</GlowButton>
    </div>
  );

  if (inline) return card;
  return (
    <div className="min-h-[calc(100dvh-56px)] bg-bg flex flex-col items-center justify-center px-4">
      {card}
    </div>
  );
}
