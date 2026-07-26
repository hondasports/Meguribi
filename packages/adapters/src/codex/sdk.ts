import { Codex, type CodexOptions, type Thread, type ThreadEvent } from "@openai/codex-sdk";
import type { CodexClient, CodexThread, CodexThreadEvent, CodexThreadOptions } from "./types.js";

function normalizeEvent(event: ThreadEvent): CodexThreadEvent {
  return JSON.parse(JSON.stringify(event)) as CodexThreadEvent;
}

class SdkCodexThread implements CodexThread {
  constructor(private readonly thread: Thread) {}

  get id(): string | null {
    return this.thread.id;
  }

  async runStreamed(input: string, options: { outputSchema: unknown; signal: AbortSignal }) {
    const result = await this.thread.runStreamed(input, options);
    return {
      events: (async function* () {
        for await (const event of result.events) {
          yield normalizeEvent(event);
        }
      })(),
    };
  }
}

export interface CodexSdkClientOptions extends CodexOptions {}

export class CodexSdkClient implements CodexClient {
  private readonly client: Codex;

  constructor(options: CodexSdkClientOptions = {}) {
    this.client = new Codex(options);
  }

  startThread(options: CodexThreadOptions): CodexThread {
    return new SdkCodexThread(this.client.startThread(options));
  }

  resumeThread(threadId: string, options: CodexThreadOptions): CodexThread {
    return new SdkCodexThread(this.client.resumeThread(threadId, options));
  }
}
