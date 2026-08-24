import {serve} from '@hono/node-server';
import {config} from '../util/config.js';
import {childLogger} from '../util/logger.js';
import {isLoopbackHostname} from './http-boundary.js';

const log = childLogger({module: 'bootstrap'});

// Production entry: bind the HTTP server and own the process lifecycle.
// SIGINT/SIGTERM close the listener and release every runtime (watchers,
// LanceDB connection, ONNX sessions) before exit, with a hard-kill timeout so
// a wedged teardown cannot hang shutdown. Last-resort handlers log stray
// rejections instead of letting them kill the server silently.
//
export function startServer({
    app,
    disposeRuntimes = null,
    serveImpl = serve,
    processImpl = process,
    logger = log,
    port = null,
    hostname = null
} = {}) {
    if(!app) {
        throw new Error('startServer requires {app}');
    }
    const resolvedPort = resolvePort({port, processImpl});
    const resolvedHost = resolveHostname({hostname, processImpl});
    const server = serveImpl({fetch: app.fetch, port: resolvedPort, hostname: resolvedHost});
    logger.info({port: resolvedPort, hostname: resolvedHost}, 'server listening');

    let shuttingDown = false;

    async function shutdown(signal) {
        if(shuttingDown) {
            return;
        }
        shuttingDown = true;
        logger.info({signal}, 'shutting down');
        const timeoutMs = config.runtime?.shutdownTimeoutMs ?? 10000;
        const timer = setTimeout(() => {
            logger.warn({timeoutMs}, 'shutdown timed out — exiting');
            processImpl.exit(1);
        }, timeoutMs);
        timer.unref?.();
        try {
            await new Promise((resolve) => {
                server.close(() => resolve());
                server.closeIdleConnections?.();
            });
            if(disposeRuntimes) {
                await disposeRuntimes();
            }
            logger.info('shutdown complete');
            processImpl.exit(0);
        } catch(err) {
            logger.error({err}, 'shutdown failed');
            processImpl.exit(1);
        } finally {
            clearTimeout(timer);
        }
    }

    processImpl.once('SIGINT', () => shutdown('SIGINT'));
    processImpl.once('SIGTERM', () => shutdown('SIGTERM'));
    processImpl.on('unhandledRejection', (reason) => {
        logger.error({err: reason}, 'unhandled promise rejection');
    });
    processImpl.on('uncaughtException', (err) => {
        logger.error({err}, 'uncaught exception — exiting');
        processImpl.exit(1);
    });

    return {server, shutdown, port: resolvedPort, hostname: resolvedHost};
}

// PORT precedence: explicit argument, then the environment, then the config
// default. The listener is always loopback-only.
//
function resolvePort({port, processImpl}) {
    const candidates = [port, processImpl.env?.PORT, config.port, 3000];
    for(const candidate of candidates) {
        const value = Number(candidate);
        if(Number.isInteger(value) && value >= 1 && value <= 65535) {
            return value;
        }
    }
    return 3000;
}

function resolveHostname({hostname, processImpl}) {
    const value = hostname ?? processImpl.env?.HOST ?? '127.0.0.1';
    if(!isLoopbackHostname(value)) {
        throw new Error('Tracebook must bind to localhost, 127.0.0.1, or ::1.');
    }
    return value.toLowerCase();
}
