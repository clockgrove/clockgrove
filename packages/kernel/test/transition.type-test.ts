import type { CommandEnvelope, CommandId, ScheduleId } from "@clockgrove/contracts";

import type {
  KernelTransitionInput,
  KernelTransitionResult,
  ScheduledKernelInput,
} from "../src/index.js";

// This file is compiled by tsc as a pressure test for the public generic seam. It deliberately
// contains no executable simulation or runtime machinery.
export type ExampleKernelInput = KernelTransitionInput<
  { readonly version: 1 },
  { readonly kind: "command"; readonly command: CommandEnvelope<"example", never> },
  { readonly version: "policy-v1" },
  { readonly version: "pack-v1" }
>;

export type ExampleKernelOutput = KernelTransitionResult;

export const scheduledInputFixture = {
  schemaVersion: 1,
  scheduleId: "schedule-type-fixture" as ScheduleId,
  commandId: "originating-command-type-fixture" as CommandId,
  type: "example.scheduled",
  payload: { reason: "due" },
} as const satisfies ScheduledKernelInput<"example.scheduled", { readonly reason: "due" }>;
