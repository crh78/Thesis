import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { parseDexes } from "@thesis/venues/bank";
import { FORK_DEXES, REPO_ROOT } from "../lib.ts";

// The asset bank probes through ASSET_BANK_DEXES; the fork's router through FORK_DEXES. If they
// differ, the take builder offers tokens the receipt can't buy (or hides ones it can).
test("the VM template's ASSET_BANK_DEXES is the fork router's FORK_DEXES", () => {
  const template = readFileSync(join(REPO_ROOT, "infra/executor/executor.env.example"), "utf8");
  const line = template.split("\n").find((l) => l.startsWith("ASSET_BANK_DEXES="));
  assert.ok(line, "infra/executor/executor.env.example sets ASSET_BANK_DEXES");
  assert.deepEqual(parseDexes(line.slice("ASSET_BANK_DEXES=".length)), FORK_DEXES);
});
