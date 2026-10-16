'use strict';
const {spawn}=require('node:child_process');
const {once}=require('node:events');
const assert=require('node:assert/strict');
const {WebSocket}=require('ws');
const port=18000+Math.floor(Math.random()*10000),clients=[];
const server=spawn(process.execPath,['server.js'],{cwd:__dirname,env:{...process.env,PORT:String(port)},windowsHide:true,stdio:['ignore','pipe','pipe']});
let output='';server.stdout.on('data',d=>{output+=d;});server.stderr.on('data',d=>{output+=d;});
const deadline=setTimeout(()=>{console.error('Timed out',output);server.kill();process.exit(1);},15000);
async function open(session,role){const ws=new WebSocket(`ws://127.0.0.1:${port}/ws?session=${session}&role=${role}`);clients.push(ws);await once(ws,'open');return ws;}
function message(ws){return new Promise((resolve,reject)=>{const timeout=setTimeout(()=>reject(Error('Message timeout')),2000);ws.once('message',(data,binary)=>{clearTimeout(timeout);resolve({data,binary});});});}
async function rejected(session,role,code){await new Promise((resolve,reject)=>{const ws=new WebSocket(`ws://127.0.0.1:${port}/ws?session=${session}&role=${role}`);ws.on('error',()=>{});ws.on('unexpected-response',(_,res)=>{res.resume();ws.terminate();try{assert.equal(res.statusCode,code);resolve();}catch(e){reject(e);}});ws.on('open',()=>{ws.terminate();reject(Error('Unexpected open'));});});}
(async()=>{
 await new Promise((resolve,reject)=>{const check=()=>{if(output.includes('server start'))resolve();else if(server.exitCode!==null)reject(Error(output));else setTimeout(check,20);};check();});
 const a=await open('test_session_a','sender'),b=await open('test_session_a','receiver'),other=await open('test_session_b','receiver');
 let isolated=0;other.on('message',()=>isolated++);
 for(const [from,to,payload] of [[a,b,{type:'offer',sdp:'v=0\r\n'}],[b,a,{type:'answer',sdp:'v=0\r\n'}],[b,a,{type:'ready'}],[a,b,{type:'ice',candidate:{candidate:'candidate:test'}}]]){
   const raw=JSON.stringify(payload),received=message(to);from.send(raw);const result=await received;assert.equal(result.data.toString(),raw);assert.equal(result.binary,false);
 }
 const binary=message(a);b.send(Buffer.from([0,1,255]));assert.deepEqual((await binary).data,Buffer.from([0,1,255]));
 await rejected('test_session_a','sender',409);await rejected('short','sender',400);
 // Check exact payload boundary and rejection above it. Production clients send signaling JSON only.
 const limit=message(b);a.send('x'.repeat(65536));assert.equal((await limit).data.length,65536);
 const closed=once(a,'close');a.send('x'.repeat(65537));assert.equal((await closed)[0],1009);
 assert.equal(isolated,0);
 console.log('PASS local relay offer/answer/ready/ICE both directions, unchanged text/binary payloads, session isolation, duplicate role 409, invalid session 400, 64 KiB boundary / oversized 1009.');
})().catch(e=>{console.error(e);process.exitCode=1;}).finally(()=>{clearTimeout(deadline);for(const ws of clients)ws.terminate();server.kill();});
