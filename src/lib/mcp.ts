/**
 * MCP server factory (`src/lib/mcp.ts`) — registers the eight flex tools
 * (see `docs/ARCHITECTURE.md` §5) on a fresh `McpServer` per request.
 *
 * Served by `createMcpHandler` from the bare `@modelcontextprotocol/server`
 * v2 SDK over legacy-stateless Streamable HTTP (see
 * `docs/TRANSPORT_DECISION.md`; no `agents` framework). Each handler is a
 * thin zod-validated adapter over `src/handlers/tools.ts`, which owns the
 * Worker-side OpenAI I/O and LedgerDO RPC.
 */

import { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import {
  handleFlexCancel,
  handleFlexChildren,
  handleFlexDelete,
  handleFlexGet,
  handleFlexList,
  handleFlexStatus,
  handleFlexSubmit,
  handleFlexUsage,
} from "../handlers/tools.ts";

const SUBMISSION_STATUSES = [
  "submitted",
  "queued",
  "in_progress",
  "completed",
  "failed",
  "cancelled",
  "incomplete",
] as const;

const SERVICE_TIERS = ["auto", "default", "flex"] as const;

const responseIdField = z.string().min(1, "response_id must be a non-empty string");

const cursorField = z.string().nullable().optional();
const limitField = z.number().int().min(1).max(100).nullable().optional();
const statusFilterField = z.enum(SUBMISSION_STATUSES).optional();

/** `flex_submit` input (ARCH §5; `background` in `extras` rejected by the builder). */
const flexSubmitSchema = z.object({
  model: z.string().min(1),
  input: z.union([z.string(), z.array(z.unknown())]),
  reasoning: z.record(z.string(), z.unknown()).optional(),
  reasoning_effort: z.string().optional(),
  previous_response_id: z.string().min(1).optional(),
  service_tier: z.enum(SERVICE_TIERS).optional(),
  max_output_tokens: z.number().int().positive().optional(),
  store: z.boolean().optional(),
  metadata: z.record(z.string(), z.string()).optional(),
  tools: z.array(z.unknown()).optional(),
  tool_choice: z.unknown().optional(),
  extras: z.record(z.string(), z.unknown()).optional(),
});

/** `flex_status` input. */
const flexStatusSchema = z.object({
  response_id: responseIdField,
});

/** `flex_children` input. */
const flexChildrenSchema = z.object({
  response_id: responseIdField,
  cursor: cursorField,
  limit: limitField,
});

/** `flex_get` input. */
const flexGetSchema = z.object({
  response_id: responseIdField,
  envelopes: z.boolean().optional(),
});

/** `flex_list` input. */
const flexListSchema = z.object({
  status: statusFilterField,
  model: z.string().min(1).optional(),
  limit: limitField,
  cursor: cursorField,
});

/** `flex_cancel` input. */
const flexCancelSchema = z.object({
  response_id: responseIdField,
});

/** `flex_delete` input. */
const flexDeleteSchema = z.object({
  response_id: responseIdField,
});

/** `flex_usage` input. */
const flexUsageSchema = z.object({
  day: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, "day must be YYYY-MM-DD")
    .optional(),
  model: z.string().min(1).optional(),
  status: statusFilterField,
});

/**
 * Builds a fresh `McpServer` with the eight flex tools registered. Called
 * once per HTTP request by `createMcpHandler`.
 */
export function createFlexServer(env: Env): McpServer {
  const server = new McpServer({ name: "flex-mcp", version: "0.0.0" });

  server.registerTool(
    "flex_submit",
    {
      description:
        "Submit a background flex-tier Responses request; returns {response_id, status}.",
      inputSchema: flexSubmitSchema,
    },
    async (args) => handleFlexSubmit(env, args),
  );

  server.registerTool(
    "flex_status",
    {
      description:
        "Read a submission; live-refreshes non-terminal rows. Returns {response_id, status, model, usage, error, observed_at_ms, refreshed}.",
      inputSchema: flexStatusSchema,
    },
    async (args) => handleFlexStatus(env, args),
  );

  server.registerTool(
    "flex_children",
    {
      description: "List submissions with previous_response_id = id, newest first.",
      inputSchema: flexChildrenSchema,
    },
    async (args) => handleFlexChildren(env, args),
  );

  server.registerTool(
    "flex_get",
    {
      description:
        "Extract output text from the stored response envelope; envelopes=true returns raw {request, response} JSON.",
      inputSchema: flexGetSchema,
    },
    async (args) => handleFlexGet(env, args),
  );

  server.registerTool(
    "flex_list",
    {
      description: "Newest-first page of blob-free submission summaries.",
      inputSchema: flexListSchema,
    },
    async (args) => handleFlexList(env, args),
  );

  server.registerTool(
    "flex_cancel",
    {
      description: "Cancel an in-flight response (refused unless submitted|queued|in_progress).",
      inputSchema: flexCancelSchema,
    },
    async (args) => handleFlexCancel(env, args),
  );

  server.registerTool(
    "flex_delete",
    {
      description: "Delete a terminal submission row and blobs (refused while in-flight).",
      inputSchema: flexDeleteSchema,
    },
    async (args) => handleFlexDelete(env, args),
  );

  server.registerTool(
    "flex_usage",
    {
      description:
        "Token sums grouped by day/model/status; estimated spend is null (pricing unknown).",
      inputSchema: flexUsageSchema,
    },
    async (args) => handleFlexUsage(env, args),
  );

  return server;
}
