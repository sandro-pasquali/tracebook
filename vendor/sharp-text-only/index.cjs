'use strict';

function sharpTextOnlyGuard() {
    throw new Error(
        'Image processing is unavailable: Tracebook replaces Transformers.js\' unused Sharp dependency with a text-only guard.'
    );
}

sharpTextOnlyGuard.isTracebookTextOnlyGuard = true;

module.exports = sharpTextOnlyGuard;
