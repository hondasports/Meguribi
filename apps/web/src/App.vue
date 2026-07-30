<script setup lang="ts">
import { computed, onMounted, reactive, ref } from "vue";

type CommandId =
  | "doctor"
  | "init"
  | "discover"
  | "hypothesis"
  | "promote"
  | "explore"
  | "require"
  | "plan"
  | "review"
  | "run"
  | "resume"
  | "measure"
  | "cleanup";

interface CommandDefinition {
  id: CommandId;
  label: string;
  description: string;
  group: string;
  requiresTarget: boolean;
}

interface OutputLine {
  stream: "stdout" | "stderr" | "system";
  text: string;
}

const commandGroups = ["準備", "プロダクトループ", "Delivery"];
const commands: CommandDefinition[] = [
  {
    id: "doctor",
    label: "doctor",
    description: "実装エージェントの準備状態を診断",
    group: "準備",
    requiresTarget: false,
  },
  {
    id: "init",
    label: "init",
    description: "リポジトリと設定を診断",
    group: "準備",
    requiresTarget: true,
  },
  {
    id: "discover",
    label: "discover",
    description: "根拠から課題候補を抽出",
    group: "プロダクトループ",
    requiresTarget: true,
  },
  {
    id: "hypothesis",
    label: "hypothesis",
    description: "Issue の仮説を構造化",
    group: "プロダクトループ",
    requiresTarget: true,
  },
  {
    id: "promote",
    label: "promote",
    description: "Problem 草案へ昇格",
    group: "プロダクトループ",
    requiresTarget: true,
  },
  {
    id: "explore",
    label: "explore",
    description: "解決方針を比較",
    group: "プロダクトループ",
    requiresTarget: true,
  },
  {
    id: "require",
    label: "require",
    description: "選択した方針から要件化",
    group: "プロダクトループ",
    requiresTarget: true,
  },
  {
    id: "measure",
    label: "measure",
    description: "リリース後の測定草案を作成",
    group: "プロダクトループ",
    requiresTarget: true,
  },
  {
    id: "plan",
    label: "plan",
    description: "Codex SDK で実装計画を作成",
    group: "Delivery",
    requiresTarget: true,
  },
  {
    id: "review",
    label: "review",
    description: "既存 Run を Codex SDK で再レビュー",
    group: "Delivery",
    requiresTarget: true,
  },
  {
    id: "run",
    label: "run",
    description: "実装・検証・レビューを実行",
    group: "Delivery",
    requiresTarget: true,
  },
  {
    id: "resume",
    label: "resume",
    description: "中断した Run を再開",
    group: "Delivery",
    requiresTarget: true,
  },
  {
    id: "cleanup",
    label: "cleanup",
    description: "完了済み worktree を整理",
    group: "Delivery",
    requiresTarget: true,
  },
];

const selectedCommand = ref<CommandId>("run");
const running = ref(false);
const runId = ref<string | null>(null);
const connection = ref<"offline" | "online">("offline");
const output = ref<OutputLine[]>([]);
const result = ref<string | null>(null);
const error = ref<string | null>(null);
const form = reactive({
  repoPath: "",
  target: "local/todo#1",
  implementer: "devin",
  solution: "1",
  period: "14d",
  branch: "meguribi/issue-1",
  worktreePath: "",
  local: true,
  nonInteractive: true,
  allowInheritedMcp: true,
  noPush: true,
  noPr: true,
});

const selected = computed(() => commands.find((command) => command.id === selectedCommand.value)!);

function selectCommand(id: CommandId): void {
  if (running.value) return;
  selectedCommand.value = id;
  error.value = null;
  result.value = null;
}

function append(stream: OutputLine["stream"], text: string): void {
  output.value.push(
    ...text
      .split(/\r?\n/)
      .filter(Boolean)
      .map((line) => ({ stream, text: line })),
  );
}

function buildOptions(): Record<string, unknown> {
  return {
    repoPath: form.repoPath || undefined,
    implementer: form.implementer,
    local: form.local,
    nonInteractive: form.nonInteractive,
    allowInheritedMcp: form.allowInheritedMcp,
    noPush: form.noPush,
    noPr: form.noPr,
    branch: form.branch || undefined,
    worktreePath: form.worktreePath || undefined,
    solution: Number(form.solution),
    period: form.period || undefined,
  };
}

async function runCommand(): Promise<void> {
  if (running.value) return;
  running.value = true;
  output.value = [];
  result.value = null;
  error.value = null;
  append("system", `meguribi ${selectedCommand.value} を開始しています…`);

  try {
    const response = await fetch("/api/commands", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        command: selectedCommand.value,
        target: form.target,
        options: buildOptions(),
      }),
    });
    const payload = (await response.json()) as { runId?: string; error?: string };
    if (!response.ok || !payload.runId)
      throw new Error(payload.error ?? "コマンドを開始できませんでした");
    runId.value = payload.runId;
    connection.value = "online";
    const events = new EventSource(`/api/runs/${encodeURIComponent(payload.runId)}/events`);
    events.addEventListener("output", (event) => {
      const line = JSON.parse((event as MessageEvent).data) as OutputLine;
      append(line.stream, line.text);
    });
    events.addEventListener("complete", (event) => {
      const completed = JSON.parse((event as MessageEvent).data) as { exitCode: number };
      result.value = completed.exitCode === 0 ? "成功" : `終了コード ${completed.exitCode}`;
      append(
        "system",
        completed.exitCode === 0
          ? "コマンドが完了しました。"
          : "コマンドが失敗しました。ログを確認してください。",
      );
      running.value = false;
      connection.value = "offline";
      events.close();
    });
    events.onerror = () => {
      if (running.value)
        error.value = "実行ログとの接続が切れました。RunStore を確認してください。";
      connection.value = "offline";
      events.close();
    };
  } catch (cause) {
    running.value = false;
    error.value = cause instanceof Error ? cause.message : String(cause);
    append("stderr", error.value);
  }
}

onMounted(async () => {
  try {
    const response = await fetch("/api/health");
    if (response.ok) connection.value = "online";
  } catch {
    connection.value = "offline";
  }
});
</script>

<template>
  <main class="shell">
    <header class="topbar">
      <div class="brand">
        <span class="brand-mark">↻</span>
        <div><strong>Meguribi</strong><span>Command Desk</span></div>
      </div>
      <div class="connection">
        <span :class="['dot', connection]"></span
        >{{ connection === "online" ? "ローカルブリッジ接続中" : "待機中" }}
      </div>
    </header>

    <div class="workspace">
      <aside class="sidebar">
        <div class="eyebrow">COMMANDS</div>
        <section v-for="group in commandGroups" :key="group" class="command-group">
          <div class="group-label">{{ group }}</div>
          <button
            v-for="command in commands.filter((item) => item.group === group)"
            :key="command.id"
            :class="['command-item', { active: selectedCommand === command.id }]"
            @click="selectCommand(command.id)"
          >
            <span class="command-icon">{{
              command.id === "run" ? "▶" : command.id === "doctor" ? "✦" : "·"
            }}</span>
            <span
              ><b>{{ command.label }}</b
              ><small>{{ command.description }}</small></span
            >
          </button>
        </section>
      </aside>

      <section class="content">
        <div class="page-heading">
          <div>
            <div class="eyebrow">LOCAL ORCHESTRATOR</div>
            <h1>{{ selected.label }}</h1>
            <p>{{ selected.description }}</p>
          </div>
          <span class="badge">REAL CLI</span>
        </div>

        <div class="grid">
          <form class="card form-card" @submit.prevent="runCommand">
            <div class="card-heading">
              <div>
                <span class="step">01</span>
                <h2>実行設定</h2>
              </div>
              <span class="safe-label">● local-first</span>
            </div>
            <label v-if="selected.requiresTarget"
              >Target<input v-model="form.target" placeholder="owner/repo#123 または local/todo#1"
            /></label>
            <label
              >Repository path<input
                v-model="form.repoPath"
                placeholder="C:\\Users\\tatsuya\\Documents\\sourcecode\\todo"
            /></label>
            <div class="two-col">
              <label
                >Implementer<select v-model="form.implementer">
                  <option value="devin">Devin ACP</option>
                  <option value="cursor">Cursor ACP</option>
                </select></label
              >
              <label v-if="selectedCommand === 'require'"
                >Solution number<input v-model="form.solution" type="number" min="1"
              /></label>
              <label v-else-if="selectedCommand === 'measure'"
                >Period<input v-model="form.period" placeholder="14d"
              /></label>
              <label v-else>Branch<input v-model="form.branch" /></label>
            </div>
            <label v-if="selectedCommand === 'run'"
              >Worktree path<input v-model="form.worktreePath" placeholder="空欄ならCLIの既定値"
            /></label>
            <div class="switches">
              <label class="switch"
                ><input v-model="form.local" type="checkbox" /><span></span>Local
                mode（GitHubを呼ばない）</label
              >
              <label class="switch"
                ><input v-model="form.nonInteractive" type="checkbox" /><span></span
                >Non-interactive</label
              >
              <label v-if="selectedCommand === 'run'" class="switch"
                ><input v-model="form.allowInheritedMcp" type="checkbox" /><span></span>Inherited
                MCP を許可</label
              >
              <label v-if="selectedCommand === 'run'" class="switch"
                ><input v-model="form.noPush" type="checkbox" /><span></span>Pushしない</label
              >
              <label v-if="selectedCommand === 'run'" class="switch"
                ><input v-model="form.noPr" type="checkbox" /><span></span>PRを作成しない</label
              >
            </div>
            <button class="run-button" :disabled="running" type="submit">
              <span>{{ running ? "実行中…" : "コマンドを実行" }}</span
              ><b>⌘ ↵</b>
            </button>
            <p v-if="error" class="error-message">{{ error }}</p>
          </form>

          <section class="card output-card">
            <div class="card-heading">
              <div>
                <span class="step">02</span>
                <h2>実行ログ</h2>
              </div>
              <span v-if="result" :class="['result', result === '成功' ? 'success' : 'failure']">{{
                result
              }}</span>
            </div>
            <div class="terminal">
              <div v-if="output.length === 0" class="empty-terminal">
                <span>_</span>
                <p>実行すると stdout / stderr がここに表示されます</p>
              </div>
              <div v-for="(line, index) in output" :key="index" :class="['log-line', line.stream]">
                <i>{{ line.stream === "stderr" ? "!" : line.stream === "system" ? "›" : "$" }}</i
                ><span>{{ line.text }}</span>
              </div>
            </div>
            <div class="artifact-note">
              <span>◈</span>
              <p>
                成果物と Run 状態は<br /><code>%LOCALAPPDATA%\meguribi\runs</code> に保存されます。
              </p>
            </div>
          </section>
        </div>
      </section>
    </div>
  </main>
</template>
