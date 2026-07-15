/**
 * Load a policy from a YAML (or JSON) file on disk.
 *
 * Kept separate from `load.ts` so the core validation has no filesystem or YAML
 * dependency — `loadPolicy` takes an already-parsed object and can run anywhere.
 * This is the thin convenience layer for the common case: a policy is a file a
 * human wrote.
 */

import { readFile } from "node:fs/promises";
import { parse } from "yaml";
import { loadPolicy, PolicyError } from "./load.js";
import type { Policy } from "./policy.js";

export async function loadPolicyFile(
  path: string,
  now: number,
): Promise<{ policy: Policy; hash: string }> {
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch (e) {
    throw new PolicyError(`cannot read policy ${path}: ${(e as Error).message}`);
  }

  let doc: unknown;
  try {
    doc = parse(text); // YAML is a superset of JSON, so this handles both
  } catch (e) {
    throw new PolicyError(`policy ${path} is not valid YAML/JSON: ${(e as Error).message}`);
  }

  return loadPolicy(doc, now);
}
