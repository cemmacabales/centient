"use client";

import Image from "next/image";

export default function LoadingScreen() {
  return (
    <div className="relative flex min-h-screen flex-col items-center justify-center bg-surface px-6 text-center">
      <div className="pointer-events-none absolute inset-0 z-0 overflow-hidden">
        <div className="absolute -right-[10%] -top-[20%] h-[80vw] w-[80vw] rounded-full bg-primary/5 blur-[100px]" />
        <div className="absolute -left-[20%] top-[40%] h-[70vw] w-[70vw] rounded-full bg-secondary/5 blur-[80px]" />
      </div>
      <div className="relative z-10 flex flex-col items-center gap-6">
        <Image
          src="/logo.png"
          alt=""
          width={120}
          height={120}
          priority
          className="select-none drop-shadow-[0_8px_24px_rgba(0,109,61,0.15)]"
        />
        <span className="text-4xl font-headline font-extrabold tracking-tighter text-primary">
          Centient
        </span>
        <p className="font-body text-sm text-on-surface-variant">
          Train AI, cent by cent.
        </p>
        <span className="flex gap-1" aria-label="Loading">
          {[0, 1, 2].map((i) => (
            <span
              key={i}
              className="h-2.5 w-2.5 rounded-full bg-primary motion-safe:animate-bounce"
              style={{ animationDelay: `${i * 0.15}s` }}
            />
          ))}
        </span>
      </div>
    </div>
  );
}
