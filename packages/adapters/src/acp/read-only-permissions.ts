import type { PermissionPolicyContext } from "@meguribi/core";
import {
  createPermissionMediator,
  type PermissionMediator,
} from "./permissions.js";

/**
 * read-only 役割セッション用の権限メディエーター。
 * `file_read` だけを通常のポリシー判定に委ね、それ以外の operation は
 * ポリシーに関係なく一律で拒否する。
 */
export function createReadOnlyPermissionMediator(
  context: PermissionPolicyContext,
): PermissionMediator {
  const inner = createPermissionMediator(context);
  return {
    async decide(request) {
      if (request.operation === "file_read") {
        return inner.decide(request);
      }
      return { outcome: "deny", reason: "role session is read-only" };
    },
    endSession(sessionId) {
      inner.endSession(sessionId);
    },
    records() {
      return inner.records();
    },
  };
}
