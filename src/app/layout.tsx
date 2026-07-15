import type { Metadata } from "next";

import "./globals.css";

export const metadata: Metadata = {
  title: "Personal English Lab",
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
