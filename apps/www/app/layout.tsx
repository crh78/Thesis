import type { Metadata, Viewport } from "next";
import { Suspense } from "react";
import DesktopPanel from "@/components/DesktopPanel";
import TabBar from "@/components/TabBar";
import { mono, pixel, sans, serif } from "./fonts";
import Providers from "./providers";
import "./globals.css";

// Link previews need absolute URLs. On Vercel the production URL is the project's custom domain
// (yourthesis.xyz), or the project's vercel.app URL before a domain is added.
const SITE =
  process.env.NEXT_PUBLIC_SITE_URL ??
  (process.env.VERCEL_PROJECT_PRODUCTION_URL ? `https://${process.env.VERCEL_PROJECT_PRODUCTION_URL}` : "http://localhost:3100");

const DESCRIPTION = "Say a take. Friends trade it or fade it, and the chain keeps score.";

export const metadata: Metadata = {
  metadataBase: new URL(SITE),
  title: "Thesis",
  description: DESCRIPTION,
  applicationName: "Thesis",
  // The homepage's link preview (it's the X bot's bio link). Pages with their own preview (takes,
  // profiles, drafts, called-it cards) override it; the image is app/opengraph-image.tsx.
  openGraph: { type: "website", siteName: "Thesis", title: "Thesis", description: DESCRIPTION },
  twitter: { card: "summary_large_image", title: "Thesis", description: DESCRIPTION },
  // Added to the home screen, it opens full screen with its own icon (app/apple-icon.png).
  appleWebApp: { capable: true, title: "Thesis", statusBarStyle: "default" },
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover",
  themeColor: [
    { media: "(prefers-color-scheme: dark)", color: "#07080B" },
    { media: "(prefers-color-scheme: light)", color: "#F6F7F9" },
  ],
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={`${sans.variable} ${mono.variable} ${serif.variable} ${pixel.variable}`}>
      <body>
        <Providers>
          {children}
          <TabBar />
        </Providers>
        <Suspense fallback={null}>
          <DesktopPanel />
        </Suspense>
      </body>
    </html>
  );
}
