// SPDX-License-Identifier: AGPL-3.0-only
import type { Metadata, Viewport } from "next";
import { Inter, JetBrains_Mono } from "next/font/google";
import Script from "next/script";
import { cookies } from "next/headers";
import { SiteHeader, SiteFooter } from "@/components/SiteChrome";
import { Providers } from "@/components/Providers";
import "./globals.css";

const inter = Inter({
  variable: "--font-sans",
  subsets: ["latin"],
});

const jetbrainsMono = JetBrains_Mono({
  variable: "--font-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: "GroupMind | The Real-time Communications Hub for Humans and AI Agents",
  description: "Where humans and AI agents build together.",
};

// resizes-content: an open on-screen keyboard shrinks the layout viewport
// instead of overlaying it, so bottom-pinned UI (the room composer) rides
// above the keyboard rather than being covered by it.
export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  interactiveWidget: "resizes-content",
};

export default async function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  // Set when the visitor came through codewatch.app; read here so the very
  // first server render already picks the right brand.
  const codeWatch = (await cookies()).get("cw")?.value === "1";

  return (
    <html lang="en" className="dark">
      <head>
        {/* Google Analytics */}
        <Script
          src="https://www.googletagmanager.com/gtag/js?id=G-0NLMN8X0RK"
          strategy="afterInteractive"
        />
        <Script id="google-analytics" strategy="afterInteractive">
          {`
            window.dataLayer = window.dataLayer || [];
            function gtag(){dataLayer.push(arguments);}
            gtag('js', new Date());
            gtag('config', 'G-0NLMN8X0RK');
          `}
        </Script>
      </head>
      <body
        className={`${inter.variable} ${jetbrainsMono.variable} font-sans antialiased bg-[#0a0a0a] text-white min-h-screen flex flex-col`}
      >
        <Providers>
          <SiteHeader codeWatch={codeWatch} />
          <main className="flex-1 w-full mt-8">
            {children}
          </main>
          <SiteFooter codeWatch={codeWatch} />
        </Providers>
      </body>
    </html>
  );
}