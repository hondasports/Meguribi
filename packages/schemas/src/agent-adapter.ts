/**
 * Agent-agnostic re-exports for adapter input/output schemas.
 * The canonical schema definitions live in their original files to avoid
 * unnecessary churn; this module provides a stable agent-neutral entry point.
 */
export {
  ImplementationArtifactPathsSchema,
  ImplementationPermissionDecisionSchema,
  ImplementationResultSchema,
  McpPolicyDecisionSchema,
} from "./implementation-result.js";
export {
  AgentTerminationResultSchema,
  ImplementationContextSchema,
  PermissionRequestSchema,
} from "./devin-safety.js";
export type {
  ImplementationArtifactPaths,
  ImplementationPermissionDecision,
  ImplementationResult,
} from "./implementation-result.js";
export type {
  AgentTerminationResult,
  FixContext,
  ImplementationContext,
  PermissionRequest,
} from "./devin-safety.js";
