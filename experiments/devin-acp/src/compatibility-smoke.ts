import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createDevinAcpAdapter, diagnoseDevin, MINIMUM_SUPPORTED_DEVIN_CLI_VERSION } from "@meguribi/adapters";
import type { DevinDiagnosis, ImplementationContext, ImplementationResult } from "@meguribi/core";
import { createFixture, snapshotDirectory, diffSnapshots, type Fixture } from "./workspace.js";
import { buildIsolatedEnvironment } from "./isolation.js";

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

function fakeDiagnosis(executable: string): DevinDiagnosis {
  return {
    executable: { status: "ok", path: executable },
    version: { status: "supported", raw: "3000.0.0-fake" },
    authentication: { status: "authenticated" },
    acp: { status: "supported" },
    inheritedMcpPolicy: "allow",
    runnable: true,
    warnings: [],
    errors: [],
  };
}

function resultFromImplementation(
  result: ImplementationResult,
  options: { optIn: boolean; cliVersion: string; artifactDirectory: string; outsideChanges: string[] },
): DevinCompatibilitySmokeResult {
  const sessionStarted = result.sessionId !== "none";
  const promptCompleted = result.status === "completed" && result.stopReason !== undefined;
  const shutdownCompleted = result.termination?.stdinClosed === true && result.termination.residualProcesses === 0 && result.termination.cleanupError === undefined;
  const worktreeBoundaryOk = result.publishable && result.changedFiles.every((file: string) => file === "README.md") && options.outsideChanges.length === 0;
  const acpCompatible = sessionStarted && promptCompleted && shutdownCompleted && worktreeBoundaryOk;
  const warnings = [
    ...(result.mcpPolicyResult?.reason ? [result.mcpPolicyResult.reason] : []),
    ...(result.secondaryError ? [result.secondaryError.message] : []),
    ...(result.unresolvedItems ?? []),
  ];
  return {
    schemaVersion: 1,
    artifactType: "devin-acp-compatibility-smoke",
    optIn: options.optIn,
    cliVersion: options.cliVersion,
    acpCompatible,
    sessionStarted,
    promptCompleted,
    worktreeBoundaryOk,
    shutdownCompleted,
    status: acpCompatible ? "completed" : result.status === "blocked" ? "blocked" : "failed",
    ...(result.stopReason ? { stopReason: result.stopReason } : {}),
    warnings,
    ...(result.error ? { error: result.error.message } : {}),
    changedFiles: [...result.changedFiles],
    outsideChanges: options.outsideChanges,
    residualProcesses: (result.termination?.residualProcesses ?? 1) > 0,
    artifactDirectory: options.artifactDirectory,
    implementation: result,
  };
}

async function writeResult(directory: string, result: DevinCompatibilitySmokeResult): Promise<void> {
  await fs.writeFile(path.join(directory, "compatibility-result.json"), `${JSON.stringify(result, null, 2)}\n`, "utf8");
}

export async function runCompatibilitySmoke(options: CompatibilitySmokeOptions = {}): Promise<DevinCompatibilitySmokeResult> {
  const optIn = options.optIn ?? process.env.MEGURIBI_RUN_REAL_DEVIN_SMOKE === "1";
  const artifactDirectory = options.artifactDirectory ?? path.resolve(DEFAULT_ARTIFACT_ROOT, timestamp());
  await fs.mkdir(artifactDirectory, { recursive: true });
  if (!optIn && !options.fake) {
    const result: DevinCompatibilitySmokeResult = {
      schemaVersion: 1,
      artifactType: "devin-acp-compatibility-smoke",
      optIn: false,
      cliVersion: "not-started",
      acpCompatible: false,
      sessionStarted: false,
      promptCompleted: false,
      worktreeBoundaryOk: false,
      shutdownCompleted: false,
      status: "blocked",
      warnings: ["Real Devin smoke requires MEGURIBI_RUN_REAL_DEVIN_SMOKE=1; no external agent was started."],
      changedFiles: [],
      outsideChanges: [],
      residualProcesses: false,
      artifactDirectory,
      implementation: null,
    };
    await writeResult(artifactDirectory, result);
    return result;
  }

  const fixture = await createFixture(path.join(artifactDirectory, "fixture-"));
  const outsideBefore = await snapshotDirectory(fixture.normalCheckout);
  const outsideFixtureBefore = await snapshotDirectory(fixture.outside);
  const isolated = options.isolated ?? !options.fake;
  const isolation = isolated ? buildIsolatedEnvironment(path.join(artifactDirectory, "isolated-env")) : undefined;
  const executable = options.executable ?? (options.fake ? process.execPath : "devin");
  const executableArgs = options.executableArgs?.length
    ? options.executableArgs
    : options.fake
      ? [options.fakeScript ?? DEFAULT_FAKE_ACP_SERVER_SCRIPT]
      : [];
  const acpArgs = options.fake ? options.acpArgs ?? [] : options.acpArgs ?? ["acp"];
  const environment = {
    ...(isolation?.env ?? {}),
    ...(options.env ?? {}),
    ...(options.fake ? { FAKE_ACP_MODE: options.fakeMode ?? "write-in-scope" } : {}),
  };
  let implementation: ImplementationResult | null = null;
  let cliVersion = "unknown";
  try {
    if (options.fake) {
      cliVersion = "fake-3000.0.0";
    } else {
      const diagnosis = options.diagnosis ?? await diagnoseDevin({
        executable,
        executableArgs,
        inheritedMcpPolicy: "deny",
        nonInteractive: true,
        cwd: fixture.worktree,
        env: environment,
        probeTimeoutMs: 10_000,
        minimumSupportedVersion: MINIMUM_SUPPORTED_DEVIN_CLI_VERSION,
      });
      cliVersion = diagnosis.version.raw ?? "unknown";
      if (!diagnosis.runnable) {
        const result: DevinCompatibilitySmokeResult = {
          schemaVersion: 1,
          artifactType: "devin-acp-compatibility-smoke",
          optIn,
          cliVersion,
          acpCompatible: false,
          sessionStarted: false,
          promptCompleted: false,
          worktreeBoundaryOk: false,
          shutdownCompleted: false,
          status: "blocked",
          warnings: diagnosis.warnings.map((warning) => warning.message),
          error: diagnosis.errors[0]?.message ?? "Devin CLI is not runnable",
          changedFiles: [],
          outsideChanges: [],
          residualProcesses: false,
          artifactDirectory,
          implementation: null,
        };
        await writeResult(artifactDirectory, result);
        return result;
      }
      options.diagnosis = diagnosis;
    }

    const diagnosis = options.diagnosis ?? fakeDiagnosis(executable);
    const adapter = createDevinAcpAdapter({
      executable,
      executableArgs,
      acpArgs,
      diagnosis,
      inheritedMcpPolicy: options.fake ? "allow" : "deny",
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
    });
    await writeResult(artifactDirectory, result);
    return result;
  } catch (error) {
    const result: DevinCompatibilitySmokeResult = {
      schemaVersion: 1,
      artifactType: "devin-acp-compatibility-smoke",
      optIn,
      cliVersion,
      acpCompatible: false,
      sessionStarted: implementation?.sessionId !== undefined && implementation.sessionId !== "none",
      promptCompleted: false,
      worktreeBoundaryOk: false,
      shutdownCompleted: implementation?.termination?.stdinClosed === true && implementation.termination.residualProcesses === 0,
      status: "failed",
      warnings: [],
      error: error instanceof Error ? error.message : String(error),
      changedFiles: implementation ? [...implementation.changedFiles] : [],
      outsideChanges: [],
      residualProcesses: (implementation?.termination?.residualProcesses ?? 1) > 0,
      artifactDirectory,
      implementation,
    };
    await writeResult(artifactDirectory, result);
    return result;
  } finally {
    await fixture.cleanup();
  }
}

export async function runCompatibilitySmokeCli(): Promise<void> {
  const fake = process.argv.includes("--fake");
  const result = await runCompatibilitySmoke({
    fake,
    optIn: fake || process.env.MEGURIBI_RUN_REAL_DEVIN_SMOKE === "1",
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
