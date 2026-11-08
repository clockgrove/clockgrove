import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { encodeResource } from "@clockgrove/world-pack-sdk";
import { runScenario } from "../../src/index.js";
import type { Json } from "../fixtures/lamp-hall.js";
import { advance, hall, ports, SECTION_EPOCH, scenario } from "../scenario/harness.js";

export type GoldenMode = "match" | "mismatch" | "missing";

export interface FixturePackOptions {
  readonly golden?: GoldenMode;
  /** Adds an assertion that cannot hold. */
  readonly failingAssertion?: boolean;
  /** Leaves out the rules, the capability and the conversational object. */
  readonly bare?: boolean;
}

export const FIXTURE_SCENARIO = "hall-day";

/** The scenario document committed by the fixture pack. */
export function fixtureScenario(options: FixturePackOptions = {}): Json {
  return scenario({
    assertions: [
      { kind: "eventCount", id: "count-holds", run: "main", operator: "gte", value: 0 },
      ...(options.failingAssertion === true
        ? [
            {
              kind: "eventCount",
              id: "count-cannot-hold",
              run: "main",
              eventType: "no.such.event",
              operator: "gt",
              value: 0,
            },
          ]
        : []),
    ],
  });
}

/**
 * Writes the section-hall simulator fixture, extended with a rule pair and a stationary
 * `embodied-dialogue` object, as a pack directory in the documented layout under `root/<name>`.
 */
export async function writeFixturePack(
  root: string,
  name: string,
  options: FixturePackOptions = {},
): Promise<string> {
  const { source, artifact } = await hall(
    options.bare === true
      ? {}
      : {
          rules: true,
          edit: ({ docs, manifest }) => {
            (manifest.capabilities as Json[]).push({
              id: "sec.talk",
              version: 1,
              kind: "embodied-dialogue",
              commands: [{ type: "world.weather.set", version: 2 }],
            });
            (docs["actors/shed.json"] as Json).capabilities = [{ id: "sec.talk", version: 1 }];
          },
        },
  );
  const directory = join(root, name);
  const put = async (relative: string, bytes: Uint8Array): Promise<void> => {
    const path = join(directory, relative);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, bytes);
  };
  await put("manifest.json", encodeResource(source.manifest));
  for (const [path, bytes] of Object.entries(source.resources))
    await put(`resources/${path}`, bytes);
  await put("README.md", new TextEncoder().encode(`# ${name}\n`));
  const document = fixtureScenario(options);
  await put(`scenarios/${FIXTURE_SCENARIO}.json`, encodeResource(document));

  const mode = options.golden ?? "match";
  if (mode !== "missing") {
    const goldenDocument =
      mode === "match"
        ? document
        : { ...document, steps: [advance("span", SECTION_EPOCH + 120000n, "live", 60000n)] };
    const result = await runScenario({ artifact, source, scenario: goldenDocument }, ports);
    if (!result.ok) throw new Error(`fixture scenario refused: ${JSON.stringify(result.error)}`);
    await put(`goldens/${FIXTURE_SCENARIO}.json`, result.value.bytes);
  }
  return directory;
}
