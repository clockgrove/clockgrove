import { createHash } from "node:crypto";
import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { decodeConversationSession, decodeTalkReceipt } from "@clockgrove/contracts";
import { expect, it } from "vitest";
import {
  isNativeWorldOwnerChild,
  runNativeWorldOwnerProcess,
  withNativeWorldOwner,
} from "./world-owner/native-harness.js";

const FILE = "apps/runtime/test/actor-commands.journey.postgres.test.ts";
const MEMBER = "local-reader-session";
const POLICY = "policies/actor-commands.json";
const TRANSFER = `fixture:use world.command {"type":"resource.transfer","fromObjectId":"fixture.household-water","toObjectId":"fixture.water-bowl","kind":"water"}`;

/** A second test world: the fixture-hall pack with its own actor-command declaration, or none. */
async function world(root: string, name: string, commands?: readonly string[]) {
  const pack = path.join(root, name);
  await cp(path.resolve("worlds/fixture/reference"), pack, { recursive: true });
  const manifest = JSON.parse(await readFile(path.join(pack, "manifest.json"), "utf8"));
  const file = path.join(pack, "resources", POLICY);
  const bytes = JSON.stringify({
    callsPerTurn: 1,
    commands,
    schemaVersion: 1,
    type: "clockgrove.actor-command-policy",
  });
  if (commands === undefined) await rm(file);
  else await writeFile(file, bytes);
  manifest.policies = manifest.policies.flatMap((entry: { path: string }) =>
    entry.path !== POLICY
      ? [entry]
      : commands === undefined
        ? []
        : [{ ...entry, sha256: createHash("sha256").update(bytes).digest("hex") }],
  );
  await writeFile(path.join(pack, "manifest.json"), JSON.stringify(manifest));
  return pack;
}

it.skipIf(isNativeWorldOwnerChild())(
  "owns provider, PostgreSQL and workerd for each world",
  async () => {
    const root = await mkdtemp(path.join(tmpdir(), "actor-commands-"));
    try {
      for (const pack of [
        await world(root, "transfer", ["resource.offer", "resource.transfer"]),
        await world(root, "undeclared"),
      ])
        await runNativeWorldOwnerProcess(FILE, pack, {
          timeoutMs: 180_000,
          prepare: async (fixture) => {
            const { truthOf } = await import("./world-fixture.js");
            await truthOf(fixture)(
              `UPDATE clockgrove.world_memberships
                  SET grants = ARRAY(SELECT DISTINCT unnest(grants ||
                        ARRAY['runtime:world-observe', 'runtime:world-command'])),
                      persona_id = 'persona-caretaker',
                      privacy_ceiling = '{"version":1,"allowedCategories":["public_scene","conversation"]}'`,
            );
          },
        });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
  420_000,
);

it.skipIf(!isNativeWorldOwnerChild())(
  "lets an actor propose only the commands its world declares",
  async () => {
    await withNativeWorldOwner(async (owner) => {
      const post = (route: string, fields: object) =>
        owner.request(route, { version: 1, ...owner.scope, ...fields }, MEMBER);
      const sessionId = decodeConversationSession(
        (await post("/v1/runtime/conversations/create", { actorId: "fixture.keeper" })).body,
      ).sessionId;
      const say = async (messageId: string, text: string) => {
        const answered = await post("/v1/runtime/talk", { sessionId, messageId, text });
        expect(answered.status).toBe(200);
        return decodeTalkReceipt(answered.body).command;
      };

      if (path.basename(owner.packName) === "transfer") {
        // The world declares resource.transfer: Keeper's transfer is admitted and the world commits it.
        const moved = await say("m1", TRANSFER);
        expect(moved).toMatchObject({ capability: "world.command", status: "committed" });
        expect(
          await owner.sql(
            `SELECT status || ' ' || (SELECT count(*) FROM clockgrove.events e WHERE e.command_id = r.command_id AND e.event_type = 'resource.transferred')
               FROM clockgrove.command_receipts r WHERE command_id = '${moved?.commandId}'`,
          ),
        ).toBe("committed 1");
        // A command the declaration doesn't name is still refused before the world.
        expect(await say("m2", "fixture:call world.command resource.consume")).toMatchObject({
          status: "refused",
          code: "command_type_not_granted",
          commandId: null,
        });
        return;
      }
      // With no declaration, Keeper may propose nothing, not even the offer it proposed before.
      const refused = { status: "refused", code: "not_granted", commandId: null };
      expect(await say("m1", "fixture:offer fixture.water-bowl water")).toMatchObject(refused);
      expect(await say("m2", TRANSFER)).toMatchObject(refused);
      expect(await owner.sql("SELECT count(*) FROM clockgrove.command_receipts")).toBe("0");
    });
  },
  240_000,
);
