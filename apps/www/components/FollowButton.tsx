"use client";
// Follow / Following on a public profile, for a signed-in visitor who isn't its owner. Whether you
// already follow them comes from your own following list (social GET following/<you>), since the
// page itself is cached for everyone.
import { useEffect, useState } from "react";
import { useSession } from "@/lib/session";

export default function FollowButton({ profileId }: { profileId: string }) {
  const { phase, snapshot, social } = useSession();
  const me = phase.kind === "ready" ? snapshot?.profile.id ?? null : null;
  const [on, setOn] = useState<boolean | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!me || me === profileId) return setOn(null);
    let live = true;
    social<{ people: { id: string }[] }>("GET", `following/${me}`)
      .then((r) => live && setOn(r.people.some((p) => p.id === profileId)))
      .catch(() => live && setOn(false));
    return () => { live = false; };
  }, [me, profileId, social]);

  if (!me || me === profileId || on == null) return null;

  async function toggle() {
    const next = !on;
    setBusy(true);
    setError(null);
    setOn(next);
    try {
      await social(next ? "PUT" : "DELETE", `follows/${profileId}`);
    } catch {
      setOn(!next);
      setError(next ? "Couldn't follow. Try again." : "Couldn't unfollow. Try again.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <button className={`btn ${on ? "ghost" : "light"}`} disabled={busy} aria-pressed={on} onClick={toggle}>
        {on ? "Following" : "Follow"}
      </button>
      {error ? <div className="err follow-err" role="alert">{error}</div> : null}
    </>
  );
}
