import type { Metadata, Viewport } from "next";
import Link from "next/link";
import "./globals.css";
import { Providers } from "./providers";

export const metadata: Metadata = {
  title: "Script-to-Video Studio",
  description: "Paste a script, review each step, get a finished video with captions, music, thumbnails and YouTube metadata.",
};

export const viewport: Viewport = { width: "device-width", initialScale: 1 };

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body className="min-h-screen">
        <Providers>
          <header className="border-b border-[var(--line)] bg-[var(--panel)]">
            <nav className="mx-auto flex max-w-7xl items-center gap-5 px-4 py-3 text-sm">
              <Link href="/" className="font-semibold">Script-to-Video Studio</Link>
              <Link href="/" className="text-[var(--muted)] hover:text-[var(--text)]">Projects</Link>
              <Link href="/music" className="text-[var(--muted)] hover:text-[var(--text)]">Music</Link>
              <Link href="/settings" className="text-[var(--muted)] hover:text-[var(--text)]">Settings</Link>
              <Link href="/projects/new" className="ml-auto rounded-md bg-[var(--accent)] px-3 py-1.5 font-medium text-white">New project</Link>
            </nav>
          </header>
          <main className="mx-auto max-w-7xl px-4 py-6">{children}</main>
        </Providers>
      </body>
    </html>
  );
}
