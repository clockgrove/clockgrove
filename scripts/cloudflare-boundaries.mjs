import path from "node:path";

import ts from "typescript";

const adapterModules = new Set([
  "apps/runtime/src/cloudflare-entry.ts",
  "apps/runtime/src/cloudflare-adapters.ts",
  "apps/runtime/src/cloudflare-adapter-types.d.ts",
  "apps/runtime/src/cloudflare-metrics.ts",
]);
const providerTypes =
  /^(?:Cloudflare\w*|DurableObject(?:Namespace|State|Storage|Id|Stub|Transaction)?|Workflow(?:Entrypoint|Event|Step|Binding)|Queue(?:Binding|Message)?|MessageBatch|ScheduledController|ScheduledEvent|ExportedHandler|R2Bucket|KVNamespace|Hyperdrive|AnalyticsEngine\w*|Fetcher)$/u;
const providerModules = /^(?:cloudflare:|@cloudflare\/|workerd(?:\/|$))/u;

/** Reject provider declarations, ambient types and indirect module references inward. */
export function assertCloudflareBoundary(source, location) {
  const normalized = location.split(path.sep).join("/");
  if (adapterModules.has(normalized)) return;
  const file = ts.createSourceFile(location, source, ts.ScriptTarget.Latest, true);
  for (const reference of [...file.typeReferenceDirectives, ...file.referencedFiles]) {
    if (
      providerModules.test(reference.fileName) ||
      /cloudflare-(?:entry|adapters|adapter-types|metrics)/u.test(reference.fileName)
    ) {
      throw new Error(`${location}: Cloudflare type reference is confined to adapters`);
    }
  }
  function visit(node) {
    if (ts.isIdentifier(node) && providerTypes.test(node.text)) {
      throw new Error(
        `${location}: Cloudflare structural type ${node.text} is confined to adapters`,
      );
    }
    if (
      ts.isIdentifier(node) &&
      [
        "idFromName",
        "blockConcurrencyWhile",
        "waitUntil",
        "passThroughOnException",
        "ackAll",
        "retryAll",
        "writeDataPoint",
      ].includes(node.text)
    ) {
      throw new Error(
        `${location}: Cloudflare structural member ${node.text} is confined to adapters`,
      );
    }
    if (ts.isStringLiteralLike(node)) {
      if (
        providerModules.test(node.text) ||
        /(?:^|\/)cloudflare-(?:entry|adapters|adapter-types|metrics)(?:\.[cm]?[jt]s)?$/u.test(
          node.text,
        ) ||
        node.text === "@clockgrove/runtime/cloudflare"
      ) {
        throw new Error(`${location}: Cloudflare module reference is confined to adapters`);
      }
    }
    ts.forEachChild(node, visit);
  }
  visit(file);
}
