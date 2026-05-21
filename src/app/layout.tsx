import type { Metadata } from "next";
import { Inter, JetBrains_Mono } from "next/font/google";
import Image from "next/image";
import Link from "next/link";
import { ThemeProvider } from "next-themes";
import { CortexGitStatusIndicator } from "@/components/cortex-git-status";
import { ReviewsNavLink } from "@/components/reviews-nav-link";
import { ThemeSwitcher } from "@/components/theme-switcher";
import "./globals.css";

const inter = Inter({
  variable: "--font-inter",
  subsets: ["latin"],
});

const jetbrainsMono = JetBrains_Mono({
  variable: "--font-jetbrains-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: "Cortex City",
  description: "Cortex City — agent orchestrator",
  icons: {
    icon: "/logo-20260416-190413.png",
  },
};

const commitSha = process.env.NEXT_PUBLIC_CORTEX_COMMIT_SHA;
const shortCommitSha = commitSha?.slice(0, 7);

export default async function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html
      lang="en"
      className={`${inter.variable} ${jetbrainsMono.variable} h-full antialiased`}
      suppressHydrationWarning
    >
      <body className="min-h-full flex">
        <ThemeProvider attribute="class" defaultTheme="system" enableSystem>
          <nav className="w-56 border-r bg-muted/40 p-4 flex flex-col shrink-0">
            <Link
              href="/"
              className="mb-4 flex items-center gap-0 rounded-xl px-2 py-2 text-left transition-colors hover:bg-accent"
            >
              <Image
                src="/logo-20260416-190413.png"
                alt="Cortex City logo"
                width={88}
                height={88}
                className="rounded-xl"
                priority
              />
              <div className="min-w-0">
                <div className="font-semibold leading-tight whitespace-nowrap">
                  Cortex City
                </div>
              </div>
            </Link>
            <div className="flex flex-col gap-1 flex-1">
              <NavLink href="/issues">Issues</NavLink>
              <NavLink href="/">Tasks</NavLink>
              <ReviewsNavLink />
              <NavLink href="/agents">Agents</NavLink>
              <NavLink href="/sessions">Sessions</NavLink>
              <NavLink href="/settings">Settings</NavLink>
            </div>
            <CortexGitStatusIndicator />
            {shortCommitSha ? (
              <div
                className="mb-3 px-2 font-mono text-[11px] text-muted-foreground"
                title={commitSha}
              >
                {`commit ${shortCommitSha}`}
              </div>
            ) : null}
            <ThemeSwitcher />
          </nav>
          <main className="flex-1 p-6 overflow-auto">{children}</main>
        </ThemeProvider>
      </body>
    </html>
  );
}

function NavLink({
  href,
  children,
}: {
  href: string;
  children: React.ReactNode;
}) {
  return (
    <Link
      href={href}
      className="px-2 py-1.5 rounded-md text-sm hover:bg-accent transition-colors"
    >
      {children}
    </Link>
  );
}
