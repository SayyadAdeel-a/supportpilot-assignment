import type { SourceCitation, TicketSummary } from "@/types";

export type ModelKey =
  | "claude-opus-4-8"
  | "claude-opus-5"
  | "claude-opus-5-5"
  | "claude-sonnet-5-5"
  | "claude-haiku-5-5";

export type ModelVerification = "catalog_verified" | "unverified";

export interface ModelCapabilities {
  converse: boolean;
  streaming: boolean;
  toolUse: boolean;
  vision: boolean;
}

export interface ModelDefinition {
  key: ModelKey;
  displayName: string;
  catalogModelId: string | null;
  configuredModelId: string | null;
  envVar: string;
  verification: ModelVerification;
  capabilities: ModelCapabilities;
  configurationSource: "BEDROCK_MODEL_ID" | string | "not_configured";
  constraints: string[];
}

export interface AgentRequest {
  conversationId?: string;
  message: string;
  model: ModelDefinition;
}

export interface AgentResponse {
  message: string;
  citations: SourceCitation[];
  ticket?: TicketSummary;
}

export interface BedrockConversePort {
  converse(input: unknown): Promise<unknown>;
}

export class AgentNotImplementedError extends Error {
  constructor() {
    super("Bedrock agent orchestration has not been implemented.");
    this.name = "AgentNotImplementedError";
  }
}
