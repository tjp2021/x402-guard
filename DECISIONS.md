# Decisions

A short record of the design calls that shaped this library, and the ones I got
wrong and reversed. Newest last. I'd rather show the reversals than a polished
story — the reversals are where the real reasoning is.

## Money is integer-only

Amounts are `bigint` atomic units and never touch a float. `0.1 + 0.2 !== 0.3`
is not a curiosity in a payments library, it is a wrong authorization decision.
`parseDecimal` refuses more precision than the asset carries rather than
rounding — rounding a limit down silently loosens it, up silently tightens it.

## The gate is stateful; that is the whole point

x402's own pre-payment hook (`onBeforePaymentCreation`) exists and can veto a
payment — I was wrong to think otherwise, and caught that before writing code by
reading the SDK source. But the hook is stateless: it sees one quote at a time.
So it cannot see that two under-limit payments add up to an over-limit one. This
library adds the cumulative budget the hook can't hold. That is the one thing it
does that the SDK does not.

## Authorization holds, because check-then-pay is not atomic

Two payments evaluated against the same remaining balance both pass and both
settle — the budget is breached by the tool meant to prevent it. So the gate
reserves budget at authorize time and reconciles at settlement, the way card
networks have for decades. `Guard.authorize` does evaluate-and-hold in one
synchronous critical section, and persists the hold before returning an ALLOW
the caller may act on.

## Reconcile against the chain; never guess

When a payment goes quiet — a crash, a dead network, a facilitator that never
answered — the outcome is not unknowable. The payment either settled on a public
chain or it did not. So the reconciler asks the chain rather than assuming. Three
answers, kept distinct: settled, definitively-not-settled, and cannot-say. An
unreachable RPC is never mistaken for "did not happen" — collapsing those two is
how a hold gets released for money that already left.

## Never release a signed authorization that can still land

This one I got wrong twice. An EIP-3009 authorization is a signed bearer
instrument: once signed, a facilitator can submit it any time until its
`validBefore` deadline. So "not on chain yet" is not "never will be." Releasing a
hold before that deadline frees budget the agent respends while the original is
still landable — both settle. The hold now carries `validBefore` and will not
release until the authorization can no longer be used.

And because the authorization is attached *after* the payload is signed, there
is a window where a live authorization exists with nothing recorded in the
ledger. A hold in that state cannot be proven unsigned, so it is never
auto-released — it flags for a human, or the caller affirms it was never signed
via `abandon`.

## Confirm the payment we authorized, not merely that a payment happened

`AuthorizationUsed` carries no amount and no recipient. Confirming on it alone
lets a caller sign a payment to a stranger and have the ledger record it as the
payment we approved, with a real transaction hash as proof. So the settlement's
ERC-20 `Transfer` log is checked against the quote — token, payer, recipient,
amount — and bound to this nonce's authorization by log position.

## Fail closed, everywhere, and know which way is safe

The safe error and the unsafe error are not symmetric, and every branch has to
know which is which. An unparseable policy denies everything, not allows it. A
corrupt ledger line refuses to load rather than under-counting spend. A negative
quote amount is denied at the boundary rather than minting budget. An
indeterminate outcome stays committed rather than being handed back.

## Tests must be able to fail

The safety-critical claims above are backed by a test that goes red when the
code breaks — checked by deliberately breaking the code and confirming the test
fails, not by asserting it does. I learned this the hard way:
more than once a test passed against deliberately broken code, which means it was
decoration. If a test cannot fail, it is not a test.
