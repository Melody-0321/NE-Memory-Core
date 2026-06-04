// core/adapters/history/cursor-jsonl-reader.js — Cursor agent-transcripts JSONL reader
//
// Reads Cursor's agent chat transcripts stored as JSONL files.
// Cursor stores transcripts at: ~/.cursor/projects/<project>/agent-transcripts/<chat-id>/
// Each file contains one JSON object per line with type/message fields.
//
// Config:
//   { "reader": "cursor-jsonl", "path": "C:/Users/.../.cursor/projects/my-app/agent-transcripts/" }
//   path can point to: a specific .jsonl file, or a directory containing .jsonl files
//
// JSONL line format:
//   {"type":"user","message":{"role":"user","content":"hello"}}
//   {"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"hi"}]}}

import fs from 'node:fs';
import path from 'node:path';
import { registerReader } from './index.js';

// Extract text from content which can be a string or content block array
function extractText(content) {
    if (typeof content === 'string') return content.trim();
    if (Array.isArray(content)) {
        var parts = [];
        for (var i = 0; i < content.length; i++) {
            if (content[i].type === 'text' && content[i].text) {
                parts.push(content[i].text);
            }
        }
        return parts.join('\n').trim();
    }
    return '';
}

registerReader('cursor-jsonl', function(config) {
    var basePath = config.path || '';

    /**
     * Read JSONL file and extract messages.
     */
    function readJsonlFile(filePath, chatId) {
        try {
            var raw = fs.readFileSync(filePath, 'utf-8');
            var lines = raw.split('\n');
            var messages = [];
            var msgIdx = 0;

            for (var i = 0; i < lines.length; i++) {
                var line = lines[i].trim();
                if (!line) continue;

                try {
                    var entry = JSON.parse(line);
                    if (!entry.message || !entry.message.role) continue;

                    // Skip non-conversation types
                    if (entry.type === 'summary' || entry.type === 'file-history-snapshot') continue;

                    var role = entry.message.role;
                    // Normalize: only keep user/assistant
                    if (role !== 'user' && role !== 'assistant') continue;

                    var text = extractText(entry.message.content);
                    if (text.length > 0) {
                        messages.push({
                            role: role,
                            content: text,
                            id: (chatId || 'cursor') + '_' + (msgIdx++)
                        });
                    }
                } catch (_) {
                    // Skip malformed lines
                }
            }
            return messages;
        } catch (e) {
            console.error('[history/cursor-jsonl] Error reading', filePath, ':', e.message);
            return [];
        }
    }

    return {
        readHistory: async function(chatId) {
            if (!basePath || !fs.existsSync(basePath)) return [];

            // If path points to a file, read it directly
            if (fs.statSync(basePath).isFile()) {
                return readJsonlFile(basePath, chatId);
            }

            // Path is a directory — find JSONL files
            var findJsonlFiles = function(dir) {
                var results = [];
                try {
                    var entries = fs.readdirSync(dir, { withFileTypes: true });
                    for (var i = 0; i < entries.length; i++) {
                        var fullPath = path.join(dir, entries[i].name);
                        if (entries[i].isDirectory()) {
                            // Recurse into subdirs (agent-transcripts has <chat-id>/ folders)
                            results = results.concat(findJsonlFiles(fullPath));
                        } else if (entries[i].name.endsWith('.jsonl')) {
                            results.push(fullPath);
                        }
                    }
                } catch (_) {}
                return results;
            };

            var files = findJsonlFiles(basePath);
            if (files.length === 0) return [];

            // Sort by modification time, newest first
            files.sort(function(a, b) {
                try { return fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs; } catch (_) { return 0; }
            });

            // If chatId provided, try to find matching file
            if (chatId) {
                for (var i = 0; i < files.length; i++) {
                    if (files[i].indexOf(chatId) !== -1) {
                        return readJsonlFile(files[i], chatId);
                    }
                }
            }

            // Return latest file's messages
            return readJsonlFile(files[0], chatId);
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
