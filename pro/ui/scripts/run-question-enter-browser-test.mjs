// Render the actual request cards with an isolated response transport.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import http from 'node:http';
import ts from 'typescript';
import { build } from 'esbuild';

const { chromium } = await import(process.env.COFFEE_PLAYWRIGHT_MODULE || 'playwright-core');
const project = fileURLToPath(new URL('..', import.meta.url));
async function component(file, name) {
  const source = await readFile(new URL(`../src/components/center/${file}.tsx`, import.meta.url), 'utf8');
  const ast = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const node = ast.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === name);
  assert.ok(node, `${name} exists in the production source`);
  return node.getText(ast);
}
const bundle = await build({
  stdin: { resolveDir: project, loader: 'tsx', contents: `
    import {useState} from 'react';import {createRoot} from 'react-dom/client';
    import {object,list,text,resultText} from './src/lib/claude-protocol';
    import {arr,obj,str,pretty} from './src/lib/codex-protocol';
    const useT=()=>key=>key;
    async function record(args){window.calls.push(args);if(window.fail)throw Error('Response failed');await new Promise(resolve=>window.resolveResponse=resolve)}
    const respondClaude=(...args)=>record(args),respondCodex=(...args)=>record(args);
    ${await component('ClaudeConversation', 'Question')}
    ${await component('CodexConversation', 'RequestCard')}
    function Fixture(){const [request,setRequest]=useState(null);window.show=(provider,questions)=>{window.calls=[];window.fail=false;const next={provider,questions,key:crypto.randomUUID()};setRequest(next);return next.key};
      if(!request)return null;
      return <div data-request-key={request.key}>{request.provider==='claude'?<Question key={request.key} id="session" pending={{id:'question',request:{tool_name:'AskUserQuestion',input:{questions:request.questions}}}}/>:<RequestCard key={request.key} sessionId="session" request={{id:'question',method:'item/tool/requestUserInput',params:{questions:request.questions}}}/>}</div>;
    }createRoot(document.getElementById('root')).render(<Fixture/>);
  ` },
  bundle: true, write: false, jsx: 'automatic', define: { 'process.env.NODE_ENV': '"development"' },
});
const script = bundle.outputFiles[0].contents;
const server = http.createServer((req, res) => {
  if (req.url === '/fixture.js') return res.setHeader('Content-Type', 'text/javascript').end(script);
  res.setHeader('Content-Type', 'text/html').end('<!doctype html><div id="root"></div><script src="/fixture.js"></script>');
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
let browser;
try {
  browser = await chromium.launch({ headless: true, ...(process.env.COFFEE_CHROMIUM_EXECUTABLE ? { executablePath: process.env.COFFEE_CHROMIUM_EXECUTABLE } : {}) });
  const page = await browser.newPage();
  const errors = [];page.on('pageerror', error => errors.push(error.message));
  await page.goto(`http://127.0.0.1:${server.address().port}`);
  await page.waitForFunction(() => window.show);
  for (const provider of ['claude', 'codex']) {
    const show = async questions => {
      const key=await page.evaluate(({provider, questions}) => window.show(provider, questions), {provider, questions});
      await page.locator(`[data-request-key="${key}"]`).waitFor();
      await page.locator('.claude-custom-answer').first().waitFor();
    };
    const inputs = page.locator('.claude-custom-answer');
    const submit = page.getByRole('button', { name: provider === 'claude' ? 'interaction.submit' : 'codex.submit', exact: true });
    const calls = () => page.evaluate(() => window.calls);
    const first = {id:'first',question:'Choose a language',isOther:true,options:[{label:'English'}]};
    const second = {id:'second',question:'Choose a style',options:[]};
    await show([first, second]);
    await inputs.first().fill('   ');await inputs.first().press('Enter');
    assert.equal((await calls()).length, 0, `${provider}: blank answer is not submitted`);
    await inputs.first().fill('中文');await inputs.first().press('Enter');
    assert.equal((await calls()).length, 0, `${provider}: another unanswered question blocks submission`);
    assert.equal(await submit.isDisabled(), true);
    await inputs.nth(1).fill('简洁');
    for (const event of [{isComposing:true}, {keyCode:229}, {repeat:true}, {shiftKey:true}, {ctrlKey:true}, {altKey:true}, {metaKey:true}]) {
      await inputs.nth(1).dispatchEvent('keydown', {key:'Enter',code:'Enter',bubbles:true,...event});
      assert.equal((await calls()).length, 0, `${provider}: composition, repeat and modified Enter do not submit`);
    }
    await inputs.nth(1).press('Enter');
    const keyboardCalls = await calls();
    assert.equal(keyboardCalls.length, 1, `${provider}: Enter submits once`);
    assert.equal(keyboardCalls[0][0], 'session');assert.equal(keyboardCalls[0][1], 'question');
    assert.deepEqual(keyboardCalls[0][2], provider === 'claude'
      ? {behavior:'allow',updatedInput:{questions:[first,second],answers:{'Choose a language':'中文','Choose a style':'简洁'}}}
      : {answers:{first:{answers:['中文']},second:{answers:['简洁']}}});
    await inputs.nth(1).dispatchEvent('keydown', {key:'Enter',bubbles:true});
    assert.equal((await calls()).length, 1, `${provider}: pending response blocks duplicate submission`);
    assert.equal(await submit.isDisabled(), true);
    await page.evaluate(() => window.resolveResponse());

    await show([first, second]);
    await inputs.first().fill('中文');await inputs.nth(1).fill('简洁');await submit.click();
    assert.deepEqual(await calls(), keyboardCalls, `${provider}: button sends the same payload as Enter`);
    await page.evaluate(() => window.resolveResponse());

    await show([first, second]);
    await page.getByRole('radio').check();await inputs.nth(1).fill('简洁');await inputs.nth(1).press('Enter');
    const selected = (await calls())[0][2];
    assert.equal(provider === 'claude' ? selected.updatedInput.answers['Choose a language'] : selected.answers.first.answers[0], 'English');
    await page.evaluate(() => window.resolveResponse());

    await show([second]);await inputs.first().fill('再试一次');
    await page.evaluate(() => {window.fail=true});await inputs.first().press('Enter');
    await page.getByRole('alert').waitFor();assert.equal(await submit.isDisabled(), false);
    await page.evaluate(() => {window.fail=false});await inputs.first().press('Enter');
    assert.equal((await calls()).length, 2, `${provider}: failed response can be retried with Enter`);
    await page.evaluate(() => window.resolveResponse());
    console.log(`ok ${provider}: Enter, validation, IME, repeat, pending, button parity, mixed answers and retry`);
  }
  assert.deepEqual(errors, []);
} finally {
  await browser?.close();await new Promise(resolve => server.close(resolve));
}
