// /robots.txt: takes, profiles and the homepage are public and shareable; the API routes and the
// signed-in screens aren't for crawlers.
import type { MetadataRoute } from "next";

export default function robots(): MetadataRoute.Robots {
  return {
    rules: { userAgent: "*", allow: "/", disallow: ["/api/", "/me", "/settings", "/saved", "/people/", "/x"] },
  };
}
