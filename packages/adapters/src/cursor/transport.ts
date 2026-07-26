import {
  AcpProcessLifecycle,
  AcpTransportImpl,
  createAcpTransport,
  DEFAULT_POST_TURN_LIVENESS_MS,
  DEFAULT_PROMPT_TIMEOUT_MS,
  type AcpConnection,
  type AcpTransport,
  type RawAcpEvent,
  type StartAcpInput,
} from "../acp/transport.js";

export {
  AcpProcessLifecycle,
  AcpTransportImpl as CursorAcpTransportImpl,
  createAcpTransport as createCursorAcpTransport,
  DEFAULT_POST_TURN_LIVENESS_MS,
  DEFAULT_PROMPT_TIMEOUT_MS,
};
export type {
  AcpConnection as CursorAcpConnection,
  AcpTransport as CursorAcpTransport,
  RawAcpEvent as RawCursorAcpEvent,
  StartAcpInput as StartCursorAcpInput,
};
export { assertCursorRunnable } from "./diagnose.js";
