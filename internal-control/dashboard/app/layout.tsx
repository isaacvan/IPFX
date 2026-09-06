import "./globals.css";
import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "IPFX Capital — Internal Control",
  robots: { index: false, follow: false }, // owner-only; never let this get indexed
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
