import assert from 'node:assert/strict';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createInterface } from 'node:readline';

const executable=process.env.COFFEE_TEST_EXE;
assert.ok(executable,'Set COFFEE_TEST_EXE to the compiled development executable');
const received=[];
const server=net.createServer(socket=>{
  let buffer='';socket.on('data',chunk=>{
    buffer+=chunk.toString('utf8');if(!buffer.includes('\n'))return;
    const request=JSON.parse(buffer.slice(0,buffer.indexOf('\n')));buffer='';received.push(request);
    const result=request.worker?{accepted:true}:{action:request.action,agents:['codex','opencode'],tasks:[],revision:1};
    setTimeout(()=>socket.end(JSON.stringify({ok:true,result})+'\n'),request.action==='worker_wait'?350:0);
  });
});
server.listen(0,'127.0.0.1');await once(server,'listening');const port=server.address().port;
let child;
try {
  child=spawn(executable,['__team_mcp',String(port),'parent-secret'],{windowsHide:true,stdio:['pipe','pipe','pipe']});
  const errors=[];child.stderr.on('data',chunk=>errors.push(chunk.toString()));
  const lines=createInterface({input:child.stdout}),responses=[],waiting=[];
  lines.on('line',line=>{responses.push(JSON.parse(line));waiting.splice(0).forEach(wake=>wake())});
  const wait=async(predicate)=>{
    const deadline=Date.now()+5000;
    while(!predicate()) {
      assert.ok(Date.now()<deadline,'runtime response timed out: '+errors.join(''));
      await Promise.race([new Promise(resolve=>waiting.push(resolve)),new Promise(resolve=>setTimeout(resolve,50))]);
    }
  };
  const send=request=>child.stdin.write(JSON.stringify({jsonrpc:'2.0',...request})+'\n');
  send({id:1,method:'initialize',params:{protocolVersion:'2025-03-26',capabilities:{},clientInfo:{name:'test',version:'1'}}});
  send({method:'notifications/initialized'});send({id:2,method:'tools/list'});await wait(()=>responses.length===2);
  assert.equal(responses[0].result.serverInfo.name,'Coffee Team');assert.equal(responses[1].result.tools.length,7);assert.deepEqual(responses[1].result.tools[0].inputSchema.properties.tool.enum,['codex','opencode']);
  send({id:3,method:'tools/call',params:{name:'worker_wait',arguments:{revision:0}}});
  send({id:4,method:'tools/call',params:{name:'worker_list',arguments:{}}});send({id:5,method:'ping'});
  await wait(()=>responses.some(response=>response.id===4));assert.equal(responses.some(response=>response.id===3),false,'a long wait cannot block other tools');
  assert.ok(responses.some(response=>response.id===5),'ping remains responsive while a tool waits');
  await wait(()=>responses.some(response=>response.id===3));
  assert.equal(JSON.parse(responses.find(response=>response.id===4).result.content[0].text).action,'worker_list');
  child.stdin.end();assert.equal((await once(child,'exit'))[0],0);assert.deepEqual(errors,[]);child=undefined;
  assert.ok(received.filter(request=>!request.worker).every(request=>request.token==='parent-secret'));
  const worker=spawn(executable,['__team_worker',String(port),'worker-secret','complete','--outcome','succeeded','--summary','验证完成，保留原 Tab'],{windowsHide:true,stdio:['ignore','pipe','pipe']});
  let output='',error='';worker.stdout.on('data',chunk=>output+=chunk.toString('utf8'));worker.stderr.on('data',chunk=>error+=chunk.toString('utf8'));
  assert.equal((await once(worker,'exit'))[0],0,error);assert.equal(JSON.parse(output.trim()).accepted,true);
  const report=received.find(request=>request.worker);assert.equal(report.token,'worker-secret');assert.equal(report.action,'complete');assert.equal(report.arguments.summary,'验证完成，保留原 Tab');
  console.log('OK: compiled MCP stdio handshake, tool schemas, concurrent calls, responsive ping, scoped loopback payload and worker CLI completion');
} finally {child?.kill();await new Promise(resolve=>server.close(resolve))}
