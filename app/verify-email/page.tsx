"use client";
import { Suspense } from "react";
import { useSearchParams, useRouter } from "next/navigation";
import { useEffect, useState } from "react";

function VerifyEmailContent() {
    const searchParams = useSearchParams();
    const router = useRouter();
    const token = searchParams.get("token");
    const [status, setStatus] = useState< "loading" | "success" | "error" >("loading");
    useEffect(() => {
        if (!token) {
            setStatus("error");
            return;
        }
        fetch("/api/verify-email", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ token }),
        }).then((res) => {
            if (res.ok) setStatus("success");
            else setStatus("error");
        }).catch(() => setStatus("error"));
    }, [token]);
    if (status === "success"){
        return(
            <div className="flex min-h-screen flex-col items-center justify-center bg-surface text-center">
                <div className="rounded-full bg-green-100 p-4">
                    <svg className="h-12 w-12 text-green-600" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
                    </svg>
                </div>
                <h1 className="mt-4 text-2xl font-bold text-on-surface">Email Verified!</h1>
                <p className="mt-2 text-on-surface-variant">Your account is now active. Sign in to start earning.</p>
                <a href="/" className="mt-6 rounded-full bg-primary px-6 py-2.5 font-label text-sm font-semibold text-on-primary">
                    Go to sign in
                </a>
                <a href="/admin/login" className="mt-3 font-label text-sm font-semibold text-on-surface-variant underline-offset-2 hover:underline">
                    Admin? Sign in here
                </a>
            </div>
        );
    }
    if (status === "error"){
        return(
            <div className="flex min-h-screen flex-col items-center justify-center bg-surface text-center">
                <div className="rounded-full bg-red-100 p-4">
                    <svg className="h-12 w-12 text-red-600" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                    </svg>
                </div>
                <h1 className="mt-4 text-2xl font-bold text-on-surface">Verification Failed</h1>
                <p className="mt-2 max-w-sm text-on-surface-variant">
                    {token ? "This link is invalid or has expired." : "Missing verification token."}
                </p>
                <a href="/admin/login" className="mt-6 rounded-full bg-surface-container-high px-6 py-2.5 font-label text-sm font-semibold text-on-surface">
                    Back to Login
                </a>
            </div>
        );
    }
    return (
        <div className="flex min-h-screen flex-col items-center justify-center bg-surface">
            <div className="h-8 w-8 animate-spin rounded-full border-4 border-primary border-t-transparent"></div>
            <p className="mt-4 text-on-surface-variant">Verifying your email...</p>
        </div>
    );
}

function Loading() {
    return (
        <div className="flex min-h-screen flex-col items-center justify-center bg-surface">
            <div className="h-8 w-8 animate-spin rounded-full border-4 border-primary border-t-transparent"></div>
            <p className="mt-4 text-on-surface-variant">Loading...</p>
        </div>
    );
}

export default function VerifyEmailPage() {
    return (
        <Suspense fallback={<Loading />}>
            <VerifyEmailContent />
        </Suspense>
    );
}
