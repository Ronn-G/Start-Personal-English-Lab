import type { Metadata } from "next";

import "./globals.css";

export const metadata: Metadata = {
  title: "Personal English Lab",
  applicationName: "Personal English Lab",
  icons: {
    icon: [
      { url: "/icons/app-logo-16.png", sizes: "16x16", type: "image/png" },
      { url: "/icons/app-logo-32.png", sizes: "32x32", type: "image/png" },
      { url: "/icons/app-logo-192.png", sizes: "192x192", type: "image/png" },
    ],
    apple: [{ url: "/apple-icon.png", sizes: "192x192", type: "image/png" }],
  },
  description: "Tạo bài học tiếng Anh từ transcript YouTube bạn tự dán.",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="vi" className="h-full antialiased" suppressHydrationWarning>
      <head>
        <script
          dangerouslySetInnerHTML={{
            __html: `(function(){try{var t=localStorage.getItem("personal-english-lab-theme");document.documentElement.dataset.theme=t==="b"||t==="c"?t:"a"}catch(e){}})()`,
          }}
        />
      </head>
      <body className="flex min-h-full flex-col font-sans">{children}</body>
    </html>
  );
}
