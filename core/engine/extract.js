// core/engine/extract.js — STM extraction engine
//
// Extracts short-term memory entries from new chat messages.
// callLLM is injected as a dependency — core does not call any LLM directly.

import { read, write, appendSTMEntries } from '../store.js';
import { get, getStmMaxUnconsolidated, isStateSchemaEnabled } from '../config.js';
import { validateStateChanges, mergeStateChanges } from '../schema.js';
import { validateSTMOutput, postFillSTM, whitelistStateChanges } from '../validator.js';
import { buildSTMUpdatePrompt } from '../prompts.js';
import { executeConsolidation } from './consolidate.js';

// ─── Collect processed message IDs ───

export function collectProcessedMsgIds(vault) {
    var ids = new Set();
    var content = vault.content || {};
    var allSTM = (content.unconsolidated_stm || []).concat(content.stm_entries || []);
    allSTM.forEach(function(stm) { (stm.msg_ids || []).forEach(function(id) { ids.add(id); }); });
    return ids;
}

export function filterNewMessages(messages, processedIds) {
    return messages.filter(function(m) {
        var id = m.id || m.mes_id;
        return id !== undefined && !processedIds.has(id);
    });
}

// ─── Parse STM response ───

export function parseSTMResponse(response) {
    var text = String(response || '').trim();
    var stateChangesText = null;
    var stateMatch = text.match(/<state_changes>([\s\S]*?)<\/state_changes>/);
    if (stateMatch) {
        stateChangesText = stateMatch[1].trim();
        text = text.replace(/<state_changes>[\s\S]*?<\/state_changes>/g, '').trim();
    }
    var codeMatch = text.match(/```(?:json)?\s*([\s\S]*?)```/);
    if (codeMatch) text = codeMatch[1].trim();

    var stmEntries = [];
    var checkpoints = null;
    try {
        var jsonMatch = text.match(/\{[\s\S]*\}/);
        if (jsonMatch) {
            var parsed = JSON.parse(jsonMatch[0]);
            if (parsed.stm_entries || parsed._checkpoints) {
                checkpoints = parsed._checkpoints || null;
                stmEntries = parsed.stm_entries || [];
            } else if (Array.isArray(parsed)) {
                stmEntries = parsed;
            }
        } else {
            try {
                var arrayMatch = text.match(/\[[\s\S]*\]/);
                if (arrayMatch) {
                    stmEntries = JSON.parse(arrayMatch[0]);
                    if (!Array.isArray(stmEntries)) stmEntries = [];
                }
            } catch (e2) {}
        }
        if (stmEntries.length === 0 && text.length > 5) {
            stmEntries = [{ event: text.substring(0, 120), scene: '', period: '', time_label: '' }];
        }
    } catch (e) {}

    var stateChanges = {};
    if (stateChangesText) {
        try {
            var parsedState = JSON.parse(stateChangesText);
            if (typeof parsedState === 'object' && parsedState !== null && !Array.isArray(parsedState)) {
                if (!isStateSchemaEnabled()) {
                    stateChanges = whitelistStateChanges(parsedState);
                } else {
                    stateChanges = parsedState;
                }
            }
        } catch (e) {}
    }

    return { stmEntries: stmEntries, stateChanges: stateChanges, _checkpoints: checkpoints };
}

// ─── Handle quest completion ───

export function handleQuestCompletion(state, validatedChanges) {
    if (!state || !validatedChanges) return;
    var currentTime = (state.global && state.global.time) || state.time || '';
    if (!currentTime) return;

    Object.keys(validatedChanges).forEach(function(path) {
        var parts = path.split('.');
        if (parts.length === 4 && parts[0] === 'quests' && parts[1] === 'tasks' && parts[3] === 'status') {
            var taskName = parts[2];
            if (validatedChanges[path] === '已完成') {
                if (!state.quests) state.quests = {};
                if (!state.quests.tasks) state.quests.tasks = {};
                if (!state.quests.tasks[taskName]) state.quests.tasks[taskName] = {};
                state.quests.tasks[taskName].deadline = currentTime;
            }
        }
    });
}

// ─── Main extraction function ───

export async function executeIncrementalUpdate(chatId, newMessages, callLLM, options) {
    options = options || {};
    var force = options.force || false;

    var vault = await read(chatId);
    var processedIds = new Set();
    if (!force) {
        processedIds = collectProcessedMsgIds(vault);
    }
    var filteredMessages = force ? newMessages : filterNewMessages(newMessages, processedIds);
    if (filteredMessages.length === 0) return { vault: vault, added: 0 };

    var prompt = buildSTMUpdatePrompt(filteredMessages, vault);
    var response = await callLLM([{ role: 'system', content: prompt.system }, { role: 'user', content: prompt.user }]);
    var parsed = parseSTMResponse(response);

    var validateErrors = validateSTMOutput(parsed, vault);
    if (validateErrors.length > 0) {
        console.warn('[core/extract] STM output validation failed, retrying:', validateErrors.join('; '));
        var retryMsg = 'YOUR PREVIOUS OUTPUT WAS REJECTED. Missing required fields:\n' +
            validateErrors.map(function(e) { return '- ' + e; }).join('\n') +
            '\n\nYou MUST include the _checkpoints block with "time" and "scene", and every stm_entries item MUST have "event".';
        var retryResponse = await callLLM([
            { role: 'system', content: prompt.system },
            { role: 'user', content: prompt.user },
            { role: 'assistant', content: response },
            { role: 'user', content: retryMsg }
        ]);
        parsed = parseSTMResponse(retryResponse);
        var retryErrors = validateSTMOutput(parsed, vault);
        if (retryErrors.length > 0) {
            console.warn('[core/extract] STM retry also failed, using post-fill:', retryErrors.join('; '));
        }
    }

    postFillSTM(parsed, vault);
    var stmEntries = parsed.stmEntries;
    var stateChanges = parsed.stateChanges;

    if (stmEntries.length === 0 && Object.keys(stateChanges).length === 0) return { vault: vault, added: 0 };

    if (stmEntries.length > 0) {
        var perEntry = Math.max(1, Math.floor(filteredMessages.length / stmEntries.length));
        stmEntries.forEach(function(entry, i) {
            var startIdx = i * perEntry;
            var endIdx = (i === stmEntries.length - 1) ? filteredMessages.length : (i + 1) * perEntry;
            entry.msg_ids = filteredMessages.slice(startIdx, endIdx).map(function(m, idx) { return m.id || m.mes_id || (startIdx + idx); });
            entry.timestamp = new Date().toISOString();
            entry.parent_ltm = null;
        });
        appendSTMEntries(vault, stmEntries);
    }

    if (isStateSchemaEnabled() && Object.keys(stateChanges).length > 0) {
        var schema = vault.content.state_schema || null;
        var result = validateStateChanges(schema, stateChanges);
        if (result.warnings.length > 0) console.warn('[core/extract] State change warnings:', result.warnings);
        var oldState = vault.content.state || {};
        vault.content.state = mergeStateChanges(vault.content.state || {}, result.validated);
        handleQuestCompletion(vault.content.state, result.validated);

        // Note: initPowerSlots is ST-specific and skipped in core.
        // Hosts that need it should implement it via their own adapter.
    }

    if (stateChanges.story_date) {
        vault.content.story_date = String(stateChanges.story_date);
    }

    vault._meta = vault._meta || {};
    vault._meta.last_pipeline_task = 'stm_extract';
    vault._meta.last_pipeline_time = new Date().toISOString();
    vault.version = (vault.version || 0) + 1;

    await write(chatId, vault);

    // Auto-consolidation check
    var unconsolidatedCount = (vault.content.unconsolidated_stm || []).filter(function(s) { return !s.parent_ltm; }).length;
    var maxUnconsolidated = getStmMaxUnconsolidated();
    if (unconsolidatedCount >= maxUnconsolidated) {
        var consResult = await executeConsolidation(chatId, callLLM);
        if (consResult.merged > 0) vault = consResult.vault;
    }

    return { vault: vault, added: stmEntries.length };
}
