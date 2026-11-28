import type { ApprovalRecord, DiscussionConclusion, DiscussionTurn } from "@meguribi/core";

export interface DiscussionDetail {
  turns: DiscussionTurn[];
  conclusion: DiscussionConclusion | null;
  approval: ApprovalRecord | null;
  canInterject: boolean;
  canDecide: boolean;
}

export interface DiscussionActionResult {
  ok: boolean;
  stdout?: string;
  stderr?: string;
  started?: boolean;
}

export interface DiscussionApi {
  load(runId: string): Promise<DiscussionDetail>;
  say(runId: string, message: string): Promise<DiscussionActionResult>;
  approve(runId: string, comment?: string): Promise<DiscussionActionResult>;
  reject(runId: string, reason: string, redo: boolean): Promise<DiscussionActionResult>;
}

type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

function endpoint(runId: string, suffix: string): string {
  return `/api/run-store/runs/${encodeURIComponent(runId)}/${suffix}`;
}

async function readJson(response: Response): Promise<unknown> {
  return (await response.json()) as unknown;
}

function errorMessage(payload: unknown, fallback: string): string {
  if (
    typeof payload === "object" &&
    payload !== null &&
    "error" in payload &&
    typeof payload.error === "string"
  ) {
    return payload.error;
  }
  return fallback;
}

async function expectOk(response: Response, fallback: string): Promise<unknown> {
  const payload = await readJson(response);
  if (!response.ok) throw new Error(errorMessage(payload, fallback));
  return payload;
}

async function postJson(
  fetchImpl: FetchLike,
  path: string,
  body: Record<string, unknown>,
): Promise<DiscussionActionResult> {
  const response = await fetchImpl(path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const payload = await readJson(response);
  if (!response.ok && response.status !== 422) {
    throw new Error(errorMessage(payload, "操作を実行できませんでした"));
  }
  return payload as DiscussionActionResult;
}

export function createDiscussionApi(
  fetchImpl: FetchLike = (input, init) => fetch(input, init),
): DiscussionApi {
  return {
    async load(runId) {
      const response = await fetchImpl(endpoint(runId, "discussion"));
      return (await expectOk(response, "議論を読み込めませんでした")) as DiscussionDetail;
    },
    say(runId, message) {
      return postJson(fetchImpl, endpoint(runId, "say"), { message });
    },
    approve(runId, comment) {
      const body: Record<string, unknown> = {};
      if (comment !== undefined && comment.trim().length > 0) body["comment"] = comment;
      return postJson(fetchImpl, endpoint(runId, "approve"), body);
    },
    reject(runId, reason, redo) {
      return postJson(fetchImpl, endpoint(runId, "reject"), { reason, redo });
    },
  };
}
