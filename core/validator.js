// core/validator.js — General STM/LTM output validation and post-fill
//
// No external dependencies. Pure validation logic for agent/general mode.
// RP-specific validators have been moved to core/engine/rp/rp-validator.js.

export function validateSTMOutput(parsed, vault, options) {
    var errors = [];
    var stmEntries = parsed.stmEntries || [];

    for (var i = 0; i < stmEntries.length; i++) {
        var e = stmEntries[i];
        if (!e.event || !String(e.event).trim()) {
            errors.push('stm_entries[' + i + '].event is REQUIRED');
        }
    }

    return errors;
}

export function postFillSTM(parsed, vault) {
    var content = vault && vault.content || {};
    var state = content.state || {};
    var stmEntries = parsed.stmEntries || [];

    var defaultPeriod = state.time || content.story_time || new Date().toISOString().slice(0, 10);
    var defaultScene = state.scene || content.story_scene || '';

    for (var i = 0; i < stmEntries.length; i++) {
        var e = stmEntries[i];
        e.period = defaultPeriod;
        e.scene = defaultScene;
    }

    if (!content.story_time) {
        content.story_time = new Date().toISOString().slice(0, 10);
    }
    if (!content.story_scene) {
        content.story_scene = 'unknown';
    }

    return parsed;
}

export function validateLTMOutput(result) {
    var errors = [];
    var entries = result.ltm_entries || [];

    if (entries.length === 0) {
        return errors;
    }

    for (var i = 0; i < entries.length; i++) {
        var e = entries[i];
        if (!e.event || !String(e.event).trim()) {
            errors.push('ltm_entries[' + i + '].event is REQUIRED');
        }
        if (!e.period || !String(e.period).trim()) {
            errors.push('ltm_entries[' + i + '].period is REQUIRED');
        }
        if (!e.scene || !String(e.scene).trim()) {
            errors.push('ltm_entries[' + i + '].scene is REQUIRED');
        }
        if (!e.stm_refs || e.stm_refs.length === 0) {
            errors.push('ltm_entries[' + i + '].stm_refs is REQUIRED');
        }
    }

    return errors;
}

export function postFillLTM(result, sourceSTMList) {
    var entries = result.ltm_entries || [];

    for (var i = 0; i < entries.length; i++) {
        var e = entries[i];

        if (!e.stm_refs || e.stm_refs.length === 0) {
            e.stm_refs = sourceSTMList.map(function(s) { return s.id; }).filter(Boolean);
        }

        if (!e.period || !String(e.period).trim()) {
            var periods = [];
            (e.stm_refs || []).forEach(function(refId) {
                var found = sourceSTMList.find(function(s) { return s.id === refId; });
                if (found && found.period) periods.push(found.period);
            });
            if (periods.length > 0) {
                var unique = [];
                periods.forEach(function(p) { if (unique.indexOf(p) === -1) unique.push(p); });
                e.period = unique.join('→');
            }
        }

        if (!e.scene || !String(e.scene).trim()) {
            var scenes = [];
            (e.stm_refs || []).forEach(function(refId) {
                var found = sourceSTMList.find(function(s) { return s.id === refId; });
                if (found && found.scene) scenes.push(found.scene);
            });
            if (scenes.length > 0) {
                var sceneCounts = {};
                scenes.forEach(function(s) { sceneCounts[s] = (sceneCounts[s] || 0) + 1; });
                var best = '';
                var bestCount = 0;
                Object.keys(sceneCounts).forEach(function(k) {
                    if (sceneCounts[k] > bestCount) { best = k; bestCount = sceneCounts[k]; }
                });
                e.scene = best;
            }
        }

        if (!e.id) {
            e.id = 'ltm_' + (Math.floor(Date.now() / 1000));
        }
    }

    return result;
}

export function mergeStoryPeriod(storyTime, storyDate) {
    var parts = [];
    if (storyTime) parts.push(storyTime);
    if (storyDate) parts.push(storyDate);
    return parts.join(' ─ ');
}

export function whitelistStateChanges(changes) {
    return changes || {};
}
