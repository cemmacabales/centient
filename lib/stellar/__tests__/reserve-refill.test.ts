import {
  Account,
  Asset,
  Keypair,
  Memo,
  Networks,
  Operation,
  TransactionBuilder,
} from "@stellar/stellar-sdk";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  addReserveRefillSignature,
  assertReserveRefillStillPermitted,
  buildReserveRefillTransaction,
  extractAssetBalanceUnits,
  loadReserveRefillStatus,
  parseReserveRefillExpectedAmountUnits,
  parseReserveRefillPolicy,
  planReserveRefill,
  stellarAmountToUnits,
  submitReserveRefill,
  validateReserveRefillTransaction,
} from "../reserve-refill";

beforeEach(() => {
  process.env.STELLAR_NETWORK = "testnet";
});

function policyFixture() {
  const cold = Keypair.random();
  const hot = Keypair.random();
  const ops = Keypair.random();
  const policy = Keypair.random();
  const env: Record<string, string | undefined> = {
    STELLAR_COLD_RESERVE_ACCOUNT: cold.publicKey(),
    STELLAR_COLD_OPS_SIGNER_PUBLIC: ops.publicKey(),
    STELLAR_COLD_POLICY_SIGNER_PUBLIC: policy.publicKey(),
    STELLAR_PLATFORM_ACCOUNT: hot.publicKey(),
    STELLAR_PLATFORM_SECRET: hot.secret(),
    STELLAR_HOT_FLOAT_TRIGGER_UNITS: "250000000",
    STELLAR_HOT_FLOAT_TARGET_UNITS: "1000000000",
    STELLAR_COLD_MIN_RETAIN_UNITS: "500000000",
  };
  return { cold, hot, ops, policy, env };
}

describe("reserve refill policy", () => {
  it("parses exact unit limits and the true 2-of-3 signer set", () => {
    const { cold, hot, ops, policy, env } = policyFixture();

    expect(parseReserveRefillPolicy(env)).toEqual({
      coldAccount: cold.publicKey(),
      hotAccount: hot.publicKey(),
      signerPublicKeys: [
        cold.publicKey(),
        ops.publicKey(),
        policy.publicKey(),
      ],
      triggerUnits: 250_000_000n,
      targetUnits: 1_000_000_000n,
      minRetainUnits: 500_000_000n,
    });
  });

  it.each([
    "STELLAR_COLD_RESERVE_ACCOUNT",
    "STELLAR_COLD_OPS_SIGNER_PUBLIC",
    "STELLAR_COLD_POLICY_SIGNER_PUBLIC",
    "STELLAR_HOT_FLOAT_TRIGGER_UNITS",
    "STELLAR_HOT_FLOAT_TARGET_UNITS",
    "STELLAR_COLD_MIN_RETAIN_UNITS",
  ])("fails closed when %s is missing", (name) => {
    const { env } = policyFixture();
    delete env[name];

    expect(() => parseReserveRefillPolicy(env)).toThrow(name);
  });

  it("supports public-only hot configuration on an offline signing host", () => {
    const { hot, env } = policyFixture();
    delete env.STELLAR_PLATFORM_SECRET;

    expect(parseReserveRefillPolicy(env).hotAccount).toBe(hot.publicKey());
  });

  it("parses an exact positive amount for an offline signer", () => {
    expect(
      parseReserveRefillExpectedAmountUnits({
        STELLAR_RESERVE_REFILL_AMOUNT_UNITS: "750000000",
      }),
    ).toBe(750_000_000n);
  });

  it.each([undefined, "", "0", "-1", "1.5", " 1"])(
    "rejects an unsafe offline signing amount %j",
    (value) => {
      expect(() =>
        parseReserveRefillExpectedAmountUnits({
          STELLAR_RESERVE_REFILL_AMOUNT_UNITS: value,
        }),
      ).toThrow(/STELLAR_RESERVE_REFILL_AMOUNT_UNITS/);
    },
  );

  it("fails closed when neither hot account identity is configured", () => {
    const { env } = policyFixture();
    delete env.STELLAR_PLATFORM_ACCOUNT;
    delete env.STELLAR_PLATFORM_SECRET;

    expect(() => parseReserveRefillPolicy(env)).toThrow(
      /STELLAR_PLATFORM_ACCOUNT.*STELLAR_PLATFORM_SECRET/,
    );
  });

  it("rejects a public hot account that disagrees with the hot seed", () => {
    const { env } = policyFixture();

    expect(() =>
      parseReserveRefillPolicy({
        ...env,
        STELLAR_PLATFORM_ACCOUNT: Keypair.random().publicKey(),
      }),
    ).toThrow(/must match/i);
  });

  it("rejects malformed account and signer public keys", () => {
    const { env } = policyFixture();

    expect(() =>
      parseReserveRefillPolicy({
        ...env,
        STELLAR_COLD_RESERVE_ACCOUNT: "not-a-stellar-key",
      }),
    ).toThrow(/STELLAR_COLD_RESERVE_ACCOUNT/);
    expect(() =>
      parseReserveRefillPolicy({
        ...env,
        STELLAR_COLD_OPS_SIGNER_PUBLIC: "not-a-stellar-key",
      }),
    ).toThrow(/STELLAR_COLD_OPS_SIGNER_PUBLIC/);
  });

  it("rejects malformed platform seeds", () => {
    const { env } = policyFixture();

    expect(() =>
      parseReserveRefillPolicy({
        ...env,
        STELLAR_PLATFORM_SECRET: "not-a-stellar-seed",
      }),
    ).toThrow(/STELLAR_PLATFORM_SECRET/);
  });

  it("rejects a malformed explicit hot account", () => {
    const { env } = policyFixture();

    expect(() =>
      parseReserveRefillPolicy({
        ...env,
        STELLAR_PLATFORM_ACCOUNT: "not-a-stellar-key",
      }),
    ).toThrow(/STELLAR_PLATFORM_ACCOUNT/);
  });

  it.each([
    ["ops equals master", "STELLAR_COLD_OPS_SIGNER_PUBLIC", "cold"],
    ["policy equals master", "STELLAR_COLD_POLICY_SIGNER_PUBLIC", "cold"],
    ["policy equals ops", "STELLAR_COLD_POLICY_SIGNER_PUBLIC", "ops"],
  ])("rejects overlapping identities: %s", (_label, field, replacement) => {
    const { cold, ops, env } = policyFixture();
    const value =
      replacement === "cold"
        ? cold.publicKey()
        : ops.publicKey();

    expect(() => parseReserveRefillPolicy({ ...env, [field]: value })).toThrow(
      /distinct/i,
    );
  });

  it("rejects a hot account reused as the cold account", () => {
    const { cold, env } = policyFixture();

    expect(() =>
      parseReserveRefillPolicy({
        ...env,
        STELLAR_PLATFORM_ACCOUNT: cold.publicKey(),
        STELLAR_PLATFORM_SECRET: cold.secret(),
      }),
    ).toThrow(/distinct/i);
  });

  it.each(["-1", "1.5", " 1", "1 ", "abc", ""])(
    "rejects an unsafe unit setting %j",
    (value) => {
      const { env } = policyFixture();
      expect(() =>
        parseReserveRefillPolicy({
          ...env,
          STELLAR_HOT_FLOAT_TRIGGER_UNITS: value,
        }),
      ).toThrow(/STELLAR_HOT_FLOAT_TRIGGER_UNITS/);
    },
  );

  it("requires a positive target above the trigger", () => {
    const { env } = policyFixture();

    expect(() =>
      parseReserveRefillPolicy({
        ...env,
        STELLAR_HOT_FLOAT_TRIGGER_UNITS: "0",
        STELLAR_HOT_FLOAT_TARGET_UNITS: "0",
      }),
    ).toThrow(/target/i);
    expect(() =>
      parseReserveRefillPolicy({
        ...env,
        STELLAR_HOT_FLOAT_TRIGGER_UNITS: "100",
        STELLAR_HOT_FLOAT_TARGET_UNITS: "100",
      }),
    ).toThrow(/greater than/i);
  });
});

describe("reserve refill balance parsing", () => {
  it("converts a large 7-decimal Stellar amount exactly", () => {
    expect(stellarAmountToUnits("123456789012.3456789")).toBe(
      1_234_567_890_123_456_789n,
    );
  });

  it.each(["-1", "1.00000001", "1e3", "NaN", " 1.0"])(
    "rejects an invalid Stellar amount %j",
    (amount) => {
      expect(() => stellarAmountToUnits(amount)).toThrow(/invalid Stellar amount/i);
    },
  );

  it("extracts only the configured asset code and issuer", () => {
    const issuer = Keypair.random().publicKey();
    const otherIssuer = Keypair.random().publicKey();
    const asset = new Asset("USDC", issuer);

    expect(
      extractAssetBalanceUnits(
        [
          { asset_type: "native", balance: "500.0000000" },
          {
            asset_type: "credit_alphanum4",
            asset_code: "USDC",
            asset_issuer: otherIssuer,
            balance: "99.0000000",
          },
          {
            asset_type: "credit_alphanum4",
            asset_code: "USDC",
            asset_issuer: issuer,
            balance: "12.3456789",
          },
        ],
        asset,
      ),
    ).toBe(123_456_789n);
  });

  it("treats a missing configured trustline as zero", () => {
    const asset = new Asset("USDC", Keypair.random().publicKey());
    expect(
      extractAssetBalanceUnits(
        [{ asset_type: "native", balance: "500.0000000" }],
        asset,
      ),
    ).toBe(0n);
  });
});

describe("reserve refill plan", () => {
  it("does nothing while the hot float is above its trigger", () => {
    const policy = parseReserveRefillPolicy(policyFixture().env);

    expect(planReserveRefill(policy, 300_000_000n, 2_000_000_000n)).toEqual({
      status: "healthy",
      hotBalanceUnits: 300_000_000n,
      coldBalanceUnits: 2_000_000_000n,
    });
  });

  it("restores the exact target when the hot float reaches the trigger", () => {
    const policy = parseReserveRefillPolicy(policyFixture().env);

    expect(planReserveRefill(policy, 250_000_000n, 2_000_000_000n)).toEqual({
      status: "refill_required",
      amountUnits: 750_000_000n,
      hotBalanceUnits: 250_000_000n,
      coldBalanceUnits: 2_000_000_000n,
      coldAfterUnits: 1_250_000_000n,
    });
  });

  it("allows an exact refill that leaves the retain floor intact", () => {
    const policy = parseReserveRefillPolicy(policyFixture().env);

    expect(planReserveRefill(policy, 250_000_000n, 1_250_000_000n)).toEqual({
      status: "refill_required",
      amountUnits: 750_000_000n,
      hotBalanceUnits: 250_000_000n,
      coldBalanceUnits: 1_250_000_000n,
      coldAfterUnits: 500_000_000n,
    });
  });

  it("rejects a partial refill when the reserve cannot retain its floor", () => {
    const policy = parseReserveRefillPolicy(policyFixture().env);

    expect(planReserveRefill(policy, 250_000_000n, 1_000_000_000n)).toEqual({
      status: "insufficient_reserve",
      requiredUnits: 750_000_000n,
      availableUnits: 500_000_000n,
      hotBalanceUnits: 250_000_000n,
      coldBalanceUnits: 1_000_000_000n,
    });
  });
});

describe("reserve refill transaction builder", () => {
  it("builds one time-bounded cold-to-hot USDC payment with exact units", () => {
    const fixture = policyFixture();
    const policy = parseReserveRefillPolicy(fixture.env);
    const issuer = Keypair.random().publicKey();

    const transaction = buildReserveRefillTransaction({
      sourceAccount: new Account(policy.coldAccount, "41"),
      policy,
      asset: new Asset("USDC", issuer),
      amountUnits: 12_345_678n,
      fee: "200",
    });

    expect(transaction.source).toBe(policy.coldAccount);
    expect(transaction.operations).toHaveLength(1);
    expect(transaction.operations[0]).toMatchObject({
      type: "payment",
      destination: policy.hotAccount,
      amount: "1.2345678",
      asset: { code: "USDC", issuer },
    });
    expect((transaction.operations[0] as { source?: string }).source).toBeUndefined();
    expect(transaction.fee).toBe("200");
    expect(Number(transaction.timeBounds?.maxTime)).toBeGreaterThan(0);
  });

  it.each([0n, -1n, 1_000_000_001n])(
    "rejects an unsafe refill amount %s",
    (amountUnits) => {
      const fixture = policyFixture();
      const policy = parseReserveRefillPolicy(fixture.env);

      expect(() =>
        buildReserveRefillTransaction({
          sourceAccount: new Account(policy.coldAccount, "41"),
          policy,
          asset: new Asset("USDC", Keypair.random().publicKey()),
          amountUnits,
        }),
      ).toThrow(/amount/i);
    },
  );

  it.each([0, -1, 1.5, 901])(
    "rejects an unsafe transaction lifetime %s seconds",
    (timeoutSeconds) => {
      const fixture = policyFixture();
      const policy = parseReserveRefillPolicy(fixture.env);

      expect(() =>
        buildReserveRefillTransaction({
          sourceAccount: new Account(policy.coldAccount, "41"),
          policy,
          asset: new Asset("USDC", Keypair.random().publicKey()),
          amountUnits: 1n,
          timeoutSeconds,
        }),
      ).toThrow(/timeoutSeconds/);
    },
  );

  it("allows the approved 15-minute two-custodian signing window", () => {
    const fixture = policyFixture();
    const policy = parseReserveRefillPolicy(fixture.env);

    expect(() =>
      buildReserveRefillTransaction({
        sourceAccount: new Account(policy.coldAccount, "41"),
        policy,
        asset: new Asset("USDC", Keypair.random().publicKey()),
        amountUnits: 1n,
        timeoutSeconds: 900,
      }),
    ).not.toThrow();
  });
});

function transactionFixture() {
  const keys = policyFixture();
  const policy = parseReserveRefillPolicy(keys.env);
  const asset = new Asset("USDC", Keypair.random().publicKey());
  const amountUnits = 750_000_000n;
  const transaction = buildReserveRefillTransaction({
    sourceAccount: new Account(policy.coldAccount, "41"),
    policy,
    asset,
    amountUnits,
    fee: "200",
  });
  return { ...keys, policy, asset, amountUnits, transaction };
}

function directPayment({
  source,
  destination,
  asset,
  amount = "75.0000000",
  fee = "200",
  operationSource,
  secondOperation = false,
  timeout = 180,
}: {
  source: string;
  destination: string;
  asset: Asset;
  amount?: string;
  fee?: string;
  operationSource?: string;
  secondOperation?: boolean;
  timeout?: number;
}) {
  const builder = new TransactionBuilder(new Account(source, "41"), {
    fee,
    networkPassphrase: Networks.TESTNET,
  }).addOperation(
    Operation.payment({
      source: operationSource,
      destination,
      asset,
      amount,
    }),
  );
  if (secondOperation) {
    builder.addOperation(
      Operation.payment({ destination, asset, amount: "0.0000001" }),
    );
  }
  return builder.setTimeout(timeout).build();
}

describe("reserve refill transaction validation", () => {
  it("accepts exactly one payment signed by any two configured cold identities", () => {
    const fixture = transactionFixture();
    addReserveRefillSignature(fixture.transaction, fixture.cold, fixture.policy);
    addReserveRefillSignature(fixture.transaction, fixture.ops, fixture.policy);

    expect(() =>
      validateReserveRefillTransaction({
        transaction: fixture.transaction,
        policy: fixture.policy,
        asset: fixture.asset,
        expectedAmountUnits: fixture.amountUnits,
        nowSeconds: Math.floor(Date.now() / 1000),
        requireSignatures: true,
      }),
    ).not.toThrow();
  });

  it("verifies configured identities even when two signature hints collide", () => {
    const signerA = Keypair.fromSecret(
      "SCCWCBKRPZIXX2WBQE7ROHQJZFRD5JKEGCHX5XUI2JCYVVJMXUB5LBB2",
    );
    const signerB = Keypair.fromSecret(
      "SDXU2G5LKV4W7FQ4AUC6HDLA6NB3OY4W5JARKHHIVSBM65I5H4EPGWVC",
    );
    expect(signerA.signatureHint()).toEqual(signerB.signatureHint());
    const hot = Keypair.random();
    const third = Keypair.random();
    const policy = parseReserveRefillPolicy({
      STELLAR_COLD_RESERVE_ACCOUNT: signerA.publicKey(),
      STELLAR_COLD_OPS_SIGNER_PUBLIC: signerB.publicKey(),
      STELLAR_COLD_POLICY_SIGNER_PUBLIC: third.publicKey(),
      STELLAR_PLATFORM_SECRET: hot.secret(),
      STELLAR_HOT_FLOAT_TRIGGER_UNITS: "1",
      STELLAR_HOT_FLOAT_TARGET_UNITS: "10",
      STELLAR_COLD_MIN_RETAIN_UNITS: "1",
    });
    const asset = new Asset("USDC", Keypair.random().publicKey());
    const transaction = buildReserveRefillTransaction({
      sourceAccount: new Account(policy.coldAccount, "41"),
      policy,
      asset,
      amountUnits: 5n,
    });

    addReserveRefillSignature(transaction, signerA, policy);
    addReserveRefillSignature(transaction, signerB, policy);

    expect(() =>
      validateReserveRefillTransaction({
        transaction,
        policy,
        asset,
        expectedAmountUnits: 5n,
        nowSeconds: Math.floor(Date.now() / 1000),
        requireSignatures: true,
      }),
    ).not.toThrow();
  });

  it("rejects an unconfigured signer and a duplicate signature", () => {
    const fixture = transactionFixture();

    expect(() =>
      addReserveRefillSignature(
        fixture.transaction,
        Keypair.random(),
        fixture.policy,
      ),
    ).toThrow(/configured/i);

    addReserveRefillSignature(fixture.transaction, fixture.cold, fixture.policy);
    expect(() =>
      addReserveRefillSignature(
        fixture.transaction,
        fixture.cold,
        fixture.policy,
      ),
    ).toThrow(/already signed/i);
  });

  it("rejects fewer than two configured signatures", () => {
    const fixture = transactionFixture();
    addReserveRefillSignature(fixture.transaction, fixture.cold, fixture.policy);

    expect(() =>
      validateReserveRefillTransaction({
        transaction: fixture.transaction,
        policy: fixture.policy,
        asset: fixture.asset,
        expectedAmountUnits: fixture.amountUnits,
        nowSeconds: Math.floor(Date.now() / 1000),
        requireSignatures: true,
      }),
    ).toThrow(/two distinct/i);
  });

  it.each([0n, -1n, 1_000_000_001n])(
    "rejects an unsafe expected amount %s even when the XDR matches",
    (expectedAmountUnits) => {
      const fixture = transactionFixture();

      expect(() =>
        validateReserveRefillTransaction({
          transaction: fixture.transaction,
          policy: fixture.policy,
          asset: fixture.asset,
          expectedAmountUnits,
          nowSeconds: Math.floor(Date.now() / 1000),
          requireSignatures: false,
        }),
      ).toThrow(/expected amount/i);
    },
  );

  it("rejects a memo on an otherwise valid payment", () => {
    const fixture = transactionFixture();
    const transaction = new TransactionBuilder(
      new Account(fixture.policy.coldAccount, "41"),
      { fee: "200", networkPassphrase: Networks.TESTNET },
    )
      .addOperation(
        Operation.payment({
          destination: fixture.policy.hotAccount,
          asset: fixture.asset,
          amount: "75.0000000",
        }),
      )
      .addMemo(Memo.text("not part of refill policy"))
      .setTimeout(180)
      .build();

    expect(() =>
      validateReserveRefillTransaction({
        transaction,
        policy: fixture.policy,
        asset: fixture.asset,
        expectedAmountUnits: fixture.amountUnits,
        nowSeconds: Math.floor(Date.now() / 1000),
        requireSignatures: false,
      }),
    ).toThrow(/memo/i);
  });

  it("rejects a transaction whose validity window starts in the future", () => {
    const fixture = transactionFixture();
    const nowSeconds = Math.floor(Date.now() / 1000);
    const transaction = new TransactionBuilder(
      new Account(fixture.policy.coldAccount, "41"),
      { fee: "200", networkPassphrase: Networks.TESTNET },
    )
      .addOperation(
        Operation.payment({
          destination: fixture.policy.hotAccount,
          asset: fixture.asset,
          amount: "75.0000000",
        }),
      )
      .setTimebounds(nowSeconds + 30, nowSeconds + 180)
      .build();

    expect(() =>
      validateReserveRefillTransaction({
        transaction,
        policy: fixture.policy,
        asset: fixture.asset,
        expectedAmountUnits: fixture.amountUnits,
        nowSeconds,
        requireSignatures: false,
      }),
    ).toThrow(/start time/i);
  });

  it("rejects an approval window longer than 15 minutes", () => {
    const fixture = transactionFixture();
    const nowSeconds = Math.floor(Date.now() / 1000);
    const transaction = new TransactionBuilder(
      new Account(fixture.policy.coldAccount, "41"),
      { fee: "200", networkPassphrase: Networks.TESTNET },
    )
      .addOperation(
        Operation.payment({
          destination: fixture.policy.hotAccount,
          asset: fixture.asset,
          amount: "75.0000000",
        }),
      )
      .setTimebounds(0, nowSeconds + 901)
      .build();

    expect(() =>
      validateReserveRefillTransaction({
        transaction,
        policy: fixture.policy,
        asset: fixture.asset,
        expectedAmountUnits: fixture.amountUnits,
        nowSeconds,
        requireSignatures: false,
      }),
    ).toThrow(/900 seconds/i);
  });

  it("rejects an extra signature from outside the configured signer set", () => {
    const fixture = transactionFixture();
    fixture.transaction.sign(fixture.cold, fixture.ops, Keypair.random());

    expect(() =>
      validateReserveRefillTransaction({
        transaction: fixture.transaction,
        policy: fixture.policy,
        asset: fixture.asset,
        expectedAmountUnits: fixture.amountUnits,
        nowSeconds: Math.floor(Date.now() / 1000),
        requireSignatures: true,
      }),
    ).toThrow(/unconfigured signature/i);
  });

  it.each([
    ["wrong source", (f: ReturnType<typeof transactionFixture>) =>
      directPayment({
        source: Keypair.random().publicKey(),
        destination: f.policy.hotAccount,
        asset: f.asset,
      })],
    ["operation source override", (f: ReturnType<typeof transactionFixture>) =>
      directPayment({
        source: f.policy.coldAccount,
        destination: f.policy.hotAccount,
        asset: f.asset,
        operationSource: Keypair.random().publicKey(),
      })],
    ["wrong destination", (f: ReturnType<typeof transactionFixture>) =>
      directPayment({
        source: f.policy.coldAccount,
        destination: Keypair.random().publicKey(),
        asset: f.asset,
      })],
    ["wrong asset issuer", (f: ReturnType<typeof transactionFixture>) =>
      directPayment({
        source: f.policy.coldAccount,
        destination: f.policy.hotAccount,
        asset: new Asset("USDC", Keypair.random().publicKey()),
      })],
    ["wrong amount", (f: ReturnType<typeof transactionFixture>) =>
      directPayment({
        source: f.policy.coldAccount,
        destination: f.policy.hotAccount,
        asset: f.asset,
        amount: "74.9999999",
      })],
    ["multiple operations", (f: ReturnType<typeof transactionFixture>) =>
      directPayment({
        source: f.policy.coldAccount,
        destination: f.policy.hotAccount,
        asset: f.asset,
        secondOperation: true,
      })],
    ["excessive fee", (f: ReturnType<typeof transactionFixture>) =>
      directPayment({
        source: f.policy.coldAccount,
        destination: f.policy.hotAccount,
        asset: f.asset,
        fee: "10001",
      })],
    ["unbounded time", (f: ReturnType<typeof transactionFixture>) =>
      directPayment({
        source: f.policy.coldAccount,
        destination: f.policy.hotAccount,
        asset: f.asset,
        timeout: 0,
      })],
  ])("rejects %s", (_label, makeTransaction) => {
    const fixture = transactionFixture();

    expect(() =>
      validateReserveRefillTransaction({
        transaction: makeTransaction(fixture),
        policy: fixture.policy,
        asset: fixture.asset,
        expectedAmountUnits: fixture.amountUnits,
        nowSeconds: Math.floor(Date.now() / 1000),
        requireSignatures: false,
      }),
    ).toThrow();
  });

  it("rejects fee-bump envelopes", () => {
    const fixture = transactionFixture();
    const feeBump = TransactionBuilder.buildFeeBumpTransaction(
      fixture.policy.hotAccount,
      "200",
      fixture.transaction,
      Networks.TESTNET,
    );

    expect(() =>
      validateReserveRefillTransaction({
        transaction: feeBump,
        policy: fixture.policy,
        asset: fixture.asset,
        expectedAmountUnits: fixture.amountUnits,
        nowSeconds: Math.floor(Date.now() / 1000),
        requireSignatures: false,
      }),
    ).toThrow(/fee-bump/i);
  });

  it("rejects an expired transaction", () => {
    const fixture = transactionFixture();
    const expired = new TransactionBuilder(
      new Account(fixture.policy.coldAccount, "41"),
      { fee: "200", networkPassphrase: Networks.TESTNET },
    )
      .addOperation(
        Operation.payment({
          destination: fixture.policy.hotAccount,
          asset: fixture.asset,
          amount: "75.0000000",
        }),
      )
      .setTimebounds(0, 1)
      .build();

    expect(() =>
      validateReserveRefillTransaction({
        transaction: expired,
        policy: fixture.policy,
        asset: fixture.asset,
        expectedAmountUnits: fixture.amountUnits,
        nowSeconds: 2,
        requireSignatures: false,
      }),
    ).toThrow(/expired/i);
  });
});

describe("reserve refill submission", () => {
  it("logs the signed hash before submitting exactly once", async () => {
    const fixture = transactionFixture();
    addReserveRefillSignature(fixture.transaction, fixture.cold, fixture.policy);
    addReserveRefillSignature(fixture.transaction, fixture.ops, fixture.policy);
    const hash = fixture.transaction.hash().toString("hex");
    const events: string[] = [];

    const result = await submitReserveRefill({
      signedXdr: fixture.transaction.toXDR(),
      policy: fixture.policy,
      asset: fixture.asset,
      hotBalanceUnits: 250_000_000n,
      coldBalanceUnits: 2_000_000_000n,
      nowSeconds: Math.floor(Date.now() / 1000),
      log(message) {
        events.push(`log:${message}`);
      },
      async submit(transaction) {
        events.push(`submit:${transaction.hash().toString("hex")}`);
        return { hash };
      },
    });

    expect(result).toEqual({ hash });
    expect(events).toHaveLength(3);
    expect(events[0]).toContain(`hash: ${hash}`);
    expect(events[1]).toContain(`/tx/${hash}`);
    expect(events[2]).toBe(`submit:${hash}`);
  });

  it("refuses an envelope whose amount differs from the amount the custodians agreed", async () => {
    // `prepare` prints the exact amount and the custodians sign it. When the
    // operator hands that amount to `submit`, an envelope carrying any other
    // amount must be refused before Horizon is contacted, so the check is a
    // real second reading rather than the envelope validating itself.
    const fixture = transactionFixture();
    addReserveRefillSignature(fixture.transaction, fixture.cold, fixture.policy);
    addReserveRefillSignature(fixture.transaction, fixture.ops, fixture.policy);
    const submit = vi.fn(async () => ({ hash: "unused" }));

    await expect(
      submitReserveRefill({
        signedXdr: fixture.transaction.toXDR(),
        policy: fixture.policy,
        asset: fixture.asset,
        hotBalanceUnits: 250_000_000n,
        coldBalanceUnits: 2_000_000_000n,
        nowSeconds: Math.floor(Date.now() / 1000),
        expectedAmountUnits: fixture.amountUnits + 1n,
        log: () => {},
        submit,
      }),
    ).rejects.toThrow(/amount/i);
    expect(submit).not.toHaveBeenCalled();
  });

  it("rejects when Horizon echoes a different transaction hash", async () => {
    const fixture = transactionFixture();
    addReserveRefillSignature(fixture.transaction, fixture.cold, fixture.policy);
    addReserveRefillSignature(fixture.transaction, fixture.ops, fixture.policy);

    await expect(
      submitReserveRefill({
        signedXdr: fixture.transaction.toXDR(),
        policy: fixture.policy,
        asset: fixture.asset,
        hotBalanceUnits: 250_000_000n,
        coldBalanceUnits: 2_000_000_000n,
        nowSeconds: Math.floor(Date.now() / 1000),
        log() {},
        async submit() {
          return { hash: "f".repeat(64) };
        },
      }),
    ).rejects.toThrow(/different hash/i);
  });

  it("never retries an unknown submission outcome", async () => {
    const fixture = transactionFixture();
    addReserveRefillSignature(fixture.transaction, fixture.cold, fixture.policy);
    addReserveRefillSignature(fixture.transaction, fixture.ops, fixture.policy);
    let submitCalls = 0;

    await expect(
      submitReserveRefill({
        signedXdr: fixture.transaction.toXDR(),
        policy: fixture.policy,
        asset: fixture.asset,
        hotBalanceUnits: 250_000_000n,
        coldBalanceUnits: 2_000_000_000n,
        nowSeconds: Math.floor(Date.now() / 1000),
        log() {},
        async submit() {
          submitCalls += 1;
          throw new Error("connection dropped after send");
        },
      }),
    ).rejects.toThrow(/connection dropped/i);
    expect(submitCalls).toBe(1);
  });
  it("still submits after payouts drained the hot wallet during signing", async () => {
    // Regression: the amount is fixed when the custodians sign it. A payout
    // landing inside the 15-minute ceremony must not invalidate their
    // signatures — only the two policy invariants have to still hold.
    const fixture = transactionFixture();
    addReserveRefillSignature(fixture.transaction, fixture.cold, fixture.policy);
    addReserveRefillSignature(fixture.transaction, fixture.ops, fixture.policy);
    const hash = fixture.transaction.hash().toString("hex");

    await expect(
      submitReserveRefill({
        signedXdr: fixture.transaction.toXDR(),
        policy: fixture.policy,
        asset: fixture.asset,
        // Prepared at 250000000; payouts since took it to 100000000.
        hotBalanceUnits: 100_000_000n,
        coldBalanceUnits: 2_000_000_000n,
        nowSeconds: Math.floor(Date.now() / 1000),
        log() {},
        async submit() {
          return { hash };
        },
      }),
    ).resolves.toEqual({ hash });
  });

  it("rejects a signed amount that would lift the hot float above target", async () => {
    const fixture = transactionFixture();
    addReserveRefillSignature(fixture.transaction, fixture.cold, fixture.policy);
    addReserveRefillSignature(fixture.transaction, fixture.ops, fixture.policy);
    let submitCalls = 0;

    await expect(
      submitReserveRefill({
        signedXdr: fixture.transaction.toXDR(),
        policy: fixture.policy,
        asset: fixture.asset,
        // 400000000 + 750000000 exceeds the 1000000000 float cap.
        hotBalanceUnits: 400_000_000n,
        coldBalanceUnits: 2_000_000_000n,
        nowSeconds: Math.floor(Date.now() / 1000),
        log() {},
        async submit() {
          submitCalls += 1;
          return { hash: "" };
        },
      }),
    ).rejects.toThrow(/above its target/i);
    expect(submitCalls).toBe(0);
  });

  it("rejects a signed amount that would breach the cold retained floor", async () => {
    const fixture = transactionFixture();
    addReserveRefillSignature(fixture.transaction, fixture.cold, fixture.policy);
    addReserveRefillSignature(fixture.transaction, fixture.ops, fixture.policy);
    let submitCalls = 0;

    await expect(
      submitReserveRefill({
        signedXdr: fixture.transaction.toXDR(),
        policy: fixture.policy,
        asset: fixture.asset,
        hotBalanceUnits: 250_000_000n,
        // 1000000000 - 750000000 leaves less than the 500000000 floor.
        coldBalanceUnits: 1_000_000_000n,
        nowSeconds: Math.floor(Date.now() / 1000),
        log() {},
        async submit() {
          submitCalls += 1;
          return { hash: "" };
        },
      }),
    ).rejects.toThrow(/retained floor/i);
    expect(submitCalls).toBe(0);
  });
});

describe("reserve refill live-balance invariants", () => {
  const policy = parseReserveRefillPolicy(policyFixture().env);

  it("permits an exact top-up to the target and an under-sized refill", () => {
    expect(() =>
      assertReserveRefillStillPermitted({
        policy,
        amountUnits: 750_000_000n,
        hotBalanceUnits: 250_000_000n,
        coldBalanceUnits: 1_250_000_000n,
      }),
    ).not.toThrow();
    expect(() =>
      assertReserveRefillStillPermitted({
        policy,
        amountUnits: 1n,
        hotBalanceUnits: 0n,
        coldBalanceUnits: 500_000_001n,
      }),
    ).not.toThrow();
  });

  it("rejects one unit over either bound", () => {
    expect(() =>
      assertReserveRefillStillPermitted({
        policy,
        amountUnits: 750_000_001n,
        hotBalanceUnits: 250_000_000n,
        coldBalanceUnits: 2_000_000_000n,
      }),
    ).toThrow(/above its target/i);
    expect(() =>
      assertReserveRefillStillPermitted({
        policy,
        amountUnits: 750_000_000n,
        hotBalanceUnits: 250_000_000n,
        coldBalanceUnits: 1_249_999_999n,
      }),
    ).toThrow(/retained floor/i);
  });
});

describe("reserve refill status I/O", () => {
  it("loads hot and cold USDC balances into the exact planner", async () => {
    const fixture = policyFixture();
    const asset = new Asset("USDC", Keypair.random().publicKey());
    const accounts = new Map([
      [
        fixture.hot.publicKey(),
        {
          account_id: fixture.hot.publicKey(),
          sequence: "10",
          balances: [
            { asset_type: "native", balance: "20.0000000" },
            {
              asset_type: "credit_alphanum4",
              asset_code: "USDC",
              asset_issuer: asset.getIssuer(),
              balance: "25.0000000",
            },
          ],
        },
      ],
      [
        fixture.cold.publicKey(),
        {
          account_id: fixture.cold.publicKey(),
          sequence: "20",
          balances: [
            { asset_type: "native", balance: "20.0000000" },
            {
              asset_type: "credit_alphanum4",
              asset_code: "USDC",
              asset_issuer: asset.getIssuer(),
              balance: "200.0000000",
            },
          ],
        },
      ],
    ]);

    const result = await loadReserveRefillStatus({
      env: fixture.env,
      asset,
      async loadAccount(accountId) {
        const account = accounts.get(accountId);
        if (!account) throw new Error(`unknown fixture account ${accountId}`);
        return account;
      },
    });

    expect(result).toEqual({
      status: "refill_required",
      amountUnits: 750_000_000n,
      hotBalanceUnits: 250_000_000n,
      coldBalanceUnits: 2_000_000_000n,
      coldAfterUnits: 1_250_000_000n,
    });
  });

  it("surfaces a missing cold USDC trustline as insufficient reserve", async () => {
    const fixture = policyFixture();
    const asset = new Asset("USDC", Keypair.random().publicKey());

    const result = await loadReserveRefillStatus({
      env: fixture.env,
      asset,
      async loadAccount(accountId) {
        return {
          account_id: accountId,
          sequence: "10",
          balances:
            accountId === fixture.hot.publicKey()
              ? [
                  {
                    asset_type: "credit_alphanum4",
                    asset_code: "USDC",
                    asset_issuer: asset.getIssuer(),
                    balance: "25.0000000",
                  },
                ]
              : [{ asset_type: "native", balance: "20.0000000" }],
        };
      },
    });

    expect(result).toEqual({
      status: "insufficient_reserve",
      requiredUnits: 750_000_000n,
      availableUnits: 0n,
      hotBalanceUnits: 250_000_000n,
      coldBalanceUnits: 0n,
    });
  });
});
