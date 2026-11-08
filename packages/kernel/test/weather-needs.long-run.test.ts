import { mkdtemp, readdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { fullRuntimeEvidence } from "./executor.scenario.js";
import {
  lifecycleComparisonProblems,
  lifecycleEvidenceProblems,
  lifecycleReportProblems,
} from "./lifecycle-evidence.js";
import { expectedPackRefusals, inputIdentities } from "./pack-fixtures/evidence.js";
import {
  decisionsComparisonProblems,
  decisionsEvidenceProblems,
  decisionsReportProblems,
  ecologyComparisonProblems,
  ecologyEvidenceProblems,
  ecologyReportProblems,
  environmentComparisonProblems,
  environmentEvidenceProblems,
  environmentReportProblems,
  perceptionComparisonProblems,
  perceptionEvidenceProblems,
  perceptionReportProblems,
  REPORT_FILE_NAMES,
  reportDirectoryProblems,
  schedulerComparisonProblems,
  schedulerEvidenceProblems,
  schedulerReportProblems,
  spatialComparisonProblems,
  spatialEvidenceProblems,
  spatialReportProblems,
  wellbeingComparisonProblems,
  wellbeingEvidenceProblems,
  wellbeingReportProblems,
} from "./spatial-evidence.js";
import { evidenceHash, fetchFromWorkerd } from "./workerd.js";

// Long-run suite (pnpm test:long-run): every evidence section, including the 30-day and
// one-year lifecycle runs, computed in Node and in actual workerd.
describe("real rain/needs/shelter capability", () => {
  it("produces identical canonical events, decisions, queues, state and SHA-256 in actual workerd", async () => {
    // Node first, so a section that throws fails here with its message, not as a bare workerd 500.
    const nodeEvidence = await fullRuntimeEvidence();
    const worker = await fetchFromWorkerd("http://local.invalid/");
    expect(worker.status, worker.body.slice(0, 1200)).toBe(200);
    const workerBytes = worker.body;
    const nodeBytes = JSON.stringify(nodeEvidence);
    const workerEvidence = JSON.parse(workerBytes) as Awaited<
      ReturnType<typeof fullRuntimeEvidence>
    >;
    expect(worker.runtime).toBe("Cloudflare-Workers");
    const comparisons = nodeEvidence.components.map((entry, index) => {
      const other = workerEvidence.components[index];
      return {
        name: entry.name,
        override: entry.override,
        resolvedCanonicalObjectsEqual:
          JSON.stringify(entry.resolvedCanonicalObjects) ===
          JSON.stringify(other?.resolvedCanonicalObjects),
        semanticEventsEqual: entry.semanticEvents === other?.semanticEvents,
        schedulesEqual: entry.schedules === other?.schedules,
        scheduleMutationsEqual: entry.scheduleMutations === other?.scheduleMutations,
        decisionsEqual: entry.decisions === other?.decisions,
        finalStateEqual: entry.finalState === other?.finalState,
        stateHashEqual: entry.stateHash === other?.stateHash,
        nodeStateHash: entry.stateHash,
        workersStateHash: other?.stateHash,
      };
    });
    const nodePacks = nodeEvidence.packs;
    const workersPacks = workerEvidence.packs;
    const nodeInputs = inputIdentities(nodePacks);
    const workersInputs = inputIdentities(workersPacks);
    const same = (left: unknown, right: unknown) => JSON.stringify(left) === JSON.stringify(right);
    const nodeArtifactBytes = nodePacks.built.weather.output;
    const workersArtifactBytes = workersPacks.built.weather.output;
    const packComparisons = {
      baseEqual: same(nodePacks.built, workersPacks.built),
      inputsEqual: same(nodeInputs, workersInputs),
      inputCount: nodeInputs.length,
      nodeInputsHash: await evidenceHash(JSON.stringify(nodeInputs)),
      workersInputsHash: await evidenceHash(JSON.stringify(workersInputs)),
      reorderedEqual: same(
        [nodePacks.reordered, nodePacks.reorderedLantern, nodePacks.v2, nodePacks.rebuilt],
        [
          workersPacks.reordered,
          workersPacks.reorderedLantern,
          workersPacks.v2,
          workersPacks.rebuilt,
        ],
      ),
      refusalsEqual: same(nodePacks.refusals, workersPacks.refusals),
      refusalCount: nodePacks.refusals.length,
      hashChangesEqual: same(nodePacks.hashChanges, workersPacks.hashChanges),
      retainedEqual: same(nodePacks.retained, workersPacks.retained),
      dependentPacksEqual: same(nodePacks.dependent, workersPacks.dependent),
      nodeArtifactBytesHash: await evidenceHash(JSON.stringify(nodeArtifactBytes)),
      workersArtifactBytesHash: await evidenceHash(JSON.stringify(workersArtifactBytes)),
    };
    const comparison = {
      schemaVersion: 1,
      node: process.version,
      workers: worker.runtime,
      wrangler: worker.wrangler,
      miniflare: worker.miniflare,
      nativeRuntimeVersion: worker.nativeRuntimeVersion,
      canonicalBytesEqual: workerBytes === nodeBytes,
      nodeHash: await evidenceHash(nodeBytes),
      workersHash: await evidenceHash(workerBytes),
      comparisons,
      packComparisons,
      containment: {
        ...nodeEvidence.containment,
        equal: same(nodeEvidence.containment, workerEvidence.containment),
        nodeHash: await evidenceHash(JSON.stringify(nodeEvidence.containment)),
        workersHash: await evidenceHash(JSON.stringify(workerEvidence.containment)),
      },
      spatial: {
        equal: same(nodeEvidence.spatial, workerEvidence.spatial),
        nodeHash: await evidenceHash(JSON.stringify(nodeEvidence.spatial)),
        workersHash: await evidenceHash(JSON.stringify(workerEvidence.spatial)),
        registryHash: nodeEvidence.spatial.registry.hash,
        finalStateHash: nodeEvidence.spatial.finalStateHash,
        entryCount: nodeEvidence.spatial.entries.length,
      },
      perception: {
        equal: same(nodeEvidence.perception, workerEvidence.perception),
        nodeHash: await evidenceHash(JSON.stringify(nodeEvidence.perception)),
        workersHash: await evidenceHash(JSON.stringify(workerEvidence.perception)),
        resolverVersion: nodeEvidence.perception.resolverVersion,
        entryCount: nodeEvidence.perception.entries.length,
        refusalCount: nodeEvidence.perception.entries.filter(
          (entry) => entry.output.kind === "refusal",
        ).length,
      },
      scheduler: {
        equal: same(nodeEvidence.scheduler, workerEvidence.scheduler),
        nodeHash: await evidenceHash(JSON.stringify(nodeEvidence.scheduler)),
        workersHash: await evidenceHash(JSON.stringify(workerEvidence.scheduler)),
        engineVersion: nodeEvidence.scheduler.engineVersion,
        entryCount: nodeEvidence.scheduler.entries.length,
        pairCount: nodeEvidence.scheduler.pairs.length,
        refusalCount: nodeEvidence.scheduler.entries.filter(
          (entry) => entry.output.kind === "refusal",
        ).length,
      },
      environment: {
        equal: same(nodeEvidence.environment, workerEvidence.environment),
        nodeHash: await evidenceHash(JSON.stringify(nodeEvidence.environment)),
        workersHash: await evidenceHash(JSON.stringify(workerEvidence.environment)),
        entryCount: nodeEvidence.environment.entries.length,
        refusalCount: nodeEvidence.environment.entries.filter(
          (entry) => entry.output.kind === "refusal",
        ).length,
        pairCount: nodeEvidence.environment.pairs.length,
        goldenName: nodeEvidence.environment.golden.name,
        goldenMaterialEventHash: nodeEvidence.environment.golden.materialEventHash,
        goldenFinalStateHash: nodeEvidence.environment.golden.finalStateHash,
      },
      ecology: {
        equal: same(nodeEvidence.ecology, workerEvidence.ecology),
        nodeHash: await evidenceHash(JSON.stringify(nodeEvidence.ecology)),
        workersHash: await evidenceHash(JSON.stringify(workerEvidence.ecology)),
        entryCount: nodeEvidence.ecology.entries.length,
        refusalCount: nodeEvidence.ecology.entries.filter(
          (entry) => entry.output.kind === "refusal",
        ).length,
        pairCount: nodeEvidence.ecology.pairs.length,
        goldens: nodeEvidence.ecology.goldens,
      },
      wellbeing: {
        equal: same(nodeEvidence.wellbeing, workerEvidence.wellbeing),
        nodeHash: await evidenceHash(JSON.stringify(nodeEvidence.wellbeing)),
        workersHash: await evidenceHash(JSON.stringify(workerEvidence.wellbeing)),
        entryCount: nodeEvidence.wellbeing.entries.length,
        refusalCount: nodeEvidence.wellbeing.entries.filter(
          (entry) => entry.output.kind === "refusal",
        ).length,
        pairCount: nodeEvidence.wellbeing.pairs.length,
        goldenName: nodeEvidence.wellbeing.golden.name,
        goldenMaterialEventHash: nodeEvidence.wellbeing.golden.materialEventHash,
        goldenFinalStateHash: nodeEvidence.wellbeing.golden.finalStateHash,
      },
      decisions: {
        equal: same(nodeEvidence.decisions, workerEvidence.decisions),
        nodeHash: await evidenceHash(JSON.stringify(nodeEvidence.decisions)),
        workersHash: await evidenceHash(JSON.stringify(workerEvidence.decisions)),
        entryCount: nodeEvidence.decisions.entries.length,
        refusalCount: nodeEvidence.decisions.entries.filter(
          (entry) => entry.output.kind === "refusal",
        ).length,
        pairCount: nodeEvidence.decisions.pairs.length,
        goldenName: nodeEvidence.decisions.golden.name,
        goldenMaterialEventHash: nodeEvidence.decisions.golden.materialEventHash,
        goldenTraceHash: nodeEvidence.decisions.golden.traceHash,
        goldenFinalStateHash: nodeEvidence.decisions.golden.finalStateHash,
      },
      lifecycle: {
        equal: same(nodeEvidence.lifecycle, workerEvidence.lifecycle),
        nodeHash: await evidenceHash(JSON.stringify(nodeEvidence.lifecycle)),
        workersHash: await evidenceHash(JSON.stringify(workerEvidence.lifecycle)),
        runCount: nodeEvidence.lifecycle.runs.length,
        longRunCount: nodeEvidence.lifecycle.longRuns.length,
        pairCount: nodeEvidence.lifecycle.pairs.length,
        assertionCount: nodeEvidence.lifecycle.assertions.length,
        goldenName: nodeEvidence.lifecycle.golden.name,
        goldenMaterialEventHash: nodeEvidence.lifecycle.golden.materialEventHash,
        goldenFinalStateHash: nodeEvidence.lifecycle.golden.finalStateHash,
      },
      executor: {
        equal: same(nodeEvidence.executor, workerEvidence.executor),
        nodeHash: await evidenceHash(JSON.stringify(nodeEvidence.executor)),
        workersHash: await evidenceHash(JSON.stringify(workerEvidence.executor)),
        registryHash: nodeEvidence.executor.registry.hash,
        goldenCount: nodeEvidence.executor.golden.length,
        fuzzCount: nodeEvidence.executor.fuzz.entries.length,
      },
    };
    const evidence = await mkdtemp(join(tmpdir(), "clockgrove-component-evidence-"));
    const nodeRuntime = process.version;
    const workersRuntime = worker.runtime;
    const sectionNames = [
      "spatial",
      "perception",
      "scheduler",
      "environment",
      "ecology",
      "decisions",
      "lifecycle",
    ] as const;
    const runtimeKeys = [
      "schemaVersion",
      "composition",
      "components",
      "historical",
      "packs",
      "executor",
      "containment",
    ];
    const slim = (source: Record<string, unknown>) =>
      Object.fromEntries(Object.entries(source).filter(([key]) => runtimeKeys.includes(key)));
    const summaryOnly = Object.fromEntries(
      Object.entries(comparison).filter(
        ([key]) => !(sectionNames as readonly string[]).includes(key) && key !== "wellbeing",
      ),
    );
    const reports: Record<string, string> = {
      "node.json": JSON.stringify({ runtime: nodeRuntime, evidence: slim(nodeEvidence) }),
      "workers.json": JSON.stringify({ runtime: workersRuntime, evidence: slim(workerEvidence) }),
      "comparison.json": JSON.stringify(
        { ...summaryOnly, wellbeing: comparison.wellbeing },
        null,
        2,
      ),
    };
    for (const section of sectionNames) {
      reports[`${section}.json`] = JSON.stringify({
        schemaVersion: 1,
        section,
        node: { runtime: nodeRuntime, evidence: nodeEvidence[section] },
        workers: { runtime: workersRuntime, evidence: workerEvidence[section] },
        comparison: comparison[section],
      });
    }
    reports["wellbeing-node.json"] = JSON.stringify({
      schemaVersion: 1,
      section: "wellbeing",
      runtime: nodeRuntime,
      evidence: nodeEvidence.wellbeing,
    });
    reports["wellbeing-workers.json"] = JSON.stringify({
      schemaVersion: 1,
      section: "wellbeing",
      runtime: workersRuntime,
      evidence: workerEvidence.wellbeing,
    });
    for (const [file, body] of Object.entries(reports)) {
      if (Buffer.byteLength(body, "utf8") > 1048576)
        throw new Error(`${file} exceeded 1 MiB evidence bound`);
      await writeFile(join(evidence, file), body, "utf8");
    }
    console.log(`Clockgrove component evidence: ${evidence}`);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    type Written = Record<string, any>;
    const written: Written = {};
    for (const file of Object.keys(reports)) {
      const bytes = await readFile(join(evidence, file));
      expect(bytes.byteLength).toBeLessThanOrEqual(1048576);
      const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
      written[file] = JSON.parse(text);
    }
    const listing = await readdir(evidence);
    expect([...listing].sort()).toEqual([...REPORT_FILE_NAMES].sort());
    expect(reportDirectoryProblems(listing, written)).toEqual([]);

    // Whole-directory negative controls on mutated copies of the written reports.
    const clone = () => structuredClone(written) as Written;
    const problemsOf = (change: (files: Written, names: string[]) => void) => {
      const files = clone();
      const names = [...listing];
      change(files, names);
      return reportDirectoryProblems(names, files);
    };
    expect(
      problemsOf((_files, names) => names.splice(names.indexOf("ecology.json"), 1)),
    ).not.toEqual([]);
    expect(
      problemsOf((_files, names) => names.splice(names.indexOf("wellbeing-node.json"), 1)),
    ).not.toEqual([]);
    expect(
      problemsOf((_files, names) => names.splice(names.indexOf("decisions.json"), 1)),
    ).not.toEqual([]);
    expect(
      problemsOf((_files, names) => names.splice(names.indexOf("lifecycle.json"), 1)),
    ).not.toEqual([]);
    expect(listing).toHaveLength(12);
    expect(
      problemsOf((files, names) => {
        names.push("extra.json");
        files["extra.json"] = {};
      }),
    ).not.toEqual([]);
    expect(
      problemsOf((files, names) => {
        names[names.indexOf("scheduler.json")] = "schedulers.json";
        files["schedulers.json"] = files["scheduler.json"];
      }),
    ).not.toEqual([]);
    for (const section of sectionNames) {
      expect(
        problemsOf((files) => {
          files["node.json"].evidence[section] = nodeEvidence[section];
        }),
      ).not.toEqual([]);
      expect(
        problemsOf((files) => {
          files["workers.json"].evidence[section] = workerEvidence[section];
        }),
      ).not.toEqual([]);
      expect(
        problemsOf((files) => {
          files["comparison.json"][section] = comparison[section];
        }),
      ).not.toEqual([]);
      expect(
        problemsOf((files) => {
          files[`${section}.json`].section = "other";
        }),
      ).not.toEqual([]);
      expect(
        problemsOf((files) => {
          delete files[`${section}.json`].comparison;
        }),
      ).not.toEqual([]);
      expect(
        problemsOf((files) => {
          files[`${section}.json`].extra = 1;
        }),
      ).not.toEqual([]);
      expect(
        problemsOf((files) => {
          delete files[`${section}.json`].node.runtime;
        }),
      ).not.toEqual([]);
      expect(
        problemsOf((files) => {
          files[`${section}.json`].workers.extra = 1;
        }),
      ).not.toEqual([]);
      expect(
        problemsOf((files) => {
          files[`${section}.json`].workers.evidence = {
            ...files[`${section}.json`].workers.evidence,
            changed: true,
          };
        }),
      ).not.toEqual([]);
      expect(
        problemsOf((files) => {
          files[`${section}.json`].comparison.nodeHash = "0".repeat(64);
        }),
      ).not.toEqual([]);
      expect(
        problemsOf((files) => {
          files[`${section}.json`].comparison.workersHash = "0".repeat(64);
        }),
      ).not.toEqual([]);
      expect(
        problemsOf((files) => {
          files[`${section}.json`].comparison.workersHash = "A".repeat(64);
        }),
      ).not.toEqual([]);
      expect(
        problemsOf((files) => {
          files[`${section}.json`].comparison.nodeHash =
            files[`${section}.json`].comparison.nodeHash.toUpperCase();
        }),
      ).not.toEqual([]);
    }
    expect(
      problemsOf((files) => {
        files["node.json"].evidence.wellbeing = nodeEvidence.wellbeing;
      }),
    ).not.toEqual([]);
    expect(
      problemsOf((files) => {
        files["workers.json"].evidence.wellbeing = workerEvidence.wellbeing;
      }),
    ).not.toEqual([]);
    expect(
      problemsOf((files) => {
        files["comparison.json"].spatial = comparison.spatial;
      }),
    ).not.toEqual([]);
    expect(
      problemsOf((files) => {
        delete files["node.json"].evidence.packs;
      }),
    ).not.toEqual([]);
    expect(
      problemsOf((files) => {
        files["node.json"].extra = 1;
      }),
    ).not.toEqual([]);
    expect(
      problemsOf((files) => {
        delete files["comparison.json"].packComparisons;
      }),
    ).not.toEqual([]);
    expect(
      problemsOf((files) => {
        files["comparison.json"].extra = 1;
      }),
    ).not.toEqual([]);
    for (const key of ["executor", "containment"] as const) {
      expect(
        problemsOf((files) => {
          files["workers.json"].evidence[key] = { changed: true };
        }),
      ).not.toEqual([]);
      expect(
        problemsOf((files) => {
          files["comparison.json"][key].nodeHash = "0".repeat(64);
        }),
      ).not.toEqual([]);
      expect(
        problemsOf((files) => {
          files["comparison.json"][key].workersHash = "0".repeat(64);
        }),
      ).not.toEqual([]);
    }
    for (const key of ["components", "historical", "packs"] as const)
      expect(
        problemsOf((files) => {
          files["workers.json"].evidence[key] = { changed: true };
        }),
      ).not.toEqual([]);
    expect(
      problemsOf((files) => {
        files["wellbeing-node.json"].section = "other";
      }),
    ).not.toEqual([]);
    expect(
      problemsOf((files) => {
        delete files["wellbeing-node.json"].runtime;
      }),
    ).not.toEqual([]);
    expect(
      problemsOf((files) => {
        files["wellbeing-workers.json"].extra = 1;
      }),
    ).not.toEqual([]);
    expect(
      problemsOf((files) => {
        files["wellbeing-workers.json"].evidence = {
          ...files["wellbeing-workers.json"].evidence,
          changed: true,
        };
      }),
    ).not.toEqual([]);
    expect(
      problemsOf((files) => {
        files["comparison.json"].wellbeing.nodeHash = "0".repeat(64);
      }),
    ).not.toEqual([]);
    expect(
      problemsOf((files) => {
        files["comparison.json"].wellbeing.workersHash = "0".repeat(64);
      }),
    ).not.toEqual([]);
    expect(
      problemsOf((files) => {
        files["lifecycle.json"].workers.evidence = {
          ...files["lifecycle.json"].workers.evidence,
          changed: true,
        };
      }),
    ).not.toEqual([]);
    expect(
      problemsOf((files) => {
        files["lifecycle.json"].comparison.nodeHash = "0".repeat(64);
      }),
    ).not.toEqual([]);
    expect(
      Buffer.byteLength(JSON.stringify(written["lifecycle.json"]), "utf8"),
    ).toBeLessThanOrEqual(1048576);
    expect(Object.keys(written["lifecycle.json"])).toEqual([
      "schemaVersion",
      "section",
      "node",
      "workers",
      "comparison",
    ]);

    // Each section file holds the exact moved body for each runtime.
    for (const section of sectionNames) {
      expect(Object.keys(written[`${section}.json`])).toEqual([
        "schemaVersion",
        "section",
        "node",
        "workers",
        "comparison",
      ]);
      expect(JSON.stringify(written[`${section}.json`].node.evidence)).toBe(
        JSON.stringify(nodeEvidence[section]),
      );
      expect(JSON.stringify(written[`${section}.json`].workers.evidence)).toBe(
        JSON.stringify(workerEvidence[section]),
      );
      expect(JSON.stringify(written[`${section}.json`].comparison)).toBe(
        JSON.stringify(comparison[section]),
      );
    }
    for (const [file, runtime, source] of [
      ["wellbeing-node.json", nodeRuntime, nodeEvidence],
      ["wellbeing-workers.json", workersRuntime, workerEvidence],
    ] as const) {
      expect(Object.keys(written[file])).toEqual([
        "schemaVersion",
        "section",
        "runtime",
        "evidence",
      ]);
      expect(written[file].runtime).toBe(runtime);
      expect(JSON.stringify(written[file].evidence)).toBe(JSON.stringify(source.wellbeing));
    }
    expect(Object.keys(written["node.json"].evidence)).toEqual(Object.keys(slim(nodeEvidence)));
    expect(Object.keys(written["node.json"].evidence).sort()).toEqual([...runtimeKeys].sort());
    expect(Object.keys(written["workers.json"].evidence).sort()).toEqual([...runtimeKeys].sort());
    expect(JSON.stringify(written["node.json"].evidence)).toBe(JSON.stringify(slim(nodeEvidence)));
    expect(JSON.stringify(written["workers.json"].evidence)).toBe(
      JSON.stringify(slim(workerEvidence)),
    );
    expect(Object.keys(written["comparison.json"]).sort()).toEqual(
      [...Object.keys(summaryOnly), "wellbeing"].sort(),
    );
    expect(written["wellbeing-node.json"].evidence.entries.length).toBe(
      written["comparison.json"].wellbeing.entryCount,
    );

    const nodeFile = written["node.json"];
    const workersFile = written["workers.json"];
    const comparisonFile = written["comparison.json"];
    const sectionOf = (section: string) => ({
      node: { evidence: { [section]: written[`${section}.json`].node.evidence } },
      workers: { evidence: { [section]: written[`${section}.json`].workers.evidence } },
      comparison: { [section]: written[`${section}.json`].comparison },
    });
    const wellbeingNodeAdapter = {
      evidence: { wellbeing: written["wellbeing-node.json"].evidence },
    };
    const wellbeingWorkersAdapter = {
      evidence: { wellbeing: written["wellbeing-workers.json"].evidence },
    };
    expect(nodeFile.evidence.executor).toBeDefined();
    expect(workersFile.evidence.executor).toBeDefined();
    expect(comparisonFile.executor).toBeDefined();
    expect(JSON.stringify(nodeFile.evidence.executor)).toBe(
      JSON.stringify(workersFile.evidence.executor),
    );
    expect(comparison.executor).toMatchObject({ equal: true });
    expect(comparison.executor.nodeHash).toBe(comparison.executor.workersHash);
    expect(comparison.executor.fuzzCount).toBeGreaterThan(0);
    expect(comparison.containment.equal).toBe(true);
    expect(comparison.containment.nodeHash).toBe(comparison.containment.workersHash);
    for (const entry of comparison.containment.entries) {
      expect(entry.input.inputHash).toMatch(/^[a-f0-9]{64}$/u);
      expect(entry.input.preStateHash).toMatch(/^[a-f0-9]{64}$/u);
      expect(entry.input.randomStateHash).toMatch(/^[a-f0-9]{64}$/u);
    }
    const sectionChecks = {
      spatial: [spatialEvidenceProblems, spatialComparisonProblems, spatialReportProblems],
      perception: [
        perceptionEvidenceProblems,
        perceptionComparisonProblems,
        perceptionReportProblems,
      ],
      scheduler: [schedulerEvidenceProblems, schedulerComparisonProblems, schedulerReportProblems],
      environment: [
        environmentEvidenceProblems,
        environmentComparisonProblems,
        environmentReportProblems,
      ],
      ecology: [ecologyEvidenceProblems, ecologyComparisonProblems, ecologyReportProblems],
      decisions: [decisionsEvidenceProblems, decisionsComparisonProblems, decisionsReportProblems],
      lifecycle: [lifecycleEvidenceProblems, lifecycleComparisonProblems, lifecycleReportProblems],
    } as const;
    for (const section of sectionNames) {
      const [evidenceProblems, comparisonProblems, reportProblems] = sectionChecks[section];
      const moved = sectionOf(section);
      expect(evidenceProblems(moved.node.evidence[section])).toEqual([]);
      expect(evidenceProblems(moved.workers.evidence[section])).toEqual([]);
      expect(comparisonProblems(moved.comparison[section])).toEqual([]);
      expect(reportProblems(moved.node, moved.workers, moved.comparison)).toEqual([]);
      expect(JSON.stringify(moved.node.evidence[section])).toBe(
        JSON.stringify(moved.workers.evidence[section]),
      );
    }
    expect(wellbeingEvidenceProblems(wellbeingNodeAdapter.evidence.wellbeing)).toEqual([]);
    expect(wellbeingEvidenceProblems(wellbeingWorkersAdapter.evidence.wellbeing)).toEqual([]);
    expect(wellbeingComparisonProblems(comparisonFile.wellbeing)).toEqual([]);
    expect(
      wellbeingReportProblems(wellbeingNodeAdapter, wellbeingWorkersAdapter, comparisonFile),
    ).toEqual([]);
    expect(JSON.stringify(wellbeingNodeAdapter.evidence.wellbeing)).toBe(
      JSON.stringify(wellbeingWorkersAdapter.evidence.wellbeing),
    );
    expect(workerBytes).toBe(nodeBytes);
    expect(comparison.nodeHash).toBe(comparison.workersHash);
    expect(packComparisons).toMatchObject({
      baseEqual: true,
      inputsEqual: true,
      reorderedEqual: true,
      refusalsEqual: true,
      refusalCount: Object.keys(expectedPackRefusals).length,
      hashChangesEqual: true,
      retainedEqual: true,
      dependentPacksEqual: true,
    });
    expect(packComparisons.nodeInputsHash).toBe(packComparisons.workersInputsHash);
    expect(packComparisons.nodeArtifactBytesHash).toBe(packComparisons.workersArtifactBytesHash);
    expect(packComparisons.inputCount).toBeGreaterThan(Object.keys(expectedPackRefusals).length);
    for (const entry of comparisons) {
      expect(entry).toMatchObject({
        resolvedCanonicalObjectsEqual: true,
        semanticEventsEqual: true,
        schedulesEqual: true,
        scheduleMutationsEqual: true,
        decisionsEqual: true,
        finalStateEqual: true,
        stateHashEqual: true,
      });
    }
  }, 300000);
});
