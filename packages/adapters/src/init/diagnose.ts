import path from "node:path";
import { ProcessError, ProcessRunner } from "@meguribi/process";
import type { InitDependencyCheck, RepositoryInitDiagnostics } from "@meguribi/core";

interface CommandResult {
  exitCode: number | null;
  stdout: string;
  stderr: string;
}

export interface InitCommandRunner {
  run(executable: string, args: readonly string[], cwd: string): Promise<CommandResult>;
}

async function collect(source: AsyncIterable<Uint8Array>): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of source) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks).toString("utf8");
}

class ProcessInitCommandRunner implements InitCommandRunner {
  async run(executable: string, args: readonly string[], cwd: string): Promise<CommandResult> {
    const child = new ProcessRunner().run(executable, [...args], {
      cwd,
      env: process.env,
      timeoutMs: 30_000,
      terminationGraceMs: 5_000,
    });
    const [stdout, stderr, exit] = await Promise.all([
      collect(child.stdout),
      collect(child.stderr),
      child.waitForExit(),
    ]);
    return { exitCode: exit.code, stdout, stderr };
  }
}

export interface RepositoryInitDiagnosticsOptions {
  repositoryPath: string;
  runner?: InitCommandRunner;
  gitExecutable?: string;
  githubExecutable?: string;
  codexExecutable?: string;
}

interface GhRepositoryResponse {
  nameWithOwner?: unknown;
  defaultBranchRef?: { name?: unknown } | null;
}

function normalizeRepository(remote: string): string | null {
  const value = remote.trim().replace(/\.git$/, "");
  if (value.startsWith("git@")) {
    const separator = value.indexOf(":");
    if (separator > 0) {
      const host = value.slice(4, separator).toLowerCase();
      const repository = value.slice(separator + 1);
      return host === "github.com" ? repository : null;
    }
  }
  try {
    const url = new URL(value);
    if (url.hostname.toLowerCase() !== "github.com") return null;
    return url.pathname.replace(/^\/+/, "");
  } catch {
    return null;
  }
}

function commandStatus(
  name: InitDependencyCheck["name"],
  result: CommandResult,
): InitDependencyCheck {
  if (result.exitCode === 0) {
    const version = result.stdout.trim().split(/\r?\n/, 1)[0];
    return { name, status: "available", version: version || undefined };
  }
  return {
    name,
    status: "failed",
    nextAction:
      name === "gh" ? "Run gh auth login and retry" : `Install or repair ${name} and retry`,
  };
}

function isMissing(error: unknown): boolean {
  return error instanceof ProcessError && error.code === "executable_not_found";
}

function missingDependency(name: InitDependencyCheck["name"]): InitDependencyCheck {
  return {
    name,
    status: "missing",
    nextAction: name === "gh" ? "Install GitHub CLI (gh) and run gh auth login" : `Install ${name}`,
  };
}

function failedDependency(name: InitDependencyCheck["name"]): InitDependencyCheck {
  return {
    name,
    status: "failed",
    nextAction: name === "gh" ? "Run gh auth status and retry" : `Run ${name} --version and retry`,
  };
}

async function runDependency(
  runner: InitCommandRunner,
  name: InitDependencyCheck["name"],
  executable: string,
  args: readonly string[],
  cwd: string,
): Promise<InitDependencyCheck> {
  try {
    return commandStatus(name, await runner.run(executable, args, cwd));
  } catch (error) {
    if (isMissing(error)) return missingDependency(name);
    return failedDependency(name);
  }
}

function parseGhRepository(
  output: string,
): { repository: string; defaultBranch: string | null } | null {
  try {
    const value = JSON.parse(output) as GhRepositoryResponse;
    if (typeof value.nameWithOwner !== "string") return null;
    const branch = value.defaultBranchRef?.name;
    return {
      repository: value.nameWithOwner,
      defaultBranch: typeof branch === "string" && branch.length > 0 ? branch : null,
    };
  } catch {
    return null;
  }
}

export async function diagnoseRepository(
  options: RepositoryInitDiagnosticsOptions,
): Promise<RepositoryInitDiagnostics> {
  const repositoryPath = path.resolve(options.repositoryPath);
  const runner = options.runner ?? new ProcessInitCommandRunner();
  const gitExecutable = options.gitExecutable ?? "git";
  const githubExecutable = options.githubExecutable ?? "gh";
  const codexExecutable = options.codexExecutable ?? "codex";
  const dependencies = await Promise.all([
    runDependency(runner, "git", gitExecutable, ["--version"], repositoryPath),
    runDependency(runner, "gh", githubExecutable, ["--version"], repositoryPath),
    runDependency(runner, "codex", codexExecutable, ["--version"], repositoryPath),
  ]);
  const warnings: string[] = [];
  const errors: string[] = [];
  let repository: string | null = null;
  let defaultBranch: string | null = null;
  let githubRepository: string | null = null;
  let githubDefaultBranch: string | null = null;
  let githubAuthenticated: boolean | null = null;

  const git = dependencies[0];
  if (git.status === "available") {
    try {
      const root = await runner.run(
        gitExecutable,
        ["rev-parse", "--show-toplevel"],
        repositoryPath,
      );
      if (root.exitCode !== 0 || path.resolve(root.stdout.trim()) !== repositoryPath) {
        errors.push(`Not a Git checkout root: ${repositoryPath}`);
      } else {
        const remote = await runner.run(
          gitExecutable,
          ["remote", "get-url", "origin"],
          repositoryPath,
        );
        if (remote.exitCode === 0) {
          repository = normalizeRepository(remote.stdout);
          if (repository === null) errors.push("The origin remote is not a GitHub repository URL");
        } else {
          errors.push("The Git checkout has no readable origin remote");
        }
        const branch = await runner.run(
          gitExecutable,
          ["symbolic-ref", "--short", "refs/remotes/origin/HEAD"],
          repositoryPath,
        );
        if (branch.exitCode === 0 && branch.stdout.trim()) {
          defaultBranch = branch.stdout.trim().replace(/^origin\//, "");
        }
      }
    } catch {
      errors.push(`Unable to inspect the Git checkout: ${repositoryPath}`);
    }
  } else {
    errors.push(`Git is ${git.status}; ${git.nextAction ?? "install Git and retry"}`);
  }

  const gh = dependencies[1];
  if (gh.status === "available" && repository !== null) {
    try {
      const auth = await runner.run(githubExecutable, ["auth", "status"], repositoryPath);
      githubAuthenticated = auth.exitCode === 0;
      if (!githubAuthenticated) {
        warnings.push("GitHub authentication is not available; run gh auth login");
        errors.push("GitHub authentication failed; run gh auth login and retry");
      }
      const view = await runner.run(
        githubExecutable,
        ["repo", "view", repository, "--json", "nameWithOwner,defaultBranchRef"],
        repositoryPath,
      );
      if (view.exitCode === 0) {
        const parsed = parseGhRepository(view.stdout);
        if (parsed === null) {
          errors.push("GitHub returned an invalid repository response");
        } else {
          githubRepository = parsed.repository.toLowerCase();
          githubDefaultBranch = parsed.defaultBranch;
          if (githubRepository !== repository.toLowerCase()) {
            errors.push(
              `Git remote '${repository}' does not match GitHub repository '${parsed.repository}'`,
            );
          }
          if (defaultBranch === null) defaultBranch = githubDefaultBranch;
        }
      } else {
        errors.push(`Unable to inspect GitHub repository ${repository}; verify gh auth status`);
      }
    } catch {
      errors.push(`Unable to inspect GitHub repository ${repository}; verify gh auth status`);
    }
  } else if (repository !== null && gh.status !== "available") {
    errors.push(`GitHub CLI is ${gh.status}; ${gh.nextAction ?? "install gh and retry"}`);
  }

  if (defaultBranch === null && repository !== null) {
    warnings.push("Default branch could not be determined; fetch origin and retry");
  }
  const runnable =
    errors.length === 0 && dependencies.every((dependency) => dependency.status === "available");
  return {
    repositoryPath,
    repository,
    defaultBranch,
    githubRepository,
    githubDefaultBranch,
    githubAuthenticated,
    dependencies,
    warnings,
    errors,
    runnable,
  };
}
