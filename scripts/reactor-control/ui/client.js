/* REACTOR CONTROL ROOM — page half. Server-authoritative: this page decides nothing, it only
   *requests* (mc.send) and renders what came back (mc.onState); every field may be null.
   Rendering is INCREMENTAL — the shell is static HTML, so a 1s poll only patches text/class/width
   on cached refs; the dynamic lists (chips, alarms) rebuild only when their signature changes and
   keep scrollTop. MCEF input: plain clicks only — no drag, no native double-click, no hover-only. */
(function(){
"use strict";
var mc=window.mc||{send:function(){},onState:null,player:"",display:""};
var POLL_MS=1000,HIST_MAX=60,STALE_MS=3600;    // STALE_MS: no push for this long -> link lamp red
var AMBER="#f4b63b",RED="#ff5b49",TEAL="#3fe0c2",WARM="#ffd9a6";
var RAMP_LO=600,CRIT_K=1200;                   // K: colour ramp start / Mekanism damage threshold
var D="—";                                     // the "no reading" placeholder

// ---------------------------------------------------------------- helpers
function num(v){return (typeof v==="number"&&isFinite(v))?v:null;}
function clamp(v,lo,hi){return v<lo?lo:(v>hi?hi:v);}
function fmt(n){n=num(n);if(n==null)return D;var a=Math.abs(n);
  if(a>=1e9)return (n/1e9).toFixed(2)+"G";if(a>=1e6)return (n/1e6).toFixed(2)+"M";
  if(a>=1e3)return (n/1e3).toFixed(1)+"k";if(a>=100)return String(Math.round(n));
  if(a>=10)return n.toFixed(1);return n.toFixed(2);}
function fmtInt(n){n=num(n);return n==null?D:(Math.abs(n)>=1e4?fmt(n):String(Math.round(n)));}
function signed(n){n=num(n);if(n==null)return D;if(Math.abs(n)<1e-6)return "0";
  return (n>0?"+":"−")+fmt(Math.abs(n));}
function pctOf(s,c){s=num(s);c=num(c);return (s==null||c==null||c<=0)?null:clamp(s/c*100,0,100);}
function pctTxt(p){p=num(p);return p==null?D:Math.round(p)+"%";}
/* human durations: "2h 14m" / "7m 30s" / "45s" / "—" */
function dur(sec){sec=num(sec);if(sec==null||sec<0)return D;sec=Math.round(sec);
  if(sec<60)return sec+"s";var m=Math.floor(sec/60),s=sec%60;
  if(m<60)return s?(m+"m "+s+"s"):(m+"m");var h=Math.floor(m/60);m=m%60;
  if(h<24)return m?(h+"h "+m+"m"):(h+"h");var d=Math.floor(h/24);h=h%24;
  return h?(d+"d "+h+"h"):(d+"d");}
function durCls(sec){sec=num(sec);return sec==null?"":(sec<60?"crit":(sec<300?"warn":""));}
function tk(t,k){return (t&&num(t[k])!=null)?num(t[k]):null;}
/* hero temperature ramps ivory-amber -> red between RAMP_LO and the damage threshold */
function tempColor(t){t=num(t);if(t==null)return "rgba(239,230,210,.45)";if(t<=RAMP_LO)return WARM;
  function ch(i){var a=parseInt(WARM.substr(1+i*2,2),16),b=parseInt(RED.substr(1+i*2,2),16);
    return Math.round(a+(b-a)*clamp((t-RAMP_LO)/(CRIT_K-RAMP_LO),0,1));}
  return "rgb("+ch(0)+","+ch(1)+","+ch(2)+")";}
function tempNote(t){t=num(t);if(t==null)return "no reading";if(t>=CRIT_K)return "damage threshold exceeded";
  if(t>=CRIT_K*0.875)return "approaching limit";return t>=RAMP_LO?"elevated":"nominal";}

function el(tag,c,t){var x=document.createElement(tag);if(c)x.className=c;if(t!=null)x.textContent=t;return x;}
function txt(n,s){if(n&&n.textContent!==s)n.textContent=s;}
function cls(n,s){if(n&&n.className!==s)n.className=s;}
function dis(n,b){if(n)n.disabled=!!b;}
function width(n,p){if(n)n.style.width=(p==null?0:clamp(p,0,100))+"%";}
function send(m){try{mc.send(JSON.stringify(m));}catch(e){}}

// ---------------------------------------------------------------- refs
var R={};
("offsheet offReason op devCount link linkTxt "+
 "nReactor rName rState rStateTxt rChips rPh rTemp rTrend rBurning rCrit rRing rRingV rBurnRead rStep rPre "+
 "fFuel pFuel vFuel fCool pCool vCool fHeat pHeat vHeat fWaste pWaste vWaste "+
 "tDamage tBoil tEnv tLimit tMax tPlantBurn tOwnFuel tOwnWaste wTank wTotal wWaste btnActivate btnScram "+
 "nTurbine tName tState tStateTxt tChips tPh tProd tTrend tProdMax tRing tRingV "+
 "tBufPct fBuf tNetLine tNetTxt tBufAbs tDraw tRunL tRunV tNetV fSteam pSteam vSteam fFlow pFlow vFlow "+
 "sBlades sCoils sCond sVents sDisp sDump btnDump "+
 "gState gStateTxt gProd gProdMax gBuf gBufAbs gNet gDraw fGridBuf gRunL gRunV gHot "+
 "fName fState fStateTxt fPh fRsE pRsE vRsE fReserve fReserveSec fTank fTankCap "+
 "stLamp stTxt tbFrame clock interlock ilTxt ilAt limCool limDmg limWaste limTbuf btnSafety "+
 "alCount alarms log chart btnScramAll mSub").split(" ").forEach(function(k){R[k]=document.getElementById(k);});
R.rArc=R.rRing?R.rRing.querySelector(".rv"):null;
R.tArc=R.tRing?R.tRing.querySelector(".rv"):null;
var ARC=251.3;
function setRing(arc,cap,p,color){var v=num(p);
  if(arc){arc.style.strokeDashoffset=(ARC*(1-clamp(v==null?0:v,0,100)/100)).toFixed(1);if(color)arc.style.stroke=color;}
  txt(cap,v==null?D:Math.round(v)+"%");}

// ---------------------------------------------------------------- one-time wiring
var cur={rId:null,rMax:null,rFormed:false,tId:null,safety:true,anyReactor:false};
function attr(ev,name){var n=ev.target;
  while(n&&n!==ev.currentTarget){if(n.getAttribute&&n.getAttribute(name)!=null)return n.getAttribute(name);n=n.parentNode;}
  return null;}
function on(node,fn){if(node)node.addEventListener("click",fn);}
on(R.rChips,function(ev){var v=attr(ev,"data-id");if(v)send({action:"selectReactor",id:v});});
on(R.tChips,function(ev){var v=attr(ev,"data-id");if(v)send({action:"selectTurbine",id:v});});
on(R.rStep,function(ev){var d=attr(ev,"data-d");
  if(d!=null&&cur.rId&&cur.rFormed)send({action:"burnAdjust",target:cur.rId,delta:parseFloat(d)});});
on(R.rPre,function(ev){var f=attr(ev,"data-f");
  if(f==null||!cur.rId||!cur.rFormed)return;
  f=parseFloat(f);
  if(f>0&&cur.rMax==null)return;                       // no known ceiling -> no preset
  send({action:"burnSet",target:cur.rId,rate:f<=0?0:f*cur.rMax});});
on(R.btnActivate,function(){if(cur.rId)send({action:"activate",target:cur.rId});});
on(R.btnScram,function(){if(cur.rId)send({action:"scram",target:cur.rId});});
on(R.btnDump,function(){if(cur.tId)send({action:"dumpCycle",target:cur.tId});});
function toggleSafety(){send({action:"setSafety",enabled:!cur.safety});}
on(R.interlock,toggleSafety);on(R.btnSafety,toggleSafety);
// Emergency stop: one click, no confirm — an e-stop that needs two clicks is not an e-stop.
on(R.btnScramAll,function(){if(cur.anyReactor)send({action:"scramAll"});});

// ---------------------------------------------------------------- trend history
var hist={t:[],temp:[],prod:[]};
function record(temp,prod){hist.t.push(Date.now());hist.temp.push(num(temp));hist.prod.push(num(prod));
  while(hist.t.length>HIST_MAX){hist.t.shift();hist.temp.shift();hist.prod.shift();}}
function rateOf(a){if(!a||a.length<2)return null;var t=hist.t,e=a.length-1;
  while(e>0&&a[e]==null)e--;var s=Math.max(0,e-11);while(s<e&&a[s]==null)s++;
  if(s>=e)return null;var dt=(t[e]-t[s])/1000;return dt<=0?null:(a[e]-a[s])/dt;}
function arrow(r){return (r==null||Math.abs(r)<1e-6)?"":(r>0?"▲":"▼");}

// ---------------------------------------------------------------- shared setters
function setState(box,label,d,activeCls,activeTxt,idleTxt){
  if(!d){cls(box,"n-state warn");txt(label,"offline");return false;}
  var formed=!!(d.online&&!d.error&&d.formed);
  if(!d.online){cls(box,"n-state warn");txt(label,"offline");}
  else if(d.error){cls(box,"n-state warn");txt(label,"error");}
  else if(!d.formed){cls(box,"n-state warn");txt(label,"unformed");}
  else if(d.active){cls(box,"n-state "+activeCls);txt(label,activeTxt);}
  else{cls(box,"n-state idle");txt(label,idleTxt);}
  return formed;}
function setPh(phEl,on,text){cls(phEl,"ph"+(on?" on":""));if(on&&phEl)phEl.firstChild.textContent=text;}
function offTxt(d){return !d.online?"OFFLINE — CHUNK UNLOADED":(d.error?"READ ERROR":"MULTIBLOCK NOT FORMED");}
function setLevel(fillEl,pctEl,valEl,t,pctVal,mode,unit){
  var st=tk(t,"stored"),cp=tk(t,"capacity"),p=num(pctVal),sev="";
  if(p==null)p=pctOf(st,cp);
  width(fillEl,p);
  if(p!=null&&mode==="lo-bad")sev=p<25?"crit":(p<45?"warn":"");
  else if(p!=null&&mode==="hi-bad")sev=p>85?"crit":(p>65?"warn":"");
  cls(fillEl,"fill"+(mode?" "+mode:"")+(sev?" "+sev:""));
  txt(pctEl,pctTxt(p));cls(pctEl,"pv"+(sev?" "+sev:""));
  txt(valEl,(st==null&&cp==null)?D:(fmt(st)+"/"+fmt(cp)+(unit?" "+unit:"")));}
function setRunway(tileEl,valEl,sec){var c=durCls(sec);txt(valEl,dur(sec));cls(tileEl,"rw"+(c?" "+c:""));}
function setEta(labEl,valEl,empty,full,idleLab){
  if(empty!=null){txt(labEl,"Empty in");txt(valEl,dur(empty));cls(valEl,"v "+(durCls(empty)||"down"));}
  else if(full!=null){txt(labEl,"Full in");txt(valEl,dur(full));cls(valEl,"v up");}
  else{txt(labEl,idleLab);txt(valEl,D);cls(valEl,"v");}}
function etaCls(sec){var c=durCls(sec);return c?(c==="crit"?" crit":" warm"):"";}
function pick(list,selId){for(var i=0;i<list.length;i++)if(list[i].id===selId)return list[i];
  return list.length?list[0]:null;}
/* selector chips: rebuilt only when the roster changes (a per-poll rebuild blinks + eats clicks) */
function renderChips(box,list,selId,hot){
  if(!box)return;
  if(list.length<2){cls(box,"chips hide");box.__sig=null;return;}
  cls(box,"chips");
  var sig=list.map(function(d){return d.id+"~"+(d.label||"");}).join("|");
  if(box.__sig!==sig){box.__sig=sig;box.innerHTML="";box.__els={};
    list.forEach(function(d){var b=document.createElement("button");
      b.type="button";b.className="chip-b";b.setAttribute("data-id",d.id);
      b.appendChild(el("span","cl"));b.appendChild(el("span","ct",d.label||d.id));
      box.appendChild(b);box.__els[d.id]=b;});}
  list.forEach(function(d){var b=box.__els[d.id];if(!b)return;
    var st=(!d.online||d.error||!d.formed)?"st-warn":(d.active?hot:"");
    cls(b,"chip-b"+(st?" "+st:"")+(d.id===selId?" sel":""));});}

// ---------------------------------------------------------------- panels
function renderReactor(list,selId,runway){
  var sel=pick(list,selId),r=sel||{},i;
  renderChips(R.rChips,list,sel?sel.id:null,"st-hot");
  var formed=setState(R.rState,R.rStateTxt,sel,"active","active","scrammed");
  cur.rId=sel?sel.id:null;cur.rMax=num(r.maxBurnRate);cur.rFormed=formed;
  txt(R.rName,sel?(r.label||r.id):"NO REACTOR");
  setPh(R.rPh,!formed,sel?offTxt(r):"NO FISSION REACTOR ON NET");

  var temp=num(r.temperature);
  txt(R.rTemp,fmt(temp));
  if(R.rTemp)R.rTemp.style.color=tempColor(temp);
  var tr=rateOf(hist.temp);
  txt(R.rTrend,arrow(tr));cls(R.rTrend,"trend "+(tr==null?"":(tr>0?"warm":"up")));
  txt(R.rCrit,tempNote(temp));
  cls(R.rBurning,"pip"+(r.burning?" on":""));
  cls(R.nReactor,"node thermal"+(formed&&temp!=null&&temp>=CRIT_K?" crit":""));

  var burn=num(r.burnRate),limit=num(r.rateLimit),maxb=num(r.maxBurnRate);
  txt(R.rBurnRead,fmt(burn)+" / "+fmt(limit)+" / "+fmt(maxb));
  setRing(R.rArc,R.rRingV,(burn!=null&&maxb>0)?burn/maxb*100:null,(temp!=null&&temp>=CRIT_K)?RED:AMBER);

  setLevel(R.fFuel,R.pFuel,R.vFuel,r.fuel,r.fuelPct,"lo-bad","mB");
  setLevel(R.fCool,R.pCool,R.vCool,r.coolant,r.coolantPct,"lo-bad","mB");
  setLevel(R.fHeat,R.pHeat,R.vHeat,r.heatedCoolant,r.heatedPct,"hi-bad","mB");
  setLevel(R.fWaste,R.pWaste,R.vWaste,r.waste,r.wastePct,"hi-bad","mB");

  var dmg=num(r.damage),boil=num(r.boilEfficiency),plant=runway?num(runway.burnRate):null;
  txt(R.tDamage,dmg==null?D:fmt(dmg)+"%");
  cls(R.tDamage,"v"+(dmg==null?"":(dmg>10?" crit":(dmg>0?" warm":""))));
  txt(R.tBoil,boil==null?D:Math.round(boil*100)+"%");
  txt(R.tEnv,fmt(r.environmentalLoss));
  txt(R.tLimit,limit==null?D:fmt(limit)+" mB/t");
  txt(R.tMax,maxb==null?D:fmt(maxb)+" mB/t");
  txt(R.tPlantBurn,plant==null?D:fmt(plant)+" mB/t");
  txt(R.tOwnFuel,dur(r.fuelSeconds));cls(R.tOwnFuel,"v"+etaCls(r.fuelSeconds));
  txt(R.tOwnWaste,dur(r.wasteSeconds));cls(R.tOwnWaste,"v"+etaCls(r.wasteSeconds));

  setRunway(R.wTank&&R.wTank.parentNode,R.wTank,runway&&runway.tankSeconds);
  setRunway(R.wTotal&&R.wTotal.parentNode,R.wTotal,runway&&runway.totalSeconds);
  setRunway(R.wWaste&&R.wWaste.parentNode,R.wWaste,runway&&runway.wasteSeconds);

  dis(R.btnActivate,!formed||!!r.active);
  dis(R.btnScram,!formed||!r.active);
  if(R.btnScram)R.btnScram.classList.toggle("armed",!!(formed&&r.active));
  var step=R.rStep?R.rStep.children:[],pre=R.rPre?R.rPre.children:[];
  for(i=0;i<step.length;i++)dis(step[i],!formed);
  for(i=0;i<pre.length;i++){var f=parseFloat(pre[i].getAttribute("data-f"));
    dis(pre[i],!formed||(f>0&&cur.rMax==null));
    if(formed&&cur.rMax!=null)pre[i].title=fmt(f*cur.rMax)+" mB/t";}}

function renderTurbine(list,selId){
  var sel=pick(list,selId),t=sel||{};
  renderChips(R.tChips,list,sel?sel.id:null,"st-run");
  var formed=setState(R.tState,R.tStateTxt,sel,"run","running","idle");
  cur.tId=sel?sel.id:null;
  txt(R.tName,sel?(t.label||t.id):"NO TURBINE");
  setPh(R.tPh,!formed,sel?offTxt(t):"NO INDUSTRIAL TURBINE ON NET");

  var prod=num(t.production),maxp=num(t.maxProduction);
  txt(R.tProd,fmt(prod));
  var pr=rateOf(hist.prod);
  txt(R.tTrend,arrow(pr));cls(R.tTrend,"trend "+(pr==null?"":(pr>0?"up":"down")));
  txt(R.tProdMax,"of "+fmt(maxp)+" FE/t max");
  setRing(R.tArc,R.tRingV,(prod!=null&&maxp>0)?prod/maxp*100:null,TEAL);

  var es=tk(t.energy,"stored"),ec=tk(t.energy,"capacity"),ep=num(t.energyPct);
  if(ep==null)ep=pctOf(es,ec);
  txt(R.tBufPct,pctTxt(ep));width(R.fBuf,ep);
  cls(R.fBuf,"fill"+(ep==null?"":(ep>92?" warn":(ep<8?" crit":""))));
  txt(R.tBufAbs,(es==null&&ec==null)?D:fmt(es)+"/"+fmt(ec)+" FE");

  var net=num(t.net),draw=num(t.draw),idle=(net==null||Math.abs(net)<1e-6);
  if(idle){cls(R.tNetLine,"netline idle");txt(R.tNetTxt,net==null?"NO FLOW DATA":"IDLE");}
  else if(net>0){cls(R.tNetLine,"netline chg");txt(R.tNetTxt,"CHARGING "+signed(net)+" FE/t");}
  else{cls(R.tNetLine,"netline drw");txt(R.tNetTxt,"DRAWING "+signed(net)+" FE/t");}
  txt(R.tNetV,net==null?D:signed(net)+" FE/t");
  cls(R.tNetV,"v"+(idle?"":(net>0?" up":" down")));
  txt(R.tDraw,draw==null?D:fmt(draw)+" FE/t");
  setEta(R.tRunL,R.tRunV,num(t.secondsToEmpty),num(t.secondsToFull),"Buffer runway");

  setLevel(R.fSteam,R.pSteam,R.vSteam,t.steam,t.steamPct,"","mB");
  var flow=num(t.flowRate),maxf=num(t.maxFlow);
  var fp=(flow!=null&&maxf>0)?clamp(flow/maxf*100,0,100):null;
  width(R.fFlow,fp);txt(R.pFlow,pctTxt(fp));
  txt(R.vFlow,(flow==null&&maxf==null)?D:fmt(flow)+"/"+fmt(maxf)+" mB/t");

  txt(R.sBlades,fmtInt(t.blades));
  txt(R.sCoils,fmtInt(t.coils));
  txt(R.sCond,fmtInt(t.condensers));
  txt(R.sVents,fmtInt(t.vents));
  txt(R.sDisp,fmtInt(t.dispersers));
  var dm=(typeof t.dumping==="string")?t.dumping.replace(/_/g," "):null;
  txt(R.sDump,dm==null?D:dm);
  cls(R.sDump,"v"+(t.dumping==="DUMPING"?" crit":(t.dumping==="DUMPING_EXCESS"?" warm":"")));
  txt(R.btnDump,"DUMP: "+(dm==null?D:dm));
  dis(R.btnDump,!formed);}

function renderGrid(grid,reactors){
  var g=grid||{},i,hot=0;
  var prod=num(g.production),maxp=num(g.maxProduction),net=num(g.net);
  var bp=num(g.bufPct);if(bp==null)bp=pctOf(g.bufStored,g.bufCapacity);
  txt(R.gProd,fmt(prod));
  txt(R.gProdMax,maxp==null?"FE/t":"of "+fmt(maxp)+" FE/t");
  txt(R.gBuf,pctTxt(bp));
  txt(R.gBufAbs,(num(g.bufStored)==null&&num(g.bufCapacity)==null)?"FE":fmt(g.bufStored)+"/"+fmt(g.bufCapacity)+" FE");
  txt(R.gNet,signed(net));
  cls(R.gNet,"t-v"+((net==null||Math.abs(net)<1e-6)?"":(net>0?" up":" down")));
  txt(R.gDraw,fmt(g.draw));
  width(R.fGridBuf,bp);
  cls(R.fGridBuf,"fill"+(bp==null?"":(bp<8?" crit":(bp>92?" warn":""))));
  setEta(R.gRunL,R.gRunV,num(g.secondsToEmpty),num(g.secondsToFull),"Buffer runway");
  for(i=0;i<reactors.length;i++){var r=reactors[i];if(r.online&&!r.error&&r.formed&&r.active)hot++;}
  txt(R.gHot,hot+" / "+reactors.length);
  cls(R.gHot,"v"+(hot>0?" warm":""));
  if(prod>0){cls(R.gState,"n-state run");txt(R.gStateTxt,"generating");}
  else if(hot>0){cls(R.gState,"n-state active");txt(R.gStateTxt,"hot · no output");}
  else{cls(R.gState,"n-state idle");txt(R.gStateTxt,"standby");}
  return hot;}

function renderFuel(fuel,runway){
  var f=fuel||{},ok=!!f.ok;
  txt(R.fName,f.networkLabel||f.networkId||"RS NETWORK");
  if(!ok){cls(R.fState,"n-state warn");txt(R.fStateTxt,"no link");}
  else if(f.connected){cls(R.fState,"n-state run");txt(R.fStateTxt,"connected");}
  else{cls(R.fState,"n-state warn");txt(R.fStateTxt,"disconnected");}
  setPh(R.fPh,!ok,f.reason||"NO REFINED STORAGE NETWORK");

  var e=f.rsEnergy||{},ep=num(e.pct);
  if(ep==null)ep=pctOf(e.stored,e.capacity);
  width(R.fRsE,ep);
  cls(R.fRsE,"fill"+(ep==null?"":(ep<15?" crit":(ep<35?" warn":""))));
  txt(R.pRsE,pctTxt(ep));
  txt(R.vRsE,f.rsEnergy?(fmt(e.stored)+"/"+fmt(e.capacity)+" FE"):D);

  var res=num(f.reserveMb),rs=runway?num(runway.reserveSeconds):null;
  txt(R.fReserve,res==null?D:fmt(res)+" mB");
  txt(R.fReserveSec,rs==null?"RS reserve alone "+D:"RS alone "+dur(rs));
  var tm=num(f.tankMb),tc=num(f.tankCap);
  txt(R.fTank,tm==null?D:fmt(tm)+" mB");
  txt(R.fTankCap,"of "+fmt(tc)+" mB");}

function renderSafety(s){
  var L=(s&&s.limits)||{};
  s=s||{};
  cur.safety=!!s.enabled;
  txt(R.ilAt,s.at==null?D:"@"+s.at);
  if(s.tripped){cls(R.interlock,"interlock scram");txt(R.ilTxt,s.reason||"AUTO-SCRAM TRIPPED");}
  else if(s.enabled){cls(R.interlock,"interlock ok");txt(R.ilTxt,"Interlock armed · containment nominal");}
  else{cls(R.interlock,"interlock off");txt(R.ilTxt,"!! SAFETY INTERLOCK DISABLED !!");}
  function lim(v){return num(v)==null?D:Math.round(v)+"%";}
  txt(R.limCool,"COOL ≥ "+lim(L.coolantMinPct));
  txt(R.limDmg,"DMG ≤ "+lim(L.damageMaxPct));
  txt(R.limWaste,"WASTE ≤ "+lim(L.wasteMaxPct));
  txt(R.limTbuf,"TBUF ≤ "+lim(L.turbineEnergyMaxPct));
  txt(R.btnSafety,cur.safety?"DISARM INTERLOCK":"ARM INTERLOCK");}

/* alarms: same signature-rebuild + scroll-preserve discipline as the chips */
function renderAlarms(list){
  var box=R.alarms;
  if(!box)return;
  txt(R.alCount,String(list.length));
  var sig=list.map(function(a){return (a.level||"")+"~"+(a.text||"");}).join("|");
  if(box.__sig===sig)return;
  var keep=box.scrollTop;
  box.__sig=sig;box.innerHTML="";
  if(!list.length)box.appendChild(el("div","al none","NO ACTIVE ALARMS"));
  else list.forEach(function(a){box.appendChild(el("div","al "+(a.level==="crit"?"crit":"warn"),a.text||D));});
  box.scrollTop=keep;}

/* event log + strip recorder: index.html + style.css ship both panels; the page draws them */
function renderLog(list){var box=R.log;if(!box)return;
  var sig=list.map(function(l){return (l.ok?"1":"0")+"~"+(l.text||"");}).join("|");
  if(box.__sig===sig)return;var keep=box.scrollTop;box.__sig=sig;box.innerHTML="";
  if(!list.length)box.appendChild(el("div","ev","no events yet"));
  else list.forEach(function(l){box.appendChild(el("div","ev "+(l.ok?"ok":"err"),l.text||D));});
  box.scrollTop=keep;}
function trace(g,w,h,arr,col){var p=[],i,lo=0,hi=null;
  for(i=0;i<arr.length;i++)if(num(arr[i])!=null){p.push([i,arr[i]]);
    if(arr[i]<lo)lo=arr[i];if(hi==null||arr[i]>hi)hi=arr[i];}
  if(p.length<2)return false;
  if(hi===lo)hi=lo+1;
  var n=arr.length,mx=hi+((hi-lo)*.14||1),b=h-4;
  function X(k){return 3+(n<=1?0:k/(n-1)*(w-6));}
  function Y(v){return b-(v-lo)/(mx-lo)*(h-10);}
  function path(){g.beginPath();g.moveTo(X(p[0][0]),Y(p[0][1]));
    for(i=1;i<p.length;i++)g.lineTo(X(p[i][0]),Y(p[i][1]));}
  path();g.lineTo(X(p[p.length-1][0]),b);g.lineTo(X(p[0][0]),b);g.closePath();
  g.globalAlpha=.16;g.fillStyle=col;g.fill();g.globalAlpha=1;
  path();g.lineWidth=1.4;g.strokeStyle=col;g.lineJoin="round";g.stroke();return true;}
function drawChart(){var cv=R.chart;if(!cv)return;
  var w=cv.clientWidth||300,h=cv.clientHeight||60,d=window.devicePixelRatio||1,i;
  cv.width=Math.round(w*d);cv.height=Math.round(h*d);
  var g=cv.getContext("2d");if(!g)return;
  g.setTransform(d,0,0,d,0,0);g.clearRect(0,0,w,h);
  g.strokeStyle="rgba(239,230,210,.06)";g.lineWidth=1;
  for(i=1;i<4;i++){var y=Math.round(h*i/4)+.5;g.beginPath();g.moveTo(0,y);g.lineTo(w,y);g.stroke();}
  var a=trace(g,w,h,hist.temp,AMBER),z=trace(g,w,h,hist.prod,TEAL);
  if(!a&&!z){g.fillStyle="rgba(239,230,210,.35)";g.textAlign="center";
    g.font=Math.max(8,Math.round(h*.17))+"px monospace";g.fillText("acquiring…",w/2,h/2+4);}}

function renderStatus(last){
  if(!last||!last.text){cls(R.stLamp,"st-lamp");cls(R.stTxt,"st-txt");
    txt(R.stTxt,"Standing by — no operator action yet.");return;}
  cls(R.stLamp,"st-lamp "+(last.ok?"ok":"err"));
  cls(R.stTxt,"st-txt"+(last.ok?"":" err"));
  var head=last.action?String(last.action).toUpperCase():"";
  if(last.target)head+=" · "+last.target;
  txt(R.stTxt,head?(head+" — "+last.text):last.text);}

// ---------------------------------------------------------------- main render
var lastState=null,lastFrame=null,lastRecv=0;
function setLink(live){cls(R.link,"link"+(live?"":" down"));txt(R.linkTxt,live?"LINK LIVE":"NO SIGNAL");}

function render(state){
  var ok=!!(state&&state.ok);
  cls(R.offsheet,"offsheet"+(ok?"":" on"));
  if(!ok){txt(R.offReason,(state&&state.reason)||"No process signal from the control script.");
    setLink(false);return;}

  var reactors=state.reactors||[],turbines=state.turbines||[];
  cur.anyReactor=reactors.length>0;

  // trends advance only on a genuinely fresh server rebuild
  var frame=num(state.frame);
  if(frame==null||frame!==lastFrame){lastFrame=frame;
    var sel=pick(reactors,state.selReactor);
    record(sel?sel.temperature:null,state.grid?state.grid.production:null);}

  renderReactor(reactors,state.selReactor,state.runway);
  renderTurbine(turbines,state.selTurbine);
  var hot=renderGrid(state.grid,reactors);
  renderFuel(state.fuel,state.runway);
  renderSafety(state.safety);
  renderAlarms(state.alarms||[]);
  renderLog(state.log||[]);
  renderStatus(state.last);
  drawChart();

  txt(R.tbFrame,frame==null?D:String(frame));
  txt(R.devCount,reactors.length+"R · "+turbines.length+"T");
  txt(R.op,(mc.player||D)+(mc.display?" · "+String(mc.display).replace(/^Screen:\s*/,""):""));
  dis(R.btnScramAll,!cur.anyReactor);
  if(R.btnScramAll)R.btnScramAll.classList.toggle("armed",hot>0);
  txt(R.mSub,!cur.anyReactor?"no reactors":(hot>0?hot+" unit"+(hot===1?"":"s")+" hot":"all cold"));
  setLink(true);}

// ---------------------------------------------------------------- bridge + timers
mc.onState=function(state){lastRecv=Date.now();lastState=state;
  try{render(state);}catch(err){                       // one bad field must never kill the loop
    if(R.stTxt){R.stTxt.className="st-txt err";R.stTxt.textContent="render error: "+err;}}};

function two(n){return (n<10?"0":"")+n;}
setInterval(function(){var d=new Date();
  txt(R.clock,two(d.getHours())+":"+two(d.getMinutes())+":"+two(d.getSeconds()));
  if(lastRecv&&(Date.now()-lastRecv)>STALE_MS)setLink(false);},1000);

send({action:"poll"});
setInterval(function(){send({action:"poll"});},POLL_MS);

var rt=null;
window.addEventListener("resize",function(){if(rt)clearTimeout(rt);
  rt=setTimeout(function(){rt=null;if(lastState)mc.onState(lastState);},150);});
})();
