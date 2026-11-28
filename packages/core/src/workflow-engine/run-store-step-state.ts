import type { RunStore } from "../delivery.js";
import type { StepStateStore } from "./engine.js";

/**
 * 工程状態を RunStore の成果物 `steps/<stepId>.json` として保存する。
 */
export function createRunStoreStepStateStore(runStore: RunStore, runId: string): StepStateStore {
  return {
    async save(record) {
      await runStore.saveArtifact(runId, `steps/${record.stepId}.json`, record);
    },
  };
}
