'use strict';
const assert=require('node:assert/strict'),{JoinLimit}=require('./join-limit.cjs');
let now=0;const limit=new JoinLimit({now:()=>now});
for(let i=0;i<12;i++)assert.equal(limit.allow('secret'),true);
assert.equal(limit.allow('secret'),false);
assert.equal(limit.allow('another'),true);
for(let i=14;i<120;i++)assert.equal(limit.allow('code'+i),true);
assert.equal(limit.allow('new'),false);assert.ok(limit.codes.size<=120);
now=60000;assert.equal(limit.allow('secret'),true);assert.equal(limit.codes.size,1);
const {spawn}=require('node:child_process'),{randomInt}=require('node:crypto'),{WebSocket}=require('ws');
const port=randomInt(20000,60000),peers=[];
const child=spawn(process.execPath,['server.js'],{cwd:__dirname,env:{...process.env,PORT:String(port)},windowsHide:true,stdio:['ignore','pipe','pipe']});
let logs='';child.stdout.on('data',d=>logs+=d);child.stderr.on('data',d=>logs+=d);
const deadline=setTimeout(()=>{child.kill();process.exit(1);},10000);
async function open(code,intent,role='sender'){
 return new Promise((resolve,reject)=>{
  const ws=new WebSocket(`ws://127.0.0.1:${port}/ws?session=${code}&role=${role}&intent=${intent}`);peers.push(ws);
  ws.on('error',reject);ws.on('message',raw=>{const m=JSON.parse(raw);if(m.type==='registration')resolve(m.status);});
 });
}
(async()=>{
 for(let i=0;i<200&&!logs.includes('server start');i++)await new Promise(r=>setTimeout(r,10));
 for(let i=0;i<12;i++)assert.equal(await open('7K4M2Q','join'),'not-found');
 assert.equal(await open('7K4M2Q','join'),'rate-limited');
 assert.equal(await open('8K4M2Q','create','receiver'),'ok');
 assert.equal(await open('8K4M2Q','join'),'ok');
 assert.ok(!logs.includes('7K4M2Q')&&!logs.includes('8K4M2Q'));
 console.log('PASS JOIN limit: per-code/global/window/memory bounds, real registration rate-limited, unaffected other code and privacy.');
})().catch(e=>{console.error('FAIL JOIN limit:',e);process.exitCode=1;}).finally(()=>{clearTimeout(deadline);for(const ws of peers)ws.terminate();child.kill();});
