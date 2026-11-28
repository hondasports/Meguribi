import type { AgentError } from "../agent-error.js";
import type { DiscussionConclusion } from "../discussion/types.js";
import { assertApprovedConclusion, type ApprovalRecord } from "../discussion/approval.js";
import { decideInheritedMcpPolicy } from "../mcp-policy.js";
import type {
  DeliveryDependencies,
  DeliveryResult,
  RunDeliveryInput,
} from "../delivery.js";
import type { RunStore } from "../delivery.js";
import { requireIssueRunState } from "../delivery.js";
import { runWorkflow } from "../workflow-engine/engine.js";
import { createRunStoreStepStateStore } from "../workflow-engine/run-store-step-state.js";
import {
  buildSpecificationArtifacts,
  saveSpecificationArtifacts,
  type Specification,
  type SpecificationContent,
} from "../specify/specification.js";
import type { RequirementArtifact } from "../require.js";
import {
  runDiscussionWorkflow,
  type DiscussionDependencies,
  type DiscussionWorkflowResult,
  type RunDiscussionWorkflowInput,
} from "./discussion.js";
import {
  createDeliveryStepHandlers,
  type DeliveryRunContext,
} from "./delivery-steps.js";
import { createDiscussToPrWorkflow } from "./discuss-to-pr-definition.js";

/** `discuss-to-pr` 固有の永続化入力。承認後の継続に必要な delivery 設定を保持する。 */
export interface DiscussToPrContinuationConfig {
  outOfScope: string[];
  protectedPaths: readonly string[];
  verifyCommands: readonly { name: string; run: string }[];
  inheritedMcpPolicy: RunDeliveryInput["inheritedMcpPolicy"];
  allowInheritedMcp: boolean;
  maxFixAttempts: number;
  artifactRootForDevin: string;
  verifyTimeoutMs?: number;
  noCommit?: boolean;
  noPush?: boolean;
  noPr?: boolean;
}

export type RunDiscussToPrInput = RunDiscussionWorkflowInput & DiscussToPrContinuationConfig;

export interface SpecifyPort {
  (input: {
    cwd: string;
    artifactRoot: string;
    conclusion: DiscussionConclusion;
    abortSignal?: AbortSignal;
  }): Promise<SpecificationContent>;
}

export interface DiscussToPrDependencies {
  discussion: DiscussionDependencies;
  delivery: DeliveryDependencies;
  specify: SpecifyPort;
  now?: () => Date;
}

const CONTINUATION_ARTIFACT = "discuss-to-pr.json";
const DISCUSSION_INPUT_ARTIFACT = "discussion-input.json";

interface PersistedDiscussionInput {
  repositoryPath: string;
  worktreePath: string;
  branch: string;
  baseRef: string;
  requiredLabels: readonly string[];
  repositoryRules: string;
  nonInteractive: boolean;
  artifactRoot: string;
  userRequest?: string;
}

function nowIso(now?: () => Date): string {
  return (now?.() ?? new Date()).toISOString();
}

/**
 * 第1フェーズ: 議論を実行し、承認待ちで止まる。
 * 継続に必要な delivery 設定を `discuss-to-pr.json` として Run に保存する。
 */
function continuationConfig(input: RunDiscussToPrInput): DiscussToPrContinuationConfig {
  return {
    outOfScope: [...input.outOfScope],
    protectedPaths: input.protectedPaths,
    verifyCommands: input.verifyCommands,
    inheritedMcpPolicy: input.inheritedMcpPolicy,
    allowInheritedMcp: input.allowInheritedMcp,
    maxFixAttempts: input.maxFixAttempts,
    artifactRootForDevin: input.artifactRootForDevin,
    ...(input.verifyTimeoutMs !== undefined ? { verifyTimeoutMs: input.verifyTimeoutMs } : {}),
    ...(input.noCommit !== undefined ? { noCommit: input.noCommit } : {}),
    ...(input.noPush !== undefined ? { noPush: input.noPush } : {}),
    ...(input.noPr !== undefined ? { noPr: input.noPr } : {}),
  };
}

export async function runDiscussToPr(
  input: RunDiscussToPrInput,
  deps: DiscussToPrDependencies,
): Promise<DiscussionWorkflowResult> {
  const config = continuationConfig(input);
  let saved = false;
  const saveContinuation = async (runId: string): Promise<void> => {
    if (saved) {
      return;
    }
    await deps.discussion.runStore.saveArtifact(runId, CONTINUATION_ARTIFACT, config);
    saved = true;
  };

  const originalBeforeStateChange = deps.discussion.beforeStateChange;
  const discussionDeps: typeof deps.discussion = {
    ...deps.discussion,
    beforeStateChange: async (runId, patch) => {
      if (patch.status === "awaiting_human") {
        await saveContinuation(runId);
      }
      await originalBeforeStateChange?.(runId, patch);
    },
  };

  return await runDiscussionWorkflow(input, discussionDeps);
}

/** この Run が discuss-to-pr の継続対象かどうか（CLI の approve 分岐に使う）。 */
export async function hasDiscussToPrContinuation(
  runStore: RunStore,
  runId: string,
): Promise<boolean> {
  return (await runStore.readArtifact(runId, CONTINUATION_ARTIFACT)) !== null;
}

interface StepStateSnapshot {
  stepId: string;
  status: "running" | "completed" | "failed";
  outcome?: string;
  startedAt: string;
}

/**
 * 再開位置の決定。中断後の再実行で完了済み工程を再実行しないための最小ルール:
 * - 記録がなければ specify から
 * - 最後に開始された工程が未完（running/failed）ならその工程から
 * - 完了していたら engine と同じ遷移規則で次工程を求める。次がなければ null（全部済み）
 */
export async function findContinuationStartStep(
  runStore: RunStore,
  runId: string,
  definition: { steps: readonly { id: string; then?: string; onFailure?: { goto: string }; onChangesRequired?: { goto: string } }[] },
): Promise<string | null> {
  const records: StepStateSnapshot[] = [];
  for (const step of definition.steps) {
    const record = await runStore.readArtifact<StepStateSnapshot>(runId, `steps/${step.id}.json`);
    if (record !== null && typeof record.startedAt === "string") {
      records.push(record);
    }
  }
  if (records.length === 0) {
    return "specify";
  }
  const interrupted = records.filter(
    (record) => record.status === "running" || record.status === "failed",
  );
  if (interrupted.length > 0) {
    interrupted.sort((left, right) => right.startedAt.localeCompare(left.startedAt));
    return interrupted[0]?.stepId ?? "specify";
  }

  // 完了済み工程だけがある場合は、ループで定義順と実行順が入れ替わっても
  // outcome に従って次工程へ進む。記録がなければ specify から。
  const indexOf = (stepId: string): number =>
    definition.steps.findIndex((step) => step.id === stepId);
  const last = [...records].sort((a, b) => indexOf(b.stepId) - indexOf(a.stepId))[0];
  if (last === undefined) {
    return "specify";
  }
  if (last.status !== "completed") {
    return last.stepId;
  }
  const stepIndex = definition.steps.findIndex((step) => step.id === last.stepId);
  const step = definition.steps[stepIndex];
  if (step === undefined) {
    return last.stepId;
  }
  if (last.outcome === "failure" && step.onFailure !== undefined) {
    return step.onFailure.goto;
  }
  if (last.outcome === "changes_required" && step.onChangesRequired !== undefined) {
    return step.onChangesRequired.goto;
  }
  if (step.then !== undefined) {
    return step.then;
  }
  const next = definition.steps[stepIndex + 1];
  return next === undefined ? null : next.id;
}

export class DiscussToPrContinuationError extends Error {
  readonly code: "not_awaiting_continuation" | "missing_artifact";
  constructor(code: "not_awaiting_continuation" | "missing_artifact", message: string) {
    super(message);
    this.name = "DiscussToPrContinuationError";
    this.code = code;
  }
}

/**
 * 第2フェーズ: 承認記録済みの Run を specify 以降へ進める。
 * - 排他: Run のロックを取得し、並行 approve / 復帰の二重実行を防ぐ
 * - 常時検証: 再開位置に関わらず、承認ハッシュと現在の結論を照合する
 * - 復元: 永続済みの仕様・plan・implementation 等を context に再読み込みする
 * - 冪等: 全工程完了済みなら何も実行せず現在の状態を返す（二重実装・二重 PR 防止）
 */
export async function continueDiscussToPrAfterApproval(
  input: { runId: string; abortSignal?: AbortSignal },
  deps: DiscussToPrDependencies,
): Promise<DeliveryResult> {
  const { runId } = input;
  const deliveryDeps = deps.delivery;
  const runStore = deliveryDeps.runStore;
  const state = await runStore.load(runId);
  if (state === null || state.command !== "discuss") {
    throw new DiscussToPrContinuationError(
      "not_awaiting_continuation",
      `Run は discuss-to-pr の対象ではありません: ${runId}`,
    );
  }

  await runStore.acquireLock({
    repository: state.repository,
    issueNumber: state.issueNumber,
    runId,
  });
  const releaseLock = async (): Promise<void> => {
    await runStore
      .releaseLock({ repository: state.repository, issueNumber: state.issueNumber })
      .catch(() => undefined);
  };

  try {
    // 再読込: ロック取得後に最新状態へ追従する
    let lockedState = requireIssueRunState((await runStore.load(runId)) ?? state);
    const approval = await runStore.readArtifact<ApprovalRecord>(runId, "approval.json");
    if (approval === null || approval.decision !== "approved") {
      throw new DiscussToPrContinuationError(
        "not_awaiting_continuation",
        `承認記録がありません。先に meguribi approve ${runId} を実行してください`,
      );
    }
    const config = await runStore.readArtifact<DiscussToPrContinuationConfig>(runId, CONTINUATION_ARTIFACT);
    const discussionInput = await runStore.readArtifact<PersistedDiscussionInput>(runId, DISCUSSION_INPUT_ARTIFACT);
    if (config === null || discussionInput === null) {
      throw new DiscussToPrContinuationError(
        "missing_artifact",
        "discuss-to-pr の継続入力が見つかりません（Run が壊れている可能性があります）",
      );
    }
    lockedState = requireIssueRunState(await runStore.update(runId, { maxFixAttempts: config.maxFixAttempts }));
    const store = deps.discussion.createStore(runId);
    const conclusion = await store.readConclusion();
    if (conclusion === null) {
      throw new DiscussToPrContinuationError(
        "missing_artifact",
        "discussion/conclusion.json が見つかりません",
      );
    }

    // 常時検証: 再開位置に関わらず承認した結論と現在の結論のハッシュを照合する。
    // 承認後に結論が変わっていたらここで停止する（buildSpecificationArtifacts だけに頼らない）。
    const conclusionHash = deps.discussion.hashConclusion(conclusion);
    assertApprovedConclusion({ approval, currentConclusionHash: conclusionHash });

    // 永続済みの仕様を復元する。specify 工程を再実行しない再開でも、
    // completionCriteria / outOfScope はここから常に埋め直す。
    const persistedRequirement = await runStore.readArtifact<RequirementArtifact>(runId, "requirement.json");
    const persistedSpecification = await runStore.readArtifact<Specification>(runId, "specification.json");
    if (persistedSpecification !== null && persistedSpecification.conclusionHash !== conclusionHash) {
      throw new DiscussToPrContinuationError(
        "not_awaiting_continuation",
        "保存済みの仕様が現在の結論と一致しません。reject してやり直してください",
      );
    }

    const deliveryInput: RunDeliveryInput = {
      repository: lockedState.repository,
      issueNumber: lockedState.issueNumber,
      repositoryPath: discussionInput.repositoryPath,
      worktreePath: discussionInput.worktreePath,
      branch: discussionInput.branch,
      baseRef: discussionInput.baseRef,
      repositoryRules: discussionInput.repositoryRules,
      completionCriteria: persistedRequirement?.acceptanceCriteria.map((criterion) => criterion.statement) ?? [],
      outOfScope: persistedRequirement !== null ? [...persistedRequirement.outOfScope] : [...config.outOfScope],
      requiredLabels: discussionInput.requiredLabels,
      protectedPaths: config.protectedPaths,
      verifyCommands: config.verifyCommands,
      inheritedMcpPolicy: config.inheritedMcpPolicy,
      allowInheritedMcp: config.allowInheritedMcp,
      nonInteractive: discussionInput.nonInteractive,
      maxFixAttempts: config.maxFixAttempts,
      artifactRootForDevin: config.artifactRootForDevin,
      ...(input.abortSignal !== undefined ? { abortSignal: input.abortSignal } : {}),
      ...(config.verifyTimeoutMs !== undefined ? { verifyTimeoutMs: config.verifyTimeoutMs } : {}),
      ...(config.noCommit !== undefined ? { noCommit: config.noCommit } : {}),
      ...(config.noPush !== undefined ? { noPush: config.noPush } : {}),
      ...(config.noPr !== undefined ? { noPr: config.noPr } : {}),
    };

    const issue = await deliveryDeps.github.getIssue(lockedState.repository, lockedState.issueNumber);
    const definition = createDiscussToPrWorkflow(config.maxFixAttempts);
    const startAt = await findContinuationStartStep(runStore, runId, definition);

    if (startAt === null) {
      // 全工程が完了済み: 再実行せず現在の状態を返す（二重 PR 防止の要）
      const latest = await runStore.load(runId);
      return {
        runId,
        status: latest?.status ?? "completed",
        published: true,
        pullRequestNumber: latest?.pullRequestNumber,
        reasons: ["discuss-to-pr run already completed; nothing re-executed"],
      };
    }

    const preflight = deliveryDeps.assertImplementerReady ?? deliveryDeps.assertDevinReady;
    if (preflight) {
      await preflight();
    }
    const mcpDecision = decideInheritedMcpPolicy({
      policy: config.inheritedMcpPolicy,
      mode: discussionInput.nonInteractive ? "non-interactive" : "interactive",
      explicitAllow: config.allowInheritedMcp,
      detection: { detected: false, transport: "unknown" },
    });
    if (mcpDecision.outcome !== "allow") {
      const confirmed = mcpDecision.outcome === "confirm" && deliveryDeps.mcpConfirmation
        ? await deliveryDeps.mcpConfirmation.confirmInheritedMcp()
        : false;
      if (!confirmed) {
        await runStore.update(runId, {
          status: "blocked",
          lastError: { code: "policy_blocked", message: mcpDecision.reason },
          updatedAt: nowIso(deps.now),
        });
        return { runId, status: "blocked", published: false, reasons: [mcpDecision.reason] };
      }
    }

    // 永続状態から前工程の成果物を復元する（再開時に plan 等を失わないため）
    const plan = await runStore.readArtifact<NonNullable<DeliveryRunContext["plan"]>>(runId, "plan.json");
    const implementation = await runStore.readArtifact<NonNullable<DeliveryRunContext["implementation"]>>(runId, "implementation-result.json");
    const verification = await runStore.readArtifact<NonNullable<DeliveryRunContext["verification"]>>(runId, "verification.json");
    const review = await runStore.readArtifact<NonNullable<DeliveryRunContext["review"]>>(runId, "review.json");

    const context: DeliveryRunContext = {
      deps: deliveryDeps,
      delivery: deliveryInput,
      state: lockedState,
      issue,
      ...(plan !== null ? { plan } : {}),
      ...(implementation !== null ? { implementation } : {}),
      ...(verification !== null ? { verification } : {}),
      ...(review !== null ? { review } : {}),
      // verify 工程より後ろから再開するときは既存の検証結果を再利用する
      reuseVerification: verification !== null && startAt !== "verify" && !startAt.startsWith("fix"),
      includeSpecificationInPrBody: true,
    };

    const specifyHandler = async (): Promise<{ type: "continue" }> => {
      const content = await deps.specify({
        cwd: discussionInput.worktreePath,
        artifactRoot: discussionInput.artifactRoot,
        conclusion,
        ...(input.abortSignal !== undefined ? { abortSignal: input.abortSignal } : {}),
      });
      const artifacts = buildSpecificationArtifacts({
        repository: lockedState.repository,
        sourceIssueNumber: lockedState.issueNumber,
        sourceIssueUrl: `https://github.com/${lockedState.repository}/issues/${String(lockedState.issueNumber)}`,
        runId,
        approval,
        conclusion,
        content,
        generatedAt: nowIso(deps.now),
        conclusionHash,
      });
      await saveSpecificationArtifacts(runStore, runId, artifacts);
      // A3 対策: 受け入れ条件を plan の completionCriteria として引き渡す
      deliveryInput.completionCriteria = artifacts.requirement.acceptanceCriteria.map(
        (criterion) => criterion.statement,
      );
      deliveryInput.outOfScope = [...artifacts.requirement.outOfScope];
      return { type: "continue" };
    };

    const deliveryHandlers = createDeliveryStepHandlers();
    try {
      const workflowResult = await runWorkflow<DeliveryRunContext, DeliveryResult>({
        runId,
        definition,
        handlers: {
          ...deliveryHandlers,
          specify: specifyHandler,
        },
        context,
        startAt,
        stepStore: createRunStoreStepStateStore(runStore, runId),
        onEvent: deliveryDeps.onWorkflowEvent,
        now: deliveryDeps.now,
      });
      if (workflowResult.type === "stopped") {
        return workflowResult.result;
      }
      return {
        runId,
        status: "failed",
        published: false,
        reasons: [`discuss-to-pr workflow ended without a result: ${workflowResult.type}`],
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const code = (error as AgentError | undefined)?.code ?? "unknown";
      const status = code === "cancelled" ? "cancelled"
        : code === "timeout" ? "timed_out"
        : code === "policy_blocked" || code === "permission_denied" ? "blocked"
        : "failed";
      await runStore.update(runId, {
        status,
        lastError: { code: typeof code === "string" ? code : "unknown", message },
        updatedAt: nowIso(deps.now),
      }).catch(() => undefined);
      return { runId, status, published: false, reasons: [message] };
    }
  } finally {
    await releaseLock();
  }
}
