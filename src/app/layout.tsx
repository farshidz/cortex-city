import type { Metadata } from "next";
import { Inter, JetBrains_Mono } from "next/font/google";
import Image from "next/image";
import Link from "next/link";
import { ThemeProvider } from "next-themes";
import { CortexGitStatusIndicator } from "@/components/cortex-git-status";
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
              <NavLink href="/">Tasks</NavLink>
              <NavLink href="/tasks/new">New Task</NavLink>
              <NavLink href="/agents">Agents</NavLink>
              <NavLink href="/sessions">Sessions</NavLink>
              <NavLink href="/settings">Settings</NavLink>
            </div>
            <CortexGitStatusIndicator />
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
