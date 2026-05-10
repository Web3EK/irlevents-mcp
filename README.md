# irlevents-mcp

Model Context Protocol server for [IRLEvents](https://irlevents.io) — the
token-gated event platform for the on-chain world.

Plugs IRLEvents into **Claude Desktop**, **Claude Code**, **Cursor**, **Cline**,
and any other MCP-compatible client. Once configured, the model can list events,
check whether you qualify for a token gate, RSVP, sync your on-chain assets,
and more — all on your behalf, using a long-lived `api_*` key you control.

## Tools exposed

### Discovery + attendee tools (require `events:read` / `rsvp:write` / `profile:*`)

| Tool | What it does |
|---|---|
| `list_events` | List public events with filters (category, city, chainId, date range) |
| `trending_events` | Most RSVPed events in the last 14 days |
| `get_event` | Single event by short id (title, dates, location, gates) |
| `top_creators` | Leaderboard of top creators |
| `platform_stats` | Cached platform-wide counts |
| `get_my_profile` | Read your own profile, wallets, cached assets |
| `sync_my_assets` | Force-refresh NFT/token holdings across chains (slow, don't poll) |
| `check_eligibility` | Will I pass this event's token gate? |
| `rsvp_status` | My RSVP state for this event |
| `rsvp_event` | RSVP on my behalf (locks the qualifying token) |
| `cancel_rsvp` | Cancel my RSVP, free the locked token |
| `my_eligible_events` | Every public event a wallet currently qualifies for |

### Host tools (v0.2.0+, require `events:write`)

| Tool | What it does |
|---|---|
| `create_event` | Create a new event (subject to your subscription tier limits) |
| `update_event` | Update fields on an event you host (partial updates supported) |
| `delete_event` | Permanently delete an event (destructive — prefer "cancelled" status via update) |
| `checkin_attendee` | Mark an attendee as checked in at the door |

### IRLRewards tools (v0.4.0+, require `rewards:read` / `rewards:write`)

The same backend serves both irlevents.io (events) and irlrewards.io (rewards).
Grant `rewards:*` scopes when you want the agent to also act on the rewards surface.

| Tool | What it does |
|---|---|
| `list_rewards` | List active rewards with filters (type, category, featured) |
| `get_reward` | Single reward by id (gates, supply, creator) |
| `check_reward_eligibility` | Will I qualify for this reward? |
| `claim_reward` | Claim on my behalf (re-checks eligibility, may deduct points) |
| `cancel_reward_claim` | Cancel a pending claim, refund any deducted points |
| `get_my_points` | My points balance + history |
| `get_my_claims` | Every reward I've claimed |
| `get_my_eligible_rewards` | Active rewards whose gates I currently satisfy |

### Resources (v0.3.0+) — browsable data without explicit tool calls

| URI | What it returns |
|---|---|
| `irlevents://profile/me` | Profile, wallets, cached assets (same as `get_my_profile`) |
| `irlevents://event/{id}` | Single event by id (same as `get_event`) |

The resource template lists trending events as the discovery surface — your
client may show them in a "browse" panel.

### Prompts (v0.3.0+) — guided multi-step workflows

| Prompt | What it does |
|---|---|
| `find_eligible_event` | Walks `trending_events` → `check_eligibility` → present first match. Optional `city` and `category` args. |
| `host_a_token_gated_event` | Walks `create_event` with a token gate. Args: title, date, location, contract, chainId. |
| `explain_my_eligibility` | Reads event + profile + eligibility, explains gate match in plain English. Arg: eventId. |

Sensitive actions (key management, billing, 2FA, OAuth unlink, account delete)
are **not** exposed — those still require a browser session at irlevents.io.

## Setup

### 1. Mint an API key

Sign in at https://irlevents.io, open **Profile → API Keys**, click **Create
key**, and copy the `api_<64 hex>` value. It's only shown once.

### 2. Add to your MCP client config

#### Claude Desktop (`~/Library/Application Support/Claude/claude_desktop_config.json` on macOS, `%APPDATA%\Claude\claude_desktop_config.json` on Windows)

```json
{
  "mcpServers": {
    "irlevents": {
      "command": "npx",
      "args": ["-y", "irlevents-mcp"],
      "env": {
        "IRLEVENTS_API_KEY": "api_your_key_here"
      }
    }
  }
}
```

Restart Claude Desktop. The IRLEvents tools will appear in the tools panel.

#### Claude Code (project-scoped, `.mcp.json` at the repo root)

```json
{
  "mcpServers": {
    "irlevents": {
      "command": "npx",
      "args": ["-y", "irlevents-mcp"],
      "env": { "IRLEVENTS_API_KEY": "api_your_key_here" }
    }
  }
}
```

Or via CLI: `claude mcp add irlevents npx -y irlevents-mcp -e IRLEVENTS_API_KEY=api_...`

#### Cursor (`~/.cursor/mcp.json`)

```json
{
  "mcpServers": {
    "irlevents": {
      "command": "npx",
      "args": ["-y", "irlevents-mcp"],
      "env": { "IRLEVENTS_API_KEY": "api_your_key_here" }
    }
  }
}
```

#### Cline (VS Code MCP settings)

Same config shape — add under `cline.mcpServers`.

### 3. Try it

Ask the model:

- *"What events are trending on IRLEvents right now?"*
- *"List events in Las Vegas this month."*
- *"Check if I'm eligible for event 7s5TZhMQqrCs."*
- *"RSVP me to that event if I qualify."*

## Configuration

| Env var | Default | Purpose |
|---|---|---|
| `IRLEVENTS_API_KEY` | *(required)* | Your `api_*` key |
| `IRLEVENTS_API_BASE` | `https://irlevents.io` | Override for staging or self-hosted |

## Local development

```bash
git clone <this repo>
cd irlevents-mcp
npm install
npm run build
IRLEVENTS_API_KEY=api_... node dist/index.js
```

To smoke-test the wire format without a live MCP client:

```bash
printf '%s\n%s\n%s\n' \
  '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"test","version":"0.0.1"}}}' \
  '{"jsonrpc":"2.0","method":"notifications/initialized"}' \
  '{"jsonrpc":"2.0","id":2,"method":"tools/list","params":{}}' \
  | IRLEVENTS_API_KEY=api_... node dist/index.js
```

## Etiquette

- **Don't poll `sync_my_assets`.** It hits external NFT providers (Alchemy,
  Helius, Hiro). Once per session is plenty.
- **Always `check_eligibility` before `rsvp_event`.** The API rejects ineligible
  users with 403 — you'll waste a tool call otherwise.
- **Respect rate limits.** Each api key gets 1000 req/hr by default. The IRLEvents
  API returns `X-RateLimit-Remaining` headers; this MCP server surfaces 429
  errors back to the model so it can back off.

## See also

- [IRLEvents agent guide](https://irlevents.io/api/guides/agent-guide)
- [Full agent docs (one-shot LLM ingest)](https://irlevents.io/llms-full.txt)
- [OpenAPI spec](https://irlevents.io/api/openapi.json)
- [Webhook integration guide](https://irlevents.io/api/guides/webhook-guide) — push instead of pull

## Releasing (maintainers)

CI auto-publishes to npm when a `v*.*.*` tag is pushed. Steps:

```bash
# 1. Bump version in package.json (e.g. 0.1.0 → 0.1.1)
# 2. Commit
git commit -am "Release v0.1.1"

# 3. Tag and push
git tag v0.1.1
git push && git push --tags
```

The GitHub Actions workflow (`.github/workflows/publish.yml`) will:

1. Verify the tag matches `package.json` version
2. Build with `tsc`
3. Smoke-test the MCP handshake (asserts all 12 tools register)
4. Publish to npm with provenance attestation

Required GitHub repo secret: **`NPM_TOKEN`** — an npm "Automation" or
"Publish" token. Generate at <https://www.npmjs.com/settings/_/tokens>,
then add at *Settings → Secrets and variables → Actions*.

## License

MIT
