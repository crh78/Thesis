"use client";
// Shares this page: the phone's share sheet when there is one (iMessage, etc.), else copies the link.
import { useState } from "react";

// `url`: a path to share instead of this page (Me shares your public profile, /u/<handle>).
export default function ShareButton({ text, label = "Share", className = "btn light", url: path }: { text: string; label?: string; className?: string; url?: string }) {
  const [copied, setCopied] = useState(false);

  async function share() {
    const url = path ? new URL(path, window.location.origin).toString() : window.location.href.split("#")[0];
    if (navigator.share) {
      try {
        await navigator.share({ text, url });
        return;
      } catch (e) {
        if ((e as Error).name === "AbortError") return;
      }
    }
    try {
      await navigator.clipboard.writeText(`${text} ${url}`);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1800);
    } catch {
      window.prompt("Copy this link", url);
    }
  }

  return (
    <button className={className} onClick={share}>
      {copied ? "Link copied" : label}
    </button>
  );
}
