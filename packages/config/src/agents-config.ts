import {
  RoleAssignmentError,
  validateRoleAssignments,
  type AgentKind,
  type AgentProfile,
  type AgentTransport,
  type InheritedMcpPolicy,
  type RoleAssignments,
} from "@meguribi/core";
import * as v from "valibot";
import { executableSchema } from "./executable.js";

const MAX_TIMEOUT_MS = 2_147_483_647 - 1;
const MAX_TIMEOUT_MINUTES = Math.floor(MAX_TIMEOUT_MS / 60_000);
const PROFILE_ID_PATTERN = /^[a-z][a-z0-9-]{0,31}$/;

const positiveInteger = v.pipe(v.number(), v.integer(), v.minValue(1));
const msTimeout = v.pipe(positiveInteger, v.maxValue(MAX_TIMEOUT_MS));
const minutesTimeout = v.pipe(positiveInteger, v.maxValue(MAX_TIMEOUT_MINUTES));
const profileIdSchema = v.pipe(v.string(), v.regex(PROFILE_ID_PATTERN));

const AgentProfileConfigSchema = v.strictObject({
  kind: v.picklist(["claude-code", "codex", "devin", "cursor"]),
  transport: v.optional(v.picklist(["acp", "sdk"])),
  executable: executableSchema,
  startupTimeoutMs: v.optional(msTimeout),
  turnTimeoutMinutes: v.optional(minutesTimeout),
  inheritedMcpPolicy: v.optional(v.picklist(["warn", "allow", "deny"])),
});

const RolesConfigSchema = v.strictObject({
  discussants: v.optional(v.array(profileIdSchema)),
  summarizer: v.optional(profileIdSchema),
  specifier: v.optional(profileIdSchema),
  planner: v.optional(profileIdSchema),
  implementer: v.optional(profileIdSchema),
  reviewer: v.optional(profileIdSchema),
  allowSameImplementerReviewer: v.optional(v.boolean()),
});

type AgentProfileConfigInput = v.InferOutput<typeof AgentProfileConfigSchema>;
type RolesConfigInput = v.InferOutput<typeof RolesConfigSchema>;

export const BUILTIN_AGENT_PROFILES: readonly AgentProfile[] = [
  {
    id: "claude-code",
    kind: "claude-code",
    transport: "acp",
    executable: "claude-agent-acp",
    startupTimeoutMs: 10000,
    turnTimeoutMinutes: 45,
    inheritedMcpPolicy: "warn",
  },
  {
    id: "codex",
    kind: "codex",
    transport: "sdk",
    startupTimeoutMs: 10000,
    turnTimeoutMinutes: 45,
    inheritedMcpPolicy: "warn",
  },
  {
    id: "codex-acp",
    kind: "codex",
    transport: "acp",
    executable: "codex-acp",
    startupTimeoutMs: 10000,
    turnTimeoutMinutes: 45,
    inheritedMcpPolicy: "warn",
  },
  {
    id: "devin",
    kind: "devin",
    transport: "acp",
    startupTimeoutMs: 10000,
    turnTimeoutMinutes: 45,
    inheritedMcpPolicy: "warn",
  },
  {
    id: "cursor",
    kind: "cursor",
    transport: "acp",
    startupTimeoutMs: 10000,
    turnTimeoutMinutes: 45,
    inheritedMcpPolicy: "warn",
  },
];

export interface AgentsConfigResult {
  profiles: readonly AgentProfile[];
  roles: RoleAssignments;
  snapshot: Record<string, unknown>;
}

export interface AgentsConfigData {
  profiles: readonly AgentProfile[];
  roles: RoleAssignments;
}

export interface ResolveAgentsConfigInput {
  user?: unknown;
  repository?: unknown;
  environment?: NodeJS.ProcessEnv;
  cli?: unknown;
}

interface AgentsDocumentConfig {
  agents: Record<string, AgentProfileConfigInput>;
  roles: RolesConfigInput;
  legacyImplementer?: string;
}

export class ConflictingImplementerError extends Error {
  readonly code = "conflicting_implementer" as const;
  readonly nextAction: string;

  constructor(source: string, legacyImplementer: string, roleImplementer: string) {
    super(
      `Conflicting implementer settings in ${source}: implementer is ${legacyImplementer}, roles.implementer is ${roleImplementer}`,
    );
    this.name = "ConflictingImplementerError";
    this.nextAction =
      "Use either implementer or roles.implementer in the same configuration file, or make both values the same.";
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function formatIssuePath(issue: v.BaseIssue<unknown>): string {
  return issue.path?.map((item) => String(item.key)).join(".") ?? "";
}

function invalidProfileMessage(id: string, issues: v.BaseIssue<unknown>[]): string {
  const fields = issues
    .map((issue) => {
      const path = formatIssuePath(issue);
      return path.length > 0 ? `agents.${id}.${path}` : `agents.${id}`;
    })
    .join(", ");
  return `Invalid agents configuration: ${fields}`;
}

function validateAgentsSection(input: unknown): Record<string, AgentProfileConfigInput> {
  if (input === undefined) {
    return {};
  }
  if (!isRecord(input)) {
    throw new Error("Invalid agents configuration: agents");
  }

  const result: Record<string, AgentProfileConfigInput> = {};
  for (const [id, value] of Object.entries(input)) {
    if (!PROFILE_ID_PATTERN.test(id)) {
      throw new Error(`Invalid agents configuration: agents.${id}`);
    }
    const parsed = v.safeParse(AgentProfileConfigSchema, value);
    if (!parsed.success) {
      throw new Error(invalidProfileMessage(id, parsed.issues));
    }
    result[id] = parsed.output;
  }
  return result;
}

function validateRolesSection(input: unknown): RolesConfigInput {
  if (input === undefined) {
    return {};
  }
  if (!isRecord(input)) {
    throw new Error("Invalid roles configuration: roles");
  }
  const parsed = v.safeParse(RolesConfigSchema, input);
  if (!parsed.success) {
    const fields = parsed.issues
      .map((issue) => {
        const path = formatIssuePath(issue);
        return path.length > 0 ? `roles.${path}` : "roles";
      })
      .join(", ");
    throw new Error(`Invalid roles configuration: ${fields}`);
  }
  return parsed.output;
}

function validateLegacyImplementer(input: unknown, source: string): string | undefined {
  if (input === undefined) {
    return undefined;
  }
  if (typeof input !== "string" || !PROFILE_ID_PATTERN.test(input)) {
    throw new Error(`Invalid implementer configuration: ${source}.implementer`);
  }
  return input;
}

function extractAgentsDocument(document: unknown, source: string): AgentsDocumentConfig {
  if (document === null || document === undefined) {
    return { agents: {}, roles: {} };
  }
  if (!isRecord(document)) {
    throw new Error(`Invalid configuration document: ${source}`);
  }

  const agents = validateAgentsSection(document.agents);
  const roles = validateRolesSection(document.roles);
  const legacyImplementer = validateLegacyImplementer(document.implementer, source);

  if (
    legacyImplementer !== undefined &&
    roles.implementer !== undefined &&
    legacyImplementer !== roles.implementer
  ) {
    throw new ConflictingImplementerError(source, legacyImplementer, roles.implementer);
  }

  return {
    agents,
    roles,
    ...(legacyImplementer !== undefined ? { legacyImplementer } : {}),
  };
}

function normalizeExecutable(executable: AgentProfileConfigInput["executable"]): string | undefined {
  if (executable === undefined) {
    return undefined;
  }
  return Array.isArray(executable) ? executable[0] : executable;
}

function normalizeProfile(id: string, input: AgentProfileConfigInput): AgentProfile {
  const executable = normalizeExecutable(input.executable);
  return {
    id,
    kind: input.kind as AgentKind,
    transport: (input.transport ?? "acp") as AgentTransport,
    ...(executable !== undefined ? { executable } : {}),
    startupTimeoutMs: input.startupTimeoutMs ?? 10000,
    turnTimeoutMinutes: input.turnTimeoutMinutes ?? 45,
    inheritedMcpPolicy: (input.inheritedMcpPolicy ?? "warn") as InheritedMcpPolicy,
  };
}

function mergeProfiles(
  userAgents: Record<string, AgentProfileConfigInput>,
  repositoryAgents: Record<string, AgentProfileConfigInput>,
): readonly AgentProfile[] {
  const profiles = new Map<string, AgentProfile>(
    BUILTIN_AGENT_PROFILES.map((profile) => [profile.id, profile]),
  );
  for (const source of [userAgents, repositoryAgents]) {
    for (const [id, input] of Object.entries(source)) {
      profiles.set(id, normalizeProfile(id, input));
    }
  }
  return [...profiles.values()];
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function cliImplementer(cli: unknown): string | undefined {
  if (!isRecord(cli)) {
    return undefined;
  }
  return nonEmptyString(cli.implementer);
}

function buildRoleAssignments(
  userRoles: RolesConfigInput,
  repositoryRoles: RolesConfigInput,
  implementer: string | undefined,
): RoleAssignments {
  const { implementer: _userRolesImplementer, ...userRolesWithoutImplementer } = userRoles;
  const { implementer: _repositoryRolesImplementer, ...repositoryRolesWithoutImplementer } =
    repositoryRoles;
  const merged = { ...userRolesWithoutImplementer, ...repositoryRolesWithoutImplementer };
  const assignments: RoleAssignments = {
    discussants: merged.discussants ?? [],
    planner: merged.planner ?? "codex",
    reviewer: merged.reviewer ?? "codex",
    allowSameImplementerReviewer: merged.allowSameImplementerReviewer ?? false,
  };
  if (merged.summarizer !== undefined) {
    assignments.summarizer = merged.summarizer;
  }
  if (merged.specifier !== undefined) {
    assignments.specifier = merged.specifier;
  }
  if (implementer !== undefined) {
    assignments.implementer = implementer;
  }
  return assignments;
}

export function resolveAgentsConfigData(input: ResolveAgentsConfigInput): AgentsConfigData {
  const environment = input.environment ?? process.env;
  const user = extractAgentsDocument(input.user, "user configuration");
  const repository = extractAgentsDocument(input.repository, "repository configuration");
  const profiles = mergeProfiles(user.agents, repository.agents);

  const userImplementer = user.roles.implementer ?? user.legacyImplementer;
  const repositoryImplementer = repository.roles.implementer ?? repository.legacyImplementer;
  const implementer =
    cliImplementer(input.cli) ??
    nonEmptyString(environment.MEGURIBI_IMPLEMENTER) ??
    userImplementer ??
    repositoryImplementer;

  return {
    profiles,
    roles: buildRoleAssignments(user.roles, repository.roles, implementer),
  };
}

export function resolveValidatedAgentsConfig(input: ResolveAgentsConfigInput): AgentsConfigData {
  const resolved = resolveAgentsConfigData(input);
  validateRoleAssignments(resolved.roles, resolved.profiles);
  return resolved;
}

export function unknownImplementerProfileError(profileId: string): RoleAssignmentError {
  return new RoleAssignmentError(
    "unknown_profile",
    `implementer references unknown profile: ${profileId}`,
    "`.meguribi.yml` の `roles.implementer` を既存のプロファイル ID に直してください",
  );
}

export function unsupportedImplementerTransportError(profile: AgentProfile): RoleAssignmentError {
  return new RoleAssignmentError(
    "transport_unsupported",
    `implementer requires an acp-transport profile: ${profile.id} uses ${profile.transport}`,
    `\`agents.${profile.id}.transport: acp\` のプロファイルを選んでください`,
  );
}

const secretKeyPattern = /authorization|cookie|credential|key|password|secret|token/i;

function redact(value: unknown, key?: string): unknown {
  if (key !== undefined && secretKeyPattern.test(key)) {
    return undefined;
  }
  if (Array.isArray(value)) {
    return value.map((item) => redact(item));
  }
  if (typeof value === "object" && value !== null) {
    return Object.fromEntries(
      Object.entries(value)
        .map(([entryKey, entryValue]) => [entryKey, redact(entryValue, entryKey)] as const)
        .filter(([, entryValue]) => entryValue !== undefined),
    );
  }
  return value;
}

export function toRedactedAgentsConfigSnapshot(value: unknown): Record<string, unknown> {
  return redact(value) as Record<string, unknown>;
}
