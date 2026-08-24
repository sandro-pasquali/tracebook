import {createRequire} from 'node:module';
import {createHash} from 'node:crypto';

export const CREDENTIAL_SERVICE = 'com.bandf.tracebook';
export const CREDENTIAL_FIELDS = [
    'openaiApiKey',
    'anthropicApiKey',
    'googleApiKey',
    'mistralApiKey'
];

const MEMORY_STORE_KEY = Symbol.for('tracebook.credential-store.memory');
const require = createRequire(import.meta.url);
let KeyringEntry = null;

export function createCredentialStore() {
    return createKeychainCredentialStore();
}

export function createMemoryCredentialStore() {
    if(!globalThis[MEMORY_STORE_KEY]) {
        globalThis[MEMORY_STORE_KEY] = new Map();
    }
    const memory = globalThis[MEMORY_STORE_KEY];
    return {
        type: 'memory',
        readCredentials() {
            return fieldsFrom((field) => memory.get(field) || '');
        },
        writeCredentials(credentials = {}) {
            for(const field of CREDENTIAL_FIELDS) {
                const value = String(credentials[field] || '').trim();
                if(value) {
                    memory.set(field, value);
                }
            }
        },
        deleteCredentials(fields = CREDENTIAL_FIELDS) {
            for(const field of fields) {
                memory.delete(field);
            }
        }
    };
}

export function createKeychainCredentialStore() {
    return {
        type: 'keychain',
        readCredentials() {
            return fieldsFrom((field) => readKeychainField(field));
        },
        writeCredentials(credentials = {}) {
            for(const field of CREDENTIAL_FIELDS) {
                const value = String(credentials[field] || '').trim();
                if(value) {
                    writeKeychainField(field, value);
                }
            }
        },
        deleteCredentials(fields = CREDENTIAL_FIELDS) {
            for(const field of fields) {
                try {
                    keyringEntry(CREDENTIAL_SERVICE, field).deletePassword();
                } catch(err) {
                    if(!isNoEntryError(err)) {
                        throw credentialStoreError(`delete ${field}`, err);
                    }
                }
            }
        }
    };
}

export function credentialStatus(credentials) {
    return Object.fromEntries(CREDENTIAL_FIELDS.map((field) => [field, Boolean(String(credentials?.[field] || '').trim())]));
}

export function credentialFingerprints(credentials) {
    return Object.fromEntries(CREDENTIAL_FIELDS.map((field) => [field, credentialFingerprint(credentials?.[field])]));
}

export function credentialFieldsWithValues(credentials = {}) {
    return CREDENTIAL_FIELDS.filter((field) => String(credentials[field] || '').trim());
}

function credentialFingerprint(value) {
    const text = String(value || '').trim();
    if(!text) {
        return '';
    }
    return `sha256:${createHash('sha256').update(text).digest('hex').slice(0, 12)}`;
}

function readKeychainField(field) {
    try {
        return keyringEntry(CREDENTIAL_SERVICE, field).getPassword() || '';
    } catch(err) {
        if(isNoEntryError(err)) {
            return '';
        }
        throw credentialStoreError(`read ${field}`, err);
    }
}

function writeKeychainField(field, value) {
    try {
        keyringEntry(CREDENTIAL_SERVICE, field).setPassword(value);
    } catch(err) {
        throw credentialStoreError(`write ${field}`, err);
    }
}

function fieldsFrom(read) {
    return Object.fromEntries(CREDENTIAL_FIELDS.map((field) => [field, read(field)]));
}

function keyringEntry(service, field) {
    KeyringEntry ||= require('@napi-rs/keyring').Entry;
    return new KeyringEntry(service, field);
}

function isNoEntryError(err) {
    return /NoEntry|no entry|not found|not exist/iu.test(String(err?.message || err || ''));
}

function credentialStoreError(operation, err) {
    const message = err?.message || String(err);
    return new Error(`OS keychain credential store failed to ${operation}: ${message}`);
}
