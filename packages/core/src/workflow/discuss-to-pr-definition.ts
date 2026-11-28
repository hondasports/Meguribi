import type { WorkflowDefinition } from "../workflow-engine/definition.js";

export const DISCUSS_TO_PR_WORKFLOW_NAME = "discuss-to-pr";

/**
 * 組み込み discuss-to-pr ワークフロー（設計書 §6.5）。
 * discuss → approve(of: discuss) → specify のあと、delivery と同じ
 * plan → implement → verify → review ⇄ fix → publish を逐次実行する。
 * fix ループは delivery 由来の構造を使う（fix 工程が verify / review の
 * どちらの失敗を修正するかを `of` で区別するため）。
 */
export function createDiscussToPrWorkflow(maxFixAttempts: number): WorkflowDefinition {
  return {
    name: DISCUSS_TO_PR_WORKFLOW_NAME,
    steps: [
      { id: "discuss", kind: "discuss" },
      { id: "approve", kind: "approve", of: "discuss" },
      { id: "specify", kind: "specify" },
      { id: "plan", kind: "plan" },
      { id: "implement", kind: "implement" },
      { id: "verify", kind: "verify", onFailure: { goto: "fix-after-verify", max: 1 } },
      // oxlint-disable-next-line unicorn/no-thenable -- ワークフロー定義の `then` はデータフィールドであり thenable ではない
      {
        id: "review",
        kind: "review",
        // oxlint-disable-next-line unicorn/no-thenable -- ワークフロー定義の `then` はデータフィールドであり thenable ではない
        then: "publish",
        onChangesRequired: { goto: "fix-after-review", max: maxFixAttempts + 1 },
      },
      // oxlint-disable-next-line unicorn/no-thenable -- ワークフロー定義の `then` はデータフィールドであり thenable ではない
      { id: "fix-after-verify", kind: "fix", of: "verify", then: "review" },
      // oxlint-disable-next-line unicorn/no-thenable -- ワークフロー定義の `then` はデータフィールドであり thenable ではない
      {
        id: "fix-after-review",
        kind: "fix",
        of: "review",
        // oxlint-disable-next-line unicorn/no-thenable -- ワークフロー定義の `then` はデータフィールドであり thenable ではない
        then: "publish",
        onChangesRequired: { goto: "fix-after-review", max: maxFixAttempts + 1 },
      },
      { id: "publish", kind: "publish" },
    ],
  };
}
