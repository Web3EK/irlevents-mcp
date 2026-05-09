#!/usr/bin/env node
// IRLEvents MCP Server
//
// Exposes the IRLEvents agent-callable API as Model Context Protocol tools so
// Claude Desktop, Claude Code, Cursor, Cline, and other MCP-compatible clients
// can read and act on a user's behalf with their api_* key.
//
// Configure in claude_desktop_config.json:
//   {
//     "mcpServers": {
//       "irlevents": {
//         "command": "npx",
//         "args": ["-y", "irlevents-mcp"],
//         "env": { "IRLEVENTS_API_KEY": "api_..." }
//       }
//     }
//   }

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

import { createClient, IRLApiError } from "./client.js";

const apiKey = process.env.IRLEVENTS_API_KEY;
if (!apiKey) {
  console.error(
    "irlevents-mcp: IRLEVENTS_API_KEY env var is required.\n" +
      "Mint a key at https://irlevents.io/profile (API Keys tab) and pass it as:\n" +
      '  { "env": { "IRLEVENTS_API_KEY": "api_..." } }\n' +
      "in your MCP client config.",
  );
  process.exit(1);
}

const client = createClient({
  apiKey,
  base: process.env.IRLEVENTS_API_BASE,
});

const server = new McpServer(
  { name: "irlevents-mcp", version: "0.1.0" },
  {
    capabilities: { tools: {} },
    instructions:
      "Tools for the IRLEvents token-gated event platform. Use list_events / " +
      "trending_events / get_event to discover; check_eligibility before any " +
      "rsvp_event call (the API will reject ineligible users). Use sync_my_assets " +
      "sparingly — it hits external NFT providers and is slow.",
  },
);

// ----- Helpers ----------------------------------------------------------

function ok(data: unknown) {
  return {
    content: [
      {
        type: "text" as const,
        text: typeof data === "string" ? data : JSON.stringify(data, null, 2),
      },
    ],
  };
}

function err(e: unknown) {
  if (e instanceof IRLApiError) {
    return {
      isError: true,
      content: [
        {
          type: "text" as const,
          text: `IRLEvents API error ${e.status}${e.code ? ` (${e.code})` : ""}: ${e.message}`,
        },
      ],
    };
  }
  const msg = e instanceof Error ? e.message : String(e);
  return {
    isError: true,
    content: [{ type: "text" as const, text: `Error: ${msg}` }],
  };
}

async function handle<T>(fn: () => Promise<T>) {
  try {
    return ok(await fn());
  } catch (e) {
    return err(e);
  }
}

// ----- Discovery tools (no user-context needed) -------------------------

server.registerTool(
  "list_events",
  {
    title: "List events",
    description:
      "List public IRLEvents events. Filter by category, city, chain, or date range. " +
      "Returns a paginated list of event summaries.",
    inputSchema: {
      category: z.string().optional().describe("e.g. 'conference', 'meetup', 'workshop'"),
      city: z.string().optional().describe("City name, e.g. 'Las Vegas'"),
      chainId: z.number().int().optional().describe("EVM chain id, e.g. 1, 137, 8453"),
      from: z.string().optional().describe("ISO 8601 date — events starting on/after this"),
      to: z.string().optional().describe("ISO 8601 date — events starting on/before this"),
      limit: z.number().int().min(1).max(100).optional().default(20),
      offset: z.number().int().min(0).optional().default(0),
    },
    annotations: { readOnlyHint: true, openWorldHint: true },
  },
  async (args) => handle(() => client.request("/api/events", { query: args })),
);

server.registerTool(
  "trending_events",
  {
    title: "Trending events",
    description:
      "Most RSVPed events in the last 14 days. Fast, public, cached. Good first call " +
      "to surface what's happening right now.",
    inputSchema: {},
    annotations: { readOnlyHint: true, openWorldHint: true },
  },
  async () => handle(() => client.request("/api/events/trending")),
);

server.registerTool(
  "get_event",
  {
    title: "Get event details",
    description:
      "Fetch a single event by its short id (e.g. '7s5TZhMQqrCs'). Returns title, " +
      "description, dates, location, capacity, host, and the full gates config.",
    inputSchema: {
      eventId: z.string().describe("Public event short id"),
    },
    annotations: { readOnlyHint: true, openWorldHint: true },
  },
  async ({ eventId }) =>
    handle(() => client.request(`/api/events/${encodeURIComponent(eventId)}`)),
);

server.registerTool(
  "top_creators",
  {
    title: "Top creators leaderboard",
    description: "Top creators on IRLEvents ranked by RSVPs and events hosted.",
    inputSchema: {},
    annotations: { readOnlyHint: true, openWorldHint: true },
  },
  async () => handle(() => client.request("/api/creators/leaderboard")),
);

server.registerTool(
  "platform_stats",
  {
    title: "Platform stats",
    description: "Cached platform-wide counts: events, RSVPs, creators, chains active.",
    inputSchema: {},
    annotations: { readOnlyHint: true, openWorldHint: true },
  },
  async () => handle(() => client.request("/api/stats/public")),
);

// ----- User-context tools (act on the api key owner) --------------------

server.registerTool(
  "get_my_profile",
  {
    title: "Get my profile",
    description:
      "Read the api-key owner's IRLEvents profile: display name, bio, wallets across " +
      "every connected chain, and the cached on-chain assets snapshot. " +
      "If `assetsUpdatedAt` is stale, call sync_my_assets.",
    inputSchema: {},
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  async () => handle(() => client.request("/api/profile")),
);

server.registerTool(
  "sync_my_assets",
  {
    title: "Sync my on-chain assets",
    description:
      "Force-refresh the user's NFT/token holdings across every connected chain. " +
      "SLOW (5–30s) and resource-heavy — hits Alchemy / Helius / Hiro. " +
      "Don't poll. Once per session is fine; rely on cached `Profile.assets` otherwise.",
    inputSchema: {},
    annotations: { readOnlyHint: false, openWorldHint: false, idempotentHint: true },
  },
  async () => handle(() => client.request("/api/profile/assets/sync", { method: "POST" })),
);

server.registerTool(
  "check_eligibility",
  {
    title: "Check event eligibility",
    description:
      "Check whether the api-key owner satisfies any gate group on the given event. " +
      "Always call this before rsvp_event — the API will reject ineligible users with 403. " +
      "Returns { eligible, reason, matchedGroupId }.",
    inputSchema: {
      eventId: z.string().describe("Public event short id"),
    },
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  async ({ eventId }) =>
    handle(() => client.request(`/api/events/${encodeURIComponent(eventId)}/eligibility`)),
);

server.registerTool(
  "rsvp_status",
  {
    title: "Get my RSVP status for an event",
    description:
      "Returns whether the user has RSVPed to this event, plus check-in status and " +
      "which gate group they qualified through.",
    inputSchema: {
      eventId: z.string().describe("Public event short id"),
    },
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  async ({ eventId }) =>
    handle(() => client.request(`/api/events/${encodeURIComponent(eventId)}/rsvp/status`)),
);

server.registerTool(
  "rsvp_event",
  {
    title: "RSVP to an event",
    description:
      "Create an RSVP for the api-key owner. Re-checks eligibility, locks the qualifying " +
      "token in Redis (5-min TTL), and returns a check-in token. Failure modes: " +
      "NOT_ELIGIBLE (403), TOKEN_LOCKED (409, qualifying NFT used elsewhere), " +
      "ALREADY_RSVPED (409), EVENT_FULL (410), EVENT_PAST (410). " +
      "Always call check_eligibility first.",
    inputSchema: {
      eventId: z.string().describe("Public event short id"),
    },
    annotations: { readOnlyHint: false, openWorldHint: false, destructiveHint: false },
  },
  async ({ eventId }) =>
    handle(() =>
      client.request(`/api/events/${encodeURIComponent(eventId)}/rsvp`, {
        method: "POST",
        body: JSON.stringify({}),
      }),
    ),
);

server.registerTool(
  "cancel_rsvp",
  {
    title: "Cancel an RSVP",
    description:
      "Cancel the api-key owner's RSVP for this event. Frees the locked token so it " +
      "can be reused for another event in the same window.",
    inputSchema: {
      eventId: z.string().describe("Public event short id"),
    },
    annotations: { readOnlyHint: false, openWorldHint: false, destructiveHint: true },
  },
  async ({ eventId }) =>
    handle(() =>
      client.request(`/api/events/${encodeURIComponent(eventId)}/rsvp`, {
        method: "DELETE",
      }),
    ),
);

server.registerTool(
  "my_eligible_events",
  {
    title: "My eligible events",
    description:
      "List every public event the given wallet currently qualifies for, based on its " +
      "cached on-chain assets. Pass the user's primary wallet address (lowercased EVM, " +
      "or chain-native for non-EVM).",
    inputSchema: {
      wallet: z.string().describe("Wallet address (EVM lowercased, or Solana/BTC native)"),
    },
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  async ({ wallet }) =>
    handle(() =>
      client.request(`/api/users/${encodeURIComponent(wallet)}/events/eligible`),
    ),
);

// ----- Host tools (require events:write scope) -------------------------

server.registerTool(
  "create_event",
  {
    title: "Create an event",
    description:
      "Create a new event hosted by the api-key owner. Requires the `events:write` scope. " +
      "Subject to the user's subscription tier limits (free / pro / business). " +
      "At minimum supply title, date, and location; everything else is optional. " +
      "Token gates can be added at create time via the `gates` field or set later via update_event.",
    inputSchema: {
      title: z.string().describe("Event title"),
      date: z.string().describe("ISO date YYYY-MM-DD"),
      location: z.string().describe("Human-readable location, e.g. 'Las Vegas, NV' or a venue name"),
      description: z.string().optional(),
      endDate: z.string().optional().describe("ISO date for multi-day events"),
      time: z.string().optional().describe("Start time, e.g. '6:00 PM'"),
      endTime: z.string().optional(),
      timezone: z.string().optional().describe("IANA timezone e.g. 'America/Los_Angeles'"),
      venueName: z.string().optional(),
      capacity: z.number().int().optional(),
      category: z.string().optional().describe("e.g. 'meetup', 'conference', 'workshop'"),
      imageUrl: z.string().optional(),
      gates: z
        .object({
          mode: z.enum(["any", "all"]).optional(),
          groups: z.array(z.any()),
        })
        .optional()
        .describe("Token gate config — see /api/guides/agent-guide for the schema"),
    },
    annotations: { readOnlyHint: false, openWorldHint: false, destructiveHint: false },
  },
  async (args) =>
    handle(() =>
      client.request("/api/events", { method: "POST", body: JSON.stringify(args) }),
    ),
);

server.registerTool(
  "update_event",
  {
    title: "Update an event",
    description:
      "Update fields on an event the api-key owner hosts (or co-hosts). Requires `events:write`. " +
      "Send only the fields you want to change — omitted fields are left untouched.",
    inputSchema: {
      eventId: z.string().describe("Event short id"),
      title: z.string().optional(),
      description: z.string().optional(),
      date: z.string().optional(),
      endDate: z.string().optional(),
      time: z.string().optional(),
      endTime: z.string().optional(),
      timezone: z.string().optional(),
      location: z.string().optional(),
      venueName: z.string().optional(),
      capacity: z.number().int().optional(),
      category: z.string().optional(),
      imageUrl: z.string().optional(),
      gates: z
        .object({
          mode: z.enum(["any", "all"]).optional(),
          groups: z.array(z.any()),
        })
        .optional(),
    },
    annotations: { readOnlyHint: false, openWorldHint: false, destructiveHint: false, idempotentHint: true },
  },
  async ({ eventId, ...patch }) =>
    handle(() =>
      client.request(`/api/events/${encodeURIComponent(eventId)}`, {
        method: "PUT",
        body: JSON.stringify(patch),
      }),
    ),
);

server.registerTool(
  "delete_event",
  {
    title: "Delete an event",
    description:
      "Permanently delete an event the api-key owner hosts. Requires `events:write`. " +
      "DESTRUCTIVE — RSVPs and check-ins are removed too. Prefer updating `status` to 'cancelled' " +
      "(via update_event) if you want to keep the record for attendees.",
    inputSchema: {
      eventId: z.string().describe("Event short id"),
    },
    annotations: { readOnlyHint: false, openWorldHint: false, destructiveHint: true },
  },
  async ({ eventId }) =>
    handle(() =>
      client.request(`/api/events/${encodeURIComponent(eventId)}`, { method: "DELETE" }),
    ),
);

server.registerTool(
  "checkin_attendee",
  {
    title: "Check in an attendee",
    description:
      "Mark an attendee as checked in at the door. Requires `events:write`. " +
      "Caller must be the event host or a designated check-in staff member. " +
      "Identify the attendee by their wallet address (the `userId` on their RSVP record).",
    inputSchema: {
      eventId: z.string().describe("Event short id"),
      wallet: z.string().describe("Attendee wallet address (EVM lowercased, or chain-native)"),
    },
    annotations: { readOnlyHint: false, openWorldHint: false, destructiveHint: false, idempotentHint: true },
  },
  async ({ eventId, wallet }) =>
    handle(() =>
      client.request(`/api/events/${encodeURIComponent(eventId)}/checkin`, {
        method: "POST",
        body: JSON.stringify({ wallet }),
      }),
    ),
);

// ----- Boot -------------------------------------------------------------

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error(
    `irlevents-mcp v0.2.0 ready (base: ${client.base}). Awaiting MCP requests on stdio.`,
  );
}

main().catch((e) => {
  console.error("irlevents-mcp fatal:", e);
  process.exit(1);
});
