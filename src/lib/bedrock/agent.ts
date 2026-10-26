import { formatEvidenceForPrompt, LocalPolicyRetriever } from "@/lib/knowledge/retrieve";
import type { PolicyRetriever } from "@/lib/knowledge/types";
import { FixtureOrderRepository, type OrderRepository } from "@/lib/repositories/orders";
import { InMemoryTicketRepository, type TicketRepository } from "@/lib/repositories/tickets";
import { createSupportTicket } from "@/lib/tools/create-support-ticket";
import { lookupOrder } from "@/lib/tools/lookup-order";
import { createSupportTicketInputSchema, lookupOrderInputSchema } from "@/lib/tools/schemas";
import type { SourceCitation, TicketSummary } from "@/types";
import { invokeConverse } from "./invoke";
import { SUPPORT_SYSTEM_PROMPT } from "./prompts";
import {
  AgentNotImplementedError,
  type AgentRequest,
  type AgentResponse,
  type BedrockConversePort,
} from "./types";

export interface SupportAgent {
  respond(request: AgentRequest): Promise<AgentResponse>;
}

export interface BedrockSupportAgentOptions {
  retriever?: PolicyRetriever;
  orders?: OrderRepository;
  tickets?: TicketRepository;
  customerId?: string;
  maxIterations?: number;
}

export const SUPPORT_TOOL_CONFIG = {
  tools: [
    {
      toolSpec: {
        name: "lookupOrder",
        description: "Look up current status, items, and delivery estimate for an authorized order by ID.",
        inputSchema: {
          json: {
            type: "object",
            properties: {
              orderId: {
                type: "string",
                description: "Order ID in the format ORD-XXXX (e.g. ORD-1001)",
              },
            },
            required: ["orderId"],
          },
        },
      },
    },
    {
      toolSpec: {
        name: "createSupportTicket",
        description: "Create a customer support ticket for an order with a category and issue description.",
        inputSchema: {
          json: {
            type: "object",
            properties: {
              orderId: {
                type: "string",
                description: "Order ID in the format ORD-XXXX (e.g. ORD-1001)",
              },
              category: {
                type: "string",
                enum: ["damaged_item", "delivery_issue", "refund_request", "other"],
                description: "The category of the customer issue",
              },
              description: {
                type: "string",
                description: "Detailed explanation of the issue (10 to 1000 characters)",
              },
            },
            required: ["orderId", "category", "description"],
          },
        },
      },
    },
  ],
};

interface ConverseContentBlock {
  text?: string;
  toolUse?: {
    toolUseId: string;
    name: string;
    input: unknown;
  };
  toolResult?: {
    toolUseId: string;
    content: Array<{ json?: unknown; text?: string }>;
    status?: "success" | "error";
  };
}

interface ConverseMessage {
  role: "user" | "assistant";
  content: ConverseContentBlock[];
}

interface ConverseApiResponse {
  output?: {
    message?: ConverseMessage;
  };
  stopReason?: string;
}

export class BedrockSupportAgent implements SupportAgent {
  private readonly retriever: PolicyRetriever;
  private readonly orders: OrderRepository;
  private readonly tickets: TicketRepository;
  private readonly customerId: string;
  private readonly maxIterations: number;

  constructor(
    private readonly bedrock: BedrockConversePort,
    options: BedrockSupportAgentOptions = {},
  ) {
    this.retriever = options.retriever ?? new LocalPolicyRetriever();
    this.orders = options.orders ?? new FixtureOrderRepository();
    this.tickets = options.tickets ?? new InMemoryTicketRepository();
    this.customerId = options.customerId ?? "mock-customer-001";
    this.maxIterations = options.maxIterations ?? 5;
  }

  async respond(request: AgentRequest): Promise<AgentResponse> {
    const modelId = request.model.configuredModelId;
    if (!modelId) {
      throw new Error(`Model ${request.model.displayName} is missing a configured model ID.`);
    }

    const passages = await this.retriever.retrieve(request.message);
    const citations: SourceCitation[] = passages.map(({ id, title, path, excerpt }) => ({
      id,
      title,
      path,
      excerpt,
    }));

    const evidencePrompt = formatEvidenceForPrompt(passages);
    const systemPrompt = evidencePrompt
      ? `${SUPPORT_SYSTEM_PROMPT}\n\n${evidencePrompt}`
      : SUPPORT_SYSTEM_PROMPT;

    const messages: ConverseMessage[] = [
      {
        role: "user",
        content: [{ text: request.message }],
      },
    ];

    let lastAssistantText = "";
    let capturedTicket: TicketSummary | undefined;
    let iterations = 0;

    while (iterations < this.maxIterations) {
      iterations += 1;

      const payload = {
        modelId,
        system: [{ text: systemPrompt }],
        messages,
        toolConfig: SUPPORT_TOOL_CONFIG,
      };

      const rawResponse = await invokeConverse(this.bedrock, payload);
      const response = rawResponse as ConverseApiResponse | undefined;
      const outputMessage = response?.output?.message;
      const stopReason = response?.stopReason;

      const contentBlocks = outputMessage?.content ?? [];
      const textBlocks = contentBlocks
        .filter((block): block is { text: string } => typeof block.text === "string" && block.text.trim().length > 0)
        .map((block) => block.text);

      if (textBlocks.length > 0) {
        lastAssistantText = textBlocks.join("\n\n");
      }

      const toolUses = contentBlocks
        .filter((block): block is { toolUse: { toolUseId: string; name: string; input: unknown } } =>
          Boolean(block.toolUse && typeof block.toolUse.toolUseId === "string" && typeof block.toolUse.name === "string"),
        )
        .map((block) => block.toolUse);

      if (stopReason === "tool_use" || toolUses.length > 0) {
        messages.push({
          role: "assistant",
          content: contentBlocks,
        });

        const toolResultBlocks: ConverseContentBlock[] = [];

        for (const toolUse of toolUses) {
          const result = await this.executeTool(toolUse);
          if (result.ticket) {
            capturedTicket = result.ticket;
          }
          toolResultBlocks.push({
            toolResult: {
              toolUseId: toolUse.toolUseId,
              content: [{ json: result.data }],
              status: result.status,
            },
          });
        }

        messages.push({
          role: "user",
          content: toolResultBlocks,
        });

        continue;
      }

      break;
    }

    const message =
      lastAssistantText ||
      "I was unable to complete the request within the allowed execution limit. Please try again or rephrase your question.";

    return {
      message,
      citations,
      ...(capturedTicket ? { ticket: capturedTicket } : {}),
    };
  }

  private async executeTool(toolUse: { toolUseId: string; name: string; input: unknown }): Promise<{
    data: unknown;
    status: "success" | "error";
    ticket?: TicketSummary;
  }> {
    if (toolUse.name === "lookupOrder") {
      const parsed = lookupOrderInputSchema.safeParse(toolUse.input);
      if (!parsed.success) {
        return {
          data: { error: `Validation error: ${parsed.error.issues.map((i) => i.message).join(", ")}` },
          status: "error",
        };
      }
      try {
        const orderResult = await lookupOrder(parsed.data, {
          customerId: this.customerId,
          orders: this.orders,
        });
        return { data: orderResult, status: "success" };
      } catch {
        return { data: { error: "Failed to look up order." }, status: "error" };
      }
    }

    if (toolUse.name === "createSupportTicket") {
      const parsed = createSupportTicketInputSchema.safeParse(toolUse.input);
      if (!parsed.success) {
        return {
          data: { error: `Validation error: ${parsed.error.issues.map((i) => i.message).join(", ")}` },
          status: "error",
        };
      }
      try {
        const ticketResult = await createSupportTicket(parsed.data, {
          customerId: this.customerId,
          orders: this.orders,
          tickets: this.tickets,
        });

        let ticket: TicketSummary | undefined;
        if (ticketResult.created) {
          ticket = {
            ticketId: ticketResult.ticketId,
            status: ticketResult.status as "open" | "in_progress" | "resolved",
            category: parsed.data.category,
          };
        }

        return { data: ticketResult, status: "success", ticket };
      } catch {
        return { data: { error: "Failed to create support ticket." }, status: "error" };
      }
    }

    return {
      data: { error: `Tool "${toolUse.name}" is not allowlisted.` },
      status: "error",
    };
  }
}

export const placeholderAgent: SupportAgent = {
  async respond() {
    throw new AgentNotImplementedError();
  },
};
