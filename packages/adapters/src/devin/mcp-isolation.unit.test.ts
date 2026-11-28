import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createDevinMcpIsolationFactory, prepareDevinMcpIsolation } from "./mcp-isolation.js";

describe("prepareDevinMcpIsolation", () => {
  let root: string;
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "meguribi-mcp-iso-"));
  });
  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("writes an isolated devin config disabling every read_config_from source", async () => {
    const isolation = await prepareDevinMcpIsolation({
      isolationRoot: join(root, "iso"),
      baseEnv: { PATH: "/bin" },
    });
    const raw = await readFile(join(root, "iso", "devin", "config.json"), "utf8");
    const config = JSON.parse(raw) as { read_config_from: Record<string, boolean> };
    expect(Object.keys(config.read_config_from).length).toBeGreaterThanOrEqual(8);
    expect(Object.values(config.read_config_from).every((value) => value === false)).toBe(true);
    expect(isolation.configRoot).toBe(join(root, "iso"));
  });

  it("merges XDG_CONFIG_HOME into the base env without dropping existing entries", async () => {
    const isolation = await prepareDevinMcpIsolation({
      isolationRoot: join(root, "iso"),
      baseEnv: { PATH: "/bin", HOME: "/home/test" },
    });
    expect(isolation.env.XDG_CONFIG_HOME).toBe(join(root, "iso"));
    expect(isolation.env.PATH).toBe("/bin");
    expect(isolation.env.HOME).toBe("/home/test");
  });

  it("forces the in-process process model so a shared daemon cannot bypass isolation", async () => {
    const isolation = await prepareDevinMcpIsolation({
      isolationRoot: join(root, "iso"),
      baseEnv: {},
    });
    expect(isolation.acpArgs).toContain("--process-model");
    expect(isolation.acpArgs).toContain("in-process");
  });

  it("does not copy credentials or reference the user config directory", async () => {
    const isolation = await prepareDevinMcpIsolation({
      isolationRoot: join(root, "iso"),
      baseEnv: {},
    });
    const raw = await readFile(join(root, "iso", "devin", "config.json"), "utf8");
    expect(raw).not.toContain("credentials");
    expect(raw).not.toContain(".config/devin");
    // 認証は ~/.local/share/devin/credentials.toml（data dir）側にあり、
    // XDG_CONFIG_HOME の隔離では失われないためコピー不要。
    expect(isolation.env.XDG_DATA_HOME).toBeUndefined();
  });

  it("is idempotent when the config already exists", async () => {
    const input = { isolationRoot: join(root, "iso"), baseEnv: {} };
    await prepareDevinMcpIsolation(input);
    await expect(prepareDevinMcpIsolation(input)).resolves.toBeDefined();
  });
});

describe("createDevinMcpIsolationFactory", () => {
  let root: string;
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "meguribi-mcp-iso-f-"));
  });
  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("creates a fresh dir per invocation and cleanup removes only its own", async () => {
    const factory = createDevinMcpIsolationFactory({ isolationRootParent: root, baseEnv: {} });
    const first = await factory();
    const second = await factory();
    expect(first.configRoot).not.toBe(second.configRoot);
    const { readdir } = await import("node:fs/promises");
    expect((await readdir(root)).length).toBe(2);
    await first.cleanup();
    const remaining = await readdir(root);
    expect(remaining.length).toBe(1);
    expect(remaining[0]).not.toContain(first.configRoot.split("/").pop() ?? "never");
    await second.cleanup();
    expect((await readdir(root)).length).toBe(0);
  });

  it("cleanup is idempotent and repeated consultations leave no temp dirs", async () => {
    const factory = createDevinMcpIsolationFactory({ isolationRootParent: root, baseEnv: {} });
    for (let index = 0; index < 3; index += 1) {
      const session = await factory();
      await session.cleanup();
      await session.cleanup();
    }
    const { readdir } = await import("node:fs/promises");
    expect((await readdir(root)).length).toBe(0);
  });

  it("does not touch foreign dirs in the same parent", async () => {
    const { mkdir: mkdirP, readdir } = await import("node:fs/promises");
    await mkdirP(join(root, "meguribi-devin-iso-foreign"));
    const factory = createDevinMcpIsolationFactory({ isolationRootParent: root, baseEnv: {} });
    const session = await factory();
    await session.cleanup();
    expect((await readdir(root)).sort()).toEqual(["meguribi-devin-iso-foreign"]);
  });
});
