"use client";
// The first screen for signed-out people (and anyone tapping through from X), like the iOS
// WelcomeView: the wordmark, a short story of a take becoming a market, the pitch, and sign-in.
import { useEffect, useState } from "react";
import { SERIES } from "@/lib/data";
import SignIn from "./SignIn";

type Story = { claim: string; ret: number; risk: string; legs: { name: string; weight: number }[] };

// The iOS hero's demo takes (MockData: aiPower, nuclear, fedCut).
const STORIES: Story[] = [
  { claim: "AI power demand is underrated.", ret: 14.0, risk: "Medium risk", legs: [{ name: "Vistra", weight: 30 }, { name: "Constellation", weight: 30 }, { name: "NVIDIA", weight: 25 }, { name: "AI capex: Yes", weight: 15 }] },
  { claim: "Nuclear restarts get fast-tracked.", ret: 9.4, risk: "High risk", legs: [{ name: "Constellation", weight: 40 }, { name: "Vistra", weight: 30 }, { name: "Restart approved: Yes", weight: 30 }] },
  { claim: "The Fed cuts in January.", ret: 3.1, risk: "Low risk", legs: [{ name: "Rate cut: Yes", weight: 50 }, { name: "T-bills", weight: 30 }, { name: "Cash", weight: 20 }] },
];

const EVENTS = [
  { who: "priya", side: "back", amount: 50 },
  { who: "nina", side: "back", amount: 20 },
  { who: "dev", side: "fade", amount: 25 },
  { who: "danny", side: "back", amount: 100 },
  { who: "johnny", side: "back", amount: 40 },
] as const;

const CYCLE = 11500;

/** You type a take, it becomes a basket of picks, and friends trade it or fade it. */
function StoryHero() {
  const [t, setT] = useState(0);
  const [reduced, setReduced] = useState(false);
  useEffect(() => {
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
      setReduced(true);
      setT(9200); // a still frame with everything on screen, like the app's frozen hero
      return;
    }
    const start = performance.now();
    const id = window.setInterval(() => setT(performance.now() - start), 50);
    return () => window.clearInterval(id);
  }, []);

  const round = reduced ? 0 : Math.floor(t / CYCLE);
  const story = STORIES[round % STORIES.length];
  const local = reduced ? t : t % CYCLE;
  const typeEnd = 300 + story.claim.length * 40;
  const typed = Math.min(story.claim.length, Math.max(0, Math.floor((local - 300) / 40)));
  const legStart = (i: number) => typeEnd + 200 + i * 220;
  const tradeStart = legStart(story.legs.length - 1) + 1400;
  const shown = local < tradeStart ? 0 : Math.min(EVENTS.length, Math.floor((local - tradeStart) / 550) + 1);
  const events = EVENTS.slice(0, shown);
  const total = events.reduce((s, e) => s + e.amount, 0);
  const fading = local > CYCLE - 550;

  return (
    <div className="hero" style={{ opacity: fading ? 0 : 1 }} role="img" aria-label="You type a take, it becomes a basket of picks, and friends trade it or fade it">
      <div className="caps">Your take</div>
      <div className="hero-claim">
        <span className="ghost">{story.claim}</span>
        <span className="typed">{story.claim.slice(0, typed)}{local < typeEnd + 500 ? <i className="caret" /> : null}</span>
      </div>
      <div className="hero-legs">
        <div className="caps">{story.legs.length} picks · {story.risk}</div>
        {story.legs.map((l, i) => (
          <div key={l.name} className="hero-leg" style={{ opacity: local > legStart(i) ? 1 : 0, transform: local > legStart(i) ? "none" : "translateY(6px)" }}>
            <i style={{ background: SERIES[i] }} />
            <span>{l.name}</span>
            <span className="mono muted">{l.weight}%</span>
          </div>
        ))}
      </div>
      <div className="hero-trades" style={{ opacity: shown ? 1 : 0 }}>
        <div className="faces">
          {events.map((e, i) => (
            // eslint-disable-next-line @next/next/no-img-element
            <img key={i} src={`/avatars/${e.who}.png`} alt="" className={e.side === "back" ? "ring-up" : "ring-down"} />
          ))}
        </div>
        <div className="small">
          <b className="mono">${total}</b> on your take <span className="muted">· {events.length} {events.length === 1 ? "person" : "people"}</span>
        </div>
        <div className="mono up small">+{(story.ret * (shown / EVENTS.length)).toFixed(1)}%</div>
      </div>
    </div>
  );
}

export default function Welcome() {
  return (
    <main className="page welcome">
      <header className="welcome-top">
        <span className="brand" style={{ fontSize: 28 }}>thesis</span>
      </header>
      <StoryHero />
      <h1 className="welcome-title">Turn ideas<br />into markets.</h1>
      <p className="muted welcome-sub">Make a market. Make it yours. Share your take, follow others, and trade any idea long or short.</p>
      <SignIn />
      <p className="muted small welcome-note">Thesis runs on play money for now, so you can try every trade risk-free.</p>
    </main>
  );
}
