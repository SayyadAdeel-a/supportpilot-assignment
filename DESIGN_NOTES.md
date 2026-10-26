# SupportPilot AI — Production Design Notes

## 1. Architecture & Agent Orchestration

SupportPilot AI enforces a strict multi-tier separation of concerns across presentation, boundary validation, model orchestration, and domain persistence:

```text
Browser UI (React 19 / Next.js)
   │ POST /api/chat (Validated via Zod; 16 KB / 4,000 char limits)
   ▼
Route Handler (`src/app/api/chat/route.ts`)
   │ Resolves internal model key -> server model ID
   ▼
BedrockSupportAgent (`src/lib/bedrock/agent.ts`)
   ├── LocalPolicyRetriever (Semantic chunking, stemming, grounded scoring)
   ├── Bedrock Converse Loop (Bounded at maxIterations = 5)
   │     ├── lookupOrder (`src/lib/tools/lookup-order.ts`) ── OrderRepository
   │     └── createSupportTicket (`src/lib/tools/create-support-ticket.ts`) ── TicketRepository
   ▼
Typed AgentResponse ({ message, citations, ticket })
```

### Converse Loop Design
- **Bounded Iterations**: Tool execution loops are strictly capped (`maxIterations = 5`, configurable via options) to prevent runaway model execution or cycle recursion.
- **Linear State Machine**: The agent handles `stopReason === "tool_use"`, executes validated tools in sequence, appends `toolResult` blocks as user turns, and returns when the model yields `stopReason === "end_turn"`.
- **Fail-Safe Finalization**: If iteration limits are reached without `end_turn`, the agent finalizes with the latest accumulated assistant message or a polite fallback message without dropping state.

---

## 2. Security & Boundary Defenses

### Untrusted Data Separation & Prompt Injection Defense
- Retrieved Markdown documents are treated strictly as untrusted external reference data, never as system instructions.
- Passages injected into the prompt are wrapped in `<policy_evidence>` blocks preceded by explicit system directives informing the model to disregard embedded commands.
- To prevent prompt injection breakouts, all closing tags (`</passage>`, `</policy_evidence>`) in document content are sanitized and disarmed, and XML attributes are escaped.

### Server-Enforced Customer Authorization
- Customer identity (`mock-customer-001`) is injected exclusively by server context into repository lookups and mutations.
- The model's tool schema exposes only `orderId`, `category`, and `description`. Neither the client nor the model has access to pass or override `customerId`.
- Cross-tenant lookups (e.g. customer A querying customer B's order) yield `{ found: false }` to prevent timing or existence enumeration attacks.

### Strict Allowlisting
- **Model Registry**: The browser sends only approved internal model keys (e.g. `claude-sonnet-5-5`). Arbitrary model IDs in request bodies are rejected at the API boundary with HTTP 400.
- **Tool Allowlist**: The agent accepts only `lookupOrder` and `createSupportTicket`. Model outputs requesting unallowlisted tools are intercepted and answered with an error `toolResult` without executing external code.

### Input Validation
- All model-generated tool arguments are parsed with strict Zod schemas (`lookupOrderInputSchema`, `createSupportTicketInputSchema`) before dispatching to domain services. Schema validation failures return structured error blocks to the model so it can correct its input.

---

## 3. Evidence Grounding & Fallback Behavior

### Retrieval & Relevance Scoring
- Documents are split into logical paragraphs while preserving structural context and document metadata (`id`, `title`, `path`, `excerpt`).
- Query evaluation tokenizes input, removes conversational stop words, and applies suffix stemming (`-s`, `-es`, `-ed`, `-ing`, `-ies`) to support morphological inflections without heavy NLP runtimes.
- Relevance scoring weights content overlap (50%), document title matches (30%), and document-level grounding (20%).
- Single incidental words (e.g. "weather" appearing in `shipping.md`) require title grounding or document term frequency $\ge 2$ to prevent irrelevant retrievals.

### Declining Unsupported Claims
- Queries falling below `DEFAULT_MIN_SCORE` (`0.30`) return an empty array `[]`.
- System prompts instruct the model to explicitly decline unsupported policy claims rather than extrapolate or hallucinate.

### Citation Integrity
- Source citations (`id`, `title`, `path`, `excerpt`) are returned in `AgentResponse.citations` and visually rendered via expandable details components in the client conversation thread.

---

## 4. Idempotency & Persistence

### Deterministic Ticket Deduplication
- `createSupportTicket` generates a SHA-256 idempotency key over `customerId:orderId:category:description`.
- If an existing ticket matches the idempotency key, the repository returns the existing record with `duplicate: true`.

### Verified State Mutation
- The agent populates `ticket` metadata in `AgentResponse` only when server persistence confirms creation with a genuine `TKT-...` identifier and status. The model cannot fabricate successful ticket creation without backend verification.

---

## 5. Production Hardening Path (Roadmap & Tradeoffs)

| Component | Starter / Prototype | Production Target |
|---|---|---|
| **Persistence** | `InMemoryTicketRepository` & `FixtureOrderRepository` | **Amazon DynamoDB**: Distributed single-table design with customer-partitioned keys (`PK=CUST#<id>`, `SK=TKT#<id>`) and atomic conditional writes (`attribute_not_exists(idempotencyKey)`). |
| **Retrieval** | In-memory `LocalPolicyRetriever` | **Amazon Bedrock Knowledge Bases**: Backed by Amazon OpenSearch Serverless and S3 using `amazon.titan-embed-text-v2` for dense vector search with hybrid keyword retrieval and tenancy metadata filters. |
| **Streaming** | Request/response JSON | **ConverseStream**: Server-Sent Events (SSE) streaming model tokens via `ConverseStreamCommand` for immediate first-token responsiveness while handling tool calls asynchronously. |
| **Telemetry & Observability** | Console logs | **AWS CloudWatch & OpenTelemetry**: Distributed tracing across Bedrock API calls, model token usage, latency metrics, and automated PII redaction via AWS Comprehend. |
| **Authentication** | Hardcoded mock identity (`mock-customer-001`) | **JWT / Session Verification**: Customer identity derived from validated session cookies (e.g. AWS Cognito, NextAuth, or enterprise IdP) at the edge. |

---

## 6. Clean Hygiene Audit

- **Environment & Secrets**: `.gitignore` strictly ignores `.env`, `.env.*` (allowing only `.env.example`), `*.pem`, and `.aws/`.
- **Zero Committed Secrets**: Repository audit confirms no real AWS access keys, secret keys, or customer PII are committed in tracked files.
- **Offline Test Suite**: All unit, integration, and acceptance tests run with zero external network connectivity or cloud credentials required.
