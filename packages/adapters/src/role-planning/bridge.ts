import { randomUUID } from "node:crypto";
import type {
  DeliveryDependencies,
  LiveLogEvent,
  PlanArtifact,
  PlanContent,
  ReviewArtifact,
  ReviewContent,
  RoleAgent,
  RoleSession,
} from "@meguribi/core";
import { agentDisplayName } from "@meguribi/core";
import { PlanContentSchema, ReviewContentSchema } from "@meguribi/schemas";
import * as v from "valibot";
import { buildPlanningPrompt, buildRepairPrompt, buildReviewPrompt } from "../codex/prompt.js";
import { digestSource } from "../codex/digest.js";
import type { CodexWorkspaceGuard } from "../codex/types.js";
import { captureGitWorktreeSnapshot } from "../git-boundary.js";
import { RoleSessionWriteViolationError } from "../acp-server/role-agent.js";
import { extractFinalJson } from "./extract-json.js";

export class RolePlanningError extends Error {
  readonly code: "malformed_output" | "policy_blocked";
  readonly attempts: number;

  constructor(code: "malformed_output" | "policy_blocked", message: string, attempts: number) {
    super(message);
    this.name = "RolePlanningError";
    this.code = code;
    this.attempts = attempts;
  }
}

export interface CreateRoleAgentPlanningBridgeOptions {
  planner: RoleAgent;
  reviewer: RoleAgent;
  artifactRoot: string;
  onEvent?: (event: LiveLogEvent) => void;
  now?: () => Date;
}

const PLAN_KEYS = [
  "summary",
  "requirements",
  "acceptanceCriteria",
  "outOfScope",
  "proposedFiles",
  "steps",
  "risks",
  "tests",
  "humanDecisions",
  "unresolvedItems",
] as const;

const REVIEW_KEYS = [
  "status",
  "summary",
  "requirementCoverage",
  "findings",
  "missingTests",
  "scopeViolations",
  "recommendedAction",
] as const;

function fenceInstruction(keys: readonly string[]): string {
  return [
    "Finally, output exactly one JSON object inside a single ```json fence.",
    `The object must have only these keys: ${keys.join(", ")}.`,
    "Do not include any text after the closing fence.",
  ].join("\n");
}

function validationSummary(issues: readonly v.BaseIssue<unknown>[]): string {
  return issues
    .map((issue) => issue.path?.map((item) => String(item.key)).join(".") ?? issue.message)
    .join(", ");
}

async function workspaceDigest(repositoryPath: string): Promise<{ guard: CodexWorkspaceGuard; digest: string }> {
  const snapshot = () =>
    captureGitWorktreeSnapshot({ cwd: repositoryPath }).then((value) => JSON.stringify(value));
  const before = await snapshot();
  return { guard: { snapshot }, digest: digestSource(before) };
}

function issueContext(issue: { title: string; body: string; comments: readonly { body: string }[] }) {
  return {
    title: issue.title,
    body: issue.body,
    comments: issue.comments.map((comment) => comment.body),
  };
}

export function createRoleAgentPlanningBridge(
  options: CreateRoleAgentPlanningBridgeOptions,
): DeliveryDependencies["codex"] {
  const now = options.now ?? (() => new Date());

  async function runStructured<T>(params: {
    agent: RoleAgent;
    role: "planner" | "reviewer";
    stepId: "plan" | "review";
    repositoryPath: string;
    basePrompt: string;
    schema: v.GenericSchema<unknown, T>;
    keys: readonly string[];
  }): Promise<{ content: T; sessionId: string; durationMs: number }> {
    const { agent, role, stepId } = params;
    const startedAt = now().getTime();
    const artifactRoot = `${options.artifactRoot}/${role}-${startedAt}`;
    const session = await agent.openSession({
      cwd: params.repositoryPath,
      mode: "read-only",
      role,
      artifactRoot,
      onEvent: options.onEvent
        ? (event) => {
            options.onEvent?.({
              type: "agent.event",
              stepId,
              profileId: agent.profileId,
              agentLabel: agentDisplayName(agent.kind),
              role,
              event,
            });
          }
        : undefined,
    });

    let attempts = 0;
    try {
      let prompt = `${params.basePrompt}\n\n${fenceInstruction(params.keys)}`;
      let lastMessage = "response did not match the required schema";
      while (attempts < 3) {
        attempts += 1;
        const result = await sendWithConversion(session, prompt, attempts);
        const extracted = extractFinalJson(result.text);
        if (extracted !== undefined) {
          const parsed = v.safeParse(params.schema, extracted);
          if (parsed.success) {
            return {
              content: parsed.output,
              sessionId: session.sessionId,
              durationMs: now().getTime() - startedAt,
            };
          }
          lastMessage = `response schema mismatch: ${validationSummary(parsed.issues)}`;
        } else {
          lastMessage = "response did not contain a final ```json fence with valid JSON";
        }
        if (attempts < 3) {
          prompt = buildRepairPrompt(role, lastMessage);
        }
      }
      throw new RolePlanningError(
        "malformed_output",
        `${role} response failed validation after ${attempts} attempts: ${lastMessage}`,
        attempts,
      );
    } finally {
      await closeWithConversion(session, attempts);
    }
  }

  async function sendWithConversion(
    session: RoleSession,
    content: string,
    attempts: number,
  ): Promise<{ text: string }> {
    try {
      return await session.send({ content });
    } catch (error) {
      throw convert(error, attempts);
    }
  }

  async function closeWithConversion(session: RoleSession, attempts: number): Promise<void> {
    try {
      await session.close();
    } catch (error) {
      throw convert(error, attempts);
    }
  }

  function convert(error: unknown, attempts: number): unknown {
    if (error instanceof RoleSessionWriteViolationError) {
      return new RolePlanningError(
        "policy_blocked",
        `${error.message} (changed files: ${error.changedFiles.join(", ")})`,
        attempts,
      );
    }
    return error;
  }

  return {
    createPlan: async (input) => {
      const issue = issueContext(input.issue);
      const workspace = await workspaceDigest(input.repositoryPath);
      const sourceDigests: Record<string, string> = {
        issue: digestSource(issue),
        repository: workspace.digest,
        ...(input.userRequest === undefined
          ? {}
          : { userRequest: digestSource(input.userRequest) }),
      };
      const result = await runStructured<PlanContent>({
        agent: options.planner,
        role: "planner",
        stepId: "plan",
        repositoryPath: input.repositoryPath,
        basePrompt: buildPlanningPrompt({
          repositoryPath: input.repositoryPath,
          issue,
          userRequest: input.userRequest,
          repositoryRules: input.repositoryRules,
          completionCriteria: input.completionCriteria,
          outOfScope: input.outOfScope,
          sourceDigests,
          workspaceGuard: workspace.guard,
        }),
        schema: PlanContentSchema,
        keys: PLAN_KEYS,
      });
      const artifact: PlanArtifact = {
        ...result.content,
        schemaVersion: 1,
        artifactType: "implementation-plan",
        metadata: {
          schemaVersion: 1,
          artifactId: randomUUID(),
          createdAt: now().toISOString(),
          durationMs: result.durationMs,
          producer: { kind: options.planner.kind, role: "planner", threadId: result.sessionId },
          sourceDigests,
          eventLog: [],
        },
      };
      return artifact;
    },

    review: async (input) => {
      const issue = issueContext(input.issue);
      const workspace = await workspaceDigest(input.repositoryPath);
      const verification = {
        success: input.verification.success,
        commands: input.verification.commands.map((command) => ({
          name: command.name,
          exitCode: command.exitCode,
        })),
      };
      const sourceDigests: Record<string, string> = {
        issue: digestSource(issue),
        plan: digestSource(input.plan),
        diff: digestSource(input.diff),
        verification: digestSource(verification),
        repository: workspace.digest,
      };
      const result = await runStructured<ReviewContent>({
        agent: options.reviewer,
        role: "reviewer",
        stepId: "review",
        repositoryPath: input.repositoryPath,
        basePrompt: buildReviewPrompt({
          repositoryPath: input.repositoryPath,
          issue,
          plan: input.plan,
          diff: input.diff,
          changedFiles: input.changedFiles,
          verification,
          repositoryRules: input.repositoryRules,
          sourceDigests,
          workspaceGuard: workspace.guard,
        }),
        schema: ReviewContentSchema,
        keys: REVIEW_KEYS,
      });
      const artifact: ReviewArtifact = {
        ...result.content,
        schemaVersion: 1,
        artifactType: "code-review",
        metadata: {
          schemaVersion: 1,
          artifactId: randomUUID(),
          createdAt: now().toISOString(),
          durationMs: result.durationMs,
          producer: { kind: options.reviewer.kind, role: "reviewer", threadId: result.sessionId },
          sourceDigests,
          eventLog: [],
        },
      };
      return artifact;
    },
  };
}
