import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { runInNewContext } from 'node:vm';

const result = await build({ entryPoints: ['src/lib/gambit-attachments.ts'], bundle: true, platform: 'node', format: 'cjs', write: false });
const module = { exports: {} };
runInNewContext(result.outputFiles[0].text, { module, exports: module.exports });
const { gambitAttachments, removeGambitAttachment, ATTACH_MARK, splitDraft, joinDraft, attachToDraft, detachFromDraft, draftForSend } = module.exports;
let passed = 0;
function test(name, fn) { fn(); passed++; console.log(`ok ${name}`); }

test('quoted images and files preserve spaces and Unicode', () => {
  const draft = '请看 "C:\\My Files\\截图 1.png" "D:\\项目\\设计 说明.pdf"';
  const items = gambitAttachments(draft);
  assert.equal(items.length, 2);
  assert.equal(items[0].path, 'C:\\My Files\\截图 1.png');
  assert.equal(items[0].image, true);
  assert.equal(items[1].image, false);
  assert.equal(removeGambitAttachment(draft, items[0].path), '请看  "D:\\项目\\设计 说明.pdf"');
});
test('bare pasted images and dropped files can both be removed', () => {
  const draft = 'check C:\\Temp\\clip.png /tmp/report.pdf';
  const items = gambitAttachments(draft);
  assert.equal(items.length, 2);
  assert.equal(removeGambitAttachment(draft, items[1].path), 'check C:\\Temp\\clip.png ');
});
test('removal deletes all references to the same attachment without changing nearby text', () => {
  const path = 'C:\\Temp\\clip.png';
  const draft = `before "${path}"\n${path} after C:\\Temp\\other.png`;
  const next = removeGambitAttachment(draft, path);
  assert.equal(next, 'before \n after C:\\Temp\\other.png');
  assert.equal(gambitAttachments(next).length, 1);
  assert.equal(gambitAttachments(next)[0].path, 'C:\\Temp\\other.png');
});
test('single quoted POSIX and UNC paths remove their quotes too', () => {
  const draft = "'/tmp/My Files/pic.webp' \"\\\\server\\share\\设计.txt\"";
  const items = gambitAttachments(draft);
  assert.equal(items.length, 2);
  assert.equal(removeGambitAttachment(removeGambitAttachment(draft, items[0].path), items[1].path).trim(), '');
});
test('slash commands, URLs, and filenames in prose are not attachments', () => {
  assert.equal(gambitAttachments('/model https://example.com/image.png README.md').length, 0);
  assert.equal(removeGambitAttachment('keep my draft', 'C:\\missing.png'), 'keep my draft');
});
const same = (actual, expected, message) => assert.equal(JSON.stringify(actual), JSON.stringify(expected), message);
test('attached files stay out of the box but go out after the words', () => {
  let draft = attachToDraft('看看这张', ['/tmp/clip-1.png', '/Users/me/My Docs/a.pdf']);
  same(splitDraft(draft), { text: '看看这张', tokens: ['/tmp/clip-1.png', '"/Users/me/My Docs/a.pdf"'] });
  assert.equal(gambitAttachments(draft).length, 2, 'thumbnails still see both');
  assert.equal(draftForSend(draft), '看看这张\n/tmp/clip-1.png "/Users/me/My Docs/a.pdf"');
  assert.equal(attachToDraft(draft, ['/tmp/clip-1.png']), draft, 'the same file is attached once');
  // Typing in the box keeps the attachments, trailing space included.
  draft = joinDraft('看看这张 ', splitDraft(draft).tokens);
  assert.equal(splitDraft(draft).text, '看看这张 ');
  draft = detachFromDraft(draft, '/tmp/clip-1.png');
  same(splitDraft(draft).tokens, ['"/Users/me/My Docs/a.pdf"']);
  assert.equal(detachFromDraft(draft, '/Users/me/My Docs/a.pdf'), '看看这张 ', 'the last one takes the mark with it');
});
test('text appended after the attachments joins the words', () => {
  const draft = attachToDraft('hi', ['/tmp/a.png']) + '\nvoice words';
  same(splitDraft(draft), { text: 'hi\nvoice words', tokens: ['/tmp/a.png'] });
  assert.equal(draftForSend(attachToDraft('', ['/tmp/a.png'])), '/tmp/a.png', 'only files: just the paths');
  assert.equal(splitDraft('typed /tmp/a.png stays typed').text, 'typed /tmp/a.png stays typed');
  assert.ok(!draftForSend(draft).includes(ATTACH_MARK));
});
console.log(`${passed} attachment checks passed`);
