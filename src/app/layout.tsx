import type { Metadata } from "next";
import { Inter, JetBrains_Mono } from "next/font/google";
import Image from "next/image";
import Link from "next/link";
import { ThemeProvider } from "next-themes";
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
    icon: "/logo.png",
  },
};

export default function RootLayout({
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
              className="mb-4 flex items-center gap-3 rounded-xl px-2 py-1.5 transition-colors hover:bg-accent"
            >
              <Image
                src="/logo.png"
                alt="Cortex City logo"
                width={40}
                height={40}
                className="rounded-xl border border-border/60 shadow-sm"
                priority
              />
              <div className="min-w-0">
                <div className="font-semibold leading-tight">Cortex City</div>
                <div className="text-xs text-muted-foreground leading-tight">
                  Agent orchestrator
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
