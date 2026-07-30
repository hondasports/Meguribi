import {
  structureHypothesis,
  type HypothesisArtifact,
  type HypothesisDependencies,
} from "@meguribi/core";
import { parseIssueTarget } from "../target.js";

export interface HypothesisCommandOptions {
  json?: boolean;
  local?: boolean;
  repoPath?: string;
}

export interface HypothesisCommandDependencies {
  hypothesis?: HypothesisDependencies;
  structureHypothesis?: typeof structureHypothesis;
  createHypothesisDependencies?: (options: {
    cwd: string;
    repositoryPath: string;
    repository: string;
    localOnly: boolean;
  }) => Promise<HypothesisDependencies>;
  cwd?: string;
  stdout?: (text: string) => void;
}

export async function runHypothesisCommand(
  target: string,
  options: HypothesisCommandOptions = {},
  deps: HypothesisCommandDependencies = {},
): Promise<{ exitCode: number; result?: Awaited<ReturnType<typeof structureHypothesis>> }> {
  const parsed = parseIssueTarget(target);
  const cwd = deps.cwd ?? process.cwd();
  const repositoryPath = options.repoPath ?? cwd;
  const hypothesisDependencies = deps.hypothesis ?? await (
    deps.createHypothesisDependencies ?? (async (wiringOptions) => {
      const wiring = await import("../wiring/create-delivery-deps.js");
      return wiring.createHypothesisDependencies(wiringOptions);
    })
  )({ cwd, repositoryPath, repository: parsed.repository, localOnly: options.local === true });
  const result = await (deps.structureHypothesis ?? structureHypothesis)({
    repository: parsed.repository,
    issueNumber: parsed.issueNumber,
  }, hypothesisDependencies);
  const writeOut = deps.stdout ?? ((text: string) => process.stdout.write(text));
  writeOut(options.json ? `${JSON.stringify(result, null, 2)}\n` : formatHuman(result));
  return { exitCode: 0, result };
}

function formatHuman(result: { artifact: HypothesisArtifact; artifactPath: string; commentId: number }): string {
  return [
    `Hypothesis: ${result.artifact.status}`,
    `Observations: ${String(result.artifact.observations.length)}`,
    `Problem candidates: ${String(result.artifact.problemCandidates.length)}`,
    `Missing evidence: ${result.artifact.missingEvidence.length > 0 ? result.artifact.missingEvidence.join(", ") : "none"}`,
    `Artifact: ${result.artifactPath}`,
    `Issue comment: #${String(result.commentId)}`,
    "Human approval required: yes",
    "",
  ].join("\n");
}
