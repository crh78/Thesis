import type { MetadataRoute } from "next";

// Lets people add Thesis to their home screen and open it full screen, like an app.
export default function manifest(): MetadataRoute.Manifest {
  return {
    id: "/",
    name: "Thesis",
    short_name: "Thesis",
    description: "Say a take. Friends trade it or fade it, and the chain keeps score.",
    start_url: "/",
    scope: "/",
    display: "standalone",
    orientation: "portrait",
    background_color: "#07080B",
    theme_color: "#07080B",
    icons: [
      { src: "/icons/icon-192.png", sizes: "192x192", type: "image/png" },
      { src: "/icons/icon-512.png", sizes: "512x512", type: "image/png" },
    ],
  };
}
