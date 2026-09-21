import { Keypair } from "@stellar/stellar-sdk";
import { call, evidence, sep53, short } from "./kit";
(async () => {
  const A = Keypair.random(), B = Keypair.random();
  const c = await call("POST", "/api/auth/wallet/challenge", { json: { address: A.publicKey() } });
  const bad = await call("POST", "/api/auth/wallet/verify", { json: { address: A.publicKey(), nonce: c.body.nonce, signature: sep53(A, c.body.message), signerAddress: B.publicKey() } });
  const good = await call("POST", "/api/auth/wallet/verify", { json: { address: A.publicKey(), nonce: c.body.nonce, signature: sep53(A, c.body.message), signerAddress: A.publicKey() } });
  const out = { A: short(A.publicKey()), reportedSigner: short(B.publicKey()),
    wrongSigner: { status: bad.status, body: bad.body, sessionCookie: Boolean(bad.headers["set-cookie"]) },
    realSignerAfterwards: { status: good.status, sessionIssued: Boolean(good.headers["set-cookie"]), note: "challenge stayed live after the refusal (#109)" } };
  evidence("005", "E005-4-server-wrong-signer.json", out);
  console.log(JSON.stringify(out, null, 1));
})();
