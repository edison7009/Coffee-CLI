import assert from 'node:assert/strict';
import { readFile, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import http from 'node:http';
import ts from 'typescript';
import { build } from 'esbuild';

const { chromium } = await import(process.env.COFFEE_PLAYWRIGHT_MODULE || 'playwright-core');
const project = fileURLToPath(new URL('..', import.meta.url));
const source = await readFile(join(project, 'src/components/center/TierTerminal.tsx'), 'utf8');
const tree = ts.createSourceFile('TierTerminal.tsx', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
let keyboard;
function visit(node) {
  if (ts.isCallExpression(node) && node.expression.getText(tree) === 'term.attachCustomKeyEventHandler') keyboard = node.getText(tree);
  ts.forEachChild(node, visit);
}
visit(tree); assert.ok(keyboard);
const normalize = tree.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === 'normalizePasteNewlines').getText(tree);
const directory = await mkdtemp(join(tmpdir(), 'coffee-enter-browser-'));
await build({ stdin: { resolveDir: project, loader: 'ts', contents: `
import {Terminal} from '@xterm/xterm';
import {createTerminalEnterEncoder} from './src/lib/terminal-enter';
const term=new Terminal({allowProposedApi:true,cols:80,rows:10});term.open(document.getElementById('root'));
let tool='terminal',enterEncoder=createTerminalEnterEncoder(term,tool),ptyEnded=false;
const ime=null,rig={inputStart(){}};
const clipboardWrite=()=>{},clipboardRead=async()=>'',clipboardReadImage=async()=>'';
${normalize}
window.writes=[];
const forwardInput=(data,editing=false)=>window.writes.push({data,editing});term.onData(data=>forwardInput(data));
${keyboard};
window.output=data=>new Promise(resolve=>term.write(data,resolve));
window.setTool=value=>{enterEncoder.dispose();tool=value;enterEncoder=createTerminalEnterEncoder(term,tool)};
window.encode=values=>enterEncoder.encode(new KeyboardEvent('keydown',{key:'Enter',code:'Enter',keyCode:13,...values}));
window.end=()=>{ptyEnded=true};
window.dispose=()=>{term.dispose();enterEncoder.dispose()};
term.focus();` }, bundle: true, outfile: join(directory, 'fixture.js'), logLevel: 'silent' });
const css = await readFile(join(project, 'node_modules/@xterm/xterm/css/xterm.css'));
const server = http.createServer(async (req, res) => {
  if (req.url === '/fixture.js') { res.setHeader('Content-Type', 'text/javascript'); return res.end(await readFile(join(directory, 'fixture.js'))); }
  if (req.url === '/xterm.css') { res.setHeader('Content-Type', 'text/css'); return res.end(css); }
  res.setHeader('Content-Type', 'text/html');res.end('<link rel="stylesheet" href="/xterm.css"><div id="root"></div><script src="/fixture.js"></script>');
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const browser = await chromium.launch({headless:true,...(process.env.COFFEE_CHROMIUM_EXECUTABLE?{executablePath:process.env.COFFEE_CHROMIUM_EXECUTABLE}:{})});
try {
  const page = await browser.newPage(); const errors=[];page.on('pageerror',error=>errors.push(error.message));
  await page.goto(`http://127.0.0.1:${server.address().port}`);
  const input=page.locator('.xterm-helper-textarea');await input.focus();
  async function press(chord) {
    await page.evaluate(()=>{window.writes=[]});await page.keyboard.press(chord);
    return page.evaluate(()=>window.writes);
  }
  for(const tool of ['claude','codex','opencode','mimocode','kilo','pi','omp']) {
    await page.evaluate(tool=>window.setTool(tool),tool);
    assert.deepEqual(await press('Shift+Enter'),[{data:'\x1b[13;2u',editing:true}],`${tool}: one modified event, no plain Enter`);
    assert.deepEqual(await press('Control+Enter'),[{data:'\x1b[13;5u',editing:true}]);
    assert.deepEqual(await press('Control+Shift+Enter'),[{data:'\x1b[13;6u',editing:true}]);
    assert.deepEqual(await press('Enter'),[{data:'\r',editing:false}]);
    assert.deepEqual(await press('Control+c'),[{data:'\x03',editing:false}]);
  }
  await page.evaluate(()=>window.setTool('terminal'));
  assert.deepEqual(await press('Shift+Enter'),[{data:'\r',editing:false}], 'unnegotiated shell retains xterm handling');
  await page.evaluate(()=>window.output('\x1b[>4;'));await page.evaluate(()=>window.output('2m'));
  assert.deepEqual(await press('Control+Enter'),[{data:'\x1b[27;5;13~',editing:true}], 'split output negotiates the app encoding');
  await page.evaluate(()=>window.output('\x1b[>4;0m\x1b[>7u'));
  assert.deepEqual(await press('Shift+Enter'),[{data:'\x1b[13;2u',editing:true}]);
  await page.evaluate(()=>window.output('\x1b[<u'));
  assert.deepEqual(await press('Shift+Enter'),[{data:'\r',editing:false}], 'leaving the mode restores ordinary handling');
  await page.evaluate(()=>window.output('\x1b[?9001h'));
  const shift=await press('Shift+Enter'),ctrl=await press('Control+Enter');
  assert.equal(shift.length,1);assert.equal(ctrl.length,1);
  assert.match(shift[0].data,/^\x1b\[13;28;13;1;\d+;1_\x1b\[13;28;13;0;\d+;1_$/);
  assert.match(ctrl[0].data,/^\x1b\[13;28;10;1;\d+;1_\x1b\[13;28;10;0;\d+;1_$/);
  await page.evaluate(()=>window.setTool('claude'));await page.evaluate(()=>window.output('\x1b[?9001h'));
  const vtShift=await press('Shift+Enter'),vtCtrl=await press('Control+Enter');
  assert.deepEqual(vtShift,[{data:'\x1b[13;2u',editing:true}]);
  assert.deepEqual(vtCtrl,[{data:'\x1b[13;5u',editing:true}]);
  await page.evaluate(()=>window.setTool('codex'));await page.evaluate(()=>window.output('\x1b[?9001h\x1b[>7u'));
  assert.deepEqual(await press('Control+Enter'),ctrl,'native console editor retains Ctrl rather than receiving sequence characters');
  const packetFile=join(directory,'win32-packets.json');await writeFile(packetFile,JSON.stringify({shift:shift[0].data,ctrl:ctrl[0].data,vtShift:vtShift[0].data,vtCtrl:vtCtrl[0].data}));
  assert.equal(await page.evaluate(()=>window.encode({shiftKey:true,isComposing:true})),null);
  assert.equal(await page.evaluate(()=>window.encode({ctrlKey:true,keyCode:229})),null);
  await page.evaluate(()=>window.setTool('terminal'));await page.evaluate(()=>window.output('\x1bc'));
  assert.deepEqual(await press('Shift+Enter'),[{data:'\r',editing:false}], 'terminal reset clears negotiated state');
  assert.deepEqual(await press('a'),[{data:'a',editing:false}]);
  await page.evaluate(()=>window.dispose());assert.deepEqual(errors,[]);
  console.log('OK: real xterm and production key handler, one write per chord, plain Enter/Ctrl+C, split negotiation, reset, IME and disposal');
  console.log('Native packets: '+packetFile);
} finally {await browser.close();await new Promise(resolve=>server.close(resolve));}
