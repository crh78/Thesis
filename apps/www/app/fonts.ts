import localFont from "next/font/local";

// The iOS app's fonts (Geist, Geist Mono, Geist Serif; SIL OFL, see fonts/OFL.txt).
export const sans = localFont({
  src: [
    { path: "./fonts/Geist-Regular.ttf", weight: "400" },
    { path: "./fonts/Geist-Medium.ttf", weight: "500" },
    { path: "./fonts/Geist-SemiBold.ttf", weight: "600" },
  ],
  variable: "--font-sans",
});
export const mono = localFont({
  src: [
    { path: "./fonts/GeistMono-Regular.ttf", weight: "400" },
    { path: "./fonts/GeistMono-Medium.ttf", weight: "500" },
  ],
  variable: "--font-mono",
});
export const serif = localFont({ src: "./fonts/GeistSerif-Regular.ttf", variable: "--font-serif" });
// The wordmark `thesis` and "Called it", as in the iOS app.
export const pixel = localFont({ src: "./fonts/GeistPixel-Square.ttf", variable: "--font-pixel" });
