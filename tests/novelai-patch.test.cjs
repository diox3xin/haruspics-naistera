const test = require('node:test');
const assert = require('node:assert/strict');
const { patchNovelAIEndpoint } = require('../tools/patch-sillytavern-novelai.cjs');

const server = `const unrelated = { params_version: 3 };
router.post('/generate-image', async (request, response) => {
    const payload = { model: request.body.model, parameters: { params_version: 3, steps: 28 } };
});
router.post('/generate-voice', async (request, response) => {});
`;

test('patches only image route, preserving other versions and is idempotent', () => {
    const result = patchNovelAIEndpoint(server);
    assert.equal(result.changed, true);
    assert.match(result.source, /const unrelated = \{ params_version: 3 \}/);
    assert.match(result.source, /params_version: \/\^nai-diffusion-5\(\?:-\|\$\)\/\.test\(request\.body\.model \?\? ''\) \? 4 : 3/);
    const again = patchNovelAIEndpoint(result.source);
    assert.equal(again.changed, false);
    assert.equal(again.source, result.source);
});

test('refuses an unexpected SillyTavern route', () => {
    assert.throws(() => patchNovelAIEndpoint(server.replace('params_version: 3, steps', 'params_version: 4, steps')), /Unexpected NovelAI route version/);
    assert.throws(() => patchNovelAIEndpoint('no route'), /route not found/);
});