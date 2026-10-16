'use strict';
const {spawn}=require('node:child_process');
const {once}=require('node:events');
const {randomInt}=require('node:crypto');
const assert=require('node:assert/strict');
const {WebSocket}=require('ws');
const port=randomInt(20000,60000),code='7K4M2Q',clients=[];
let output='';
const child=spawn(process.execPath,['server.js'],{cwd:__dirname,env:{...process.env,PORT:String(port)},windowsHide:true,stdio:['ignore','pipe','pipe']});
child.stdout.on('data',data=>{output+=data;});child.stderr.on('data',data=>{output+=data;});
const deadline=setTimeout(()=>{console.error('FAIL pairing log privacy: local test timed out');child.kill();process.exit(1);},10000);
(async()=>{
  await new Promise((resolve,reject)=>{
    function ready(){if(output.includes('server start'))resolve();else if(child.exitCode!==null)reject(Error('Local relay failed to start'));else setTimeout(ready,20);}ready();
  });
  for(const method of ['GET','POST']){
    const response=await fetch(`http://127.0.0.1:${port}/turn/credentials`,{method});
    assert.equal(response.status,404,'Experimental credential route must not be active');
    await response.text();
  }
  for(const role of ['sender','receiver']){
    const ws=new WebSocket(`ws://127.0.0.1:${port}/ws?session=${code}&role=${role}`);clients.push(ws);await once(ws,'open');
  }
  for(const ws of clients){const closed=once(ws,'close');ws.close();await closed;}
  await new Promise(resolve=>setTimeout(resolve,100));
  assert.ok(output.includes('connection accepted'));assert.ok(output.includes('connection closed'));
  assert.ok(!output.includes(code),'Pairing code appeared in relay logs');
  for(const line of output.trim().split(/\r?\n/)) assert.ok(!Object.hasOwn(JSON.parse(line),'session'),'Session field appeared in relay logs');
  console.log('PASS pairing log privacy: short-code sender/receiver accepted; logs contain no session identifier; credential route GET/POST both 404.');
})().catch(error=>{console.error('FAIL pairing log privacy: '+error.message);process.exitCode=1;}).finally(()=>{clearTimeout(deadline);for(const ws of clients)ws.terminate();child.kill();});
