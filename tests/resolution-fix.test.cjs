const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const test = require('node:test');

const source = fs.readFileSync(path.join(__dirname, '..', 'index.js'), 'utf8');

function extractFunction(name) {
    const start = source.indexOf(`async function ${name}(`);
    const next = source.indexOf('\nasync function ', start + 1);
    const end = next > start ? next : source.indexOf('\n// ====', start + 100);
    assert.ok(start >= 0 && end > start, `${name} must exist`);
    return source.slice(start, end);
}

function setup(apiType = 'openai-chat', endpoint = 'https://api.openai.com') {
    const requests = [];
    const config = {
        apiType,
        endpoint,
        apiKey: 'test-key',
        model: 'gpt-4o',
        aspectRatio: '16:9',
        imageSize: '2K',
        negativeGalleryItems: [],
    };
    
    const context = vm.createContext({
        getSettings: () => config,
        iigLog: () => {},
        isRouterEndpoint: (ep) => /openrouter|closerouter|rout\.my/i.test(ep || ''),
        buildOpenAIUrl: (base, path) => `${base.replace(/\/$/, '')}/v1/${path}`,
        buildAuthHeaders: (key, headers) => ({ ...headers, 'Authorization': `Bearer ${key}` }),
        VALID_ASPECT_RATIOS: ['1:1', '2:3', '3:2', '3:4', '4:3', '4:5', '5:4', '9:16', '16:9', '21:9'],
        VALID_IMAGE_SIZES: ['1K', '2K', '4K'],
        isGeminiModel: (id) => /nano-banana|gemini|flash-image|imagen/i.test(String(id || '')),
        parseImageFromApiResponse: () => 'data:image/png;base64,FAKE',
        fetch: async (url, init) => {
            requests.push({ url, body: JSON.parse(init.body) });
            return {
                ok: true,
                json: async () => ({ choices: [{ message: { content: 'data:image/png;base64,FAKE' } }] }),
            };
        },
    });
    
    vm.runInContext(extractFunction('generateImageOpenAIChat'), context);
    return { generate: context.generateImageOpenAIChat, requests, config };
}

test('OpenAI Chat adds aspect ratio to prompt and logs it', async () => {
    const { generate, requests } = setup('openai-chat', 'https://api.openai.com');
    await generate('a cat', 'anime', { imageRefs: [], textOnlyClothing: [], textDirectives: [] }, { aspectRatio: '9:16', imageSize: '4K' });
    
    assert.equal(requests.length, 1);
    const body = requests[0].body;
    assert.ok(body.messages[0].content.some(part => 
        part.type === 'text' && part.text.includes('aspect ratio 9:16')
    ), 'Prompt must include aspect ratio instruction');
    assert.ok(!body.image_config, 'Plain OpenAI Chat should not send image_config');
});

test('Router endpoints receive image_config with aspect_ratio and image_size', async () => {
    const { generate, requests } = setup('openai-chat', 'https://openrouter.ai/api');
    await generate('a dog', '', { imageRefs: [], textOnlyClothing: [], textDirectives: [] }, { aspectRatio: '3:2', imageSize: '1K' });
    
    assert.equal(requests.length, 1);
    const body = requests[0].body;
    assert.ok(body.image_config, 'Router must receive image_config');
    assert.equal(body.image_config.aspect_ratio, '3:2');
    assert.equal(body.image_config.image_size, '1K');
});

test('Falls back to settings when options are missing', async () => {
    const { generate, requests, config } = setup('gemini', 'https://closerouter.ai/api');
    config.aspectRatio = '4:5';
    config.imageSize = '2K';
    
    await generate('a bird', '', { imageRefs: [], textOnlyClothing: [], textDirectives: [] }, {});
    
    assert.equal(requests.length, 1);
    const body = requests[0].body;
    assert.ok(body.messages[0].content.some(part => 
        part.type === 'text' && part.text.includes('aspect ratio 4:5')
    ));
});

test('Validates and sanitizes invalid aspect ratios', async () => {
    const { generate, requests } = setup('openai-chat', 'https://rout.my/api');
    await generate('test', '', { imageRefs: [], textOnlyClothing: [], textDirectives: [] }, { aspectRatio: '999:1', imageSize: 'XL' });
    
    assert.equal(requests.length, 1);
    const body = requests[0].body;
    // Invalid values should fall back to 1:1 and 1K
    assert.ok(body.image_config.aspect_ratio === '1:1');
    assert.ok(body.image_config.image_size === '1K');
});
