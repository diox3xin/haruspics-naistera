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
function grabConst(name, keyword = 'const') {
    const start = source.indexOf(`${keyword} ${name} =`);
    assert.ok(start >= 0, `${name} must exist`);
    return source.slice(start, source.indexOf(';', start) + 1);
}

const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
const JPG = '/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAEBAQ==';

let settings;
let server; // path -> base64 written by /api/images/upload
let calls;
let uploadFails = false;
let saves = 0;

const context = vm.createContext({
    getSettings: () => settings,
    saveSettings: () => { saves++; },
    iigLog: () => {},
    toastr: { error: () => {}, info: () => {}, success: () => {} },
    SillyTavern: { getContext: () => ({ getRequestHeaders: () => ({ 'Content-Type': 'application/json' }) }) },
    FileReader: class {
        readAsDataURL(blob) { this.result = `data:${blob.type};base64,${blob.b64}`; setTimeout(() => this.onloadend(), 0); }
    },
    fetch: async (url, init = {}) => {
        calls.push({ url, body: init.body ? JSON.parse(init.body) : null });
        if (url === '/api/images/upload') {
            if (uploadFails) return { ok: false, status: 404, json: async () => ({}) };
            const body = JSON.parse(init.body);
            const file = `user/images/${body.ch_name}/${body.filename}.${body.format}`;
            server.set(file, body.image);
            return { ok: true, status: 200, json: async () => ({ path: file }) };
        }
        if (url === '/api/images/delete') {
            server.delete(JSON.parse(init.body).path);
            return { ok: true, status: 200 };
        }
        const file = url.replace(/^\//, '');
        if (!server.has(file)) return { ok: false, status: 404 };
        return { ok: true, status: 200, blob: async () => ({ type: 'image/png', b64: server.get(file) }) };
    },
    setTimeout,
});
vm.runInContext([
    grab('detectMimeType'),
    grabConst('WARDROBE_FILES_FOLDER'), grabConst('wardrobeMissingFiles'), grabConst('wardrobeFileLoads'),
    'let wardrobeMigrationRunning = false; let wardrobeMigrationAgain = false;',
    grab('getWardrobeImageItems'), grab('hideItemImageFromSettings'), grab('isItemImageInSettings'), grab('hasItemImage'),
    grab('wardrobeFileUrl'), grab('itemImageSrc'),
    grab('uploadWardrobeImageFile', 'async function'), grab('deleteWardrobeImageFile', 'async function'),
    grab('deleteWardrobeFilesOf'), grab('storeItemImageAsFile', 'async function'), grab('setItemImage'),
    grab('readWardrobeImageFile', 'async function'), grab('ensureItemImageLoaded'),
    grab('ensureWardrobeImagesLoaded', 'async function'), grab('migrateWardrobeImagesToFiles', 'async function'),
    'globalThis.wardrobeMissingFiles = wardrobeMissingFiles;',
].join('\n'), context);

function reset() {
    settings = { wardrobeItems: [], hairstyleItems: [] };
    server = new Map();
    calls = [];
    uploadFails = false;
    saves = 0;
    context.wardrobeMissingFiles.clear();
}

test('a new picture stays in settings until its file exists, then only the path is saved', async () => {
    reset();
    const item = { id: 'ward_1', name: 'Рубашка' };
    settings.wardrobeItems.push(item);
    const done = context.setItemImage(item, PNG);
    assert.match(JSON.stringify(settings), /iVBOR/, 'kept in settings while uploading');
    assert.equal(await done, true);
    const saved = JSON.parse(JSON.stringify(settings));
    assert.equal(saved.wardrobeItems[0].imageData, undefined, 'base64 is not in settings.json any more');
    assert.match(saved.wardrobeItems[0].imageFile, /^user\/images\/haruspics-wardrobe\/ward_1_\d+\.png$/);
    assert.equal(item.imageData, PNG, 'still in memory for references');
    assert.equal(server.get(item.imageFile), PNG, 'file holds exactly the same bytes');
    assert.equal(saves, 1);
});

test('failed upload: the picture simply stays in settings', async () => {
    reset();
    uploadFails = true;
    const item = { id: 'ward_2', name: 'Платье' };
    settings.wardrobeItems.push(item);
    assert.equal(await context.setItemImage(item, JPG), false);
    assert.equal(JSON.parse(JSON.stringify(settings)).wardrobeItems[0].imageData, JPG);
    assert.equal(item.imageFile, undefined);
    assert.equal(saves, 0);
});

test('after a reload the picture is read back from its file byte for byte', async () => {
    reset();
    server.set('user/images/haruspics-wardrobe/ward_3_1.png', PNG);
    const item = { id: 'ward_3', name: 'Куртка', imageFile: 'user/images/haruspics-wardrobe/ward_3_1.png' };
    settings.hairstyleItems.push(item);
    assert.equal(context.hasItemImage(item), true);
    assert.equal(context.itemImageSrc(item), '/user/images/haruspics-wardrobe/ward_3_1.png', 'card shows the file without waiting');
    await context.ensureWardrobeImagesLoaded();
    assert.equal(item.imageData, PNG);
    assert.equal(JSON.parse(JSON.stringify(item)).imageData, undefined, 'loaded copy is never written back to settings');
    assert.match(context.itemImageSrc(item), /^data:image\/png;base64,iVBOR/);
});

test('a missing file is reported once, not fetched on every generation', async () => {
    reset();
    const item = { id: 'ward_4', name: 'Пропал', imageFile: 'user/images/haruspics-wardrobe/gone.png' };
    settings.wardrobeItems.push(item);
    assert.equal(await context.ensureItemImageLoaded(item), false);
    assert.equal(await context.ensureItemImageLoaded(item), false);
    assert.equal(calls.filter(call => call.url.endsWith('gone.png')).length, 1);
});

test('migration moves old base64 pictures into files and stops at the first refusal', async () => {
    reset();
    const a = { id: 'a', name: 'A', imageData: PNG };
    const b = { id: 'b', name: 'B', imageData: JPG };
    const text = { id: 't', name: 'Текстовый', imageData: null };
    settings.wardrobeItems.push(a, text);
    settings.hairstyleItems.push(b);
    assert.equal(await context.migrateWardrobeImagesToFiles(), 2);
    const saved = JSON.parse(JSON.stringify(settings));
    assert.equal(saved.wardrobeItems[0].imageData, undefined);
    assert.equal(saved.hairstyleItems[0].imageData, undefined);
    assert.equal(saved.wardrobeItems[1].imageData, null, 'text outfits untouched');
    assert.equal(server.get(b.imageFile), JPG);
    assert.equal(saves, 1);

    reset();
    uploadFails = true;
    settings.wardrobeItems.push({ id: 'c', name: 'C', imageData: PNG }, { id: 'd', name: 'D', imageData: PNG });
    assert.equal(await context.migrateWardrobeImagesToFiles(), 0);
    assert.equal(calls.filter(call => call.url === '/api/images/upload').length, 1, 'no upload storm');
    assert.match(JSON.stringify(settings), /iVBOR.*iVBOR/, 'both pictures still in settings');
});

test('replacing a picture deletes the old file; removing an item deletes its file unless shared', async () => {
    reset();
    const item = { id: 'e', name: 'E' };
    settings.wardrobeItems.push(item);
    await context.setItemImage(item, PNG);
    const first = item.imageFile;
    await new Promise(resolve => setTimeout(resolve, 2)); // a different timestamp in the file name
    await context.setItemImage(item, JPG);
    await new Promise(resolve => setTimeout(resolve, 0));
    assert.notEqual(item.imageFile, first);
    assert.equal(server.has(first), false, 'old file deleted');
    assert.equal(server.get(item.imageFile), JPG);

    const twin = { id: 'f', name: 'F', imageFile: item.imageFile };
    settings.wardrobeItems.push(twin);
    settings.wardrobeItems = settings.wardrobeItems.filter(known => known !== item);
    context.deleteWardrobeFilesOf([item], settings);
    await new Promise(resolve => setTimeout(resolve, 0));
    assert.equal(server.has(twin.imageFile), true, 'still used by another item');
});

test('an item deleted while its file uploads leaves no file behind', async () => {
    reset();
    const item = { id: 'g', name: 'G' };
    settings.wardrobeItems.push(item);
    const done = context.setItemImage(item, PNG);
    settings.wardrobeItems = [];
    assert.equal(await done, false);
    await new Promise(resolve => setTimeout(resolve, 0));
    assert.equal(server.size, 0);
});
