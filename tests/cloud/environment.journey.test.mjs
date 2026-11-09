// The cloud suite, run by `pnpm test:cloud [environment]`. Every environment plans reproducibly
// with no pending change; `local` and `ci` own nothing. A hosted environment is also probed through
// its deployed HTTPS origin.
import { readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { root } from "../../scripts/ci/evidence.mjs";
import { withEnvironmentPlans, zeroResource } from "../../scripts/infra-plan.mjs";

const target = process.env.CLOCKGROVE_CLOUD_ENVIRONMENT;
if (!target) throw new Error("run the cloud suite with pnpm test:cloud [environment]");
const config = JSON.parse(
  await readFile(path.join(root, `infra/environments/${target}.json`), "utf8"),
);

it(`plans ${target} reproducibly with no pending change`, async () => {
  const [first, second] = await withEnvironmentPlans(target, async (plan) => [
    await plan(),
    await plan(),
  ]);
  expect(second.changeDigest).toBe(first.changeDigest);
  expect(first.pending).toEqual([]);
  if (zeroResource(target)) expect(first.resources).toBe(0);
}, 600_000);

describe.runIf(!zeroResource(target))(`deployed ${target} runtime`, () => {
  const origin = config.authentication.origin;
  it("serves the web shell over HTTPS", async () => {
    const response = await fetch(origin, { signal: AbortSignal.timeout(30_000) });
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toMatch(/^text\/html/u);
  });
  it("refuses an unauthenticated runtime request", async () => {
    const response = await fetch(new URL("/v1/runtime/world-directory", origin), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
      signal: AbortSignal.timeout(30_000),
    });
    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ error: "authentication_refused" });
  });
});
