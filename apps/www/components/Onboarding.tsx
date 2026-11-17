"use client";
// First-time setup, the iOS app's four steps: profile (name, handle, bio), photo, where you live,
// and people to follow. Signed in with X, the name, handle and photo start from the X account;
// everything can still be changed here.
import { useEffect, useMemo, useState } from "react";
import { supabaseKey, supabaseUrl } from "@/lib/data";
import { countries, defaultCountry, US_STATES } from "@/lib/regions";
import { useSession, type Step } from "@/lib/session";
import Avatar from "./Avatar";

const FACE_COUNT = 33;
const FACE_COLORS = 7;
const face = (n: number) => `person-${String(n).padStart(2, "0")}`;
const randomInt = (n: number) => Math.floor(Math.random() * n);

function Scaffold({ title, subtitle, children, footer }: { title: string; subtitle: string; children: React.ReactNode; footer: React.ReactNode }) {
  return (
    <main className="page onboard">
      <h1 className="onboard-title">{title}</h1>
      <p className="muted onboard-sub">{subtitle}</p>
      <div className="onboard-body">{children}</div>
      <div className="onboard-foot">{footer}</div>
    </main>
  );
}

export default function Onboarding({ step }: { step: Step }) {
  if (step === "profile") return <ProfileStep />;
  if (step === "photo") return <PhotoStep />;
  if (step === "location") return <LocationStep />;
  return <FollowStep />;
}

type HandleState = "idle" | "short" | "checking" | "free" | "taken" | "unknown";

async function handleFree(handle: string): Promise<boolean | null> {
  const r = await fetch(`${supabaseUrl()}/rest/v1/profiles?select=id&handle=eq.${encodeURIComponent(handle)}&limit=1`, {
    headers: { apikey: supabaseKey() },
  }).catch(() => null);
  if (!r?.ok) return null;
  return ((await r.json()) as unknown[]).length === 0;
}

function ProfileStep() {
  const { hints, snapshot, update, apply, social } = useSession();
  const [name, setName] = useState(snapshot?.profile.display_name || hints.name);
  const [handle, setHandle] = useState(snapshot?.profile.handle || hints.handle);
  const [bio, setBio] = useState("");
  const [state, setState] = useState<HandleState>("idle");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Check the handle as it's typed, like the app (a short pause, then one lookup).
  useEffect(() => {
    if (!handle) return setState("idle");
    if (handle.length < 3) return setState("short");
    setState("checking");
    const id = window.setTimeout(async () => {
      const free = await handleFree(handle);
      setState(free == null ? "unknown" : free ? "free" : "taken");
    }, 350);
    return () => window.clearTimeout(id);
  }, [handle]);

  const hint: Record<HandleState, [string, string]> = {
    idle: ["Letters, numbers and underscores.", "muted"],
    unknown: ["Letters, numbers and underscores.", "muted"],
    short: ["At least 3 characters.", "muted"],
    checking: ["Checking…", "muted"],
    free: [`@${handle} is yours.`, "up"],
    taken: [`@${handle} is taken.`, "down"],
  };

  async function submit() {
    setError(null);
    setBusy(true);
    try {
      // Name and handle go to the session; the bio to the social layer, which needs the handle first.
      // The step only moves on once both are saved, so a failed bio can be retried.
      const text = bio.trim();
      if (text) {
        const saved = await update({ display_name: name.trim(), handle }, { hold: true });
        await social("PATCH", "profile", { bio: text });
        apply(saved);
      } else {
        await update({ display_name: name.trim(), handle });
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Scaffold
      title="Make your profile"
      subtitle={hints.hasX ? "We started from your X profile. This is how friends find you and see your calls." : "This is how friends find you and see your calls."}
      footer={
        <>
          {error ? <div className="err">{error}</div> : null}
          <button className="obtn filled" disabled={busy || !name.trim() || state === "short" || state === "taken" || state === "checking" || handle.length < 3} onClick={submit}>
            {busy ? "Saving…" : "Continue"}
          </button>
        </>
      }
    >
      <label className="caps" htmlFor="name">Name</label>
      <input id="name" className="uline" placeholder="Your name" autoComplete="name" maxLength={50} value={name} onChange={(e) => setName(e.target.value)} />
      <label className="caps" htmlFor="handle">Handle</label>
      <div className="uline-wrap">
        <span className="muted">@</span>
        <input id="handle" className="uline" placeholder="handle" autoCapitalize="none" autoCorrect="off" spellCheck={false} maxLength={20} value={handle} onChange={(e) => setHandle(e.target.value.toLowerCase().replace(/[^a-z0-9_]/g, ""))} />
      </div>
      <div className={`small ${hint[state][1]}`} style={{ marginTop: 6 }}>{hint[state][0]}</div>
      <label className="caps" htmlFor="bio">Bio · optional</label>
      <textarea id="bio" className="uline" rows={2} maxLength={160} placeholder="What do you trade on?" value={bio} onChange={(e) => setBio(e.target.value)} />
      <div className="small muted" style={{ textAlign: "right" }}>{bio.length}/160</div>
    </Scaffold>
  );
}

/** A photo as a JPEG of at most 640px, so it fits the 3 MB limit whatever the camera took. */
async function shrink(file: Blob): Promise<Blob> {
  const bitmap = await createImageBitmap(file);
  const scale = Math.min(1, 640 / Math.max(bitmap.width, bitmap.height));
  const canvas = document.createElement("canvas");
  canvas.width = Math.round(bitmap.width * scale);
  canvas.height = Math.round(bitmap.height * scale);
  canvas.getContext("2d")!.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  return await new Promise((resolve, reject) => canvas.toBlob((b) => (b ? resolve(b) : reject(new Error("Couldn't open that photo. Try another one."))), "image/jpeg", 0.88));
}

type Pick = { kind: "face"; n: number; color: number } | { kind: "x" } | { kind: "upload"; file: Blob; url: string } | { kind: "current" };

function PhotoStep() {
  return <PhotoPicker mode="onboarding" />;
}

/** The photo step, also used by Edit profile (`mode="edit"`: starts on your current photo, Save when changed). */
export function PhotoPicker({ mode, onDone }: { mode: "onboarding" | "edit"; onDone?: () => void }) {
  const { hints, snapshot, update, uploadPhoto } = useSession();
  const [pick, setPick] = useState<Pick>(() => (mode === "edit" ? { kind: "current" } : hints.photo ? { kind: "x" } : { kind: "face", n: 1 + randomInt(FACE_COUNT), color: randomInt(FACE_COLORS) }));
  const [color, setColor] = useState(() => randomInt(FACE_COLORS));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const preview = pick.kind === "face" ? `face:${face(pick.n)}:${pick.color}` : pick.kind === "x" ? hints.photo : pick.kind === "upload" ? pick.url : (snapshot?.profile.avatar_url ?? null);

  async function submit() {
    setError(null);
    setBusy(true);
    try {
      if (pick.kind === "face") await update({ avatar: `face:${face(pick.n)}:${pick.color}` });
      else if (pick.kind === "upload") await uploadPhoto(await shrink(pick.file));
      else if (pick.kind === "x") {
        const r = await fetch(hints.photo!);
        if (!r.ok) throw new Error("Couldn't get your X photo. Pick a face or upload one.");
        await uploadPhoto(await shrink(await r.blob()));
      }
      onDone?.();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  const footer = (
    <>
      {error ? <div className="err">{error}</div> : null}
      <button className="obtn filled" disabled={busy || (mode === "edit" && pick.kind === "current")} onClick={submit}>
        {busy ? "Saving…" : mode === "edit" ? "Save" : "Continue"}
      </button>
    </>
  );
  const body = (
    <>
      <div className="photo-preview">
        <Avatar person={{ avatar_url: preview, handle: snapshot?.profile.handle ?? null }} size={112} />
      </div>
      <div className="photo-actions">
        <button className="pill small" onClick={() => setPick({ kind: "face", n: 1 + randomInt(FACE_COUNT), color })}>Shuffle</button>
        <label className="pill small" style={{ cursor: "pointer" }}>
          Upload photo
          <input
            type="file"
            accept="image/jpeg,image/png,image/heic,image/webp"
            hidden
            onChange={(e) => {
              const file = e.target.files?.[0];
              if (file) setPick({ kind: "upload", file, url: URL.createObjectURL(file) });
            }}
          />
        </label>
        {hints.photo ? <button className="pill small" onClick={() => setPick({ kind: "x" })}>Use my X photo</button> : null}
      </div>
      <div className="swatches" role="radiogroup" aria-label="Background color">
        {Array.from({ length: FACE_COLORS }, (_, i) => (
          <button
            key={i}
            role="radio"
            aria-checked={color === i}
            aria-label={`Color ${i + 1}`}
            className={`swatch-dot${color === i ? " on" : ""}`}
            style={{ background: ["#FFD5DC", "#C0AEDE", "#B6E3F4", "#D1D4F9", "#FFDFBF", "#C8ECD4", "#FFFFFF"][i] }}
            onClick={() => {
              setColor(i);
              if (pick.kind === "face") setPick({ ...pick, color: i });
            }}
          />
        ))}
      </div>
      <div className="faces-grid">
        {Array.from({ length: FACE_COUNT }, (_, i) => i + 1).map((n) => (
          <button key={n} aria-label={`Avatar ${n}`} aria-pressed={pick.kind === "face" && pick.n === n} className={pick.kind === "face" && pick.n === n ? "on" : ""} onClick={() => setPick({ kind: "face", n, color })}>
            <Avatar person={{ avatar_url: `face:${face(n)}:${color}`, handle: null }} size={56} />
          </button>
        ))}
      </div>
    </>
  );
  if (mode === "edit") {
    return (
      <div>
        <p className="muted small">Pick a face or upload your own.</p>
        {body}
        <div className="onboard-foot">{footer}</div>
      </div>
    );
  }
  return (
    <Scaffold title="Pick a profile photo" subtitle="Pick a face or upload your own. You can change it anytime." footer={footer}>
      {body}
    </Scaffold>
  );
}

function LocationStep() {
  const { update } = useSession();
  const list = useMemo(() => countries(), []);
  const [country, setCountry] = useState("US");
  const [usState, setUsState] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => setCountry(defaultCountry()), []);

  async function submit() {
    setError(null);
    setBusy(true);
    try {
      await update({ country, us_state: country === "US" ? usState : null });
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Scaffold
      title="Where do you live?"
      subtitle="What you can invest in depends on where you live. We'll only show you what's available to you."
      footer={
        <>
          {error ? <div className="err">{error}</div> : null}
          <button className="obtn filled" disabled={busy || (country === "US" && !usState)} onClick={submit}>{busy ? "Saving…" : "Continue"}</button>
        </>
      }
    >
      <label className="caps" htmlFor="country">Country</label>
      <select id="country" className="field" value={country} onChange={(e) => setCountry(e.target.value)}>
        {list.map((c) => <option key={c.code} value={c.code}>{c.name}</option>)}
      </select>
      {country === "US" ? (
        <>
          <label className="caps" htmlFor="state">State</label>
          <select id="state" className="field" value={usState} onChange={(e) => setUsState(e.target.value)}>
            <option value="">Choose</option>
            {US_STATES.map((s) => <option key={s.code} value={s.code}>{s.name}</option>)}
          </select>
        </>
      ) : null}
    </Scaffold>
  );
}

type Suggestion = { id: string; handle: string | null; display_name: string | null; avatar_url: string | null; reason?: string | null };

function FollowStep() {
  const { social, finishOnboarding } = useSession();
  const [people, setPeople] = useState<Suggestion[] | null>(null);
  const [followed, setFollowed] = useState<Set<string>>(new Set());
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    social<{ people: Suggestion[] }>("GET", "suggestions?limit=12")
      .then((r) => setPeople(r.people))
      .catch(() => setPeople([]));
  }, [social]);

  async function toggle(id: string) {
    const on = !followed.has(id);
    setError(null);
    setFollowed((s) => { const n = new Set(s); if (on) n.add(id); else n.delete(id); return n; });
    try {
      await social(on ? "PUT" : "DELETE", `follows/${id}`);
    } catch (e) {
      setFollowed((s) => { const n = new Set(s); if (on) n.delete(id); else n.add(id); return n; });
      setError(e instanceof Error ? e.message : String(e));
    }
  }

  return (
    <Scaffold
      title="Follow some callers"
      subtitle="Their takes show up in your Following feed. You can change this anytime."
      footer={<button className="obtn filled" onClick={finishOnboarding}>{followed.size ? "Continue" : "Skip for now"}</button>}
    >
      {error ? <div className="err">{error}</div> : null}
      {people == null ? <p className="muted">Finding people…</p> : null}
      {people?.length === 0 ? <p className="muted">No one to suggest yet. You can find people in Search.</p> : null}
      {people?.map((p) => (
        <div key={p.id} className="follow-row">
          <Avatar person={p} size={44} />
          <div className="follow-who">
            <div style={{ fontWeight: 600 }}>{p.display_name ?? p.handle}</div>
            <div className="muted small">@{p.handle}{p.reason ? ` · ${p.reason}` : ""}</div>
          </div>
          <button className={`pill small${followed.has(p.id) ? "" : " pill-on"}`} onClick={() => toggle(p.id)}>
            {followed.has(p.id) ? "Following" : "Follow"}
          </button>
        </div>
      ))}
    </Scaffold>
  );
}
