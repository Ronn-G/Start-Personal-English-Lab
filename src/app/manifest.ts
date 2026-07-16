import type { MetadataRoute } from "next";

export default function manifest(): MetadataRoute.Manifest {
  return {
    name: "Personal English Lab",
    short_name: "English Lab",
    description: "Tạo và luyện bài học tiếng Anh cá nhân từ transcript YouTube.",
    start_url: "/",
    display: "standalone",
    background_color: "#f8fafc",
    theme_color: "#2563eb",
    icons: [
      { src: "/icons/app-logo-192.png", sizes: "192x192", type: "image/png" },
      { src: "/icons/app-logo-256.png", sizes: "256x256", type: "image/png" },
      { src: "/icons/app-logo-512.png", sizes: "512x512", type: "image/png" },
    ],
  };
}
