import AppGate from "@/components/AppGate";

// The tabs (Home, Scores, Me, Search) need an account: signed-out visitors get the welcome screen.
// Take, called-it and profile pages stay public for shared links.
export default function TabsLayout({ children }: { children: React.ReactNode }) {
  return <AppGate>{children}</AppGate>;
}
