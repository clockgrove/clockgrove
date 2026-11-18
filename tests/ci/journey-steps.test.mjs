// #401 owner decision (2026-11-17): a dev:world journey that fails before Ctrl-C reports the step it
// failed in, not the shutdown step that runs after it.
import { expect, it } from "vitest";
import { journeyThenShutdown, namedSteps } from "./journey-steps.mjs";

async function run(journey, shutdown) {
  let reportFailure;
  const at = namedSteps((handler) => {
    reportFailure = handler;
  });
  const events = [];
  const error = await journeyThenShutdown(
    at,
    () => journey(at, events),
    "Ctrl-C stops dev:world",
    async () => {
      events.push(`shutdown during "${at.step}"`);
      await shutdown?.();
    },
  ).then(
    () => undefined,
    (failure) => failure,
  );
  // Vitest calls onTestFailed handlers once the test body has settled, as here.
  if (error) reportFailure({ task: { result: { errors: [error] } } });
  return { at, events, message: error?.message };
}

it("reports a failure inside an earlier journey step under that step, after shutting down", async () => {
  const signIn = async (at, events) => {
    at.step = "world directory";
    events.push("directory listed");
    at.step = "browser signs in and the scene arrives";
    throw new Error("Arrival: scene never ready");
  };
  expect(await run(signIn)).toEqual({
    at: { step: "browser signs in and the scene arrives" },
    events: ["directory listed", 'shutdown during "browser signs in and the scene arrives"'],
    message: 'step "browser signs in and the scene arrives": Arrival: scene never ready',
  });
  const refused = await run(signIn, async () => {
    throw new Error("dev:world exited 1");
  });
  expect(refused.message).toBe(
    'step "browser signs in and the scene arrives": Arrival: scene never ready\n' +
      "shutdown also failed: dev:world exited 1",
  );
});

it("names the shutdown step only once every journey step has passed", async () => {
  const walk = async (at) => {
    at.step = "webgl2: sample every walk frame";
  };
  expect(await run(walk)).toEqual({
    at: { step: "Ctrl-C stops dev:world" },
    events: ['shutdown during "Ctrl-C stops dev:world"'],
    message: undefined,
  });
  const stuck = await run(walk, async () => {
    throw new Error("dev:world exited 130");
  });
  expect(stuck.message).toBe('step "Ctrl-C stops dev:world": dev:world exited 130');
});
