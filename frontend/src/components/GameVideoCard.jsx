import { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';

// A square card: a looping gameplay clip fills the whole thing, and the title
// and Play button sit directly on top of it, over a gradient scrim so they
// stay readable no matter what the video underneath is doing.
//
// aspect-square applies at every breakpoint on purpose — one rule, not a
// desktop layout and a separate mobile one to keep in sync.
//
// Clips live at /game-clips/{slug}.mp4 with a /game-clips/{slug}.jpg poster.
// Both are plain static files (public/, not imported), so adding a game is
// dropping two files in a folder, not a build change.
// ?cropdebug=1 on any page using this card turns on a live crop-position
// slider, per card, that writes straight to object-position and shows the
// number. It exists because a crop that looks right in every tool available
// here (extracted frames, simulated canvas crops, the deployed CSS value
// itself) still came back wrong on a real phone, twice — canvas drawImage
// does not reproduce what object-fit:cover actually paints, so nothing built
// on it can be trusted for this. The fastest real fix is handing the dial to
// whoever is looking at the real screen. Reads the value back out of the URL
// hash so it survives a reload while testing.
function useCropDebug(slug) {
  const enabled = typeof window !== 'undefined' && new URLSearchParams(window.location.search).get('cropdebug') === '1';
  const [pos, setPos] = useState(() => {
    if (!enabled) return null;
    const saved = new URLSearchParams(window.location.hash.slice(1)).get(slug);
    return saved ? Number(saved) : 50;
  });
  const setAndPersist = (v) => {
    setPos(v);
    const params = new URLSearchParams(window.location.hash.slice(1));
    params.set(slug, v);
    history.replaceState(null, '', `${window.location.pathname}${window.location.search}#${params}`);
  };
  return enabled ? [pos, setAndPersist] : [null, null];
}

export default function GameVideoCard({ slug, title, icon, route, liveCount = 0, available = true, clipPosition }) {
  const navigate = useNavigate();
  const containerRef = useRef(null);
  const videoRef = useRef(null);
  const [inView, setInView] = useState(false);
  const [videoFailed, setVideoFailed] = useState(false);
  const [debugX, setDebugX] = useCropDebug(slug);
  if (debugX !== null) clipPosition = `${debugX}% 50%`;

  // Only load and play the clip once the card is actually on screen. Seven
  // autoplaying videos loading at once — especially on a phone on cellular —
  // is the kind of thing that quietly makes a page miserable. margin gives it
  // a head start so playback has already begun by the time it's fully visible.
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const io = new IntersectionObserver(
      ([entry]) => setInView(entry.isIntersecting),
      { rootMargin: '200px 0px' }
    );
    io.observe(el);
    return () => io.disconnect();
  }, []);

  // Respected, not just declared. Someone with this OS setting sees the still
  // poster only — this page is for browsing, not gameplay itself, so there is
  // no reason to force motion on someone who has said motion is a problem.
  const [reducedMotion] = useState(
    () => typeof window !== 'undefined' && window.matchMedia?.('(prefers-reduced-motion: reduce)').matches
  );

  useEffect(() => {
    const v = videoRef.current;
    if (!v) return;
    if (inView && !reducedMotion) v.play().catch(() => {}); // autoplay can be refused; the poster covers that
    else v.pause();
  }, [inView, reducedMotion]);

  const clipSrc   = `/game-clips/${slug}.mp4`;
  const posterSrc = `/game-clips/${slug}.jpg`;
  const showVideo = !reducedMotion && !videoFailed;

  return (
    <div
      ref={containerRef}
      onClick={() => available && navigate(route)}
      className={`relative aspect-square rounded-2xl overflow-hidden border transition-all duration-300 ${
        available
          ? 'border-surfaceLight hover:border-primary/50 hover:shadow-glow cursor-pointer group'
          : 'border-surfaceLight/50 opacity-60'
      }`}
    >
      {/* Base layer, always rendered: the icon on a solid surface. This is
          what shows before any clip has been recorded, and it is a genuine
          base layer rather than an error handler — a browser that fails to
          load an <img> just renders nothing, so waiting for an onError to
          show a fallback would leave the card blank for anyone whose poster
          hasn't loaded yet, not only for games with no footage at all. */}
      <div className="absolute inset-0 flex items-center justify-center text-6xl bg-surface">
        {icon}
      </div>

      {/* Poster layers over the icon once it loads; the video, once it loads,
          covers the poster. Nothing here needs to be removed from the DOM — a
          slow or missing file just leaves the layer underneath visible. */}
      {/* clipPosition falls through to CSS object-position on both layers —
          the poster and the video have to agree, or the still frame jumps to
          a different crop the instant the clip takes over. */}
      <img
        src={posterSrc}
        alt=""
        aria-hidden="true"
        className="absolute inset-0 w-full h-full object-cover"
        style={clipPosition ? { objectPosition: clipPosition } : undefined}
        onError={(e) => { e.currentTarget.style.display = 'none'; }}
      />

      {showVideo && inView && (
        <video
          ref={videoRef}
          src={clipSrc}
          poster={posterSrc}
          autoPlay
          muted
          loop
          playsInline
          // playsInline specifically: without it iOS Safari takes the clip
          // fullscreen the instant it starts instead of playing inside the card.
          preload="metadata"
          onError={() => setVideoFailed(true)}
          className="absolute inset-0 w-full h-full object-cover"
          style={clipPosition ? { objectPosition: clipPosition } : undefined}
        />
      )}

      {debugX !== null && (
        // Sits above the scrim, doesn't block the title/button below it, and
        // stops the card's own onClick from firing when you're dragging.
        <div
          className="absolute top-2 left-2 right-2 z-20 bg-black/80 rounded-lg px-2 py-1.5 flex items-center gap-2"
          onClick={(e) => e.stopPropagation()}
        >
          <input
            type="range" min="0" max="100" value={debugX}
            onChange={(e) => setDebugX(Number(e.target.value))}
            onClick={(e) => e.stopPropagation()}
            className="flex-1 accent-primary"
          />
          <span className="text-[11px] font-mono text-white w-9 text-right">{debugX}%</span>
        </div>
      )}

      {liveCount > 0 && (
        <div className="absolute top-2 right-2 md:top-3 md:right-3 inline-flex items-center gap-1 text-[10px] md:text-xs font-semibold px-1.5 md:px-2 py-0.5 rounded-full bg-black/60 backdrop-blur-sm text-primary border border-primary/40">
          <span className="w-1.5 h-1.5 rounded-full bg-primary inline-block" style={{ boxShadow: '0 0 4px #1250B4' }} />
          {liveCount} Live
        </div>
      )}

      {/* Scrim + title + button, all over the video. from-black/90 at the
          bottom guarantees the button and title read on any footage. */}
      <div className="absolute inset-x-0 bottom-0 pt-10 pb-2.5 px-2.5 md:pb-4 md:px-4 bg-gradient-to-t from-black/90 via-black/50 to-transparent">
        <h3 className="text-sm md:text-xl font-bold text-white mb-1.5 md:mb-3 leading-tight drop-shadow-[0_1px_3px_rgba(0,0,0,0.8)]">
          {title}
        </h3>
        {available ? (
          <button
            onClick={(e) => { e.stopPropagation(); navigate(route); }}
            className="w-full text-xs md:text-base py-1.5 md:py-2.5 rounded-lg md:rounded-xl bg-primary hover:bg-blue-500 text-white font-bold transition-all"
          >
            Play Now
          </button>
        ) : (
          <div className="w-full text-center text-xs md:text-sm text-muted py-1.5 md:py-2 border border-white/20 rounded-lg">
            Coming Soon
          </div>
        )}
      </div>
    </div>
  );
}
