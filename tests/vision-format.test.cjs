const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const test = require('node:test');

const source = fs.readFileSync(path.join(__dirname, '..', 'index.js'), 'utf8');

function grab(name) {
    const start = source.indexOf(`function ${name}(`);
    assert.ok(start >= 0, `${name} must exist`);
    const end = source.slice(start).search(/\r?\n\}\r?\n/);
    return source.slice(start, start + end + source.slice(start + end).indexOf('}') + 1);
}

const defaultsStart = source.indexOf('const defaultSettings');
const defaultsEnd = source.indexOf('\n});', defaultsStart) + 4;
const visionStart = source.indexOf('const VISION_PROMPTS');
const visionEnd = source.indexOf('\n});', visionStart) + 4;
const settings = {};
const context = vm.createContext({ getSettings: () => settings });
vm.runInContext([
    source.slice(defaultsStart, defaultsEnd).replace('const defaultSettings', 'var defaultSettings'),
    source.slice(visionStart, visionEnd),
    grab('getVisionDescFormat'),
    grab('getVisionPrompt'),
    grab('cleanVisionAnswer'),
    'globalThis.prompt = getVisionPrompt; globalThis.clean = cleanVisionAnswer;',
].join('\n'), context);

test('text format keeps the user prompt for outfits; tags format uses the NovelAI prompt', () => {
    settings.wardrobeDescFormat = 'banana';
    settings.wardrobeDescPrompt = 'My own outfit prompt';
    assert.equal(context.prompt('outfit', settings), 'My own outfit prompt');
    assert.match(context.prompt('appearance', settings), /2-4 sentences/);
    settings.wardrobeDescFormat = 'novelai';
    settings.wardrobeDescPromptNovelAI = '';
    assert.match(context.prompt('outfit', settings), /real Danbooru tag names only, lowercase/);
    assert.match(context.prompt('outfit', settings), /never underscores/);
    assert.match(context.prompt('outfit', settings), /never use photo, realistic/);
    assert.match(context.prompt('hairstyle', settings), /ONLY the hairstyle/);
    assert.match(context.prompt('appearance', settings), /Do NOT tag clothing/);
});

test('tag answers become one clean comma-separated line; text answers stay as they are', () => {
    settings.wardrobeDescFormat = 'novelai';
    assert.equal(context.clean('Tags: white blouse, high collar,\n- black pencil skirt\n- lace gloves.', settings), 'white blouse, high collar, black pencil skirt, lace gloves');
    assert.equal(context.clean('```\nred scarf,, wool coat\n```', settings), 'red scarf, wool coat');
    assert.equal(context.clean('Pleated_Skirt, white_shirt, black footwear, white shirt;', settings), 'pleated skirt, white shirt, black footwear');
    settings.wardrobeDescFormat = 'banana';
    assert.equal(context.clean('  A red wool coat.\nWith a scarf.  ', settings), 'A red wool coat.\nWith a scarf.');
});
