"use client";
import { PrivyProvider } from "@privy-io/react-auth";
import { ComposerProvider } from "@/components/Composer";
import SessionScreens from "@/components/SessionScreens";
import { X_LOGIN } from "@/lib/flags";
import { SessionProvider } from "@/lib/session";

// The same Privy app as the iOS app, so the same email or Google account reaches the same embedded
// Solana wallet and Thesis profile. X sign-in maps a reply to @thesis on X to that wallet.
// Required setting (apps/www/.env.example), inlined at build time. Without it the build still
// succeeds, and every page says what's missing instead of loading the app.
const APP_ID = process.env.NEXT_PUBLIC_PRIVY_APP_ID;

export default function Providers({ children }: { children: React.ReactNode }) {
  if (!APP_ID) {
    return (
      <main style={{ padding: 24, fontFamily: "system-ui, sans-serif" }}>
        NEXT_PUBLIC_PRIVY_APP_ID is not set (see apps/www/.env.example).
      </main>
    );
  }
  return (
    <PrivyProvider
      appId={APP_ID}
      config={{
        // X only once it's switched on in Privy (lib/flags.ts).
        loginMethods: X_LOGIN ? ["twitter", "google", "email"] : ["google", "email"],
        appearance: { theme: "dark", accentColor: "#A9E3BA", walletChainType: "solana-only" },
        embeddedWallets: { solana: { createOnLogin: "users-without-wallets" }, ethereum: { createOnLogin: "off" } },
      }}
    >
      <SessionProvider>
        <ComposerProvider>
          {children}
          <SessionScreens />
        </ComposerProvider>
      </SessionProvider>
    </PrivyProvider>
  );
}
