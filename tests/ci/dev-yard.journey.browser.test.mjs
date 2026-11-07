import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import { expect, it } from "vitest";

const root = fileURLToPath(new URL("../../", import.meta.url));

// issue 1002: `pnpm dev:yard` serves green-lake-yard@1 at the URL it prints, the printed credential signs
// in there, and Ctrl-C removes the temporary database it created.
it("serves the living yard it prints and removes it on Ctrl-C", async () => {
  const yard = spawn(process.execPath, ["scripts/dev-yard.mjs"], {
    cwd: root,
    detached: true,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  const exited = new Promise((resolve) => yard.on("exit", (code) => resolve(code)));
  const printed = new Promise((resolve) => {
    const read = (chunk) => {
      output += chunk;
      const url = /Open: +(\S+)/u.exec(output)?.[1];
      const credential = /credential "([^"]+)"/u.exec(output)?.[1];
      if (url && credential) resolve({ url: new URL(url), credential });
    };
    yard.stdout.setEncoding("utf8").on("data", read);
    yard.stderr.setEncoding("utf8").on("data", read);
  });
  let browser;
  try {
    const { url, credential } = await Promise.race([
      printed,
      exited.then((code) => Promise.reject(new Error(`dev:yard exited ${code}\n${output}`))),
    ]);
    const directory = await fetch(new URL("/v1/runtime/world-directory", url), {
      method: "POST",
      headers: { authorization: `Bearer ${credential}`, "content-type": "application/json" },
      body: JSON.stringify({ version: 1 }),
    }).then((response) => response.json());
    const [{ tenantId, worldId, timelineId, spaceId }] = directory.entries;
    expect([directory.entries.length, url.pathname, credential]).toEqual([
      1,
      `/worlds/${tenantId}/${worldId}/${timelineId}/${spaceId}`,
      "yard-observer",
    ]);
    browser = await chromium.launch({ headless: true });
    const page = await browser.newPage();
    await page.goto(url.toString());
    await page.getByLabel("Local session credential").fill(credential);
    await page.getByRole("button", { name: "Sign in", exact: true }).click();
    await page.getByText(/^Arrival: (text )?scene ready at revision /u).waitFor();
    expect(await page.getByText(/^Arrival: /u).textContent()).toBe(
      "Arrival: scene ready at revision 0.",
    );
  } finally {
    await browser?.close();
    process.kill(-yard.pid, "SIGINT");
  }
  const database = /creating directory (\S+)\/data/u.exec(output)?.[1];
  expect([await exited, typeof database, database && existsSync(database)]).toEqual([
    0,
    "string",
    false,
  ]);
}, 240_000);
