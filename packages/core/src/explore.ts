import type { GitHubAdapter } from "./delivery.js";
import { parseHypothesisSections } from "./hypothesis.js";

export interface SolutionOption {
  id: string;
  statement: string;
  userValue: string | null;
  validationPower: string | null;
  implementationCost: string | null;
  operationalCost: string | null;
  risk: string | null;
  reversibility: string | null;
  strategicFit: string | null;
  measurementDifficulty: string | null;
  guardrailRisk: string | null;
}

export interface ExploreArtifact {
  schemaVersion: 1;
  artifactType: "solution-exploration";
  repository: string;
  sourceIssueNumber: number;
  sourceIssueUrl: string;
  generatedAt: string;
  status: "draft";
  humanApprovalRequired: true;
  options: SolutionOption[];
  selectedOptionId: string | null;
  missingEvidence: string[];
}

export interface ExploreArtifactStore {
  save(input: { repository: string; sourceIssueNumber: number; artifact: ExploreArtifact }): Promise<string>;
}

export interface ExploreDependencies {
  github: Pick<GitHubAdapter, "getIssue" | "upsertMarkerComment">;
  artifactStore: ExploreArtifactStore;
  now?: () => Date;
}

export interface ExploreInput { repository: string; issueNumber: number }

const MARKER = "<!-- meguribi:explore -->";

function sourceUrl(repository: string, issueNumber: number): string {
  return `https://github.com/${repository}/issues/${String(issueNumber)}`;
}

function renderComment(artifact: ExploreArtifact, path: string): string {
  return [
    MARKER,
    "## Meguribi 解決方針比較草案",
    "",
    "入力に明示された解決方針だけを比較しています。採用案は自動選択していません。",
    "人間による比較と採用判断が必要です。",
    "",
    `- 案数: ${String(artifact.options.length)}`,
    `- 不足情報: ${artifact.missingEvidence.length > 0 ? artifact.missingEvidence.join(", ") : "なし"}`,
    `- 成果物: \`${path}\``,
  ].join("\n");
}

export async function exploreSolutions(input: ExploreInput, deps: ExploreDependencies): Promise<{ artifact: ExploreArtifact; artifactPath: string; commentId: number }> {
  const now = deps.now ?? (() => new Date());
  const issue = await deps.github.getIssue(input.repository, input.issueNumber);
  const sections = parseHypothesisSections(issue.body);
  const statements = [...(sections.sections.solutionHypotheses ?? []), ...(sections.sections["solutionDirections"] ?? [])];
  const unique = [...new Set(statements.map((value) => value.trim()).filter((value) => value.length > 0))];
  if (unique.length < 2) throw new Error("Explore requires at least two explicit 解決仮説 or 解決方針 entries; do not invent alternatives");
  const options: SolutionOption[] = unique.map((statement, index) => ({
    id: `solution-${String(index + 1).padStart(3, "0")}`,
    statement,
    userValue: null,
    validationPower: null,
    implementationCost: null,
    operationalCost: null,
    risk: null,
    reversibility: null,
    strategicFit: null,
    measurementDifficulty: null,
    guardrailRisk: null,
  }));
  const missingEvidence = [
    "user value",
    "validation power",
    "implementation cost",
    "operational cost",
    "risk",
    "reversibility",
    "strategic fit",
    "measurement difficulty",
    "guardrail risk",
  ];
  const artifact: ExploreArtifact = {
    schemaVersion: 1,
    artifactType: "solution-exploration",
    repository: input.repository,
    sourceIssueNumber: issue.number,
    sourceIssueUrl: sourceUrl(input.repository, issue.number),
    generatedAt: now().toISOString(),
    status: "draft",
    humanApprovalRequired: true,
    options,
    selectedOptionId: null,
    missingEvidence,
  };
  const artifactPath = await deps.artifactStore.save({ repository: input.repository, sourceIssueNumber: input.issueNumber, artifact });
  const comment = await deps.github.upsertMarkerComment({ repository: input.repository, issueNumber: input.issueNumber, marker: MARKER, body: renderComment(artifact, artifactPath) });
  return { artifact, artifactPath, commentId: comment.commentId };
}
