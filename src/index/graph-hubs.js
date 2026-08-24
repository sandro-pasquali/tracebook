import path from 'node:path';

const IMPORT_GRAPH_CACHE_TTL_MS = 30_000;
const importGraphCache = new WeakMap();

// Import-graph orchestrators — the files that wire the most project files
// together. The code_graph table records every import edge with its specifier
// as written; this resolves the project-local ones and ranks files by how many
// DISTINCT project files they import (out-degree). That profile finds entry
// points and orchestrators — server entries, pipeline coordinators, indexers —
// which is the spine an overview answer should walk. (In-degree was measured
// and rejected: it surfaces shared leaf utilities like config/model helpers,
// the most-imported but least narratable files in a repo.)
//
// Resolution is language-agnostic: relative specifiers resolve against the
// importer's directory; non-relative specifiers (Python-style dotted modules,
// bare repo paths) match by extensionless suffix. Specifiers that match no
// indexed file (npm packages, stdlib) simply drop out.
//
export async function computeImportHubs({store, limit = 5}) {
    const {outgoing} = await resolvedImportGraph(store);

    return [...outgoing.entries()]
        .map(([hubPath, wired]) => ({path: hubPath, wires: wired.size}))
        .sort((a, b) => b.wires - a.wires || a.path.localeCompare(b.path))
        .slice(0, limit);
}

// Centrality alone over-selects one architectural neighborhood (often server
// route files). For an overview, pick the strongest hub for each narratable
// role first, then fill remaining slots by centrality. The role rules are
// intentionally ecosystem-neutral path conventions.
//
export function selectArchitectureSpine(hubs, limit = 5) {
    const ranked = hubs || [];
    const selected = [];
    const seen = new Set();
    const roles = ['entrypoint', 'orchestration', 'data', 'presentation', 'runtime'];
    for(const role of roles) {
        const hub = ranked.find((candidate) => architectureRole(candidate?.path) === role && !seen.has(candidate.path));
        if(!hub) {
            continue;
        }
        selected.push(hub);
        seen.add(hub.path);
        if(selected.length >= limit) {
            return selected;
        }
    }
    for(const hub of ranked) {
        if(!hub?.path || seen.has(hub.path)) {
            continue;
        }
        selected.push(hub);
        seen.add(hub.path);
        if(selected.length >= limit) {
            break;
        }
    }
    return selected;
}

// Expand semantically/lexically retrieved seed files through actual local
// import edges. This retrieves the collaborators product and flow questions
// need (what a seed calls and who calls it) without polluting exact-symbol
// lookup with nearby files. The resolved graph is cached briefly because its
// construction is O(edges + paths), while an ask can run several searches.
//
export async function expandImportNeighbors({store, seedPaths = [], limit = 8}) {
    if(!store || typeof store.importEdges !== 'function' || typeof store.knownPaths !== 'function') {
        return [];
    }
    const {outgoing, incoming} = await resolvedImportGraph(store);
    const seeds = [...new Set(seedPaths.filter(Boolean))];
    const seedSet = new Set(seeds);
    const out = [];
    const seen = new Set();
    const add = (path, relatedTo, direction) => {
        if(!path || seedSet.has(path) || seen.has(path) || out.length >= limit) {
            return;
        }
        seen.add(path);
        out.push({path, relatedTo, direction});
    };

    // Walk one hop in both directions, round-robin by seed rank. One hop is
    // intentional: it brings in immediate callers/callees while avoiding the
    // high-degree graph flood that would erase the original semantic signal.
    for(const seed of seeds) {
        for(const imported of outgoing.get(seed) || []) {
            add(imported, seed, 'imports');
        }
        for(const importer of incoming.get(seed) || []) {
            add(importer, seed, 'imported_by');
        }
        if(out.length >= limit) {
            break;
        }
    }
    return out;
}

async function resolvedImportGraph(store) {
    const now = Date.now();
    const cached = importGraphCache.get(store);
    if(cached && cached.expiresAt > now) {
        return cached.promise;
    }
    const promise = buildResolvedImportGraph(store);
    importGraphCache.set(store, {expiresAt: now + IMPORT_GRAPH_CACHE_TTL_MS, promise});
    try {
        return await promise;
    } catch(err) {
        importGraphCache.delete(store);
        throw err;
    }
}

async function buildResolvedImportGraph(store) {
    const [edges, knownList] = await Promise.all([store.importEdges(), store.knownPaths()]);
    const known = new Set(knownList);
    const byExtensionless = new Map();
    for(const knownPath of knownList) {
        const stripped = stripExtension(knownPath);
        if(!byExtensionless.has(stripped)) {
            byExtensionless.set(stripped, knownPath);
        }
    }
    const outgoing = new Map();
    const incoming = new Map();
    for(const edge of edges) {
        const resolved = resolveImportTarget(edge, {known, byExtensionless});
        if(!resolved || resolved === edge.path) {
            continue;
        }
        addGraphEdge(outgoing, edge.path, resolved);
        addGraphEdge(incoming, resolved, edge.path);
    }
    return {outgoing, incoming};
}

function addGraphEdge(graph, from, to) {
    let neighbors = graph.get(from);
    if(!neighbors) {
        neighbors = new Set();
        graph.set(from, neighbors);
    }
    neighbors.add(to);
}

function architectureRole(value) {
    const path = String(value || '').toLowerCase();
    const base = path.split('/').pop() || '';
    if(/(^|\/)(planner|orchestrat\w*|workflow|pipeline|services?)(\/|\.|$)/.test(path)) {
        return 'orchestration';
    }
    if(/(^|\/)(index|indexer|store|storage|database|db|models?|repositories|dao)(\/|\.|$)/.test(path)) {
        return 'data';
    }
    if(/(^|\/)(public|client|frontend|ui|views?|templates?|components?|pages?)(\/|$)/.test(path)) {
        return 'presentation';
    }
    if(/(^|\/)(runtime|bootstrap|startup|config|settings?)(?:[-/.]|$)/.test(path)) {
        return 'runtime';
    }
    if(/^(?:main|app|server|index|cli)\.[^.]+$/.test(base) && path.split('/').length <= 3) {
        return 'entrypoint';
    }
    return 'core';
}

function stripExtension(value) {
    return String(value || '').replace(/\.[^/.]+$/, '');
}

function resolveImportTarget(edge, {known, byExtensionless}) {
    const target = String(edge.target || '').trim();
    if(!target) {
        return null;
    }
    if(target.startsWith('.')) {
        const resolved = path.posix.normalize(path.posix.join(path.posix.dirname(String(edge.path || '')), target));
        if(known.has(resolved)) {
            return resolved;
        }
        return byExtensionless.get(stripExtension(resolved)) || byExtensionless.get(resolved) || null;
    }
    const candidates = [target, target.replaceAll('.', '/')];
    for(const candidate of candidates) {
        if(known.has(candidate)) {
            return candidate;
        }
        for(const [stripped, fullPath] of byExtensionless) {
            if(stripped === candidate || stripped.endsWith(`/${candidate}`)) {
                return fullPath;
            }
        }
    }
    return null;
}
