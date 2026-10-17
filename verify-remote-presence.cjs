'use strict';
const assert=require('node:assert/strict'),{spawn}=require('node:child_process'),{randomInt}=require('node:crypto'),{WebSocket}=require('ws');
const port=randomInt(20000,60000),base=`http://127.0.0.1:${port}`,peers=[];
// Intentionally fake canonical Base64URL fixtures, never generated device credentials.
const A='AAAAAAAAAAAAAAAAAAAAAA',B='BBBBBBBBBBBBBBBBBBBBBA',C='CCCCCCCCCCCCCCCCCCCCCA';
let logs='';const child=spawn(process.execPath,['server.js'],{cwd:__dirname,env:{...process.env,PORT:String(port)},windowsHide:true,stdio:['ignore','pipe','pipe']});
child.stdout.on('data',d=>logs+=d);child.stderr.on('data',d=>logs+=d);
const deadline=setTimeout(()=>{child.kill();console.error('FAIL remote presence: timeout');process.exit(1);},15000);
async function until(fn){for(let i=0;i<300;i++){if(fn())return;await new Promise(r=>setTimeout(r,10));}throw Error('Expected remote signaling event timed out');}
async function open(code,role='sender',intent='create'){
 const ws=new WebSocket(`ws://127.0.0.1:${port}/ws?session=${code}&role=${role}&intent=${intent}`),p={ws,messages:[]};peers.push(p);
 ws.on('error',()=>{});ws.on('message',raw=>p.messages.push(JSON.parse(raw)));
 await until(()=>p.messages.some(m=>m.type==='registration'));assert.equal(p.messages[0].status,'ok');assert.equal(p.messages[0].remotePresence,true);return p;
}
async function presence(p,token){const start=p.messages.length;p.ws.send(JSON.stringify({type:'remote-presence-register',token}));await until(()=>p.messages.slice(start).some(m=>m.type==='remote-presence'));return p.messages.slice(start).find(m=>m.type==='remote-presence').status;}
async function resolve(token,origin='https://pradertamas.github.io'){
 const res=await fetch(base+'/remote/resolve',{method:'POST',headers:{Origin:origin,'Content-Type':'application/json'},body:JSON.stringify({token})});
 assert.equal(res.headers.get('cache-control'),'no-store');return {res,body:await res.json()};
}
(async()=>{
 await until(()=>logs.includes('server start'));
 let p=await open('7K4M2Q');assert.equal(await presence(p,A),'registered');
 let r=await resolve(A);assert.equal(r.res.status,200);assert.deepEqual(r.body,{status:'available',session:'7K4M2Q'});
 assert.equal(r.res.headers.get('access-control-allow-origin'),'https://pradertamas.github.io');
 assert.equal((await resolve(B)).res.status,404);
 assert.equal((await resolve(A,'https://evil.invalid')).res.status,403);
 assert.equal((await resolve(A,'http://localhost:8080')).res.status,200);
 const options=await fetch(base+'/remote/resolve',{method:'OPTIONS',headers:{Origin:'https://pradertamas.github.io','Access-Control-Request-Method':'POST','Access-Control-Request-Headers':'content-type'}});
 assert.equal(options.status,204);assert.equal(options.headers.get('access-control-allow-methods'),'POST');assert.equal(options.headers.get('cache-control'),'no-store');
 assert.equal(await presence(p,B),'registered');assert.equal((await resolve(A)).res.status,404);assert.equal((await resolve(B)).res.status,200);
 p.ws.close();await until(()=>p.ws.readyState===3);assert.equal((await resolve(B)).res.status,404);
 // Rotation maps the same persistent token onto only the new ephemeral code.
 p=await open('8K4M2Q');assert.equal(await presence(p,B),'registered');assert.equal((await resolve(B)).body.session,'8K4M2Q');
 const receiver=await open('8K4M2Q','receiver','join');assert.equal((await resolve(B)).res.status,404);
 assert.equal(await presence(p,B),'denied');assert.equal(await presence(receiver,C),'denied');
 assert.ok(!JSON.stringify([...p.messages,...receiver.messages]).includes(C)); // Control secrets never forwarded.
 p.ws.close();await until(()=>receiver.ws.readyState===3);
 const browser=await open('9K4M2Q','receiver');assert.equal(await presence(browser,C),'denied');
 const joiner=await open('9K4M2Q','sender','join');assert.equal(await presence(joiner,C),'denied');
 joiner.ws.close();await until(()=>browser.ws.readyState===3);
 p=await open('6K4M2Q');assert.equal(await presence(p,A),'registered');
 p.ws.send(JSON.stringify({type:'remote-presence-remove'}));await until(()=>p.messages.some(m=>m.status==='removed'));assert.equal((await resolve(A)).res.status,404);
 assert.equal(await presence(p,C),'registered');
 const invalidBody=await fetch(base+'/remote/resolve',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({token:'bad'})});assert.equal(invalidBody.status,400);
 const get=await fetch(base+'/remote/resolve');assert.equal(get.status,405);
 const oversized=await fetch(base+'/remote/resolve',{method:'POST',headers:{'Content-Type':'application/json'},body:' '.repeat(600)});assert.equal(oversized.status,413);
 // Per-token throttling, bounded hash keys and a separately tested global cap.
 let limited=false;for(let i=0;i<22;i++){if((await resolve(C)).res.status===429){limited=true;break;}}assert.ok(limited);
 const {RemotePresence}=require('./remote-presence.cjs'),{JoinLimit}=require('./join-limit.cjs');
 let now=0;const limit=new JoinLimit({total:2,perCode:2,now:()=>now});assert.ok(limit.allow('request'));assert.ok(limit.allow('request'));assert.equal(limit.allow('request'),false);now=60000;assert.ok(limit.allow('request'));
 const unit=new RemotePresence(),socket={readyState:1},session={sender:socket,creator:socket};
 assert.equal(unit.register(socket,A,session,'5K4M2Q'),'registered');assert.ok(![...unit.mapping.keys()].includes(A));assert.equal(unit.mapping.size,1);
 unit.register(socket,B,session,'5K4M2Q');assert.equal(unit.mapping.size,1);assert.equal(unit.resolve(A),null);unit.remove(socket);assert.equal(unit.mapping.size,0);
 const global=new RemotePresence({limit:new JoinLimit({total:1,perCode:1})});
 async function probe(){
  let status;
  const req={url:'/remote/resolve',method:'POST',headers:{'content-type':'application/json'},resume(){},async *[Symbol.asyncIterator](){yield Buffer.from(JSON.stringify({token:A}));}};
  const res={writableEnded:false,writeHead(code){status=code;},end(){this.writableEnded=true;}};
  await global.http(req,res);return status;
 }
 assert.equal(await probe(),404);assert.equal(await probe(),429);
 assert.throws(()=>new RemotePresence({origins:['*']}),/Invalid remote origin/);
 assert.ok(!logs.includes(A)&&!logs.includes(B)&&!logs.includes(C)&&!logs.includes('?device='));
 console.log('PASS remote presence/resolve: allowed roles/waiting only, resolve/rotation/regeneration/disconnect/peer cleanup, no-store, CORS/preflight, throttling, hash-only bounded memory and secret-free logs.');
})().catch(e=>{console.error('FAIL remote presence:',e.message);process.exitCode=1;}).finally(()=>{clearTimeout(deadline);for(const p of peers)p.ws.terminate();child.kill();});
