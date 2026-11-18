// Line icons in the spirit of the iOS app's SF Symbols (house, trophy, person, magnifying glass).
type P = { className?: string };
const base = { viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: 1.7, strokeLinecap: "round", strokeLinejoin: "round", "aria-hidden": true } as const;

export const HomeIcon = (p: P) => (
  <svg {...base} {...p}><path d="M3.5 10.5 12 3.5l8.5 7" /><path d="M5.5 9v10.5h4.5V14h4v5.5h4.5V9" /></svg>
);
export const TrophyIcon = (p: P) => (
  <svg {...base} {...p}><path d="M7 4h10v5a5 5 0 0 1-10 0V4Z" /><path d="M7 6H4v1.5A3.5 3.5 0 0 0 7.5 11M17 6h3v1.5a3.5 3.5 0 0 1-3.5 3.5" /><path d="M12 14v3.5M8.5 20.5h7M9.5 20.5c0-1.7 1.1-3 2.5-3s2.5 1.3 2.5 3" /></svg>
);
export const PersonIcon = (p: P) => (
  <svg {...base} {...p}><circle cx="12" cy="12" r="9" /><circle cx="12" cy="10" r="3.2" /><path d="M6.2 18.4c1.3-2 3.4-3.1 5.8-3.1s4.5 1.1 5.8 3.1" /></svg>
);
export const SearchIcon = (p: P) => (
  <svg {...base} {...p}><circle cx="10.5" cy="10.5" r="6.5" /><path d="m15.5 15.5 5 5" /></svg>
);
export const ShareIcon = (p: P) => (
  <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden {...p}><path d="M12 3v12M7 8l5-5 5 5M5 13v7h14v-7" /></svg>
);
export const CheckIcon = (p: P) => (
  <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden {...p}><path d="M5 12.5l4.5 4.5L19 7.5" /></svg>
);
