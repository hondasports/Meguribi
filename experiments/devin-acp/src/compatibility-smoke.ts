import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import readline from "node:readline/promises";
import {
  createDevinAcpAdapter,
  diagnoseDevin,
  MINIMUM_SUPPORTED_DEVIN_CLI_VERSION,
  redactJsonValue,
} from "@meguribi/adapters";
import type {
  DevinDiagnosis,
  ImplementationContext,
  ImplementationResult,
  InheritedMcpPolicy,
} from "@meguribi/core";
import { createFixture, snapshotDirectory, diffSnapshots, type Fixture } from "./workspace.js";
import { buildIsolatedEnvironment } from "./isolation.js";
import type { OutsideSnapshot } from "./types.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_FAKE_ACP_SERVER_SCRIPT = path.resolve(
  __dirname,
  "../../../packages/adapters/src/devin/fixtures/fake-acp-server.js",
);
const DEFAULT_ARTIFACT_ROOT = path.resolve(__dirname, "../../../artifacts/devin-acp");

export interface DevinCompatibilitySmokeResult {
  schemaVersion: 1;
  artifactType: "devin-acp-compatibility-smoke";
  optIn: boolean;
  cliVersion: string;
  minimumSupportedVersion: string;
  acpCompatible: boolean;
  sessionStarted: boolean;
  promptCompleted: boolean;
  worktreeBoundaryOk: boolean;
  shutdownCompleted: boolean;
  status: "completed" | "blocked" | "failed";
  stopReason?: string;
  warnings: string[];
  error?: string;
  changedFiles: string[];
  outsideChanges: string[];
  residualProcesses: boolean;
  artifactDirectory: string;
  executedAt: string;
  implementation: ImplementationResult | null;
}

export interface CompatibilitySmokeOptions {
  artifactDirectory?: string;
  executable?: string;
  executableArgs?: string[];
  acpArgs?: string[];
  env?: NodeJS.ProcessEnv;
  fake?: boolean;
  fakeScript?: string;
  fakeMode?: string;
  timeoutMs?: number;
  optIn?: boolean;
  diagnosis?: DevinDiagnosis;
  isolated?: boolean;
  inheritedMcpPolicy?: InheritedMcpPolicy;
}

function timestamp(): string {
  return new Date().toISOString().replace(/[:.]/g, "-");
}

function fixtureContext(fixture: Fixture): ImplementationContext {
  return {
    issue: {
      source: "devin-acp-compatibility-smoke",
      content: "Add one verification line to README.md in the temporary fixture.",
    },
    comments: [],
    acceptanceCriteria: ["README.md contains the verification line"],
    plan: {
      summary: "Run the ACP compatibility smoke against a temporary fixture.",
      steps: ["Edit README.md only", "Do not use GitHub, Git, network, or secrets"],
    },
    repositoryRules: "The fixture is disposable. Do not commit, push, create a PR, or update an Issue.",
    primarySkill: "devin-integration",
    verificationCommands: [],
    protectedPaths: [".env", ".env.*", "**/*secret*"],
    worktreePath: fixture.worktree,
    allowedPaths: ["README.md"],
    limits: { maxPromptChars: 12_000, maxChangedFiles: 1, maxDiffLines: 20 },
    expectedResult: ["Report the ACP stop reason and the changed README.md file."],
  };
}

function fakeDiagnosis(
  executable: string,
  inheritedMcpPolicy: InheritedMcpPolicy = "allow",
): DevinDiagnosis {
  return {
    executable: { status: "ok", path: executable },
    version: { status: "supported", raw: "3000.0.0-fake" },
    authentication: { status: "authenticated" },
    acp: { status: "supported" },
    inheritedMcpPolicy,
    runnable: true,
    warnings: [],
    errors: [],
  };
}

function deriveVersionWarnings(diagnosis: DevinDiagnosis): string[] {
  if (diagnosis.version.status === "unknown") {
    return [
      `Devin CLI version could not be parsed; it may be untested against the minimum supported version ${MINIMUM_SUPPORTED_DEVIN_CLI_VERSION}.`,
    ];
  }
  if (diagnosis.version.status === "unsupported") {
    return [
      `Devin CLI version ${diagnosis.version.raw ?? "unknown"} is below the minimum supported version ${MINIMUM_SUPPORTED_DEVIN_CLI_VERSION}.`,
    ];
  }
  return [];
}

function resultFromImplementation(
  result: ImplementationResult,
  options: {
    optIn: boolean;
    cliVersion: string;
    artifactDirectory: string;
    outsideChanges: string[];
    executedAt: string;
    minimumSupportedVersion: string;
    diagnosis: DevinDiagnosis;
  },
): DevinCompatibilitySmokeResult {
  const sessionStarted = result.sessionId !== "none";
  const promptCompleted = result.status === "completed" && result.stopReason !== undefined;
  const shutdownCompleted =
    result.termination?.stdinClosed === true &&
    result.termination.residualProcesses === 0 &&
    result.termination.cleanupError === undefined;
  const worktreeBoundaryOk =
    result.publishable &&
    result.changedFiles.every((file: string) => file === "README.md") &&
    options.outsideChanges.length === 0;
  const acpCompatible = sessionStarted && promptCompleted && shutdownCompleted && worktreeBoundaryOk;
  const status = acpCompatible
    ? "completed"
    : !worktreeBoundaryOk || result.status === "blocked"
      ? "blocked"
      : "failed";
  const warnings = [
    ...(result.mcpPolicyResult?.reason ? [result.mcpPolicyResult.reason] : []),
    ...(result.secondaryError ? [result.secondaryError.message] : []),
    ...(result.unresolvedItems ?? []),
    ...deriveVersionWarnings(options.diagnosis),
  ];
  return {
    schemaVersion: 1,
    artifactType: "devin-acp-compatibility-smoke",
    optIn: options.optIn,
    cliVersion: options.cliVersion,
    minimumSupportedVersion: options.minimumSupportedVersion,
    acpCompatible,
    sessionStarted,
    promptCompleted,
    worktreeBoundaryOk,
    shutdownCompleted,
    status,
    ...(result.stopReason ? { stopReason: result.stopReason } : {}),
    warnings,
    ...(result.error ? { error: result.error.message } : {}),
    changedFiles: [...result.changedFiles],
    outsideChanges: options.outsideChanges,
    residualProcesses: (result.termination?.residualProcesses ?? 1) > 0,
    artifactDirectory: options.artifactDirectory,
    executedAt: options.executedAt,
    implementation: result,
  };
}

function buildBaseResult(
  overrides: Partial<DevinCompatibilitySmokeResult> &
    Pick<
      DevinCompatibilitySmokeResult,
      "status" | "optIn" | "cliVersion" | "artifactDirectory" | "executedAt" | "minimumSupportedVersion"
    >,
): DevinCompatibilitySmokeResult {
  return {
    schemaVersion: 1,
    artifactType: "devin-acp-compatibility-smoke",
    acpCompatible: false,
    sessionStarted: false,
    promptCompleted: false,
    worktreeBoundaryOk: false,
    shutdownCompleted: false,
    stopReason: undefined,
    warnings: [],
    error: undefined,
    changedFiles: [],
    outsideChanges: [],
    residualProcesses: false,
    implementation: null,
    ...overrides,
  };
}

function buildBlockedResultFromDiagnosis(
  optIn: boolean,
  cliVersion: string,
  artifactDirectory: string,
  executedAt: string,
  minimumSupportedVersion: string,
  diagnosis: DevinDiagnosis,
): DevinCompatibilitySmokeResult {
  return buildBaseResult({
    status: "blocked",
    optIn,
    cliVersion,
    minimumSupportedVersion,
    artifactDirectory,
    executedAt,
    warnings: [
      ...diagnosis.warnings.map((warning) => warning.message),
      ...deriveVersionWarnings(diagnosis),
    ],
    error: diagnosis.errors[0]?.message ?? "Devin CLI is not runnable",
  });
}

function buildFailedResult(
  optIn: boolean,
  cliVersion: string,
  artifactDirectory: string,
  executedAt: string,
  minimumSupportedVersion: string,
  outsideChanges: string[],
  implementation: ImplementationResult | null,
  error: unknown,
  diagnosis?: DevinDiagnosis,
): DevinCompatibilitySmokeResult {
  const sessionStarted =
    implementation?.sessionId !== undefined && implementation.sessionId !== "none";
  const shutdownCompleted =
    implementation?.termination?.stdinClosed === true &&
    implementation.termination.residualProcesses === 0;
  return buildBaseResult({
    status: "failed",
    optIn,
    cliVersion,
    minimumSupportedVersion,
    artifactDirectory,
    executedAt,
    sessionStarted,
    promptCompleted: false,
    shutdownCompleted,
    worktreeBoundaryOk: outsideChanges.length === 0,
    outsideChanges,
    residualProcesses: (implementation?.termination?.residualProcesses ?? 1) > 0,
    implementation,
    warnings: diagnosis
      ? [...diagnosis.warnings.map((warning) => warning.message), ...deriveVersionWarnings(diagnosis)]
      : [],
    error: error instanceof Error ? error.message : String(error),
  });
}

async function writeResult(
  directory: string,
  result: DevinCompatibilitySmokeResult,
): Promise<void> {
  const redacted = redactJsonValue(result) as DevinCompatibilitySmokeResult;
  await fs.writeFile(
    path.join(directory, "compatibility-result.json"),
    `${JSON.stringify(redacted, null, 2)}\n`,
    "utf8",
  );
}

export async function runCompatibilitySmoke(
  options: CompatibilitySmokeOptions = {},
): Promise<DevinCompatibilitySmokeResult> {
  const executedAt = new Date().toISOString();
  const minimumSupportedVersion = MINIMUM_SUPPORTED_DEVIN_CLI_VERSION;
  const optIn = options.optIn ?? process.env.MEGURIBI_RUN_REAL_DEVIN_SMOKE === "1";
  const artifactDirectory =
    options.artifactDirectory ?? path.resolve(DEFAULT_ARTIFACT_ROOT, timestamp());
  await fs.mkdir(artifactDirectory, { recursive: true });

  if (!optIn && !options.fake) {
    const result = buildBaseResult({
      status: "blocked",
      optIn: false,
      cliVersion: "not-started",
      minimumSupportedVersion,
      artifactDirectory,
      executedAt,
      warnings: [
        "Real Devin smoke requires MEGURIBI_RUN_REAL_DEVIN_SMOKE=1; no external agent was started.",
      ],
    });
    await writeResult(artifactDirectory, result);
    return result;
  }

  const isolated = options.isolated ?? options.fake ?? false;
  const isolation = isolated
    ? buildIsolatedEnvironment(path.join(artifactDirectory, "isolated-env"))
    : undefined;
  const executable = options.executable ?? (options.fake ? process.execPath : "devin");
  const executableArgs = options.executableArgs?.length
    ? options.executableArgs
    : options.fake
      ? [options.fakeScript ?? DEFAULT_FAKE_ACP_SERVER_SCRIPT]
      : [];
  const acpArgs = options.fake ? options.acpArgs ?? [] : options.acpArgs ?? ["acp"];
  let environment: NodeJS.ProcessEnv | undefined = isolated
    ? { ...isolation?.env, ...(options.env ?? {}) }
    : options.env
      ? { ...options.env }
      : undefined;
  if (options.fake) {
    (environment ??= {})["FAKE_ACP_MODE"] = options.fakeMode ?? "write-in-scope";
  }
  const inheritedMcpPolicy = options.inheritedMcpPolicy ?? (options.fake ? "allow" : "deny");

  let fixture: Fixture | undefined;
  let outsideBefore: OutsideSnapshot = {};
  let outsideFixtureBefore: OutsideSnapshot = {};
  let implementation: ImplementationResult | null = null;
  let cliVersion = "unknown";
  let diagnosis: DevinDiagnosis | undefined;

  try {
    fixture = await createFixture(path.join(artifactDirectory, "fixture-"));
    if (options.fake && (options.fakeMode === "write-outside" || options.fakeMode === "symlink-escape")) {
      (environment ??= {})["MEGURIBI_FAKE_OUTSIDE_PATH"] = path.join(fixture.outside, "fake-outside.txt");
    }
    outsideBefore = await snapshotDirectory(fixture.normalCheckout);
    outsideFixtureBefore = await snapshotDirectory(fixture.outside);

    if (options.fake) {
      cliVersion = "3000.0.0-fake";
      diagnosis = fakeDiagnosis(executable, inheritedMcpPolicy);
    } else {
      diagnosis =
        options.diagnosis ??
        (await diagnoseDevin({
          executable,
          executableArgs,
          inheritedMcpPolicy,
          nonInteractive: true,
          cwd: fixture.worktree,
          env: environment,
          probeTimeoutMs: 10_000,
          minimumSupportedVersion,
        }));
      cliVersion = diagnosis.version.raw ?? "unknown";
      if (!diagnosis.runnable) {
        const result = buildBlockedResultFromDiagnosis(
          optIn,
          cliVersion,
          artifactDirectory,
          executedAt,
          minimumSupportedVersion,
          diagnosis,
        );
        await writeResult(artifactDirectory, result);
        return result;
      }
    }

    const adapter = createDevinAcpAdapter({
      executable,
      executableArgs,
      acpArgs,
      diagnosis: diagnosis ?? fakeDiagnosis(executable, inheritedMcpPolicy),
      inheritedMcpPolicy,
      mode: "non-interactive",
      explicitAllowInheritedMcp: true,
      startupTimeoutMs: 10_000,
      promptTimeoutMs: options.timeoutMs ?? 120_000,
      postTurnLivenessMs: 50,
      env: environment,
      allowedCommands: [],
    });
    implementation = await adapter.implement({
      context: fixtureContext(fixture),
      artifactRoot: artifactDirectory,
      gitBoundary: {
        expectedRemoteIdentity: "",
        expectedBaseSha: "",
        expectedBranch: "issue-3-fixture",
        outsidePaths: [fixture.normalCheckout, fixture.outside],
        protectedPaths: [".env", ".env.*", "**/*secret*"],
        maxChangedFiles: 1,
        maxDiffLines: 20,
      },
    });
    const outsideAfter = await snapshotDirectory(fixture.normalCheckout);
    const outsideFixtureAfter = await snapshotDirectory(fixture.outside);
    const outsideChanges = [
      ...diffSnapshots(outsideBefore, outsideAfter),
      ...diffSnapshots(outsideFixtureBefore, outsideFixtureAfter),
    ];
    const result = resultFromImplementation(implementation, {
      optIn,
      cliVersion,
      artifactDirectory,
      outsideChanges,
      executedAt,
      minimumSupportedVersion,
      diagnosis: diagnosis ?? fakeDiagnosis(executable, inheritedMcpPolicy),
    });
    await writeResult(artifactDirectory, result);
    return result;
  } catch (error) {
    let outsideChanges: string[] = [];
    if (fixture) {
      try {
        const outsideAfter = await snapshotDirectory(fixture.normalCheckout);
        const outsideFixtureAfter = await snapshotDirectory(fixture.outside);
        outsideChanges = [
          ...diffSnapshots(outsideBefore, outsideAfter),
          ...diffSnapshots(outsideFixtureBefore, outsideFixtureAfter),
        ];
      } catch {
        // Best-effort: if snapshot fails the original error is still reported.
      }
    }
    const result = buildFailedResult(
      optIn,
      cliVersion,
      artifactDirectory,
      executedAt,
      minimumSupportedVersion,
      outsideChanges,
      implementation,
      error,
      diagnosis,
    );
    await writeResult(artifactDirectory, result);
    return result;
  } finally {
    await fixture?.cleanup();
  }
}

const REAL_SMOKE_WARNING = `WARNING: This command runs the real Devin CLI against a temporary fixture.
- It may incur billing and network usage.
- It inherits the current user environment, including any saved Devin credentials.
- MCP isolation is not mechanically guaranteed; inherited MCP is denied by policy, but the smoke cannot fully prevent Devin from trying.
`;

async function confirmRealSmoke(): Promise<boolean> {
  process.stderr.write(REAL_SMOKE_WARNING);
  if (!process.stdin.isTTY) {
    process.stderr.write("This command requires an interactive terminal or --yes.\n");
    return false;
  }
  const reader = readline.createInterface({
    input: process.stdin,
    output: process.stderr,
  });
  try {
    const answer = await reader.question("Continue? [y/N]: ");
    return answer.trim().toLowerCase() === "y";
  } finally {
    reader.close();
  }
}

export async function runCompatibilitySmokeCli(): Promise<void> {
  const fake = process.argv.includes("--fake");
  const yes = process.argv.includes("--yes");
  const optIn = process.env.MEGURIBI_RUN_REAL_DEVIN_SMOKE === "1";

  if (!fake && optIn) {
    process.stderr.write(REAL_SMOKE_WARNING);
    if (!yes) {
      const confirmed = await confirmRealSmoke();
      if (!confirmed) {
        process.stderr.write("Aborted. No external agent was started.\n");
        process.exitCode = 1;
        return;
      }
    }
  }

  const result = await runCompatibilitySmoke({
    fake,
    optIn: fake || optIn,
    fakeMode: process.env.MEGURIBI_FAKE_DEVIN_SCENARIO ?? "write-in-scope",
  });
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  if (!result.acpCompatible) {
    process.exitCode = 1;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
  await runCompatibilitySmokeCli();
}
