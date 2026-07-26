import { describe, expect, it } from "vitest";
import { ProcessError } from "@meguribi/process";
import {
  AcpTransportError,
  toAcpTransportError,
} from "./transport-error.js";

describe("toAcpTransportError", () => {
  it("classifies ACP connection closed as connection_closed", () => {
    const error = toAcpTransportError(
      new Error("ACP connection closed"),
      "prompt_send_failure",
    );
    expect(error).toBeInstanceOf(AcpTransportError);
    expect(error.code).toBe("connection_closed");
    expect(error.toAgentError().code).toBe("process_crashed");
  });

  it("classifies ProcessError permission_denied explicitly", () => {
    const error = toAcpTransportError(
      new ProcessError("permission_denied", "Permission denied: /bin/devin", false),
      "initialize_failure",
    );
    expect(error.code).toBe("permission_denied");
    expect(error.toAgentError().code).toBe("permission_denied");
  });

  it("preserves existing AcpTransportError codes", () => {
    const original = new AcpTransportError("process_crashed", "already classified");
    expect(toAcpTransportError(original, "prompt_send_failure")).toBe(original);
  });
});
