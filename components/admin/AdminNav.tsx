"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

const TABS_SUPER_ADMIN = [
  { href: "/admin/campaigns", label: "Campaigns" },
  { href: "/admin/tasks", label: "Tasks" },
  { href: "/admin/users", label: "Users" },
  { href: "/admin/wallets", label: "Wallets" },
  { href: "/admin/customers", label: "Customers" },
  { href: "/admin/disputes", label: "Disputes" },
  { href: "/admin/flagged-withdrawals", label: "Flagged" },
  { href: "/admin/status-health", label: "Status" },
  { href: "/admin/ops", label: "Ops" },
];

const TABS_CUSTOMER = [
  { href: "/admin/campaigns", label: "Campaigns" },
];

interface AdminNavProps {
  role: "SUPER_ADMIN" | "CUSTOMER";
}

export default function AdminNav({ role }: AdminNavProps) {
  const pathname = usePathname();
  const tabs = role === "CUSTOMER" ? TABS_CUSTOMER : TABS_SUPER_ADMIN;

  return (
    <nav className="flex items-center gap-1">
      {tabs.map((tab) => {
        const active = pathname.startsWith(tab.href);
        return (
          <Link
            key={tab.href}
            href={tab.href}
            className={`rounded-full px-4 py-2 font-label text-sm font-semibold transition-colors ${
              active
                ? "bg-primary text-on-primary"
                : "text-on-surface-variant hover:bg-surface-container-low"
            }`}
          >
            {tab.label}
          </Link>
        );
      })}
    </nav>
  );
}
