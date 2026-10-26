import { describe, expect, it, vi } from "vitest";
import { BedrockSupportAgent } from "@/lib/bedrock/agent";
import type { AgentRequest, BedrockConversePort, ModelDefinition } from "@/lib/bedrock/types";
import type { PolicyRetriever } from "@/lib/knowledge/types";
import type { OrderRepository } from "@/lib/repositories/orders";
import type { TicketRepository } from "@/lib/repositories/tickets";

const mockModel: ModelDefinition = {
  key: "claude-sonnet-5-5",
  displayName: "Claude Sonnet 3.5",
  catalogModelId: "anthropic.claude-3-5-sonnet-20241022-v2:0",
  configuredModelId: "us.anthropic.claude-3-5-sonnet-20241022-v2:0",
  envVar: "BEDROCK_MODEL_ID_SONNET",
  verification: "catalog_verified",
  capabilities: { converse: true, streaming: true, toolUse: true, vision: true },
  configurationSource: "BEDROCK_MODEL_ID_SONNET",
  constraints: [],
};

describe("BedrockSupportAgent", () => {
  it("rejects execution when configuredModelId is missing", async () => {
    const bedrock: BedrockConversePort = { converse: vi.fn() };
    const agent = new BedrockSupportAgent(bedrock);

    const request: AgentRequest = {
      message: "Hello",
      model: { ...mockModel, configuredModelId: null },
    };

    await expect(agent.respond(request)).rejects.toThrow("missing a configured model ID");
  });

  it("completes a direct conversation turn without tool calls", async () => {
    const bedrock: BedrockConversePort = {
      converse: vi.fn().mockResolvedValue({
        output: {
          message: {
            role: "assistant",
            content: [{ text: "Hello! How can I assist you with SupportPilot today?" }],
          },
        },
        stopReason: "end_turn",
      }),
    };

    const agent = new BedrockSupportAgent(bedrock);
    const response = await agent.respond({ message: "Hello", model: mockModel });

    expect(response.message).toBe("Hello! How can I assist you with SupportPilot today?");
    expect(response.citations).toEqual([]);
    expect(response.ticket).toBeUndefined();
    expect(bedrock.converse).toHaveBeenCalledTimes(1);
  });

  it("grounds policy inquiries with retrieved citations and formatted system prompt", async () => {
    const mockRetriever: PolicyRetriever = {
      retrieve: vi.fn().mockResolvedValue([
        {
          id: "src/data/policies/returns.md#1",
          title: "Returns and refunds",
          path: "src/data/policies/returns.md",
          excerpt: "Returns accepted within 30 days.",
          content: "Returns accepted within 30 days of delivery.",
          score: 0.9,
        },
      ]),
    };

    const bedrock: BedrockConversePort = {
      converse: vi.fn().mockResolvedValue({
        output: {
          message: {
            role: "assistant",
            content: [{ text: "You can return unused items within 30 days of delivery." }],
          },
        },
        stopReason: "end_turn",
      }),
    };

    const agent = new BedrockSupportAgent(bedrock, { retriever: mockRetriever });
    const response = await agent.respond({ message: "What is your return window?", model: mockModel });

    expect(response.message).toContain("within 30 days");
    expect(response.citations).toHaveLength(1);
    expect(response.citations[0].title).toBe("Returns and refunds");

    // Verify system prompt contained evidence block
    const callArgs = vi.mocked(bedrock.converse).mock.calls[0][0] as {
      system: Array<{ text: string }>;
    };
    expect(callArgs.system[0].text).toContain("<policy_evidence>");
    expect(callArgs.system[0].text).toContain("Returns and refunds");
  });

  it("executes lookupOrder tool with server-enforced customerId and feeds results back", async () => {
    const bedrock: BedrockConversePort = {
      converse: vi
        .fn()
        // Turn 1: Model invokes lookupOrder
        .mockResolvedValueOnce({
          output: {
            message: {
              role: "assistant",
              content: [
                {
                  toolUse: {
                    toolUseId: "tool-call-1",
                    name: "lookupOrder",
                    input: { orderId: "ORD-1001" },
                  },
                },
              ],
            },
          },
          stopReason: "tool_use",
        })
        // Turn 2: Model answers using tool results
        .mockResolvedValueOnce({
          output: {
            message: {
              role: "assistant",
              content: [{ text: "Your order ORD-1001 is delivered." }],
            },
          },
          stopReason: "end_turn",
        }),
    };

    const mockOrders: OrderRepository = {
      findAuthorizedById: vi.fn().mockResolvedValue({
        id: "ORD-1001",
        customerId: "mock-customer-001",
        status: "delivered",
        estimatedDeliveryDate: "2026-03-25",
        carrier: "FedEx",
        items: [{ name: "Mechanical Keyboard", quantity: 1 }],
      }),
    };

    const agent = new BedrockSupportAgent(bedrock, { orders: mockOrders, customerId: "mock-customer-001" });
    const response = await agent.respond({ message: "Check order ORD-1001", model: mockModel });

    expect(response.message).toBe("Your order ORD-1001 is delivered.");
    expect(mockOrders.findAuthorizedById).toHaveBeenCalledWith("ORD-1001", "mock-customer-001");
    expect(bedrock.converse).toHaveBeenCalledTimes(2);

    // Verify tool result was sent back in turn 2
    const secondCallPayload = vi.mocked(bedrock.converse).mock.calls[1][0] as {
      messages: Array<{
        role: string;
        content: Array<{ toolResult?: { toolUseId: string; status: string; content: unknown } }>;
      }>;
    };
    const userTurn = secondCallPayload.messages[secondCallPayload.messages.length - 1];
    expect(userTurn.role).toBe("user");
    expect(userTurn.content[0].toolResult?.toolUseId).toBe("tool-call-1");
    expect(userTurn.content[0].toolResult?.status).toBe("success");
  });

  it("executes createSupportTicket tool and populates ticket summary on success", async () => {
    const bedrock: BedrockConversePort = {
      converse: vi
        .fn()
        // Turn 1: Model calls createSupportTicket
        .mockResolvedValueOnce({
          output: {
            message: {
              role: "assistant",
              content: [
                {
                  toolUse: {
                    toolUseId: "tool-call-create",
                    name: "createSupportTicket",
                    input: {
                      orderId: "ORD-1001",
                      category: "damaged_item",
                      description: "The keyboard arrived with several broken keys.",
                    },
                  },
                },
              ],
            },
          },
          stopReason: "tool_use",
        })
        // Turn 2: Model finishes
        .mockResolvedValueOnce({
          output: {
            message: {
              role: "assistant",
              content: [{ text: "I have created ticket TKT-999 for your damaged order." }],
            },
          },
          stopReason: "end_turn",
        }),
    };

    const mockOrders: OrderRepository = {
      findAuthorizedById: vi.fn().mockResolvedValue({
        id: "ORD-1001",
        customerId: "mock-customer-001",
        status: "delivered",
        estimatedDeliveryDate: "2026-03-25",
        carrier: "FedEx",
        items: [{ name: "Mechanical Keyboard", quantity: 1 }],
      }),
    };

    const mockTickets: TicketRepository = {
      create: vi.fn().mockResolvedValue({
        id: "TKT-999",
        customerId: "mock-customer-001",
        orderId: "ORD-1001",
        category: "damaged_item",
        description: "The keyboard arrived with several broken keys.",
        status: "open",
        createdAt: "2026-03-26T10:00:00Z",
        idempotencyKey: "test-hash",
      }),
      findByIdempotencyKey: vi.fn().mockResolvedValue(null),
    };

    const agent = new BedrockSupportAgent(bedrock, {
      orders: mockOrders,
      tickets: mockTickets,
      customerId: "mock-customer-001",
    });

    const response = await agent.respond({ message: "My keyboard arrived broken", model: mockModel });

    expect(response.message).toContain("TKT-999");
    expect(response.ticket).toEqual({
      ticketId: "TKT-999",
      status: "open",
      category: "damaged_item",
    });
  });

  it("handles tool validation errors gracefully and sends error toolResult to model", async () => {
    const bedrock: BedrockConversePort = {
      converse: vi
        .fn()
        // Turn 1: Model passes invalid tool input (orderId format wrong, description too short)
        .mockResolvedValueOnce({
          output: {
            message: {
              role: "assistant",
              content: [
                {
                  toolUse: {
                    toolUseId: "tool-call-bad",
                    name: "createSupportTicket",
                    input: { orderId: "bad-id", category: "damaged_item", description: "short" },
                  },
                },
              ],
            },
          },
          stopReason: "tool_use",
        })
        // Turn 2: Model receives validation error and responds
        .mockResolvedValueOnce({
          output: {
            message: {
              role: "assistant",
              content: [{ text: "Please provide a valid order ID like ORD-1001 and more details." }],
            },
          },
          stopReason: "end_turn",
        }),
    };

    const agent = new BedrockSupportAgent(bedrock);
    const response = await agent.respond({ message: "Open ticket", model: mockModel });

    expect(response.message).toContain("Please provide a valid order ID");
    expect(bedrock.converse).toHaveBeenCalledTimes(2);

    const secondCall = vi.mocked(bedrock.converse).mock.calls[1][0] as {
      messages: Array<{
        content: Array<{ toolResult?: { status: string; content: unknown } }>;
      }>;
    };
    const lastMessage = secondCall.messages[secondCall.messages.length - 1];
    expect(lastMessage.content[0].toolResult?.status).toBe("error");
  });

  it("rejects unallowlisted tool requests safely", async () => {
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
                    toolUseId: "tool-call-malicious",
                    name: "executeShellCommand",
                    input: { cmd: "rm -rf" },
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
              content: [{ text: "I cannot execute system commands." }],
            },
          },
          stopReason: "end_turn",
        }),
    };

    const agent = new BedrockSupportAgent(bedrock);
    const response = await agent.respond({ message: "Hack system", model: mockModel });

    expect(response.message).toBe("I cannot execute system commands.");

    const secondCall = vi.mocked(bedrock.converse).mock.calls[1][0] as {
      messages: Array<{
        content: Array<{ toolResult?: { status: string; content: unknown } }>;
      }>;
    };
    const lastMessage = secondCall.messages[secondCall.messages.length - 1];
    expect(lastMessage.content[0].toolResult?.status).toBe("error");
  });

  it("strictly terminates when maxIterations is reached without infinite looping", async () => {
    const bedrock: BedrockConversePort = {
      converse: vi.fn().mockResolvedValue({
        output: {
          message: {
            role: "assistant",
            content: [
              {
                text: "Checking again...",
                toolUse: {
                  toolUseId: "tool-loop",
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

    const agent = new BedrockSupportAgent(bedrock, { maxIterations: 3 });
    const response = await agent.respond({ message: "Loop test", model: mockModel });

    expect(bedrock.converse).toHaveBeenCalledTimes(3);
    expect(response.message).toBe("Checking again...");
  });
});
