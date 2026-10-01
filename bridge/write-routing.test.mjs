import assert from 'node:assert/strict';
import test from 'node:test';
import { spawn } from 'node:child_process';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { once } from 'node:events';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { boundaryEnv, bridgeCommand, freePort, isolatedEnv, pairDevice, passwordEnv, terminalTicket } from './test-support.mjs';

test('HTTP writes share the pane lane; /pty only views the pane', { timeout: 20000 }, async t => {
  const dir = await mkdtemp(path.join(tmpdir(), 'moshpit-routing-'));
  const log = path.join(dir, 'writes.jsonl');
  const ctrlLog = path.join(dir, 'control.jsonl');
  const counter = path.join(dir, 'layout-count');
  const bin = path.join(dir, 'herdr-fixture');
  await writeFile(log, '');
  await writeFile(ctrlLog, '');
  await writeFile(counter, '0');
  await writeFile(bin, `#!${process.execPath}
import {appendFileSync, readFileSync, writeFileSync} from 'node:fs';
const a=process.argv.slice(2);
if(a[0]==='api') console.log(JSON.stringify({result:{snapshot:{agents:[{pane_id:'pane',agent:'codex',agent_status:'idle',agent_session:{kind:'id',value:'session'},cwd:''}]}}}));
else if(a[1]==='list') console.log(JSON.stringify({result:{panes:[{pane_id:'pane',terminal_id:'pane'}]}}));
else if(a[1]==='layout') {
  const n=Number(readFileSync('${counter}','utf8'))+1;
  writeFileSync('${counter}',String(n));
  console.log(JSON.stringify({result:{layout:{area:{width:80+n*4,height:24}}}}));
}
else if(a[1]==='send-text'||a[1]==='send-keys'||a[1]==='prompt') {appendFileSync(process.env.REVIEW_WRITES, JSON.stringify(a)+'\\n');console.log('{}');}
else if(a[0]==='terminal'&&a[1]==='session'&&a[2]==='control') {
  process.stdin.on('data', c => {
    const s=String(c);
    appendFileSync(process.env.REVIEW_CTRL, s);
    if(s.includes('TEARDOWN')) {
      console.log(JSON.stringify({reason:'test',type:'terminal.closed'}));
      process.exit(0);
    }
  });
  setTimeout(()=>{}, 60000);
}
else console.log('{}');
`, { mode: 0o700 });
  // Keep the executable in ESM mode without relying on the user's checkout.
  await writeFile(path.join(dir, 'package.json'), '{"type":"module"}');
  const port = await freePort();
  const url = `http://127.0.0.1:${port}`;
  const child = spawn(...bridgeCommand(), { env: { ...isolatedEnv(), ...boundaryEnv(port), MOSHPIT_BIND: '127.0.0.1', ...await passwordEnv(dir), MOSHPIT_STATE_DIR: path.join(dir, 'state'), MOSHPIT_HERDR_BIN: bin, REVIEW_WRITES: log, REVIEW_CTRL: ctrlLog }, stdio: ['ignore', 'pipe', 'pipe'] });
  let socket;
  t.after(async () => { socket?.close(); child.kill(); await once(child, 'exit').catch(() => {}); await rm(dir, { recursive: true, force: true }); });
  await once(child.stdout, 'data');
  const login = await fetch(`${url}/api/login`, { method:'POST', headers:{'content-type':'application/json',origin:url}, body:JSON.stringify({password:'review-pass'}) }).then(r=>r.json());
  const headers = { 'content-type':'application/json', origin:url, authorization:`Bearer ${login.token}`, 'x-moshpit-device':'review' };
  headers['x-moshpit-device'] = await pairDevice(url, headers, { stateDir: path.join(dir, 'state') });
  // A browser always sends Origin on an upgrade; node only does when asked.
  socket = new WebSocket(`ws://127.0.0.1:${port}/pty?${await terminalTicket(url, headers, "pane")}`, { headers: { origin: url } });
  await new Promise((resolve,reject)=>{socket.onopen=resolve;socket.onerror=reject;});
  const rows = async file => (await readFile(file,'utf8')).trim().split('\n').filter(Boolean).map(JSON.parse);
  const ctrlLines = async () => (await readFile(ctrlLog,'utf8')).trim().split('\n').filter(Boolean);
  async function waitFor(predicate) { for(let i=0;i<100;i++){if(await predicate())return;await delay(20);}throw new Error('Timed out waiting'); }
  const post=(route,body)=>fetch(`${url}${route}`, {method:'POST',headers,body:JSON.stringify(body)});

  // HTTP prompt: the fully awaited native submit path on the pane lane.
  await post('/api/action',{kind:'prompt',target:'pane',text:'legacy'});
  await waitFor(async()=>(await rows(log)).length>0);
  assert.equal((await rows(log))[0][1],'send-text','Prompts use the fully awaited native submit path');

  // Submit delimiter precedes the later keys on the pane lane.
  const sending=post('/api/submit',{id:randomUUID(),target:'pane',sessionId:'session',mode:'send',text:'composed'});
  await waitFor(async()=>(await rows(log)).some(r=>r[3]==='enter'));
  assert.equal((await sending).status,200);

  // A keys sequence writes in order on the pane lane.
  await post('/api/action',{kind:'keys',target:'pane',keys:['down','down','enter']});
  await waitFor(async()=>(await rows(log)).filter(r=>r[3]==='down').length>=2);
  assert.deepEqual((await rows(log)).slice(-3).map(r=>r[3]),['down','down','enter']);
  assert.equal((await post('/api/action',{kind:'keys',target:'pane',keys:[]})).status,400,'An empty keys action is rejected');

  // /pty only views the pane. herdr acknowledges no input on a control pipe,
  // so the socket forwards none: each input frame is refused, nothing is
  // written, and no session-control child is opened.
  const refusals = [];
  socket.onmessage = (event) => { const frame = JSON.parse(event.data); if (frame.error) refusals.push(frame.error.code); };
  const before = (await rows(log)).length;
  socket.send(JSON.stringify({target:'pane',keys:'esc'}));
  socket.send(JSON.stringify({target:'pane',text:'hello '}));
  await waitFor(async()=>refusals.length===2);
  assert.deepEqual(refusals,['terminal_input_http','terminal_input_http']);
  await delay(200);
  assert.equal((await rows(log)).length,before,'Socket input does not hit pane send-keys/send-text');
  assert.deepEqual(await ctrlLines(),[],'No session-control child receives anything');

  // A crossing frame still closes the connection as a policy violation.
  const crossing = new WebSocket(`ws://127.0.0.1:${port}/pty?${await terminalTicket(url, headers, "pane")}`, { headers: { origin: url } });
  await new Promise((resolve,reject)=>{crossing.onopen=resolve;crossing.onerror=reject;});
  const crossingClosed = new Promise(resolve=>{ crossing.onclose=(event)=>resolve(event.code); setTimeout(()=>resolve('timeout'), 8000).unref(); });
  crossing.send(JSON.stringify({target:'other',keys:'x'}));
  assert.equal(await crossingClosed,1008,'a crossing frame closes the connection as a policy violation');
});
