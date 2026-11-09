# Prior-art review: is flex-mcp needed?

Date: 2026-11-09. Question: does a robust project already give an MCP
client durable, searchable custody of OpenAI flex-tier background
Responses?

## Candidates examined

### salviz/openai-mcp-server (42 tools, stdio, MIT)
https://github.com/salviz/openai-mcp-server

The closest match. Stateless stdio proxy over the whole OpenAI surface:
Responses create/get/cancel/delete/input-items, Chat, Images, Audio,
Files, Batch, Vector Stores, Fine-tune, Uploads. Supports background
mode and stored-response retrieval.

Gaps vs flex-mcp: **no durable ledger** (nothing recorded server-side;
the agent's context is the only memory), **no search** over past
submissions (no "which responses chained off resp_123?"), **no
previous_response_id lineage index**, no flex-specific surfacing
(`service_tier` is just another passthrough field, no budget/cost
awareness), stdio-only (per-machine, no shared team ledger), no
poll-and-notify (the agent must remember to re-poll).

Verdict: a good thin proxy; not a ledger. Does not obsolete flex-mcp.

### lroolle/openai-agents-mcp-server
https://github.com/lroolle/openai-agents-mcp-server

Exposes OpenAI *Agents* (assistant-style runs) as MCP tools. Wrong
abstraction layer (agents, not raw Responses), no submission ledger.

### Cloudflare MCP infrastructure (workers-mcp, mcp-server-cloudflare, Agents SDK)
https://github.com/cloudflare/workers-mcp
https://github.com/cloudflare/mcp-server-cloudflare
https://developers.cloudflare.com/agents/model-context-protocol/

Scaffolding for *building* remote MCP servers on Workers (Streamable
HTTP transport, OAuth, DO-backed state), not an OpenAI Responses
ledger. Useful as implementation substrate, not a replacement.

### OpenAI Responses API: hosted MCP tool, Batch API
https://developers.openai.com/api/docs/guides/tools
https://developers.openai.com/api/docs/guides/batch

Directionally opposite (Responses *consumes* MCP tools) or adjacent
(Batch is 24h file-based async, not interactive background Responses
with chaining). Not replacements.

## Conclusion

**Build it.** Nothing found combines: (a) remote MCP access, (b) durable
per-submission request/response byte custody, (c) lineage + status
search, (d) flex-tier background focus. The thin-proxy space is covered;
the ledger space is empty.
