import type { Metadata } from "next";
import { Manrope, Inter } from "next/font/google";
import { ErrorBoundary } from "@sentry/nextjs";
import PostHogProvider from "@/components/PostHogProvider";
import MiniPaySimulator from "@/components/MiniPaySimulator";
import { Toaster } from "sonner";
import "./globals.css";

const manrope = Manrope({
  subsets: ["latin"],
  weight: ["400", "500", "600", "700", "800"],
  variable: "--font-headline",
});

const inter = Inter({
  subsets: ["latin"],
  weight: ["400", "500", "600", "700"],
  variable: "--font-body",
});

export const metadata: Metadata = {
  metadataBase: new URL("https://centient.work"),
  title: "Centient",
  description: "Train AI, cent by cent.",
  icons: {
    icon: "/favicon.ico",
    apple: "/apple-touch-icon.png",
  },
  manifest: "/site.webmanifest",
  openGraph: {
    title: "Centient",
    description: "Train AI, cent by cent.",
    url: "https://centient.work",
    siteName: "Centient",
    images: [
      {
        url: "/og-image.png",
        width: 1200,
        height: 630,
        alt: "Centient — train AI, cent by cent.",
      },
    ],
    type: "website",
  },
  twitter: {
    card: "summary_large_image",
    title: "Centient",
    description: "Train AI, cent by cent.",
    images: ["/og-image.png"],
  },
};

function ErrorFallback() {
  return (
    <div className="flex min-h-dvh items-center justify-center bg-surface px-6">
      <div className="flex max-w-sm flex-col items-center gap-4 text-center">
        <div className="flex h-24 w-24 items-center justify-center rounded-full bg-error-container">
          <span
            className="material-symbols-outlined text-[48px] text-on-error-container"
            aria-hidden="true"
          >
            error_outline
          </span>
        </div>
        <h1 className="font-headline text-2xl font-bold text-on-surface">
          Something went wrong
        </h1>
        <p className="font-body text-sm text-on-surface-variant">
          An unexpected error occurred. Please reload the page and try again.
        </p>
      </div>
    </div>
  );
}

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={`${manrope.variable} ${inter.variable}`}>
      <head>
        <link
          rel="stylesheet"
          href="https://fonts.googleapis.com/css2?family=Material+Symbols+Outlined:opsz,wght,FILL,GRAD@20..48,100..700,0..1,-50..200&display=swap"
        />
      </head>
      <body className="bg-surface text-on-surface antialiased">
        <MiniPaySimulator />
        <ErrorBoundary fallback={<ErrorFallback />}>
          <PostHogProvider>
            {children}
            <Toaster position="bottom-right" richColors />
          </PostHogProvider>
        </ErrorBoundary>
      </body>
    </html>
  );
}
