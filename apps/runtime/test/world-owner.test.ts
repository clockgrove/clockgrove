import {
  CanonicalNodeError,
  encodeCanonicalNode,
  InMemoryRuntimeLogger,
  JournalRevisionConflictError,
  releaseRuntimeLogger,
  type WorldCommandResult,
} from "@clockgrove/application";
import { ContractDecodeError, decodeOpaqueId } from "@clockgrove/contracts";
import { expect, it, vi } from "vitest";
import { RuntimeWorker } from "../src/worker.js";
import {
  decodeWorldCommandInput,
  ownerLogIds,
  unwrapWorldCommandRpc,
  worldCommandBytes,
  worldCommandRpc,
} from "../src/world-commands.js";
import { authenticationFixture } from "./auth-fixture.js";
import { trustedTestContext } from "./trusted-context.js";
import { advanceCommand, testWorld } from "./world-fixture.js";

it("accepts the canonical envelope and makes all epoch, scope and authenticated identity bytes significant", async () => {
  const world = await testWorld();
  const space = world.birth.spaces[0];
  if (space === undefined) throw new Error("fixture world requires a space");
  const scope = {
    tenantId: world.birth.world.tenantId,
    worldId: world.birth.world.worldId,
    timelineId: world.birth.world.timelineId,
    spaceId: space.spaceId,
  };
  const command = { ...advanceCommand(world, "boundary-command", 123n, null), schemaVersion: 2 };
  const envelope = {
    schemaVersion: 1,
    ...scope,
    routingEpoch: "7",
    authorityEpoch: "8",
    command: encodeCanonicalNode(command),
  };
  const decoded = decodeWorldCommandInput(envelope);
  expect(decoded).toEqual({ scope, command, epochs: { routingEpoch: 7n, authorityEpoch: 8n } });
  expect(decoded.command.payload).toEqual({
    schemaVersion: 1,
    targetTime: 123n,
    maxInputs: 64,
    maxEvents: 256,
  });
  const accepted = worldCommandBytes(decoded, "principal-a");
  for (const changed of [
    decodeWorldCommandInput({ ...envelope, routingEpoch: "8" }),
    decodeWorldCommandInput({ ...envelope, authorityEpoch: "9" }),
    decodeWorldCommandInput({
      ...envelope,
      command: encodeCanonicalNode({
        ...command,
        context: { ...command.context, requestId: "changed" },
      }),
    }),
  ])
    expect(worldCommandBytes(changed, "principal-a")).not.toEqual(accepted);
  expect(worldCommandBytes(decoded, "principal-b")).not.toEqual(accepted);
  for (const invalid of [
    { ...envelope, schemaVersion: 2 },
    { ...envelope, context: { grants: ["runtime:world-command"] } },
    { ...envelope, principalId: "caller" },
    { ...envelope, routingEpoch: "01" },
    { ...envelope, routingEpoch: "-1" },
    { ...envelope, routingEpoch: "+1" },
    { ...envelope, routingEpoch: 1 },
    { ...envelope, authorityEpoch: "1.0" },
    { ...envelope, tenantId: "another-tenant" },
    { ...envelope, worldId: "another-world" },
    { ...envelope, timelineId: "another-timeline" },
    {
      ...envelope,
      command: encodeCanonicalNode({ ...command, commandId: "trusted:continue:client:1" }),
    },
    { ...envelope, command: encodeCanonicalNode({ ...command, extra: true }) },
  ])
    expect(() => decodeWorldCommandInput(invalid)).toThrow(ContractDecodeError);
  expect(() => decodeWorldCommandInput({ ...envelope, command })).toThrow(CanonicalNodeError);
  expect(() => decodeWorldCommandInput({ ...envelope, command: ["bigint", "01"] })).toThrow(
    ContractDecodeError,
  );
});

it.each(["decided", "undecided"])(
  "keeps accepted caller attribution outside world authority: %s",
  async (phase) => {
    const authority = authenticationFixture();
    if (phase === "decided") {
      authority.removeWorld();
      authority.removeWorkspace();
    }
    const context = trustedTestContext();
    if (
      context.worldId === undefined ||
      context.timelineId === undefined ||
      context.spaceId === undefined
    )
      throw new Error("fixture requires world scope");
    const scope = {
      tenantId: context.tenantId,
      worldId: context.worldId,
      timelineId: context.timelineId,
      spaceId: context.spaceId,
    };
    const world = await testWorld();
    const command = {
      ...advanceCommand(world, "stored-exact", 123n, null),
      attribution: {
        principalId: "caller-supplied-principal",
        worldMembershipId: "caller-supplied-membership",
        personaId: "caller-supplied-persona",
        effectiveActorId: "caller-supplied-actor",
        causalRootActionId: "caller-supplied-action",
      },
      target: {
        version: 1,
        tenantId: scope.tenantId,
        worldId: scope.worldId,
        timelineId: scope.timelineId,
        kind: "world",
        id: scope.worldId,
      },
    };
    const stored: WorldCommandResult =
      phase === "decided"
        ? {
            commandId: decodeOpaqueId("stored-exact", "CommandId"),
            outcome: "committed",
            value: {
              status: "committed",
              revision: "9",
              simulationTime: "123",
              complete: false,
              eventCount: 0,
              stateHash: "a".repeat(64),
            },
            events: [],
          }
        : {
            commandId: decodeOpaqueId("stored-exact", "CommandId"),
            outcome: "rejected",
            value: { status: "denied", reasonCode: "runtime-grant-missing" },
            events: [],
          };
    const submit = vi.fn(async () => {
      throw new Error("decided retry must not execute");
    });
    const deny = vi.fn(async () => stored);
    const getSpace = vi.fn(() => {
      throw new Error("decided retry must not construct an owner");
    });
    const prepare = vi.fn(async () => ({
      tenantMember: true,
      ready: true,
      ...(phase === "decided" ? { stored } : {}),
    }));
    const response = await new RuntimeWorker(authority.authenticator, {
      getSpace,
      worldCommands: { prepare, submit, deny },
    }).fetch(
      new Request("http://runtime.test/v1/runtime/commands", {
        method: "POST",
        headers: { authorization: "Bearer valid", "content-type": "application/json" },
        body: JSON.stringify({
          schemaVersion: 1,
          ...scope,
          routingEpoch: "1",
          authorityEpoch: "1",
          command: encodeCanonicalNode(command),
        }),
      }),
    );
    expect(response.status).toBe(phase === "decided" ? 200 : 403);
    expect(await response.json()).toEqual(encodeCanonicalNode(stored));
    expect(prepare).toHaveBeenCalledTimes(1);
    expect(authority.worldResolutions()).toBe(phase === "decided" ? 0 : 1);
    expect(submit).toHaveBeenCalledTimes(0);
    expect(deny).toHaveBeenCalledTimes(phase === "decided" ? 0 : 1);
    if (phase === "undecided")
      expect(deny).toHaveBeenCalledWith(
        { scope, command, epochs: { routingEpoch: 1n, authorityEpoch: 1n } },
        context.principalId,
        {
          reasonCode: "runtime-grant-missing",
          inputs: {
            principalId: context.principalId,
            worldMembershipId: "world-membership",
            personaId: "world-persona",
            roles: [],
            grants: ["runtime:no-op"],
            privacyCeiling: context.privacyCeiling,
          },
        },
      );
    expect(getSpace).toHaveBeenCalledTimes(0);
  },
);

it("logs a failed world command once, at the owner, with its IDs and a redacted cause", async () => {
  const authority = authenticationFixture();
  authority.setWorldGrants([decodeOpaqueId("runtime:world-command", "GrantRef")]);
  const context = trustedTestContext();
  const scope = {
    tenantId: context.tenantId,
    worldId: context.worldId,
    timelineId: context.timelineId,
    spaceId: context.spaceId,
  };
  const logger = new InMemoryRuntimeLogger();
  // A connection string and a libpq password in the cause; neither may reach the log.
  const secret = ["fixture", "secret"].join("-");
  const leaked = new URL("postgres://rt@db.test/cg");
  leaked.password = secret;
  const response = await new RuntimeWorker(
    authority.authenticator,
    {
      getSpace: () => {
        throw new Error("world commands do not use the no-op owner");
      },
      worldCommands: {
        prepare: async () => ({ tenantMember: true, ready: true }),
        // The production relay: the owner logs the cause; the Worker answers the relayed failure.
        submit: async (input, trusted) =>
          unwrapWorldCommandRpc(
            await worldCommandRpc(
              logger,
              ownerLogIds(input.scope, trusted, input.command.commandId),
              () =>
                Promise.reject(new Error(`connect ${leaked} ${["password", secret].join("=")}`)),
            ),
          ),
        deny: async () => {
          throw new Error("an authorized command is not denied");
        },
      },
    },
    logger,
  ).fetch(
    new Request("http://runtime.test/v1/runtime/commands", {
      method: "POST",
      headers: { authorization: "Bearer valid", "content-type": "application/json" },
      body: JSON.stringify({
        schemaVersion: 1,
        ...scope,
        routingEpoch: "1",
        authorityEpoch: "1",
        command: encodeCanonicalNode({
          ...advanceCommand(await testWorld(), "failed-command", 1n, null),
          target: {
            version: 1,
            tenantId: scope.tenantId,
            worldId: scope.worldId,
            timelineId: scope.timelineId,
            kind: "world",
            id: scope.worldId,
          },
        }),
      }),
    }),
  );
  expect(response.status).toBe(500);
  expect(await response.json()).toEqual({ error: "world_command_failed" });
  // The owner's failure record carries the cause; the Worker's answered record only its class.
  const [{ timestamp, error, ...record }, answered] = JSON.parse(JSON.stringify(logger.records));
  const ids = {
    ...scope,
    correlationId: "correlation-failed-command",
    requestId: "failed-command",
    commandId: "failed-command",
  };
  const failure = { failureClass: "internal", retryable: false };
  expect(record).toEqual({
    schemaVersion: 5,
    level: "error",
    event: "world_owner_failed",
    ...ids,
    ...failure,
  });
  expect(new Date(timestamp).toISOString()).toBe(timestamp);
  expect([error.name, error.message]).toEqual(["Error", "connect [url] password=[redacted]"]);
  expect(error.stack).not.toContain(secret);
  expect({ ...answered, timestamp: undefined }).toEqual({
    schemaVersion: 5,
    level: "warn",
    event: "world_command_answered",
    ...ids,
    authorization: "authorized",
    outcome: "failed",
    code: "world_command_failed",
    status: 500,
    routingEpoch: 1,
    ...failure,
  });
  expect(logger.records.length).toBe(2);
});

it("answers each world command with one record: committed, replayed, refused, conflicting", async () => {
  const authority = authenticationFixture();
  authority.setWorldGrants([decodeOpaqueId("runtime:world-command", "GrantRef")]);
  const { tenantId, worldId, timelineId, spaceId } = trustedTestContext();
  const scope = { tenantId, worldId, timelineId, spaceId };
  const world = await testWorld();
  const sink = new InMemoryRuntimeLogger();
  const logger = releaseRuntimeLogger(sink, { codeVersion: "test", environment: "ci" });
  const stored = new Map<string, WorldCommandResult>();
  const worker = new RuntimeWorker(
    authority.authenticator,
    {
      getSpace: () => {
        throw new Error("world commands do not use the no-op owner");
      },
      worldCommands: {
        prepare: async (input) => {
          const result = stored.get(input.command.commandId);
          return {
            tenantMember: input.command.commandId !== "outsider-command",
            ready: true,
            ...(result === undefined ? {} : { stored: result }),
          };
        },
        submit: async (input, trusted) =>
          unwrapWorldCommandRpc(
            await worldCommandRpc(
              logger,
              ownerLogIds(input.scope, trusted, input.command.commandId),
              async () => {
                if (input.command.commandId === "stale-command")
                  throw new JournalRevisionConflictError("routing-epoch", 4, 5);
                if (input.command.commandId === "racing-command")
                  throw new JournalRevisionConflictError("partition", 3n, 9n);
                const result: WorldCommandResult = {
                  commandId: input.command.commandId,
                  outcome: "committed",
                  value: {
                    status: "committed",
                    revision: "9",
                    simulationTime: "1",
                    complete: true,
                    eventCount: 0,
                    stateHash: "a".repeat(64),
                  },
                  events: [],
                };
                stored.set(input.command.commandId, result);
                return result;
              },
            ),
          ),
        deny: async () => {
          throw new Error("no command here is denied by a recorded decision");
        },
      },
    },
    logger,
  );
  const send = (commandId: string) =>
    worker.fetch(
      new Request("http://runtime.test/v1/runtime/commands", {
        method: "POST",
        headers: { authorization: "Bearer valid", "content-type": "application/json" },
        body: JSON.stringify({
          schemaVersion: 1,
          ...scope,
          routingEpoch: "4",
          authorityEpoch: "4",
          command: encodeCanonicalNode({
            ...advanceCommand(world, commandId, 1n, null),
            target: { version: 1, tenantId, worldId, timelineId, kind: "world", id: worldId },
          }),
        }),
      }),
    );
  const statuses: number[] = [];
  for (const commandId of [
    "logged-command",
    "logged-command",
    "outsider-command",
    "stale-command",
    "racing-command",
  ])
    statuses.push((await send(commandId)).status);
  expect(statuses).toEqual([200, 200, 403, 409, 409]);
  const record = (commandId: string, fields: Record<string, unknown>) => ({
    schemaVersion: 5,
    level: "info",
    event: "world_command_answered",
    ...scope,
    correlationId: `correlation-${commandId}`,
    requestId: commandId,
    commandId,
    routingEpoch: 4,
    codeVersion: "test",
    environment: "ci",
    ...fields,
  });
  expect(sink.records.map(({ timestamp, ...rest }) => rest)).toEqual([
    record("logged-command", {
      authorization: "authorized",
      outcome: "committed",
      status: 200,
      revision: 9,
    }),
    // The exact retry is answered from the stored receipt before authorization.
    record("logged-command", {
      authorization: "not_evaluated",
      outcome: "replayed",
      status: 200,
      revision: 9,
    }),
    record("outsider-command", {
      level: "warn",
      authorization: "denied",
      outcome: "refused",
      code: "authorization_refused",
      status: 403,
    }),
    // A stale routing epoch and a partition revision race are told apart by their class.
    record("stale-command", {
      level: "warn",
      authorization: "authorized",
      outcome: "conflict",
      code: "world_command_conflict",
      status: 409,
      failureClass: "epoch_conflict",
      retryable: true,
    }),
    record("racing-command", {
      level: "warn",
      authorization: "authorized",
      outcome: "conflict",
      code: "world_command_conflict",
      status: 409,
      failureClass: "revision_conflict",
      retryable: true,
    }),
  ]);
});
