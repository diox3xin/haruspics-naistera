const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const test = require('node:test');

const source = fs.readFileSync(path.join(__dirname, '..', 'index.js'), 'utf8');
function grab(name, prefix = 'function') {
    const start = source.indexOf(`${prefix} ${name}(`);
    assert.ok(start >= 0, `${name} must exist`);
    const end = source.slice(start).search(/\r?\n\}\r?\n/);
    return source.slice(start, start + end + source.slice(start + end).indexOf('}') + 1);
}
function grabConst(name) {
    const start = source.indexOf(`const ${name} =`);
    assert.ok(start >= 0, `${name} must exist`);
    return source.slice(start, source.indexOf(';\r\n', start) + 1);
}

const calls = [];
let answers = [];
const toasts = [];
const context = vm.createContext({
    getSettings: () => ({ endpoint: 'https://api.rout.my', apiKey: 'k', model: 'google/gemini-3.1-flash-lite-image', apiType: 'gemini', aspectRatio: '1:1', imageSize: '1K' }),
    iigLog: () => {},
    toastr: { info: (text) => toasts.push(text) },
    buildOpenAIUrl: (endpoint, tail) => `${endpoint}/v1/${tail}`,
    buildAuthHeaders: (key, extra) => ({ ...extra, Authorization: `Bearer ${key}` }),
    isGeminiModel: () => true,
    parseImageFromApiResponse: result => result.image,
    fetch: async (url, init) => {
        calls.push(JSON.parse(init.body).image_config);
        const [status, body] = answers.shift();
        return { ok: status === 200, status, text: async () => body, json: async () => JSON.parse(body), clone() { return this; } };
    },
});
vm.runInContext([
    grabConst('VALID_ASPECT_RATIOS'), grabConst('VALID_IMAGE_SIZES'),
    grab('isRouterEndpoint'), grab('isUnsupportedParamsError'), grab('imageConfigFallbacks'), grab('buildReferenceLegend'),
    grab('generateImageOpenAIChat', 'async function'),
].join('\n'), context);

const REJECT = '{"error":{"code":"Bad Request","message":"Invalid request for this model. Please remove unsupported parameters or adjust the message format."}}';

test('a model that rejects 2K draws again in 1K', async () => {
    calls.length = 0; toasts.length = 0;
    answers = [[400, REJECT], [200, '{"image":"data:image/png;base64,AAA"}']];
    const image = await context.generateImageOpenAIChat('apple', '', {}, { aspectRatio: '16:9', imageSize: '2K' });
    assert.equal(image, 'data:image/png;base64,AAA');
    assert.deepEqual(calls.map(cfg => ({ ...cfg })), [{ aspect_ratio: '16:9', image_size: '2K' }, { aspect_ratio: '16:9', image_size: '1K' }]);
    assert.match(toasts[0], /не поддерживает размер 2K/);
});

test('then without the size at all; other errors are not retried', async () => {
    calls.length = 0;
    answers = [[400, REJECT], [400, REJECT], [200, '{"image":"ok"}']];
    assert.equal(await context.generateImageOpenAIChat('apple', '', {}, { aspectRatio: '3:2', imageSize: '2K' }), 'ok');
    assert.deepEqual(calls.map(cfg => ({ ...cfg })), [{ aspect_ratio: '3:2', image_size: '2K' }, { aspect_ratio: '3:2', image_size: '1K' }, { aspect_ratio: '3:2' }]);
    calls.length = 0;
    answers = [[401, '{"error":"bad key"}']];
    await assert.rejects(context.generateImageOpenAIChat('apple', '', {}, { aspectRatio: '3:2', imageSize: '2K' }), /API Error \(401\)/);
    assert.equal(calls.length, 1);
});
