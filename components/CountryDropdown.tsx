"use client";

import { useState, useRef, useEffect } from "react";
import { COUNTRIES } from "@/lib/countries";

interface CountryDropdownProps {
  value: string | null;
  onChange: (code: string) => void;
  required?: boolean;
}

export default function CountryDropdown({ value, onChange, required = false }: CountryDropdownProps) {
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);

  const selectedCountry = COUNTRIES.find((c) => c.code === value);

  const filtered = COUNTRIES.filter(
    (c) =>
      c.name.toLowerCase().includes(search.toLowerCase()) ||
      c.code.toLowerCase().includes(search.toLowerCase())
  );

  useEffect(() => {
    if (open && inputRef.current) {
      inputRef.current.focus();
    }
  }, [open]);

  useEffect(() => {
    function handleClickOutside(event: MouseEvent) {
      if (containerRef.current && !containerRef.current.contains(event.target as Node)) {
        setOpen(false);
        setSearch("");
      }
    }
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, []);

  return (
    <div ref={containerRef} className="relative">
      <button
        type="button"
        onClick={() => setOpen(!open)}
        className={`flex h-14 w-full items-center justify-between rounded-2xl border-2 px-4 transition-colors ${
          open
            ? "border-primary bg-surface-container"
            : selectedCountry
            ? "border-outline bg-surface-container-low"
            : "border-outline-variant bg-surface-container-low hover:border-outline"
        }`}
        aria-haspopup="listbox"
        aria-expanded={open}
      >
        <span className={`font-body text-base ${selectedCountry ? "text-on-surface" : "text-on-surface-variant"}`}>
          {selectedCountry ? `${selectedCountry.name} (${selectedCountry.code})` : "Select country"}
        </span>
        <span className="material-symbols-outlined text-[20px] text-on-surface-variant">
          {open ? "expand_less" : "expand_more"}
        </span>
      </button>

      {open && (
        <div className="absolute z-50 mt-2 w-full rounded-2xl border border-outline-variant bg-surface-container-lowest shadow-[0_8px_32px_rgba(25,28,30,0.16)]">
          <div className="p-2">
            <div className="flex items-center gap-2 rounded-xl bg-surface-container px-3 py-2">
              <span className="material-symbols-outlined text-[20px] text-on-surface-variant">
                search
              </span>
              <input
                ref={inputRef}
                type="text"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="Search country..."
                className="flex-1 bg-transparent font-body text-base text-on-surface placeholder:text-on-surface-variant focus:outline-none"
              />
            </div>
          </div>
          <div className="max-h-64 overflow-y-auto p-2">
            {filtered.length === 0 ? (
              <p className="p-4 text-center font-body text-sm text-on-surface-variant">No country found</p>
            ) : (
              <ul role="listbox" className="space-y-0.5">
                {filtered.map((country) => (
                  <li key={country.code}>
                    <button
                      type="button"
                      onClick={() => {
                        onChange(country.code);
                        setOpen(false);
                        setSearch("");
                      }}
                      className={`flex w-full items-center justify-between rounded-xl px-3 py-2.5 font-body text-base transition-colors ${
                        value === country.code
                          ? "bg-primary text-on-primary"
                          : "text-on-surface hover:bg-surface-container"
                      }`}
                      role="option"
                      aria-selected={value === country.code}
                    >
                      <span>{country.name}</span>
                      <span className="font-label text-sm opacity-60">{country.code}</span>
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </div>
      )}
    </div>
  );
}