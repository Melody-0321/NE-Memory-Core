// core/engine/consolidate.js — STM→LTM consolidation engine
//
// When unconsolidated STM reaches threshold, merges them into LTM summaries.
// callLLM is injected as a dependency.

import { read, write } from '../store.js';
import { getStmMaxUnconsolidated } from '../config.js';
import { validateLTMOutput, postFillLTM } from '../validator.js';
import { buildConsolidatePrompt } from '../prompts.js';

function findNextId(vault) {
    var content = vault.content || {};
    var max = 0;
    (content.ltm_entries || []).forEach(function(e) {
        var num = parseInt(String(e.id || '').replace('ltm_', ''), 10);
        if (num > max) max = num;
    });
    return 'ltm_' + (max + 1);
}

export function checkConsolidateThreshold(vault) {
    var content = vault.content || {};
    var maxUnconsolidated = getStmMaxUnconsolidated();
    var unconsolidated = (content.unconsolidated_stm || []).filter(function(stm) { return !stm.parent_ltm; });
    if (unconsolidated.length < maxUnconsolidated) return false;
    // Also check total text length to avoid consolidating too few short entries
    var totalText = 0;
    unconsolidated.forEach(function(s) {
        totalText += (s.event || '').length + (s.scene || '').length;
    });
    if (totalText < maxUnconsolidated * 40) return false;
    return true;
}

export function parseConsolidateResponse(llmResponse) {
    try {
        var text = String(llmResponse || '').trim();
        var jsonMatch = text.match(/\{[\s\S]*\}/);
        if (jsonMatch) return JSON.parse(jsonMatch[0]);
        return JSON.parse(text);
    } catch (e) {
        return { ltm_entries: [], delete_stm_ids: [] };
    }
}

export function applyConsolidation(vault, consolidationResult) {
    var content = vault.content || {};
    content.stm_entries = content.stm_entries || [];
    var allSTM = (content.unconsolidated_stm || []).concat(content.stm_entries || []);

    var ltmEntries = consolidationResult.ltm_entries || [];
    ltmEntries.forEach(function(ltm) {
        if (!ltm.id) ltm.id = findNextId(vault);

        var sourceSTM = allSTM.filter(function(s) {
            return (ltm.stm_refs || []).indexOf(s.id) !== -1;
        });
        ltm.time_range = deriveTimeRange(sourceSTM);

        content.ltm_entries.push(ltm);
        (ltm.stm_refs || []).forEach(function(stmId) {
            if (vault.stm_index && vault.stm_index[stmId]) {
                vault.stm_index[stmId].ltm_id = ltm.id;
            }
            var found = allSTM.find(function(s) { return s.id === stmId; });
            if (found) found.parent_ltm = ltm.id;
        });
    });
    var unconsolidated = content.unconsolidated_stm || [];
    var consolidated = unconsolidated.filter(function(s) { return s.parent_ltm; });
    if (consolidated.length > 0) {
        content.stm_entries = (content.stm_entries || []).concat(consolidated);
        content.unconsolidated_stm = unconsolidated.filter(function(s) { return !s.parent_ltm; });
    }
    return ltmEntries.length;
}

function deriveTimeRange(sourceSTMEntries) {
    var timed = sourceSTMEntries.filter(function(s) {
        return (s.period || s.time_label);
    });

    if (timed.length === 0) return null;

    var first = timed[0];
    var last = timed[timed.length - 1];

    var fmt = function(s) {
        var parts = [];
        if (s.period) parts.push(s.period);
        if (s.time_label) parts.push(s.time_label);
        return parts.join('·');
    };

    if (timed.length === 1) return fmt(first);

    if (first.period === last.period) {
        return first.period + ': ' + (first.time_label || '?') + ' → ' + (last.time_label || '?');
    }
    return fmt(first) + ' → ' + fmt(last);
}

export async function executeConsolidation(chatId, callLLM) {
    var vault = await read(chatId);
    if (!checkConsolidateThreshold(vault)) return { vault: vault, merged: 0 };
    var content = vault.content || {};
    var unconsolidated = (content.unconsolidated_stm || []).filter(function(stm) { return !stm.parent_ltm; });
    var prompt = buildConsolidatePrompt(vault);
    var response = await callLLM([{ role: 'system', content: prompt.system }, { role: 'user', content: prompt.user }]);
    var result = parseConsolidateResponse(response);

    var validateErrors = validateLTMOutput(result);
    if (validateErrors.length > 0) {
        console.warn('[core/consolidate] LTM output validation failed, retrying:', validateErrors.join('; '));
        var retryMsg = 'YOUR PREVIOUS OUTPUT WAS REJECTED. Every ltm_entries item MUST have "event", "period", "scene", and "stm_refs". Fix and re-output the JSON.';
        var retryResponse = await callLLM([
            { role: 'system', content: prompt.system },
            { role: 'user', content: prompt.user },
            { role: 'assistant', content: response },
            { role: 'user', content: retryMsg }
        ]);
        result = parseConsolidateResponse(retryResponse);
    }

    postFillLTM(result, unconsolidated);
    var merged = applyConsolidation(vault, result);
    if (merged > 0) {
        vault._meta = vault._meta || {};
        vault._meta.last_pipeline_task = 'consolidation';
        vault._meta.last_pipeline_time = new Date().toISOString();
        vault.version = (vault.version || 0) + 1;
        await write(chatId, vault);
    }
    return { vault: vault, merged: merged };
}
