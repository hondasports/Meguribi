import type { GitHubAdapter } from "./delivery.js";

export type HypothesisConfidence = "confirmed" | "reported" | "unknown";

export interface HypothesisObservation {
  statement: string;
  source: string;
  confidence: HypothesisConfidence;
}

export interface HypothesisProblemCandidate {
  statement: string;
  targetUser?: string;
  confidence: HypothesisConfidence;
}

export interface HypothesisArtifact {
  schemaVersion: 1;
  artifactType: "hypothesis";
  repository: string;
  issueNumber: number;
  generatedAt: string;
  status: "draft";
  humanApprovalRequired: true;
  observations: HypothesisObservation[];
  problemCandidates: HypothesisProblemCandidate[];
  causeHypotheses: string[];
  solutionHypotheses: string[];
  counterHypotheses: string[];
  validationMethods: string[];
  successConditions: string[];
  rejectionConditions: string[];
  missingEvidence: string[];
}

export interface HypothesisArtifactStore {
  save(input: { repository: string; issueNumber: number; artifact: HypothesisArtifact }): Promise<string>;
}

export interface HypothesisDependencies {
  github: Pick<GitHubAdapter, "getIssue" | "upsertMarkerComment">;
  artifactStore: HypothesisArtifactStore;
  now?: () => Date;
}

export interface HypothesisInput {
  repository: string;
  issueNumber: number;
}

const SECTION_NAMES = {
  observations: "観測",
  problemCandidates: "課題候補",
  causeHypotheses: "原因仮説",
  solutionHypotheses: "解決仮説",
  counterHypotheses: "反対仮説",
  validationMethods: "検証方法",
  successConditions: "成功条件",
  rejectionConditions: "失敗・棄却条件",
} as const;

type SectionKey = keyof typeof SECTION_NAMES;

const SECTION_ALIASES: Record<SectionKey, readonly string[]> = {
  observations: ["観測", "observations", "observation"],
  problemCandidates: ["課題候補", "problem candidates", "problem candidate"],
  causeHypotheses: ["原因仮説", "cause hypotheses", "cause hypothesis"],
  solutionHypotheses: ["解決仮説", "solution hypotheses", "solution hypothesis"],
  counterHypotheses: ["反対仮説", "counter hypotheses", "counter hypothesis"],
  validationMethods: ["検証方法", "validation methods", "validation method"],
  successConditions: ["成功条件", "success conditions", "success condition"],
  rejectionConditions: ["失敗・棄却条件", "失敗・却下条件", "rejection conditions", "rejection condition"],
};

export interface HypothesisSections {
  sections: Partial<Record<SectionKey, string[]>>;
  present: Set<SectionKey>;
}

function normalizeHeading(value: string): string {
  return value
    .normalize("NFKC")
    .replace(/[：:]+$/u, "")
    .trim()
    .toLocaleLowerCase("en-US");
}

function sectionKey(value: string): SectionKey | undefined {
  const normalized = normalizeHeading(value);
  return (Object.keys(SECTION_ALIASES) as SectionKey[]).find((key) =>
    SECTION_ALIASES[key].some((alias) => normalizeHeading(alias) === normalized),
  );
}

function linesFromSection(lines: readonly string[]): string[] {
  return lines
    .map((line) => line.replace(/^\s*(?:[-*+]\s+|\d+[.)]\s+)/u, "").trim())
    .filter((line) => line.length > 0);
}

export function parseHypothesisSections(body: string): HypothesisSections {
  const sections: Partial<Record<SectionKey, string[]>> = {};
  const present = new Set<SectionKey>();
  let current: SectionKey | undefined;
  let buffer: string[] = [];

  const flush = () => {
    if (current) sections[current] = [...(sections[current] ?? []), ...linesFromSection(buffer)];
    buffer = [];
  };

  for (const line of body.split(/\r?\n/u)) {
    const heading = /^##\s+(.+?)\s*$/u.exec(line);
    if (heading) {
      flush();
      current = sectionKey(heading[1]!);
      if (current) present.add(current);
      continue;
    }
    if (current) buffer.push(line);
  }
  flush();
  return { sections, present };
}

function nonEmptySection(parsed: HypothesisSections, key: SectionKey): string[] {
  return parsed.sections[key] ?? [];
}

function toObservations(values: readonly string[], source: string): HypothesisObservation[] {
  return values.map((statement) => ({ statement, source, confidence: "reported" }));
}

function toProblemCandidates(values: readonly string[]): HypothesisProblemCandidate[] {
  return values.map((statement) => ({ statement, confidence: "reported" }));
}

function missingEvidence(parsed: HypothesisSections): string[] {
  return (Object.keys(SECTION_NAMES) as SectionKey[])
    .filter((key) => !parsed.present.has(key) || (parsed.sections[key] ?? []).length === 0)
    .map((key) => SECTION_NAMES[key]);
}

function hypothesisComment(artifact: HypothesisArtifact, artifactPath: string): string {
  const marker = "<!-- meguribi:hypothesis -->";
  const missing = artifact.missingEvidence.length > 0
    ? artifact.missingEvidence.map((item) => `\`${item}\``).join(", ")
    : "なし";
  return [
    marker,
    "## Meguribi 仮説草案",
    "",
    "この成果物は Issue 本文の記載を構造化した草案です。未提示の事実・数値・引用は補っていません。",
    "人間による確認と承認が必要です。",
    "",
    `- 観測: ${String(artifact.observations.length)} 件`,
    `- 課題候補: ${String(artifact.problemCandidates.length)} 件`,
    `- 原因 / 解決 / 反対仮説: ${String(artifact.causeHypotheses.length)} / ${String(artifact.solutionHypotheses.length)} / ${String(artifact.counterHypotheses.length)} 件`,
    `- 不足情報: ${missing}`,
    `- 成果物: \`${artifactPath}\``,
  ].join("\n");
}

export async function structureHypothesis(
  input: HypothesisInput,
  deps: HypothesisDependencies,
): Promise<{ artifact: HypothesisArtifact; artifactPath: string; commentId: number }> {
  const now = deps.now ?? (() => new Date());
  const issue = await deps.github.getIssue(input.repository, input.issueNumber);
  const parsed = parseHypothesisSections(issue.body);
  const source = `github:issue:${String(issue.number)}:body`;
  const artifact: HypothesisArtifact = {
    schemaVersion: 1,
    artifactType: "hypothesis",
    repository: input.repository,
    issueNumber: input.issueNumber,
    generatedAt: now().toISOString(),
    status: "draft",
    humanApprovalRequired: true,
    observations: toObservations(nonEmptySection(parsed, "observations"), source),
    problemCandidates: toProblemCandidates(nonEmptySection(parsed, "problemCandidates")),
    causeHypotheses: nonEmptySection(parsed, "causeHypotheses"),
    solutionHypotheses: nonEmptySection(parsed, "solutionHypotheses"),
    counterHypotheses: nonEmptySection(parsed, "counterHypotheses"),
    validationMethods: nonEmptySection(parsed, "validationMethods"),
    successConditions: nonEmptySection(parsed, "successConditions"),
    rejectionConditions: nonEmptySection(parsed, "rejectionConditions"),
    missingEvidence: missingEvidence(parsed),
  };
  const artifactPath = await deps.artifactStore.save({
    repository: input.repository,
    issueNumber: input.issueNumber,
    artifact,
  });
  const comment = await deps.github.upsertMarkerComment({
    repository: input.repository,
    issueNumber: input.issueNumber,
    marker: "<!-- meguribi:hypothesis -->",
    body: hypothesisComment(artifact, artifactPath),
  });
  return { artifact, artifactPath, commentId: comment.commentId };
}
