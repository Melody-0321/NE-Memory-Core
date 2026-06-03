// core/adapters/history/openclaw-md-reader.js — OpenClaw Markdown history reader
//
// Reads conversation history from OpenClaw's daily Markdown files.
// OpenClaw stores daily logs at: {workspace}/memory/YYYY-MM-DD.md
//
// Config:
//   { "reader": "openclaw-md", "path": "/home/user/.openclaw/workspace/memory" }
//   path can point to: a specific .md file, or a directory containing YYYY-MM-DD.md files
//
// The reader parses several common Markdown conversation formats:
//   - ## User / ## Assistant headers
//   - **User:** / **Assistant:** bold labels
//   - > User: / > Assistant: blockquote style
//   - - **User:** bullet + bold

import fs from 'node:fs';
import path from 'node:path';
import { registerReader } from './index.js';

registerReader('openclaw-md', function(config) {
    var basePath = config.path || '';

    return {
        readHistory: async function(chatId) {
            if (!basePath || !fs.existsSync(basePath)) return [];

            if (fs.statSync(basePath).isFile()) {
                return parseMarkdownFile(basePath, chatId);
            }

            if (!chatId) {
                var files = fs.readdirSync(basePath)
                    .filter(function(f) { return f.endsWith('.md'); })
                    .sort()
                    .reverse();
                if (files.length === 0) return [];
                return parseMarkdownFile(path.join(basePath, files[0]), files[0].replace('.md', ''));
            }

            var candidates = [
                path.join(basePath, chatId + '.md'),
                path.join(basePath, chatId.replace(/[^0-9-]/g, '') + '.md'),
                path.join(basePath, 'memory', chatId + '.md'),
                path.join(basePath, '..', 'memory', chatId + '.md')
            ];

            for (var i = 0; i < candidates.length; i++) {
                if (fs.existsSync(candidates[i])) {
                    return parseMarkdownFile(candidates[i], chatId);
                }
            }

            return [];
        },
        prepareBatches: null
    };
});

// ─── Detection helper (hoisted before parseMarkdownFile) ───

/**
 * Detect if a line starts a new speaker role.
 * Returns { role, remaining } or null.
 */
function detectRole(line) {
    if (!line) return null;

    var patterns = [
        { re: /^#{1,3}\s+(用户|User|Human)\s*[:：]?\s*(.*)/i, role: 'user' },
        { re: /^#{1,3}\s+(助手|Assistant|AI|Agent|Model)\s*[:：]?\s*(.*)/i, role: 'assistant' },
        { re: /\*\*(用户|User|Human)\*\*\s*[:：]?\s*(.*)/i, role: 'user' },
        { re: /\*\*(助手|Assistant|AI|Agent|Model)\*\*\s*[:：]?\s*(.*)/i, role: 'assistant' },
        { re: /^>\s*(用户|User|Human)\s*[:：]?\s*(.*)/i, role: 'user' },
        { re: /^>\s*(助手|Assistant|AI|Agent|Model)\s*[:：]?\s*(.*)/i, role: 'assistant' },
        { re: /^-\s*\*\*(用户|User|Human)\*\*\s*[:：]?\s*(.*)/i, role: 'user' },
        { re: /^-\s*\*\*(助手|Assistant|AI|Agent|Model)\*\*\s*[:：]?\s*(.*)/i, role: 'assistant' },
        { re: /^(用户|User|Human)\s*[:：]\s*(.*)/i, role: 'user' },
        { re: /^(助手|Assistant|AI|Agent|Model)\s*[:：]\s*(.*)/i, role: 'assistant' },
    ];

    for (var i = 0; i < patterns.length; i++) {
        var m = line.match(patterns[i].re);
        if (m) return { role: patterns[i].role, remaining: m[2] || '' };
    }
    return null;
}

// ─── Markdown parser ───

function parseMarkdownFile(filePath, chatId) {
    try {
        var raw = fs.readFileSync(filePath, 'utf-8');
        var lines = raw.split('\n');
        var messages = [];
        var currentRole = null;
        var currentContent = [];
        var msgIdx = 0;

        // Define flushMessage inside parseMarkdownFile scope, before the loop
        var flushMessage = function() {
            var content = currentContent.join('\n').trim();
            if (content) {
                messages.push({
                    role: currentRole,
                    content: content,
                    id: chatId + '_' + (msgIdx++)
                });
            }
            currentContent = [];
        };

        for (var i = 0; i < lines.length; i++) {
            var trimmed = lines[i].trim();
            if (!trimmed && !currentRole) continue;

            var roleChange = detectRole(trimmed);
            if (roleChange) {
                if (currentRole) flushMessage();
                currentRole = roleChange.role;
                if (roleChange.remaining) currentContent.push(roleChange.remaining);
            } else if (currentRole) {
                currentContent.push(lines[i]);
            }
        }

        if (currentRole) flushMessage();
        return messages;
    } catch (e) {
        console.error('[history/openclaw-md] Error:', filePath, '-', e.message);
        return [];
    }
}
