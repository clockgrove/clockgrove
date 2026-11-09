import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";

export async function readCaptureApprovals(directory) {
  const captured = JSON.parse(await readFile(path.join(directory, "captures.json"), "utf8"));
  const approved = JSON.parse(
    await readFile(path.join(directory, "approved-captures.json"), "utf8").catch((error) => {
      if (error.code === "ENOENT") return '{"approvals":[]}';
      throw error;
    }),
  );
  if (!Array.isArray(approved.approvals)) throw new Error("approvals must be an array");
  const reports = [];
  for (const capture of [...captured.captures, ...(captured.backendCaptures ?? [])]) {
    const file = path.resolve(directory, capture.file);
    if (!file.startsWith(`${path.resolve(directory)}${path.sep}`))
      throw new Error(`Capture path escapes output directory: ${capture.file}`);
    const bytes = await readFile(file);
    const sha256 = `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
    const approvals = approved.approvals.filter((entry) => entry.file === capture.file);
    reports.push({
      file: capture.file,
      state: capture.state,
      viewport: capture.viewport,
      sha256,
      approval: approvals.some((entry) => entry.sha256 === sha256)
        ? "approved"
        : approvals.length > 0
          ? "changed-needs-human-approval"
          : "pending-human-approval",
    });
  }
  return reports;
}
