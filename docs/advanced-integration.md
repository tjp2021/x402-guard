# Advanced direct integration

The x402 hook adapter is the recommended integration. Use the direct `Guard`
API only when your code owns the entire signing lifecycle and can durably attach
the exact authorization before it performs any other payment attempt.

```ts
const result = await guard.authorize(quote);
if (result.decision !== "allow") {
  // Stop, or route require_approval through a real external workflow.
  return result;
}

try {
  const signed = await createOneExactEip3009Authorization(quote);
  await guard.attachAuthorization(
    result.holdId,
    signed.nonce,
    signed.payer,
    signed.validBefore,
  );
  const facilitatorResult = await submitPayment(signed);
  await guard.reportSettlement(result.holdId, facilitatorResult.transaction);
} catch {
  // A generic failure does not prove that signing never happened. Record the
  // ambiguity; never release the hold by caller assertion.
  await guard.markCreationIndeterminate(
    result.holdId,
    "creation_outcome_unknown",
  );
}
```

The pseudocode leaves signer and facilitator functions application-specific.
They are part of the trusted computing base. The signer must create at most one
authorization for the attempt and bind scheme, network, asset, value, and payee
exactly to the held quote.

If an authorization may have been exposed but cannot be attached exactly, stop
creating new payment authority and investigate the durable ledger. Do not add a
timeout-based or operator-asserted release path.
