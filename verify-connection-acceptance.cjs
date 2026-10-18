'use strict';
const assert = require('node:assert/strict');
const {randomBytes} = require('node:crypto');
const {readFileSync} = require('node:fs');
const http = require('node:http');
const {once} = require('node:events');
const {ConnectionRequestStore, ESTABLISHMENT_MS, TOMBSTONE_MS} = require('./connection-request-store.cjs');
const {ConnectionRequestHttp} = require('./connection-request-http.cjs');
const {JoinLimit} = require('./join-limit.cjs');
const claim = () => randomBytes(32).toString('base64url');
let passed = 0;
function fixture(capacity = 1000) {
  let now = Date.UTC(2026, 0, 1);
  const store = new ConnectionRequestStore({now: () => now, capacity});
  const r = store.create('send').body, c = claim(), other = claim();
  return {store, r, c, other, advance(ms) {now += ms;}, accept: value => store.accept(r.requestId, r.recipientCapability, value || c),
    status: secret => store.status(r.requestId, secret || r.initiatorSecret), cancel: () => store.cancel(r.requestId, r.initiatorSecret)};
}
function test(name, fn) { fn(); passed++; console.log('PASS ' + name); }
function noSecrets(body, values) {
  const text = JSON.stringify(body);
  for (const v of values) assert.ok(!text.includes(v));
  assert.ok(!/Hash|Secret|Capability|session|assignment/.test(text));
}
async function main() {
  test('valid Accept and exact deadline', () => {
    const f = fixture(), result = f.accept(); assert.equal(result.code,200);
    assert.equal(result.body.state,'ACCEPTED'); assert.equal(result.body.initiatorRole,'send');
    assert.equal(Date.parse(result.body.connectBy)-Date.parse(result.body.acceptedAt),ESTABLISHMENT_MS);
    noSecrets(result.body,[f.c,f.r.initiatorSecret,f.r.recipientCapability]);
  });
  test('same claim lost-response retry preserves timestamps', () => {
    const f=fixture(), first=f.accept().body; f.advance(1000);
    const retry=f.accept(); assert.equal(retry.code,200);
    assert.equal(retry.body.acceptedAt,first.acceptedAt); assert.equal(retry.body.connectBy,first.connectBy);
  });
  test('different claim never takes over and winner retry succeeds', () => {
    const f=fixture(); f.accept(); assert.equal(f.accept(f.other).code,409);
    assert.equal(f.accept().code,200); assert.equal(f.accept(f.other).code,409);
    assert.equal(f.status(f.other).code,404);
  });
  test('canonical claim format is mandatory', () => {
    const f=fixture(); for(const bad of [null,'', 'A'.repeat(22),'A'.repeat(42),'A'.repeat(44),'B'.repeat(43),f.c+'='])
      assert.equal(f.store.accept(f.r.requestId,f.r.recipientCapability,bad).code,400);
    assert.equal(f.status().body.state,'WAITING');
  });
  test('Accept expiresAt minus one succeeds',()=>{const f=fixture();f.advance(299999);assert.equal(f.accept().code,200);});
  test('Accept at expiresAt fails with authenticated 410',()=>{const f=fixture();f.advance(300000);assert.equal(f.accept().code,410);assert.equal(f.status().body.state,'EXPIRED');});
  test('ACCEPTED survives original WAITING expiry and cleanup',()=>{
    const f=fixture();f.advance(297000);f.accept();f.advance(3000);f.store.cleanup();assert.equal(f.status().body.state,'ACCEPTED');
    f.advance(116000);assert.equal(f.status().body.state,'ACCEPTED');
    f.advance(1000);const result=f.status();assert.equal(result.code,410);assert.equal(result.body.state,'FAILED');
    assert.equal(result.body.failureReason,'establishment_timeout');assert.equal(f.accept().code,410);
  });
  test('cleanup independently applies establishment failure',()=>{
    const f=fixture();f.accept();f.advance(120000);f.store.cleanup();
    assert.equal(f.status(f.c).body.failureReason,'establishment_timeout');
  });
  test('initiator and winner status projections',()=>{
    const f=fixture();f.accept();const i=f.status(),c=f.status(f.c),r=f.status(f.r.recipientCapability);
    assert.equal(i.code,200);assert.ok(i.body.createdAt);assert.ok(i.body.acceptedAt);assert.ok(i.body.connectBy);
    assert.equal(c.code,200);assert.equal(c.body.createdAt,undefined);assert.ok(c.body.connectBy);
    assert.deepEqual(Object.keys(r.body).sort(),['requestId','state','initiatorRole','serverNow','expiresAt'].sort());
    for(const v of [i,c,r])noSecrets(v.body,[f.c,f.r.initiatorSecret,f.r.recipientCapability]);
  });
  test('wrong secret types and unknown requests share safe failure',()=>{
    const f=fixture();f.accept();const safe={code:404,body:{error:'unavailable'}};
    for(const auth of [f.r.initiatorSecret,f.c,f.other,null])assert.deepEqual(f.store.accept(f.r.requestId,auth,f.c),safe);
    for(const auth of [f.r.recipientCapability,f.c,f.other,null])assert.deepEqual(f.store.cancel(f.r.requestId,auth),safe);
    assert.deepEqual(f.store.accept('A'.repeat(22),f.r.recipientCapability,f.c),safe);
    assert.deepEqual(f.store.cancel('A'.repeat(22),f.r.initiatorSecret),safe);
  });
  test('WAITING Cancel prevents Accept and is idempotent',()=>{
    const f=fixture();assert.equal(f.cancel().code,200);assert.equal(f.accept().code,410);
    f.advance(1000);assert.equal(f.cancel().code,200);assert.equal(f.status().body.state,'CANCELED');
  });
  test('ACCEPTED Cancel beats retries and timeout',()=>{
    const f=fixture();f.accept();assert.equal(f.cancel().code,200);assert.equal(f.accept().code,410);
    f.advance(119999);assert.equal(f.status().body.state,'CANCELED');
  });
  test('Cancel does not overwrite prior EXPIRED or FAILED',()=>{
    const f=fixture();f.advance(300000);assert.equal(f.cancel().code,410);assert.equal(f.status().body.state,'EXPIRED');
    const g=fixture();g.accept();g.advance(120000);assert.equal(g.cancel().code,410);assert.equal(g.status().body.state,'FAILED');
  });
  test('CANCELED retention is based on first cancellation',()=>{
    const f=fixture();f.cancel();f.advance(TOMBSTONE_MS-1);assert.equal(f.cancel().code,200);
    f.advance(1);assert.equal(f.status().code,404);assert.equal(f.cancel().code,404);
  });
  test('FAILED retention starts at deadline, not lazy observation',()=>{
    const f=fixture();f.accept();f.advance(120000+TOMBSTONE_MS-1);assert.equal(f.status(f.c).code,410);
    assert.equal(f.status(f.r.recipientCapability).body.failureReason,undefined);
    f.advance(1);assert.equal(f.status(f.c).code,404);
  });
  test('capacity retains live accepted records and terminal tombstones',()=>{
    const f=fixture(1);f.accept();assert.equal(f.store.create('receive').code,503);
    f.advance(120000);f.store.cleanup();assert.equal(f.store.create('receive').code,503);
    f.advance(TOMBSTONE_MS);assert.equal(f.store.create('receive').code,201);
  });
  test('private claim hash only; Accept critical section is synchronous',()=>{
    const source=readFileSync(require.resolve('./connection-request-store.cjs'),'utf8');
    const method=source.split('  accept(id, capability, claimSecret) {')[1].split('  cancel(')[0];
    assert.ok(method.includes('record.recipientClaimHash = claimHash'));
    assert.ok(method.includes('const claimHash = digest(claimSecret)'));
    assert.ok(!/record\.\w+\s*=\s*claimSecret\b/.test(source));
    assert.ok(!/\basync\b|^\s*await\b/m.test(method));
  });
  // Promise scheduling models near-concurrent entrants; each store mutation is synchronous.
  for(const reverse of [false,true]) {
    const f=fixture(), contenders=reverse?[f.other,f.c]:[f.c,f.other];
    const results=await Promise.all(contenders.map(c=>Promise.resolve().then(()=>f.accept(c))));
    assert.deepEqual(results.map(r=>r.code),[200,409]);
    assert.equal(f.status(contenders[0]).code,200);assert.equal(f.status(contenders[1]).code,404);
    passed++;
  }
  for(const cancelFirst of [false,true]) {
    const f=fixture();const operations=cancelFirst?[()=>f.cancel(),()=>f.accept()]:[()=>f.accept(),()=>f.cancel()];
    const result=await Promise.all(operations.map(op=>Promise.resolve().then(op)));
    assert.deepEqual(result.map(r=>r.code),cancelFirst?[200,410]:[200,200]);
    assert.equal(f.status().body.state,'CANCELED');passed++;
  }
  await httpSmoke();
  console.log(`PASS ${passed} CP2 test groups (state/auth/race/deadline/HTTP/security).`);
}
async function httpSmoke() {
  let now=Date.UTC(2026,0,1),tick;
  const store=new ConnectionRequestStore({now:()=>now});
  const router=new ConnectionRequestHttp({store,schedule(fn){tick=fn;return {unref(){}};},cancel(){},
    acceptLimit:new JoinLimit({perCode:6,total:100,now:()=>now}),cancelLimit:new JoinLimit({perCode:3,total:100,now:()=>now})});
  const server=http.createServer(async(req,res)=>{if(!await router.http(req,res)){res.writeHead(404);res.end();}});
  server.listen(0,'127.0.0.1');await once(server,'listening');
  const base=`http://127.0.0.1:${server.address().port}`;
  async function call(path,method='GET',secret,body) {
    const headers={...(secret&&{Authorization:`Bearer ${secret}`}),...(body!==undefined&&{'Content-Type':'application/json'})};
    const res=await fetch(base+path,{method,headers,...(body!==undefined&&{body:JSON.stringify(body)})});
    const raw=await res.text();return {code:res.status,body:raw?JSON.parse(raw):null,headers:res.headers};
  }
  try {
    const r=(await call('/connection-requests','POST',null,{version:1,initiatorRole:'receive'})).body;
    const path=`/connection-requests/${r.requestId}`,c=claim(),other=claim();
    assert.equal((await call(path+'/status','GET',r.recipientCapability)).body.state,'WAITING');
    const first=await call(path+'/accept','POST',r.recipientCapability,{claimSecret:c});assert.equal(first.code,200);
    for(const auth of [r.initiatorSecret,c])assert.equal((await call(path+'/status','GET',auth)).body.state,'ACCEPTED');
    const retry=await call(path+'/accept','POST',r.recipientCapability,{claimSecret:c});
    assert.equal(retry.code,200);assert.equal(retry.body.connectBy,first.body.connectBy);
    assert.equal((await call(path+'/accept','POST',r.recipientCapability,{claimSecret:other})).code,409);
    for(const body of [{claimSecret:'bad'},{claimSecret:'B'.repeat(43)},{claimSecret:c,extra:true}])
      assert.equal((await call(path+'/accept','POST',r.recipientCapability,body)).code,400);
    const rate=await call(path+'/accept','POST',r.recipientCapability,{claimSecret:c});
    assert.equal(rate.code,429);assert.equal(rate.headers.get('retry-after'),'60');
    for(let i=0;i<3;i++)assert.equal((await call(path+'/cancel','POST',r.initiatorSecret)).code,200);
    const limited=await call(path+'/cancel','POST',r.initiatorSecret);assert.equal(limited.code,429);assert.equal(limited.headers.get('retry-after'),'60');
    const terminal=await call(path+'/status','GET',c);assert.equal(terminal.code,410);assert.equal(terminal.body.state,'CANCELED');
    assert.equal(terminal.headers.get('cache-control'),'no-store');noSecrets(terminal.body,[c,r.initiatorSecret,r.recipientCapability]);
    now+=60000;
    assert.equal((await call(path+'/accept','POST',r.recipientCapability,{claimSecret:c})).code,410);
    assert.equal((await call(path+'/accept?auth=x','POST',r.recipientCapability,{claimSecret:c})).code,400);
    for(const endpoint of ['decline','busy'])assert.equal((await call(path+'/'+endpoint,'POST')).code,404);
    const second=(await call('/connection-requests','POST',null,{version:1,initiatorRole:'send'})).body;
    assert.equal((await call(`/connection-requests/${second.requestId}/cancel`,'POST',second.initiatorSecret,{})).code,200);
    const race=(await call('/connection-requests','POST',null,{version:1,initiatorRole:'send'})).body;
    const racePath=`/connection-requests/${race.requestId}`,claims=[claim(),claim()];
    const contenders=await Promise.all(claims.map(value=>call(racePath+'/accept','POST',race.recipientCapability,{claimSecret:value})));
    assert.deepEqual(contenders.map(r=>r.code).sort(),[200,409]);
    const winner=contenders.findIndex(r=>r.code===200);
    assert.equal((await call(racePath+'/status','GET',claims[winner])).code,200);
    assert.equal((await call(racePath+'/status','GET',claims[1-winner])).code,404);
    passed++;
    const preflight=await fetch(base+racePath+'/accept',{method:'OPTIONS',headers:{Origin:'https://pairing.pradert.synology.me',
      'Access-Control-Request-Method':'POST','Access-Control-Request-Headers':'authorization,content-type'}});
    assert.equal(preflight.status,204);assert.equal(preflight.headers.get('access-control-allow-methods'),'POST');
    const denied=await fetch(base+racePath+'/cancel',{method:'POST',headers:{Authorization:`Bearer ${claims[winner]}`}});
    assert.equal(denied.status,404);
    now+=120000;tick();assert.equal((await call(path+'/status','GET',c)).code,404);
    passed++;
    console.log('PASS CP2 local HTTP smoke: create/preview/Accept/claim/retry/conflict/Cancel/410, rate limits and absent future routes.');
  } finally {router.close();server.closeAllConnections();await new Promise(r=>server.close(r));}
}
main().catch(()=>{console.error('FAIL CP2 verification (credentials suppressed)');process.exitCode=1;});
