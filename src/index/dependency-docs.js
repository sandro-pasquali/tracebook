import {LANGUAGE_INTEGRATIONS, isDependencyManifestPath} from '../language-integrations/registry.js';

export {isVirtualDependencyPath} from '../language-integrations/dependency-core.js';

export async function collectDependencyDocs({root, repoIgnore} = {}) {
    if(!root) {
        return [];
    }

    const docs = [];
    const seenCollectors = new Set();
    for(const integration of LANGUAGE_INTEGRATIONS) {
        const collect = integration.dependency?.collect;
        if(!collect || seenCollectors.has(collect)) {
            continue;
        }
        seenCollectors.add(collect);
        docs.push(...await collect(root, {
            repoIgnore,
            dependencyExclude: integration.dependency?.exclude || []
        }));
    }

    return dedupeDocs(docs.filter((doc) => doc?.path && doc.content));
}

export function isDependencyManifest(rel) {
    return isDependencyManifestPath(rel);
}

function dedupeDocs(docs) {
    const out = new Map();
    for(const doc of docs) {
        if(!out.has(doc.path)) {
            out.set(doc.path, doc);
        } else {
            out.set(doc.path, {
                path: doc.path,
                content: `${out.get(doc.path).content}\n\n${doc.content}`
            });
        }
    }
    return [...out.values()].sort((a, b) => a.path.localeCompare(b.path));
}
