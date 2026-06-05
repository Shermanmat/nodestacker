# Matcap Pipeline MCP Server

Connect your AI client (Claude Desktop, Cursor, …) to **your Matcap investor
pipeline**, so you can read and manage it by chatting with your AI.

It's a thin local connector: it holds **only your personal access token** — never
any database credentials — and calls Matcap's token-authenticated API over HTTPS.
Everything you can do is scoped to *your* pipeline; the server enforces tenancy
and permissions, so this connector can't reach anyone else's data.

## What you can do

| Tool | What it does |
|---|---|
| `list_investors` | List/filter/search your pipeline (status, source, kind, needs-attention) |
| `get_investor` | One pipeline item by id |
| `create_investor` | Add a self-managed record |
| `update_investor` | Edit a record (see rules below) |
| `archive_investor` | Soft-delete (reversible) a self-managed record |
| `log_touch` | Record an interaction; optionally advance a self-record's status |
| `bulk_upsert_investors` | Idempotently import many records (no duplicates) |
| `get_pipeline_summary` | Counts by stage for your dashboard |

**Two kinds of rows, different powers** (same as the portal):
- **Self-added records** — you own them fully (create / edit / archive).
- **MatCap intros** — you can edit only *your* fields (`nextActionText`,
  `nextActionDate`, `checkSize`, `notes`). Status and investor details are managed
  by MatCap and can't be changed here.

## 1. Mint a token

In the Matcap founder portal, create an MCP token (Settings → Connect AI), or via API:

```bash
curl -X POST https://matcap.vc/api/portal/mcp-tokens \
  -H "X-Session-Id: <your portal session>" \
  -H "Content-Type: application/json" \
  -d '{"name":"Claude Desktop","expiresInDays":365}'
```

Copy the `token` from the response — it's shown **once**. Revoke anytime:

```bash
curl -X DELETE https://matcap.vc/api/portal/mcp-tokens/<id> -H "X-Session-Id: <session>"
```

## 2. Install

```bash
cd mcp-server
npm install
```

## 3. Connect it to your MCP client

Add this to your client's MCP config (e.g. Claude Desktop's
`claude_desktop_config.json`):

```json
{
  "mcpServers": {
    "matcap-pipeline": {
      "command": "node",
      "args": ["/absolute/path/to/mcp-server/index.mjs"],
      "env": {
        "MATCAP_MCP_TOKEN": "mcp_xxxxxxxx...",
        "MATCAP_API_URL": "https://matcap.vc"
      }
    }
  }
}
```

Restart the client. You should be able to ask: *"List my investors that need a
follow-up"* or *"Add Jane Doe at Acme, self-outreach, follow up Friday."*

## Security notes

- The raw token is stored **hashed** server-side; a DB leak can't reconstruct it.
- Tokens are **revocable** and can carry an **expiry**.
- All access is scoped to the founder the token belongs to — enforced in a single
  server-side data-access layer (our equivalent of row-level security).
- This connector never sees database credentials; it only ever sends your token.

## Env

| Var | Required | Default | Notes |
|---|---|---|---|
| `MATCAP_MCP_TOKEN` | yes | — | your minted token |
| `MATCAP_API_URL` | no | `https://matcap.vc` | API base URL |
