"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useState } from "react";

const TABS_SUPER_ADMIN = [
  { href: "/admin/tasks", label: "Tasks" },
  { href: "/admin/wallets", label: "Wallets" },
  { href: "/admin/customers", label: "Customers" },
];

const TABS_CUSTOMER = [
  { href: "/admin/campaigns", label: "Campaigns" },
  { href: "/admin/wallets", label: "Wallets" },
];

export default function AdminNav() {
  const pathname = usePathname();
  const [tabs, setTabs] = useState<typeof TABS_SUPER_ADMIN>([]);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    fetch("/api/admin/auth/me")
      .then((res) => res.ok ? res.json() : null)
      .then((data) => {
        if (data?.role === "CUSTOMER") {
          setTabs(TABS_CUSTOMER);
        } else {
          setTabs(TABS_SUPER_ADMIN);
        }
        setLoaded(true);
      })
      .catch(() => setLoaded(true));
  }, []);

  if (!loaded) return null;

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