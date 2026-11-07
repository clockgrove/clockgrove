import { type BrowserScope, ContractDecodeError, decodeBrowserScope } from "@clockgrove/contracts";

/** A shareable world route names one viewed space and never a credential. */
export type WorldRoute =
  | { readonly kind: "none" }
  | { readonly kind: "world"; readonly scope: BrowserScope }
  | { readonly kind: "unknown" };

const prefix = "worlds";

export function worldRoutePath(scope: BrowserScope): string {
  return `/${[prefix, scope.tenantId, scope.worldId, scope.timelineId, scope.spaceId].map(encodeURIComponent).join("/")}`;
}

export function parseWorldRoute(pathname: string): WorldRoute {
  if (pathname === "/") return { kind: "none" };
  const [, first, tenantId, worldId, timelineId, spaceId, ...rest] = pathname.split("/");
  if (first !== prefix || rest.length > 0) return { kind: "unknown" };
  try {
    return {
      kind: "world",
      scope: decodeBrowserScope({
        tenantId: tenantId && decodeURIComponent(tenantId),
        worldId: worldId && decodeURIComponent(worldId),
        timelineId: timelineId && decodeURIComponent(timelineId),
        spaceId: spaceId && decodeURIComponent(spaceId),
      }),
    };
  } catch (error) {
    if (error instanceof ContractDecodeError || error instanceof URIError)
      return { kind: "unknown" };
    throw error;
  }
}
