# NE-Memory Core

Persistent memory system for AI agents. Runs as an MCP server — plug into Claude Desktop, Cursor, Windsurf, VS Code Copilot, OpenClaw, or any MCP-compatible client.

## Quick Start

### Prerequisites

- **Node.js ≥ 22** (uses built-in `node:sqlite`)

### Install

```bash
git clone <your-repo-url>
cd ne-memory-core/mcp
npm install
```

### Configure

**Claude Desktop** — Edit `claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "ne-memory": {
      "command": "node",
      "args": ["/absolute/path/ne-memory-core/mcp/server.js"],
      "env": {
        "NE_MEMORY_DATA_DIR": "/absolute/path/ne-memory-core/data"
      }
    }
  }
}
```

**OpenClaw** — Edit `~/.openclaw/openclaw.json`:

```json
{
  "tools": {
    "mcp": [{
      "type": "stdio",
      "command": "node",
      "args": ["/absolute/path/ne-memory-core/mcp/server.js"],
      "env": {
        "NE_MEMORY_DATA_DIR": "/absolute/path/ne-memory-core/data"
      }
    }]
  }
}
```

Restart the client. The server exposes 11 tools automatically.

### Verify

Run `memory_status` in your AI agent's conversation:

> "检查记忆系统状态。"

If the agent sees the tool and returns vault stats, it's working.

---

## Features

| Layer | Tools | What it does |
|-------|-------|-------------|
| **Status** | `memory_status` | Vault version, STM/LTM counts |
| **Search (BM25)** | `memory_search` | Zero-LLM keyword search across all stored memories |
| **Access** | `memory_access` | Direct lookup: `stm_12`, `input_5`, `characters.Seraphina` |
| **Synthesize** | `memory_synthesize` | BM25 → dedup → LLM synthesis with source citations |
| **Extract** | `memory_extract` | Extract STM from conversation, optional background mode |
| **Consolidate** | `memory_consolidate` | Merge STM into LTM summaries |
| **State** | `memory_get/update_state` | Persistent story/game state |
| **Rollback** | `memory_rollback` | Remove memories by message ID |
| **History** | `memory_process_history` | Backfill from platform conversation logs |
| **Projects** | `memory_list_projects` | Discover available Trae workspaces |

---

## Architecture

```
┌──────────────────────────────────────────────┐
│                 MCP Client                    │
│     (Trae / OpenClaw / Claude Desktop)        │
└──────────────────┬───────────────────────────┘
                   │ stdio (JSON-RPC)
┌──────────────────▼───────────────────────────┐
│              mcp/server.js                    │
│           (StdioServerTransport)              │
└──────────────────┬───────────────────────────┘
                   │
┌──────────────────▼───────────────────────────┐
│              mcp/tools.js                     │
│         (11 tool definitions via Zod)         │
└──────┬────────────────────────────────┬──────┘
       │                                │
┌──────▼──────┐                 ┌──────▼──────┐
│   core/     │                 │  adapters/  │
│  (index.js) │                 │             │
│             │                 │  history/   │
│ ・store.js  │                 │  ├─ trae-sqlite│
│ ・access.js │                 │  ├─ openclaw-md│
│ ・retrieval │                 │  └─ generic-json│
│ ・schema    │                 │             │
│ ・engine/   │                 │ ・llm-api.js│
│   extract   │                 │ ・storage-fs│
│   consolidate│                └─────────────┘
└──────▲──────┘
       │
┌──────┴──────┐
│   data/     │
│  *.json     │
│ (vaults)    │
└─────────────┘
```

### Layers

- **Layer 0** — Zero LLM. `search` (BM25) + `access` (direct ref lookup). Instant, no API cost.
- **Layer 1** — LLM-assisted. `synthesize` (BM25 → dedup → LLM) + `extract` (dialog → STM).
- **Layer 2** — LTM consolidation. `consolidate` merges related STM into compressed summaries.

### Key design decisions

- **Storage-agnostic**: swap `storage-fs.js` for IndexedDB, KV store, etc.
- **LLM-agnostic**: swap `llm-api.js` for any OpenAI-compatible or local model.
- **History-agnostic**: platform-specific readers (`trae-sqlite`, `openclaw-md`, `generic-json`) plug in via config.
- **No external databases**: vaults are flat JSON files. No Postgres, no Redis, no Vector DB.
- **Background extraction**: `memory_extract(background: true)` runs LLM calls asynchronously.

---

## Configuration

Copy `mcp/config.json`:

| Key | Default | Description |
|-----|---------|-------------|
| `data_dir` | `./data` | Vault file directory |
| `history.reader` | — | Platform: `trae-sqlite`, `openclaw-md`, `generic-json` |
| `history.path` | — | Path to history storage |

Environment variables override config file:

| Variable | Overrides |
|----------|-----------|
| `NE_MEMORY_DATA_DIR` | Vault directory |
| `NE_MEMORY_HISTORY_PATH` | History reader path |
| `NE_MEMORY_WORKSPACE` | Workspace scan directory |

---

## License

MIT
