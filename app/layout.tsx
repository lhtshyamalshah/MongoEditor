import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Mongo Browser — Your data, in view",
  description: "A local workspace to browse, search, and edit your MongoDB and Amazon DocumentDB collections.",
  robots: { index: false, follow: false }
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return <html lang="en"><body>{children}</body></html>;
}
