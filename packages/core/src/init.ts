export type InitDependencyStatus = "available" | "missing" | "failed";

export interface InitDependencyCheck {
  name: "git" | "gh";
  status: InitDependencyStatus;
  version?: string;
  nextAction?: string;
}

export interface RepositoryInitDiagnostics {
  repositoryPath: string;
  repository: string | null;
  defaultBranch: string | null;
  githubRepository: string | null;
  githubDefaultBranch: string | null;
  githubAuthenticated: boolean | null;
  dependencies: readonly InitDependencyCheck[];
  warnings: readonly string[];
  errors: readonly string[];
  runnable: boolean;
}
