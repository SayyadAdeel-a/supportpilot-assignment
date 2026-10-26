import { describe, expect, it, vi } from "vitest";
import { handleChatRequest } from "@/app/api/chat/route";
import { BedrockSupportAgent } from "@/lib/bedrock/agent";
import { BedrockInvocationError } from "@/lib/bedrock/invoke";
import type { AgentRequest, BedrockConversePort, ModelDefinition } from "@/lib/bedrock/types";
import { LocalPolicyRetriever } from "@/lib/knowledge/retrieve";
import { FixtureOrderRepository } from "@/lib/repositories/orders";
import { InMemoryTicketRepository } from "@/lib/repositories/tickets";

const testModel: ModelDefinition = {
  key: "claude-sonnet-5-5",
  displayName: "Claude Sonnet 5.5",
  catalogModelId: "anthropic.claude-sonnet-5-5",
  configuredModelId: "global.anthropic.claude-sonnet-5-5",
  envVar: "BEDROCK_MODEL_ID",
  verification: "catalog_verified",
  capabilities: { converse: true, streaming: true, toolUse: true, vision: true },
  configurationSource: "BEDROCK_MODEL_ID",
  constraints: [],
};

function createJsonPostRequest(body: unknown) {
  return new Request("http://localhost/api/chat", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("Candidate Acceptance Scenarios", () => {
  // Criterion 1: Supported policy question produces evidence-grounded answer with relevant citations
  it("1. Supported policy question: produces an evidence-grounded answer with citations", async () => {
    let capturedSystemPrompt = "";

    const bedrock: BedrockConversePort = {
      converse: vi.fn().mockImplementation((input: { system?: Array<{ text: string }> }) => {
        capturedSystemPrompt = input.system?.[0]?.text ?? "";
        return Promise.resolve({
          output: {
            message: {
              role: "assistant",
              content: [
                {
                  text: "You can return unused items in their original condition within 30 calendar days of delivery.",
                },
              ],
            },
          },
          stopReason: "end_turn",
        });
      }),
    };

    const agent = new BedrockSupportAgent(bedrock, {
      retriever: new LocalPolicyRetriever(),
    });

    const response = await agent.respond({
      message: "How many days do I have to return an item?",
      model: testModel,
    });

    expect(response.citations.length).toBeGreaterThan(0);
    expect(response.citations[0].title).toBe("Returns and refunds");
    expect(response.citations[0].path).toBe("src/data/policies/returns.md");
    expect(capturedSystemPrompt).toContain("<policy_evidence>");
    expect(capturedSystemPrompt).toContain("Returns and refunds");
    expect(response.message).toContain("30 calendar days");
  });

  // Criterion 2: Unsupported policy question explicitly declines policy claims and returns empty citations
  it("2. Unsupported policy question: declines to make claims and returns empty citations", async () => {
    let capturedSystemPrompt = "";

    const bedrock: BedrockConversePort = {
      converse: vi.fn().mockImplementation((input: { system?: Array<{ text: string }> }) => {
        capturedSystemPrompt = input.system?.[0]?.text ?? "";
        return Promise.resolve({
          output: {
            message: {
              role: "assistant",
              content: [
                {
                  text: "I do not have policy information regarding moon colony warranties. Policy evidence is insufficient to answer this question.",
                },
              ],
            },
          },
          stopReason: "end_turn",
        });
      }),
    };

    const agent = new BedrockSupportAgent(bedrock, {
      retriever: new LocalPolicyRetriever(),
    });

    const response = await agent.respond({
      message: "What is your moon colony warranty policy?",
      model: testModel,
    });

    expect(response.citations).toEqual([]);
    expect(capturedSystemPrompt).not.toContain("<policy_evidence>");
    expect(response.message).toContain("insufficient");
  });

  // Criterion 3: Authorized order lookup returns fixture order details without inventing fields
  it("3. Authorized order lookup: returns real fixture order details and enforces server customerId", async () => {
    let capturedToolResult: unknown;

    const bedrock: BedrockConversePort = {
      converse: vi
        .fn()
        .mockResolvedValueOnce({
          output: {
            message: {
              role: "assistant",
              content: [
                {
                  toolUse: {
                    toolUseId: "call-lookup-1",
                    name: "lookupOrder",
                    input: { orderId: "ORD-1001" },
                  },
                },
              ],
            },
          },
          stopReason: "tool_use",
        })
        .mockImplementationOnce((input: { messages?: Array<{ content?: Array<{ toolResult?: { content?: Array<{ json?: unknown }> } }> }> }) => {
          const userMsg = input.messages?.[input.messages.length - 1];
          capturedToolResult = userMsg?.content?.[0]?.toolResult?.content?.[0]?.json;
          return Promise.resolve({
            output: {
              message: {
                role: "assistant",
                content: [{ text: "Order ORD-1001 is delivered by Northstar Parcel." }],
              },
            },
            stopReason: "end_turn",
          });
        }),
    };

    const agent = new BedrockSupportAgent(bedrock, {
      orders: new FixtureOrderRepository(),
      customerId: "mock-customer-001",
    });

    const response = await agent.respond({
      message: "Where is my order ORD-1001?",
      model: testModel,
    });

    expect(response.message).toContain("delivered by Northstar Parcel");
    expect(capturedToolResult).toEqual({
      found: true,
      order: {
        orderId: "ORD-1001",
        status: "delivered",
        estimatedDeliveryDate: "2026-10-04",
        carrier: "Northstar Parcel",
        items: [{ name: "Everyday Backpack", quantity: 1 }],
      },
    });
  });

  // Criterion 4: Missing or unauthorized order produces a safe not-found result without leaking existence
  it("4. Missing or unauthorized order: produces safe not-found result without revealing existence", async () => {
    let toolResultMissing: unknown;
    let toolResultUnauthorized: unknown;

    const bedrockMissing: BedrockConversePort = {
      converse: vi
        .fn()
        .mockResolvedValueOnce({
          output: {
            message: {
              role: "assistant",
              content: [
                {
                  toolUse: {
                    toolUseId: "lookup-missing",
                    name: "lookupOrder",
                    input: { orderId: "ORD-9999" },
                  },
                },
              ],
            },
          },
          stopReason: "tool_use",
        })
        .mockImplementationOnce((input: { messages?: Array<{ content?: Array<{ toolResult?: { content?: Array<{ json?: unknown }> } }> }> }) => {
          const userMsg = input.messages?.[input.messages.length - 1];
          toolResultMissing = userMsg?.content?.[0]?.toolResult?.content?.[0]?.json;
          return Promise.resolve({
            output: {
              message: {
                role: "assistant",
                content: [{ text: "I could not locate an order with ID ORD-9999 under your account." }],
              },
            },
            stopReason: "end_turn",
          });
        }),
    };

    const agentMissing = new BedrockSupportAgent(bedrockMissing, {
      orders: new FixtureOrderRepository(),
      customerId: "mock-customer-001",
    });

    await agentMissing.respond({ message: "Check order ORD-9999", model: testModel });
    expect(toolResultMissing).toEqual({ found: false, orderId: "ORD-9999" });

    // Unauthorized customer attempting to access ORD-1001
    const bedrockUnauthorized: BedrockConversePort = {
      converse: vi
        .fn()
        .mockResolvedValueOnce({
          output: {
            message: {
              role: "assistant",
              content: [
                {
                  toolUse: {
                    toolUseId: "lookup-unauth",
                    name: "lookupOrder",
                    input: { orderId: "ORD-1001" },
                  },
                },
              ],
            },
          },
          stopReason: "tool_use",
        })
        .mockImplementationOnce((input: { messages?: Array<{ content?: Array<{ toolResult?: { content?: Array<{ json?: unknown }> } }> }> }) => {
          const userMsg = input.messages?.[input.messages.length - 1];
          toolResultUnauthorized = userMsg?.content?.[0]?.toolResult?.content?.[0]?.json;
          return Promise.resolve({
            output: {
              message: {
                role: "assistant",
                content: [{ text: "Order ORD-1001 could not be found." }],
              },
            },
            stopReason: "end_turn",
          });
        }),
    };

    const agentUnauthorized = new BedrockSupportAgent(bedrockUnauthorized, {
      orders: new FixtureOrderRepository(),
      customerId: "unauthorized-customer-999",
    });

    await agentUnauthorized.respond({ message: "Check order ORD-1001", model: testModel });
    expect(toolResultUnauthorized).toEqual({ found: false, orderId: "ORD-1001" });
  });

  // Criterion 5: Support ticket creation reports success only after persistence confirms real ID with idempotency
  it("5. Support ticket creation: confirms success only after repository returns real ID and deduplicates", async () => {
    const tickets = new InMemoryTicketRepository();
    const orders = new FixtureOrderRepository();

    const makeBedrockMock = () => ({
      converse: vi
        .fn()
        .mockResolvedValueOnce({
          output: {
            message: {
              role: "assistant",
              content: [
                {
                  toolUse: {
                    toolUseId: "call-ticket",
                    name: "createSupportTicket",
                    input: {
                      orderId: "ORD-1001",
                      category: "damaged_item",
                      description: "The zipper broke immediately upon arrival.",
                    },
                  },
                },
              ],
            },
          },
          stopReason: "tool_use",
        })
        .mockResolvedValueOnce({
          output: {
            message: {
              role: "assistant",
              content: [{ text: "Your support ticket has been opened." }],
            },
          },
          stopReason: "end_turn",
        }),
    });

    const agent = new BedrockSupportAgent(makeBedrockMock(), {
      orders,
      tickets,
      customerId: "mock-customer-001",
    });

    const request: AgentRequest = {
      message: "My backpack arrived with a broken zipper for order ORD-1001",
      model: testModel,
    };

    const firstResponse = await agent.respond(request);

    expect(firstResponse.ticket).toBeDefined();
    expect(firstResponse.ticket?.ticketId).toMatch(/^TKT-[0-9A-F]{8}$/);
    expect(firstResponse.ticket?.status).toBe("open");
    expect(firstResponse.ticket?.category).toBe("damaged_item");

    // Second identical request - idempotency ensures same ticketId is returned without duplicate records
    const agentSecond = new BedrockSupportAgent(makeBedrockMock(), {
      orders,
      tickets,
      customerId: "mock-customer-001",
    });
    const secondResponse = await agentSecond.respond(request);
    expect(secondResponse.ticket?.ticketId).toBe(firstResponse.ticket?.ticketId);
  });

  // Criterion 6: Failed tool execution (invalid args failing Zod schema) surfaced safely via error toolResult
  it("6. Failed tool execution: surfaces validation error via toolResult and avoids fabricated success", async () => {
    let capturedToolResult: { status?: string; content?: Array<{ json?: { error?: string } }> } | undefined;

    const bedrock: BedrockConversePort = {
      converse: vi
        .fn()
        .mockResolvedValueOnce({
          output: {
            message: {
              role: "assistant",
              content: [
                {
                  toolUse: {
                    toolUseId: "call-invalid",
                    name: "createSupportTicket",
                    input: {
                      orderId: "not-an-order-id",
                      category: "invalid_category",
                      description: "short",
                    },
                  },
                },
              ],
            },
          },
          stopReason: "tool_use",
        })
        .mockImplementationOnce((input: { messages?: Array<{ content?: Array<{ toolResult?: typeof capturedToolResult }> }> }) => {
          const userMsg = input.messages?.[input.messages.length - 1];
          capturedToolResult = userMsg?.content?.[0]?.toolResult;
          return Promise.resolve({
            output: {
              message: {
                role: "assistant",
                content: [{ text: "I could not create the ticket because the arguments were invalid." }],
              },
            },
            stopReason: "end_turn",
          });
        }),
    };

    const agent = new BedrockSupportAgent(bedrock);
    const response = await agent.respond({
      message: "Please open a ticket with bad params",
      model: testModel,
    });

    expect(capturedToolResult?.status).toBe("error");
    expect(capturedToolResult?.content?.[0]?.json?.error).toContain("Validation error");
    expect(response.ticket).toBeUndefined();
    expect(response.message).toContain("invalid");
  });

  // Criterion 7: Error normalization maps Bedrock errors cleanly to HTTP status codes
  it("7. Error normalization: maps SDK errors cleanly to HTTP 403, 429, 502, 503, 504", async () => {
    const errorCases: Array<[BedrockInvocationError["code"], number, boolean]> = [
      ["ACCESS_DENIED", 403, false],
      ["THROTTLED", 429, true],
      ["MODEL_UNAVAILABLE", 503, false],
      ["TIMEOUT", 504, true],
      ["SERVICE_ERROR", 502, true],
    ];

    for (const [code, expectedStatus, retryable] of errorCases) {
      const mockFailingAgent = {
        respond: vi.fn().mockRejectedValue(new BedrockInvocationError(code, `Simulated ${code}`, retryable)),
      };

      const res = await handleChatRequest(
        createJsonPostRequest({ message: "Hello" }),
        { agent: mockFailingAgent, env: { BEDROCK_MODEL_ID: "global.anthropic.claude-sonnet-5-5" } },
      );

      expect(res.status).toBe(expectedStatus);
      const data = await res.json();
      expect(data).toEqual({
        ok: false,
        error: {
          code,
          message: `Simulated ${code}`,
          retryable,
        },
      });
    }
  });

  // Criterion 8: Security boundaries block arbitrary model IDs and arbitrary tool execution
  it("8. Security boundaries: rejects arbitrary model IDs and blocks unallowlisted tools", async () => {
    // Arbitrary model ID in client request is rejected by schema
    const arbitraryModelReq = createJsonPostRequest({
      message: "Hello",
      modelId: "arbitrary-untrusted-model-id",
    });
    const res1 = await handleChatRequest(arbitraryModelReq);
    expect(res1.status).toBe(400);
    const data1 = await res1.json();
    expect(data1.error.code).toBe("VALIDATION_ERROR");

    // Arbitrary tool execution requested by model output is blocked by agent
    let unallowlistedToolResult: { status?: string; content?: Array<{ json?: { error?: string } }> } | undefined;

    const bedrock: BedrockConversePort = {
      converse: vi
        .fn()
        .mockResolvedValueOnce({
          output: {
            message: {
              role: "assistant",
              content: [
                {
                  toolUse: {
                    toolUseId: "malicious-tool-call",
                    name: "executeArbitraryCommand",
                    input: { cmd: "cat /etc/passwd" },
                  },
                },
              ],
            },
          },
          stopReason: "tool_use",
        })
        .mockImplementationOnce((input: { messages?: Array<{ content?: Array<{ toolResult?: typeof unallowlistedToolResult }> }> }) => {
          const userMsg = input.messages?.[input.messages.length - 1];
          unallowlistedToolResult = userMsg?.content?.[0]?.toolResult;
          return Promise.resolve({
            output: {
              message: {
                role: "assistant",
                content: [{ text: "I cannot execute arbitrary operations." }],
              },
            },
            stopReason: "end_turn",
          });
        }),
    };

    const agent = new BedrockSupportAgent(bedrock);
    const response = await agent.respond({ message: "Run shell", model: testModel });

    expect(unallowlistedToolResult?.status).toBe("error");
    expect(unallowlistedToolResult?.content?.[0]?.json?.error).toContain("is not allowlisted");
    expect(response.message).toBe("I cannot execute arbitrary operations.");
  });

  // Criterion 9: Execution loops terminate strictly at maxIterations and conversations remain isolated
  it("9. Loop bounding and isolation: terminates at maxIterations without runaway turns and isolates state", async () => {
    const bedrockLooping: BedrockConversePort = {
      converse: vi.fn().mockResolvedValue({
        output: {
          message: {
            role: "assistant",
            content: [
              {
                text: "Looping step...",
                toolUse: {
                  toolUseId: "loop-step",
                  name: "lookupOrder",
                  input: { orderId: "ORD-1001" },
                },
              },
            ],
          },
        },
        stopReason: "tool_use",
      }),
    };

    const agent = new BedrockSupportAgent(bedrockLooping, { maxIterations: 4 });
    const response = await agent.respond({ message: "Indefinite loop query", model: testModel });

    // Bedrock should have been invoked exactly 4 times, capping runaway iterations
    expect(bedrockLooping.converse).toHaveBeenCalledTimes(4);
    expect(response.message).toBe("Looping step...");

    // Conversation isolation: ensure different requests do not share or leak message history
    const bedrockIsolated: BedrockConversePort = {
      converse: vi.fn().mockResolvedValue({
        output: {
          message: {
            role: "assistant",
            content: [{ text: "Response" }],
          },
        },
        stopReason: "end_turn",
      }),
    };

    const isolatingAgent = new BedrockSupportAgent(bedrockIsolated);
    await isolatingAgent.respond({ message: "Customer A secret", model: testModel });
    await isolatingAgent.respond({ message: "Customer B inquiry", model: testModel });

    const call1Messages = vi.mocked(bedrockIsolated.converse).mock.calls[0][0] as { messages: Array<{ content: Array<{ text?: string }> }> };
    const call2Messages = vi.mocked(bedrockIsolated.converse).mock.calls[1][0] as { messages: Array<{ content: Array<{ text?: string }> }> };

    expect(call1Messages.messages[0].content[0].text).toBe("Customer A secret");
    expect(call2Messages.messages[0].content[0].text).toBe("Customer B inquiry");
    expect(call2Messages.messages.length).toBe(1); // Call 2 only has its own initial user message
  });

  // Criterion 10: Starter and candidate test suites pass offline without AWS credentials
  it("10. Offline test compliance: runs completely offline with zero AWS credentials or network access", async () => {
    // Verify execution succeeds in an environment stripped of AWS credentials
    const cleanEnv = { BEDROCK_MODEL_ID: "global.anthropic.claude-sonnet-5-5" };

    const offlineBedrock: BedrockConversePort = {
      converse: vi.fn().mockResolvedValue({
        output: {
          message: {
            role: "assistant",
            content: [{ text: "Offline response verified." }],
          },
        },
        stopReason: "end_turn",
      }),
    };

    const mockAgent = new BedrockSupportAgent(offlineBedrock);
    const req = createJsonPostRequest({
      message: "Testing offline operation",
      conversationId: crypto.randomUUID(),
    });

    const res = await handleChatRequest(req, { agent: mockAgent, env: cleanEnv });
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.ok).toBe(true);
    expect(json.data.message).toBe("Offline response verified.");
  });
});
