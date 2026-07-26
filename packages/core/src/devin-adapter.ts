/**
 * DevinAdapter is the historical name; the canonical interface is AgentAdapter.
 * All new code should import from ./agent-adapter.js.
 */
export type {
  AgentAdapter as DevinAdapter,
  FixInput,
  ImplementationArtifactPaths,
  ImplementationGitBoundary,
  ImplementationInput,
  ImplementationPermissionDecision,
  ImplementationResult,
  ImplementationStatus,
} from "./agent-adapter.js";
