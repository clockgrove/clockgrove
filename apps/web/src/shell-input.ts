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
    readonly atlas: string | null;
    readonly accent: number;
    readonly panel: number;
    readonly text: string;
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
  scene: { atlas: null, accent: 0x9bbce0, panel: 0x202630, text: "#edf1f5" },
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
      ([key, token]) => /^--rw-v1-[a-z0-9-]+$/.test(key) && typeof token === "string",
    ) ||
    !input.scene ||
    !(
      input.scene.atlas === null ||
      (typeof input.scene.atlas === "string" && /^[a-z0-9-]+$/.test(input.scene.atlas))
    ) ||
    ![input.scene.accent, input.scene.panel].every(
      (color) => Number.isInteger(color) && color >= 0 && color <= 0xffffff,
    ) ||
    typeof input.scene.text !== "string"
  )
    throw new Error("unsupported or invalid world shell input");
  return input;
}
