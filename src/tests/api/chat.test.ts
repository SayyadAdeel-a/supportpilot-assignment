import { describe, expect, it, vi } from "vitest";
import { handleChatRequest } from "@/app/api/chat/route";
import { BedrockInvocationError } from "@/lib/bedrock/invoke";
import { MAX_CHAT_MESSAGE_LENGTH } from "@/lib/validation/chat";

function request(body: string) {
  return new Request("http://localhost/api/chat", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body,
  });
}

describe("POST /api/chat", () => {
  it("rejects malformed JSON", async () => {
    const response = await handleChatRequest(request("{"));
    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({ ok: false, error: { code: "INVALID_JSON" } });
  });

  it.each([
    ["empty", { message: "" }],
    ["oversized", { message: "x".repeat(MAX_CHAT_MESSAGE_LENGTH + 1) }],
    ["unknown fields", { message: "hello", modelId: "arbitrary-model" }],
  ])("rejects %s request bodies", async (_name, body) => {
    const response = await handleChatRequest(request(JSON.stringify(body)));
    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({ ok: false, error: { code: "VALIDATION_ERROR" } });
  });

  it("rejects requests exceeding the 16 KB body limit", async () => {
    const largeBody = JSON.stringify({ message: "x".repeat(17_000) });
    const response = await handleChatRequest(
      new Request("http://localhost/api/chat", {
        method: "POST",
        headers: { "content-type": "application/json", "content-length": String(largeBody.length) },
        body: largeBody,
      }),
    );
    expect(response.status).toBe(413);
    await expect(response.json()).resolves.toMatchObject({
      ok: false,
      error: { code: "REQUEST_TOO_LARGE" },
    });
  });

  it("reports an unavailable model configuration without using AWS", async () => {
    const response = await handleChatRequest(request(JSON.stringify({ message: "Where is my order?" })), { env: {} });
    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toMatchObject({ ok: false, error: { code: "MODEL_NOT_CONFIGURED" } });
  });

  it("returns the documented placeholder when a model is configured without an AWS client", async () => {
    const response = await handleChatRequest(request(JSON.stringify({ message: "What is your return policy?" })), {
      env: { BEDROCK_MODEL_ID: "global.anthropic.claude-sonnet-5-5" },
    });
    expect(response.status).toBe(501);
    await expect(response.json()).resolves.toMatchObject({ ok: false, error: { code: "NOT_IMPLEMENTED" } });
  });

  it("returns a successful agent response with citations and ticket", async () => {
    const mockAgent = {
      respond: vi.fn().mockResolvedValue({
        message: "Order ORD-1001 is on its way.",
        citations: [
          {
            id: "src/data/policies/shipping.md#1",
            title: "Shipping and delivery",
            path: "src/data/policies/shipping.md",
            excerpt: "Arrives within 3-7 days.",
          },
        ],
        ticket: {
          ticketId: "TKT-12345",
          status: "open" as const,
          category: "delivery_issue",
        },
      }),
    };

    const response = await handleChatRequest(
      request(
        JSON.stringify({
          message: "Where is my package?",
          conversationId: crypto.randomUUID(),
        }),
      ),
      { agent: mockAgent, env: { BEDROCK_MODEL_ID: "global.anthropic.claude-sonnet-5-5" } },
    );

    expect(response.status).toBe(200);
    const json = await response.json();
    expect(json).toEqual({
      ok: true,
      data: {
        message: "Order ORD-1001 is on its way.",
        citations: [
          {
            id: "src/data/policies/shipping.md#1",
            title: "Shipping and delivery",
            path: "src/data/policies/shipping.md",
            excerpt: "Arrives within 3-7 days.",
          },
        ],
        ticket: {
          ticketId: "TKT-12345",
          status: "open",
          category: "delivery_issue",
        },
      },
    });
  });

  it.each<[BedrockInvocationError["code"], number, boolean]>([
    ["ACCESS_DENIED", 403, false],
    ["THROTTLED", 429, true],
    ["MODEL_UNAVAILABLE", 503, false],
    ["TIMEOUT", 504, true],
    ["SERVICE_ERROR", 502, true],
  ])("maps %s invocation error to HTTP %i", async (code, expectedStatus, retryable) => {
    const failingAgent = {
      respond: vi.fn().mockRejectedValue(new BedrockInvocationError(code, "Upstream error", retryable)),
    };

    const response = await handleChatRequest(
      request(JSON.stringify({ message: "Help" })),
      { agent: failingAgent, env: { BEDROCK_MODEL_ID: "global.anthropic.claude-sonnet-5-5" } },
    );

    expect(response.status).toBe(expectedStatus);
    const json = await response.json();
    expect(json).toEqual({
      ok: false,
      error: {
        code,
        message: "Upstream error",
        retryable,
      },
    });
  });
});
