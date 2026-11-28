export interface ApprovalRecord {
  decision: "approved" | "rejected";
  approver: string;
  at: string;
  conclusionHash: string;
  comment?: string;
  redo?: boolean;
}

type ApprovalErrorCode =
  | "not_awaiting_approval"
  | "conclusion_missing"
  | "conclusion_hash_mismatch"
  | "redo_limit_reached";

export class ApprovalError extends Error {
  readonly code: ApprovalErrorCode;
  readonly nextAction: string;

  constructor(code: ApprovalErrorCode, message: string, nextAction: string) {
    super(message);
    this.name = "ApprovalError";
    this.code = code;
    this.nextAction = nextAction;
  }
}

const APPROVE_NEXT_ACTION = "meguribi approve <runId>";
const CONCLUSION_HASH_MISMATCH_NEXT_ACTION =
  "結論が承認後に変わっています。meguribi reject <runId> --redo で議論をやり直してください";

export function assertApprovedConclusion(input: {
  approval: ApprovalRecord | null;
  currentConclusionHash: string;
}): void {
  const { approval, currentConclusionHash } = input;

  if (approval === null || approval.decision !== "approved") {
    throw new ApprovalError(
      "not_awaiting_approval",
      "Discussion conclusion is not approved",
      APPROVE_NEXT_ACTION,
    );
  }

  if (approval.conclusionHash !== currentConclusionHash) {
    throw new ApprovalError(
      "conclusion_hash_mismatch",
      "Discussion conclusion changed after approval",
      CONCLUSION_HASH_MISMATCH_NEXT_ACTION,
    );
  }
}
