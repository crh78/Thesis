"use client";
// Edit profile, like the iOS EditProfileView: name and handle through the session, the bio through
// the social layer, and the photo on its own (the picker saves itself).
import { useEffect, useState } from "react";
import { supabaseKey, supabaseUrl } from "@/lib/data";
import { useSession } from "@/lib/session";
import Avatar from "./Avatar";
import { PhotoPicker } from "./Onboarding";

export default function EditProfile({ bio: initialBio, onClose, onSaved }: { bio: string; onClose: () => void; onSaved: () => void }) {
  const { snapshot, update, social } = useSession();
  const me = snapshot?.profile;
  const [name, setName] = useState(me?.display_name ?? "");
  const [handle, setHandle] = useState(me?.handle ?? "");
  const [bio, setBio] = useState(initialBio);
  const [taken, setTaken] = useState<boolean | null>(null);
  const [photo, setPhoto] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleChanged = handle !== (me?.handle ?? "");
  const nameChanged = name.trim() !== (me?.display_name ?? "");
  const bioChanged = bio.trim() !== initialBio.trim();

  // Check a new handle as it's typed.
  useEffect(() => {
    setTaken(null);
    if (!handleChanged || handle.length < 3) return;
    const id = window.setTimeout(async () => {
      const r = await fetch(`${supabaseUrl()}/rest/v1/profiles?select=id&handle=eq.${encodeURIComponent(handle)}&limit=1`, { headers: { apikey: supabaseKey() } }).catch(() => null);
      if (r?.ok) setTaken(((await r.json()) as unknown[]).length > 0);
    }, 350);
    return () => window.clearTimeout(id);
  }, [handle, handleChanged]);

  async function save() {
    setError(null);
    setBusy(true);
    try {
      // Name and handle first: if the handle turns out to be taken, nothing else saves.
      if (nameChanged || handleChanged) await update({ display_name: name.trim(), handle });
      if (bioChanged) await social("PATCH", "profile", { bio: bio.trim() || null });
      onSaved();
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Couldn't save. Try again.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="sheet-wrap" onClick={(e) => e.target === e.currentTarget && !busy && onClose()}>
      <div className="sheet" role="dialog" aria-label="Edit profile">
        <button className="x" aria-label="Close" onClick={onClose}>×</button>
        <h3>{photo ? "Profile photo" : "Edit profile"}</h3>
        {photo ? (
          <PhotoPicker mode="edit" onDone={() => setPhoto(false)} />
        ) : (
          <>
            <div className="photo-preview" style={{ marginTop: 12 }}>
              {me ? <Avatar person={me} size={84} /> : null}
              <button className="pill small" style={{ marginTop: 10 }} onClick={() => setPhoto(true)}>Change photo</button>
            </div>
            <label className="caps" htmlFor="ep-name">Name</label>
            <input id="ep-name" className="uline" maxLength={50} value={name} onChange={(e) => setName(e.target.value)} />
            <label className="caps" htmlFor="ep-handle" style={{ display: "block", marginTop: 16 }}>Handle</label>
            <div className="uline-wrap">
              <span className="muted">@</span>
              <input id="ep-handle" className="uline" maxLength={20} autoCapitalize="none" autoCorrect="off" spellCheck={false} value={handle} onChange={(e) => setHandle(e.target.value.toLowerCase().replace(/[^a-z0-9_]/g, ""))} />
            </div>
            <div className={`small ${taken ? "down" : "muted"}`} style={{ marginTop: 6 }}>
              {handle.length < 3 ? "At least 3 characters." : taken ? `@${handle} is taken.` : "Letters, numbers and underscores."}
            </div>
            <label className="caps" htmlFor="ep-bio" style={{ display: "block", marginTop: 16 }}>Bio</label>
            <textarea id="ep-bio" className="uline" rows={2} maxLength={160} value={bio} onChange={(e) => setBio(e.target.value)} />
            <div className="small muted" style={{ textAlign: "right" }}>{bio.length}/160</div>
            {error ? <div className="err">{error}</div> : null}
            <button
              className="obtn filled"
              style={{ marginTop: 12 }}
              disabled={busy || !name.trim() || handle.length < 3 || taken === true || !(nameChanged || handleChanged || bioChanged)}
              onClick={save}
            >
              {busy ? "Saving…" : "Save"}
            </button>
          </>
        )}
      </div>
    </div>
  );
}
