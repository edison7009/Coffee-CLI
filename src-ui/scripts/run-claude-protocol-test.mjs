import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { runInNewContext } from 'node:vm';
import { fileURLToPath } from 'node:url';
const result = await build({ entryPoints: [fileURLToPath(new URL('../src/lib/claude-protocol.ts', import.meta.url))], bundle: true, platform: 'node', format: 'cjs', write: false });
const module = { exports: {} }; runInNewContext(result.outputFiles[0].text, { module, exports: module.exports, console, Date });
const { emptyClaudeState, reduceClaudeEvent } = module.exports;
let passed = 0;
function test(name, fn) { fn(); passed++; console.log(`ok ${name}`); }
const stream = event => ({ type: 'stream_event', event });
function fixture() { let s = emptyClaudeState(); return { get state() { return s; }, send: (event, now = 1000) => { s = reduceClaudeEvent(s, event, now); return s; } }; }

test('partial thinking and text become exactly one block each after complete assistant messages', () => {
  const f = fixture();
  f.send(stream({ type:'message_start', message:{ id:'msg' } }));
  f.send(stream({ type:'content_block_start', index:0, content_block:{ type:'thinking', thinking:'' } }));
  f.send(stream({ type:'content_block_delta', index:0, delta:{ type:'thinking_delta', thinking:'Reason' } }));
  f.send({ type:'assistant', message:{ id:'msg', content:[{type:'thinking', thinking:'Reason'}] } });
  f.send(stream({type:'content_block_stop', index:0}), 2500);
  f.send(stream({ type:'content_block_start', index:1, content_block:{type:'text', text:''} }));
  f.send(stream({ type:'content_block_delta', index:1, delta:{type:'text_delta',text:'Answer'} }));
  f.send({type:'assistant',message:{id:'msg',content:[{type:'text',text:'Answer'}]}});
  f.send(stream({type:'content_block_stop',index:1}), 3000);
  assert.equal(f.state.messages.length,2);
  assert.equal(f.state.messages[0].content,'Reason');
  assert.equal(f.state.messages[0].endedAt,2500);
  assert.equal(f.state.messages[1].content,'Answer');
  assert.equal(f.state.messages[1].partial,false);
});
test('parallel tool blocks retain their own incremental input and out-of-order results', () => {
  const f = fixture(); f.send(stream({type:'message_start',message:{id:'tools'}}));
  for(const [index,id] of [[0,'bash-1'],[1,'bash-2']]) f.send(stream({type:'content_block_start',index,content_block:{type:'tool_use',id,name:'Bash',input:{}}}));
  f.send(stream({type:'content_block_delta',index:0,delta:{type:'input_json_delta',partial_json:'{"command":"echo first"}'}}));
  f.send(stream({type:'content_block_delta',index:1,delta:{type:'input_json_delta',partial_json:'{"command":"exit 7"}'}}));
  f.send({type:'user',message:{role:'user',content:[{type:'tool_result',tool_use_id:'bash-2',content:'Exit code 7',is_error:true},{type:'tool_result',tool_use_id:'bash-1',content:[{type:'text',text:'first'}]}]}});
  assert.equal(f.state.messages.length,2);
  assert.equal(f.state.messages[0].input.command,'echo first');
  assert.equal(f.state.messages[0].output,'first');
  assert.equal(f.state.messages[0].toolStatus,'done');
  assert.equal(f.state.messages[1].input.command,'exit 7');
  assert.equal(f.state.messages[1].toolStatus,'failed');
});
test('tool approval is paired and a cancelled request disappears', () => {
  const f = fixture(); f.send({type:'control_request',request_id:'p',request:{subtype:'can_use_tool',tool_name:'Edit',input:{}}});
  assert.equal(f.state.requests.length,1); assert.equal(f.state.status,'requires_action');
  f.send({type:'control_cancel_request',request_id:'p'}); assert.equal(f.state.requests.length,0);
});
test('usage comes from result and is not multiplied by assistant block count', () => {
  const f = fixture();
  for(let i=0;i<3;i++) f.send({type:'assistant',message:{id:`m${i}`,content:[{type:'text',text:'text'}],usage:{input_tokens:100,output_tokens:5,cache_read_input_tokens:300}}});
  f.send({type:'result',usage:{input_tokens:100,output_tokens:15},modelUsage:{test:{contextWindow:100000}},total_cost_usd:0.002});
  assert.equal(f.state.usage.output_tokens,15); assert.equal(f.state.contextTokens,405); assert.equal(f.state.totalCost,0.002); assert.equal(f.state.contextWindow,100000);
});
test('final result clears live thinking and unfinished tools after interruption', () => {
  const f=fixture(); f.send({type:'system',subtype:'thinking_tokens',estimated_tokens:123});
  f.send({type:'assistant',message:{id:'t',content:[{type:'tool_use',id:'unfinished',name:'Bash',input:{command:'sleep 30'}}]}});
  f.send({type:'result',subtype:'success',is_error:false},8000);
  assert.equal(f.state.thinkingTokens,undefined); assert.equal(f.state.busy,false); assert.equal(f.state.messages[0].toolStatus,'failed');
});
test('historical messages do not fabricate thinking durations or live usage',()=>{
  let s=emptyClaudeState(); s=reduceClaudeEvent(s,{type:'assistant',message:{id:'old',content:[{type:'thinking',thinking:'history'}]}},100,true);
  assert.equal(s.messages[0].startedAt,undefined); assert.equal(s.messages[0].endedAt,undefined);
});
test('optimistic prompts are reconciled with echoed user messages',()=>{
  const s=emptyClaudeState(); s.messages.push({id:'pending:x',role:'user',content:'hello',timestamp:1});
  const next=reduceClaudeEvent(s,{type:'user',uuid:'native-user',message:{role:'user',content:'hello'}},100);
  assert.equal(next.messages.length,1); assert.equal(next.messages[0].id,'native-user');
});
test('history pages retain a tool result until its earlier call is loaded',()=>{
  let s=reduceClaudeEvent(emptyClaudeState(),{type:'user',message:{content:[{type:'tool_result',tool_use_id:'older-edit',content:'edited'}]}},200,true);
  assert.equal(s.messages.length,0);
  s=reduceClaudeEvent(s,{type:'assistant',message:{id:'old-msg',content:[{type:'tool_use',id:'older-edit',name:'Edit',input:{old_string:'a',new_string:'b'}}]}},100,true);
  assert.equal(s.messages[0].output,'edited'); assert.equal(s.messages[0].toolStatus,'done');
});
test('a queued second turn keeps the session busy after the first result',()=>{
  const state=emptyClaudeState(); state.busy=true; state.pendingTurns=2;
  const next=reduceClaudeEvent(state,{type:'result',usage:{}},5000);
  assert.equal(next.busy,true); assert.equal(next.pendingTurns,1); assert.equal(next.endedAt,undefined);
  const end=reduceClaudeEvent(next,{type:'result',usage:{}},6000);
  assert.equal(end.busy,false); assert.equal(end.pendingTurns,0);
});

test('only a locally requested stop downgrades its EDE diagnostic',()=>{
  const diagnostic='[ede_diagnostic] result_type=user last_content_type=n/a stop_reason=tool_use';
  const state={...emptyClaudeState(),ready:true,busy:true,pendingTurns:1,interruptRequested:true,messages:[{id:'partial',role:'assistant',content:'Keep this output',partial:true,timestamp:1},{id:'tool',role:'tool',content:'',toolStatus:'running',output:'Already produced output',timestamp:1}]};
  const stopped=reduceClaudeEvent(state,{type:'result',subtype:'error_during_execution',is_error:true,errors:[diagnostic]},5000);
  assert.equal(stopped.busy,false); assert.equal(stopped.ready,true); assert.equal(stopped.interrupted,true);
  assert.equal(stopped.interruptRequested,false); assert.equal(stopped.error,undefined);
  assert.equal(stopped.messages[0].content,'Keep this output'); assert.equal(stopped.messages[0].partial,false);
  assert.equal(stopped.messages[1].output,'Already produced output'); assert.equal(stopped.messages[1].interrupted,true);
  const nextFailure=reduceClaudeEvent(stopped,{type:'result',is_error:true,errors:[diagnostic]},6000);
  assert.equal(nextFailure.interrupted,false); assert.equal(nextFailure.error,diagnostic,'a stop marker cannot leak to the next result');
  const unrequested=reduceClaudeEvent({...state,interruptRequested:false},{type:'result',is_error:true,errors:[diagnostic]},5000);
  assert.equal(unrequested.error,diagnostic,'diagnostics from a real failure remain errors');
  const mixed=reduceClaudeEvent(state,{type:'result',is_error:true,errors:[diagnostic,'API Error: 503 unavailable']},5000);
  assert.equal(mixed.error,'API Error: 503 unavailable','real provider errors survive a concurrent stop');
  const unknown=reduceClaudeEvent(state,{type:'result',is_error:true,errors:[]},5000);
  assert.equal(unknown.errorKey,'claude.error.request_failed','an unexplained error is never silently hidden');
  const otherDiagnostic=reduceClaudeEvent(state,{type:'result',is_error:true,errors:['[ede_diagnostic] unexpected provider failure']},5000);
  assert.equal(otherDiagnostic.error,'[ede_diagnostic] unexpected provider failure','unrecognized diagnostics still surface');
  const exit=reduceClaudeEvent(state,{type:'coffee_exit',code:1,detail:'Process crashed'},5000);
  assert.equal(exit.error,'Process crashed'); assert.equal(exit.ready,false); assert.equal(exit.interruptRequested,false);
});
test('side calls streamed after a finished turn neither show working nor add rows', () => {
  const f = fixture();
  f.send({type:'system',subtype:'session_state_changed',state:'running'});
  f.send(stream({type:'message_start',message:{id:'turn'}}));
  f.send({type:'result',subtype:'success'});
  f.send({type:'system',subtype:'session_state_changed',state:'idle'});
  const rows = f.state.messages.length;
  f.send(stream({type:'message_start',message:{id:'idle-compaction'}}), 9000);
  f.send(stream({type:'content_block_start',index:0,content_block:{type:'text',text:''}}));
  f.send(stream({type:'content_block_delta',index:0,delta:{type:'text_delta',text:'Summary of the conversation'}}));
  assert.equal(f.state.busy,false,'an idle session stays idle without a result frame');
  assert.equal(f.state.messages.length,rows,'side-call text is not a transcript reply');
  // A turn the CLI starts itself announces running first and still shows progress.
  f.send({type:'system',subtype:'session_state_changed',state:'running'});
  f.send(stream({type:'message_start',message:{id:'task-notification'}}));
  assert.equal(f.state.busy,true);
  // Idle ends a self-started run that never sent a result.
  f.send({type:'system',subtype:'session_state_changed',state:'idle'});
  assert.equal(f.state.busy,false);
  // While a sent prompt awaits its result, an early idle does not end the turn.
  const pending = reduceClaudeEvent({...f.state,busy:true,pendingTurns:1},{type:'system',subtype:'session_state_changed',state:'idle'});
  assert.equal(pending.busy,true);
  // CLIs without session state events keep the previous behavior.
  const legacy = reduceClaudeEvent(emptyClaudeState(),stream({type:'message_start',message:{id:'legacy'}}));
  assert.equal(legacy.busy,true);
});
test('background tasks outlive the turn and clear when the CLI reports none', () => {
  const f = fixture();
  f.send({type:'system',subtype:'background_tasks_changed',tasks:[{task_id:'b1',task_type:'local_bash',description:'Build installer'},{task_id:'mem',task_type:'local_bash',description:'internal',ambient:true}]});
  f.send({type:'result',subtype:'success'});
  assert.equal(f.state.busy,false);
  assert.equal(JSON.stringify(f.state.backgroundTasks),JSON.stringify([{id:'b1',type:'local_bash',description:'Build installer'}]),'ambient tasks stay hidden');
  f.send({type:'system',subtype:'background_tasks_changed',tasks:[]});
  assert.equal(f.state.backgroundTasks.length,0);
  f.send({type:'system',subtype:'background_tasks_changed',tasks:[{task_id:'b2',task_type:'local_agent',description:'Review'}]});
  assert.equal(reduceClaudeEvent(f.state,{type:'coffee_exit',code:0}).backgroundTasks.length,0,'an exited CLI has no running tasks');
});
console.log(`${passed} Claude protocol checks passed`);
