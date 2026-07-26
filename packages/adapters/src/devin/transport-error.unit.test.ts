import { describe, expect, it } from "vitest";
import { ProcessError } from "@meguribi/process";
import {
  DevinAcpTransportError,
  toDevinAcpTransportError,
} from "./transport-error.js";

describe("toDevinAcpTransportError", () => {
  it("classifies ACP connection closed as connection_closed", () => {
    const error = toDevinAcpTransportError(
      new Error("ACP connection closed"),
      "prompt_send_failure",
    );
    expect(error).toBeInstanceOf(DevinAcpTransportError);
    expect(error.code).toBe("connection_closed");
    expect(error.toAgentError().code).toBe("process_crashed");
  });

  it("classifies ProcessError permission_denied explicitly", () => {
    const error = toDevinAcpTransportError(
      new ProcessError("permission_denied", "Permission denied: /bin/devin", false),
      "initialize_failure",
    );
    expect(error.code).toBe("permission_denied");
    expect(error.toAgentError().code).toBe("permission_denied");
  });

  it("preserves existing DevinAcpTransportError codes", () => {
    const original = new DevinAcpTransportError("process_crashed", "already classified");
    expect(toDevinAcpTransportError(original, "prompt_send_failure")).toBe(original);
  });
});
