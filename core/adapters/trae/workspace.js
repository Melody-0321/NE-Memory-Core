// core/adapters/trae/workspace.js — Trae workspace discovery
//
// Scans workspaceStorage directories to discover projects.
// Each workspace = one Trae project = one state.vscdb.

import fs from 'node:fs';
import path from 'node:path';

export function listWorkspaces(workspaceDir, vaultDataDir) {
    if (!workspaceDir || !fs.existsSync(workspaceDir)) return [];

    var entries = fs.readdirSync(workspaceDir, { withFileTypes: true });
    var projects = [];

    for (var i = 0; i < entries.length; i++) {
        var entry = entries[i];
        if (!entry.isDirectory()) continue;

        var wsPath = path.join(workspaceDir, entry.name);
        var vscdbPath = path.join(wsPath, 'state.vscdb');
        var wsJsonPath = path.join(wsPath, 'workspace.json');
        if (!fs.existsSync(vscdbPath)) continue;

        var folder = '';
        try {
            if (fs.existsSync(wsJsonPath)) {
                folder = (JSON.parse(fs.readFileSync(wsJsonPath, 'utf-8'))).folder || '';
            }
        } catch (e) { /* ignore */ }

        var name = deriveProjectName(folder, entry.name);
        var size = 0;
        try { size = fs.statSync(vscdbPath).size; } catch (e) { /* ignore */ }

        var chatIds = [];
        if (vaultDataDir && fs.existsSync(vaultDataDir)) {
            try {
                chatIds = fs.readdirSync(vaultDataDir)
                    .filter(function(f) { return f.endsWith('.json'); })
                    .map(function(f) { return f.replace('.json', ''); });
            } catch (e) { /* ignore */ }
        }

        projects.push({ id: entry.name, name: name, folder: folder, vscdbPath: vscdbPath, size: size, chatIds: chatIds });
    }

    projects.sort(function(a, b) { return b.size - a.size; });
    return projects;
}

function deriveProjectName(folder, fallbackId) {
    if (!folder) return fallbackId;
    try {
        var decoded = folder;
        if (decoded.indexOf('file:///') === 0) decoded = decodeURIComponent(decoded.replace('file:///', ''));
        decoded = decoded.replace(/\\/g, '/');
        var parts = decoded.split('/').filter(Boolean);
        if (parts.length > 0) return parts[parts.length - 1] || fallbackId;
    } catch (e) { /* fallback */ }
    return fallbackId;
}
