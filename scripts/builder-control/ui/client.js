/* EXCAVATION CONTROL ROOM — page half. Server-authoritative: this page decides nothing, it only
   *requests* (mc.send) and renders what came back (mc.onState); every field may be null.
   Rendering is INCREMENTAL — the shell is static HTML, so a 1s poll only patches text/class/width
   on cached refs; the dynamic lists (chips, alarms, log) rebuild only when their signature changes
   and keep scrollTop. The two survey plots are canvases redrawn from their client rect each frame.
   MCEF input: plain clicks only — no drag, no native double-click, no hover-only. */
(function(){
"use strict";
var mc=window.mc||{send:function(){},onState:null,player:"",display:""};
var POLL_MS=1000,HIST_MAX=60,STALE_MS=3600;    // STALE_MS: no push for this long -> link lamp red
var AMBER="#f4b63b",RED="#ff5b49",TEAL="#3fe0c2",CYAN="#84cdff",WARM="#ffd9a6";
var D="—";                                     // the "no reading" placeholder
var RS_MODES=["ignored","onRequired","offRequired"];
var RS_LABEL={ignored:"IGNORED",onRequired:"ON REQ",offRequired:"OFF REQ"};
/* one row per unit state: lamp class, header text, chip class */
var ST={run:["run","cutting","st-run"],idle:["idle","idle",""],stalled:["warn","stalled","st-warn"],
        error:["active","error","st-hot"],nocard:["warn","no card","st-warn"],
        offline:["warn","offline","st-warn"]};

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
function group(n){n=num(n);return n==null?D:Math.round(n).toString().replace(/\B(?=(\d{3})+(?!\d))/g,",");}
function xyz(p){return (p&&num(p.x)!=null&&num(p.y)!=null&&num(p.z)!=null)?(p.x+", "+p.y+", "+p.z):D;}
function title(s){return String(s).replace(/_/g," ").replace(/\b\w/g,function(c){return c.toUpperCase();});}
/* "minecraft:the_nether" -> "The Nether"; modded keeps a readable namespace prefix */
function prettyDim(id){if(!id)return D;var s=String(id),i=s.indexOf(":");
  var ns=i>=0?s.slice(0,i):"",path=i>=0?s.slice(i+1):s;
  return (ns&&ns!=="minecraft")?(title(ns)+": "+title(path)):title(path);}
/* inclusive block count of the min..max box */
function volume(u){if(!u||!u.min||!u.max||num(u.min.x)==null||num(u.max.x)==null)return null;
  return (Math.abs(u.max.x-u.min.x)+1)*(Math.abs(u.max.y-u.min.y)+1)*(Math.abs(u.max.z-u.min.z)+1);}
/* W×H×D: the shape card's own extent when it has one, else the live min..max span */
function spanWHD(u){var d=u&&u.dimensions;
  if(d&&num(d.x)!=null&&num(d.y)!=null&&num(d.z)!=null)return d.x+"×"+d.y+"×"+d.z;
  if(u&&u.min&&u.max&&num(u.min.x)!=null&&num(u.max.x)!=null)
    return (Math.abs(u.max.x-u.min.x)+1)+"×"+(Math.abs(u.max.y-u.min.y)+1)+"×"+(Math.abs(u.max.z-u.min.z)+1);
  return D;}

function el(tag,c,t){var x=document.createElement(tag);if(c)x.className=c;if(t!=null)x.textContent=t;return x;}
function txt(n,s){if(n&&n.textContent!==s)n.textContent=s;}
function cls(n,s){if(n&&n.className!==s)n.className=s;}
function dis(n,b){if(n)n.disabled=!!b;}
function width(n,p){if(n)n.style.width=(p==null?0:clamp(p,0,100))+"%";}
function send(m){try{mc.send(JSON.stringify(m));}catch(e){}}

// ---------------------------------------------------------------- refs
var R={};
("offsheet offReason op devCount link linkTxt "+
 "nUnit uName uState uStateTxt uChips uPh uProg uTrend uPip uNote uRing uRingV uRingL "+
 "fLayers pLayers vLayers fVol pVol vVol "+
 "tY tLayers tLeft tPerLayer tCard tSpace tStall tErr wEta wLayer wPower "+
 "btnStart btnStop btnRestart "+
 "sState sStateTxt sPh planC planMeta secC secMeta "+
 "qMin qMax qSize qVol qScan qPos qOff qDim flags btnRs "+
 "bState bStateTxt bUnits bUnitsSub bProg bEta bNet fFleet bBuf bStored chart "+
 "pName pState pStateTxt pPh pPct fBuf netLine netTxt pStored pNet pRunL pRunV pFleet "+
 "stLamp stTxt tbFrame clock "+
 "alCount alPos alarms alUp alDn evCount evPos log evUp evDn "+
 "btnStopAll btnStartAll mSub").split(" ").forEach(function(k){R[k]=document.getElementById(k);});
R.uArc=R.uRing?R.uRing.querySelector(".rv"):null;
var ARC=251.3;

// ---------------------------------------------------------------- one-time wiring
var cur={sel:null,live:false,flags:{},rs:"ignored",enabled:false,any:false};
function attr(ev,name){var n=ev.target;
  while(n&&n!==ev.currentTarget){if(n.getAttribute&&n.getAttribute(name)!=null)return n.getAttribute(name);n=n.parentNode;}
  return null;}
function on(node,fn){if(node)node.addEventListener("click",fn);}
/* the unit a control addresses is always the SELECTED one — the server re-validates it anyway */
on(R.uChips,function(ev){var v=attr(ev,"data-id");if(v)send({action:"select",id:v,target:v});});
on(R.btnStart,function(){if(cur.sel)send({action:"start",target:cur.sel});});
on(R.btnStop,function(){if(cur.sel)send({action:"stop",target:cur.sel});});
on(R.btnRestart,function(){if(cur.sel)send({action:"restart",target:cur.sel});});
on(R.btnRs,function(){if(!cur.sel||!cur.live)return;
  var next=RS_MODES[(RS_MODES.indexOf(cur.rs)+1)%RS_MODES.length];
  send({action:"setRedstoneMode",target:cur.sel,mode:next});});
on(R.flags,function(ev){var f=attr(ev,"data-f");
  if(!f||!cur.sel||!cur.live)return;
  var m={action:"setFlags",target:cur.sel,flags:{}};
  m.flags[f]=!cur.flags[f];
  send(m);});
// Master trip: one click, no confirm — a stop-all that needs two clicks is not a stop-all.
on(R.btnStopAll,function(){if(cur.any)send({action:"stopAll"});});
on(R.btnStartAll,function(){if(cur.any)send({action:"startAll"});});

// ---------------------------------------------------------------- trend history
var hist={t:[],prog:[],net:[]};
function record(p,n){hist.t.push(Date.now());hist.prog.push(num(p));hist.net.push(num(n));
  while(hist.t.length>HIST_MAX){hist.t.shift();hist.prog.shift();hist.net.shift();}}
function rateOf(a){if(!a||a.length<2)return null;var t=hist.t,e=a.length-1;
  while(e>0&&a[e]==null)e--;var s=Math.max(0,e-11);while(s<e&&a[s]==null)s++;
  if(s>=e)return null;var dt=(t[e]-t[s])/1000;return dt<=0?null:(a[e]-a[s])/dt;}
function arrow(r){return (r==null||Math.abs(r)<1e-6)?"":(r>0?"▲":"▼");}

// ---------------------------------------------------------------- canvas plumbing
/* One context factory for all three canvases: size from the CLIENT RECT (so the plots follow the
   rem scaling), honour devicePixelRatio, and bail out on a zero/absurd rect instead of throwing. */
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

/* PLAN (XZ) — the work-region rectangle seen from above: chunk grid, the swept portion tinted,
   the Builder block's own position marked in cyan, the scan cursor as a crosshair. */
function drawPlan(u){
  var c=plotCtx(R.planC);if(!c)return;
  var g=c.g,W=c.w,H=c.h,mn=u&&u.min,mx=u&&u.max;
  if(!mn||!mx||num(mn.x)==null||num(mx.x)==null){plotEmpty(c,"no work region");return;}
  var x0=Math.min(mn.x,mx.x),x1=Math.max(mn.x,mx.x);
  var z0=Math.min(mn.z,mx.z),z1=Math.max(mn.z,mx.z);
  var bw=x1-x0+1,bd=z1-z0+1;
  var padT=Math.max(11,H*.17),padB=Math.max(9,H*.13),padX=8;
  var aw=Math.max(4,W-padX*2),ah=Math.max(4,H-padT-padB);
  var s=Math.min(aw/bw,ah/bd),rw=bw*s,rh=bd*s;
  var ox=(W-rw)/2,oy=padT+(ah-rh)/2;
  function PX(v){return ox+(v-x0)*s;}
  function PZ(v){return oy+(v-z0)*s;}

  g.fillStyle="rgba(239,230,210,.045)";g.fillRect(ox,oy,rw,rh);
  // swept tint — X-major raster: every finished Z row, plus the partial row under the cursor
  var sc=u.scan,hasScan=!!(sc&&num(sc.x)!=null&&num(sc.z)!=null);
  if(hasScan){
    var cz=clamp(sc.z,z0,z1),cx=clamp(sc.x,x0,x1);
    g.fillStyle="rgba(244,182,59,.17)";
    if(cz>z0)g.fillRect(ox,oy,rw,(cz-z0)*s);
    g.fillRect(ox,PZ(cz),(cx-x0+1)*s,Math.max(1,s));}
  // 16-block chunk grid (dropped when it would turn into mush)
  if(s*16>=3){
    g.strokeStyle="rgba(239,230,210,.10)";g.lineWidth=1;g.beginPath();
    var gx=Math.ceil(x0/16)*16,gz=Math.ceil(z0/16)*16,k;
    for(k=gx;k<=x1+1;k+=16){var lx=Math.round(PX(k))+.5;g.moveTo(lx,oy);g.lineTo(lx,oy+rh);}
    for(k=gz;k<=z1+1;k+=16){var lz=Math.round(PZ(k))+.5;g.moveTo(ox,lz);g.lineTo(ox+rw,lz);}
    g.stroke();}
  g.strokeStyle=AMBER;g.lineWidth=1.2;g.strokeRect(ox+.5,oy+.5,Math.max(1,rw-1),Math.max(1,rh-1));
  // the Builder block itself
  var p=u.pos;
  if(p&&num(p.x)!=null&&num(p.z)!=null){
    var px=PX(p.x+.5),pz=PZ(p.z+.5);
    if(px>-8&&px<W+8&&pz>-8&&pz<H+8){
      g.strokeStyle=CYAN;g.lineWidth=1;
      g.beginPath();g.moveTo(px-5,pz);g.lineTo(px+5,pz);g.moveTo(px,pz-5);g.lineTo(px,pz+5);g.stroke();
      var q=Math.max(2.5,Math.min(6,s));g.fillStyle=CYAN;g.fillRect(px-q/2,pz-q/2,q,q);}}
  // scan cursor
  if(hasScan){
    var kx=PX(clamp(sc.x,x0,x1)+.5),kz=PZ(clamp(sc.z,z0,z1)+.5);
    g.strokeStyle="rgba(255,217,166,.40)";g.lineWidth=1;g.beginPath();
    g.moveTo(ox,Math.round(kz)+.5);g.lineTo(ox+rw,Math.round(kz)+.5);
    g.moveTo(Math.round(kx)+.5,oy);g.lineTo(Math.round(kx)+.5,oy+rh);g.stroke();
    g.strokeStyle=WARM;g.lineWidth=1.4;g.beginPath();
    g.arc(kx,kz,Math.max(2.5,Math.min(7,s*.9)),0,6.284);g.stroke();}
  // footer marks: north is -Z in Minecraft
  g.font=Math.max(7,Math.round(H*.095))+"px monospace";
  g.fillStyle="rgba(239,230,210,.42)";
  g.textAlign="left";g.fillText("N↑",4,H-4);
  g.textAlign="right";g.fillText(bw+"×"+bd+" blk",W-4,H-4);}

/* SECTION (Y) — a mine survey of the shaft: cut layers voided in amber above, the current layer a
   bright rule carrying its Y number, untouched rock hatched below, Y ticks down the left gutter. */
function drawSection(u){
  var c=plotCtx(R.secC);if(!c)return;
  var g=c.g,W=c.w,H=c.h,mn=u&&u.min,mx=u&&u.max;
  if(!mn||!mx||num(mn.y)==null||num(mx.y)==null){plotEmpty(c,"no work region");return;}
  var y0=Math.min(mn.y,mx.y),y1=Math.max(mn.y,mx.y),n=y1-y0+1;
  var gut=Math.max(24,W*.18),padT=Math.max(11,H*.17),padB=Math.max(9,H*.11);
  var bx=gut,bw=Math.max(6,W-gut-10),by=padT,bh=Math.max(6,H-padT-padB);
  var band=bh/n,i;
  function YP(v){return by+(y1-v)/n*bh;}          // top edge of layer v
  var cy=num(u.currentLevel);
  if(cy!=null)cy=clamp(cy,y0,y1);
  var rockTop=(cy==null)?by:Math.min(by+bh,YP(cy)+band);

  // untouched rock — 45° hatch, clipped to what is left below the cutting face
  if(by+bh-rockTop>0.5){
    g.save();g.beginPath();g.rect(bx,rockTop,bw,by+bh-rockTop);g.clip();
    g.strokeStyle="rgba(239,230,210,.14)";g.lineWidth=1;g.beginPath();
    for(i=bx-bh;i<bx+bw+bh;i+=6){g.moveTo(i,by+bh);g.lineTo(i+bh,by);}
    g.stroke();g.restore();}
  // void: everything already cut, above the face
  if(cy!=null&&YP(cy)-by>0.5){
    g.fillStyle="rgba(244,182,59,.20)";g.fillRect(bx,by,bw,YP(cy)-by);
    if(band>=3){                                   // individual bench lines once they fit
      g.strokeStyle="rgba(244,182,59,.28)";g.lineWidth=1;g.beginPath();
      for(i=y1;i>cy;i--){var ly=Math.round(YP(i))+.5;g.moveTo(bx,ly);g.lineTo(bx+bw,ly);}
      g.stroke();}}
  g.strokeStyle="rgba(239,230,210,.32)";g.lineWidth=1;
  g.strokeRect(bx+.5,by+.5,Math.max(1,bw-1),Math.max(1,bh-1));

  var fs=Math.max(7,Math.round(H*.10));
  g.font=fs+"px monospace";
  // Y gutter ticks
  g.textAlign="right";g.fillStyle="rgba(239,230,210,.5)";
  g.fillText(String(y1),bx-7,by+fs*.9);
  g.fillText(String(y0),bx-7,by+bh);
  if(n>8){var ym=Math.round((y0+y1)/2);g.fillText(String(ym),bx-7,YP(ym)+fs*.35);}
  // the cutting face
  if(cy!=null){
    var ry=YP(cy),rb=Math.max(2,band);
    g.fillStyle="rgba(244,182,59,.9)";g.fillRect(bx,ry,bw,rb);
    g.fillStyle=AMBER;g.textAlign="right";g.fillText("▶",bx-1,ry+rb/2+fs*.35);
    var lbl="Y "+Math.round(cy);
    g.textAlign="left";
    var ty=(ry-4>by+fs)?(ry-4):Math.min(by+bh-2,ry+rb+fs);
    var tw=g.measureText(lbl).width;
    g.fillStyle="rgba(8,10,14,.85)";g.fillRect(bx+3,ty-fs,tw+5,fs+3);
    g.fillStyle=WARM;g.fillText(lbl,bx+5,ty);}
  // the Builder's own Y, so the operator can see how far below it the face has dropped
  var p=u.pos;
  if(p&&num(p.y)!=null&&p.y>=y0&&p.y<=y1){
    var py=YP(p.y)+band/2;
    g.strokeStyle=CYAN;g.lineWidth=1.2;g.beginPath();g.moveTo(bx+bw,py);g.lineTo(bx+bw+7,py);g.stroke();}}

/* strip recorder — client-accumulated fleet history, same two-trace treatment as reactor-control */
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
function drawChart(){var c=plotCtx(R.chart);if(!c)return;
  var g=c.g,w=c.w,h=c.h,i;
  g.strokeStyle="rgba(239,230,210,.06)";g.lineWidth=1;
  for(i=1;i<4;i++){var y=Math.round(h*i/4)+.5;g.beginPath();g.moveTo(0,y);g.lineTo(w,y);g.stroke();}
  var a=trace(g,w,h,hist.prog,AMBER),z=trace(g,w,h,hist.net,TEAL);
  if(!a&&!z){g.fillStyle="rgba(239,230,210,.35)";g.textAlign="center";
    g.font=Math.max(8,Math.round(h*.17))+"px monospace";g.fillText("acquiring…",w/2,h/2+4);}}

// ---------------------------------------------------------------- panels
function pick(list,selId){var i;for(i=0;i<list.length;i++)if(list[i].id===selId)return list[i];
  return list.length?list[0]:null;}
function stRow(u){return ST[(u&&u.state)||"offline"]||ST.offline;}
/* selector chips: rebuilt only when the roster changes (a per-poll rebuild blinks + eats clicks) */
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

function renderUnit(list,selId,fleet){
  var sel=pick(list,selId),u=sel||{},i;
  renderChips(list,sel?sel.id:null);
  var live=!!(sel&&u.online&&!u.error);
  var row=stRow(sel);
  cur.sel=sel?sel.id:null;cur.live=live;cur.rs=u.redstoneMode||"ignored";
  cur.enabled=!!u.enabled;cur.flags=u.flags||{};

  txt(R.uName,sel?(u.label||u.id):"NO BUILDER");
  cls(R.uState,"n-state "+row[0]);txt(R.uStateTxt,sel?row[1]:"—");
  var offTxt=!sel?"NO RFTOOLS BUILDER ON NET":
    (u.notFound?"NOT ON THIS NETWORK":(!u.online?"OFFLINE — CHUNK UNLOADED":"READ ERROR"));
  cls(R.uPh,"ph"+(live?"":" on"));
  if(!live&&R.uPh)R.uPh.firstChild.textContent=offTxt;

  var prog=num(u.progress),pp=prog==null?null:clamp(prog*100,0,100);
  txt(R.uProg,pp==null?D:pp.toFixed(1));
  var tr=rateOf(hist.prog);
  txt(R.uTrend,arrow(tr));cls(R.uTrend,"trend "+(tr==null?"":(tr>0?"up":"down")));
  cls(R.uPip,"pip"+(live&&u.enabled?" on":""));
  txt(R.uPip,u.state==="stalled"?"STALLED":"CUTTING");
  var lvl=num(u.currentLevel),tot=num(u.layersTotal),left=num(u.layersLeft);
  txt(R.uNote,!live?"no signal":(u.state==="nocard"?"no shape card":
    (lvl==null?"awaiting scan":("bench Y "+Math.round(lvl)+(tot!=null?" · "+((tot-(left==null?0:left))+" of "+tot+" layers"):"")))));
  cls(R.nUnit,"node mech"+(u.state==="error"||u.state==="stalled"?" crit":""));

  if(R.uArc)R.uArc.style.strokeDashoffset=(ARC*(1-(pp==null?0:pp)/100)).toFixed(1);
  txt(R.uRingV,left==null?D:fmtInt(left));
  txt(R.uRingL,left==null?"layers":"layers left");

  var cut=(tot!=null&&left!=null)?clamp(tot-left,0,tot):null;
  var lp=(tot!=null&&tot>0&&cut!=null)?cut/tot*100:null;
  width(R.fLayers,lp);txt(R.pLayers,pctTxt(lp));
  txt(R.vLayers,(cut==null||tot==null)?D:(cut+" / "+tot));
  var vol=volume(u);
  width(R.fVol,pp);txt(R.pVol,pctTxt(pp));
  txt(R.vVol,vol==null?D:(group(vol)+" blk"));

  txt(R.tY,lvl==null?D:String(Math.round(lvl)));
  txt(R.tLayers,tot==null?D:fmtInt(tot));
  txt(R.tLeft,left==null?D:fmtInt(left));
  cls(R.tLeft,"v"+(left!=null&&left<=0?" up":""));
  var spl=num(u.secPerLayer);
  txt(R.tPerLayer,spl==null?"measuring…":dur(spl));
  txt(R.tCard,!live?D:(u.hasCard?title(u.card||"?"):"none"));
  cls(R.tCard,"v"+(live&&!u.hasCard?" warm":""));
  txt(R.tSpace,u.spaceMode?title(u.spaceMode):D);
  var stalled=num(u.stalledSec);
  txt(R.tStall,stalled==null?D:dur(stalled));
  cls(R.tStall,"v"+(u.state==="stalled"?" crit":(stalled!=null&&stalled>0?" warm":"")));
  txt(R.tErr,(live&&u.lastError)?u.lastError:D);
  cls(R.tErr,"v"+((live&&u.lastError)?" crit":""));

  var eta=num(u.etaSec),run=num(u.powerRunwaySec);
  txt(R.wEta,u.etaText||dur(eta));
  cls(R.wEta&&R.wEta.parentNode,"rw"+(eta!=null&&durCls(eta)?" "+durCls(eta):""));
  txt(R.wLayer,spl==null?"—":dur(spl));
  txt(R.wPower,run==null?"—":dur(run));
  // the interesting cross-check: does the buffer die before the dig finishes?
  var starve=(run!=null&&eta!=null&&run<eta);
  cls(R.wPower&&R.wPower.parentNode,"rw"+(starve?" crit":(run!=null&&durCls(run)?" "+durCls(run):"")));

  dis(R.btnStart,!live||!!u.enabled);
  dis(R.btnStop,!live||!u.enabled);
  dis(R.btnRestart,!live);
  if(R.btnStop)R.btnStop.classList.toggle("armed",!!(live&&u.enabled));
  return sel;}

function renderSurvey(sel){
  var u=sel||{},live=!!(sel&&u.online&&!u.error);
  cls(R.sState,"n-state "+(live?(u.enabled?"run":"idle"):"warn"));
  txt(R.sStateTxt,live?(u.hasCard?(u.card?title(u.card):"card"):"no card"):"no survey");
  cls(R.sPh,"ph"+(live?"":" on"));
  if(!live&&R.sPh)R.sPh.firstChild.textContent=sel?"NO SURVEY DATA":"NO WORK REGION";

  txt(R.qMin,xyz(u.min));
  txt(R.qMax,xyz(u.max));
  txt(R.qSize,spanWHD(u));
  var vol=volume(u);
  txt(R.qVol,vol==null?D:(group(vol)+" blk"));
  txt(R.qScan,xyz(u.scan));
  txt(R.qPos,xyz(u.pos));
  txt(R.qOff,xyz(u.offset));
  txt(R.qDim,u.dimension?prettyDim(u.dimension):D);

  // plot captions live in the DOM (cheap to patch) so the canvases stay pure drawing
  var lvl=num(u.currentLevel),tot=num(u.layersTotal),left=num(u.layersLeft);
  txt(R.planMeta,(u.scan&&num(u.scan.x)!=null)?("cursor "+u.scan.x+", "+u.scan.z):"no cursor");
  txt(R.secMeta,(lvl==null?"no bench":("Y "+Math.round(lvl)))+
    (tot!=null&&left!=null?("  ·  "+(tot-left)+"/"+tot):""));

  var fs=R.flags?R.flags.children:[];
  for(var i=0;i<fs.length;i++){
    var k=fs[i].getAttribute("data-f"),on=!!(live&&u.flags&&u.flags[k]);
    fs[i].className="fg"+(on?" on":"");
    dis(fs[i],!live);}
  txt(R.btnRs,"RS: "+(RS_LABEL[u.redstoneMode]||D)+" ▸");
  dis(R.btnRs,!live);

  drawPlan(live?u:{});
  drawSection(live?u:{});}

function renderBus(fleet,units){
  var f=fleet||{};
  var cnt=num(f.count),run=num(f.running),stall=num(f.stalled),off=num(f.offline);
  if(cnt==null)cnt=units.length;
  txt(R.bUnits,(run==null?D:run)+" / "+cnt);
  cls(R.bUnits,"t-v"+(run>0?" up":""));
  txt(R.bUnitsSub,(stall==null?0:stall)+" stall · "+(off==null?0:off)+" off");
  var ap=num(f.avgProgress);ap=ap==null?null:clamp(ap*100,0,100);
  txt(R.bProg,pctTxt(ap));
  width(R.fFleet,ap);
  txt(R.bEta,f.etaText||dur(f.etaSec));
  cls(R.bEta,"t-v"+(durCls(f.etaSec)==="crit"?" down":(durCls(f.etaSec)==="warn"?" warm":"")));
  var net=num(f.drawTotal);
  txt(R.bNet,signed(net));
  cls(R.bNet,"t-v"+((net==null||Math.abs(net)<1e-6)?"":(net>0?" up":" down")));
  var bp=num(f.bufPct);if(bp==null)bp=pctOf(f.storedTotal,f.capacityTotal);
  txt(R.bBuf,pctTxt(bp));
  cls(R.bBuf,"v"+(bp==null?"":(bp<10?" crit":(bp<25?" warm":""))));
  txt(R.bStored,(num(f.storedTotal)==null&&num(f.capacityTotal)==null)?D:
    (fmt(f.storedTotal)+"/"+fmt(f.capacityTotal)+" FE"));
  if(run>0){cls(R.bState,"n-state run");txt(R.bStateTxt,"excavating");}
  else if(stall>0){cls(R.bState,"n-state active");txt(R.bStateTxt,"stalled");}
  else{cls(R.bState,"n-state idle");txt(R.bStateTxt,"standby");}
  return {prog:ap,net:net};}

function renderPower(sel,fleet){
  var u=sel||{},f=fleet||{},live=!!(sel&&u.online&&!u.error),e=u.energy||null;
  var es=e?num(e.stored):null,ec=e?num(e.capacity):null;
  var ep=num(u.energyPct);if(ep==null)ep=pctOf(es,ec);
  cls(R.pPh,"ph"+((live&&e)?"":" on"));
  if(R.pPh&&!(live&&e))R.pPh.firstChild.textContent=live?"NO ENERGY CAP ON THIS BUILDER":"NO POWER READING";
  cls(R.pState,"n-state "+(!live?"warn":(ep!=null&&ep<10?"active":(ep!=null&&ep<25?"warn":"run"))));
  txt(R.pStateTxt,!live?"offline":(ep==null?"no cap":(ep<10?"starved":(ep<25?"low":"powered"))));
  txt(R.pName,sel?(u.label||u.id):"Unit power");

  txt(R.pPct,pctTxt(ep));
  width(R.fBuf,ep);
  cls(R.fBuf,"fill"+(ep==null?"":(ep<10?" crit":(ep<25?" warn":""))));
  var net=num(u.netFe),idle=(net==null||Math.abs(net)<1e-6);
  if(idle){cls(R.netLine,"netline idle");txt(R.netTxt,net==null?"NO FLOW DATA":"IDLE");}
  else if(net>0){cls(R.netLine,"netline chg");txt(R.netTxt,"CHARGING "+signed(net)+" FE/t");}
  else{cls(R.netLine,"netline drw");txt(R.netTxt,"DRAWING "+signed(net)+" FE/t");}
  txt(R.pStored,(es==null&&ec==null)?D:(fmt(es)+"/"+fmt(ec)+" FE"));
  txt(R.pNet,net==null?D:(signed(net)+" FE/t"));
  cls(R.pNet,"v"+(idle?"":(net>0?" up":" down")));
  var run=num(u.powerRunwaySec);
  if(run!=null){txt(R.pRunL,"Empty in");txt(R.pRunV,dur(run));
    cls(R.pRunV,"v "+(durCls(run)||"down"));}
  else{txt(R.pRunL,"Buffer runway");txt(R.pRunV,D);cls(R.pRunV,"v");}
  var fd=num(f.drawTotal);
  txt(R.pFleet,fd==null?D:(signed(fd)+" FE/t"));
  cls(R.pFleet,"v"+((fd==null||Math.abs(fd)<1e-6)?"":(fd>0?" up":" down")));}

/* Paging for the two annunciator lists. Entries wrap now, so most of a busy list sits off-screen —
   and neither a wall screen (tap-only) nor MCEF (no wheel event forwarded) can scroll it. So: two
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
var syncAl=pager(R.alarms,R.alUp,R.alDn,R.alPos),syncEv=pager(R.log,R.evUp,R.evDn,R.evPos);

/* alarms + log: signature-rebuild + scroll-preserve, the same discipline as the chips. The pager is
   re-synced on EVERY frame, not just a rebuild — a resize changes what fits without changing content. */
function renderAlarms(list){
  var box=R.alarms;if(!box)return;
  txt(R.alCount,String(list.length));
  var sig=list.map(function(a){return (a.level||"")+"~"+(a.text||"");}).join("|");
  if(box.__sig!==sig){
    var keep=box.scrollTop;box.__sig=sig;box.__n=list.length;box.innerHTML="";
    if(!list.length)box.appendChild(el("div","al none","NO ACTIVE ALARMS"));
    else list.forEach(function(a){
      var lv=a.level==="crit"?"crit":(a.level==="none"?"none":"warn");
      box.appendChild(el("div","al "+lv,a.text||D));});
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
var lastState=null,lastFrame=null,lastRecv=0;
function setLink(live){cls(R.link,"link"+(live?"":" down"));txt(R.linkTxt,live?"LINK LIVE":"NO SIGNAL");}

function render(state){
  var ok=!!(state&&state.ok);
  cls(R.offsheet,"offsheet"+(ok?"":" on"));
  if(!ok){txt(R.offReason,(state&&state.reason)||"No excavation signal from the control script.");
    setLink(false);return;}

  var units=state.units||[],fleet=state.fleet||{};
  cur.any=units.length>0;

  // the recorder advances only on a genuinely fresh server rebuild
  var frame=num(state.frame);
  if(frame==null||frame!==lastFrame){lastFrame=frame;
    var ap=num(fleet.avgProgress);
    record(ap==null?null:ap*100,num(fleet.drawTotal));}

  var sel=renderUnit(units,state.sel,fleet);
  renderSurvey(sel);
  renderBus(fleet,units);
  renderPower(sel,fleet);
  renderAlarms(state.alarms||[]);
  renderLog(state.log||[]);
  renderStatus(state.last);
  drawChart();

  txt(R.tbFrame,frame==null?D:String(frame));
  var run=num(fleet.running);
  txt(R.devCount,units.length+(run==null?"":" · "+run+" RUN"));
  txt(R.op,(mc.player||D)+(mc.display?" · "+String(mc.display).replace(/^Screen:\s*/,""):""));
  dis(R.btnStopAll,!cur.any);
  dis(R.btnStartAll,!cur.any);
  if(R.btnStopAll)R.btnStopAll.classList.toggle("armed",run>0);
  txt(R.mSub,!cur.any?"no units":(run>0?(run+" unit"+(run===1?"":"s")+" cutting"):"all idle"));
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
