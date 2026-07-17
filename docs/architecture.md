# Architecture

`x402-guard` is a buyer-side application control. It does not replace the x402
client, wallet, facilitator, RPC, or seller.

```text
seller's 402 challenge
          |
          v
  validate selected requirements
          |
          v
  evaluate application mandate
          |
          v
  append + fsync durable hold
          |
          v
     expose wallet signature
          |
          v
    attempt x402 settlement
          |
          v
 finalized Base Sepolia evidence
          |
          +---- exact nonce + Transfer ----> settled
          |
          +---- unused after expiry -------> released
          |
          `---- cannot prove either --------> remain committed
```

## Components

| Component | Responsibility |
|---|---|
| `Guard` | Serializes decisions and lifecycle changes; refuses new authority after unsafe state |
| Policy loader/evaluator | Parses a fixed schema and evaluates payee, amount, budget, velocity, and approval clauses |
| `LedgerStore` | Durably records a hold before `ALLOW` can return |
| x402 adapter | Validates the challenge, places the hold at the signing boundary, and captures the resulting authorization |
| `ChainReader` | Derives terminal evidence from finalized Base Sepolia state under the trusted-RPC assumption |
| Reconciler | Converts verified outcomes into `settled` or `released`; preserves all unknown outcomes |

## State and authority

A quote that passes policy becomes a durable `held` entry. That state is also a
global signing-gap lock: no second payment may enter signing until the exact
authorization or a generic exact-signer outcome has been recorded.

Once an authorization is attached, the hold remains committed until finalized
chain evidence proves settlement or proves the nonce unused strictly after the
authorization deadline. RPC errors, missing logs, wrong-chain responses, and
facilitator success are nonterminal.

See [the threat model](./threat-model.md) for assumptions and
[the design decisions](./design-decisions.md) for the reversals behind this
state machine.
