// core/adapters/history/copilot-json-reader.js — GitHub Copilot Chat session JSON reader
//
// Reads VS Code GitHub Copilot Chat session files stored as JSON.
// Copilot stores sessions at:
//   %APPDATA%/Code/User/workspaceStorage/<hash>/chatSessions/<uuid>.json
//
// Config:
//   { "reader": "copilot-json", "path": "C:/Users/.../AppData/Roaming/Code/User/workspaceStorage/" }
//   path can point to: a specific .json file, a chatSessions directory, or workspaceStorage root
//
// JSON structure:
//   {
//     "sessionId": "uuid",
//     "creationDate": 1723563355820,
//     "version": 3,
//     "requests": [
//       {
//         "requestId": "...",
//         "timestamp": 1723563931179,
//         "message": { "text": "user message content" },
//         "agent": { "id": "github.copilot.editsAgent" }
//       },
//       {
//         "requestId": "...",
//         "message": { "text": "assistant response" },
//         "agent": { "id": "github.copilot.chatAgent" }
//       }
//     ]
//   }
//
// Agent ID mapping:
//   - User queries: "github.copilot.*" agents where the message is from user
//   - We distinguish by request order: odd-index = user, even-index = assistant (heuristic)
//   - Or check if agent.id contains "edits" (user edit context) vs "chat" (assistant)

import fs from 'node:fs';
import path from 'node:path';
import { registerReader } from './index.js';

/**
 * Determine role from Copilot agent ID and request context.
 * Copilot doesn't explicitly mark user vs assistant — we use heuristics.
 */
function inferRole(agentId, index, requestsLength) {
    if (!agentId) return (index % 2 === 0) ? 'user' : 'assistant';

    var lower = agentId.toLowerCase();

    // Agent IDs that indicate user-side requests
    if (lower.indexOf('edit') !== -1) return 'user';
    if (lower.indexOf('inline') !== -1) return 'user';
    if (lower.indexOf('terminal') !== -1) return 'user';

    // Agent IDs that indicate assistant responses
    if (lower.indexOf('chat') !== -1) return 'assistant';
    if (lower.indexOf('respond') !== -1) return 'assistant';

    // Fallback: alternate user/assistant by position
    return (index % 2 === 0) ? 'user' : 'assistant';
}

registerReader('copilot-json', function(config) {
    var basePath = config.path || '';

    function parseSessionFile(filePath, chatId) {
        try {
            var raw = fs.readFileSync(filePath, 'utf-8');
            var data = JSON.parse(raw);

            if (!data.requests || !Array.isArray(data.requests)) return [];
            if (data.requests.length === 0) return [];

            var messages = [];

            for (var i = 0; i < data.requests.length; i++) {
                var req = data.requests[i];
                var text = (req.message && req.message.text) ? req.message.text.trim() : '';
                if (!text) continue;

                var agentId = (req.agent && req.agent.id) ? req.agent.id : '';
                var role = inferRole(agentId, i, data.requests.length);

                messages.push({
                    role: role,
                    content: text,
                    id: (chatId || 'copilot') + '_' + i
                });
            }

            return messages;
        } catch (e) {
            console.error('[history/copilot-json] Error reading', filePath, ':', e.message);
            return [];
        }
    }

    return {
        readHistory: async function(chatId) {
            if (!basePath || !fs.existsSync(basePath)) return [];

            // If path points directly to a .json file
            if (fs.statSync(basePath).isFile()) {
                return parseSessionFile(basePath, chatId);
            }

            // Find all chatSessions directories under workspaceStorage
            var findJsonFiles = function(dir, maxDepth) {
                if (maxDepth <= 0) return [];
                var results = [];
                try {
                    var entries = fs.readdirSync(dir, { withFileTypes: true });
                    for (var i = 0; i < entries.length; i++) {
                        var fullPath = path.join(dir, entries[i].name);
                        if (entries[i].isDirectory()) {
                            // Prioritize chatSessions dirs
                            if (entries[i].name === 'chatSessions') {
                                results = results.concat(findJsonFiles(fullPath, 1));
                            } else {
                                results = results.concat(findJsonFiles(fullPath, maxDepth - 1));
                            }
                        } else if (entries[i].name.endsWith('.json')) {
                            results.push(fullPath);
                        }
                    }
                } catch (_) {}
                return results;
            };

            var files = findJsonFiles(basePath, 3);
            if (files.length === 0) return [];

            // Sort by modification time, newest first
            files.sort(function(a, b) {
                try { return fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs; } catch (_) { return 0; }
            });

            // If chatId provided, try to find matching file
            if (chatId) {
                for (var i = 0; i < files.length; i++) {
                    if (files[i].indexOf(chatId) !== -1) {
                        return parseSessionFile(files[i], chatId);
                    }
                }
            }

            // Return latest session
            return parseSessionFile(files[0], chatId);
        },

        prepareBatches: function(history, options) {
            options = options || {};
            var lastN = options.lastN || 100;
            var minLength = options.minLength || 20;
            var batchSize = options.batchSize || 10;

            var entries = history.slice(-lastN);
            var filtered = [];
            for (var i = 0; i < entries.length; i++) {
                var text = (entries[i].content || '').trim();
                if (text.length >= minLength) {
                    filtered.push(text);
                }
            }

            var batches = [];
            for (var i = 0; i < filtered.length; i += batchSize) {
                var batchTexts = filtered.slice(i, i + batchSize);
                var messages = [];
                for (var j = 0; j < batchTexts.length; j++) {
                    var idx = entries.length - filtered.length + i + j;
                    messages.push({
                        role: 'user',
                        content: batchTexts[j],
                        id: 'input_' + idx
                    });
                }
                batches.push(messages);
            }
            return batches;
        }
    };
});
