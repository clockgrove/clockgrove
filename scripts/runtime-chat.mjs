#!/usr/bin/env node
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";

const HELP = `Usage: node scripts/runtime-chat.mjs <create|list|read|talk|say> [options]
Required: --url --tenant --world --timeline --space
Authentication: CLOCKGROVE_SESSION_TOKEN environment variable
create: --actor [--title] [--thread]    list: [--actor]
read: --session [--after-sequence] [--limit]
talk: --session --message-id --text
say: --actor --message-id --text
Talk is private; Say explicitly requests public speech. Output is JSON.
`;
const COMMON = ["url", "tenant", "world", "timeline", "space"];
const OPERATIONS = {
  create: {
    route: "/v1/runtime/conversations/create",
    required: ["actor"],
    optional: ["title", "thread"],
  },
  list: { route: "/v1/runtime/conversations/list", required: [], optional: ["actor"] },
  read: {
    route: "/v1/runtime/conversations/read",
    required: ["session"],
    optional: ["after-sequence", "limit"],
  },
  talk: { route: "/v1/runtime/talk", required: ["session", "message-id", "text"], optional: [] },
  say: { route: "/v1/runtime/say", required: ["actor", "message-id", "text"], optional: [] },
};
const FIELDS = {
  actor: "actorId",
  session: "sessionId",
  "message-id": "messageId",
  text: "text",
  title: "title",
  thread: "threadId",
  "after-sequence": "afterSequence",
  limit: "limit",
};

export async function main(argv) {
  if (argv.length === 1 && argv[0] === "--help") {
    process.stdout.write(HELP);
    return;
  }
  const [command, ...args] = argv;
  const operation = Object.hasOwn(OPERATIONS, command) ? OPERATIONS[command] : undefined;
  if (!operation) throw new Error("invalid operation");
  const { values } = parseArgs({
    args,
    options: Object.fromEntries(
      [...COMMON, ...operation.required, ...operation.optional].map((name) => [
        name,
        { type: "string" },
      ]),
    ),
    strict: true,
    allowPositionals: false,
  });
  for (const name of [...COMMON, ...operation.required])
    if (!values[name]?.trim()) throw new Error("missing argument");
  // biome-ignore lint/suspicious/noUndeclaredEnvVars: this operator CLI runs directly, outside Turbo tasks.
  const token = process.env.CLOCKGROVE_SESSION_TOKEN;
  if (!token?.trim() || token.trim() !== token) throw new Error("missing credential");
  const origin = new URL(values.url);
  if (
    origin.username ||
    origin.password ||
    origin.search ||
    origin.hash ||
    origin.pathname !== "/" ||
    (origin.protocol !== "https:" &&
      !(
        origin.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(origin.hostname)
      ))
  )
    throw new Error("invalid runtime origin");
  const body = {
    version: 1,
    tenantId: values.tenant,
    worldId: values.world,
    timelineId: values.timeline,
    spaceId: values.space,
  };
  for (const name of [...operation.required, ...operation.optional]) {
    if (values[name] === undefined) continue;
    const field = FIELDS[name];
    if (name === "after-sequence" || name === "limit") {
      if (!/^\d+$/.test(values[name])) throw new Error("invalid page argument");
      const number = Number(values[name]);
      if (!Number.isSafeInteger(number)) throw new Error("invalid page argument");
      body[field] = number;
    } else body[field] = values[name];
  }
  if (command === "create" || command === "say") body.channel = "cli";
  const response = await fetch(new URL(operation.route, origin), {
    method: "POST",
    redirect: "error",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
      accept: "application/json",
    },
    body: JSON.stringify(body),
    // Decision: bound an operator invocation to two minutes, including reading its response.
    signal: AbortSignal.timeout(120_000),
  });
  if (!response.ok) throw new Error("runtime refused request");
  let result;
  if (response.headers.get("content-type")?.includes("application/x-ndjson")) {
    if (command !== "talk") throw new Error("unexpected stream");
    const lines = (await response.text()).trim().split("\n");
    const final = JSON.parse(lines.at(-1));
    if (final.type !== "receipt") throw new Error("turn incomplete or refused");
    result = final.receipt;
  } else {
    if (!response.headers.get("content-type")?.includes("application/json"))
      throw new Error("unexpected response");
    result = await response.json();
  }
  process.stdout.write(`${JSON.stringify(result)}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href)
  try {
    await main(process.argv.slice(2));
  } catch {
    // Never echo a credential, request body, URL or an arbitrary server error.
    process.stderr.write(
      "Runtime chat failed; check arguments, credentials and runtime availability.\n",
    );
    process.exitCode = 1;
  }
