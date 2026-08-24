import pino from 'pino';
import {config} from './config.js';

const prettyTransport = config.logging.pretty
    ? {
        transport: {
            target: 'pino-pretty',
            options: {
                colorize: true,
                translateTime: 'HH:MM:ss.l',
                ignore: 'pid,hostname',
                messageFormat: '{app} {msg}',
                singleLine: true
            }
        }
    }
    : {};

export const logger = pino({
    name: 'tracebook',
    level: config.logging.level,
    base: {
        app: 'tracebook'
    },
    serializers: {
        err: pino.stdSerializers.err,
        error: pino.stdSerializers.err
    },
    redact: {
        paths: [
            'req.headers.authorization',
            'req.headers.cookie',
            'headers.authorization',
            'headers.cookie',
            '*.apiKey',
            '*.authToken',
            '*.openaiApiKey',
            '*.anthropicApiKey',
            '*.googleApiKey',
            '*.mistralApiKey',
            '*.credentials.openaiApiKey',
            '*.credentials.anthropicApiKey',
            '*.credentials.googleApiKey',
            '*.credentials.mistralApiKey'
        ],
        censor: '[redacted]'
    },
    ...prettyTransport
});

export function childLogger(bindings = {}) {
    return logger.child(bindings);
}
