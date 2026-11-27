import type {
  AgentError,
  AgentAdapter,
  AgentDiagnosis,
  FixInput,
  ImplementationInput,
  ImplementationPermissionDecision,
  ImplementationResult,
  ImplementationStatus,
  ImplementationContext,
  InheritedMcpPolicy,
  McpPolicyDecision,
} from "@meguribi/core";
import { decideInheritedMcpPolicy } from "@meguribi/core";
import { ImplementationContextSchema, ImplementationResultSchema } from "@meguribi/schemas";
import type { ProcessRunner } from "@meguribi/process";
import * as v from "valibot";
import { createPermissionMediator, type PermissionDecisionRecord } from "./permissions.js";
import type { AcpSession, StartAcpSessionInput } from "./session.js";
import type { AcpTransport } from "./transport.js";
import { AcpTransportError } from "./transport-error.js";

export type AcpImplementerSessionInput = Omit<
  StartAcpSessionInput,
  "assertRunnable" | "createArtifactStore" | "promptArtifact"
> & { implementationContext: ImplementationContext };

export interface AcpImplementerHooks {
  label: string;
  assertRunnable(diagnosis: AgentDiagnosis): void;
  isNotRunnableError(error: unknown): boolean;
  isPromptBuildError(error: unknown): boolean;
  isArtifactWriteError(error: unknown): boolean;
  startSession(input: AcpImplementerSessionInput): Promise<AcpSession>;
}

export interface AcpImplementerOptions {
  executable: string;
  executableArgs?: string[];
  acpArgs?: string[];
  diagnosis: AgentDiagnosis;
  getDiagnosis?: () => Promise<AgentDiagnosis> | AgentDiagnosis;
  inheritedMcpPolicy: InheritedMcpPolicy;
  mode: "interactive" | "non-interactive";
  explicitAllowInheritedMcp?: boolean;
  startupTimeoutMs: number;
  promptTimeoutMs?: number;
  postTurnLivenessMs?: number;
  env?: NodeJS.ProcessEnv;
  runner?: ProcessRunner;
  transport?: AcpTransport;
  confirmInheritedMcp?: () => Promise<boolean> | boolean;
  allowedCommands?: readonly string[];
}

export class AcpImplementerAdapterError extends Error {
  constructor(
    public readonly code: AgentError["code"],
    message: string,
    public readonly isRetryable = false,
    options?: { cause?: unknown },
  ) {
    super(message, options);
    this.name = "AcpImplementerAdapterError";
  }

  toAgentError(): AgentError {
    return {
      code: this.code,
      message: this.message,
      isRetryable: this.isRetryable,
    };
  }
}

function emptyResult(
  partial: Partial<ImplementationResult> &
    Pick<
      ImplementationResult,
      | "status"
      | "sessionId"
      | "startedAt"
      | "finishedAt"
      | "durationMs"
      | "artifactPaths"
      | "publishable"
    >,
): ImplementationResult {
  return {
    changedFiles: [],
    reportedFiles: [],
    unresolvedItems: [],
    permissionDecisions: [],
    ...partial,
  };
}

function errorMessage(error: unknown, fallback: string): string {
  return error instanceof Error ? error.message : fallback;
}

function mapTransportErrorWithHooks(hooks: AcpImplementerHooks, error: unknown): AgentError {
  if (error instanceof AcpImplementerAdapterError) {
    return error.toAgentError();
  }
  if (error instanceof AcpTransportError) {
    return error.toAgentError();
  }
  if (hooks.isNotRunnableError(error)) {
    return {
      code: "policy_blocked",
      message: errorMessage(error, "ACP server is not runnable"),
      isRetryable: false,
    };
  }
  if (hooks.isPromptBuildError(error)) {
    return {
      code: "malformed_message",
      message: errorMessage(error, "ACP implementation prompt could not be built"),
      isRetryable: false,
    };
  }
  if (hooks.isArtifactWriteError(error)) {
    return {
      code: "cleanup_failed",
      message: errorMessage(error, "ACP artifact could not be written"),
      isRetryable: false,
    };
  }
  if (error instanceof Error && /Git\/worktree safety boundary/i.test(error.message)) {
    return {
      code: "policy_blocked",
      message: error.message,
      isRetryable: false,
    };
  }
  return {
    code: "unknown",
    message: errorMessage(error, `${hooks.label} ACP adapter failed`),
    isRetryable: false,
  };
}

function statusFromError(error: AgentError): ImplementationStatus {
  if (error.code === "cancelled") return "cancelled";
  if (error.code === "timeout") return "timed_out";
  if (
    error.code === "policy_blocked" ||
    error.code === "permission_denied" ||
    error.code === "cleanup_failed"
  ) {
    return "blocked";
  }
  return "failed";
}

function toPermissionDecisions(
  records: readonly PermissionDecisionRecord[],
): ImplementationPermissionDecision[] {
  return records.map((record) => ({
    requestId: record.requestId,
    outcome: record.decision.outcome,
    reason: record.decision.reason,
  }));
}

function collectReportedFiles(events: readonly { type: string; path?: string }[]): string[] {
  const files = new Set<string>();
  for (const event of events) {
    if (event.type === "file.changed" && typeof event.path === "string") {
      files.add(event.path);
    }
  }
  return [...files];
}

export function createGenericAcpImplementer(options: AcpImplementerOptions & { hooks: AcpImplementerHooks }): AgentAdapter {
  const hooks = options.hooks;
  const mapTransportError = (error: unknown): AgentError =>
    mapTransportErrorWithHooks(hooks, error);
  const run = async (
    input: ImplementationInput | FixInput,
    mode: "implement" | "fix",
  ): Promise<ImplementationResult> => {
    const startedAt = new Date();
    const startedAtIso = startedAt.toISOString();
    let session: AcpSession | undefined;
    let secondaryError: AgentError | undefined;
    let mcpPolicyResult: McpPolicyDecision | undefined;
    let permissionDecisions: ImplementationPermissionDecision[] = [];

    const finishPartial = (
      status: ImplementationStatus,
      error?: AgentError,
      extras?: Partial<ImplementationResult>,
    ): ImplementationResult => {
      const finishedAt = new Date();
      const result = emptyResult({
        status,
        sessionId: session?.sessionId ?? "none",
        startedAt: startedAtIso,
        finishedAt: finishedAt.toISOString(),
        durationMs: Math.max(0, finishedAt.getTime() - startedAt.getTime()),
        artifactPaths: {
          root: input.artifactRoot,
          ...(session
            ? {
                rawEvents: session.artifacts.rawEventsPath,
                events: session.artifacts.eventsPath,
                result: session.artifacts.resultPath,
                gitBoundary: session.artifacts.gitBoundaryPath,
                termination: session.artifacts.terminationPath,
                prompt: session.artifacts.promptPath,
                stderr: session.artifacts.stderrPath,
              }
            : {}),
        },
        publishable: false,
        ...(error ? { error } : {}),
        ...(secondaryError ? { secondaryError } : {}),
        ...(mcpPolicyResult ? { mcpPolicyResult } : {}),
        permissionDecisions,
        ...extras,
      });
      return v.parse(ImplementationResultSchema, result);
    };

    try {
      const parsedContext = v.parse(ImplementationContextSchema, input.context);
      if (mode === "fix" && !parsedContext.fixInstruction && !parsedContext.fixContext) {
        throw new AcpImplementerAdapterError(
          "malformed_message",
          "fix requires fixInstruction or fixContext",
        );
      }

      const diagnosis = options.getDiagnosis
        ? await options.getDiagnosis()
        : options.diagnosis;
      hooks.assertRunnable(diagnosis);

      mcpPolicyResult = decideInheritedMcpPolicy({
        policy: options.inheritedMcpPolicy,
        mode: options.mode,
        explicitAllow: options.explicitAllowInheritedMcp ?? false,
        detection: { detected: false, transport: "unknown" },
      });
      if (mcpPolicyResult.outcome === "confirm") {
        const confirmed = options.confirmInheritedMcp
          ? await options.confirmInheritedMcp()
          : false;
        if (!confirmed) {
          return finishPartial(
            "blocked",
            {
              code: "policy_blocked",
              message: "inherited MCP confirmation was denied",
              isRetryable: false,
            },
            { mcpPolicyResult },
          );
        }
        mcpPolicyResult = {
          ...mcpPolicyResult,
          outcome: "allow",
          reason: "the user explicitly accepted inherited MCP use",
        };
      } else if (mcpPolicyResult.outcome === "block") {
        return finishPartial(
          "blocked",
          {
            code: "policy_blocked",
            message: mcpPolicyResult.reason,
            isRetryable: false,
          },
          { mcpPolicyResult },
        );
      }

      const permissionMediator = createPermissionMediator({
        mode: options.mode,
        allowedCommands: options.allowedCommands ?? parsedContext.verificationCommands,
      });

      session = await hooks.startSession({
        executable: options.executable,
        executableArgs: options.executableArgs,
        acpArgs: options.acpArgs,
        cwd: parsedContext.worktreePath,
        env: options.env,
        startupTimeoutMs: options.startupTimeoutMs,
        promptTimeoutMs: options.promptTimeoutMs,
        postTurnLivenessMs: options.postTurnLivenessMs,
        diagnosis,
        runner: options.runner,
        transport: options.transport,
        resumeSessionId: mode === "fix" ? (input as FixInput).previousSessionId : undefined,
        artifactRoot: input.artifactRoot,
        implementationContext: parsedContext,
        permissionMediator,
        protectedPaths: [...parsedContext.protectedPaths],
        mcpPolicy: {
          policy: options.inheritedMcpPolicy,
          mode: options.mode,
          explicitAllow: options.explicitAllowInheritedMcp ?? false,
          confirm: options.confirmInheritedMcp,
        },
        gitBoundary: {
          expectedRemoteIdentity: input.gitBoundary.expectedRemoteIdentity,
          expectedBaseSha: input.gitBoundary.expectedBaseSha,
          expectedBranch: input.gitBoundary.expectedBranch,
          outsidePaths: [...input.gitBoundary.outsidePaths],
          protectedPaths: [...input.gitBoundary.protectedPaths],
          maxChangedFiles: input.gitBoundary.maxChangedFiles,
          maxDiffLines: input.gitBoundary.maxDiffLines,
          baselineMode: mode === "fix" ? "approved-base" : "session-start",
        },
      });

      const events: { type: string; path?: string; stopReason?: string }[] = [];
      let stopReason: string | undefined;

      const abort = () => {
        void session?.cancel();
      };
      if (input.abortSignal) {
        if (input.abortSignal.aborted) {
          await session.cancel().catch(() => undefined);
          throw new AcpImplementerAdapterError("cancelled", "implementation aborted before prompt");
        }
        input.abortSignal.addEventListener("abort", abort, { once: true });
      }

      try {
        // hooks.startSession already built+persisted the constrained prompt from ImplementationContext.
        for await (const event of session.prompt()) {
          if (input.abortSignal?.aborted) {
            throw new AcpImplementerAdapterError("cancelled", "implementation aborted");
          }
          events.push(event as { type: string; path?: string; stopReason?: string });
          input.onEvent?.(event);
          if (event.type === "turn.completed") {
            stopReason = event.stopReason;
          }
          if (event.type === "session.failed") {
            throw new AcpImplementerAdapterError(
              event.error.code,
              event.error.message,
              event.error.isRetryable,
            );
          }
        }
      } finally {
        input.abortSignal?.removeEventListener("abort", abort);
      }

      permissionDecisions = toPermissionDecisions(permissionMediator.records());
      const denied = permissionDecisions.find((decision) => decision.outcome === "deny");
      if (denied) {
        const boundary = await session.validateGitBoundary().catch((error) => {
          secondaryError = mapTransportError(error);
          return undefined;
        });
        return finishPartial(
          "blocked",
          {
            code: "permission_denied",
            message: denied.reason,
            isRetryable: false,
          },
          {
            changedFiles: boundary?.changedFiles ?? [],
            reportedFiles: collectReportedFiles(events),
            stopReason,
            termination: await session
              .shutdown("cancelled", {
                gracefulShutdownMs: 50,
                terminateTimeoutMs: 1_000,
              })
              .catch((error) => {
                secondaryError = mapTransportError(error);
                return undefined;
              }),
          },
        );
      }

      const reportedFiles = collectReportedFiles(events);
      let boundary;
      try {
        await session.finish({
          status: "completed",
          sessionId: session.sessionId,
          stopReason: stopReason ?? "end_turn",
          reportedFiles,
        });
        boundary = await session.validateGitBoundary(reportedFiles);
      } catch (error) {
        const agentError = mapTransportError(error);
        boundary = await session.validateGitBoundary(reportedFiles).catch((secondary) => {
          secondaryError = mapTransportError(secondary);
          return undefined;
        });
        const termination = await session
          .shutdown("protocol_error", {
            gracefulShutdownMs: 50,
            terminateTimeoutMs: 1_000,
          })
          .catch((secondary) => {
            secondaryError = secondaryError ?? mapTransportError(secondary);
            return undefined;
          });
        return finishPartial(statusFromError(agentError), agentError, {
          changedFiles: boundary?.changedFiles ?? [],
          reportedFiles,
          stopReason,
          termination,
          publishable: false,
        });
      }

      const termination = await session
        .shutdown("completed", {
          gracefulShutdownMs: 1,
          terminateTimeoutMs: 1_000,
        })
        .catch((error) => {
          secondaryError = mapTransportError(error);
          return undefined;
        });

      const publishable = Boolean(boundary?.publishable) && !secondaryError;
      const status: ImplementationStatus = publishable ? "completed" : "blocked";
      const finishedAt = new Date();
      const result: ImplementationResult = {
        status,
        sessionId: session.sessionId,
        startedAt: startedAtIso,
        finishedAt: finishedAt.toISOString(),
        durationMs: Math.max(0, finishedAt.getTime() - startedAt.getTime()),
        stopReason: stopReason ?? "end_turn",
        changedFiles: boundary?.changedFiles ?? [],
        reportedFiles,
        unresolvedItems: [],
        permissionDecisions,
        mcpPolicyResult,
        termination,
        artifactPaths: {
          root: input.artifactRoot,
          rawEvents: session.artifacts.rawEventsPath,
          events: session.artifacts.eventsPath,
          result: session.artifacts.resultPath,
          gitBoundary: session.artifacts.gitBoundaryPath,
          termination: session.artifacts.terminationPath,
          prompt: session.artifacts.promptPath,
          stderr: session.artifacts.stderrPath,
        },
        publishable,
        ...(publishable
          ? {}
          : {
              error: {
                code: "policy_blocked" as const,
                message:
                  boundary?.reasons.join("; ") ||
                  secondaryError?.message ||
                  "implementation blocked",
                isRetryable: false,
              },
            }),
        ...(secondaryError ? { secondaryError } : {}),
      };
      return v.parse(ImplementationResultSchema, result);
    } catch (error) {
      const agentError = mapTransportError(error);
      if (session) {
        const termination = await session
          .shutdown(
            agentError.code === "cancelled"
              ? "cancelled"
              : agentError.code === "timeout"
                ? "timed_out"
                : "protocol_error",
            { gracefulShutdownMs: 50, terminateTimeoutMs: 1_000 },
          )
          .catch((secondary) => {
            secondaryError = mapTransportError(secondary);
            return undefined;
          });
        const boundary = await session.validateGitBoundary().catch((secondary) => {
          secondaryError = secondaryError ?? mapTransportError(secondary);
          return undefined;
        });
        return finishPartial(statusFromError(agentError), agentError, {
          changedFiles: boundary?.changedFiles ?? [],
          termination,
        });
      }
      return finishPartial(statusFromError(agentError), agentError);
    }
  };

  return {
    implement: (input) => run(input, "implement"),
    fix: (input) => run(input, "fix"),
  };
}
