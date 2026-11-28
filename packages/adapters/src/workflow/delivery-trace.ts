import type { DeliveryDependencies, DeliveryResult, RunState } from "@meguribi/core";

/**
 * 現行 delivery の振る舞いを記録するためのトレース。
 * 時刻・runId・sessionId・一時パスなどの非決定的な値は含めない。
 */
export interface DeliveryTrace {
  states: Array<
    Pick<RunState, "status" | "currentStep" | "completedSteps" | "fixAttempts" | "pullRequestNumber"> & {
      lastErrorCode?: string;
      lastErrorMessage?: string;
    }
  >;
  calls: string[];
  result?: Pick<DeliveryResult, "status" | "published" | "reasons" | "pullRequestNumber">;
  /** runDelivery / resumeDelivery が例外を投げた場面だけ記録する */
  thrownError?: string;
}

function wrapPort<P extends object>(port: string, target: P, calls: string[]): P {
  const wrapped: Record<string, unknown> = {};
  for (const key of Object.keys(target)) {
    const value = (target as Record<string, unknown>)[key];
    if (typeof value === "function") {
      wrapped[key] = (...args: unknown[]) => {
        calls.push(`${port}.${key}`);
        return (value as (...a: unknown[]) => unknown).apply(target, args);
      };
    } else {
      wrapped[key] = value;
    }
  }
  return wrapped as P;
}

function artifactSuffix(name: string): string | undefined {
  // steps/ 配下はワークフローエンジンの工程状態であり、delivery 固有の
  // 振る舞いではないためトレース比較から除外する。
  if (name.startsWith("steps/")) {
    return undefined;
  }
  return `:${name}`;
}

/**
 * DeliveryDependencies を包み、呼ばれた順に "<port>.<method>" を記録する。
 * runStore.saveArtifact / readArtifact だけは成果物名を ":<name>" で付ける。
 */
export function withDeliveryTrace(deps: DeliveryDependencies): {
  deps: DeliveryDependencies;
  trace: DeliveryTrace;
} {
  const calls: string[] = [];
  const states: DeliveryTrace["states"] = [];

  const runStore: DeliveryDependencies["runStore"] = {
    ...deps.runStore,
    create: (input) => {
      calls.push("runStore.create");
      return deps.runStore.create(input);
    },
    load: (runId) => {
      calls.push("runStore.load");
      return deps.runStore.load(runId);
    },
    loadLatest: (repository, issueNumber) => {
      calls.push("runStore.loadLatest");
      return deps.runStore.loadLatest(repository, issueNumber);
    },
    update: (runId, patch) => {
      calls.push("runStore.update");
      return deps.runStore.update(runId, patch);
    },
    saveArtifact: (runId, name, value) => {
      const suffix = artifactSuffix(name);
      if (suffix !== undefined) {
        calls.push(`runStore.saveArtifact${suffix}`);
      }
      return deps.runStore.saveArtifact(runId, name, value);
    },
    readArtifact: <T>(runId: string, name: string): Promise<T | null> => {
      const suffix = artifactSuffix(name);
      if (suffix !== undefined) {
        calls.push(`runStore.readArtifact${suffix}`);
      }
      return deps.runStore.readArtifact<T>(runId, name);
    },
    acquireLock: (input) => {
      calls.push("runStore.acquireLock");
      return deps.runStore.acquireLock(input);
    },
    releaseLock: (input) => {
      calls.push("runStore.releaseLock");
      return deps.runStore.releaseLock(input);
    },
  };

  const wrapped: DeliveryDependencies = {
    ...deps,
    github: wrapPort("github", deps.github, calls),
    git: wrapPort("git", deps.git, calls),
    codex: wrapPort("codex", deps.codex, calls),
    implementer: wrapPort("implementer", deps.implementer, calls),
    devin: wrapPort("devin", deps.devin, calls),
    verifier: wrapPort("verifier", deps.verifier, calls),
    policy: wrapPort("policy", deps.policy, calls),
    runStore,
    onStateChange: async (state) => {
      states.push({
        status: state.status,
        currentStep: state.currentStep,
        completedSteps: [...state.completedSteps],
        fixAttempts: state.fixAttempts,
        pullRequestNumber: state.pullRequestNumber,
        ...(state.lastError
          ? { lastErrorCode: state.lastError.code, lastErrorMessage: state.lastError.message }
          : {}),
      });
      await deps.onStateChange?.(state);
    },
  };

  return { deps: wrapped, trace: { states, calls } };
}
