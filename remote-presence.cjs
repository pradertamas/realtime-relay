'use strict';
const {createHash}=require('node:crypto');
const {JoinLimit}=require('./join-limit.cjs');
const validToken=token=>typeof token==='string'&&/^[A-Za-z0-9_-]{21}[AQgw]$/.test(token);
const key=token=>createHash('sha256').update(token).digest('hex');
const DEFAULT_ORIGINS=['https://pradertamas.github.io','http://localhost:8080','http://127.0.0.1:8080'];
class RemotePresence {
 constructor({origins=DEFAULT_ORIGINS,limit=new JoinLimit({perCode:240,total:240}),tokenLimit=new JoinLimit({perCode:20,total:240})}={}){
  this.origins=new Set(origins);this.limit=limit;this.tokenLimit=tokenLimit;this.mapping=new Map();this.owners=new WeakMap();
  for(const origin of this.origins){
   let valid=false;try{const url=new URL(origin);valid=['http:','https:'].includes(url.protocol)&&url.origin===origin;}catch{}
   if(!valid)throw Error('Invalid remote origin configuration');
  }
 }
 remove(ws){const hash=this.owners.get(ws);if(hash&&this.mapping.get(hash)?.ws===ws)this.mapping.delete(hash);this.owners.delete(ws);}
 register(ws,token,session,sessionId){
  if(!validToken(token)||!/^[23456789ABCDEFGHJKLMNPQRSTUVWXYZ]{6}$/.test(sessionId)||!this.available({ws,session}))return 'denied';
  const hash=key(token),existing=this.mapping.get(hash);
  this.remove(ws);
  if(existing&&existing.ws!==ws&&this.available(existing))return 'conflict';
  // One synchronous swap: a socket never keeps both old and regenerated tokens.
  this.mapping.set(hash,{ws,session,sessionId});this.owners.set(ws,hash);return 'registered';
 }
 available(entry){return entry&&entry.ws.readyState===1&&entry.session.creator===entry.ws&&entry.session.sender===entry.ws&&!entry.session.receiver&&!entry.session.paired;}
 resolve(token){const hash=key(token),entry=this.mapping.get(hash);if(!this.available(entry)){if(entry)this.remove(entry.ws);return null;}return entry.sessionId;}
 async http(req,res){
  if(req.url!=='/remote/resolve')return false;
  const headers={'Cache-Control':'no-store','Content-Type':'application/json','Vary':'Origin'};
  const reply=(code,body)=>{res.writeHead(code,headers);res.end(JSON.stringify(body));};
  const origin=req.headers.origin;
  if(origin&&!this.origins.has(origin)){reply(403,{status:'unavailable'});req.resume();return true;}
  if(origin)headers['Access-Control-Allow-Origin']=origin;
  if(req.method==='OPTIONS'){
   if(req.headers['access-control-request-method']!=='POST'||(req.headers['access-control-request-headers']||'').split(',').some(h=>h.trim()&&h.trim().toLowerCase()!=='content-type')){reply(403,{status:'unavailable'});return true;}
   headers['Access-Control-Allow-Methods']='POST';headers['Access-Control-Allow-Headers']='Content-Type';res.writeHead(204,headers);res.end();return true;
  }
  if(req.method!=='POST'){reply(405,{status:'unavailable'});req.resume();return true;}
  if(!/^application\/json(?:\s*;|$)/i.test(req.headers['content-type']||'')){reply(400,{status:'unavailable'});req.resume();return true;}
  // Global budget is charged even for malformed bodies; map keys contain hashes only.
  if(!this.limit.allow('request')){reply(429,{status:'unavailable'});req.resume();return true;}
  let raw='',bytes=0;
  try{
   for await(const chunk of req){bytes+=chunk.length;if(bytes>512){reply(413,{status:'unavailable'});req.resume();return true;}raw+=chunk.toString('utf8');}
   const body=JSON.parse(raw);
   if(!body||Object.keys(body).length!==1||!validToken(body.token)){reply(400,{status:'unavailable'});return true;}
   // Separate bounded per-token budget, without retaining the bearer token.
   if(!this.tokenLimit.allow(key(body.token))){reply(429,{status:'unavailable'});return true;}
   const session=this.resolve(body.token);reply(session?200:404,session?{status:'available',session}:{status:'unavailable'});
  }catch{if(!res.writableEnded)reply(400,{status:'unavailable'});}
  return true;
 }
}
module.exports={RemotePresence,validToken,DEFAULT_ORIGINS};
