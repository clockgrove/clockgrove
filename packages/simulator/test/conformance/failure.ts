/** One failed conformance check, always naming the pack and the check. */
export interface ConformanceProblem {
  readonly pack: string;
  readonly check: string;
  readonly detail: string;
}

export const formatProblem = (problem: ConformanceProblem): string =>
  `pack "${problem.pack}": check "${problem.check}": ${problem.detail}`;

/** Thrown by every conformance check; the message is one line per problem. */
export class ConformanceFailure extends Error {
  readonly problems: readonly ConformanceProblem[];

  constructor(problems: readonly ConformanceProblem[]) {
    super(problems.map(formatProblem).join("\n"));
    this.name = "ConformanceFailure";
    this.problems = problems;
  }
}

export function failCheck(pack: string, check: string, detail: string): never {
  throw new ConformanceFailure([{ pack, check, detail }]);
}

/** Throws one ConformanceFailure when `problems` is not empty. */
export function throwIfProblems(problems: readonly ConformanceProblem[]): void {
  if (problems.length > 0) throw new ConformanceFailure(problems);
}

export const CHECKS = {
  load: "load-pack",
  validateBuild: "validate-and-build",
  reproducible: "reproducible-build",
  immutable: "artifact-immutability",
  seed: "seed-genesis",
  coverage: "contract-coverage",
  layout: "scenario-golden-layout",
  ruleIntents: "rule-intent-coverage",
  workers: "workers-runtime",
  parity: "node-workers-parity",
  assertions: "scenario-assertions",
  golden: "golden-match",
  observations: "run-observations",
  neutrality: "engine-neutrality",
  presentation: "presentation-bindings",
} as const;
