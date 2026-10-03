import Image from "next/image";

/**
 * The wait between two screens inside the app: after sign-in, before a task,
 * while onboarding saves. It promises no layout, since the next screen could
 * be any of several. It stays blank for a moment first, so a quick
 * transition passes without a flash.
 */
export default function ScreenLoader() {
  return (
    <div role="status" aria-busy="true" className="flex min-h-screen items-center justify-center bg-surface">
      <span className="sr-only">Loading</span>
      <div
        aria-hidden="true"
        className="relative flex h-20 w-20 items-center justify-center motion-safe:animate-[screen-loader-in_300ms_ease-out_200ms_both]"
      >
        <span className="absolute inset-0 rounded-full border-[3px] border-surface-container-high" />
        <span className="absolute inset-0 rounded-full border-[3px] border-transparent border-t-primary motion-safe:animate-spin" />
        <Image src="/logo.png" alt="" width={40} height={40} priority className="select-none" />
      </div>
    </div>
  );
}
