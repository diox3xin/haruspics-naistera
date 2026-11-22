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

const PNG = 'iVBORw0KGgo' + 'A'.repeat(300);
let settings;
let calls;
let answers;
const toasts = [];
const context = vm.createContext({
    getSettings: () => settings,
    getActiveNegativePrompt: () => settings.negative || '',
    iigLog: () => {},
    toastr: { info: text => toasts.push(text) },
    RANDOM_ASPECT_RATIO: 'random',
    DOMException,
    setTimeout,
    clearTimeout,
    fetch: async (url, init = {}) => {
        calls.push({ url, method: init.method || 'GET', body: init.body ? JSON.parse(init.body) : null, auth: init.headers?.Authorization });
        const [status, body] = answers.shift();
        const text = typeof body === 'string' ? body : JSON.stringify(body);
        return { ok: status >= 200 && status < 300, status, text: async () => text, json: async () => JSON.parse(text) };
    },
});
vm.runInContext([
    grab('normalizeOpenAIBaseUrl'), grab('normalizeApiKey'), grab('buildAuthHeaders'), grab('isGeminiModel'),
    grab('normalizeReturnedImage'), grab('extractImageFromText'), grab('parseImageFromApiResponse'), grab('buildReferenceLegend'),
    grab('isCloseRouterEndpoint'), grab('closeRouterBaseUrl'), grab('closeRouterModelId'), grab('closeRouterSizeFor'),
    'const closeRouterTextOnlyModels = new Set(); globalThis.closeRouterTextOnlyModels = closeRouterTextOnlyModels;',
    grab('closeRouterTakesImages'), grab('isCloseRouterEndpointRefusal'), grab('closeRouterErrorText'), grab('buildCloseRouterPrompt'),
    grab('sleepWithSignal'), grab('parseCloseRouterImage'), grab('waitCloseRouterRequest', 'async function'),
    grab('generateImageCloseRouter', 'async function'),
].join('\n'), context);

const ref = (type, name, extra = {}) => ({ type, name, data: PNG, mimeType: 'image/png', ...extra });
function reset(extra = {}) {
    settings = { endpoint: 'https://closerouter.dev', apiKey: ' Bearer closerouter_abc ', model: 'gemini-3.1-flash-lite-image', aspectRatio: '1:1', imageSize: '2K', size: 'auto', apiType: 'gemini', ...extra };
    calls = [];
    toasts.length = 0;
    context.closeRouterTextOnlyModels.clear();
}

test('addresses, model ids and sizes', () => {
    assert.equal(context.closeRouterBaseUrl('https://closerouter.dev'), 'https://api.closerouter.dev');
    assert.equal(context.closeRouterBaseUrl('https://api.closerouter.dev/v1/'), 'https://api.closerouter.dev');
    assert.equal(context.closeRouterModelId('gemini-3.1-flash-lite-image'), 'google/gemini-3.1-flash-lite-image');
    assert.equal(context.closeRouterModelId('google/gemini-3-pro-image'), 'google/gemini-3-pro-image');
    assert.equal(context.closeRouterModelId('gpt-image-2'), 'openai/gpt-image-2');
    assert.equal(context.closeRouterSizeFor('16:9'), '1024x576');
    assert.equal(context.closeRouterSizeFor('2:3'), '680x1024');
    assert.equal(context.closeRouterSizeFor('1:1'), '1024x1024');
    assert.equal(context.closeRouterSizeFor('', 'auto'), null);
});

test('flash-lite: /images/generations, text only, no unknown fields, references become text', async () => {
    reset({ negative: 'blurry' });
    answers = [[200, { data: [{ b64_json: PNG }], usage: { cost_usd: 0.045 } }]];
    const image = await context.generateImageCloseRouter('a girl in a park', 'anime', {
        imageRefs: [ref('face', 'Hero'), ref('clothing', 'Hero', { outfitName: 'Shirt', description: 'white striped shirt' })],
        textDirectives: ['[HAIRSTYLE INSTRUCTION for "Hero"]: braid'], textOnlyClothing: [],
    }, { aspectRatio: '3:4' });
    assert.equal(image, `data:image/png;base64,${PNG}`);
    assert.equal(calls.length, 1);
    const [call] = calls;
    assert.equal(call.url, 'https://api.closerouter.dev/v1/images/generations');
    assert.equal(call.auth, 'Bearer closerouter_abc');
    assert.equal(call.body.model, 'google/gemini-3.1-flash-lite-image');
    assert.equal(call.body.size, '768x1024');
    assert.equal(call.body.response_format, 'b64_json');
    for (const field of ['images', 'image', 'input', 'negative_prompt', 'aspect_ratio']) assert.equal(call.body[field], undefined, field);
    assert.match(call.body.prompt, /white striped shirt/);
    assert.match(call.body.prompt, /braid/);
    assert.match(call.body.prompt, /Avoid: blurry$/);
    assert.match(toasts[0], /не принимает картинки-референсы/);
});

test('a model with edits gets the references and the resolution', async () => {
    reset({ model: 'google/gemini-3.1-flash-image-preview' });
    answers = [[200, { data: [{ url: 'https://cdn.closerouter.dev/x.png' }] }]];
    const image = await context.generateImageCloseRouter('scene', '', { imageRefs: [ref('face', 'Hero'), ref('clothing', 'Hero')] }, { aspectRatio: '16:9' });
    assert.equal(image, 'https://cdn.closerouter.dev/x.png');
    const [call] = calls;
    assert.equal(call.url, 'https://api.closerouter.dev/v1/images/edits');
    assert.equal(call.body.images.length, 2);
    assert.match(call.body.images[0], /^data:image\/png;base64,/);
    assert.equal(call.body.input.resolution, '2K');
    assert.match(call.body.prompt, /Image 1 = FACE of "Hero"/);
});

test('no /images/edits for a model: remembered, drawn from text', async () => {
    reset({ model: 'black-forest-labs/flux-2-pro' });
    answers = [
        [400, { error: { code: 'unsupported_operation', message: 'Operation images_edits is not supported for this model' } }],
        [200, { data: [{ b64_json: PNG }] }],
    ];
    await context.generateImageCloseRouter('scene', '', { imageRefs: [ref('face', 'Hero')] }, {});
    assert.deepEqual(calls.map(call => call.url.split('/v1/')[1]), ['images/edits', 'images/generations']);
    assert.equal(calls[1].body.images, undefined);
    answers = [[200, { data: [{ b64_json: PNG }] }]];
    await context.generateImageCloseRouter('scene', '', { imageRefs: [ref('face', 'Hero')] }, {});
    assert.equal(calls[2].url.split('/v1/')[1], 'images/generations', 'no second wasted edits call');
});

test('202 image.request is polled until the picture is there', async () => {
    reset();
    answers = [
        [202, { object: 'image.request', id: 'req_1', status: 'pending' }],
        [200, { object: 'image.request', id: 'req_1', status: 'pending' }],
        [200, { object: 'image.request', id: 'req_1', status: 'succeeded', data: [{ b64_json: PNG }] }],
    ];
    const original = context.sleepWithSignal;
    context.sleepWithSignal = async () => {};
    try {
        vm.runInContext('sleepWithSignal = async () => {};', context);
        const image = await context.generateImageCloseRouter('scene', '', {}, {});
        assert.equal(image, `data:image/png;base64,${PNG}`);
        assert.deepEqual(calls.map(call => call.method + ' ' + call.url.split('/v1/')[1]), ['POST images/generations', 'GET media/requests/req_1', 'GET media/requests/req_1']);

        answers = [[202, { object: 'image.request', id: 'req_2' }], [200, { id: 'req_2', status: 'outcome_unknown' }]];
        await assert.rejects(context.generateImageCloseRouter('scene', '', {}, {}), error => /outcome_unknown/.test(error.message) && !/timeout|50\d|429/.test(error.message));
    } finally {
        context.sleepWithSignal = original;
    }
});

test('a refused resolution is retried without it; other errors keep the status for the retry logic', async () => {
    reset({ model: 'google/gemini-3-pro-image', imageSize: '4K' });
    answers = [
        [400, { error: { message: 'input.resolution: allowed values are 1K, 2K' } }],
        [200, { data: [{ b64_json: PNG }] }],
    ];
    await context.generateImageCloseRouter('scene', '', {}, {});
    assert.equal(calls[0].body.input.resolution, '4K');
    assert.equal(calls[1].body.input, undefined);

    reset();
    answers = [[503, { error: { message: 'upstream busy' } }]];
    await assert.rejects(context.generateImageCloseRouter('scene', '', {}, {}), /API Error \(503\): upstream busy/);
});

test('every CloseRouter image request goes to the images API, before the chat route', () => {
    const start = source.indexOf('async function generateImageWithRetry(');
    const body = source.slice(start, source.indexOf('const useChatApi', start));
    assert.match(body, /isCloseRouterEndpoint\(settings\.endpoint\)[^\n]*\n\s*return await generateImageCloseRouter\(/);
});

test('the reference generator can use its own CloseRouter key and model', async () => {
    reset({ endpoint: 'https://other.example', apiKey: 'main', model: 'main-model' });
    answers = [[200, { data: [{ b64_json: PNG }] }]];
    await context.generateImageCloseRouter('ref', '', {}, { api: { endpoint: 'https://api.closerouter.dev/v1', apiKey: 'closerouter_ref', model: 'gemini-3.1-flash-lite-image' }, aspectRatio: '2:3' });
    assert.equal(calls[0].url, 'https://api.closerouter.dev/v1/images/generations');
    assert.equal(calls[0].auth, 'Bearer closerouter_ref');
    assert.equal(calls[0].body.model, 'google/gemini-3.1-flash-lite-image');
});

test('the reference generator sends a CloseRouter custom API to the images handler', () => {
    const start = source.indexOf('async function generateReferenceImage(');
    const body = source.slice(start, source.indexOf("buildOpenAIUrl(settings.refGenEndpoint, 'chat/completions')", start));
    assert.match(body, /isCloseRouterEndpoint\(settings\.refGenEndpoint\)/);
    assert.match(body, /generateImageCloseRouter\(prompt, '', refData, \{ api,/);
});
