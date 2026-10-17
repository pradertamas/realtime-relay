'use strict';
// No trust in forwarded client IPs. Bounded single-instance attempt budget.
class JoinLimit {
  constructor({windowMs=60000,perCode=12,total=120,now=Date.now}={}){
    Object.assign(this,{windowMs,perCode,total,now});this.codes=new Map();this.start=now();this.count=0;
  }
  allow(code){
    const now=this.now();
    if(now-this.start>=this.windowMs){this.start=now;this.count=0;this.codes.clear();}
    // Total budget also bounds map cardinality, including nonexistent random codes.
    if(++this.count>this.total)return false;
    const count=(this.codes.get(code)||0)+1;this.codes.set(code,count);
    return count<=this.perCode;
  }
}
module.exports={JoinLimit};
