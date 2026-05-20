"use client";

import { useState } from "react";
import Image from "next/image";
import CountryDropdown from "./CountryDropdown";
import SegmentedControl from "./SegmentedControl";
import SubmitButton from "./SubmitButton";
import LoadingScreen from "./LoadingScreen";
import Toast, { type ToastKind, type ToastMessage } from "./Toast";

interface OnboardingScreenProps {
  wallet: string;
  onComplete: () => void;
}

const AGE_RANGES = ["18-24", "25-34", "35-44", "45-54", "55+"];
const GENDERS = [
  { label: "Male", value: "male" },
  { label: "Female", value: "female" },
  { label: "Prefer not to say", value: "prefer_not_to_say" },
];

export default function OnboardingScreen({ wallet, onComplete }: OnboardingScreenProps) {
  const [country, setCountry] = useState<string | null>(null);
  const [ageRange, setAgeRange] = useState<string | null>(null);
  const [gender, setGender] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [toast, setToast] = useState<ToastMessage | null>(null);

  const showToast = (message: string, kind: ToastKind = "info") => {
    setToast({ id: Date.now(), message, kind });
  };

  const canSubmit = country && ageRange;

  const handleSubmit = async () => {
    if (!canSubmit || submitting) return;

    setSubmitting(true);
    try {
      const res = await fetch(`/api/me/onboarding?wallet=${wallet}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          country,
          ageRange,
          ...(gender && { gender }),
        }),
      });

      if (res.status === 409) {
        onComplete();
        return;
      }

      if (!res.ok) {
        const data = await res.json();
        showToast(data.message || "Something went wrong. Please try again.", "error");
        return;
      }

      onComplete();
    } catch {
      showToast("Network error. Please check your connection and try again.", "error");
    } finally {
      setSubmitting(false);
    }
  };

  if (submitting) {
    return <LoadingScreen />;
  }

  return (
    <div className="min-h-screen bg-surface">
      <div className="mx-auto max-w-lg px-6 py-12">
        <div className="flex flex-col items-center text-center">
          <div className="mb-8 flex h-16 w-16 items-center justify-center rounded-full bg-primary-container">
            <Image src="/logo.png" alt="" width={40} height={40} className="rounded-full" />
          </div>
          <h1 className="font-headline text-2xl font-extrabold tracking-tight text-on-surface">
            Before you start
          </h1>
          <p className="mt-2 font-body text-base text-on-surface-variant">
            Help us improve AI fairness by sharing a few details.
          </p>
        </div>

        <div className="mt-10 space-y-6">
          <div className="space-y-2">
            <label className="font-label text-sm font-medium text-on-surface">
              Country <span className="text-error">*</span>
            </label>
            <CountryDropdown value={country} onChange={setCountry} required />
          </div>

          <div className="space-y-2">
            <label className="font-label text-sm font-medium text-on-surface">
              Age range <span className="text-error">*</span>
            </label>
            <SegmentedControl options={AGE_RANGES} selected={ageRange} onChange={setAgeRange} />
          </div>

          <div className="space-y-2">
            <label className="font-label text-sm font-medium text-on-surface">
              Gender <span className="text-outline">optional</span>
            </label>
            <SegmentedControl
              options={GENDERS}
              selected={gender}
              onChange={setGender}
              optional
            />
          </div>
        </div>

        <div className="mt-10">
          <SubmitButton
            label="Continue"
            icon="arrow_forward"
            onClick={handleSubmit}
            disabled={!canSubmit}
          />
        </div>
      </div>

      <Toast toast={toast} onDismiss={() => setToast(null)} />
    </div>
  );
}