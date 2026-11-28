import { describe, expect, it } from "vitest";
import { canUseConsultationDrawer, workspaceNavItems } from "./workspace-navigation.js";

describe("workspace navigation", () => {
  it("keeps mutual navigation between consultation, commands, and run history", () => {
    expect(workspaceNavItems.map((item) => item.view)).toEqual(["consult", "commands", "runs"]);
  });

  it("enables the consultation drawer only for the consultation view", () => {
    expect(canUseConsultationDrawer("consult")).toBe(true);
    expect(canUseConsultationDrawer("commands")).toBe(false);
    expect(canUseConsultationDrawer("runs")).toBe(false);
  });
});
