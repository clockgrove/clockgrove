import { CAPABILITY_REGISTRY } from "@clockgrove/application";
import { expect, it } from "vitest";
import { actorSystem } from "../src/actor-model.js";

// Issue 359: the model is told the fields of every command its world declares, not only resource.offer's.
it("names the fields of each declared world command in the actor's instructions", () => {
  const grants = CAPABILITY_REGISTRY.grantsFor(["runtime:world-command"], {
    commands: ["resource.offer", "resource.transfer"],
    callsPerTurn: 1,
  });
  const system = actorSystem(grants, undefined);
  expect(system).toContain('"type":"resource.offer","objectId"');
  expect(system).toContain(
    '"type":"resource.transfer","fromObjectId":<fromObjectId from the scene>,"toObjectId":<toObjectId from the scene>,"kind":<kind from the scene>',
  );
  expect(system).not.toContain('"schemaVersion"');
  expect(system).not.toContain('"quantity"');
});
