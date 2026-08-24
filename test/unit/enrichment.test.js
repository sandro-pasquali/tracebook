import test from 'node:test';
import assert from 'node:assert/strict';
import {createEnricher} from '../../src/index/enrichment.js';

// Uses the `generate` test seam so no model/API is touched.
//
test('createEnricher returns null when disabled', () => {
    assert.equal(createEnricher({model: 'openai/gpt-4o-mini', enabled: false}), null);
    assert.equal(createEnricher({model: '', enabled: true}), null);
});

test('describe returns a trimmed one-line product description', async () => {
    const seen = [];
    const enricher = createEnricher({
        model: 'openai/gpt-4o-mini',
        enabled: true,
        generate(args) {
            seen.push(args);
            return Promise.resolve({text: '  Charges a customer\'s card during checkout.\n'});
        }
    });
    const out = await enricher.describe('src/billing.js', 'export function chargeCard() {}');
    assert.equal(out, 'Charges a customer\'s card during checkout.');
    assert.match(seen[0].prompt, /src\/billing\.js/);
});

test('describe is best-effort: empty content and errors yield empty string', async () => {
    const ok = createEnricher({model: 'openai/gpt-4o-mini', enabled: true, generate: () => Promise.resolve({text: 'x'})});
    assert.equal(await ok.describe('a.js', '   '), '');

    const boom = createEnricher({
        model: 'openai/gpt-4o-mini',
        enabled: true,
        generate() {
            throw new Error('model unavailable');
        }
    });
    assert.equal(await boom.describe('a.js', 'real content here'), '');
});
