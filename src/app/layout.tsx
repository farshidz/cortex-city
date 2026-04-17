import type { Metadata } from "next";
import { Inter, JetBrains_Mono } from "next/font/google";
import Image from "next/image";
import Link from "next/link";
import { ThemeProvider } from "next-themes";
import { ThemeSwitcher } from "@/components/theme-switcher";
import { getCortexGitStatus } from "@/lib/cortex-git";
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

export default async function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  const cortexGit = getCortexGitStatus();

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
              <NavLink href="/">Tasks</NavLink>
              <NavLink href="/tasks/new">New Task</NavLink>
              <NavLink href="/agents">Agents</NavLink>
              <NavLink href="/sessions">Sessions</NavLink>
              <NavLink href="/settings">Settings</NavLink>
            </div>
            {cortexGit.pushing && (
              <div className="mb-3 rounded-lg border bg-background/70 px-3 py-2 text-xs">
                <div className="text-muted-foreground">
                  State snapshots auto-sync to{" "}
                  <span className="font-mono text-[11px] text-foreground">
                    {cortexGit.remoteSlug ||
                      cortexGit.remoteName ||
                      "configured remote"}
                  </span>
                </div>
              </div>
            )}
            {!cortexGit.enabled && (
              <div className="mb-3 rounded-lg border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-xs text-amber-900 dark:text-amber-200">
                State snapshots not synced as `.cortex` is not a git repository.
              </div>
            )}
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
