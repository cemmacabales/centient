"use client";

import { useState, type ReactNode } from "react";

interface Check {
  name: string;
  expect: "accept" | "reject";
  passed: boolean;
  detail?: string;
}

interface LogEntry {
  at: string;
  step: string;
  data: unknown;
}

interface Sponsorship {
  xdr: string;
  hash: string;
  kind: string;
  sponsor: string;
  operations: string[];
}

interface Proof {
  nonce: string;
  signature: string;
  signerAddress: string;
}

interface Props {
  networkPassphrase: string;
  explorerBase: string;
}

type Body = Record<string, unknown>;

/** Loads the browser-only Freighter API after the client component mounts. */
const loadFreighter = () => import("@stellar/freighter-api");

/** Calls one proof-harness action and preserves both its HTTP status and JSON body. */
async function callHarness(action: string, payload: Body): Promise<{ status: number; body: Body }> {
  const res = await fetch("/api/dev/freighter-proof", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ action, ...payload }),
  });
  const body = (await res.json().catch(() => ({ error: `HTTP ${res.status}` }))) as Body;
  return { status: res.status, body };
}

/**
 * Freighter's `signMessage` returns base64 in newer versions and raw bytes in
 * older ones. Record which one this install produced — that is spike evidence.
 */
function signatureToBase64(value: unknown): { base64: string; rawType: string } {
  if (typeof value === "string") return { base64: value, rawType: "string (base64, V4)" };
  if (value instanceof Uint8Array) {
    let binary = "";
    value.forEach((byte) => {
      binary += String.fromCharCode(byte);
    });
    return { base64: btoa(binary), rawType: `${value.constructor.name} (raw bytes, V3)` };
  }
  throw new Error(`Freighter returned no signature (${value === null ? "null" : typeof value}).`);
}

/** Renders a consistently styled action button for a proof step. */
function StepButton({
  onClick,
  disabled,
  children,
}: {
  onClick: () => void;
  disabled?: boolean;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className="rounded-xl border border-outline px-4 py-2 font-label text-sm font-semibold text-on-surface transition-colors hover:bg-surface-container-high focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2 focus-visible:ring-offset-surface disabled:opacity-50"
    >
      {children}
    </button>
  );
}

/** Groups one numbered proof action with its controls and evidence. */
function Step({ index, title, children }: { index: number; title: string; children: ReactNode }) {
  return (
    <section className="rounded-2xl border border-outline-variant bg-surface-container-low p-5">
      <h2 className="font-headline text-lg font-bold text-on-surface">
        {index}. {title}
      </h2>
      <div className="mt-3 space-y-3 text-sm text-on-surface-variant">{children}</div>
    </section>
  );
}

/** Displays the server-side acceptance and rejection checks for an envelope. */
function CheckList({ checks }: { checks: Check[] }) {
  return (
    <ul className="space-y-1.5">
      {checks.map((c) => (
        <li key={c.name} className="flex gap-2">
          <span aria-hidden className={c.passed ? "text-primary" : "text-error"}>
            {c.passed ? "✓" : "✗"}
          </span>
          <span className="text-on-surface">
            <span className="sr-only">{c.passed ? "Passed: " : "Failed: "}</span>
            {c.name}
            {c.expect === "reject" ? (
              <span className="text-on-surface-variant"> — expects rejection</span>
            ) : null}
            {c.detail ? (
              <span className="block break-all font-mono text-xs text-on-surface-variant">
                {c.detail}
              </span>
            ) : null}
          </span>
        </li>
      ))}
    </ul>
  );
}

/** Displays a labelled evidence value using the harness's compact layout. */
function Field({ label, value }: { label: string; value: ReactNode }) {
  return (
    <div className="grid grid-cols-[8rem_1fr] gap-2">
      <span className="font-label text-on-surface-variant">{label}</span>
      <span className="break-all font-mono text-xs text-on-surface">{value}</span>
    </div>
  );
}

/** Drives the manual Freighter signing proof and records exportable evidence. */
export default function FreighterProofHarness({ networkPassphrase, explorerBase }: Props) {
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [log, setLog] = useState<LogEntry[]>([]);
  const [env, setEnv] = useState<Body | null>(null);
  const [address, setAddress] = useState<string | null>(null);
  const [accountStatus, setAccountStatus] = useState<Body | null>(null);
  const [proof, setProof] = useState<Proof | null>(null);
  const [proofOutcome, setProofOutcome] = useState<Body | null>(null);
  const [replayOutcome, setReplayOutcome] = useState<Body | null>(null);
  const [sponsorship, setSponsorship] = useState<Sponsorship | null>(null);
  const [feeBump, setFeeBump] = useState(true);
  const [submitOutcome, setSubmitOutcome] = useState<Body | null>(null);
  const [copied, setCopied] = useState(false);

  /** Appends a timestamped result to the evidence log. */
  const record = (step: string, data: unknown) =>
    setLog((entries) => [...entries, { at: new Date().toISOString(), step, data }]);

  /** Runs a harness action while exposing its busy and failure states in the UI. */
  async function run(step: string, action: () => Promise<void>) {
    setBusy(step);
    setError(null);
    try {
      await action();
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      setError(`${step}: ${message}`);
      record(`${step}.error`, { message });
    } finally {
      setBusy(null);
    }
  }

  /** Records whether Freighter is available and connected to the expected network. */
  const detect = () =>
    run("environment", async () => {
      const freighter = await loadFreighter();
      const connected = await freighter.isConnected();
      const network = connected.isConnected ? await freighter.getNetworkDetails() : null;
      const result = {
        freighterInstalled: Boolean(connected.isConnected),
        walletNetwork: network?.network ?? null,
        walletPassphrase: network?.networkPassphrase ?? null,
        expectedPassphrase: networkPassphrase,
        passphraseMatches: network?.networkPassphrase === networkPassphrase,
        error: network?.error ?? connected.error ?? null,
      };
      setEnv(result);
      record("environment", result);
    });

  /** Requests wallet access and records the selected account's Horizon status. */
  const connectWallet = () =>
    run("connect", async () => {
      const freighter = await loadFreighter();
      const access = await freighter.requestAccess();
      if (access.error) throw new Error(`Freighter: ${access.error.message}`);
      setAddress(access.address);
      const status = await callHarness("status", { address: access.address });
      setAccountStatus(status.body);
      record("connect", { address: access.address, horizon: status.body });
    });

  /** Signs and verifies a one-time SEP-53 ownership challenge. */
  const proveOwnership = () =>
    run("challenge", async () => {
      if (!address) throw new Error("Connect Freighter first.");
      const issued = await callHarness("challenge", { address });
      if (issued.status !== 200) throw new Error(`challenge: ${JSON.stringify(issued.body)}`);
      const { message, nonce } = issued.body as { message: string; nonce: string };

      const freighter = await loadFreighter();
      const signed = await freighter.signMessage(message, { address, networkPassphrase });
      if (signed.error) {
        record("challenge.sign", { message, error: signed.error });
        throw new Error(`Freighter: ${signed.error.message}`);
      }
      const { base64, rawType } = signatureToBase64(signed.signedMessage);
      const nextProof = { nonce, signature: base64, signerAddress: signed.signerAddress };
      setProof(nextProof);
      setReplayOutcome(null);

      const verified = await callHarness("verify", { address, ...nextProof });
      setProofOutcome({ status: verified.status, ...verified.body });
      record("challenge", {
        message,
        rawSignatureType: rawType,
        signature: base64,
        signerAddress: signed.signerAddress,
        verifyStatus: verified.status,
        verify: verified.body,
      });
    });

  /** Replays the last proof to demonstrate single-use challenge enforcement. */
  const replayProof = () =>
    run("challenge.replay", async () => {
      if (!address || !proof) throw new Error("Prove ownership first.");
      const replay = await callHarness("verify", { address, ...proof });
      const outcome = {
        status: replay.status,
        ...replay.body,
        rejectedAsExpected: replay.status === 401 && replay.body.reason === "replayed",
      };
      setReplayOutcome(outcome);
      record("challenge.replay", outcome);
    });

  /** Records Freighter's response when the user rejects message signing. */
  const rejectChallenge = () =>
    run("challenge.reject", async () => {
      if (!address) throw new Error("Connect Freighter first.");
      const issued = await callHarness("challenge", { address });
      const { message } = issued.body as { message: string };
      const freighter = await loadFreighter();
      const signed = await freighter.signMessage(message, { address, networkPassphrase });
      record("challenge.reject", {
        instruction: "click Reject in Freighter",
        returnedError: signed.error ?? null,
        signedAnyway: !signed.error,
      });
    });

  /** Builds and records the sponsor-signed onboarding transaction. */
  const buildSponsorship = () =>
    run("sponsorship.build", async () => {
      if (!address) throw new Error("Connect Freighter first.");
      const built = await callHarness("sponsor", { address });
      if (built.status !== 200) throw new Error(JSON.stringify(built.body));
      setSponsorship(built.body as unknown as Sponsorship);
      setSubmitOutcome(null);
      const { xdr: _xdr, ...rest } = built.body;
      record("sponsorship.build", rest);
    });

  /** Requests the recipient signature, validates it, and submits the onboarding transaction. */
  const coSignAndSubmit = () =>
    run("sponsorship.submit", async () => {
      if (!address || !sponsorship) throw new Error("Build the sponsored transaction first.");
      const freighter = await loadFreighter();
      const signed = await freighter.signTransaction(sponsorship.xdr, { address, networkPassphrase });
      if (signed.error) {
        record("sponsorship.sign", { error: signed.error });
        throw new Error(`Freighter: ${signed.error.message}`);
      }
      const submitted = await callHarness("submit", {
        address,
        signedXdr: signed.signedTxXdr,
        feeBump,
      });
      setSubmitOutcome({ status: submitted.status, ...submitted.body });
      setSponsorship(null);
      record("sponsorship.submit", {
        signerAddress: signed.signerAddress,
        signerMatches: signed.signerAddress === address,
        feeBump,
        status: submitted.status,
        result: submitted.body,
      });
    });

  /** Records Freighter's response when the user rejects transaction signing. */
  const rejectSponsorship = () =>
    run("sponsorship.reject", async () => {
      if (!address || !sponsorship) throw new Error("Build the sponsored transaction first.");
      const freighter = await loadFreighter();
      const signed = await freighter.signTransaction(sponsorship.xdr, { address, networkPassphrase });
      record("sponsorship.reject", {
        instruction: "click Reject in Freighter",
        returnedError: signed.error ?? null,
        signedAnyway: !signed.error,
      });
    });

  // No render-time timestamp: the server and client would disagree and fail
  // hydration. `generatedAt` is stamped when the evidence is copied.
  const evidence = {
    harness: "Centient #24 — Freighter proof",
    networkPassphrase,
    address,
    entries: log,
  };

  /** Copies timestamped evidence and surfaces clipboard permission failures. */
  const copyEvidence = () =>
    run("evidence.copy", async () => {
      const stamped = { ...evidence, generatedAt: new Date().toISOString() };
      await navigator.clipboard.writeText(JSON.stringify(stamped, null, 2));
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    });

  const disabled = busy !== null;
  const proofChecks = (proofOutcome?.checks as Check[] | undefined) ?? null;
  const submitChecks = (submitOutcome?.checks as Check[] | undefined) ?? null;
  const after = submitOutcome?.after as Body | undefined;

  return (
    <main className="min-h-screen bg-surface">
      <div className="mx-auto max-w-2xl space-y-5 px-4 pb-16 pt-10">
        <header className="space-y-2">
          <p className="font-label text-xs font-semibold uppercase tracking-wide text-on-surface-variant">
            Spike #24 · testnet only
          </p>
          <h1 className="font-headline text-2xl font-extrabold text-on-surface">
            Freighter proof harness
          </h1>
          <p className="text-sm text-on-surface-variant">
            Walk the real Freighter extension through the ownership proof and the sponsored
            onboarding co-sign. For the sponsored path, use a <strong>brand-new Freighter account
            that has never been funded</strong>. Copy the evidence at the end.
          </p>
        </header>

        <div aria-live="polite" className="min-h-5 text-sm">
          {busy ? <p className="text-on-surface-variant">Working: {busy}…</p> : null}
          {error ? <p className="text-error">{error}</p> : null}
        </div>

        <Step index={1} title="Environment">
          <StepButton onClick={detect} disabled={disabled}>
            Detect Freighter
          </StepButton>
          {env ? (
            <div className="space-y-1">
              <Field label="Installed" value={String(env.freighterInstalled)} />
              <Field label="Wallet network" value={String(env.walletNetwork ?? "—")} />
              <Field
                label="Passphrase"
                value={
                  env.passphraseMatches ? (
                    <span className="text-primary">matches testnet</span>
                  ) : (
                    <span className="text-error">
                      {String(env.walletPassphrase ?? "unknown")} — switch Freighter to Testnet
                    </span>
                  )
                }
              />
            </div>
          ) : null}
        </Step>

        <Step index={2} title="Connect">
          <StepButton onClick={connectWallet} disabled={disabled}>
            Connect Freighter
          </StepButton>
          {address ? (
            <div className="space-y-1">
              <Field label="Address" value={address} />
              <Field label="Horizon" value={JSON.stringify(accountStatus?.status ?? accountStatus)} />
            </div>
          ) : null}
        </Step>

        <Step index={3} title="Ownership proof (SEP-53)">
          <div className="flex flex-wrap gap-2">
            <StepButton onClick={proveOwnership} disabled={disabled || !address}>
              Sign challenge
            </StepButton>
            <StepButton onClick={replayProof} disabled={disabled || !proof}>
              Replay last proof
            </StepButton>
            <StepButton onClick={rejectChallenge} disabled={disabled || !address}>
              Sign, then reject in Freighter
            </StepButton>
          </div>
          {proofOutcome ? (
            <div className="space-y-2">
              <Field
                label="Server verify"
                value={
                  proofOutcome.ok ? (
                    <span className="text-primary">accepted</span>
                  ) : (
                    <span className="text-error">rejected: {String(proofOutcome.reason)}</span>
                  )
                }
              />
              {proofChecks ? <CheckList checks={proofChecks} /> : null}
            </div>
          ) : null}
          {replayOutcome ? (
            <Field
              label="Replay"
              value={
                replayOutcome.rejectedAsExpected ? (
                  <span className="text-primary">rejected as replayed</span>
                ) : (
                  <span className="text-error">unexpected: {JSON.stringify(replayOutcome)}</span>
                )
              }
            />
          ) : null}
        </Step>

        <Step index={4} title="Sponsored onboarding co-sign">
          <div className="flex flex-wrap items-center gap-2">
            <StepButton onClick={buildSponsorship} disabled={disabled || !address}>
              Build sponsored transaction
            </StepButton>
            <StepButton onClick={coSignAndSubmit} disabled={disabled || !sponsorship}>
              Sign in Freighter &amp; submit
            </StepButton>
            <StepButton onClick={rejectSponsorship} disabled={disabled || !sponsorship}>
              Sign, then reject in Freighter
            </StepButton>
          </div>
          <label className="flex items-center gap-2 text-on-surface">
            <input
              type="checkbox"
              checked={feeBump}
              onChange={(e) => setFeeBump(e.target.checked)}
              className="h-4 w-4 accent-primary"
            />
            Wrap in a fee bump (sponsor pays the fee)
          </label>
          {sponsorship ? (
            <div className="space-y-1">
              <Field label="Kind" value={sponsorship.kind} />
              <Field label="Operations" value={sponsorship.operations.join(" → ")} />
              <Field label="Sponsor" value={sponsorship.sponsor} />
              <Field label="Hash" value={sponsorship.hash} />
            </div>
          ) : null}
          {submitOutcome ? (
            <div className="space-y-2">
              {submitChecks ? <CheckList checks={submitChecks} /> : null}
              {submitOutcome.ok ? (
                <>
                  <Field
                    label="Transaction"
                    value={
                      <a
                        href={String(submitOutcome.explorerTx)}
                        target="_blank"
                        rel="noreferrer"
                        className="text-primary underline"
                      >
                        {String(submitOutcome.hash)}
                      </a>
                    }
                  />
                  <Field label="XLM after" value={String(after?.xlmBalance ?? "—")} />
                  <Field label="Trustline sponsor" value={String(after?.usdcTrustlineSponsor ?? "—")} />
                  <Field label="Account sponsor" value={String(after?.accountSponsor ?? "—")} />
                </>
              ) : (
                <Field
                  label="Result"
                  value={<span className="text-error">{JSON.stringify(submitOutcome)}</span>}
                />
              )}
            </div>
          ) : null}
          <p className="text-xs">
            Explorer: <span className="font-mono">{explorerBase}</span>
          </p>
        </Step>

        <Step index={5} title="Evidence">
          <StepButton onClick={copyEvidence} disabled={log.length === 0}>
            {copied ? "Copied" : "Copy evidence JSON"}
          </StepButton>
          <pre className="max-h-80 overflow-auto rounded-xl bg-surface-container p-3 font-mono text-xs text-on-surface">
            {JSON.stringify(evidence, null, 2)}
          </pre>
        </Step>
      </div>
    </main>
  );
}
