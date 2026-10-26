import { NextResponse } from "next/server";
import { ZodError } from "zod";
import { ConverseCommand, type ConverseCommandInput } from "@aws-sdk/client-bedrock-runtime";
import { BedrockSupportAgent, placeholderAgent, type SupportAgent } from "@/lib/bedrock/agent";
import { getBedrockClient } from "@/lib/bedrock/client";
import { BedrockInvocationError } from "@/lib/bedrock/invoke";
import { resolveModel, type Environment } from "@/lib/bedrock/model-registry";
import { AgentNotImplementedError } from "@/lib/bedrock/types";
import { chatRequestSchema, MAX_CHAT_REQUEST_BYTES } from "@/lib/validation/chat";
import type { ApiResponse } from "@/types";

const BEDROCK_STATUS_MAP: Record<BedrockInvocationError["code"], number> = {
  ACCESS_DENIED: 403,
  THROTTLED: 429,
  MODEL_UNAVAILABLE: 503,
  TIMEOUT: 504,
  SERVICE_ERROR: 502,
};

let defaultAgent: SupportAgent | undefined;

function getAgent(injected?: SupportAgent): SupportAgent {
  if (injected) return injected;
  try {
    const client = getBedrockClient();
    defaultAgent ??= new BedrockSupportAgent({
      converse: (input: unknown) =>
        "converse" in client && typeof client.converse === "function"
          ? (client.converse as (params: unknown) => Promise<unknown>)(input)
          : client.send(new ConverseCommand(input as ConverseCommandInput)),
    });
    return defaultAgent;
  } catch {
    return placeholderAgent;
  }
}

function errorResponse(code: string, message: string, status: number, retryable = false) {
  return NextResponse.json<ApiResponse<never>>({ ok: false, error: { code, message, retryable } }, { status });
}

export async function handleChatRequest(
  request: Request,
  dependencies: { agent?: SupportAgent; env?: Environment } = {},
) {
  const length = Number(request.headers.get("content-length") ?? 0);
  if (length > MAX_CHAT_REQUEST_BYTES) {
    return errorResponse("REQUEST_TOO_LARGE", "Request body exceeds the 16 KB limit.", 413);
  }

  let body: unknown;
  try {
    const rawBody = await request.text();
    if (new TextEncoder().encode(rawBody).byteLength > MAX_CHAT_REQUEST_BYTES) {
      return errorResponse("REQUEST_TOO_LARGE", "Request body exceeds the 16 KB limit.", 413);
    }
    body = JSON.parse(rawBody);
  } catch {
    return errorResponse("INVALID_JSON", "Request body must be valid JSON.", 400);
  }

  try {
    const input = chatRequestSchema.parse(body);
    const model = resolveModel(input.modelKey, dependencies.env ?? process.env);
    if (!model.configuredModelId) {
      return errorResponse(
        "MODEL_NOT_CONFIGURED",
        `${model.displayName} is catalog-verified but not configured for this environment. Add its server-side model or inference profile ID.`,
        503,
      );
    }

    const agent = getAgent(dependencies.agent);
    const result = await agent.respond({ ...input, model });
    return NextResponse.json<ApiResponse<typeof result>>({ ok: true, data: result });
  } catch (error) {
    if (error instanceof ZodError) {
      return errorResponse("VALIDATION_ERROR", error.issues[0]?.message ?? "Invalid request.", 400);
    }
    if (error instanceof BedrockInvocationError) {
      const status = BEDROCK_STATUS_MAP[error.code] ?? 500;
      return errorResponse(error.code, error.message, status, error.retryable);
    }
    if (error instanceof AgentNotImplementedError) {
      return errorResponse(
        "NOT_IMPLEMENTED",
        "The Bedrock support agent is intentionally not implemented in this starter. Complete src/lib/bedrock/agent.ts to enable responses.",
        501,
      );
    }
    return errorResponse("INTERNAL_ERROR", "Support is temporarily unavailable. Please try again later.", 500, true);
  }
}

export async function POST(request: Request) {
  return handleChatRequest(request);
}
