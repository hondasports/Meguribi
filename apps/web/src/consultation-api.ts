import { MAX_CONSULTATION_PROMPT_LENGTH } from "./consultation-contract.js";

export interface DiscussionProfile {
  id: string;
  label: string;
}

export interface DiscussionProfilesResponse {
  profiles: DiscussionProfile[];
  defaultProfileIds: string[];
}

export interface DiscussionIssue {
  target: string;
  title: string;
}

export interface DiscussionIssuesResponse {
  issues: DiscussionIssue[];
}

export interface StartDiscussionInput {
  prompt: string;
  profileIds: string[];
  target?: string;
}

export interface StartDiscussionResult {
  runId: string;
}

export interface ConsultationApi {
  loadProfiles(): Promise<DiscussionProfilesResponse>;
  loadIssues(): Promise<DiscussionIssuesResponse>;
  startDiscussion(input: StartDiscussionInput): Promise<StartDiscussionResult>;
}

type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

async function readError(response: Response): Promise<Error> {
  const body = (await response.json().catch(() => null)) as { error?: unknown } | null;
  return new Error(
    typeof body?.error === "string" ? body.error : `Request failed (${String(response.status)})`,
  );
}

export function createConsultationApi(fetchImpl: FetchLike = fetch): ConsultationApi {
  return {
    async loadProfiles() {
      const result = await fetchImpl("/api/discussion/profiles");
      if (!result.ok) throw await readError(result);
      return (await result.json()) as DiscussionProfilesResponse;
    },
    async loadIssues() {
      const result = await fetchImpl("/api/discussion/issues");
      if (!result.ok) throw await readError(result);
      return (await result.json()) as DiscussionIssuesResponse;
    },
    async startDiscussion(input) {
      const body: Record<string, unknown> = {
        prompt: input.prompt,
        profileIds: input.profileIds,
      };
      if (input.target !== undefined && input.target.trim().length > 0) {
        body["target"] = input.target.trim();
      }
      const result = await fetchImpl("/api/discussions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!result.ok) throw await readError(result);
      return (await result.json()) as StartDiscussionResult;
    },
  };
}

export function validateConsultationInput(input: {
  prompt: string;
  profileIds: readonly string[];
}): string | null {
  if (input.prompt.trim().length === 0) return "相談内容を入力してください";
  if (input.prompt.length > MAX_CONSULTATION_PROMPT_LENGTH) {
    return `相談内容は${String(MAX_CONSULTATION_PROMPT_LENGTH)}文字以内で入力してください`;
  }
  const unique = new Set(input.profileIds);
  if (unique.size < 2 || unique.size > 4 || unique.size !== input.profileIds.length) {
    return "参加エージェントを2〜4件選んでください";
  }
  return null;
}
