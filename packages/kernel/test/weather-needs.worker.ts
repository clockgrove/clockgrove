import { fullRuntimeEvidence } from "./executor.scenario.js";
export default {
  async fetch() {
    try {
      const evidence = await fullRuntimeEvidence();
      return new Response(JSON.stringify(evidence), {
        headers: { "x-kernel-runtime": navigator.userAgent },
      });
    } catch (error) {
      // The section's own message, so a workerd failure is diagnosable from the test report.
      return new Response(String((error as Error)?.message ?? error), { status: 500 });
    }
  },
};
