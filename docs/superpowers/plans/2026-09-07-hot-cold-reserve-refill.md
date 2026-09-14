# Hot/Cold Reserve Refill Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add an exact, config-driven cold-reserve refill workflow in which a scheduler detects a low hot USDC float and only a transaction signed independently by two configured cold custodians can restore the target.

**Architecture:** A focused Stellar module owns policy parsing, exact balance extraction, deterministic planning, transaction construction, signature/shape validation, and injected Horizon I/O. An authenticated cron route performs read-only detection; an operator CLI prepares, signs one key at a time, and submits after revalidation. A cold setup script and runbook cover 2-of-3 provisioning without persisting seeds.

**Tech Stack:** TypeScript, Next.js 16 route handlers, `@stellar/stellar-sdk` 16, Vitest 4, Horizon REST, existing cron bearer authentication.

**Spec:** `docs/superpowers/specs/2026-09-07-hot-cold-reserve-refill-design.md`

## Global Constraints

- Use integer 7-decimal USDC units (`bigint`) from configuration through transaction construction; never use floating point for value decisions.
- Pin the hot destination with `STELLAR_PLATFORM_ACCOUNT` or derive it from `STELLAR_PLATFORM_SECRET`; require both to match when both exist and never accept an arbitrary CLI destination.
- No application, cron, or CLI invocation may receive two cold signer seeds.
- Reject partial refills: restore the exact target or return `insufficient_reserve`.
- A valid submission contains exactly one configured-USDC payment from cold to hot and at least two cryptographically valid signatures from the configured cold signer set.
- Log the signed transaction hash before the one Horizon submit call; never retry an unknown submission outcome.
- All commits use only the configured `cemmacabales` author identity and no co-author trailers.

---

### Task 1: Exact policy and deterministic refill planning

**Files:**

- Create: `lib/stellar/reserve-refill.ts`
- Create: `lib/stellar/__tests__/reserve-refill.test.ts`

**Interfaces:**

- Consumes: `Asset`, `Keypair`, and Stellar public-key validation from `@stellar/stellar-sdk`.
- Produces:
  - `ReserveRefillPolicy { coldAccount, hotAccount, signerPublicKeys, triggerUnits, targetUnits, minRetainUnits }`, where `signerPublicKeys` is the readonly `[cold master, ops, policy]` 2-of-3 set
  - `parseReserveRefillPolicy(env?: NodeJS.ProcessEnv): ReserveRefillPolicy`
  - `stellarAmountToUnits(value: string): bigint`
  - `extractAssetBalanceUnits(balances, asset): bigint`
  - `planReserveRefill(policy, hotBalanceUnits, coldBalanceUnits): ReserveRefillPlan`

- [ ] **Step 1: Write failing policy tests**

Add tests with deterministic keypairs and a literal environment object. The
  valid case must produce exact bigint fields and derive `hotAccount` from the
  platform seed. A public-only hot identity must support offline signing, while
  public and secret identities must match when both exist. Individual tests must reject a missing cold account, invalid or
duplicate signer public keys, a cold account reused as a signer or hot account,
non-integer/negative unit settings, a zero target, and `trigger >= target`.

```ts
expect(parseReserveRefillPolicy(validEnv)).toMatchObject({
  coldAccount: cold.publicKey(),
  hotAccount: hot.publicKey(),
  signerPublicKeys: [cold.publicKey(), ops.publicKey(), policy.publicKey()],
  triggerUnits: 250_000_000n,
  targetUnits: 1_000_000_000n,
  minRetainUnits: 500_000_000n,
});
```

- [ ] **Step 2: Run policy tests and verify RED**

Run: `npx vitest run lib/stellar/__tests__/reserve-refill.test.ts -t "policy"`

Expected: FAIL because `reserve-refill.ts` and its exported parser do not exist.

- [ ] **Step 3: Implement the minimal fail-closed parser**

Use a helper that accepts only `/^\d+$/` and converts with `BigInt`. Validate
every public key with `StrKey.isValidEd25519PublicKey`, derive the hot key with
`Keypair.fromSecret` when no public account is supplied, require a supplied
public account to match a supplied secret, and enforce pairwise-distinct cold, hot, ops, and policy
keys. Return a readonly tuple containing the cold master plus both configured
co-signers, so any valid two match the on-chain 2-of-3 account.

- [ ] **Step 4: Run policy tests and verify GREEN**

Run: `npx vitest run lib/stellar/__tests__/reserve-refill.test.ts -t "policy"`

Expected: PASS.

- [ ] **Step 5: Write failing exact-balance and planning tests**

Use literal Horizon balance fixtures. Prove `"123456789012.3456789"` becomes
`1_234_567_890_123_456_789n`, a missing configured trustline becomes `0n`, a
wrong issuer is ignored, and more than seven decimals is rejected. Cover these
literal plans:

```ts
expect(planReserveRefill(policy, 300_000_000n, 2_000_000_000n)).toEqual({
  status: "healthy",
  hotBalanceUnits: 300_000_000n,
  coldBalanceUnits: 2_000_000_000n,
});

expect(planReserveRefill(policy, 250_000_000n, 2_000_000_000n)).toEqual({
  status: "refill_required",
  amountUnits: 750_000_000n,
  hotBalanceUnits: 250_000_000n,
  coldBalanceUnits: 2_000_000_000n,
  coldAfterUnits: 1_250_000_000n,
});
```

When cold holds `1_000_000_000n`, the same plan must return
`insufficient_reserve` because the exact refill would leave less than the
`500_000_000n` retain floor.

- [ ] **Step 6: Run planning tests and verify RED**

Run: `npx vitest run lib/stellar/__tests__/reserve-refill.test.ts -t "balance|plan"`

Expected: FAIL because exact conversion and planning exports are absent.

- [ ] **Step 7: Implement exact conversion and the three-state planner**

Parse Stellar decimals by splitting whole/fractional text and right-padding the
fraction to seven digits. The planner treats `hot <= trigger` as actionable,
computes only `target - hot`, and returns `insufficient_reserve` rather than a
smaller payment when `cold - amount < minRetain`.

- [ ] **Step 8: Run the focused file and commit**

Run: `npx vitest run lib/stellar/__tests__/reserve-refill.test.ts`

Expected: PASS with no warnings.

```bash
git add lib/stellar/reserve-refill.ts lib/stellar/__tests__/reserve-refill.test.ts
git commit -m "feat(stellar): define bounded reserve refill policy"
```

---

### Task 2: Enforce the cold-to-hot transaction and two-party signatures

**Files:**

- Modify: `lib/stellar/reserve-refill.ts`
- Modify: `lib/stellar/__tests__/reserve-refill.test.ts`

**Interfaces:**

- Consumes: Task 1 policy and `refill_required` plan.
- Produces:
  - `buildReserveRefillTransaction({ sourceAccount, policy, asset, amountUnits, fee, timeoutSeconds }): Transaction`
  - `validateReserveRefillTransaction({ transaction, policy, asset, expectedAmountUnits, nowSeconds, requireSignatures }): void`
  - `addReserveRefillSignature(transaction, signer, policy): Transaction`
  - `submitReserveRefill({ signedXdr, policy, asset, expectedAmountUnits, submit, log, nowSeconds }): Promise<{ hash: string }>`

- [ ] **Step 1: Write the failing builder test**

Build from `new Account(cold.publicKey(), "41")` with `12_345_678n`. Assert one
operation with the hand-derived amount `"1.2345678"`, source cold, destination
hot, the exact configured asset, fee `"200"`, and a nonzero maximum time.

- [ ] **Step 2: Run the builder test and verify RED**

Run: `npx vitest run lib/stellar/__tests__/reserve-refill.test.ts -t "builds one"`

Expected: FAIL because the builder export is absent.

- [ ] **Step 3: Implement the single-operation builder**

Use `TransactionBuilder` with `networkPassphrase()`, one `Operation.payment`,
`unitsToUsdcString(amountUnits)`, a positive stroop fee, and a positive integer
timeout. Reject zero/negative amounts and amounts greater than
`policy.targetUnits` before building.

- [ ] **Step 4: Run the builder test and verify GREEN**

Run the command from Step 2. Expected: PASS.

- [ ] **Step 5: Write failing validator and signer tests**

Start with the valid transaction, then independently mutate fixtures to prove
rejection of: FeeBump envelopes, wrong source, zero or multiple operations,
wrong operation source, wrong destination, wrong asset code/issuer, wrong exact
amount, fee above `10_000` stroops, missing/expired time bounds, an unconfigured
signer, a duplicate signature, and fewer than two valid configured signatures.

Use the existing deterministic colliding-hint seeds to prove identities are
verified cryptographically instead of counted by the four-byte hint:

```ts
const signerA = Keypair.fromSecret(
  "SCCWCBKRPZIXX2WBQE7ROHQJZFRD5JKEGCHX5XUI2JCYVVJMXUB5LBB2",
);
const signerB = Keypair.fromSecret(
  "SDXU2G5LKV4W7FQ4AUC6HDLA6NB3OY4W5JARKHHIVSBM65I5H4EPGWVC",
);
expect(signerA.signatureHint()).toEqual(signerB.signatureHint());
```

- [ ] **Step 6: Run validator tests and verify RED**

Run: `npx vitest run lib/stellar/__tests__/reserve-refill.test.ts -t "validates|signature|rejects"`

Expected: FAIL because validation and signer exports are absent.

- [ ] **Step 7: Implement shape and signature validation**

Require a plain `Transaction`, exact transaction source, one payment operation
with no operation-level source override, exact asset/destination/amount, positive
time bounds with `maxTime >= nowSeconds`, and total fee `<= 10_000`. For each
configured public key, find every matching-hint signature and use
`Keypair.fromPublicKey(key).verify(transaction.hash(), signature.signature())`.
Count distinct configured identities with a valid signature and require two.
Reject any decorated signature that verifies for no configured signer.

`addReserveRefillSignature` rejects keys outside the configured signer set and
rejects a second valid signature from the same key before calling `sign`.

- [ ] **Step 8: Write failing submit-once tests**

Inject a submit function and a log collector. Prove the first event contains the
transaction hash before the submit function runs, Horizon's returned hash must
equal the signed hash, and a rejected/unknown submit is called exactly once.

- [ ] **Step 9: Run submit tests and verify RED**

Run: `npx vitest run lib/stellar/__tests__/reserve-refill.test.ts -t "submit"`

Expected: FAIL because `submitReserveRefill` is absent.

- [ ] **Step 10: Implement submit-once and verify the full focused file**

Decode with `TransactionBuilder.fromXDR`, reject `FeeBumpTransaction`, run the
validator with signatures required, log `hash` and `explorerUrl()` before
awaiting the injected submitter, call it once, and compare response hash.

Run: `npx vitest run lib/stellar/__tests__/reserve-refill.test.ts`

Expected: PASS.

- [ ] **Step 11: Commit**

```bash
git add lib/stellar/reserve-refill.ts lib/stellar/__tests__/reserve-refill.test.ts
git commit -m "feat(stellar): enforce multisig reserve refills"
```

---

### Task 3: Add scheduled detection, operator CLI, setup, and runbook

**Files:**

- Create: `app/api/cron/reserve-refill/route.ts`
- Create: `app/api/cron/reserve-refill/__tests__/route.test.ts`
- Create: `scripts/stellar-reserve-refill.ts`
- Create: `scripts/stellar-cold-reserve-setup.ts`
- Create: `docs/stellar-cold-reserve-runbook.md`
- Modify: `lib/stellar/reserve-refill.ts`
- Modify: `.env.local.example`
- Modify: `package.json`

**Interfaces:**

- Consumes: Task 1 planner, Task 2 transaction workflow, existing
  `authenticateCron`, `server()`, `usdcAsset()`, `explorerUrl()`,
  `buildSetOptionsTx`, and `evaluateMultisig`.
- Produces:
  - `loadReserveRefillStatus(deps?): Promise<ReserveRefillPlan>`
  - Authenticated `POST /api/cron/reserve-refill`
  - `npm run stellar:reserve:setup`
  - `npm run stellar:reserve:refill -- <status|prepare|sign|submit>`

- [ ] **Step 1: Read the installed Next.js route-handler guidance**

Read the App Router route-handler and environment-variable guides under
`node_modules/next/dist/docs/01-app/` before creating the route. Preserve the
repository's `NextRequest`/`NextResponse` pattern and `dynamic = "force-dynamic"`.

- [ ] **Step 2: Write failing reserve-status I/O tests**

Inject `loadAccount`, the configured asset, and policy. Use complete Horizon
fixtures for both accounts. Assert exact hot/cold balance extraction and each
planner result without mocking the planner itself.

- [ ] **Step 3: Run status tests and verify RED**

Run: `npx vitest run lib/stellar/__tests__/reserve-refill.test.ts -t "loads reserve"`

Expected: FAIL because `loadReserveRefillStatus` is absent.

- [ ] **Step 4: Implement the thin Horizon status adapter**

Default dependencies call `server().loadAccount` for the configured hot and cold
accounts and use `usdcAsset()`. Keep injected dependencies available to tests.
Return the pure planner result.

- [ ] **Step 5: Write failing cron route tests**

Mirror the complete authentication cases from the existing payout cron tests.
Mock only `loadReserveRefillStatus` and assert response behavior:

```ts
// healthy -> 200
// refill_required -> 202, amountUnits serialized as a decimal string
// insufficient_reserve -> 503
// thrown configuration/Horizon error -> 500 without leaking secrets
```

- [ ] **Step 6: Run route tests and verify RED**

Run: `npx vitest run app/api/cron/reserve-refill/__tests__/route.test.ts`

Expected: FAIL because the route does not exist.

- [ ] **Step 7: Implement the authenticated read-only route**

Authenticate first, call `loadReserveRefillStatus`, serialize every bigint field
to base-10 strings, map the three plan states to 200/202/503, log internal errors,
and return `{ error: "Reserve refill check failed" }` with 500.

- [ ] **Step 8: Run route tests and verify GREEN**

Run the command from Step 6. Expected: PASS.

- [ ] **Step 9: Implement the operator CLI and cold setup script**

Keep CLI parsing in `scripts/stellar-reserve-refill.ts`; all security decisions
remain in the tested module. `status` prints the plan. `prepare` reloads status,
requires `refill_required`, loads the cold account and base fee, builds/validates,
and prints the unsigned XDR/hash. `sign` reads XDR from
`STELLAR_RESERVE_REFILL_XDR`, the independently approved
`STELLAR_RESERVE_REFILL_AMOUNT_UNITS`, and one `STELLAR_COLD_SIGNER_SECRET`.
Without Horizon access it validates the shape and exact amount, adds exactly
that configured signature, and prints the XDR. `submit` reloads the current plan and passes the signed XDR to
`submitReserveRefill` with `server().submitTransaction`.

The setup script uses cold-specific environment names, friendbot-funds only on
testnet, creates the configured USDC trustline before raising thresholds, and
reuses `buildSetOptionsTx`/`evaluateMultisig`. It rejects hot/cold identity
reuse before network I/O. Generated throwaway secrets require explicit
`STELLAR_ALLOW_TESTNET_KEY_GENERATION=true`, are impossible on public network,
and are printed only for immediate transfer to separate stores; production
requires pre-provisioned keys.

- [ ] **Step 10: Document configuration and operations**

Add all six policy variables and one-at-a-time signing variables to
`.env.local.example`. Add package scripts for setup and refill. Write the runbook
with setup, faucet funding, policy sizing, cron schedule, status/prepare/two-sign/
submit commands, hash-first reconciliation, emergency stop, rotation, XLM floor,
insufficient-reserve handling, and public evidence fields.

- [ ] **Step 11: Run focused and repository verification**

Run:

```bash
npx vitest run lib/stellar/__tests__/reserve-refill.test.ts app/api/cron/reserve-refill/__tests__/route.test.ts
npm test
npm run typecheck
npm run build
```

Expected: focused tests pass; full suite passes with the existing one todo;
typecheck exits 0; production build exits 0.

- [ ] **Step 12: Commit**

```bash
git add app/api/cron/reserve-refill lib/stellar/reserve-refill.ts scripts/stellar-reserve-refill.ts scripts/stellar-cold-reserve-setup.ts docs/stellar-cold-reserve-runbook.md .env.local.example package.json
git commit -m "feat(stellar): add cold reserve refill operations"
```

---

### Task 4: Capture evidence and open the pull request

**Files:**

- Modify: `docs/stellar-cold-reserve-runbook.md` only when live public evidence is available.

**Interfaces:**

- Consumes: completed setup/refill scripts and testnet USDC faucet funding.
- Produces: public cold account, threshold transaction, refill transaction, exact balance delta, and PR against `develop` closing #10.

- [ ] **Step 1: Provision and verify a throwaway testnet cold reserve**

Run the setup command with cold master/ops/policy material supplied from separate
temporary operator environments. Confirm on Horizon and stellar.expert that the
account has three weight-1 Ed25519 signers and 2/2/2 thresholds.

- [ ] **Step 2: Fund testnet USDC and execute one refill**

Use the Circle testnet faucet for the cold account. Set a small test policy whose
trigger is above the current hot balance and target is exactly one test USDC
higher. Prepare, sign in two separate invocations, submit once, and verify the
hot balance increased by the exact planned units while cold remains above its
retain floor.

- [ ] **Step 3: Record only public evidence**

Add the cold account, signer public keys, thresholds, setup hash, refill hash,
hot/cold before-after balances, and explorer links to the runbook. Do not add
seeds or signed XDR.

- [ ] **Step 4: Re-run verification after evidence-only edits**

Run `git diff --check`, the two focused Vitest files, `npm run typecheck`, and
`npm run build`. Expected: all pass.

- [ ] **Step 5: Push and open the PR**

Push `feat/issue-10-hot-cold-reserve` and open a PR against `develop` with the
three implementation slices, verification results, public testnet evidence or a
precise faucet blocker, `Closes #10`, and `Part of #4`.
