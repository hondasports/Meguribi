import type { CodexEventRecord } from "@meguribi/core";
import type { CodexThreadEvent } from "./types.js";

const sensitiveKey = /api[_-]?key|authorization|cookie|credential|password|secret|token/i;
const sensitiveString =
  /(bearer\s+|(?:api[_-]?key|access[_-]?token|refresh[_-]?token|client[_-]?secret|password|credential|secret)\s*[:=]\s*|(?:sk|rk|ghp|gho|ghu|ghs|ghr|github_pat|xoxb)-)[^\s,;]+/gi;

function redactValue(value: unknown, key?: string): unknown {
  if (key !== undefined && sensitiveKey.test(key)) {
    return "[REDACTED]";
  }
  if (typeof value === "string") {
    return value.replace(sensitiveString, "$1[REDACTED]");
  }
  if (Array.isArray(value)) {
    return value.map((item) => redactValue(item));
  }
  if (typeof value === "object" && value !== null) {
    return Object.fromEntries(
      Object.entries(value).map(([entryKey, entryValue]) => [
        entryKey,
        redactValue(entryValue, entryKey),
      ]),
    );
  }
  return value;
}

export function toRedactedEventRecord(event: CodexThreadEvent, at: string): CodexEventRecord {
  const redacted = redactValue(event);
  const data =
    typeof redacted === "object" && redacted !== null && !Array.isArray(redacted)
      ? (redacted as Record<string, unknown>)
      : { value: redacted };
  return { type: event.type, at, data };
}

export function redactErrorMessage(message: string): string {
  return message.replace(sensitiveString, "$1[REDACTED]");
}
