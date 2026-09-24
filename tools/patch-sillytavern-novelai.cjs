const fs = require('node:fs');
const path = require('node:path');

function patchNovelAIEndpoint(source) {
    const marker = "router.post('/generate-image', async (request, response) => {";
    const start = source.indexOf(marker);
    if (start < 0) throw new Error('SillyTavern /generate-image route not found. No files were changed.');
    const end = source.indexOf("router.post('/generate-voice'", start);
    if (end < 0) throw new Error('Cannot identify the end of the NovelAI route. No files were changed.');
    const before = source.slice(0, start);
    const route = source.slice(start, end);
    const after = source.slice(end);
    const replacement = "params_version: /^nai-diffusion-5(?:-|$)/.test(request.body.model ?? '') ? 4 : 3,";
    if (route.includes(replacement)) return { source, changed: false };
    const old = 'params_version: 3,';
    if (route.split(old).length !== 2) throw new Error('Unexpected NovelAI route version. No files were changed.');
    return { source: before + route.replace(old, replacement) + after, changed: true };
}

if (require.main === module) {
    try {
        const root = process.argv[2];
        if (!root) throw new Error('Usage: node tools/patch-sillytavern-novelai.cjs <SillyTavern root>');
        const file = path.resolve(root, 'src', 'endpoints', 'novelai.js');
        const original = fs.readFileSync(file, 'utf8');
        const patched = patchNovelAIEndpoint(original);
        if (!patched.changed) {
            console.log('Already patched:', file);
        } else {
            const backup = `${file}.haruspics-backup`;
            if (fs.existsSync(backup)) throw new Error(`Backup already exists: ${backup}. No files were changed.`);
            fs.writeFileSync(backup, original, { flag: 'wx' });
            fs.writeFileSync(file, patched.source);
            console.log('Patched:', file, '\nBackup:', backup, '\nRestart SillyTavern.');
        }
    } catch (error) {
        console.error(error.message);
        process.exitCode = 1;
    }
}

module.exports = { patchNovelAIEndpoint };