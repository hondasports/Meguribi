import type { GitHubAdapter } from "./delivery.js";

export interface MeasurementArtifact {
  schemaVersion: 1;
  artifactType: "measurement";
  repository: string;
  sourceIssueNumber: number;
  sourceIssueUrl: string;
  pullRequestNumber: number;
  pullRequestUrl: string;
  generatedAt: string;
  humanApprovalRequired: true;
  originalHypothesis: string | null;
  period: { from: string; to: string };
  metrics: string[];
  qualitativeEvidence: string[];
  result: "inconclusive";
  recommendedNextAction: "collect_more_data";
  nextHypothesisCandidates: string[];
  openQuestions: string[];
}

export interface MeasurementArtifactStore { save(input: { repository: string; sourceIssueNumber: number; artifact: MeasurementArtifact }): Promise<string> }
export interface MeasureDependencies { github: Pick<GitHubAdapter, "getIssue" | "getPullRequest" | "upsertMarkerComment">; artifactStore: MeasurementArtifactStore; now?: () => Date }
export interface MeasureInput { repository: string; issueNumber: number; period: string }

const MARKER = "<!-- meguribi:measure -->";

function sourceUrl(repository: string, issueNumber: number): string { return `https://github.com/${repository}/issues/${String(issueNumber)}`; }
function section(body: string, names: string[]): string | null {
  const wanted = names.map((name) => name.toLowerCase());
  const lines = body.split(/\r?\n/);
  for (let index = 0; index < lines.length; index += 1) {
    const heading = lines[index]?.match(/^#{1,6}\s+(.+?)\s*$/)?.[1]?.trim().toLowerCase();
    if (!heading || !wanted.includes(heading)) continue;
    const values: string[] = [];
    for (let next = index + 1; next < lines.length && !/^#{1,6}\s+/.test(lines[next] ?? ""); next += 1) {
      const value = (lines[next] ?? "").replace(/^\s*[-*]\s+/, "").trim();
      if (value) values.push(value);
    }
    return values.join(" ") || null;
  }
  return null;
}

function parsePeriod(value: string, now: Date): { from: string; to: string } {
  const match = value.trim().match(/^(\d+)([dw])$/i);
  if (!match || Number(match[1]) < 1) throw new Error(`Invalid --period: ${value}; use a positive duration such as 14d or 2w`);
  const days = Number(match[1]) * (match[2]!.toLowerCase() === "w" ? 7 : 1);
  const from = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  const to = new Date(from); to.setUTCDate(to.getUTCDate() + days - 1);
  return { from: from.toISOString().slice(0, 10), to: to.toISOString().slice(0, 10) };
}

function findPullRequestNumber(issue: Awaited<ReturnType<GitHubAdapter["getIssue"]>>): number {
  const matches = [...issue.body.matchAll(/(?:Draft PR|Pull Request|PR)\s*:?\s*#(\d+)/gi), ...issue.comments.flatMap((comment) => [...comment.body.matchAll(/(?:Draft PR|Pull Request|PR)\s*:?\s*#(\d+)/gi)])].map((match) => Number(match[1]));
  const unique = [...new Set(matches)].filter((number) => Number.isInteger(number) && number > 0);
  if (unique.length === 0) throw new Error(`Measurement requires a delivery summary with a Pull Request number on ${issue.number}`);
  if (unique.length > 1) throw new Error(`Measurement found multiple Pull Requests on ${issue.number}; remove ambiguity before retrying`);
  return unique[0]!;
}

function renderComment(artifact: MeasurementArtifact, artifactPath: string): string {
  return [MARKER, "## Meguribi Measurement 草案", "", "測定期間と実装後の評価項目を準備した草案です。結果と次の判断は人間が行います。", "", `- 対象 PR: #${String(artifact.pullRequestNumber)}`, `- 確認期間: ${artifact.period.from} 〜 ${artifact.period.to}`, `- 元の仮説: ${artifact.originalHypothesis ?? "未提示"}`, `- 不足情報: ${artifact.openQuestions.length > 0 ? artifact.openQuestions.join(", ") : "なし"}`, `- 成果物: \`${artifactPath}\``].join("\n");
}

export async function measureRelease(input: MeasureInput, deps: MeasureDependencies): Promise<{ artifact: MeasurementArtifact; artifactPath: string; commentId: number }> {
  const now = deps.now ?? (() => new Date());
  const issue = await deps.github.getIssue(input.repository, input.issueNumber);
  const pullRequestNumber = findPullRequestNumber(issue);
  const pullRequest = await deps.github.getPullRequest(input.repository, pullRequestNumber);
  if (!pullRequest.merged) throw new Error(`Measurement requires merged Pull Request #${String(pullRequestNumber)}; evaluate after release`);
  const originalHypothesis = section(issue.body, ["元の仮説", "original hypothesis", "仮説", "hypothesis"]);
  const metrics = section(issue.body, ["指標", "metrics"]);
  const qualitativeEvidence = section(issue.body, ["定性的反応", "qualitative evidence"]);
  const period = parsePeriod(input.period, now());
  const artifact: MeasurementArtifact = { schemaVersion: 1, artifactType: "measurement", repository: input.repository, sourceIssueNumber: issue.number, sourceIssueUrl: sourceUrl(input.repository, issue.number), pullRequestNumber, pullRequestUrl: pullRequest.url, generatedAt: now().toISOString(), humanApprovalRequired: true, originalHypothesis, period, metrics: metrics ? [metrics] : [], qualitativeEvidence: qualitativeEvidence ? [qualitativeEvidence] : [], result: "inconclusive", recommendedNextAction: "collect_more_data", nextHypothesisCandidates: [], openQuestions: [...(originalHypothesis ? [] : ["original hypothesis"]), ...(metrics ? [] : ["metrics"]), ...(qualitativeEvidence ? [] : ["qualitative evidence"]), "result", "decision"] };
  const artifactPath = await deps.artifactStore.save({ repository: input.repository, sourceIssueNumber: input.issueNumber, artifact });
  const comment = await deps.github.upsertMarkerComment({ repository: input.repository, issueNumber: input.issueNumber, marker: MARKER, body: renderComment(artifact, artifactPath) });
  return { artifact, artifactPath, commentId: comment.commentId };
}
