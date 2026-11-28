import { describe, expect, it } from "vitest";
import { ApprovalError, assertApprovedConclusion, type ApprovalRecord } from "./approval.js";

const approvedRecord: ApprovalRecord = {
  decision: "approved",
  approver: "local-user",
  at: "2026-11-28T10:00:00.000Z",
  conclusionHash: "hash-1",
};

describe("assertApprovedConclusion", () => {
  it("accepts an approved conclusion when the current hash matches", () => {
    expect(() =>
      assertApprovedConclusion({
        approval: approvedRecord,
        currentConclusionHash: "hash-1",
      }),
    ).not.toThrow();
  });

  it("rejects a missing approval as not awaiting approval", () => {
    expect(() =>
      assertApprovedConclusion({
        approval: null,
        currentConclusionHash: "hash-1",
      }),
    ).toThrow(
      expect.objectContaining({
        name: "ApprovalError",
        code: "not_awaiting_approval",
        nextAction: "meguribi approve <runId>",
      }),
    );
  });

  it("rejects a rejected approval as not awaiting approval", () => {
    expect(() =>
      assertApprovedConclusion({
        approval: {
          ...approvedRecord,
          decision: "rejected",
          comment: "方針を再検討する",
        },
        currentConclusionHash: "hash-1",
      }),
    ).toThrow(
      expect.objectContaining({
        name: "ApprovalError",
        code: "not_awaiting_approval",
        nextAction: "meguribi approve <runId>",
      }),
    );
  });

  it("rejects an approved conclusion when the current hash changed after approval", () => {
    expect(() =>
      assertApprovedConclusion({
        approval: approvedRecord,
        currentConclusionHash: "hash-2",
      }),
    ).toThrow(
      expect.objectContaining({
        name: "ApprovalError",
        code: "conclusion_hash_mismatch",
        nextAction:
          "結論が承認後に変わっています。meguribi reject <runId> --redo で議論をやり直してください",
      }),
    );
  });

  it("uses ApprovalError for assertion failures", () => {
    try {
      assertApprovedConclusion({
        approval: null,
        currentConclusionHash: "hash-1",
      });
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(ApprovalError);
    }
  });
});
