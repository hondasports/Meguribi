import type { WorkflowDefinition } from "../workflow-engine/definition.js";

export const DELIVERY_WORKFLOW_NAME = "delivery";

/**
 * 組み込み delivery ワークフロー。
 * 既存 delivery の plan → implement → verify → review ⇄ fix → publish を、
 * 逐次と上限付き遷移だけで表す。
 */
export function createDeliveryWorkflow(maxFixAttempts: number): WorkflowDefinition {
  return {
    name: DELIVERY_WORKFLOW_NAME,
    steps: [
      { id: "plan", kind: "plan" },
      { id: "implement", kind: "implement" },
      { id: "verify", kind: "verify", onFailure: { goto: "fix-after-verify", max: 1 } },
      // oxlint-disable-next-line unicorn/no-thenable -- ワークフロー定義の `then` はデータフィールドであり thenable ではない
      {
        id: "review",
        kind: "review",
        then: "publish",
        onChangesRequired: { goto: "fix-after-review", max: 1 },
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
