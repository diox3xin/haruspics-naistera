const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const test = require('node:test');

const source = fs.readFileSync(path.join(__dirname, '..', 'index.js'), 'utf8');
let novelAI = false;
const context = vm.createContext({ getSettings: () => ({}), isNovelAIPromptTarget: () => novelAI });
vm.runInContext(source.slice(source.indexOf('function otherDescFormat('), source.indexOf('/** Format for describing the bot')), context);

test('an old single description is sorted into text or tags', () => {
    assert.equal(context.looksLikeTagList('pink hair, long hair, white eyelashes, mole under eye'), true);
    assert.equal(context.looksLikeTagList('She has long pink hair. Her eyes are grey.'), false);
    assert.equal(context.looksLikeTagList('A long flowing dress with a high slit, embroidered with silver thread and pearls'), false);
    assert.deepEqual({ ...context.descriptionPair(undefined, 'pink hair, long hair') }, { banana: '', novelai: 'pink hair, long hair' });
    assert.deepEqual({ ...context.descriptionPair(undefined, 'A red coat with brass buttons.') }, { banana: 'A red coat with brass buttons.', novelai: '' });
    // a stored pair is never re-sorted from the mirror
    assert.deepEqual({ ...context.descriptionPair({ banana: 'text', novelai: '' }, 'tag, tag') }, { banana: 'text', novelai: '' });
});

test('wardrobe items keep both descriptions; the picture gets the one for the API, else the other', () => {
    const item = { name: 'Coat', description: 'A red coat with brass buttons.' };
    novelAI = true;
    assert.equal(context.getItemDescription(item, 'novelai'), 'A red coat with brass buttons.', 'falls back to text');
    assert.equal(context.getItemDescription(item, 'novelai', false), '', 'the switch shows the empty tags slot');
    context.setItemDescription(item, 'novelai', 'red coat, brass buttons');
    assert.equal(context.getItemDescription(item, 'novelai'), 'red coat, brass buttons');
    assert.equal(context.getItemDescription(item, 'banana'), 'A red coat with brass buttons.');
    assert.equal(item.description, 'red coat, brass buttons', 'mirror follows the image API');
});

test('profile appearance: two slots, `appearance` is the one for the current API', () => {
    const profile = {};
    novelAI = false;
    context.setProfileAppearance(profile, 'banana', 'Soft pink hair, grey eyes.');
    context.setProfileAppearance(profile, 'novelai', '1.2::light pink hair::, grey eyes');
    assert.equal(profile.appearance, 'Soft pink hair, grey eyes.');
    novelAI = true;
    context.setProfileAppearance(profile, 'novelai', '1.2::light pink hair::, grey eyes, white eyelashes');
    assert.equal(profile.appearance, '1.2::light pink hair::, grey eyes, white eyelashes');
    assert.equal(context.getProfileAppearanceText(profile, 'banana'), 'Soft pink hair, grey eyes.');
});

test('the switch marks filled formats and wardrobe / profiles / prompt fields use it', () => {
    const html = context.descFormatSwitchHtml('novelai', { banana: 'text', novelai: '' });
    assert.match(html, /data-format="banana" aria-pressed="false">Текст · Banana<span class="iig-desc-switch-dot"/);
    assert.match(html, /is-active" data-format="novelai" aria-pressed="true">Теги · NovelAI<\/button>/);
    assert.equal((source.match(/descFormatSwitchHtml\(getVisionDescFormat\(\), ensureItemDescriptions\(activeItem\)\.descriptions\)/g) || []).length, 4, 'two wardrobe and two hairstyle editors');
    assert.match(source, /descFormatSwitchHtml\(getProfileDescFormat\(\), profile\.appearances\)/);
    assert.match(source, /const outfitDescription = getItemDescription\(outfit, apiDescFormat\);/);
    assert.match(source, /const hairDescription = getItemDescription\(hairstyle, apiDescFormat\);/);
    assert.match(source, /const charText = getItemDescription\(charItem, 'banana'\);/);
});
