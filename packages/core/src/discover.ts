import type { GitHubAdapter, IssueRecord } from "./delivery.js";

export type ObservationConfidence = "confirmed" | "reported" | "unknown";

export interface DiscoveryObservation {
  id: string;
  statement: string;
  source: string;
  confidence: ObservationConfidence;
  observedAt?: string;
}

export interface ProblemCandidate {
  id: string;
  theme: string;
  statement: string;
  evidenceRefs: string[];
  inferences: string[];
  missingInformation: string[];
  ranking: {
    rank: number;
    rationale: string;
  };
}

export interface DiscoveryArtifact {
  schemaVersion: 1;
  artifactType: "discovery";
  repository: string;
  generatedAt: string;
  filters: {
    updatedSince: string;
    label?: string;
    limit: number;
  };
  observations: DiscoveryObservation[];
  problemCandidates: ProblemCandidate[];
}

export interface DiscoveryArtifactStore {
  save(input: { repository: string; artifact: DiscoveryArtifact }): Promise<string>;
}

export interface DiscoverDependencies {
  github: Pick<GitHubAdapter, "listIssues">;
  artifactStore: DiscoveryArtifactStore;
  now?: () => Date;
}

export interface DiscoverInput {
  repository: string;
  since?: string;
  label?: string;
  limit?: number;
  fileObservations?: readonly DiscoveryObservation[];
}

function normalizeSince(value: string | undefined, now: () => Date): string {
  const raw = (value ?? "30d").trim();
  const duration = /^(\d{1,4})d$/i.exec(raw);
  if (duration) {
    const days = Number(duration[1]);
    if (days < 1 || days > 3650) throw new Error("--since must be between 1d and 3650d");
    const date = new Date(now());
    date.setUTCDate(date.getUTCDate() - days);
    return date.toISOString().slice(0, 10);
  }
  if (/^\d{4}-\d{2}-\d{2}$/.test(raw) && !Number.isNaN(Date.parse(`${raw}T00:00:00Z`))) return raw;
  throw new Error(`Invalid --since '${value ?? ""}'; use a duration such as 30d or an ISO date`);
}

function normalizeLabel(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const label = value.trim();
  if (label.length === 0 || label.length > 100 || label.includes("\0") || label.includes("\r") || label.includes("\n") || label.includes('"')) {
    throw new Error("--label must be a non-empty label name without quotes or control characters");
  }
  return label;
}

function normalizeLimit(value: number | undefined): number {
  const limit = value ?? 5;
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new Error("--limit must be an integer between 1 and 100");
  return limit;
}

function issueObservations(issues: readonly IssueRecord[]): DiscoveryObservation[] {
  const observations: DiscoveryObservation[] = [];
  for (const issue of issues) {
    const base = `github:issue:${String(issue.number)}`;
    observations.push({
      id: `${base}:title`,
      statement: issue.title,
      source: `${base}:title`,
      confidence: "reported",
      observedAt: issue.updatedAt,
    });
    if (issue.body.trim()) {
      observations.push({
        id: `${base}:body`,
        statement: issue.body.trim(),
        source: `${base}:body`,
        confidence: "reported",
        observedAt: issue.updatedAt,
      });
    }
    for (const comment of issue.comments) {
      if (!comment.body.trim()) continue;
      observations.push({
        id: `${base}:comment:${String(comment.id)}`,
        statement: comment.body.trim(),
        source: `${base}:comment:${String(comment.id)}`,
        confidence: "reported",
        observedAt: issue.updatedAt,
      });
    }
  }
  return observations;
}

function themeKey(statement: string): string {
  return statement
    .normalize("NFKC")
    .toLocaleLowerCase("en-US")
    .replace(/[`*_#]/g, "")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim()
    .replace(/\s+/g, " ")
    .slice(0, 160);
}

function candidatesFrom(observations: readonly DiscoveryObservation[]): ProblemCandidate[] {
  const groups = new Map<string, DiscoveryObservation[]>();
  for (const observation of observations) {
    const key = themeKey(observation.statement);
    if (!key) continue;
    const group = groups.get(key) ?? [];
    group.push(observation);
    groups.set(key, group);
  }
  const grouped = [...groups.entries()].sort((left, right) => {
    const evidence = right[1].length - left[1].length;
    return evidence || left[0].localeCompare(right[0]);
  });
  return grouped.map(([theme, evidence], index) => ({
    id: `candidate-${String(index + 1).padStart(3, "0")}`,
    theme,
    statement: evidence[0]!.statement,
    evidenceRefs: evidence.map((item) => item.id),
    inferences: [],
    missingInformation: ["impact", "root cause", "strategic fit"],
    ranking: {
      rank: index + 1,
      rationale: "Evidence grouping order only; this is not a product-priority decision.",
    },
  }));
}

export async function discoverProblems(input: DiscoverInput, deps: DiscoverDependencies): Promise<{ artifact: DiscoveryArtifact; artifactPath: string }> {
  const now = deps.now ?? (() => new Date());
  const updatedSince = normalizeSince(input.since, now);
  const label = normalizeLabel(input.label);
  const limit = normalizeLimit(input.limit);
  const issues = await deps.github.listIssues({ repository: input.repository, updatedSince, label, limit });
  const observations = [...(input.fileObservations ?? []), ...issueObservations(issues)];
  const artifact: DiscoveryArtifact = {
    schemaVersion: 1,
    artifactType: "discovery",
    repository: input.repository,
    generatedAt: now().toISOString(),
    filters: { updatedSince, ...(label ? { label } : {}), limit },
    observations,
    problemCandidates: candidatesFrom(observations),
  };
  const artifactPath = await deps.artifactStore.save({ repository: input.repository, artifact });
  return { artifact, artifactPath };
}
