import { describe, expect, it } from "vitest";
import { runMeasureCommand } from "./measure.js";
describe("runMeasureCommand", () => { it("requires a measurement period", async () => { await expect(runMeasureCommand("owner/repo#12", {}, {})).rejects.toThrow(/--period/); }); });
