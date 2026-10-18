'use strict';
const assert = require('node:assert/strict');
const {spawn} = require('node:child_process');
const {once} = require('node:events');
const {randomBytes} = require('node:crypto');
const net = require('node:net');
const {WebSocket} = require('ws');
const MARKER = 'SYNTHETIC-NON-CREDENTIAL-CONTROL-AUDIT';
const payload = JSON.stringify({type:'request-auth',requestId:'synthetic-request-id',secret:MARKER});
let stage = 'startup', groups = 0;
async function main() {
  const reservation = net.createServer(); reservation.listen(0,'127.0.0.1'); await once(reservation,'listening');
  const port = reservation.address().port; await new Promise(resolve => reservation.close(resolve));
  const child = spawn(process.execPath,['server.js'],{cwd:__dirname,env:{...process.env,PORT:String(port)},
    windowsHide:true,stdio:['ignore','pipe','pipe']});
  let logs = ''; child.stdout.on('data',d=>logs+=d); child.stderr.on('data',d=>logs+=d);
  const peers = [], credentials = [], base = `http://127.0.0.1:${port}`;
  const deadline = setTimeout(()=>child.kill(),15000);
  async function until(fn) { for(let i=0;i<300;i++){if(fn())return;await new Promise(r=>setTimeout(r,5));}throw Error('Local wait timeout'); }
  async function open(code,role,intent) {
    const ws = new WebSocket(base.replace('http:','ws:')+`/ws?session=${code}&role=${role}&intent=${intent}`);
    const p = {ws,messages:[],closed:false,closeCode:null,reason:''}; peers.push(p);
    ws.on('error',()=>{});ws.on('message',(data,binary)=>p.messages.push({data,binary}));
    ws.on('close',(code,reason)=>{p.closed=true;p.closeCode=code;p.reason=reason.toString();});await once(ws,'open');return p;
  }
  const has = (p,type) => p.messages.some(m=>{try{return JSON.parse(m.data.toString()).type===type;}catch{return false;}});
  async function post(path,auth,body) {
    const response=await fetch(base+path,{method:'POST',headers:{'Content-Type':'application/json',...(auth&&{Authorization:`Bearer ${auth}`})},body:JSON.stringify(body)});
    assert.ok(response.ok);return response.json();
  }
  async function bound() {
    const r=await post('/connection-requests',null,{version:1,initiatorRole:'send'}),c=randomBytes(32).toString('base64url');
    credentials.push(r.initiatorSecret,r.recipientCapability,c);
    const path=`/connection-requests/${r.requestId}`;
    await post(path+'/accept',r.recipientCapability,{claimSecret:c});
    for(const auth of [r.initiatorSecret,c])await post(path+'/participant-state',auth,{ready:true});
    const b=await post(path+'/session',r.initiatorSecret,{});
    return {r,c,code:b.session.code};
  }
  function auth(p,r,value) {p.ws.send(JSON.stringify({type:'request-auth',requestId:r.requestId,secret:value}));}
  async function normal(a,b) {
    for(const [value,binary] of [[JSON.stringify({type:'offer',sdp:'synthetic-normal'}),false],
      [Buffer.from(JSON.stringify({type:'ice',candidate:'synthetic-normal'})),true],
      [Buffer.from([0,255,128,1]),true],[Buffer.from('{"type":'),true]]) {
      const start=b.messages.length, expected=Buffer.from(value);
      a.ws.send(value);await until(()=>b.messages.slice(start).some(m=>m.data.equals(expected)));
      assert.equal(b.messages.slice(start).find(m=>m.data.equals(expected)).binary,binary);
    }
    groups++;
  }
  function clean(p) {
    assert.ok(!p.messages.some(m=>m.data.includes(Buffer.from(MARKER))));
    assert.ok(!p.reason.includes(MARKER));
  }
  async function blocked(a,b,body=payload,binary=true) {
    a.ws.send(binary?Buffer.from(body):body);
    // On the old code, peer delivery wins this wait and proves the regression.
    await until(()=>a.closed || b.messages.some(m=>m.data.includes(Buffer.from(MARKER))));
    clean(a);clean(b);assert.ok(a.closed);assert.equal(a.closeCode,1008);
    await until(()=>b.closed);clean(b);groups++;
  }
  try {
    await until(()=>logs.includes('server start'));
    // First case is the exact CP4-A blocker, before any request-bound setup.
    stage='legacy binary request-auth must not reach peer';
    const a=await open('CP4AUD','sender','create');await until(()=>has(a,'registration'));
    const b=await open('CP4AUD','receiver','join');await until(()=>has(b,'peer-present'));
    await blocked(a,b);
    stage='legacy non-control text/binary/invalid-UTF8/malformed JSON forwarding';
    const x=await open('FIXTXT','sender','create');await until(()=>has(x,'registration'));
    const y=await open('FIXTXT','receiver','join');await until(()=>has(y,'peer-present'));
    await normal(x,y);
    stage='legacy text control rejection';await blocked(x,y,payload,false);
    for(const binary of [false,true]) {
      stage=`authenticated request control rejection binary=${binary}`;
      const f=await bound(),i=await open(f.code,'sender','create');auth(i,f.r,f.r.initiatorSecret);
      await until(()=>has(i,'registration'));
      // Pre-auth signaling of either transport must not reach the registered initiator.
      for(const frameBinary of [false,true]) {
        const attacker=await open(f.code,'receiver','join');
        attacker.ws.send(frameBinary?Buffer.from('{"type":"offer","sdp":"preauth"}'):'{"type":"offer","sdp":"preauth"}');
        await until(()=>attacker.closed);assert.equal(attacker.closeCode,1008);assert.equal(has(i,'offer'),false);groups++;
      }
      const binaryAuth=await open(f.code,'receiver','join');
      binaryAuth.ws.send(Buffer.from(JSON.stringify({type:'request-auth',requestId:f.r.requestId,secret:MARKER})));
      await until(()=>binaryAuth.closed);assert.equal(binaryAuth.closeCode,1008);clean(i);clean(binaryAuth);groups++;
      const j=await open(f.code,'receiver','join');auth(j,f.r,f.c);
      await until(()=>has(i,'peer-present')&&has(j,'peer-present'));groups++;
      await normal(i,j);
      // Padding remains within the existing 64 KiB frame ceiling; no 512-byte
      // post-registration parse shortcut may bypass control recognition.
      const control=JSON.stringify({type:'request-auth',requestId:'synthetic-request-id',secret:MARKER,padding:' '.repeat(1024)});
      await blocked(i,j,control,binary);
    }
    stage='log and response privacy';
    for(const value of [MARKER,...credentials])assert.ok(!logs.includes(value));
    for(const p of peers) {
      clean(p);
      for(const value of credentials) {
        assert.ok(!p.messages.some(m=>m.data.includes(Buffer.from(value))));
        assert.ok(!p.reason.includes(value));
      }
    }
    groups++;
    assert.ok(!logs.includes('request-auth'));groups++;
    console.log(`PASS ${groups} control-frame regression groups: production entrypoint, binary/text control isolation, no echo/log leakage, pre-auth denial, text auth happy path and unchanged opaque forwarding.`);
  } finally {
    clearTimeout(deadline);for(const p of peers)p.ws.terminate();
    const ended=once(child,'exit');child.kill();if(child.exitCode===null)await ended;
  }
}
main().catch(()=>{console.error('FAIL control-frame privacy: '+stage+' (payload/credentials suppressed)');process.exitCode=1;});
