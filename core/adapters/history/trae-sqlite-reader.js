// core/adapters/history/trae-sqlite-reader.js — Trae CN SQLite history reader
//
// Reads the `icube-ai-agent-storage-input-history` key from Trae's state.vscdb.
// Registers itself as reader "trae-sqlite".
//
// Config:
//   { "reader": "trae-sqlite", "path": "C:/path/to/state.vscdb" }

import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import { registerReader } from './index.js';

registerReader('trae-sqlite', function(config) {
    var dbPath = config.path || '';

    return {
        readHistory: async function(chatId) {
            // chatId not used for Trae — reads raw input history
            if (!dbPath || !fs.existsSync(dbPath)) return [];
            try {
                var db = new DatabaseSync(dbPath, { readOnly: true });
                try {
                    var rows = db.prepare("SELECT value FROM ItemTable WHERE key = 'icube-ai-agent-storage-input-history'").all();
                    if (rows.length === 0) return [];
                    var history = JSON.parse(String(rows[0].value));
                    if (!Array.isArray(history)) return [];

                    // Convert to standard message format
                    var messages = [];
                    for (var i = 0; i < history.length; i++) {
                        var text = (history[i].inputText || '').trim();
                        if (text) {
                            messages.push({
                                role: 'user',
                                content: text,
                                id: 'input_' + i
                            });
                        }
                    }
                    return messages;
                } finally {
                    db.close();
                }
            } catch (e) {
                console.error('[history/trae-sqlite] Error:', e.message);
                return [];
            }
        },

        prepareBatches: function(history, options) {
            options = options || {};
            var lastN = options.lastN || 100;
            var minLength = options.minLength || 20;
            var batchSize = options.batchSize || 10;

            var entries = history.slice(-lastN);
            var filtered = [];
            for (var i = 0; i < entries.length; i++) {
                var text = (entries[i].content || entries[i].inputText || '').trim();
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
