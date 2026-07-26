export interface UntrustedSource {
  source: string;
  content: string;
}

export interface ImplementationContext {
  issue: UntrustedSource;
  comments: readonly UntrustedSource[];
  acceptanceCriteria: readonly string[];
  plan: { summary: string; steps: readonly string[] };
  repositoryRules: string;
  primarySkill: string;
  verificationCommands: readonly string[];
  protectedPaths: readonly string[];
  worktreePath: string;
  allowedPaths: readonly string[];
  limits: { maxPromptChars: number; maxChangedFiles: number; maxDiffLines: number };
  expectedResult: readonly string[];
  fixInstruction?: UntrustedSource;
}
