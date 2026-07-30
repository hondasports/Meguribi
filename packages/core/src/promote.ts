import type { GitHubAdapter, IssueRecord } from "./delivery.js";
import { parseHypothesisSections, type HypothesisSections } from "./hypothesis.js";

export interface ProblemArtifact {
  schemaVersion: 1;
  artifactType: "problem";
  repository: string;
  sourceIssueNumber: number;
  sourceIssueUrl: string;
  generatedAt: string;
  status: "draft";
  humanApprovalRequired: true;
  title: string;
  problem: string;
  targetUser: string | null;
  evidence: string[];
  userImpact: string | null;
  currentWorkaround: string | null;
  unconfirmedItems: string[];
  relatedHypothesis: string;
}

export interface ProblemArtifactStore {
  save(input: { repository: string; sourceIssueNumber: number; artifact: ProblemArtifact }): Promise<string>;
}

export interface PromoteDependencies {
  github: Pick<GitHubAdapter, "getIssue" | "upsertMarkerComment" | "createIssue">;
  artifactStore: ProblemArtifactStore;
  now?: () => Date;
}

export interface PromoteInput {
  repository: string;
  issueNumber: number;
  createIssue?: boolean;
  confirmCreateIssue?: () => Promise<boolean>;
}

export interface PromoteResult {
  artifact: ProblemArtifact;
  artifactPath: string;
  commentId: number;
  createdIssue?: { number: number; url: string };
}

const PROMOTE_MARKER = "<!-- meguribi:promote -->";
const REQUIRED_VALIDATION_LABEL = "product:validated";

function section(parsed: HypothesisSections, name: keyof HypothesisSections["sections"]): string[] {
  return parsed.sections[name] ?? [];
}

function sourceUrl(repository: string, issueNumber: number): string {
  return `https://github.com/${repository}/issues/${String(issueNumber)}`;
}

function renderProblemComment(artifact: ProblemArtifact, artifactPath: string): string {
  return [
    PROMOTE_MARKER,
    "## Meguribi Problem 草案",
    "",
    "この草案は `product:validated` の Hypothesis Issue から観測と課題候補を引き継いだものです。解決策は固定していません。",
    "人間による課題採用と新規Issue作成の確認が必要です。",
    "",
    `- 課題: ${artifact.problem}`,
    `- 根拠: ${String(artifact.evidence.length)} 件`,
    `- 未確認事項: ${artifact.unconfirmedItems.length > 0 ? artifact.unconfirmedItems.join(", ") : "なし"}`,
    `- 成果物: \`${artifactPath}\``,
  ].join("\n");
}

function buildArtifact(repository: string, issue: IssueRecord, parsed: HypothesisSections, generatedAt: string): ProblemArtifact {
  const observations = section(parsed, "observations");
  const candidates = section(parsed, "problemCandidates");
  const missing = [
    ...(parsed.present.has("observations") && observations.length > 0 ? [] : ["観測"]),
    ...(parsed.present.has("problemCandidates") && candidates.length > 0 ? [] : ["課題候補"]),
    "対象ユーザー",
    "ユーザーへの影響",
    "現在の回避方法",
  ];
  return {
    schemaVersion: 1,
    artifactType: "problem",
    repository,
    sourceIssueNumber: issue.number,
    sourceIssueUrl: sourceUrl(repository, issue.number),
    generatedAt,
    status: "draft",
    humanApprovalRequired: true,
    title: `Problem: ${issue.title}`,
    problem: candidates.join(" "),
    targetUser: null,
    evidence: observations,
    userImpact: null,
    currentWorkaround: null,
    unconfirmedItems: [...new Set(missing)],
    relatedHypothesis: sourceUrl(repository, issue.number),
  };
}

export async function promoteHypothesis(input: PromoteInput, deps: PromoteDependencies): Promise<PromoteResult> {
  const now = deps.now ?? (() => new Date());
  const issue = await deps.github.getIssue(input.repository, input.issueNumber);
  if (!issue.labels.includes(REQUIRED_VALIDATION_LABEL)) {
    throw new Error(`Promotion requires the human-approved ${REQUIRED_VALIDATION_LABEL} label on ${input.repository}#${String(input.issueNumber)}`);
  }
  const parsed = parseHypothesisSections(issue.body);
  const observations = section(parsed, "observations");
  const candidates = section(parsed, "problemCandidates");
  if (observations.length === 0 || candidates.length === 0) {
    throw new Error("Promotion requires non-empty 観測 and 課題候補 sections; add evidence before promoting");
  }
  const artifact = buildArtifact(input.repository, issue, parsed, now().toISOString());
  const artifactPath = await deps.artifactStore.save({
    repository: input.repository,
    sourceIssueNumber: input.issueNumber,
    artifact,
  });
  const comment = await deps.github.upsertMarkerComment({
    repository: input.repository,
    issueNumber: input.issueNumber,
    marker: PROMOTE_MARKER,
    body: renderProblemComment(artifact, artifactPath),
  });
  let createdIssue: PromoteResult["createdIssue"];
  if (input.createIssue) {
    const confirmed = await (input.confirmCreateIssue ?? (async () => false))();
    if (!confirmed) throw new Error("Problem Issue creation was not confirmed; draft remains saved");
    createdIssue = await deps.github.createIssue({
      repository: input.repository,
      title: artifact.title,
      body: renderProblemBody(artifact),
      labels: ["type:problem", "product:approved"],
    });
  }
  return { artifact, artifactPath, commentId: comment.commentId, ...(createdIssue ? { createdIssue } : {}) };
}

function renderProblemBody(artifact: ProblemArtifact): string {
  return [
    "<!-- meguribi:problem -->",
    "## 課題",
    "",
    artifact.problem,
    "",
    "## 対象ユーザー",
    "",
    "未確認",
    "",
    "## 根拠",
    "",
    ...artifact.evidence.map((item) => `- ${item}`),
    "",
    "## ユーザーへの影響",
    "",
    "未確認",
    "",
    "## 現在の回避方法",
    "",
    "未確認",
    "",
    "## 未確認事項",
    "",
    ...artifact.unconfirmedItems.map((item) => `- ${item}`),
    "",
    "## 関連 Hypothesis",
    "",
    artifact.relatedHypothesis,
  ].join("\n");
}
