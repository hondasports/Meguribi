import { describe, expect, it } from "vitest";
import type { AgentEvent } from "@meguribi/core";
import type { WorkflowEvent } from "@meguribi/core";
import { projectTerminalRows } from "./terminal.js";

function agentEvent(
  profileId: string,
  event: AgentEvent,
  role: "discussant" | "summarizer" = "discussant",
): WorkflowEvent {
  return {
    type: "agent.event",
    stepId: "discuss",
    profileId,
    agentLabel: `${profileId} agent`,
    role,
    event,
  };
}

function delta(profileId: string, text: string, at: string, role: "discussant" | "summarizer" = "discussant"): WorkflowEvent {
  return agentEvent(profileId, { type: "message.delta", sessionId: "s-1", text, at }, role);
}

function turnEvent(overrides: {
  turnId?: string;
  speaker?: string;
  message?: string;
  malformed?: boolean;
  at?: string;
}): WorkflowEvent {
  return {
    type: "discussion.turn",
    runId: "run-1",
    turn: {
      turnId: overrides.turnId ?? "t-1",
      speaker: overrides.speaker ?? "alpha",
      speakerLabel: "alpha agent",
      envelope: {
        message: overrides.message ?? "結論に向けた発言",
        replyTo: [],
        addressTo: [],
        positions: [],
        newIssues: [],
        done: false,
      },
      malformed: overrides.malformed ?? false,
      at: overrides.at ?? "2026-11-28T10:00:00.000Z",
    },
    turnNumber: 1,
    maxTurns: 9,
  };
}

describe("projectTerminalRows / discussion.turn", () => {
  it("projects a well-formed turn as a message row with canonical id and timestamp", () => {
    const rows = projectTerminalRows([
      turnEvent({ turnId: "t-9", message: "この方針で進めたい", at: "2026-11-28T10:00:01.000Z" }),
    ]);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      id: "turn-t-9",
      kind: "message",
      text: "この方針で進めたい",
      active: false,
      at: "2026-11-28T10:00:01.000Z",
      profileId: "alpha",
    });
  });

  it("never exposes raw text of a malformed turn", () => {
    const rows = projectTerminalRows([
      turnEvent({ malformed: true, message: "RAW BROKEN OUTPUT {not json" }),
    ]);
    expect(rows.every((row) => row.kind !== "message" || !row.text.includes("RAW BROKEN"))).toBe(true);
    expect(rows.some((row) => row.text.includes("{not json"))).toBe(false);
  });
});

describe("projectTerminalRows / streaming message extraction", () => {
  it("reveals multi-chunk Japanese text without whitespace incrementally before turn end", () => {
    // 空白を含まない日本語でも、かな・漢字・句読点は ASCII 秘密値の構成文字になりえないため
    // 安全な境界として逐次開示できる。
    const rows = projectTerminalRows([
      delta("alpha", '{"message":"原因を', "2026-11-28T10:00:00.000Z"),
      delta("alpha", "調べました。", "2026-11-28T10:00:00.500Z"),
      delta("alpha", "設定を確認します", "2026-11-28T10:00:01.000Z"),
    ]);
    const live = rows.find((row) => row.kind === "message");
    expect(live).toBeDefined();
    expect(live?.active).toBe(true);
    expect(live?.text).toContain("原因を調べました。");
    expect(live?.text).toContain("設定を確認します");
  });

  it("reveals Japanese text up to a trailing incomplete ASCII token and holds the token", () => {
    const rows = projectTerminalRows([
      delta("alpha", '{"message":"原因はトークン sk-live123456789', "2026-11-28T10:00:00.000Z"),
    ]);
    const live = rows.find((row) => row.kind === "message");
    // 日本語部分は開示されるが、末尾の未確定 ASCII 列は保留される。
    expect(live?.text).toContain("原因はトークン");
    expect(live?.text).not.toContain("sk-");
    expect(live?.text).not.toContain("live123456");
  });

  it("reveals an ASCII token once a Japanese character confirms its end, still redacted", () => {
    const rows = projectTerminalRows([
      delta("alpha", '{"message":"鍵は sk-live123456789 です', "2026-11-28T10:00:00.000Z"),
    ]);
    const live = rows.find((row) => row.kind === "message");
    // トークンは確定済みだが redaction で隠れる。日本語は表示される。
    expect(live?.text).toContain("鍵は");
    expect(live?.text).toContain("です");
    expect(live?.text).not.toContain("sk-live123456789");
  });

  it("reveals confirmed words gradually and holds back a trailing partial word", () => {
    const rows = projectTerminalRows([
      delta("alpha", '{"message":"次の 方針は 固ま', "2026-11-28T10:00:00.000Z"),
    ]);
    const live = rows.find((row) => row.kind === "message");
    expect(live).toBeDefined();
    expect(live?.active).toBe(true);
    // 日本語は文字種上 ASCII 秘密値に混ざらないため、末尾まで逐次開示される。
    expect(live?.text).toContain("次の");
    expect(live?.text).toContain("方針は");
    expect(live?.text).toContain("固ま");
  });

  it("holds back a trailing partial ASCII word until it is confirmed", () => {
    const rows = projectTerminalRows([
      delta("alpha", '{"message":"the token is partialtoken99', "2026-11-28T10:00:00.000Z"),
    ]);
    const live = rows.find((row) => row.kind === "message");
    expect(live?.text).toContain("the token is");
    expect(live?.text).not.toContain("partialtoken99");
  });

  it("never leaks raw JSON envelope structure", () => {
    const rows = projectTerminalRows([
      delta("alpha", '{"message":"こんにちは 皆さん","replyTo":', "2026-11-28T10:00:00.000Z"),
    ]);
    const live = rows.find((row) => row.kind === "message");
    expect(live?.text ?? "").not.toContain('"message"');
    expect(live?.text ?? "").not.toContain("replyTo");
    expect(live?.text ?? "").not.toContain("{");
  });

  it("decodes complete escape sequences and holds incomplete ones", () => {
    const rows = projectTerminalRows([
      delta("alpha", '{"message":"一行目\\n二行目の 確認です ね\\u30', "2026-11-28T10:00:00.000Z"),
    ]);
    const live = rows.find((row) => row.kind === "message");
    expect(live?.text).toContain("一行目");
    expect(live?.text).toContain("二行目の");
    expect(live?.text).not.toContain("\\n");
    expect(live?.text).not.toContain("\\u30");
  });

  it("does not expose a secret split across deltas before it is complete and redacted", () => {
    const secret = "sk-live123456789";
    const first = secret.slice(0, 6);
    const rest = secret.slice(6);
    const streamingRows = projectTerminalRows([
      delta("alpha", `{"message":"トークンは ${first}`, "2026-11-28T10:00:00.000Z"),
    ]);
    // 分割された秘密値は未完成単語として開示されない。
    const early = streamingRows.find((row) => row.kind === "message");
    expect(early?.text ?? "").not.toContain("sk-");
    expect(early?.text ?? "").not.toContain(first);

    const completedRows = projectTerminalRows([
      delta("alpha", `{"message":"トークンは ${first}`, "2026-11-28T10:00:00.000Z"),
      delta("alpha", `${rest} を使います 次の 話題`, "2026-11-28T10:00:01.000Z"),
    ]);
    const live = completedRows.find((row) => row.kind === "message");
    expect(live?.text ?? "").not.toContain(secret);
    expect(live?.text ?? "").not.toContain("live123456");
  });

  it("reveals the full message once the turn completes", () => {
    const rows = projectTerminalRows([
      delta("alpha", '{"message":"最後の 言葉"', "2026-11-28T10:00:00.000Z"),
      agentEvent("alpha", { type: "turn.completed", sessionId: "s-1", at: "2026-11-28T10:00:02.000Z" }),
    ]);
    const live = rows.find((row) => row.kind === "message");
    expect(live?.active).toBe(false);
    expect(live?.text).toContain("最後の");
    expect(live?.text).toContain("言葉");
  });

  it("supersedes the live row when the canonical turn arrives", () => {
    const rows = projectTerminalRows([
      delta("alpha", '{"message":"確定する 発言"', "2026-11-28T10:00:00.000Z"),
      agentEvent("alpha", { type: "turn.completed", sessionId: "s-1", at: "2026-11-28T10:00:01.000Z" }),
      turnEvent({ turnId: "t-1", speaker: "alpha", message: "確定する 発言", at: "2026-11-28T10:00:02.000Z" }),
    ]);
    const messageRows = rows.filter((row) => row.kind === "message");
    expect(messageRows).toHaveLength(1);
    expect(messageRows[0]?.id).toBe("turn-t-1");
  });

  it("ignores summarizer message deltas entirely", () => {
    const rows = projectTerminalRows([
      delta("gamma", '{"topic":"x","conclusion":"秘匿の 要約 途中', "2026-11-28T10:00:00.000Z", "summarizer"),
    ]);
    expect(rows.every((row) => row.kind !== "message")).toBe(true);
  });
});

describe("projectTerminalRows / tool and status rows", () => {
  it("projects tool activity without arguments or summaries", () => {
    const rows = projectTerminalRows([
      agentEvent("alpha", {
        type: "tool.started",
        sessionId: "s-1",
        tool: "Bash",
        toolCallId: "tc-1",
        summary: "rm -rf / secret args",
        at: "2026-11-28T10:00:00.000Z",
      }),
    ]);
    const tool = rows.find((row) => row.kind === "tool");
    expect(tool).toBeDefined();
    expect(tool?.active).toBe(true);
    expect(tool?.text).toContain("Bash");
    expect(tool?.text).not.toContain("rm -rf");
    expect(tool?.text).not.toContain("secret args");
  });

  it("marks the tool inactive once completed with the same id", () => {
    const rows = projectTerminalRows([
      agentEvent("alpha", { type: "tool.started", sessionId: "s-1", tool: "Read", toolCallId: "tc-1", at: "2026-11-28T10:00:00.000Z" }),
      agentEvent("alpha", { type: "tool.completed", sessionId: "s-1", tool: "Read", toolCallId: "tc-1", at: "2026-11-28T10:00:01.000Z" }),
    ]);
    const tools = rows.filter((row) => row.kind === "tool");
    expect(tools).toHaveLength(1);
    expect(tools[0]?.active).toBe(false);
  });

  it("projects session failure as a status row with only the safe error code", () => {
    const rows = projectTerminalRows([
      agentEvent("alpha", {
        type: "session.failed",
        sessionId: "s-1",
        error: { code: "policy_blocked", message: "token=abc123 secret detail", isRetryable: false },
        at: "2026-11-28T10:00:00.000Z",
      }),
    ]);
    const status = rows.find((row) => row.kind === "status");
    expect(status).toBeDefined();
    expect(status?.text).toContain("policy_blocked");
    expect(status?.text).not.toContain("abc123");
    expect(status?.text).not.toContain("secret detail");
  });

  it("strips control characters and ANSI sequences from text", () => {
    const rows = projectTerminalRows([
      turnEvent({ turnId: "t-c", message: "通常\x1b[31m赤色\x07 テキスト" }),
    ]);
    const message = rows.find((row) => row.kind === "message");
    expect(message?.text).not.toContain("\x1b");
    expect(message?.text).not.toContain("\x07");
    expect(message?.text).not.toContain("[31m");
  });
});

describe("projector review hardening", () => {
  it("ignores a nested message key inside another object", () => {
    const rows = projectTerminalRows([
      delta("alpha", '{"positions":[{"issue":"x","message":"ネストの 偽装"}], "message":"本物の 発言です"', "2026-11-28T10:00:00.000Z"),
      agentEvent("alpha", { type: "turn.completed", sessionId: "s-1", at: "2026-11-28T10:00:01.000Z" }),
    ]);
    const live = rows.find((row) => row.kind === "message");
    expect(live?.text).toContain("本物の");
    expect(live?.text).not.toContain("ネストの");
  });

  it("ignores quoted JSON in a preamble before the envelope object", () => {
    const rows = projectTerminalRows([
      delta("alpha", 'preamble text "{"message":"偽の 前置き"}" 実際の出力\n{"message":"本物だけ 見せる"', "2026-11-28T10:00:00.000Z"),
      agentEvent("alpha", { type: "turn.completed", sessionId: "s-1", at: "2026-11-28T10:00:01.000Z" }),
    ]);
    const live = rows.find((row) => row.kind === "message");
    expect(live?.text).toContain("本物だけ");
    expect(live?.text).not.toContain("偽の");
  });

  it("stops partial output when the raw buffer overflows and recovers at the confirmed turn", async () => {
    const { createTerminalProjector, COMPOSITION_RAW_MAX_LENGTH } = await import("./terminal.js");
    const projector = createTerminalProjector();
    projector.ingest(delta("alpha", '{"message":"', "2026-11-28T10:00:00.000Z"));
    // 上限を超える大量の delta を流す。
    projector.ingest(delta("alpha", "あ".repeat(COMPOSITION_RAW_MAX_LENGTH), "2026-11-28T10:00:01.000Z"));
    const overflowed = projector.snapshot();
    expect(overflowed.find((row) => row.id === "live-alpha")).toBeUndefined();
    // 確定 turn は独立経路なので復帰できる。
    projector.ingest(turnEvent({ turnId: "t-recover", speaker: "alpha", message: "確定した 内容" }));
    const recovered = projector.snapshot();
    expect(recovered.some((row) => row.id === "turn-t-recover")).toBe(true);
  });

  it("resets the raw buffer when a new delta arrives after turn completion", () => {
    const rows = projectTerminalRows([
      delta("alpha", '{"message":"一つ目の 発言"', "2026-11-28T10:00:00.000Z"),
      agentEvent("alpha", { type: "turn.completed", sessionId: "s-1", at: "2026-11-28T10:00:01.000Z" }),
      turnEvent({ turnId: "t-1", speaker: "alpha", message: "一つ目の 発言", at: "2026-11-28T10:00:02.000Z" }),
      delta("alpha", '{"message":"二つ目の 発言', "2026-11-28T10:00:03.000Z"),
    ]);
    const live = rows.find((row) => row.id === "live-alpha");
    expect(live?.text).toContain("二つ目の");
    expect(live?.text).not.toContain("一つ目の");
  });

  it("does not cross wire tool state across sessions sharing a toolCallId", () => {
    const rows = projectTerminalRows([
      agentEvent("alpha", { type: "tool.started", sessionId: "s-1", tool: "Read", toolCallId: "tc-shared", at: "2026-11-28T10:00:00.000Z" }),
      agentEvent("beta", { type: "tool.started", sessionId: "s-2", tool: "Read", toolCallId: "tc-shared", at: "2026-11-28T10:00:01.000Z" }),
      agentEvent("beta", { type: "tool.completed", sessionId: "s-2", tool: "Read", toolCallId: "tc-shared", at: "2026-11-28T10:00:02.000Z" }),
    ]);
    const tools = rows.filter((row) => row.kind === "tool");
    expect(tools).toHaveLength(2);
    const alphaTool = tools.find((row) => row.profileId === "alpha");
    const betaTool = tools.find((row) => row.profileId === "beta");
    // beta の完了が alpha の実行中を潰さない。
    expect(alphaTool?.active).toBe(true);
    expect(betaTool?.active).toBe(false);
  });

  it("does not treat a failed tool completion as a normal completion", () => {
    const rows = projectTerminalRows([
      agentEvent("alpha", { type: "tool.started", sessionId: "s-1", tool: "Bash", toolCallId: "tc-1", at: "2026-11-28T10:00:00.000Z" }),
      agentEvent("alpha", { type: "tool.completed", sessionId: "s-1", tool: "Bash", toolCallId: "tc-1", status: "failed", at: "2026-11-28T10:00:01.000Z" }),
    ]);
    const tool = rows.find((row) => row.kind === "tool");
    expect(tool?.text).not.toContain("完了");
    expect(tool?.text).toContain("失敗");
    expect(tool?.active).toBe(false);
  });

  it("masks the unseparated token tail right after a REDACTED placeholder from chunked redaction", () => {
    // eventLog.append は chunk 単位で redact する。delta1 時点で "sk-abcdefgh" が
    // [REDACTED] になり、delta2 の "ijkl " が続くと再構成は "[REDACTED]ijkl" になる。
    // suffix を漏らさないよう、プレースホルダ直後の未区切りトークン末尾も伏せる。
    const rows = projectTerminalRows([
      delta("alpha", '{"message":"鍵は [REDACTED]ijkl です 確認しました', "2026-11-28T10:00:00.000Z"),
      agentEvent("alpha", { type: "turn.completed", sessionId: "s-1", at: "2026-11-28T10:00:01.000Z" }),
    ]);
    const live = rows.find((row) => row.kind === "message");
    expect(live?.text).not.toContain("ijkl");
    expect(live?.text).toContain("[REDACTED]");
    expect(live?.text).toContain("確認しました");
  });

  it("keeps Japanese text right after a REDACTED placeholder", () => {
    const rows = projectTerminalRows([
      turnEvent({ turnId: "t-redacted", message: "値は [REDACTED]です" }),
    ]);
    const message = rows.find((row) => row.kind === "message");
    // 日本語はトークン構成文字ではないので剥がさない。
    expect(message?.text).toContain("です");
  });

  it("masks the suffix also in canonical turn rows", () => {
    const rows = projectTerminalRows([
      turnEvent({ turnId: "t-suffix", message: "鍵は [REDACTED]xyz123 終わり" }),
    ]);
    const message = rows.find((row) => row.kind === "message");
    expect(message?.text).not.toContain("xyz123");
    expect(message?.text).toContain("終わり");
  });

  it("incremental projector matches batch re-derivation for the same events", async () => {
    const { createTerminalProjector } = await import("./terminal.js");
    const events = [
      delta("alpha", '{"message":"増分と 一括が', "2026-11-28T10:00:00.000Z"),
      agentEvent("alpha", { type: "turn.completed", sessionId: "s-1", at: "2026-11-28T10:00:01.000Z" }),
      turnEvent({ turnId: "t-1", speaker: "alpha", message: "増分と 一括が一致" }),
      agentEvent("beta", { type: "session.started", sessionId: "s-9", at: "2026-11-28T10:00:03.000Z" }),
    ];
    const projector = createTerminalProjector();
    for (const event of events) projector.ingest(event);
    expect(projector.snapshot()).toEqual(projectTerminalRows(events));
  });
});

describe("projectTerminalRows / bounds", () => {
  it("caps row text length", () => {
    const rows = projectTerminalRows([
      turnEvent({ turnId: "t-long", message: "あ".repeat(600) }),
    ]);
    const message = rows.find((row) => row.kind === "message");
    expect((message?.text ?? "").length).toBeLessThanOrEqual(500);
  });

  it("caps the number of rows keeping the most recent", () => {
    const events = Array.from({ length: 250 }, (_, index) =>
      turnEvent({ turnId: `t-${String(index)}`, message: `発言${String(index)}`, at: `2026-11-28T10:${String(index % 60).padStart(2, "0")}:00.000Z` }),
    );
    const rows = projectTerminalRows(events);
    expect(rows.length).toBeLessThanOrEqual(200);
    expect(rows.some((row) => row.id === "turn-t-249")).toBe(true);
  });

  it("produces stable ids across re-derivation for reconnection dedup", () => {
    const events = [
      turnEvent({ turnId: "t-1", message: "同じ 発言" }),
      agentEvent("alpha", { type: "tool.started", sessionId: "s-1", tool: "Read", toolCallId: "tc-1", at: "2026-11-28T10:00:00.000Z" }),
    ];
    const first = projectTerminalRows(events).map((row) => row.id);
    const second = projectTerminalRows(events).map((row) => row.id);
    expect(first).toEqual(second);
    expect(new Set(first).size).toBe(first.length);
  });
});
