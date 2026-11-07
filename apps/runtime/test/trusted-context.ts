import { constructTrustedExecutionContext } from "@clockgrove/contracts/trusted";

export function trustedTestContext() {
  return constructTrustedExecutionContext({
    version: 1,
    tenantId: "tenant-runtime",
    principalId: "principal-runtime",
    worldId: "world-runtime",
    timelineId: "timeline-runtime",
    spaceId: "space-runtime",
    roles: [],
    grants: [],
    privacyCeiling: { version: 1, allowedCategories: ["operator_evidence"] },
    correlationId: "correlation-runtime",
    requestId: "request-runtime",
    codeVersion: "test",
    protocolVersion: 1,
  });
}
