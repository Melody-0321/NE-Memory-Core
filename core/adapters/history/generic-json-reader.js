// core/adapters/history/generic-json-reader.js — Generic JSON history reader
//
// Reads conversation history from JSON files.
// Supports two formats:
//   1. Array of messages: [{ role, content, id }]
//   2. Single message per file: { role, content, ... }
//
// Config:
//   { "reader": "generic-json", "path": "/path/to/conversations/" }
//   Directory should contain files named {chatId}.json

import fs from 'node:fs';
import path from 'node:path';
import { registerReader } from './index.js';

registerReader('generic-json', function(config) {
    var dirPath = config.path || '';

    return {
        readHistory: async function(chatId) {
            if (!dirPath || !fs.existsSync(dirPath)) return [];

            var filePath = path.join(dirPath, chatId + '.json');
            if (!fs.existsSync(filePath)) return [];

            try {
                var raw = fs.readFileSync(filePath, 'utf-8');
                var data = JSON.parse(raw);

                // Array format: [{ role, content, id }]
                if (Array.isArray(data)) {
                    return data.map(function(m, i) {
                        return {
                            role: m.role || 'user',
                            content: m.content || '',
                            id: m.id || chatId + '_' + i
                        };
                    });
                }

                // Single message format: { role, content }
                if (data.role && data.content) {
                    return [{
                        role: data.role,
                        content: data.content,
                        id: data.id || chatId + '_0'
                    }];
                }

                return [];
            } catch (e) {
                console.error('[history/generic-json] Error reading', filePath, ':', e.message);
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
