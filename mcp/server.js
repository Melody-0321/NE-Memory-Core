// mcp/server.js — NE-Memory MCP Server
//
// Uses stdio transport for MCP communication.
// The memory engine core is initialized with file-system storage
// and an OpenAI-compatible LLM adapter (DeepSeek by default).

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { initCore, createFSBackend, createAPILLM } from '../core/index.js';
import { registerTools } from './tools.js';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// ─── Load config ───
var __dirname = path.dirname(fileURLToPath(import.meta.url));
var configPath = path.join(__dirname, 'config.json');
var config = {};

try {
    var raw = fs.readFileSync(configPath, 'utf-8');
    config = JSON.parse(raw);
} catch (e) {
    console.error('[mcp] config.json not found or invalid, using defaults');
}

// ─── Environment variable overrides (set via MCP settings UI) ───
// These take priority over config.json so users can configure paths
// through Trae's MCP settings page without editing config.json directly.
//
// Available env vars:
//   NE_MEMORY_DATA_DIR     - Override vault data directory
//   NE_MEMORY_HISTORY_PATH - Override history reader path
//   NE_MEMORY_WORKSPACE    - Override workspaceStorage directory
if (process.env.NE_MEMORY_DATA_DIR) config.data_dir = process.env.NE_MEMORY_DATA_DIR;
if (process.env.NE_MEMORY_HISTORY_PATH) {
    config.history = config.history || {};
    config.history.path = process.env.NE_MEMORY_HISTORY_PATH;
}
if (process.env.NE_MEMORY_WORKSPACE) config.workspace_dir = process.env.NE_MEMORY_WORKSPACE;

// ─── Initialize core ───
var dataDir = path.resolve(config.data_dir || path.join(__dirname, '..', 'data'));
var llmConfig = config.secondary_api || {};

// Resolve config paths for tools
config.data_dir = dataDir;
config.workspace_dir = config.workspace_dir || path.join(os.homedir(), 'AppData', 'Roaming', 'Trae CN', 'User', 'workspaceStorage');

var ne = initCore({
    storage: createFSBackend(dataDir),
    config: {
        stmBatch: config.stmBatch || 10,
        stmWordsThreshold: config.stmWordsThreshold || 500,
        stmMaxUnconsolidated: config.stmMaxUnconsolidated || 30,
        enableStateSchema: config.enableStateSchema || false,
        retrievalEnabled: config.retrievalEnabled || true,
        memoryEnabled: config.memoryEnabled !== false
    },
    history: config.history || null,
    callLLM: createAPILLM({
        url: llmConfig.url || '',
        key: llmConfig.key || '',
        model: llmConfig.model || 'deepseek-v4-flash'
    })
});

// ─── MCP Server ───
var server = new McpServer({
    name: 'ne-memory-mcp',
    version: '1.0.0'
});

registerTools(server, ne, config);

async function main() {
    var transport = new StdioServerTransport();
    await server.connect(transport);
    console.error('[mcp] NE-Memory MCP Server running via stdio');
}

main().catch(function(e) {
    console.error('[mcp] Fatal:', e);
    process.exit(1);
});
