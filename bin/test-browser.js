import {configure, processCLIArgs, run} from '@japa/runner';
import {assert} from '@japa/assert';
import {browserClient} from '@japa/browser-client';
import {startTestServer} from '../test/browser/helpers/server.js';

// Japa entry point for the client-UI browser suite (Playwright under the hood).
// Kept separate from the node:test suites and out of `yarn test`/`yarn verify`.
// The canned server boots once in setup; its URL is shared with the specs via a
// global, and torn down when the run finishes.
//
processCLIArgs(process.argv.slice(2));

configure({
    suites: [
        {
            name: 'browser',
            files: ['test/browser/**/*.spec.js'],
            timeout: 30000
        }
    ],
    plugins: [
        assert(),
        browserClient({runInSuites: ['browser']})
    ],
    setup: [
        async () => {
            const server = await startTestServer();
            globalThis.__TEST_BASE_URL = server.url;
            return async () => {
                await server.close();
            };
        }
    ]
});

run();
