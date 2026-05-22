"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { cn } from "@/lib/utils";

type SidebarNavLinkProps = {
  href: string;
  children: React.ReactNode;
  match?: string[];
};

export function isSidebarNavLinkActive(
  pathname: string | null,
  match: string[]
): boolean {
  const currentPath = pathname || "/";

  return match.some((sectionPath) => {
    if (sectionPath === "/") return currentPath === "/";
    return (
      currentPath === sectionPath || currentPath.startsWith(`${sectionPath}/`)
    );
  });
}

export function SidebarNavLink({
  href,
  children,
  match = [href],
}: SidebarNavLinkProps) {
  const pathname = usePathname();
  const isActive = isSidebarNavLinkActive(pathname, match);

  return (
    <Link
      href={href}
      aria-current={isActive ? "page" : undefined}
      className={cn(
        "flex items-center justify-between gap-2 rounded-md px-2 py-1.5 text-sm transition-colors",
        isActive
          ? "bg-primary text-primary-foreground font-medium shadow-sm hover:bg-primary/90"
          : "hover:bg-accent"
      )}
    >
      {children}
    </Link>
  );
}
