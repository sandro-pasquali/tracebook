import test from 'node:test';
import assert from 'node:assert/strict';
import {codeImageFilename, validateCodeImageSelection} from '../../public/js/runtime/code-image.js';

test('code image download names are filesystem safe', () => {
    assert.equal(codeImageFilename({
        path: 'src/routes/admin panel.tsx',
        title: 'src/routes/admin panel.tsx:12-18'
    }), 'src-routes-admin-panel-code.png');
});

test('code image selections normalize line endings without changing source text', () => {
    assert.deepEqual(validateCodeImageSelection({
        code: 'const first = 1;\r\nconst second = 2;',
        path: 'src/example.js',
        language: 'javascript',
        title: 'src/example.js:1-2'
    }), {
        code: 'const first = 1;\nconst second = 2;',
        path: 'src/example.js',
        language: 'javascript',
        title: 'src/example.js:1-2'
    });
});

test('code image selections reject empty and oversized source', () => {
    assert.throws(
        () => validateCodeImageSelection({code: '   '}),
        /Select some code/v
    );
    assert.throws(
        () => validateCodeImageSelection({code: 'x'.repeat(30_001)}),
        /30,000 characters or fewer/v
    );
});
