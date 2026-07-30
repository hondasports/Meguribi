import { exploreSolutions, type ExploreArtifact, type ExploreDependencies } from "@meguribi/core";
import { parseIssueTarget } from "../target.js";

export interface ExploreCommandOptions { json?: boolean; local?: boolean; repoPath?: string }
export interface ExploreCommandDependencies {
  explore?: ExploreDependencies;
  exploreSolutions?: typeof exploreSolutions;
  createExploreDependencies?: (options: { cwd: string; repositoryPath: string; repository: string; localOnly: boolean }) => Promise<ExploreDependencies>;
  cwd?: string;
  stdout?: (text: string) => void;
}
export async function runExploreCommand(target: string, options: ExploreCommandOptions = {}, deps: ExploreCommandDependencies = {}): Promise<{ exitCode: number; result?: Awaited<ReturnType<typeof exploreSolutions>> }> {
  const parsed = parseIssueTarget(target); const cwd = deps.cwd ?? process.cwd(); const repositoryPath = options.repoPath ?? cwd;
  const dependencies = deps.explore ?? await (deps.createExploreDependencies ?? (async (wiringOptions) => { const wiring = await import("../wiring/create-delivery-deps.js"); return wiring.createExploreDependencies(wiringOptions); }))({ cwd, repositoryPath, repository: parsed.repository, localOnly: options.local === true });
  const result = await (deps.exploreSolutions ?? exploreSolutions)({ repository: parsed.repository, issueNumber: parsed.issueNumber }, dependencies);
  const writeOut = deps.stdout ?? ((text: string) => process.stdout.write(text)); writeOut(options.json ? `${JSON.stringify(result, null, 2)}\n` : formatHuman(result)); return { exitCode: 0, result };
}
function formatHuman(result: { artifact: ExploreArtifact; artifactPath: string; commentId: number }): string { return [`Explore: ${String(result.artifact.options.length)} solution options`, "Selected option: none", `Missing evidence: ${result.artifact.missingEvidence.join(", ")}`, `Artifact: ${result.artifactPath}`, `Issue comment: #${String(result.commentId)}`, "Human approval required: yes", ""].join("\n"); }
