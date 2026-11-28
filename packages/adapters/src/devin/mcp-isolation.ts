import { tmpdir } from "node:os";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

/**
 * Devin CLI の MCP 自動継承を Run スコープで遮断するための隔離設定。
 *
 * 調査で実証した公式機構の組み合わせを使う:
 * - ユーザーの MCP サーバーは `~/.config/devin/mcp_config.json`（XDG config dir）と、
 *   `read_config_from` による他ツール設定の import、cloud plugin から継承される。
 * - `XDG_CONFIG_HOME` を Meguribi 管理ディレクトリへ向けると、ユーザーの
 *   config.json / mcp_config.json は読まれなくなる。
 * - 認証情報は `~/.local/share/devin/credentials.toml`（XDG data dir）にあり、
 *   config dir の隔離では失われない。したがって credential のコピーは不要かつ禁止。
 * - `read_config_from` を全て false にした config.json を隔離先へ置くと、
 *   windsurf / cursor / cloud 等の import 由来サーバーも読まれない。
 * - daemon process model ではセッションが共有 daemon 内で動き、起動時の env が
 *   効かない可能性があるため `--process-model in-process` を強制する。
 *
 * ユーザーの永続設定は一切変更しない。検知（unexpected MCP connection）は
 * 引き続き安全網として残し、組織強制 plugin 等の隔離不能な経路を捕捉する。
 */
const ISOLATED_READ_CONFIG_FROM = {
  cloud: false,
  agents_standard: false,
  cursor: false,
  windsurf: false,
  claude: false,
  copilot: false,
  codex: false,
  kiro: false,
  opencode: false,
  zed: false,
} as const;

export interface DevinMcpIsolation {
  /** baseEnv をマージ済みの子プロセス用環境変数。 */
  env: NodeJS.ProcessEnv;
  /** `devin acp` へ追加する引数。 */
  acpArgs: readonly string[];
  /** 隔離 config を書き出したルート（XDG_CONFIG_HOME の指し先）。 */
  configRoot: string;
}

export async function prepareDevinMcpIsolation(input: {
  isolationRoot: string;
  baseEnv: NodeJS.ProcessEnv;
}): Promise<DevinMcpIsolation> {
  const devinDir = join(input.isolationRoot, "devin");
  await mkdir(devinDir, { recursive: true });
  await writeFile(
    join(devinDir, "config.json"),
    `${JSON.stringify({ read_config_from: ISOLATED_READ_CONFIG_FROM }, null, 2)}\n`,
    "utf8",
  );
  return {
    env: { ...input.baseEnv, XDG_CONFIG_HOME: input.isolationRoot },
    acpArgs: ["--process-model", "in-process"],
    configRoot: input.isolationRoot,
  };
}

/**
 * openSession ごとに固有の隔離 dir を作成し、cleanup で自分が作った dir だけを
 * 削除するファクトリ。wiring 時に1度だけ構築し、セッションのたびに呼び出す。
 * 繰り返しの相談で一時 dir が残り続けないようにするための契約。
 */
export interface DevinMcpIsolationSession {
  env: NodeJS.ProcessEnv;
  acpArgs: readonly string[];
  configRoot: string;
  /** 自分が作成した dir だけを削除する。冪等。 */
  cleanup(): Promise<void>;
}

export function createDevinMcpIsolationFactory(input: {
  isolationRootParent: string;
  baseEnv: NodeJS.ProcessEnv;
}): () => Promise<DevinMcpIsolationSession> {
  return async () => {
    const parent = input.isolationRootParent.length > 0 ? input.isolationRootParent : tmpdir();
    await mkdir(parent, { recursive: true });
    const isolationRoot = await mkdtemp(join(parent, "meguribi-devin-iso-"));
    const isolation = await prepareDevinMcpIsolation({
      isolationRoot,
      baseEnv: input.baseEnv,
    });
    let cleaned = false;
    return {
      env: isolation.env,
      acpArgs: isolation.acpArgs,
      configRoot: isolation.configRoot,
      async cleanup() {
        if (cleaned) {
          return;
        }
        cleaned = true;
        // mkdtemp が返した自分専用の dir だけを消す。parent や他の dir には触れない。
        await rm(isolationRoot, { recursive: true, force: true }).catch(() => undefined);
      },
    };
  };
}
