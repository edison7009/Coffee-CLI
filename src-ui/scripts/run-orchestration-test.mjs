import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { createRequire } from 'node:module';
import { runInNewContext } from 'node:vm';
import { fileURLToPath } from 'node:url';

const project = fileURLToPath(new URL('..', import.meta.url));
const mock = `
export const isTauri=true;
export async function invoke(command,args){if(command==='agent_validate_directory'){if(window.validate)await window.validate();return args.path}throw Error(command)}
export const commands={listTools:async()=>[{id:'claude'},{id:'codex'},{id:'opencode'}],orchestrationGet:async()=>({enabled:true,agents:['claude','codex','opencode'],tasks:[],revision:1}),orchestrationSync:async()=>window.deliveries.splice(0),orchestrationPending:async()=>window.pending,orchestrationResolve:async(id,result)=>window.results.push({id,...result})};`;
const compiled = await build({stdin:{resolveDir:project,contents:`export {OrchestrationBridge} from './src/components/agent/OrchestrationBridge';export {workerState,receiveOrchestration,getOrchestrationSnapshot} from './src/lib/orchestration';`},bundle:true,platform:'node',format:'cjs',write:false,plugins:[{name:'boundaries',setup(b){
  b.onResolve({filter:/\/tauri$|\/store\/app-state$|\/agent-session$|^react$|^@tauri-apps\/api\/event$/},a=>({path:a.path,namespace:'test'}));
  b.onLoad({filter:/.*/,namespace:'test'},a=>({loader:'js',contents:a.path.endsWith('/tauri')?mock:a.path.endsWith('/app-state')?'export const useAppStateRef=()=>window.stateRef,useAppDispatch=()=>window.dispatch;':a.path.endsWith('/agent-session')?'export const getAgentSession=tab=>window.sessions.get(tab.id);':a.path==='react'?'export const useEffect=fn=>{window.cleanup=fn()},useSyncExternalStore=()=>{};':'export async function listen(name,handler){window.listeners.set(name,handler);return ()=>window.listeners.delete(name)}'}));
}}]});
const require = createRequire(import.meta.url), tick=()=>new Promise(resolve=>setImmediate(resolve));
function fixture({approval=false,terminal=false,deliveries=[]}={}) {
  const window={pending:true,deliveries,results:[],actions:[],writes:[],listeners:new Map(),sessions:new Map(),stateRef:{current:{terminals:[{id:'parent',tool:'claude',folderPath:'D:/Project',resumeToken:'native-parent',agentStatus:'idle'}],activeTerminalId:'parent',currentLang:'zh-CN'}}};
  const session=(id,mode='desktop')=>({mode,generation:`${id}-g1`,ready:true,canReceive:true,readScreen:async()=>({lines:[],pendingRequests:id==='parent'||!approval?[]:[{id:'approval'}]}),send:async(text,guard,deliveryId)=>{assert.equal(guard(),true);window.writes.push({id,text,...(deliveryId?{deliveryId}:{})})}});
  window.sessions.set('parent',session('parent'));
  window.dispatch=action=>{window.actions.push(action);if(action.type==='LAUNCH_TERMINAL_TOOL'){window.stateRef.current.terminals.push({...action,folderPath:action.cwd,agentStatus:approval?'wait_input':'idle'});window.sessions.set(action.id,session(action.id,terminal?'terminal':'desktop'))}};
  const module={exports:{}};
  runInNewContext(compiled.outputFiles[0].text,{window,module,exports:module.exports,require,console,Date,performance,crypto:globalThis.crypto,setTimeout:(fn,ms)=>ms===1000?0:setTimeout(fn,ms),clearTimeout,localStorage:{getItem:()=>terminal?'terminal':null},requestAnimationFrame:()=>{}});
  module.exports.OrchestrationBridge();
  const ready=async()=>{for(let i=0;i<10&&!window.listeners.has('orchestration-request');i++)await tick();await tick()};
  const send=async(id='child',name='team_worker_start',args={tool:terminal?'opencode':'codex',cwd:'D:/Project',text:'Review the change'})=>window.listeners.get('orchestration-request')({payload:{requestId:id,name,parentId:'parent',sessionId:id,background:true,arguments:args}});
  return {window,api:module.exports,ready,send,dispose:()=>window.cleanup()};
}
{
  const f=fixture({deliveries:[{id:'batch-1',parentId:'parent',generation:'parent-g1',text:'Worker replies'}]});await f.ready();
  assert.deepEqual(f.window.writes,[{id:'parent',text:'Worker replies',deliveryId:'batch-1'}]);assert.equal(f.window.actions.length,0,'automatic replies use the existing parent, without opening a tab');f.dispose();
}
{
  const f=fixture({deliveries:[{id:'batch-1',parentId:'parent',generation:'old-generation',text:'Stale reply'}]});await f.ready();
  assert.equal(f.window.writes.length,0,'stale result batches cannot reach a restarted parent');f.dispose();
}
{
  const f=fixture({deliveries:[{id:'batch-1',parentId:'parent',generation:'parent-g1',text:'Worker replies'}]});f.window.sessions.get('parent').canReceive=false;await f.ready();
  assert.equal(f.window.writes.length,0,'busy, draft-bearing or approval-bearing parents do not receive automatic input');f.dispose();
}
{
  const f=fixture();await f.ready();await f.send();
  assert.equal(f.window.actions.length,1);assert.equal(f.window.actions[0].parentId,'parent');assert.equal(f.window.actions[0].background,true);
  assert.equal(f.window.writes.length,1);assert.equal(f.window.writes[0].id,'child');assert.equal(f.window.results[0].ok,true);
  await f.send();assert.equal(f.window.actions.length,1,'duplicate start does not replace the child');assert.equal(f.window.writes.length,1);assert.equal(f.window.results[1].ok,false);
  f.dispose();assert.equal(f.window.listeners.size,0);
}
{
  const f=fixture({terminal:true});await f.ready();await f.send();assert.equal(f.window.actions[0].tool,'opencode');assert.equal(f.window.writes.length,1);f.dispose();
}
{
  const f=fixture();f.window.stateRef.current.terminals[0].tool='codex';await f.ready();
  await f.send('claude-child','team_worker_start',{tool:'claude',cwd:'D:/Project',text:'Review'});
  assert.equal(f.window.actions[0].tool,'claude');assert.equal(f.window.actions[0].parentId,'parent');assert.equal(f.window.writes[0].id,'claude-child');f.dispose();
}
{
  const f=fixture({approval:true});await f.ready();await f.send();assert.equal(f.window.writes.length,0,'approval requests never receive the task as keystrokes');assert.equal(f.window.stateRef.current.terminals.length,2,'the visible tab remains');assert.match(f.window.results[0].error,/approval/);f.dispose();
}
{
  const f=fixture();await f.ready();f.window.pending=false;await f.send();assert.equal(f.window.actions.length,0);assert.equal(f.window.writes.length,0);f.dispose();
}
{
  const f=fixture();await f.ready();f.api.receiveOrchestration({enabled:false,tasks:[],revision:2});
  f.api.receiveOrchestration({enabled:true,tasks:[],revision:1});assert.equal(f.api.getOrchestrationSnapshot().enabled,false,'late reads cannot overwrite a newer toggle');
  await f.send();assert.equal(f.window.actions.length,0,'disabled coordination cannot dispatch from an existing parent');f.dispose();
}
{
  const f=fixture();await f.ready();let release;f.window.validate=()=>new Promise(resolve=>{release=resolve});const dispatch=f.send();await tick();
  f.window.sessions.get('parent').generation='parent-g2';release();await dispatch;
  assert.equal(f.window.actions.length,0,'a parent restart during directory validation cancels dispatch');assert.equal(f.window.writes.length,0);f.dispose();
}
{
  const f=fixture();await f.ready();let release;f.window.validate=()=>new Promise(resolve=>{release=resolve});const dispatch=f.send();await tick();
  f.api.receiveOrchestration({enabled:true,agents:['claude'],tasks:[],revision:2});release();await dispatch;
  assert.equal(f.window.actions.length,0,'disabling a selected worker while its directory is validated cancels the start');assert.equal(f.window.writes.length,0);f.dispose();
}
{
  const f=fixture();const task={phase:'running',activity:'idle',question:null};assert.equal(f.api.workerState(task),'idle');assert.equal(f.api.workerState({...task,activity:'working'}),'working');
  assert.equal(f.api.workerState({...task,question:{answer:null}}),'waiting');assert.equal(f.api.workerState({...task,activity:'disconnected'}),'waiting');
  assert.equal(f.api.workerState({...task,phase:'completed',activity:'error'}),'completed');assert.equal(f.api.workerState({...task,phase:'failed'}),'failed');f.dispose();await tick();
}
console.log('OK: actual dispatch bridge, Codex/OpenCode routing, single delivery, retained approval tabs, cancelled dispatch, stale parent protection, status mapping and listener cleanup');
