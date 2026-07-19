# Design decisions

A short record of the design calls that shaped this library, including the
ones that were wrong and got reversed. Newest last. The reversals are kept in
view rather than smoothed into a polished story; they are where the real
reasoning is.

## Money is integer-only

Amounts are `bigint` atomic units and never touch a float. `0.1 + 0.2 !== 0.3`
is not a curiosity in a payments library, it is a wrong authorization decision.
`parseDecimal` refuses more precision than the asset carries rather than
rounding: rounding a limit down silently loosens it, up silently tightens it.

## The gate is stateful; that is the whole point

x402's pre-payment hook (`onBeforePaymentCreation`) exists and can veto a
payment. An early assumption here was the opposite, and it was caught before
any code was written by reading the SDK source. The SDK supplies a lifecycle hook, but a bare hook does
not supply a durable cumulative ledger, append-before-sign reservation, or
recovery semantics. This library provides that application-owned stateful
layer. A caller could build another stateful hook; the contribution here is the
explicit lifecycle and failure boundary, not exclusive access to state.

## Authorization holds, because check-then-pay is not atomic

Two payments evaluated against the same remaining balance both pass and both
settle. The budget is breached by the tool meant to prevent it. So the gate
reserves budget at authorize time and reconciles at settlement, the way card
networks have for decades. Every Guard mutation runs through one serialized
queue. `Guard.authorize` evaluates, proposes the hold, appends and fsyncs it,
and only then applies it in memory and returns an ALLOW the caller may act on.

## Reconcile against the chain; never guess

When a payment goes quiet (a crash, a dead network, a facilitator that never
answered), the reconciler asks the configured chain reader rather than assuming.
Under the trusted-chain assumption, an attached authorization can eventually
resolve after settlement or expiry. Until then, or when the reader fails, the
correct result is unknown. Three answers stay distinct: verified settled,
finalized unused after expiry, and cannot-say. An unreachable RPC is never
mistaken for "did not happen."

## Never release a signed authorization that can still land

This decision was wrong twice before it was right. An EIP-3009 authorization is a signed bearer
instrument: once signed, a facilitator can submit it any time until its
`validBefore` deadline. So "not on chain yet" is not "never will be." Releasing a
hold before that deadline frees budget the agent respends while the original is
still landable, and both settle. The hold now carries `validBefore` and will not
release until the authorization can no longer be used.

And because the authorization is attached *after* the payload is signed, there
is a window where a live authorization exists with nothing recorded in the
ledger. A hold in that state cannot be proven unsigned, so it is never
released by caller assertion. Version 0.1 exposes no proof-free release method:
the hold remains committed unless finalized chain evidence resolves recorded
authority. This deliberately prefers a stuck budget to a second spend racing a
still-landable authorization.

The durable `held` state is therefore also a global in-flight lock, not merely an
amount reservation. Until the exact authorization or a generic exact-signer
outcome is durably recorded, no second payment may enter signing. A timer or a
direct reconciliation call never downgrades that state: if an attach or exposure
append fails, reopen still sees `held` and remains blocked.

An unreadable or mismatched after-creation payload is stronger than an ordinary
failure. It means the signer boundary visibly failed: the live authorization may
name a different recipient or an amount larger than the recorded hold. That
state is now an irreversible durable authority-exposure latch. It rejects all
new payment authority across reopen, while history and reconciliation of other
already-known holds remain available. A generic creation failure retains only
the original quote under the explicit assumption that the exact-scheme signer
never signs economics other than the selected requirements.
That signer must also create at most one authorization for each before-hook
attempt and bind scheme, network, asset, value, and payee exactly; otherwise one
recorded hold cannot bound the authority the signer emitted.
The pre-sign boundary also requires the Circle USDC EIP-712 domain (`USDC`,
version `2`), allows only the installed signer's absent/default or explicit
`eip3009` transfer selector, rejects Permit2 and unknown future metadata, and caps
`maxTimeoutSeconds` at one hour.

## Confirm the payment we authorized, not merely that a payment happened

`AuthorizationUsed` carries no amount and no recipient. Confirming on it alone
lets a caller sign a payment to a stranger and have the ledger record it as the
payment we approved, with a real transaction hash as proof. So the settlement's
ERC-20 `Transfer` log is checked against the quote (token, payer, recipient,
amount) and bound to this nonce's authorization by log position.

## Fail closed, everywhere, and know which way is safe

The safe error and the unsafe error are not symmetric, and every branch has to
know which is which. An unparseable policy denies everything, not allows it. A
corrupt ledger line refuses to load rather than under-counting spend. A negative
quote amount is denied at the boundary rather than minting budget. An
indeterminate outcome stays committed rather than being handed back.

## Trusted finalized contract state is the only negative evidence

The original design treated a completed log search plus local time as evidence
that a payment did not happen. That is not strong enough: an RPC can be stale, a range
can be wrong or truncated, and a local clock can be ahead of the chain.

Version 0.1 is pinned to Base Sepolia Circle USDC. Release of an attached signed
hold requires `authorizationState(payer, nonce) == false` at a finalized block
whose chain timestamp is strictly later than the canonical bigint
`validBefore`. Missing logs, missing receipts, wrong-chain RPCs, unsupported
finality, and clock skew all produce `unknown`, which carries no release
authority.

This is finalized-chain evidence under a trusted-RPC assumption, not a locally
verified consensus proof. A compromised provider can fabricate chain state. The
chain-ID, finality-support, and nonempty-code checks catch misconfiguration and
ordinary failure; Byzantine-RPC resistance needs an independent consensus or
multi-provider verification boundary.

## A facilitator result is a claim, not a terminal state

The happy path used to mark a hold settled directly from a facilitator success
response. That keeps budget committed, but it makes the audit trail claim more
than was verified. `reportSettlement` now records only a bounded transaction
hint and immediately asks the same finalized chain-evidence path used for recovery.
Settlement is terminal only after the nonce and the USDC Transfer's token,
payer, recipient, amount, block, and transaction all agree.

## Proposed events are inert until durability succeeds

Mutating memory and then appending creates a dangerous disagreement when the
append or fsync fails. The ledger now proposes and validates an immutable event
without changing authoritative state. Guard appends and fsyncs it first, applies
it second, and latches faulted on either failure. A faulted Guard refuses new
authority until a clean reopen replays the durable log.

## The ledger is evidence, not a debug log

Raw resource URLs, error messages, and free-form notes do not belong in durable
payment evidence. The versioned JSONL schema stores a SHA-256 resource
fingerprint and bounded reason codes. It rejects unknown or duplicate fields,
lossy integers, impossible transitions, partial tails, and legacy unversioned
records. On POSIX systems the leaf must be a regular single-link file and is
kept at mode `0600`; the parent directory is assumed trusted and single-writer.

## Policy identity travels with the policy

Accepting `{ policy, policyHash }` as unrelated arguments lets a caller attach
the wrong identity to a decision. `loadPolicy` and `loadPolicyFile` now return a
deeply frozen, opaque `LoadedPolicy` whose hash was derived from that exact
normalized value. Guard accepts that value as one unit.

## Approval is caller-attested, not independently human-verified

An in-process method cannot prove who clicked or approved anything. The old
`approve` name overstated the boundary. `attestCallerApproval` is still
quote-bound, expiring, serialized, and single-use, but the API now says exactly
what happened: the caller asserted approval. That assertion is ephemeral and is
not itself a durable ledger event. A future independently evidenced human
control needs an external verifier and an explicit evidence schema.

## Tests must be able to fail

The safety-critical claims above are backed by a test that goes red when the
code breaks, checked by deliberately breaking the code and confirming the test
fails, not by asserting it does. That lesson was learned the hard way:
more than once a test passed against deliberately broken code, which means it was
decoration. If a test cannot fail, it is not a test.
