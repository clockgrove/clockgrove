import type { TrustedExecutionContext } from "@clockgrove/contracts/trusted";
import "@clockgrove/testkit";
import type { TrustedExecutionContext as DeepTrustedExecutionContext } from "../../../contracts/src/execution-context.js";
import "cloudflare:workers";
import "node:fs";

export const forbiddenKernelFixture = true;
export type ForbiddenKernelTrustedContext = TrustedExecutionContext;
export type ForbiddenKernelDeepTrustedContext = DeepTrustedExecutionContext;
