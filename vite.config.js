import {defineConfig} from 'vite';
import devServer from '@hono/vite-dev-server';
import nodeAdapter from '@hono/vite-dev-server/node';
import build from '@hono/vite-build';

const APP_ENTRY = '../src/server.js';
const ROOT_DIR = 'public';
const DIST_DIR = '../dist';
const DEV_PORT = 5173;
const SERVER_EXTERNAL = [
    '@ai-sdk/openai',
    '@huggingface/transformers',
    '@hono/node-server',
    '@lancedb/lancedb',
    '@napi-rs/keyring',
    'ai',
    'ai-sdk-ollama',
    'apache-arrow',
    'chokidar',
    'fast-glob',
    'fs-extra',
    'hono',
    'pino',
    'pino-pretty',
    'tree-sitter-wasms',
    'web-tree-sitter',
    'zod'
];

export default defineConfig(({command, mode}) => {
    if(command === 'serve') {
        return {
            root: ROOT_DIR,
            server: {
                host: '127.0.0.1',
                port: DEV_PORT,
                strictPort: true,
                open: true
            },
            plugins: [
                devServer({
                    entry: APP_ENTRY,
                    adapter: nodeAdapter
                })
            ]
        };
    }

    if(mode === 'client') {
        return {
            root: ROOT_DIR,
            build: {
                outDir: DIST_DIR,
                emptyOutDir: true
            }
        };
    }

    return {
        root: ROOT_DIR,
        plugins: [
            build({
                entry: APP_ENTRY,
                outputDir: DIST_DIR,
                emptyOutDir: false,
                ssrTarget: 'node',
                external: SERVER_EXTERNAL,
                entryContentAfterHooks: [
                    async (appName) => [
                        "import { startServer } from '/../src/server/bootstrap.js'",
                        "import { disposeAllRuntimes } from '/../src/server.js'",
                        `startServer({ app: ${appName}, disposeRuntimes: disposeAllRuntimes })`
                    ].join('\n')
                ]
            })
        ]
    };
});
