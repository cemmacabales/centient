"use client";

import { useState } from "react";
import AddCustomerModal from "./AddCustomerModal";

export default function AddCustomerButton() {
  const [open, setOpen] = useState(false);
  async function handleAdd(data: { email: string; password: string; companyName: string }) {
    const res = await fetch("/api/admin/customers", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(data),
    });
    const body = await res.json();
    if (!res.ok) throw new Error(body.error || "failed");
    return { emailDelivered: body.emailDelivered, warning: body.warning };
  }
  return (
    <>
      <button
        onClick={() => setOpen(true)}
        className="flex items-center gap-2 rounded-xl bg-primary px-4 py-2 font-label text-sm font-semibold text-on-primary transition-opacity hover:opacity-90 active:scale-[0.97]"
      >
        <span className="material-symbols-outlined text-[18px]">add</span>
        Add Customer
      </button>
      {open && <AddCustomerModal onAdd={handleAdd} onClose={() => {setOpen(false); window.location.reload();}} />}
    </>
  );
}
