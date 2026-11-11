export interface WorldShellInput {
  readonly shellVersion: 1;
  readonly name: string;
  readonly wordmark: string;
  readonly copy: {
    readonly worldLabel: string;
    readonly chooseWorld: string;
    readonly stopped: string;
    readonly provisioning: string;
    readonly ready: string;
  };
  readonly tokens: Readonly<Record<string, string>>;
  readonly scene: {
    /** Load every atlas page the reviewed output's `atlases.json` index lists. */
    readonly atlases: boolean;
    readonly accent: number;
    readonly panel: number;
    readonly text: string;
    /** Optional fixed-isometric zoom range; omitted inputs retain the legacy camera. */
    readonly camera?: { readonly minZoom: number; readonly maxZoom: number };
  };
}

export const neutralShell: WorldShellInput = {
  shellVersion: 1,
  name: "Clockgrove",
  wordmark: "Clockgrove",
  copy: {
    worldLabel: "World",
    chooseWorld: "Choose a world",
    stopped: "World stopped",
    provisioning:
      "This world is still being provisioned, so no scene is shown yet. The scene opens once the world is ready.",
    ready: "The world is ready. Opening the scene.",
  },
  tokens: {},
  scene: { atlases: false, accent: 0x9bbce0, panel: 0x202630, text: "#edf1f5" },
};

export function readWorldShell(value: unknown): WorldShellInput {
  if (!value || typeof value !== "object") throw new Error("invalid world shell input");
  const input = value as WorldShellInput;
  if (
    input.shellVersion !== 1 ||
    ![
      input.name,
      input.wordmark,
      input.copy?.worldLabel,
      input.copy?.chooseWorld,
      input.copy?.stopped,
      input.copy?.provisioning,
      input.copy?.ready,
    ].every((text) => typeof text === "string" && text.length > 0) ||
    !input.tokens ||
    typeof input.tokens !== "object" ||
    Array.isArray(input.tokens) ||
    !Object.entries(input.tokens).every(
      ([key, token]) => /^--cg-v1-[a-z0-9-]+$/.test(key) && typeof token === "string",
    ) ||
    !input.scene ||
    typeof input.scene.atlases !== "boolean" ||
    ![input.scene.accent, input.scene.panel].every(
      (color) => Number.isInteger(color) && color >= 0 && color <= 0xffffff,
    ) ||
    typeof input.scene.text !== "string" ||
    (input.scene.camera !== undefined &&
      (!input.scene.camera ||
        !Number.isFinite(input.scene.camera.minZoom) ||
        !Number.isFinite(input.scene.camera.maxZoom) ||
        input.scene.camera.minZoom <= 0 ||
        // The scene contract has a 640-pixel logical width; its overview bounds must remain finite.
        !Number.isFinite(640 / input.scene.camera.minZoom) ||
        input.scene.camera.minZoom > 1 ||
        input.scene.camera.maxZoom < 1))
  )
    throw new Error("unsupported or invalid world shell input");
  return input;
}
