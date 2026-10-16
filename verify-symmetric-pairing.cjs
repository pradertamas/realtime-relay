'use strict';
const {spawn}=require('node:child_process'),{randomInt}=require('node:crypto'),assert=require('node:assert/strict');
const {WebSocket}=require('ws');
const port=randomInt(20000,60000),peers=[];
const child=spawn(process.execPath,['server.js'],{cwd:__dirname,env:{...process.env,PORT:String(port)},windowsHide:true,stdio:['ignore','pipe','pipe']});
let output='';child.stdout.on('data',d=>output+=d);child.stderr.on('data',d=>output+=d);
const deadline=setTimeout(()=>{console.error('FAIL symmetric pairing: timeout');child.kill();process.exit(1);},15000);
const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function until(fn){for(let i=0;i<200;i++){if(fn())return;await sleep(10);}throw Error('Expected signaling event timed out');}
async function open(code,role,intent){
  const ws=new WebSocket(`ws://127.0.0.1:${port}/ws?session=${code}&role=${role}&intent=${intent}`);
  const p={ws,messages:[],error:null};peers.push(p);ws.on('error',e=>p.error=e);ws.on('message',d=>p.messages.push(JSON.parse(d.toString())));
  await until(()=>p.messages.some(m=>m.type==='registration')||p.error);
  if(p.error)throw p.error;
  p.result=p.messages.find(m=>m.type==='registration').status;return p;
}
(async()=>{
  await until(()=>output.includes('server start'));
  const absent=await open('7K4M2Q','sender','join');assert.equal(absent.result,'not-found');
  for(const [code,creatorRole] of [['7K4M2Q','sender'],['8K4M2Q','receiver']]){
    const joinRole=creatorRole==='sender'?'receiver':'sender';
    const creator=await open(code,creatorRole,'create');assert.equal(creator.result,'ok');
    for(const role of ['sender','receiver'])assert.equal((await open(code,role,'create')).result,'conflict');
    assert.equal((await open(code,creatorRole,'join')).result,'role-occupied');
    const joiner=await open(code,joinRole,'join');assert.equal(joiner.result,'ok');
    await until(()=>[creator,joiner].every(p=>p.messages.some(m=>m.type==='peer-present')));
    const sender=creatorRole==='sender'?creator:joiner,receiver=creatorRole==='receiver'?creator:joiner;
    // Offer always originates at the sender, after presence, regardless of who created.
    const offer={type:'offer',sdp:'v=0\r\ns=pairing-qr-secret-fixture\r\n'};
    sender.ws.send(JSON.stringify(offer));await until(()=>receiver.messages.some(m=>m.type==='offer'));
    assert.deepEqual(receiver.messages.find(m=>m.type==='offer'),offer);
    receiver.ws.send(JSON.stringify({type:'answer',sdp:'answer-fixture'}));await until(()=>sender.messages.some(m=>m.type==='answer'));
    for(const role of ['sender','receiver'])assert.equal((await open(code,role,'join')).result,'role-occupied');
    creator.ws.close();await until(()=>joiner.ws.readyState===WebSocket.CLOSED);
    assert.equal((await open(code,joinRole,'join')).result,'not-found');
    const fresh=await open(code,joinRole,'create');assert.equal(fresh.result,'ok');fresh.ws.close();
  }
  await sleep(100);
  assert.ok(!output.includes('7K4M2Q')&&!output.includes('8K4M2Q')&&!output.includes('pairing-qr-secret-fixture'));
  for(const line of output.trim().split(/\r?\n/))assert.ok(!Object.hasOwn(JSON.parse(line),'session'));
  console.log('PASS symmetric CREATE/JOIN: both creator roles, conflicts against either role, not-found, duplicate roles/third peers, peer-present both orders, sender offer/receiver answer, creator cleanup/code release and no code/QR/SDP logs.');
})().catch(e=>{console.error('FAIL symmetric pairing: '+e.message);process.exitCode=1;}).finally(()=>{clearTimeout(deadline);for(const p of peers)p.ws.terminate();child.kill();});
