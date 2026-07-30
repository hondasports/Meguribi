import fs from "node:fs/promises";
import {
  discoverProblems,
  type DiscoverDependencies,
  type DiscoveryObservation,
  type DiscoveryArtifact,
} from "@meguribi/core";
import { parseRepositoryTarget } from "../target.js";

export interface DiscoverCommandOptions {
  json?: boolean;
  local?: boolean;
  repoPath?: string;
  input?: string;
  since?: string;
  label?: string;
  limit?: number;
}

export interface DiscoverCommandDependencies {
  discover?: DiscoverDependencies;
  discoverProblems?: typeof discoverProblems;
  createDiscoverDependencies?: (options: {
    cwd: string;
    repositoryPath: string;
    repository: string;
    localOnly: boolean;
  }) => Promise<DiscoverDependencies>;
  cwd?: string;
  stdout?: (text: string) => void;
}

export async function runDiscoverCommand(
  target: string,
  options: DiscoverCommandOptions = {},
  deps: DiscoverCommandDependencies = {},
): Promise<{ exitCode: number; result?: { artifact: DiscoveryArtifact; artifactPath: string } }> {
  const parsed = parseRepositoryTarget(target);
  const cwd = deps.cwd ?? process.cwd();
  const repositoryPath = options.repoPath ?? cwd;
  const observations = options.input ? await readObservations(options.input, cwd) : [];
  const discoveryDependencies = deps.discover ?? await (
    deps.createDiscoverDependencies ?? (async (wiringOptions) => {
      const wiring = await import("../wiring/create-delivery-deps.js");
      return wiring.createDiscoverDependencies(wiringOptions);
    })
  )({
    cwd,
    repositoryPath,
    repository: parsed.repository,
    localOnly: options.local === true,
  });
  const result = await (deps.discoverProblems ?? discoverProblems)({
    repository: parsed.repository,
    since: options.since,
    label: options.label,
    limit: options.limit,
    fileObservations: observations,
  }, discoveryDependencies);
  const writeOut = deps.stdout ?? ((text: string) => process.stdout.write(text));
  writeOut(options.json ? `${JSON.stringify(result, null, 2)}\n` : formatHuman(result));
  return { exitCode: 0, result };
}

async function readObservations(inputPath: string, cwd: string): Promise<DiscoveryObservation[]> {
  const resolved = pathFrom(cwd, inputPath);
  const contents = await fs.readFile(resolved, "utf8");
  if (resolved.toLowerCase().endsWith(".json")) return parseJsonObservations(contents, resolved);
  return contents
    .split(/\r?\n/)
    .map((line) => line.replace(/^\s*(?:[-*+]\s+|\d+[.)]\s+)/, "").trim())
    .filter((line) => line.length > 0 && !line.startsWith("#"))
    .map((statement, index) => ({
      id: `file:${resolved}:${String(index + 1)}`,
      statement,
      source: `file:${resolved}:${String(index + 1)}`,
      confidence: "unknown" as const,
    }));
}

function parseJsonObservations(contents: string, sourcePath: string): DiscoveryObservation[] {
  let value: unknown;
  try {
    value = JSON.parse(contents);
  } catch {
    throw new Error(`Invalid discovery input JSON: ${sourcePath}`);
  }
  const entries = Array.isArray(value) ? value : value && typeof value === "object" && Array.isArray((value as { observations?: unknown }).observations)
    ? (value as { observations: unknown[] }).observations
    : null;
  if (!entries) throw new Error(`Discovery input JSON must be an array or an object with observations: ${sourcePath}`);
  return entries.map((entry, index) => {
    if (!entry || typeof entry !== "object") throw new Error(`Discovery observation ${String(index + 1)} is not an object: ${sourcePath}`);
    const item = entry as Partial<DiscoveryObservation>;
    if (typeof item.statement !== "string" || item.statement.trim().length === 0) throw new Error(`Discovery observation ${String(index + 1)} requires statement: ${sourcePath}`);
    const confidence = item.confidence ?? "unknown";
    if (confidence !== "confirmed" && confidence !== "reported" && confidence !== "unknown") throw new Error(`Invalid observation confidence at ${String(index + 1)}: ${sourcePath}`);
    return {
      id: typeof item.id === "string" && item.id.length > 0 ? item.id : `file:${sourcePath}:${String(index + 1)}`,
      statement: item.statement.trim(),
      source: typeof item.source === "string" && item.source.length > 0 ? item.source : `file:${sourcePath}`,
      confidence,
      ...(typeof item.observedAt === "string" ? { observedAt: item.observedAt } : {}),
    };
  });
}

function pathFrom(cwd: string, inputPath: string): string {
  if (inputPath.includes("\0")) throw new Error("Discovery input path contains a null byte");
  return inputPath.match(/^(?:[A-Za-z]:[\\/]|[\\/]{1,2})/) ? inputPath : `${cwd.replace(/[\\/]$/, "")}/${inputPath}`;
}

function formatHuman(result: { artifact: DiscoveryArtifact; artifactPath: string }): string {
  return [
    `Discovery: ${String(result.artifact.problemCandidates.length)} problem candidate(s)`,
    `Observations: ${String(result.artifact.observations.length)}`,
    `Artifact: ${result.artifactPath}`,
    ...result.artifact.problemCandidates.map((candidate) => `${String(candidate.ranking.rank)}. ${candidate.statement}`),
    "",
  ].join("\n");
}
