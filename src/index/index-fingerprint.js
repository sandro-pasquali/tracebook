import crypto from 'node:crypto';
import {CHUNK_CHAR_OVERLAP, CHUNKER_VERSION, MAX_CHUNK_CHARS} from './chunker.js';
import {SOURCE_GRAPH_VERSION} from '../util/source-syntax.js';
import {config} from '../util/config.js';
import {EMBEDDING_TEXT_VERSION} from './embedding-text.js';
import {MAX_INDEX_FILE_BYTES} from './readable-text.js';

// Content-addresses everything that changes the vectors produced for a given file:
// the indexer/chunker/embedding-text/lexical/enrichment scheme versions, the chunker
// settings, the file-size cap, and the embedding model (provider, model, dims, dtype,
// doc prefix). A changed fingerprint invalidates stored content hashes so indexAll
// re-embeds cleanly. Extracted from indexer.js; the inputs and ordering are unchanged.
//

const INDEXER_VERSION = '2';
// Bumped when the lexical layer moved from hand-rolled token tables to native
// BM25 full-text search; forces a clean reindex of existing stores.
//
const LEXICAL_INDEX_VERSION = '2-fts';
// Bumped when the index-time enrichment scheme changes; combined with whether
// enrichment is on, it invalidates content hashes so toggling re-embeds cleanly.
//
const ENRICHMENT_VERSION = '1';

export function buildIndexFingerprint({embedder, enrichment}) {
    const input = {
        indexerVersion: INDEXER_VERSION,
        embeddingTextVersion: EMBEDDING_TEXT_VERSION,
        lexicalIndexVersion: LEXICAL_INDEX_VERSION,
        enrichment: {
            version: ENRICHMENT_VERSION,
            enabled: Boolean(enrichment?.enabled),
            model: enrichment?.enabled ? (enrichment.model || '') : ''
        },
        sourceGraphVersion: SOURCE_GRAPH_VERSION,
        chunkerVersion: CHUNKER_VERSION,
        chunker: {
            smallFileLines: config.chunker.smallFileLines,
            windowLines: config.chunker.windowLines,
            windowOverlap: config.chunker.windowOverlap,
            maxChunkChars: MAX_CHUNK_CHARS,
            chunkCharOverlap: CHUNK_CHAR_OVERLAP
        },
        index: {
            maxFileBytes: MAX_INDEX_FILE_BYTES
        },
        embeddings: {
            provider: embedder?.provider || '',
            model: embedder?.model || '',
            dims: embedder?.dims || 0,
            // dtype and the document prefix both change the stored vectors for the
            // same content, so a change reindexes (re-embeds) cleanly. queryPrefix
            // is query-time only and deliberately excluded.
            //
            dtype: embedder?.dtype || '',
            docPrefix: embedder?.docPrefix || ''
        }
    };
    return crypto
        .createHash('sha256')
        .update(stableStringify(input), 'utf8')
        .digest('hex')
        .slice(0, 16);
}

function stableStringify(value) {
    if(Array.isArray(value)) {
        return `[${value.map((item) => stableStringify(item)).join(',')}]`;
    }
    if(value && typeof value === 'object') {
        return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(',')}}`;
    }
    return JSON.stringify(value);
}
