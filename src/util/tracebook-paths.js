import fs from 'fs-extra';
import os from 'node:os';
import path from 'node:path';

const CONFIG_FILENAME = 'tracebook.config.json';

export function resolveTracebookPaths({
    homeDir = os.homedir(),
    configPathOverride = globalThis.__TRACEBOOK_CONFIG_PATH__
} = {}) {
    const override = String(configPathOverride || '').trim();
    const configPath = override
        ? path.resolve(override)
        : path.resolve(homeDir, '.tracebook', CONFIG_FILENAME);
    const home = override
        ? path.dirname(configPath)
        : path.resolve(homeDir, '.tracebook');
    const dataRoot = path.resolve(home, 'data');
    const reposRoot = path.resolve(dataRoot, 'repos');
    return {home, configPath, dataRoot, reposRoot};
}

export function ensureTracebookHome(paths, {fsImpl = fs} = {}) {
    if(!paths?.home || !paths?.dataRoot || !paths?.reposRoot) {
        throw new Error('ensureTracebookHome requires resolved Tracebook paths.');
    }
    try {
        fsImpl.ensureDirSync(paths.home, {mode: 0o700});
        fsImpl.ensureDirSync(paths.reposRoot, {mode: 0o700});
        fsImpl.accessSync(paths.home, fsImpl.constants.R_OK | fsImpl.constants.W_OK);
        fsImpl.accessSync(paths.dataRoot, fsImpl.constants.R_OK | fsImpl.constants.W_OK);
    } catch(err) {
        throw new Error(`Tracebook application storage is unavailable at ${paths.home}: ${err?.message || err}`, {cause: err});
    }
}
