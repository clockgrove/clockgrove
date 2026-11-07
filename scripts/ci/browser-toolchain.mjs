// Verifies the Playwright Chromium that the lockfile pins: its executable is installed, and
// the default headless browser launches on this host, which also proves its native libraries.
// Exit 0 when verified.
import { access, constants } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";

const { chromium } = createRequire(path.join(process.cwd(), "package.json"))("playwright");

try {
  await access(chromium.executablePath(), constants.X_OK);
  await (await chromium.launch()).close();
} catch (error) {
  console.error(`Pinned Playwright Chromium is not usable: ${error.message}`);
  process.exitCode = 1;
}
