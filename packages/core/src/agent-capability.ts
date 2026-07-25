/**
 * 外部エージェントが報告する capability 情報。
 */
export interface AgentCapability {
  protocol?: string;
  protocolVersion?: string;
  agentName?: string;
  agentVersion?: string;
}
