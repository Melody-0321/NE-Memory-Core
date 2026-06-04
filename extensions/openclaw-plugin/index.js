// index.js — NE-Memory State Plugin for OpenClaw
//
// Reads the NE-Memory vault JSON file from disk and injects the current
// state snapshot into the agent's system prompt via before_agent_start hook.
//
// Installation:
//   openclaw plugins install @ne-memory/openclaw-plugin
//
// Configuration (in openclaw.json):
//   {
//     plugins: {
//       entries: {
//         "ne-memory-state": {
//           enabled: true,
//           config: {
//             dataDir: "~/.ne-memory/data",    // path to vault JSON files
//             chatId: "ne-memory-dev",          // which chat session
//             maxChars: 3000                    // max chars to inject (0 = unlimited)
//           }
//         }
//       }
//     }
//   }

import fs from 'node:fs';
import path from 'node:path';
import { formatState } from './state-formatter.js';

var PLUGIN_ID = 'ne-memory-state';

/**
 * OpenClaw plugin entry — called on gateway start.
 * @param {object} pluginApi — OpenClaw plugin API
 */
export default function(pluginApi) {
    var log = pluginApi.logger || console;

    // ─── Read config ───
    var config = null;
    try {
        config = pluginApi.config || {};
    } catch (e) {
        config = {};
    }

    var dataDir = config.dataDir || path.join(process.env.HOME || '~', '.ne-memory', 'data');
    var chatId = config.chatId || 'ne-memory-dev';
    var maxChars = typeof config.maxChars === 'number' ? config.maxChars : 3000;

    // Expand ~ in dataDir
    if (dataDir.startsWith('~/')) {
        dataDir = path.join(process.env.HOME || '', dataDir.slice(2));
    }

    log.info('[' + PLUGIN_ID + '] Loaded. dataDir=' + dataDir + ' chatId=' + chatId + ' maxChars=' + maxChars);

    // ─── Register before_agent_start hook ───
    pluginApi.registerHook('before_agent_start', async function(ctx) {
        var vaultPath = path.join(dataDir, chatId + '.json');

        try {
            if (!fs.existsSync(vaultPath)) {
                log.warn('[' + PLUGIN_ID + '] Vault file not found: ' + vaultPath);
                return {};
            }

            var raw = fs.readFileSync(vaultPath, 'utf-8');
            var vault = JSON.parse(raw);
            var content = vault.content || {};

            var markdown = formatState(content);
            if (!markdown) {
                log.debug('[' + PLUGIN_ID + '] State is empty, skipping injection');
                return {};
            }

            // Apply maxChars limit
            if (maxChars > 0 && markdown.length > maxChars) {
                markdown = markdown.substring(0, maxChars);
                var lastNewline = markdown.lastIndexOf('\n');
                if (lastNewline > maxChars * 0.8) {
                    markdown = markdown.substring(0, lastNewline);
                }
                markdown += '\n<!-- truncated to ' + maxChars + ' chars -->';
            }

            log.debug('[' + PLUGIN_ID + '] Injecting ' + markdown.length + ' chars of state');
            return { prependContext: markdown };

        } catch (e) {
            log.error('[' + PLUGIN_ID + '] Failed: ' + e.message);
            return {};
        }
    });
}
