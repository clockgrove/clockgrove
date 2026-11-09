import type { MaterialChannel, SceneMaterialDelivery } from "@clockgrove/contracts";

/** Highest useful density that fits both transfer and decoded texture budgets. */
export function selectMaterialRendition(
  material: SceneMaterialDelivery,
  devicePixelRatio: number,
  budget: { readonly transferBytes: number; readonly textureBytes: number },
  supported: readonly MaterialChannel[] = ["albedo"],
): SceneMaterialDelivery["renditions"][number] | undefined {
  const target = Number.isFinite(devicePixelRatio) ? Math.max(1, devicePixelRatio) : 1;
  const useful =
    material.renditions.find((r) => r.density >= target)?.density ??
    material.renditions.at(-1)?.density ??
    1;
  return [...material.renditions].reverse().find((r) => {
    if (r.density > useful) return false;
    const textures = new Map(
      supported.flatMap((channel) => {
        const texture = r.channels[channel];
        return texture
          ? (texture.pages ?? [{ image: texture.image }]).map(
              (page) => [page.image.sha256, page.image] as const,
            )
          : [];
      }),
    );
    return (
      [...textures.values()].reduce((n, image) => n + image.bytes, 0) <= budget.transferBytes &&
      [...textures.values()].reduce((n, image) => n + image.width * image.height * 4, 0) <=
        budget.textureBytes
    );
  });
}
