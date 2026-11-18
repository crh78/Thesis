import { avatar, type Person } from "@/lib/data";

export default function Avatar({ person, size = 44 }: { person: Pick<Person, "avatar_url" | "handle" | "deleted">; size?: number }) {
  // A deleted account: a plain, neutral circle (no photo, no letter).
  if (person.deleted) return <span className="avatar" style={{ width: size, height: size, background: "var(--tile)" }} aria-hidden />;
  const a = avatar(person.avatar_url);
  return (
    <span className="avatar" style={{ width: size, height: size, background: a.bg }}>
      {a.src ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img src={a.src} alt="" />
      ) : (
        <span style={{ color: "#07080B", fontWeight: 600 }}>{(person.handle ?? "?").slice(0, 1).toUpperCase()}</span>
      )}
    </span>
  );
}
