import type { GitHubAdapter } from "./delivery.js";
import { parseHypothesisSections } from "./hypothesis.js";

export interface RequirementArtifact {
  schemaVersion: 1;
  artifactType: "requirements";
  repository: string;
  sourceIssueNumber: number;
  sourceIssueUrl: string;
  generatedAt: string;
  status: "draft";
  humanApprovalRequired: true;
  selectedSolution: { number: number; statement: string };
  problem: string | null;
  targetUsers: string[];
  requirements: Array<{ id: string; statement: string; priority: "must" | "should" | "could" }>;
  acceptanceCriteria: Array<{ id: string; statement: string; mapsTo: string[] }>;
  outOfScope: string[];
  successMetrics: string[];
  guardrails: string[];
  openQuestions: string[];
  relatedIssues: { hypothesis: number[]; problem: number[] };
}
export interface RequirementArtifactStore { save(input: { repository: string; sourceIssueNumber: number; artifact: RequirementArtifact }): Promise<string> }
export interface RequireDependencies { github: Pick<GitHubAdapter, "getIssue" | "upsertMarkerComment">; artifactStore: RequirementArtifactStore; now?: () => Date }
export interface RequireInput { repository: string; issueNumber: number; solutionNumber: number }
const MARKER = "<!-- meguribi:require -->";
function url(repository: string, number: number): string { return `https://github.com/${repository}/issues/${String(number)}`; }
function section(parsed: ReturnType<typeof parseHypothesisSections>, name: string): string[] { return parsed.sections[name as keyof typeof parsed.sections] ?? []; }
function renderComment(artifact: RequirementArtifact, path: string): string { return [MARKER, "## Meguribi Requirement 草案", "", "採用された解決方針を要件へ構造化した草案です。人間による承認が必要です。", "", `- 選択案: ${String(artifact.selectedSolution.number)}. ${artifact.selectedSolution.statement}`, `- 要件: ${String(artifact.requirements.length)} 件`, `- 不足情報: ${artifact.openQuestions.length > 0 ? artifact.openQuestions.join(", ") : "なし"}`, `- 成果物: \`${path}\``].join("\n"); }
export async function requireSolution(input: RequireInput, deps: RequireDependencies): Promise<{ artifact: RequirementArtifact; artifactPath: string; commentId: number }> {
  const now = deps.now ?? (() => new Date()); const issue = await deps.github.getIssue(input.repository, input.issueNumber);
  if (!issue.labels.includes("product:approved")) throw new Error(`Requirement creation requires the human-approved product:approved label on ${input.repository}#${String(input.issueNumber)}`);
  if (!Number.isInteger(input.solutionNumber) || input.solutionNumber < 1) throw new Error("--solution must be a positive integer");
  const parsed = parseHypothesisSections(issue.body); const solutions = [...section(parsed, "solutionDirections"), ...section(parsed, "solutionHypotheses")];
  const unique = [...new Set(solutions.map((value) => value.trim()).filter(Boolean))]; const selected = unique[input.solutionNumber - 1];
  if (!selected) throw new Error(`Solution ${String(input.solutionNumber)} is not present; the Issue must contain explicit solution entries`);
  const problem = section(parsed, "problemCandidates")[0] ?? null;
  const artifact: RequirementArtifact = { schemaVersion: 1, artifactType: "requirements", repository: input.repository, sourceIssueNumber: issue.number, sourceIssueUrl: url(input.repository, issue.number), generatedAt: now().toISOString(), status: "draft", humanApprovalRequired: true, selectedSolution: { number: input.solutionNumber, statement: selected }, problem, targetUsers: [], requirements: [], acceptanceCriteria: [], outOfScope: [], successMetrics: [], guardrails: [], openQuestions: ["requirements", "acceptance criteria", "out of scope", "success metrics", "guardrails", ...(problem ? [] : ["problem"])], relatedIssues: { hypothesis: [issue.number], problem: [issue.number] } };
  const artifactPath = await deps.artifactStore.save({ repository: input.repository, sourceIssueNumber: input.issueNumber, artifact });
  const comment = await deps.github.upsertMarkerComment({ repository: input.repository, issueNumber: input.issueNumber, marker: MARKER, body: renderComment(artifact, artifactPath) });
  return { artifact, artifactPath, commentId: comment.commentId };
}
