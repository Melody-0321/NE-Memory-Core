// mcp/server.js — NE-Memory MCP Server
//
// Uses stdio transport for MCP communication.
// The memory engine core is initialized with file-system storage
// and an OpenAI-compatible LLM adapter (DeepSeek by default).

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { initCore, createFSBackend, createAPILLM } from '../core/index.js';
import { registerTools } from './tools.js';
import { createTieredSearch } from '../core/retrieval-tiered.js';
import { listWorkspaces } from '../core/adapters/trae/workspace.js';
import { injectState } from '../core/adapters/state-injector.js';
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
//   NE_MEMORY_DATA_DIR      - Override vault data directory
//   NE_MEMORY_HISTORY_PATH  - Override history reader path
//   NE_MEMORY_WORKSPACE     - Override workspaceStorage directory
//   NE_MEMORY_PROJECT_ROOT  - Project root for state → Rule file injection
if (process.env.NE_MEMORY_DATA_DIR) config.data_dir = process.env.NE_MEMORY_DATA_DIR;
if (process.env.NE_MEMORY_HISTORY_PATH) {
    config.history = config.history || {};
    config.history.path = process.env.NE_MEMORY_HISTORY_PATH;
}
if (process.env.NE_MEMORY_WORKSPACE) config.workspace_dir = process.env.NE_MEMORY_WORKSPACE;
if (process.env.NE_MEMORY_PROJECT_ROOT) config.project_root = process.env.NE_MEMORY_PROJECT_ROOT;

// ─── State injection config ───
// config.state_injection: { enabled: true, path: "optional/explicit/path" }
// If not set, auto-detection is used (Trae → Cursor → Claude Code → generic).
config.state_injection = config.state_injection || { enabled: true };

// ─── Derive current workspace ID from history path ───
// history.path = ".../workspaceStorage/{workspaceId}/state.vscdb"
// → namespace = "{workspaceId}"
// When no history configured (non-Trae scenario), namespace = null → flat storage.
function extractWorkspaceId(historyConfig) {
    if (!historyConfig || !historyConfig.path) return null;
    var parts = historyConfig.path.replace(/\\/g, '/').split('/');
    var wsIdx = parts.indexOf('workspaceStorage');
    if (wsIdx >= 0 && wsIdx + 1 < parts.length) {
        return parts[wsIdx + 1];
    }
    return null;
}

var currentWorkspaceId = extractWorkspaceId(config.history);

// ─── Initialize core ───
var dataDir = path.resolve(config.data_dir || path.join(__dirname, '..', 'data'));
var llmConfig = config.secondary_api || {};

// Resolve config paths for tools
config.data_dir = dataDir;
config.workspace_dir = config.workspace_dir || path.join(os.homedir(), 'AppData', 'Roaming', 'Trae CN', 'User', 'workspaceStorage');

var storage = createFSBackend(dataDir, currentWorkspaceId);

var ne = initCore({
    storage: storage,
    config: {
        stmBatch: config.stmBatch || 10,
        stmWordsThreshold: config.stmWordsThreshold || 500,
        stmMaxUnconsolidated: config.stmMaxUnconsolidated || 30,
        enableStateSchema: config.enableStateSchema || false,
        retrievalEnabled: config.retrievalEnabled || true,
        memoryEnabled: config.memoryEnabled !== false,
        // Cursor engine configuration
        useCursorEngine: config.useCursorEngine !== false,
        extractionMode: config.extractionMode || 'agent',
        initialStmWindow: config.initialStmWindow || 4,
        stmExpandStep: config.stmExpandStep || 4,
        maxStmWindow: config.maxStmWindow || 20,
        initialLtmWindow: config.initialLtmWindow || 8,
        ltmExpandStep: config.ltmExpandStep || 4,
        maxLtmWindow: config.maxLtmWindow || 30,
        stmMinBatchForCursor: config.stmMinBatchForCursor || 3,
        ltmMinBatch: config.ltmMinBatch || 15,
        bm25SimilarityThreshold: config.bm25SimilarityThreshold || 0.3,
        maxPartialGenerations: config.maxPartialGenerations || 3
    },
    history: config.history || null,
    callLLM: createAPILLM({
        url: llmConfig.url || '',
        key: llmConfig.key || '',
        model: llmConfig.model || 'deepseek-v4-flash'
    })
});

// ─── Initialize tiered search ───
// Build chat→project mapping from vault storage layout.
//   data/{namespace}/{chatId}.json  →  chatId belongs to namespace
//   data/{chatId}.json (legacy)     →  chatId has no namespace (Level 1 fallback)
//
// When getChatProjectId returns null → all non-current chats are Level 1.
function buildChatProjectMap() {
    var map = {};
    try {
        if (fs.existsSync(dataDir)) {
            var entries = fs.readdirSync(dataDir, { withFileTypes: true });
            for (var i = 0; i < entries.length; i++) {
                if (entries[i].isDirectory()) {
                    // Per-workspace namespace subdirectory
                    var ns = entries[i].name;
                    var nsDir = path.join(dataDir, ns);
                    var files = fs.readdirSync(nsDir).filter(function(f) { return f.endsWith('.json'); });
                    for (var j = 0; j < files.length; j++) {
                        var chatId = files[j].replace('.json', '');
                        map[chatId] = ns;
                    }
                }
            }
        }
    } catch (e) {
        console.error('[mcp] Failed to build chat→project map:', e.message);
    }
    return map;
}

var chatProjectMap = buildChatProjectMap();

ne.tieredSearch = createTieredSearch({
    searchSingleChat: function(chatId, query, topK) {
        return ne.search(chatId, query);
    },
    listAllChatIds: function() {
        // Scan all namespace subdirectories + legacy flat files
        var ids = [];
        try {
            if (fs.existsSync(dataDir)) {
                var entries = fs.readdirSync(dataDir, { withFileTypes: true });
                for (var i = 0; i < entries.length; i++) {
                    if (entries[i].isDirectory()) {
                        var nsDir = path.join(dataDir, entries[i].name);
                        var files = fs.readdirSync(nsDir).filter(function(f) { return f.endsWith('.json'); });
                        for (var j = 0; j < files.length; j++) {
                            ids.push(files[j].replace('.json', ''));
                        }
                    } else if (entries[i].name.endsWith('.json')) {
                        // Legacy flat file (pre-namespace)
                        ids.push(entries[i].name.replace('.json', ''));
                    }
                }
            }
        } catch (e) { /* ignore */ }
        return ids;
    },
    getChatProjectId: function(chatId) {
        return chatProjectMap[chatId] || null;
    }
});

// ─── MCP Server ───
var server = new McpServer({
    name: 'ne-memory-mcp',
    version: '1.0.0'
});

// ─── State injection helper (auto-syncs vault state → Rule file) ───
var stateInjector = null;
var projectRoot = config.project_root || null;
var injectConfig = config.state_injection || {};

if (projectRoot && injectConfig.enabled !== false) {
    var effectiveRoot = projectRoot;
    stateInjector = function(chatId) {
        return injectState({
            chatId: chatId,
            readVault: function(id) { return ne.read(id); },
            getState: function(id) { return ne.getState(id); },
            projectRoot: effectiveRoot,
            explicitPath: injectConfig.path || null
        });
    };
}

registerTools(server, ne, config, stateInjector);

async function main() {
    var transport = new StdioServerTransport();
    await server.connect(transport);
    console.error('[mcp] NE-Memory MCP Server running via stdio');
}

main().catch(function(e) {
    console.error('[mcp] Fatal:', e);
    process.exit(1);
});
