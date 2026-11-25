// Opt-in integration check: uses the installed Claude and its existing authentication.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { createInterface } from 'node:readline';
import { randomUUID } from 'node:crypto';

if (process.env.COFFEE_CLAUDE_LIVE_TEST !== '1') throw new Error('Set COFFEE_CLAUDE_LIVE_TEST=1 to run against your configured Claude service.');
const cwd = mkdtempSync(join(tmpdir(), 'coffee-claude-contract-'));
const native = join(homedir(), '.local', 'bin', process.platform === 'win32' ? 'claude.exe' : 'claude');
const binary = process.env.COFFEE_CLAUDE_BINARY || (existsSync(native) ? native : 'claude');
const nativeId = randomUUID();
let child;
function launch(resume = false) {
  const env = { ...process.env }; delete env.CLAUDECODE;
  child = spawn(binary, ['-p','--verbose','--input-format','stream-json','--output-format','stream-json','--include-partial-messages','--permission-prompt-tool','stdio',resume ? '--resume' : '--session-id',nativeId], { cwd, env, windowsHide:true });
  const events=[], waiters=[], controls=new Map(); let stopped=false;
  const write = value => child.stdin.write(JSON.stringify(value)+'\n');
  const request = value => new Promise((accept,reject) => { const id=randomUUID(); const timer=setTimeout(()=>{controls.delete(id);reject(new Error('Control timed out: '+value.subtype));},60000); controls.set(id,{accept:v=>{clearTimeout(timer);accept(v);},reject:e=>{clearTimeout(timer);reject(e);}}); write({type:'control_request',request_id:id,request:value}); });
  createInterface({input:child.stderr}).on('line',line=>{ if (/authentication|API Error|Error:/.test(line)) console.log('Claude stderr:',line.slice(0,200)); });
  createInterface({input:child.stdout}).on('line',line=>{
    let e;try{e=JSON.parse(line);}catch{return;} events.push(e);
    if(e.type==='control_response'){const c=controls.get(e.response.request_id);if(c){controls.delete(e.response.request_id);e.response.subtype==='success'?c.accept(e.response.response):c.reject(new Error(e.response.error));}}
    if(e.type==='control_request'){
      const q=e.request, input=q.input??{}; let response;
      if(q.subtype==='can_use_tool' && q.tool_name==='AskUserQuestion') response={behavior:'allow',updatedInput:{...input,answers:Object.fromEntries((input.questions??[]).map(q=>[q.question,q.options[0].label]))}};
      else {
        const path=input.file_path??'';
        const inside=!path || resolve(path).startsWith(resolve(cwd)+sep);
        const allowed=inside && ['Bash','Read','Write','Edit'].includes(q.tool_name) && !String(input.command).includes('deny-marker');
        response=allowed?{behavior:'allow',updatedInput:input}:{behavior:'deny',message:'Integration fixture denied this request. Continue with remaining checks.'};
      }
      write({type:'control_response',response:{subtype:'success',request_id:e.request_id,response}});
      console.log('permission',q.tool_name,response.behavior);
    }
    for(let i=waiters.length-1;i>=0;i--){const w=waiters[i];if(w.predicate(e)){waiters.splice(i,1);clearTimeout(w.timer);w.resolve(e);}}
  });
  child.on('exit',code=>{stopped=true;for(const c of controls.values())c.reject(new Error('Claude exited '+code));});
  return {events, request, send:prompt=>write({type:'user',uuid:randomUUID(),session_id:nativeId,parent_tool_use_id:null,message:{role:'user',content:prompt}}),
    next:(predicate,ms=120000)=>new Promise((resolve,reject)=>{if(stopped)return reject(new Error('Claude is not running'));const w={predicate,resolve,timer:setTimeout(()=>{const i=waiters.indexOf(w);if(i>=0)waiters.splice(i,1);reject(new Error('Timed out waiting for Claude event'));},ms)};waiters.push(w);}),
    close:()=>new Promise(resolve=>{child.once('exit',resolve);child.stdin.end();setTimeout(()=>child.kill(),3000).unref();})};
}
const timeout=setTimeout(()=>{child?.kill();console.error('Live check timed out');process.exitCode=1;},360000);
try {
  let h=launch(); const init=await h.request({subtype:'initialize'});
  assert.ok(init.models.length); assert.ok(init.commands.length); console.log('ok initialize models and commands',init.models.length,init.commands.length);
  await h.request({subtype:'apply_flag_settings',settings:{effortLevel:'high'}});
  await h.request({subtype:'set_permission_mode',mode:'plan'});
  await h.request({subtype:'set_permission_mode',mode:'default'});
  await h.request({subtype:'set_model',model:'haiku'});
  const settings=await h.request({subtype:'get_settings'});
  console.log('ok model / effort / permissions acknowledgements',JSON.stringify({applied:settings.applied}));
  const done=h.next(e=>e.type==='result');
  h.send('Integration test in this temporary directory only. In order: (1) use Bash to run exactly: printf "coffee-protocol-ok\\n"; (2) use Write to create sample.txt containing exactly "alpha\\nbeta\\n"; (3) use Edit to change beta to gamma in sample.txt; (4) use Bash to run exactly: exit 7. This deliberate failure is expected. (5) use AskUserQuestion with one question "Which fixture?" and options "First" and "Second". Do not use any other tools or access files outside this directory. End with LIVE_CHECK_DONE.');
  const result=await done; assert.equal(result.is_error,false,JSON.stringify(result.errors));
  assert.equal(readFileSync(join(cwd,'sample.txt'),'utf8'),'alpha\ngamma\n');
  const tools=h.events.filter(e=>e.type==='assistant').flatMap(e=>e.message.content).filter(b=>b.type==='tool_use').map(b=>b.name);
  for(const name of ['Bash','Write','Edit','AskUserQuestion']) assert.ok(tools.includes(name),'Missing live tool '+name);
  assert.ok(h.events.some(e=>e.type==='stream_event'),'Missing streaming frames');
  assert.ok(result.usage.output_tokens>0); console.log('ok live streaming, Bash, Write, Edit, question and usage',result.usage.output_tokens);
  const stop=h.next(e=>e.type==='result');
  h.send('Use Bash to run sleep 20, then reply SLEEP_DONE.');
  await h.next(e=>e.type==='assistant' && e.message.content.some(b=>b.type==='tool_use'&&b.name==='Bash'));
  await h.request({subtype:'interrupt'}); await stop; console.log('ok interrupt');
  writeFileSync(join(cwd,'events.json'),JSON.stringify(h.events,null,2));
  await h.close(); h=launch(true); await h.request({subtype:'initialize'});
  const resumed=h.next(e=>e.type==='result'); h.send('No tools. Reply with exactly RESUME_OK.');
  const resumedResult=await resumed;assert.equal(resumedResult.is_error,false);assert.ok(h.events.some(e=>e.type==='system'&&e.subtype==='init'&&e.session_id===nativeId));
  await h.close(); console.log('ok resume preserves native session ID'); console.log('Live contract passed; evidence:',cwd);
} finally {clearTimeout(timeout);child?.kill();}
