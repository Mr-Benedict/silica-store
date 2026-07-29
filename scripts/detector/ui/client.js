/* PERIMETER WATCH BOARD — page half. Server-authoritative: this page decides nothing, it only
   *requests* (mc.send) and renders what came back (mc.onState); every field may be null.
   Rendering is INCREMENTAL — the shell is static HTML, so a 1s push only patches text/class/width on
   cached refs; the contact rows are a reused pool (rebuilt only when the ROW COUNT changes) and the
   annunciator lists rebuild only when their signature changes — both keep scrollTop, because a naive
   innerHTML rebuild throws the operator back to the top of the list once a second.
   The radar is a canvas redrawn from its client rect each frame.
   MCEF input: plain clicks only — no drag, no wheel, no hover-only, no native double-click. */
(function(){
"use strict";
var mc=window.mc||{send:function(){},onState:null,player:"",display:""};
var POLL_MS=1000,STALE_MS=3600;                /* STALE_MS: no push for this long -> link lamp red */
var AMBER="#f4b63b",RED="#ff5b49",TEAL="#3fe0c2",CYAN="#84cdff";
var D="—";                                     /* the "no reading" placeholder */
/* one row per unit state (entrypoint deriveState): lamp class, header text, chip class */
var ST={clear:["run","clear","st-run"],contact:["warn","contact","st-warn"],
        alert:["hot","ALERT","st-hot"],blind:["warn","blind","st-warn"],
        error:["hot","error","st-hot"],offline:["warn","offline","st-warn"]};
var FLABEL={mob:"Mob",player:"Player",friendly:"Friendly",enemy:"Enemy"};
/* Ring stepper sizes. MAX_RANGE is 24 and a wall screen is tap-only, so stepping 1..24 by ones is 23
   taps; the middle cell of the stepper cycles the step instead. The range slider next door does not
   need this — it has a tappable track for the big jumps. */
var STEPS=[1,2,4];
/* How many authoritative frames a pending stepper value may disagree with the server before the
   server wins. See `pend` below: the config/alertDist actions are ABSOLUTE, not deltas, so a second
   tap that lands before the echo would otherwise re-send the same number. */
var PEND_FRAMES=2;

// ---------------------------------------------------------------- helpers
function num(v){return (typeof v==="number"&&isFinite(v))?v:null;}
function clamp(v,lo,hi){return v<lo?lo:(v>hi?hi:v);}
function int(n){n=num(n);return n==null?D:String(Math.round(n));}
/* distances are 1 d.p. off the device; keep them that way so the sheet and the log agree */
function fmtDist(d){d=num(d);return d==null?D:((Math.round(d*10)/10)+"m");}
/* the contact's WORLD position — the number you actually walk to. The radar already carries the
   offsets (dx/dz) as a picture, so the list spends its width on coordinates rather than repeating
   them; a record with no pos (never seen from a real scan) degrades to the placeholder. */
function worldPos(e){var x=num(e.x),y=num(e.y),z=num(e.z);
  return (x==null||y==null||z==null)?D:(x+" "+y+" "+z);}
/* "minecraft:zombie" -> "Zombie"; a modded id keeps its namespace so two mods' Slimes stay distinct.
   A PLAYER record carries the player's OWN NAME, not an id — and the kind is not always beside it
   (the alert's `name`, a unit's `nearestName`), so a bare string already carrying a capital is left
   verbatim: "Mr_Benedict" is a player, not an entity id, and must not become "Mr Benedict". */
function pretty(name,kind){
  var s=String(name==null?"?":name);
  if(kind==="player")return s;
  var i=s.indexOf(":");
  if(i<0&&/[A-Z]/.test(s))return s;
  var ns=i>=0?s.slice(0,i):"",path=i>=0?s.slice(i+1):s;
  path=path.replace(/_/g," ").replace(/\b\w/g,function(c){return c.toUpperCase();});
  return (ns&&ns!=="minecraft")?(ns+":"+path):path;}
/* the three-way class split the whole sheet uses: a player is never flagged hostile */
function kindOf(e){return e.kind==="player"?"ply":(e.hostile?"hos":"fri");}
/* set equality for the four filter keys — order carries no meaning on either side */
function sameKeys(a,b){return a.length===b.length&&a.slice(0).sort().join(",")===b.slice(0).sort().join(",");}

function el(tag,c,t){var x=document.createElement(tag);if(c)x.className=c;if(t!=null)x.textContent=t;return x;}
function txt(n,s){if(n&&n.textContent!==s)n.textContent=s;}
function cls(n,s){if(n&&n.className!==s)n.className=s;}
function dis(n,b){if(n)n.disabled=!!b;}
function send(m){try{mc.send(JSON.stringify(m));}catch(e){}}

// ---------------------------------------------------------------- refs
var R={};
("offsheet offReason op devCount hdrContacts link linkTxt "+
 "nWatch uName uState uStateTxt uChips uPh radarMeta radarC "+
 "sTotal sHostile sFriendly sPlayers tNearH tNearA tRange tOut "+
 "tFilter filters rMinus rTrack rFill rKnob rPlus rVal "+
 "nList cState cStateTxt cPh rows cMore cUp cPos cDn "+
 "nAlert aState aStateTxt aBig aPip aSub aRing aRingV dVal dMinus dLabel dPlus "+
 "btnTrip btnSide btnBcast tArmed tLine tHold tInRing tFleetHos tHot faultLine "+
 "stLamp stTxt tbFrame clock alCount alPos alarms alUp alDn evCount evPos log evUp evDn "+
 "btnArm mSub btnClearLog").split(" ").forEach(function(k){R[k]=document.getElementById(k);});
R.aArc=R.aRing?R.aRing.querySelector(".rv"):null;
R.mBig=R.btnArm?R.btnArm.querySelector(".m-big"):null;
var ARC=251.3;

// ---------------------------------------------------------------- client-side session
/* SELECTION IS CLIENT-SIDE ON PURPOSE — the server deliberately publishes no `sel`, so two people
   watching the same board can look at different gates. The cost is that this page owns the fallback
   when the selected unit leaves the roster (chunk unloaded, block broken): pick() drops back to the
   first unit rather than rendering a blank card. */
var cur={sel:null,live:false,max:24,range:null,filter:[],step:0,
         armed:false,bcast:false,side:null,sides:[],trip:null,trips:[],dist:null,any:false};
/* The optimistic half of the steppers. `config` and `alertDist` both take an ABSOLUTE value, so two
   taps inside one server round-trip would compute the second from the same stale base and lose a
   step. A pend holds what we last asked for; it is dropped the moment the server agrees, and dropped
   anyway after PEND_FRAMES authoritative frames — authority always wins, it just does not win before
   the operator's second tap lands. */
var pend={unit:null,range:null,filter:null,dist:null,frame:-1,dframe:-1};

function attr(ev,name){var n=ev.target;
  while(n&&n!==ev.currentTarget){if(n.getAttribute&&n.getAttribute(name)!=null)return n.getAttribute(name);n=n.parentNode;}
  return null;}
function on(node,fn){if(node)node.addEventListener("click",fn);}
function repaint(){if(lastState)try{render(lastState);}catch(e){}}

/* the unit a config control addresses is always the SELECTED one — the server re-resolves and
   re-validates it live anyway, and refuses anything that is not an online detector */
function sendConfig(patch){
  if(!cur.sel||!cur.live)return;
  patch.action="config";patch.unit=cur.sel;
  send(patch);}

on(R.uChips,function(ev){var v=attr(ev,"data-id");
  if(!v||v===cur.sel)return;
  cur.sel=v;pend.unit=null;pend.range=null;pend.filter=null;   /* a pend belongs to one unit only */
  repaint();});

on(R.filters,function(ev){var k=attr(ev,"data-f");
  if(!k||!cur.live)return;
  var keys=[],i,held=cur.filter,seen=false;
  for(i=0;i<held.length;i++){if(held[i]===k){seen=true;}else{keys.push(held[i]);}}
  if(!seen)keys.push(k);
  pend.unit=cur.sel;pend.filter=keys;pend.frame=lastFrame;
  cur.filter=keys;paintFilters();                              /* echo the tap; the server confirms */
  sendConfig({filter:keys});});

function setRange(v){
  v=clamp(Math.round(v),1,cur.max);
  if(!cur.live||v===cur.range)return;
  pend.unit=cur.sel;pend.range=v;pend.frame=lastFrame;
  cur.range=v;paintRange();
  sendConfig({range:v});}
on(R.rMinus,function(){setRange((cur.range==null?1:cur.range)-1);});
on(R.rPlus,function(){setRange((cur.range==null?0:cur.range)+1);});
/* Tapping the track is a shortcut, never the only way in: every value is also reachable from the
   -/+ steppers, because MCEF forwards a tap reliably and a drag not at all (there is no thumb to
   grab anywhere on this sheet). */
on(R.rTrack,function(ev){
  var r=R.rTrack.getBoundingClientRect();
  var frac=r.width>0?(ev.clientX-r.left)/r.width:0;
  setRange(1+clamp(frac,0,1)*(cur.max-1));});

function setDist(v){
  v=clamp(Math.round(v),1,cur.max);
  if(v===cur.dist)return;
  pend.dist=v;pend.dframe=lastFrame;
  cur.dist=v;paintAlertDist();
  send({action:"alertDist",dist:v});}
on(R.dMinus,function(){setDist((cur.dist==null?1:cur.dist)-STEPS[cur.step]);});
on(R.dPlus,function(){setDist((cur.dist==null?0:cur.dist)+STEPS[cur.step]);});
on(R.dLabel,function(){cur.step=(cur.step+1)%STEPS.length;paintAlertDist();});

/* the three cycling switches: each walks the roster the SERVER published, so the page can never
   offer a value the server would reject */
function cycle(list,held){var i=list.indexOf(held);return list[(i<0?0:i+1)%list.length];}
on(R.btnTrip,function(){if(cur.trips.length)send({action:"alertTrip",mode:cycle(cur.trips,cur.trip)});});
on(R.btnSide,function(){if(cur.sides.length)send({action:"alertSide",side:cycle(cur.sides,cur.side)});});
on(R.btnBcast,function(){send({action:"armBroadcast",enabled:!cur.bcast});});
/* the master trip: one click, no confirm — an ARM that needs two clicks is not an ARM */
on(R.btnArm,function(){send({action:"arm",enabled:!cur.armed});});
on(R.btnClearLog,function(){send({action:"clearLog"});});

// ---------------------------------------------------------------- canvas plumbing
/* Size from the CLIENT RECT (so the plot follows the rem scaling), honour devicePixelRatio, and bail
   out on a zero/absurd rect instead of throwing. */
function plotCtx(cv){
  if(!cv)return null;
  var w=cv.clientWidth||0,h=cv.clientHeight||0;
  if(w<8||h<8)return null;
  var d=window.devicePixelRatio||1;
  var pw=Math.round(w*d),ph=Math.round(h*d);
  if(!(pw>0&&ph>0)||pw>8192||ph>8192)return null;
  if(cv.width!==pw)cv.width=pw;
  if(cv.height!==ph)cv.height=ph;
  var g=cv.getContext("2d");if(!g)return null;
  g.setTransform(d,0,0,d,0,0);g.clearRect(0,0,w,h);
  return {g:g,w:w,h:h};}
function plotEmpty(c,msg){var g=c.g;
  g.fillStyle="rgba(239,230,210,.3)";g.textAlign="center";
  g.font=Math.max(8,Math.round(c.h*.11))+"px monospace";g.fillText(msg,c.w/2,c.h/2+3);}

/* THE RADAR — a detector-centred XZ plot, carried over from the E3P1 app because it is the one thing
   only this device can draw: every record ships `dx`/`dz`, the offset from the block itself, so the
   page needs no world position to place a blip. The OUTER ring is the unit's configured range, three
   evenly spaced range rings inside it, and — while the alert is live — a dashed ALERT ring at the
   trip distance. Blips are coloured by class and clamped to the rim, because the detector scans a
   BOX: a corner contact is legitimately farther than the range and would otherwise plot outside the
   dish. `dist` is 3-D while this plot is the XZ projection, so a mob directly overhead sits at the
   centre with a non-zero distance — the list column is what disambiguates it. */
function drawRadar(u,alert,live){
  var c=plotCtx(R.radarC);if(!c)return;
  var g=c.g,W=c.w,H=c.h,cx=W/2,cy=H/2+Math.max(2,H*.02);
  if(!live){plotEmpty(c,u?"no signal":"no detector");return;}
  var range=num(u.range);if(range==null||range<1)range=cur.max;
  var pad=Math.max(10,Math.min(W,H)*.09);
  var rad=Math.max(6,Math.min(W/2,H/2)-pad);
  var scale=rad/range;                                   /* blocks -> px */
  var i;

  g.strokeStyle="rgba(239,230,210,.13)";g.lineWidth=1;
  for(i=1;i<=3;i++){g.beginPath();g.arc(cx,cy,rad*i/3,0,6.284);g.stroke();}
  g.beginPath();
  g.moveTo(cx,cy-rad);g.lineTo(cx,cy+rad);g.moveTo(cx-rad,cy);g.lineTo(cx+rad,cy);g.stroke();

  /* the alert ring. Drawn ONLY while the alert can actually act (armed, or armed to broadcast) —
     an unarmed threshold is a number, not a boundary. When the ring is wider than the unit can see
     it collapses onto the rim: everything this detector could ever report is already inside it. */
  /* cur.dist, not alert.dist: a stepper tap still in flight must move the ring and the readout
     together, or the two disagree for the round trip */
  var aLive=!!(alert&&(alert.armed||alert.broadcast)),aDist=num(cur.dist);
  if(aLive&&aDist!=null){
    var ar=Math.min(rad,aDist*scale),hot=!!(alert.tripped||alert.held);
    g.save();
    g.setLineDash([Math.max(3,rad*.07),Math.max(3,rad*.05)]);
    g.strokeStyle=hot?RED:"rgba(255,91,73,.5)";g.lineWidth=hot?1.8:1.2;
    g.beginPath();g.arc(cx,cy,ar,0,6.284);g.stroke();
    g.restore();}

  /* the detector itself, dead centre */
  g.fillStyle=AMBER;g.shadowColor=AMBER;g.shadowBlur=7;
  g.beginPath();g.arc(cx,cy,2.6,0,6.284);g.fill();g.shadowBlur=0;

  var list=u.entities||[];
  for(i=0;i<list.length;i++){
    var e=list[i],px=cx+(num(e.dx)||0)*scale,py=cy+(num(e.dz)||0)*scale;  /* world +Z -> screen down */
    var off=Math.sqrt((px-cx)*(px-cx)+(py-cy)*(py-cy));
    if(off>rad&&off>0){px=cx+(px-cx)*rad/off;py=cy+(py-cy)*rad/off;}      /* box corners -> the rim */
    var col=e.kind==="player"?CYAN:(e.hostile?RED:TEAL);
    g.fillStyle=col;g.shadowColor=col;g.shadowBlur=7;
    g.beginPath();g.arc(px,py,e.hostile?3.4:2.9,0,6.284);g.fill();g.shadowBlur=0;}

  /* footer marks: north is -Z in Minecraft, so screen-up is north */
  var fs=Math.max(7,Math.round(H*.085));
  g.font=fs+"px monospace";g.fillStyle="rgba(239,230,210,.42)";
  g.textAlign="left";g.fillText("N↑",4,H-4);
  g.textAlign="right";g.fillText(Math.round(range)+" m",W-4,H-4);}

// ---------------------------------------------------------------- WATCH card
function pick(list,selId){var i;for(i=0;i<list.length;i++)if(list[i].id===selId)return list[i];
  return list.length?list[0]:null;}
function stRow(u){return ST[(u&&u.state)||"offline"]||ST.offline;}

/* selector chips: rebuilt only when the ROSTER changes (a per-push rebuild blinks and eats clicks) */
function renderChips(list,selId){
  var box=R.uChips;if(!box)return;
  if(list.length<2){cls(box,"chips hide");box.__sig=null;return;}
  cls(box,"chips");
  var sig=list.map(function(u){return u.id+"~"+(u.label||"");}).join("|");
  if(box.__sig!==sig){box.__sig=sig;box.innerHTML="";box.__els={};
    list.forEach(function(u){var b=document.createElement("button");
      b.type="button";b.className="chip-b";b.setAttribute("data-id",u.id);
      b.appendChild(el("span","cl"));b.appendChild(el("span","ct",u.label||u.id));
      box.appendChild(b);box.__els[u.id]=b;});}
  list.forEach(function(u){var b=box.__els[u.id];if(!b)return;
    var s=stRow(u)[2];
    cls(b,"chip-b"+(s?" "+s:"")+(u.id===selId?" sel":""));});}

function paintFilters(){
  var fs=R.filters?R.filters.children:[],i;
  for(i=0;i<fs.length;i++){
    var k=fs[i].getAttribute("data-f");
    cls(fs[i],"fg"+(cur.filter.indexOf(k)>=0?" on":""));
    dis(fs[i],!cur.live);}
  txt(R.tFilter,cur.filter.length?cur.filter.map(function(k){return FLABEL[k]||k;}).join(" · "):"NONE");
  cls(R.tFilter,cur.live&&!cur.filter.length?"blindtag":"");}

function paintRange(){
  var v=cur.range;
  txt(R.rVal,v==null?D:String(v));
  var frac=(v==null||cur.max<=1)?0:clamp((v-1)/(cur.max-1),0,1);
  if(R.rFill)R.rFill.style.width=(frac*100)+"%";
  if(R.rKnob)R.rKnob.style.left=(frac*100)+"%";
  dis(R.rMinus,!cur.live||v==null||v<=1);
  dis(R.rPlus,!cur.live||v==null||v>=cur.max);}

/* the kind of the record a unit's `nearestName` came from — the list is sorted nearest-first, so it is
   almost always entities[0], but match by name rather than assume it (a truncated list, or a record
   whose dist is null, moves the index) */
function kindByName(u,name){
  var list=(u&&u.entities)||[],i;
  for(i=0;i<list.length;i++)if(list[i].name===name)return list[i].kind;
  return null;}

function renderUnit(list){
  var sel=pick(list,cur.sel),u=sel||{};
  cur.sel=sel?sel.id:null;
  renderChips(list,cur.sel);
  var live=!!(sel&&u.online&&!u.error);
  cur.live=live;
  var row=stRow(sel);

  txt(R.uName,sel?(u.label||u.id):"NO DETECTOR");
  cls(R.uState,"n-state "+row[0]);txt(R.uStateTxt,sel?row[1]:D);
  cls(R.nWatch,"node watch"+(u.state==="alert"||u.state==="error"?" crit":""));
  var offTxt=!sel?"NO DETECTOR ON NET":
    (u.notFound?"NOT ON THIS NETWORK":(!u.online?"OFFLINE — CHUNK UNLOADED":"SCAN READ FAILED"));
  cls(R.uPh,"ph"+(live?"":" on"));
  if(!live&&R.uPh&&R.uPh.firstChild)R.uPh.firstChild.textContent=offTxt;

  /* the detector's OWN config, authoritative — unless a stepper tap is still in flight for THIS
     unit and the server has not had PEND_FRAMES to answer it */
  var holdCfg=(pend.unit!=null&&pend.unit===cur.sel&&lastFrame!=null&&lastFrame-pend.frame<PEND_FRAMES);
  var srvRange=num(u.range),srvFilter=(u.filter||[]).slice(0);
  if(holdCfg&&pend.range!=null&&srvRange!==pend.range){cur.range=pend.range;}
  else{cur.range=srvRange;pend.range=null;}
  /* compared as a SET: the block is free to hand its filter back in its own order, and an order-only
     difference is agreement, not a pending change */
  if(holdCfg&&pend.filter!=null&&!sameKeys(pend.filter,srvFilter)){cur.filter=pend.filter.slice(0);}
  else{cur.filter=srvFilter;pend.filter=null;}
  paintFilters();paintRange();

  txt(R.sTotal,live?int(u.total):D);
  txt(R.sHostile,live?int(u.hostile):D);
  txt(R.sFriendly,live?int(u.friendly):D);
  txt(R.sPlayers,live?int(u.players):D);

  txt(R.tNearH,live?fmtDist(u.nearestHostile):D);
  cls(R.tNearH,"v"+(num(u.nearestHostile)!=null?" crit":""));
  txt(R.tNearA,live&&num(u.nearestAny)!=null
    ?(fmtDist(u.nearestAny)+" "+pretty(u.nearestName,kindByName(u,u.nearestName))):(live?"clear":D));
  txt(R.tRange,srvRange==null?D:(srvRange+" blk"));
  /* DERIVED, and labelled so in the HTML: no verb reports the block's redstone output, so this
     mirrors the block's own rule (15 while the filtered scan is non-empty, else 0). */
  txt(R.tOut,live?int(u.redstone):D);
  cls(R.tOut,"v"+(live&&num(u.redstone)>0?" up":""));

  txt(R.radarMeta,!live?"no sweep":
    ("range "+(srvRange==null?D:srvRange+"m")+" · "+u.total+" seen"
      +(num(u.hidden)>0?(" · "+u.hidden+" hidden"):"")));
  drawRadar(sel,lastAlert,live);
  return sel;}

// ---------------------------------------------------------------- CONTACTS card
/* The rows are a REUSED POOL, not a signature rebuild like the annunciator lists below. Every record
   moves every sweep, so a content signature would never match and the list would innerHTML-rebuild
   once a second — which is exactly how the operator's scroll position gets thrown away. Instead the
   pool is rebuilt only when the row COUNT changes, and the cells are patched in place. scrollTop is
   preserved across a rebuild and reset ONLY when the selected unit changes (a different unit is a
   different list, and keeping the old offset would land you in the middle of nowhere). */
function renderRows(sel,live){
  var box=R.rows;if(!box)return;
  var list=(live&&sel&&sel.entities)?sel.entities:[],i;
  if(box.__n!==list.length){
    var keep=box.scrollTop;
    box.__n=list.length;box.innerHTML="";box.__pool=[];
    for(i=0;i<list.length;i++){
      var r=el("div","crow"),nm=el("span","nm"),dot=el("span","cdot"),t=el("span","cn");
      nm.appendChild(dot);nm.appendChild(t);r.appendChild(nm);
      var ps=el("span","c"),ds=el("span","c");
      r.appendChild(ps);r.appendChild(ds);
      box.appendChild(r);box.__pool.push({r:r,t:t,ps:ps,ds:ds});}
    box.scrollTop=keep;}
  if(box.__view!==cur.sel){box.scrollTop=0;box.__view=cur.sel;}
  for(i=0;i<list.length;i++){
    var e=list[i],cell=box.__pool[i];if(!cell)break;
    cls(cell.r,"crow "+kindOf(e));
    txt(cell.t,pretty(e.name,e.kind));
    txt(cell.ps,worldPos(e));txt(cell.ds,fmtDist(e.dist));}

  var hidden=num(sel&&sel.hidden)||0;
  txt(R.cMore,hidden>0?("+"+hidden+" farther contact"+(hidden===1?"":"s")+" not shown"):"");
  cls(R.cMore,"more"+(hidden>0?" on":""));
  cls(R.cPh,"ph"+((live&&list.length)?"":" on"));
  if(R.cPh&&R.cPh.firstChild)R.cPh.firstChild.textContent=
    !live?"NO SIGNAL":(sel&&sel.blind?"FILTER EMPTY — BLIND":"NOTHING IN RANGE");

  var n=list.length;
  cls(R.cState,"n-state "+(!live?"warn":(n?(num(sel.hostile)>0?"hot":"warn"):"run")));
  txt(R.cStateTxt,!live?"no signal":(n?(n+" in range"):"clear"));
  syncRows();}

// ---------------------------------------------------------------- ALERT card
function paintAlertDist(){
  txt(R.dVal,cur.dist==null?D:(cur.dist+" m"));
  txt(R.aRingV,cur.dist==null?D:String(cur.dist));
  txt(R.dLabel,"±"+STEPS[cur.step]+" BLK");
  if(R.aArc){var f=(cur.dist==null||cur.max<=0)?0:clamp(cur.dist/cur.max,0,1);
    R.aArc.style.strokeDashoffset=(ARC*(1-f)).toFixed(1);}
  dis(R.dMinus,cur.dist!=null&&cur.dist<=1);
  dis(R.dPlus,cur.dist!=null&&cur.dist>=cur.max);}

function renderAlert(a,fleet){
  a=a||{};
  cur.armed=!!a.armed;cur.bcast=!!a.broadcast;
  cur.side=a.side||null;cur.sides=a.sides||[];
  cur.trip=a.trip||null;cur.trips=a.trips||[];

  /* same pend discipline as the range stepper — the alertDist action is absolute too */
  var srv=num(a.dist);
  if(pend.dist!=null&&lastFrame!=null&&lastFrame-pend.dframe<PEND_FRAMES&&srv!==pend.dist){cur.dist=pend.dist;}
  else{cur.dist=srv;pend.dist=null;}
  paintAlertDist();

  var trip=!!a.tripped,held=!!a.held;
  cls(R.nAlert,"node alr"+(held?" crit":""));
  cls(R.aState,"n-state "+(held?"hot":(cur.armed?"run":(cur.bcast?"warn":"idle"))));
  txt(R.aStateTxt,held?(trip?"tripped":"holding"):(cur.armed?"armed":(cur.bcast?"bcast only":"disarmed")));
  txt(R.aBig,trip?"TRIPPED":(held?"HOLDING":"CLEAR"));
  cls(R.aBig,trip?"hot":(held?"warm":""));
  cls(R.aPip,"pip"+(held&&!trip?" on":""));
  txt(R.aSub,num(a.count)>0
    ?(a.count+" in ring · "+pretty(a.name,null)+" "+fmtDist(a.nearest)+(a.unit?(" @ "+a.unit):""))
    :"ring clear");

  txt(R.btnTrip,"WATCH: "+(cur.trip?cur.trip.toUpperCase():D));
  txt(R.btnSide,"FACE: "+(cur.side?cur.side.toUpperCase():D));
  txt(R.btnBcast,"BCAST: "+(cur.bcast?"ON":"OFF"));
  if(R.btnBcast)R.btnBcast.classList.toggle("on",cur.bcast);
  dis(R.btnTrip,!cur.trips.length);dis(R.btnSide,!cur.sides.length);

  txt(R.tArmed,cur.armed?"ARMED":"disarmed");
  cls(R.tArmed,"v"+(cur.armed?" warm":""));
  txt(R.tLine,int(a.output)+" @ "+(cur.side?cur.side.toUpperCase():D));
  cls(R.tLine,"v"+(num(a.output)>0?" crit":""));
  txt(R.tHold,num(a.holdSec)==null?D:(a.holdSec+" s"));
  txt(R.tInRing,int(a.count));
  cls(R.tInRing,"v"+(num(a.count)>0?" crit":""));
  var f=fleet||{};
  txt(R.tFleetHos,int(f.hostile));
  cls(R.tFleetHos,"v"+(num(f.hostile)>0?" crit":""));
  txt(R.tHot,int(f.hot)+" / "+int(f.count));

  /* a redstone door that refuses is an ALARM, not an exception — the board must keep watching */
  txt(R.faultLine,a.fault?("redstone "+(cur.side||"?")+" refused — "+a.fault):"");
  cls(R.faultLine,"faultline"+(a.fault?" on":""));

  if(R.mBig)txt(R.mBig,cur.armed?"DISARM":"ARM");
  if(R.btnArm)R.btnArm.classList.toggle("armed",cur.armed&&held);
  txt(R.mSub,!cur.armed?(cur.bcast?"bcast only":"line cold")
    :(held?("LINE HOT · "+(cur.side||"?")):("watching "+(cur.trip||"?"))));}

// ---------------------------------------------------------------- annunciator foot
/* Paging for the three scrolling lists. Entries wrap, so most of a busy list sits off-screen — and
   neither a wall screen (tap-only) nor MCEF (no wheel event forwarded) can scroll it. So: two
   explicit page buttons per list, dimmed at each end, plus a "first visible / total" position mark.
   Returns the sync fn the renderer calls after every update; it never touches scrollTop itself. */
function pager(box,up,dn,pos){
  function sync(){
    if(!box)return;
    var h=box.clientHeight,max=Math.max(0,box.scrollHeight-h),t=box.scrollTop;
    dis(up,t<=1);dis(dn,t>=max-1);
    var n=box.__n||0,kids=box.children,first=1,i;
    for(i=0;i<kids.length;i++)if(kids[i].offsetTop+kids[i].offsetHeight>t+1){first=i+1;break;}
    txt(pos,n?(first+"/"+n):"0/0");}
  function page(dir){
    if(!box)return;
    var h=box.clientHeight;
    box.scrollTop=clamp(box.scrollTop+dir*Math.max(24,h*.85),0,Math.max(0,box.scrollHeight-h));
    sync();}
  on(up,function(){page(-1);});on(dn,function(){page(1);});
  return sync;}
var syncRows=pager(R.rows,R.cUp,R.cDn,R.cPos),
    syncAl=pager(R.alarms,R.alUp,R.alDn,R.alPos),
    syncEv=pager(R.log,R.evUp,R.evDn,R.evPos);

/* alarms + log: signature rebuild + scroll-preserve, the same discipline as the chips. The pager is
   re-synced on EVERY frame, not just a rebuild — a resize changes what fits without changing content. */
function renderAlarms(list){
  var box=R.alarms;if(!box)return;
  txt(R.alCount,String(list.length));
  var sig=list.map(function(a){return (a.level||"")+"~"+(a.unit||"")+"~"+(a.text||"");}).join("|");
  if(box.__sig!==sig){
    var keep=box.scrollTop;box.__sig=sig;box.__n=list.length;box.innerHTML="";
    if(!list.length)box.appendChild(el("div","al none","NO ACTIVE ALARMS"));
    else list.forEach(function(a){
      var lv=a.level==="crit"?"crit":(a.level==="none"?"none":"warn");
      var d=el("div","al "+lv);
      if(a.unit)d.appendChild(el("b",null,a.unit+" "));
      d.appendChild(el("span",null,a.text||D));
      box.appendChild(d);});
    box.scrollTop=keep;}
  syncAl();}
function renderLog(list){
  var box=R.log;if(!box)return;
  txt(R.evCount,String(list.length));
  var sig=list.map(function(l){return (l.ok?"1":"0")+"~"+(l.text||"");}).join("|");
  if(box.__sig!==sig){
    var keep=box.scrollTop;box.__sig=sig;box.__n=list.length;box.innerHTML="";
    if(!list.length)box.appendChild(el("div","ev","no events yet"));
    else list.forEach(function(l){box.appendChild(el("div","ev "+(l.ok?"ok":"err"),l.text||D));});
    box.scrollTop=keep;}
  syncEv();}

function renderStatus(last){
  if(!last||!last.text){cls(R.stLamp,"st-lamp");cls(R.stTxt,"st-txt");
    txt(R.stTxt,"Standing by — no operator action yet.");return;}
  cls(R.stLamp,"st-lamp "+(last.ok?"ok":"err"));
  cls(R.stTxt,"st-txt"+(last.ok?"":" err"));
  var head=last.action?String(last.action).toUpperCase():"";
  if(last.target)head+=" · "+last.target;
  txt(R.stTxt,head?(head+" — "+last.text):last.text);}

// ---------------------------------------------------------------- main render
var lastState=null,lastFrame=null,lastAlert=null,lastRecv=0;
function setLink(live){cls(R.link,"link"+(live?"":" down"));txt(R.linkTxt,live?"LINK LIVE":"NO SIGNAL");}

function render(state){
  var ok=!!(state&&state.ok);
  cls(R.offsheet,"offsheet"+(ok?"":" on"));
  if(!ok){txt(R.offReason,(state&&state.reason)||"No detector signal from the watch script.");
    setLink(false);return;}

  var units=state.units||[],fleet=state.fleet||{};
  cur.any=units.length>0;
  cur.max=num(state.maxRange)||24;
  lastFrame=num(state.frame);
  lastAlert=state.alert||null;

  renderAlert(state.alert,fleet);      /* before the watch card: the radar draws the alert ring */
  var sel=renderUnit(units);
  renderRows(sel,cur.live);
  renderAlarms(state.alarms||[]);
  renderLog(state.log||[]);
  renderStatus(state.last);

  txt(R.tbFrame,lastFrame==null?D:String(lastFrame));
  txt(R.devCount,units.length+(num(fleet.offline)>0?(" · "+fleet.offline+" OFF"):""));
  txt(R.hdrContacts,int(fleet.total)+(num(fleet.hostile)>0?(" / "+fleet.hostile+" HOS"):""));
  txt(R.op,(mc.player||D)+(mc.display?" · "+String(mc.display).replace(/^Screen:\s*/,""):""));
  setLink(true);}

// ---------------------------------------------------------------- bridge + timers
mc.onState=function(state){lastRecv=Date.now();lastState=state;
  try{render(state);}catch(err){                       /* one bad field must never kill the loop */
    if(R.stTxt){R.stTxt.className="st-txt err";R.stTxt.textContent="render error: "+err;}}};

function two(n){return (n<10?"0":"")+n;}
setInterval(function(){var d=new Date();
  txt(R.clock,two(d.getHours())+":"+two(d.getMinutes())+":"+two(d.getSeconds()));
  if(lastRecv&&(Date.now()-lastRecv)>STALE_MS)setLink(false);},1000);

/* The poll is a VIEW heartbeat only. The server runs its own clock (SWEEP_MS) and answers a bare
   poll from cache with zero device calls, so this cannot move the device-call rate — and the alert
   keeps firing with this page closed and nobody in the dimension. */
send({action:"poll"});
setInterval(function(){send({action:"poll"});},POLL_MS);

var rt=null;
window.addEventListener("resize",function(){if(rt)clearTimeout(rt);
  rt=setTimeout(function(){rt=null;repaint();},150);});
})();
