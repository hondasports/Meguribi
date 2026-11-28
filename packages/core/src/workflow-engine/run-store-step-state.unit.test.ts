import { describe, expect, it } from "vitest";
import type { RunState, RunStore } from "../delivery.js";
import { createRunStoreStepStateStore } from "./run-store-step-state.js";
import type { StepStateRecord } from "./engine.js";

function createMemoryRunStore(): RunStore & {
  artifacts: Map<string, Map<string, unknown>>;
} {
  const artifacts = new Map<string, Map<string, unknown>>();
  const states = new Map<string, RunState>();
  return {
    artifacts,
    async create() {
      throw new Error("not needed");
    },
    async load(runId) {
      return states.get(runId) ?? null;
    },
    async loadLatest() {
      return null;
    },
    async update() {
      throw new Error("not needed");
    },
    async saveArtifact(runId, name, value) {
      let bucket = artifacts.get(runId);
      if (!bucket) {
        bucket = new Map();
        artifacts.set(runId, bucket);
      }
      bucket.set(name, value);
      return name;
    },
    async readArtifact<T>(runId: string, name: string): Promise<T | null> {
      return (artifacts.get(runId)?.get(name) as T | undefined) ?? null;
    },
    async acquireLock() {},
    async releaseLock() {},
  };
}

describe("createRunStoreStepStateStore", () => {
  it("saves step state records under steps/<stepId>.json", async () => {
    const runStore = createMemoryRunStore();
    const store = createRunStoreStepStateStore(runStore, "run-1");
    const record: StepStateRecord = {
      stepId: "verify",
      kind: "verify",
      status: "completed",
      visit: 2,
      outcome: "continue",
      startedAt: "2026-07-26T12:00:00.000Z",
      finishedAt: "2026-07-26T12:00:01.000Z",
    };

    await store.save(record);

    const read = await runStore.readArtifact<StepStateRecord>("run-1", "steps/verify.json");
    expect(read).toEqual(record);
  });
});
