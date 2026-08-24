import test from 'node:test';
import assert from 'node:assert/strict';

test('the Transformers runtime uses the text-only Sharp guard', async () => {
    const sharpModuleUrl = import.meta.resolve('sharp');
    const {default: sharp} = await import(sharpModuleUrl);

    assert.match(sharpModuleUrl, /vendor\/sharp-text-only\/index\.cjs$/);
    assert.equal(sharp.isTracebookTextOnlyGuard, true);
    assert.throws(
        () => sharp(),
        /Tracebook replaces Transformers\.js' unused Sharp dependency/
    );

    const transformers = await import('@huggingface/transformers');
    assert.equal(typeof transformers.pipeline, 'function');
    assert.equal(typeof transformers.AutoTokenizer.from_pretrained, 'function');
    assert.equal(typeof transformers.AutoModelForSequenceClassification.from_pretrained, 'function');
});
