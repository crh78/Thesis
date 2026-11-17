// Shared bits for the link-preview images (iMessage, X, Slack unfurls), drawn with next/og.
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { avatar, type Person } from "@/lib/data";

export const OG_SIZE = { width: 1200, height: 630 };

const root = process.cwd();

export async function ogFonts() {
  const font = (f: string) => readFile(join(root, "app/fonts", f));
  const [regular, semibold, mono, serif] = await Promise.all([
    font("Geist-Regular.ttf"),
    font("Geist-SemiBold.ttf"),
    font("GeistMono-Medium.ttf"),
    font("GeistSerif-Regular.ttf"),
  ]);
  return [
    { name: "Geist", data: regular, weight: 400 as const, style: "normal" as const },
    { name: "Geist", data: semibold, weight: 600 as const, style: "normal" as const },
    { name: "Geist Mono", data: mono, weight: 500 as const, style: "normal" as const },
    { name: "Geist Serif", data: serif, weight: 400 as const, style: "normal" as const },
  ];
}

/** The avatar as something <img> in next/og can draw: the bundled face as a data URL, or the photo URL. */
export async function ogAvatar(person: Pick<Person, "avatar_url">): Promise<{ src: string | null; bg: string }> {
  const a = avatar(person.avatar_url);
  if (!a.src) return a;
  if (a.src.startsWith("/avatars/")) {
    const png = await readFile(join(root, "public", a.src)).catch(() => null);
    return { src: png ? `data:image/png;base64,${png.toString("base64")}` : null, bg: a.bg };
  }
  return /^https:\/\//.test(a.src) ? a : { src: null, bg: a.bg };
}

export const INK = { bg: "#07080B", text: "#F2F3F5", muted: "#9AA0AA", up: "#A6E3B8", down: "#F2A9C2", hairline: "rgba(255,255,255,0.12)" };

export function OgAvatar({ a, letter, size }: { a: { src: string | null; bg: string }; letter: string; size: number }) {
  return (
    <div style={{ width: size, height: size, borderRadius: size, background: a.bg, display: "flex", alignItems: "center", justifyContent: "center", overflow: "hidden" }}>
      {a.src ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img src={a.src} width={size} height={size} alt="" style={{ objectFit: "cover" }} />
      ) : (
        <span style={{ color: INK.bg, fontSize: size * 0.45, fontWeight: 600 }}>{letter}</span>
      )}
    </div>
  );
}

/** Geist has no ✓, so the preview draws its own. */
export function Check({ size, color }: { size: number; color: string }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none">
      <path d="M5 12.5l4.5 4.5L19 7.5" stroke={color} strokeWidth={3} strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}
