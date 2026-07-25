import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { PassThrough, Readable, Writable } from "node:stream";
import * as acp from "@agentclientprotocol/sdk";
import type { ChildProcess } from "node:child_process";
import { diagnoseDevinCapabilities } from "./diagnose.js";
import { gitChangedFiles } from "./git.js";
import { CONFIG_SOURCE_ORDER } from "./isolation.js";
import { assessMcpPolicy, classifyMcpDiagnostics } from "./mcp.js";
import { normalizeSessionUpdate, pathsFromToolCall } from "./normalize.js";
import { redactText } from "./redaction.js";
import { assertSafeFilePath, assertSafeReadPath, isForbiddenTool } from "./safety.js";
import { spawnProcess, terminateProcess, waitForExit } from "./process.js";
import type { AgentEvent, ProbeOptions, ProbeResult } from "./types.js";
import { diffSnapshots, snapshotDirectory } from "./workspace.js";

const SDK_VERSION = "1.3.0";

function jsonLine(value: unknown): string {
  return `${JSON.stringify(value)}\n`;
}

async function writeJson(filePath: string, value: unknown): Promise<void> {
  await fs.writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

async function wait(ms: number): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, ms));
}

function permissionDecision(params: acp.RequestPermissionRequest, cwd: string, allowedWritePaths: string[]): "allow" | "deny" {
  const title = params.toolCall.title ?? "";
  const name = params.toolCall.name;
  if (isForbiddenTool(title, name)) {
    return "deny";
  }
  const locations = params.toolCall.locations ?? [];
  if (params.toolCall.kind !== "edit" || locations.length === 0) {
    return "deny";
  }
  const safe = locations.every((location) => {
    try {
      const relative = path.relative(path.resolve(cwd), path.resolve(location.path)).split(path.sep).join("/");
      return allowedWritePaths.includes(relative);
    } catch {
      return false;
    }
  });
  return safe ? "allow" : "deny";
}

function makePermissionResponse(params: acp.RequestPermissionRequest, decision: "allow" | "deny"): acp.RequestPermissionResponse {
  if (decision === "allow" && params.options[0]) {
    return { outcome: { outcome: "selected", optionId: params.options[0].optionId } };
  }
  return { outcome: { outcome: "cancelled" } };
}

async function closeProcess(child: ChildProcess, graceMs: number): Promise<{ code: number | null; signal: NodeJS.Signals | null }> {
  if (child.stdin) {
    child.stdin.end();
  }
  const exit = await Promise.race([
    waitForExit(child),
    wait(graceMs).then(() => null)
  ]);
  return exit ?? terminateProcess(child, graceMs);
}

export async function runProbe(options: ProbeOptions): Promise<ProbeResult> {
  const startedAt = new Date();
  await fs.mkdir(options.artifactDir, { recursive: true });
  const eventsPath = path.join(options.artifactDir, "events.jsonl");
  const normalizedEventsPath = path.join(options.artifactDir, "normalized-events.jsonl");
  const stderrPath = path.join(options.artifactDir, "stderr.log");
  const sessionPath = path.join(options.artifactDir, "session.json");
  const resultPath = path.join(options.artifactDir, "result.json");
  const outsideBefore = await Promise.all(options.outsideRoots.map(snapshotDirectory));
  const rawOutput: Buffer[] = [];
  const rawError: Buffer[] = [];
  const normalized: AgentEvent[] = [];
  const permissionRequests: ProbeResult["permissionRequests"] = [];
  let child: ChildProcess | undefined;
  let sessionId: string | undefined;
  let protocolVersion: number | undefined;
  let agentInfo: acp.Implementation | null | undefined;
  let stopReason: string | undefined;
  let status: ProbeResult["status"] = "failed";
  let timedOut = false;
  let cancelled = false;
  let error: string | undefined;
  let exitCode: number | null = null;
  let signal: NodeJS.Signals | null = null;
  let residualProcesses = false;
  const mcpPolicy = options.mcpPolicy ?? "deny-all";
  const allowedMcpNames = options.allowedMcpNames ?? [];
  const mcpObservations = [] as ReturnType<typeof classifyMcpDiagnostics>;
  let unexpectedMcp = false;
  let mcpAction: "none" | "blocked-and-terminated" = "none";
  let cancelConnection: (() => Promise<unknown>) | undefined;
  let rejectSecurity: ((reason?: unknown) => void) | undefined;
  const securityPromise = new Promise<never>((_, reject) => {
    rejectSecurity = reject;
  });
  securityPromise.catch(() => undefined);
  let promptPromise: Promise<acp.PromptResponse> | undefined;
  let controlTimer: NodeJS.Timeout | undefined;

  try {
    child = spawnProcess(options.executable, options.args, options.cwd, options.env);
    if (!child.stdin || !child.stdout || !child.stderr) {
      throw new Error("failed to create piped Devin ACP process");
    }
    child.stdout.on("data", (chunk: Buffer) => rawOutput.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => {
      rawError.push(chunk);
      const observations = classifyMcpDiagnostics(chunk.toString("utf8"));
      mcpObservations.push(...observations);
      const assessment = assessMcpPolicy(mcpPolicy, allowedMcpNames, mcpObservations);
      if (assessment.unexpected.length > 0) {
        unexpectedMcp = true;
        mcpAction = "blocked-and-terminated";
        void cancelConnection?.().catch(() => undefined);
        rejectSecurity?.(new Error("unexpected MCP connection detected"));
      }
    });
    const stdoutTee = new PassThrough();
    child.stdout.pipe(stdoutTee);

    const client: acp.Client = {
      requestPermission: async (params) => {
        const decision = permissionDecision(params, options.cwd, options.allowedWritePaths);
        const requestId = params.toolCall.toolCallId;
        const summary = params.toolCall.title ?? params.toolCall.name ?? "unknown tool";
        permissionRequests.push({ requestId, summary: redactText(summary), decision });
        if (sessionId) {
          normalized.push({ type: "approval.required", sessionId, requestId, summary: redactText(summary), decision });
        }
        return makePermissionResponse(params, decision);
      },
      sessionUpdate: async (notification) => {
        normalized.push(...normalizeSessionUpdate(notification));
        if (sessionId) {
          for (const changedPath of pathsFromToolCall(notification.update)) {
            normalized.push({ type: "file.changed", sessionId, path: changedPath });
          }
        }
      },
      readTextFile: async (params) => {
        const filePath = assertSafeReadPath(options.cwd, params.path);
        return { content: await fs.readFile(filePath, "utf8") };
      },
      writeTextFile: async (params) => {
        const filePath = assertSafeFilePath(options.cwd, params.path, options.allowedWritePaths);
        await fs.writeFile(filePath, params.content, "utf8");
        if (sessionId) {
          normalized.push({ type: "file.changed", sessionId, path: filePath });
        }
        return {};
      }
    };

    const connection = new acp.ClientSideConnection(
      () => client,
      acp.ndJsonStream(
        Writable.toWeb(child.stdin),
        Readable.toWeb(stdoutTee) as unknown as ReadableStream<Uint8Array>
      )
    );
    cancelConnection = () => connection.cancel({ sessionId: sessionId ?? "unknown" });
    const initializeResponse = await connection.initialize({
      protocolVersion: acp.PROTOCOL_VERSION,
      clientCapabilities: { fs: { readTextFile: true, writeTextFile: true } },
      clientInfo: { name: "meguribi-devin-acp-poc", version: "0.1.0" }
    });
    protocolVersion = initializeResponse.protocolVersion;
    agentInfo = initializeResponse.agentInfo ?? null;
    const sessionResponse = await connection.newSession({ cwd: options.cwd, mcpServers: [] });
    sessionId = sessionResponse.sessionId;
    normalized.push({ type: "session.started", sessionId });
    await wait(options.mcpStartupGraceMs ?? 100);
    if (unexpectedMcp) {
      throw new Error("unexpected MCP connection detected before prompt");
    }
    await writeJson(sessionPath, {
      protocolVersion,
      agentInfo,
      sessionId,
      cwd: options.cwd
    });

    promptPromise = connection.prompt({
      sessionId,
      prompt: [{ type: "text", text: options.prompt }]
    });
    const controlKind = options.cancelAfterMs === undefined ? "timeout" : "cancelled";
    const controlPromise = new Promise<never>((_, reject) => {
      const delay = options.cancelAfterMs ?? options.timeoutMs;
      controlTimer = setTimeout(() => {
        if (sessionId) {
          void connection.cancel({ sessionId }).catch(() => undefined);
        }
        reject(new Error(controlKind === "timeout" ? "ACP prompt timed out" : "ACP prompt cancelled"));
      }, delay);
    });
    const promptResult = await Promise.race([promptPromise, controlPromise, securityPromise]);
    if (controlTimer) {
      clearTimeout(controlTimer);
    }
    stopReason = promptResult.stopReason;
    normalized.push({ type: "turn.completed", sessionId, stopReason });
    status = stopReason === "cancelled" ? "cancelled" : "completed";
    cancelled = stopReason === "cancelled";
    promptPromise.catch(() => undefined);
  } catch (caught) {
    error = caught instanceof Error ? caught.message : String(caught);
    if (error === "ACP prompt timed out") {
      status = "timed_out";
      timedOut = true;
    } else if (error === "ACP prompt cancelled") {
      status = "cancelled";
      cancelled = true;
    } else {
      status = "failed";
    }
    normalized.push({ type: "session.failed", message: redactText(error) });
    promptPromise?.catch(() => undefined);
  } finally {
    if (controlTimer) {
      clearTimeout(controlTimer);
    }
    if (child) {
      const exit = await closeProcess(child, options.shutdownGraceMs ?? 5_000);
      exitCode = exit.code;
      signal = exit.signal;
      residualProcesses = child.exitCode === null && child.signalCode === null;
    }
  }

  const outsideAfter = await Promise.all(options.outsideRoots.map(snapshotDirectory));
  const outsideChanges = outsideBefore.flatMap((before, index) => diffSnapshots(before, outsideAfter[index] ?? {}));
  const changedFiles = await gitChangedFiles(options.cwd).catch(() => []);
  const finishedAt = new Date();
  if (((exitCode !== null && exitCode !== 0) || signal !== null) && status === "completed") {
    status = "failed";
    error = error ?? `Devin ACP exited unexpectedly (code=${exitCode}, signal=${signal})`;
  }
  const mcpAssessment = assessMcpPolicy(mcpPolicy, allowedMcpNames, mcpObservations);
  const diagnosis = diagnoseDevinCapabilities({
    cliVersion: options.cliVersion,
    rootHelp: options.rootHelp ?? "",
    acpHelp: options.acpHelp ?? "",
    isolation: options.isolationStatus ?? "unknown",
    authentication: options.authenticationStatus ?? "unknown",
    unexpectedMcp,
    residualProcesses
  });
  const result: ProbeResult = {
    schemaVersion: 1,
    artifactType: "devin-acp-probe",
    command: { executable: options.executable, args: options.args },
    cliVersion: options.cliVersion,
    cwd: options.cwd,
    nodeVersion: process.version,
    platform: os.platform(),
    architecture: os.arch(),
    sdkVersion: SDK_VERSION,
    status,
    ...(protocolVersion === undefined ? {} : { protocolVersion }),
    ...(agentInfo === undefined ? {} : { agentInfo }),
    ...(sessionId === undefined ? {} : { sessionId }),
    ...(stopReason === undefined ? {} : { stopReason }),
    exitCode,
    signal,
    timedOut,
    cancelled,
    startedAt: startedAt.toISOString(),
    finishedAt: finishedAt.toISOString(),
    durationMs: finishedAt.getTime() - startedAt.getTime(),
    changedFiles,
    outsideChanges,
    permissionRequests,
    mcp: {
      policy: mcpPolicy,
      allowedNames: allowedMcpNames,
      observations: mcpObservations,
      unexpected: mcpAssessment.unexpected,
      action: mcpAction,
      configSources: options.configSources ?? [],
      sourceOrder: CONFIG_SOURCE_ORDER
    },
    diagnosis,
    residualProcesses,
    ...(error === undefined ? {} : { error: redactText(error) }),
    artifacts: {
      events: eventsPath,
      normalizedEvents: normalizedEventsPath,
      stderr: stderrPath,
      session: sessionPath,
      result: resultPath
    }
  };
  await fs.writeFile(eventsPath, redactText(Buffer.concat(rawOutput).toString("utf8")), "utf8");
  await fs.writeFile(normalizedEventsPath, normalized.map((event) => jsonLine(event)).join(""), "utf8");
  await fs.writeFile(stderrPath, redactText(Buffer.concat(rawError).toString("utf8")), "utf8");
  await writeJson(resultPath, result);
  return result;
}
