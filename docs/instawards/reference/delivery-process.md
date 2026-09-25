# How work is delivered

The same cycle runs every week, and each change passes the same gates.

## The weekly cycle

| Slot | What happens | Output |
| --- | --- | --- |
| **Mon–Wed** | The epic's issues are implemented **one at a time**, each through CI → review → human merge | Everything merged is on `develop` |
| **Wed, end of day** | **Development cut.** The epic's implementation is done | The tested SHA is frozen |
| **Thu–Fri** | **Manual QA** of the complete epic against that one build, in the epic's gate issue | A verdict naming the SHA |
| **Fri, end of day** | If QA passes, the QA-passed SHA is promoted | `staging` updated |
| **Sat** | SDF review. Required fixes are handled the same day | A fix list |

A Saturday fix is not a shortcut. It re-enters development → CI → review → merge → QA before it counts, and it takes time from the next epic's Monday.

## One issue, one branch, one PR

1. Pick the single issue whose dependencies are all closed. Nothing else is in flight.
2. Create a dedicated branch from `develop` and implement by hand.
3. Open a PR into `develop` that links its issue and epic. CI must be green.
4. Review the **current head SHA**, and record `CLAUDE REVIEW <full-head-sha> P0:0 P1:0`.
5. The builder merges. No bot ever merges.
6. Close the issue on merge, then release exactly one successor.

## Gates

| Gate | Where | What it proves |
| --- | --- | --- |
| `build` | CI, every PR | Migrations, the full test suite, typecheck and the production build |
| `payments-lane` | CI, every PR | The payment-critical suite on its own, including the no-single-key guard |
| `verify-commit-identities`, `single-contributor/verified` | CI, every PR | Every authored commit belongs to the builder, with no AI or bot co-author |
| CodeRabbit | Every PR | Automated review; threads are resolved before merge |
| `CLAUDE REVIEW <sha> P0:0 P1:0` | Comment | No blocking findings at that exact head |
| `QA PASSED <full-tested-sha>` | Comment on the epic's gate issue | A human ran the epic's journeys end to end **on that SHA** |

**The SHA rule.** A pass is bound to one exact commit. If anything merges afterwards, the pass is void and the epic is re-tested at the new SHA. There is no "it was only a small change".

## Branches

```
feature/issue-N  →  develop  →  staging  →  main
                    (integration)  (beta.centient.work)  (released deliverables)
```

## Epic gates

| Epic | Gate issue | QA window | Status |
| --- | --- | --- | --- |
| 1 | #80 (readiness #13) | 10–11 Sep | ✅ `QA:PASSED` 28/28 at `263be4c` |
| 2 | #31 | 17–18 Sep | ✅ `QA PASSED` at `8f660cc` on 21 Sep, 38/40 executed, 2 accepted as residual |
| 3 | #41 | 24–25 Sep | ✅ `QA PASSED` at `1fde77d` on 24 Sep, 65 of 68 cases passed |
| 4 | #53 | 1–2 Oct | — |

## Red lines

* Testnet only (D-7). Never submit a mainnet transaction.
* Never retry an ambiguous payout. Reconcile it, because a blind retry is how a double payment happens.
* Never mix up testnet and mainnet in a report. Redact keys, seeds and raw logs.
