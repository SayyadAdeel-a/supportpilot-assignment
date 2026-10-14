# SupportPilot AI

SupportPilot AI is an evidence-based customer support agent with Next.js, TypeScript, and Amazon Bedrock. Customers should ultimately be able to ask policy questions, retrieve their own order information, and create support tickets through a model-driven conversation.

## Technology stack

- Next.js App Router, React, and strict TypeScript
- Tailwind CSS and shadcn/ui-style source components
- Lucide React icons
- Zod request and tool validation
- AWS SDK for JavaScript v3 (`@aws-sdk/client-bedrock-runtime`)
- Amazon Bedrock Converse / ConverseStream target architecture
- Vitest, React Testing Library, ESLint, and TypeScript compiler checks

## Architecture

```text
Browser UI
   │ typed, validated POST /api/chat
   ▼
Chat route ── server model registry ── Bedrock agent (candidate task)
                                       ├── PolicyRetriever
                                       ├── lookupOrder ── OrderRepository
                                       └── createSupportTicket ── TicketRepository
```

The boundaries are intentionally replaceable:

- `src/components` contains client presentation and interaction code.
- `src/app/api` validates the HTTP boundary and returns consistent safe errors.
- `src/lib/bedrock` owns model configuration, prompts, invocation errors, and agent orchestration.
- `src/lib/knowledge` defines the policy retrieval port and a minimal local keyword baseline.
- `src/lib/tools` owns validated business operations. The model never calls repositories directly.
- `src/lib/repositories` defines persistence contracts and local implementations that can be replaced with DynamoDB adapters.
- `src/data` contains deterministic orders and policy documents.

## What is already implemented

- Responsive customer-support workspace with conversation navigation, suggested prompts, model selection, message states, retry guidance, citation and ticket card components, keyboard submission, and visible focus states.
- Server-validated chat request contract with a 4,000-character message limit and 16 KB request limit.
- Consistent JSON success/error envelope and an explicit `NOT_IMPLEMENTED` response.
- A centralized, allowlisted Bedrock model registry. Browser input selects internal keys, never arbitrary model IDs.
- Server-only Bedrock client construction using the AWS SDK credential provider chain.
- Catalog-verified model metadata for the five requested targets, with environment-driven model/profile IDs.
- Deterministic fixture orders `ORD-1001`, `ORD-1002`, and `ORD-1003`.
- Customer-scoped order repository and validated lookup operation.
- In-memory ticket repository, validated ticket creation, persistence confirmation, and deterministic idempotency handling.
- A minimal local keyword retriever over the supplied Markdown policies. It is a baseline, not a completed grounding workflow.
- Safe Bedrock invocation error normalization and a passing starter test suite.
- No AWS credentials are required to render or develop the starter. The UI and API report missing setup honestly.

## Candidate implementation tasks

The candidate is responsible for completing these core tasks:

1. **Bedrock agent orchestration** — implement `src/lib/bedrock/agent.ts` with Converse, multi-turn history, bounded model/tool loops, final response extraction, and capability-aware behavior.
2. **Retrieval and grounding** — improve or replace the local retriever, integrate it into the agent, cite supporting passages, decline unsupported policy claims, and treat retrieved text as untrusted data.
3. **Model-requested tool calling** — publish only the two allowlisted schemas, validate generated arguments with Zod, call business operations with authenticated server context, and return tool results to the model.
4. **Reliable error handling** — handle denied access, unavailable or invalid models, throttling, timeouts, service errors, unsupported capabilities, malformed output, and failed tools without leaking internal data.
5. **Tests** — add the candidate acceptance scenarios listed below. Mock AWS calls; live credentials must not be required for unit tests.

Do not let the model execute arbitrary functions, choose an arbitrary model ID, query unrestricted data, supply the customer identity, or report a business action before server persistence confirms it.

## Local setup

Requirements: a current Node.js LTS release and npm.

```bash
npm install
cp .env.example .env.local   # optional; use copy on Windows
npm run dev
```

Open [http://localhost:3000](http://localhost:3000). Without AWS configuration, the app loads normally and the chat endpoint returns `MODEL_NOT_CONFIGURED`.

## Environment configuration

Copy `.env.example` to `.env.local`. All variables are server-only; do not add `NEXT_PUBLIC_` prefixes.

| Variable | Purpose |
| --- | --- |
| `AWS_REGION` | Region used by the Bedrock Runtime client. |
| `AWS_ACCESS_KEY_ID` | Access key ID for local Bedrock testing (example value committed; replace with your own). |
| `AWS_SECRET_ACCESS_KEY` | Secret access key for local Bedrock testing (example value committed; replace with your own). |
| `BEDROCK_MODEL_ID` | Optional default model or inference profile ID for Claude Sonnet 5.5. |
| `BEDROCK_OPUS_48_MODEL_ID` | Claude Opus 4.8 configuration slot. |
| `BEDROCK_OPUS_5_MODEL_ID` | Claude Opus 5 configuration slot. |
| `BEDROCK_OPUS_55_MODEL_ID` | Claude Opus 5.5 configuration slot. |
| `BEDROCK_SONNET_55_MODEL_ID` | Claude Sonnet 5.5 configuration slot. |
| `BEDROCK_HAIKU_55_MODEL_ID` | Claude Haiku 5.5 configuration slot. |

Each value can be an official base model ID or an inference profile ID supported by the chosen Region and account. The frontend sends only a stable registry key; the server resolves the actual ID.

Credentials are resolved by the standard AWS SDK provider chain (for example, an IAM role, AWS SSO profile, or local credential configuration), or by setting the access key pair in `.env.local`. Never put access keys in browser variables or source code.

## Bedrock access and model registry

As verified against the Amazon Bedrock documentation on **October 10, 2026**, the requested names are present in the current catalog and the `bedrock-runtime` endpoint supports Converse:

| Internal key | Display name | Catalog base ID | Runtime state in this starter |
| --- | --- | --- | --- |
| `claude-opus-4-8` | Claude Opus 4.8 | `anthropic.claude-opus-4-8` | Unconfigured by default |
| `claude-opus-5` | Claude Opus 5 | `anthropic.claude-opus-5` | Unconfigured by default |
| `claude-opus-5-5` | Claude Opus 5.5 | `anthropic.claude-opus-5-5` | Unconfigured by default |
| `claude-sonnet-5-5` | Claude Sonnet 5.5 | `anthropic.claude-sonnet-5-5` | Unconfigured by default |
| `claude-haiku-5-5` | Claude Haiku 5.5 | `anthropic.claude-haiku-5-5` | Unconfigured by default |

Catalog presence does **not** prove that a model is enabled in a particular AWS account or usable from every Region. Before live testing, use the Bedrock console or `ListFoundationModels` / `ListInferenceProfiles`, accept any required marketplace terms, confirm regional routing and data-residency needs, and grant the runtime identity only the required `bedrock:InvokeModel` / streaming permissions. Do not silently fall back to another model.

Useful current AWS references:

- [Models at a glance](https://docs.aws.amazon.com/bedrock/latest/userguide/model-cards.html)
- [API compatibility](https://docs.aws.amazon.com/bedrock/latest/userguide/models-api-compatibility.html)
- [Regional availability](https://docs.aws.amazon.com/bedrock/latest/userguide/models-region-compatibility.html)
- [Inference profile support](https://docs.aws.amazon.com/bedrock/latest/userguide/inference-profiles-support.html)

Because AWS updates the catalog, re-check these sources at implementation time rather than assuming the table remains current.

## Commands

```bash
npm run dev        # local development server
npm run build      # production build
npm start          # serve the production build
npm run lint       # ESLint
npm run typecheck  # strict TypeScript check
npm test           # starter Vitest suite
```

## HTTP contract

`POST /api/chat`

```json
{
  "conversationId": "optional-uuid",
  "message": "Where is my order ORD-1002?",
  "modelKey": "claude-sonnet-5-5"
}
```

Success uses `{ "ok": true, "data": ... }`; errors use:

```json
{
  "ok": false,
  "error": {
    "code": "MODEL_NOT_CONFIGURED",
    "message": "Safe user-facing explanation",
    "retryable": false
  }
}
```

After a model is configured but before the candidate implements the agent, the endpoint returns HTTP 501 with `NOT_IMPLEMENTED`. Malformed input is rejected before model access.

## Mock data and persistence

The order fixture belongs to a single mock identity, `mock-customer-001`. This is a development assumption only; there is no login system in the starter. Repository lookup requires a server-provided customer ID so a generated tool argument cannot bypass customer scoping.

Tickets persist only in process memory and disappear when the server restarts. The repository waits for creation and returns the stored ticket before success can be reported. A SHA-256 idempotency key deduplicates identical local requests. In production, enforce idempotency atomically in DynamoDB and scope it by authenticated customer and operation.

Conversation persistence is represented by an interface and local implementation but is not wired into the route. A DynamoDB adapter can replace each local repository without changing the UI or agent-facing business operations. Lambda may optionally isolate tool execution, but is not required for the baseline.

## Retrieval and Bedrock Knowledge Bases

`LocalPolicyRetriever` provides a small deterministic keyword baseline so the starter can exercise policy files without external infrastructure. It does not produce complete answers and is not integrated into the unfinished agent.

For a managed implementation, add a `PolicyRetriever` adapter backed by Amazon Bedrock Knowledge Bases and store source documents in S3. Preserve the same `PolicyPassage` result shape, including source title, path/URI, excerpt, content, and relevance metadata. Apply authorization filters where policies are not public and keep retrieved text separated from system instructions.

## Security assumptions

- Mock repositories are not production authentication, authorization, persistence, or auditing.
- Customer identity must come from verified server session context in a real deployment.
- Model text and model-generated tool arguments are untrusted.
- Tool names are allowlisted and arguments are Zod-validated on the server.
- Retrieved documents are evidence, not system instructions.
- AWS credentials and model configuration remain server-side.
- Responses and logs must omit stack traces, prompts, credentials, and unnecessary customer data.
- Use timeouts, bounded tool iterations, request limits, least-privilege IAM, and rate limiting in production.
- A real persistence layer should use conditional writes for ticket idempotency and authorization.

## Required candidate deliverables

- Working agent implementation with a configured and accessible Bedrock target.
- Policy-grounded answers with source citations.
- Safe order lookup and support ticket tool flows.
- Clear handling for missing evidence and all documented error classes.
- Tests for the implemented workflows, with Bedrock mocked by default.
- A short design note describing tradeoffs, production hardening, and any incomplete items.
- No credentials, generated secrets, or personal data in the submitted repository.

## Acceptance criteria

Automated or evaluator-driven scenarios should cover:

- A supported policy question produces an evidence-grounded answer with relevant citations.
- An unsupported policy question explicitly says evidence is insufficient.
- A model-requested lookup returns the authorized fixture order and never invents fields.
- A missing or unauthorized order produces a safe not-found result without revealing existence.
- A support ticket reports success only after the repository returns its real ID and status.
- A failed tool execution is surfaced safely and does not become a fabricated success.
- Access denied, invocation failure, timeout, throttling, and unavailable model configuration are mapped to useful errors.
- An arbitrary model ID or arbitrary tool/function cannot be selected by browser or model output.
- Multi-turn state remains isolated by conversation and execution loops are bounded.
- The starter and candidate test suites pass without live AWS credentials.

## Optional stretch goals

- ConverseStream with cancellation and incremental accessible rendering.
- A model lab that runs identical fixtures across configured models and shows measured latency, token usage, tool calls, citations, and errors side by side. Never invent unavailable metrics.
- DynamoDB repositories with conditional writes and customer-scoped keys.
- A Lambda tool-execution boundary.
- Amazon Bedrock Knowledge Bases adapter and retrieval evaluation fixtures.
- Observability with redaction, request correlation, and cost/latency dashboards.

## Scope guidance

Prioritize a correct, bounded orchestration loop, evidence quality, backend authorization, and failure behavior over infrastructure breadth. A clean single-process implementation is preferable to unnecessary services for a 6–8 hour assignment.
