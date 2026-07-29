/* PROSPECTOR'S SURVEY ROOM — page half. Server-authoritative: this page decides nothing, it only
   *requests* (mc.send) and renders what came back (mc.onState); every field may be null.
   Rendering is INCREMENTAL — the shell is static HTML, so an update only patches text/class/width on
   cached refs; the dynamic lists (chips, vein rows, advisories, tally, site log) rebuild only when their
   signature changes and keep scrollTop. The three plots are canvases redrawn from their client rect.
   MCEF input: plain clicks only — no drag, no native double-click, no hover-only, and NO WHEEL, which is
   why every list is reached with explicit page buttons. Typed CHARACTERS reach the page only from the
   surfaces that forward them (the SilicaOS desktop window, a pad, a pocket computer); an in-world wall screen
   forwards clicks and nothing else, so the one text field on the sheet — SEARCH — is display-plus-✕ there and
   never the only route to anything (see the SEARCH block below). */
(function(){
"use strict";
var mc=window.mc||{send:function(){},onState:null,player:"",display:""};
var POLL_MS=1000,STALE_MS=5000;                /* STALE_MS: no push for this long -> link lamp red */
var AMBER="#f4b63b",RED="#ff5b49",TEAL="#3fe0c2",CYAN="#84cdff",VIOLET="#b79bff",WARM="#ffd9a6";
var INK="rgba(239,230,210,";
var D="—";                                     /* the "no reading" placeholder */
var TICKS=20;

// ---------------------------------------------------------------- helpers
function num(v){return (typeof v==="number"&&isFinite(v))?v:null;}
function clamp(v,lo,hi){return v<lo?lo:(v>hi?hi:v);}
function fmt(n){n=num(n);if(n==null)return D;var a=Math.abs(n);
  if(a>=1e9)return (n/1e9).toFixed(2)+"G";if(a>=1e6)return (n/1e6).toFixed(2)+"M";
  if(a>=1e3)return (n/1e3).toFixed(1)+"k";if(a>=100)return String(Math.round(n));
  if(a>=10)return n.toFixed(1);return n.toFixed(2);}
function group(n){n=num(n);return n==null?D:Math.round(n).toString().replace(/\B(?=(\d{3})+(?!\d))/g,",");}
function secs(t){t=num(t);return t==null?D:(t<TICKS?"<1s":Math.round(t/TICKS)+"s");}
/* "minecraft:deepslate_diamond_ore" -> "DEEPSLATE DIAMOND" (the trailing _ore is noise in an ore list) */
function pretty(id){if(!id)return D;var s=String(id),c=s.indexOf(":");
  if(c>=0)s=s.slice(c+1);
  s=s.replace(/_ore$/,"").replace(/^ore_/,"").replace(/_/g," ");
  return s.toUpperCase();}
/* Colour by HASHED BLOCK ID — honest and roster-independent: no hardcoded ore table, so a modded ore gets
   a stable colour of its own. (The in-world hologram uses each block's real vanilla MapColor; the page
   cannot see that, so it does not pretend to.) Golden-angle spread keeps neighbours distinguishable. */
function hueOf(id){var h=0,i,s=String(id);for(i=0;i<s.length;i++){h=(h*33+s.charCodeAt(i))>>>0;}
  return (h%997)*137.508%360;}
function colOf(id,a){return id?("hsla("+hueOf(id).toFixed(1)+",72%,62%,"+(a==null?1:a)+")")
  :(INK+(a==null?".45":a*.45)+")");}
function depthTxt(d){d=num(d);if(d==null)return D;var v=Math.round(d);
  if(v===0)return "level";return v<0?(Math.abs(v)+" below"):(v+" above");}
/* The scan volume is a CUBE hanging entirely below the scanner (E3P9-D21): `radius` is only its horizontal
   half-extent, while `edge` (its full width) and `depth` (how far it reaches down) are the same number,
   2r+1. The server sends both; this derives them if a field ever arrives missing. */
function spanOf(v,r){var e=num(v);if(e!=null)return e;r=num(r);return r==null?null:2*r+1;}

function el(tag,c,t){var x=document.createElement(tag);if(c)x.className=c;if(t!=null)x.textContent=t;return x;}
function txt(n,s){if(n&&n.textContent!==s)n.textContent=s;}
function cls(n,s){if(n&&n.className!==s)n.className=s;}
function dis(n,b){if(n)n.disabled=!!b;}
function send(m){try{mc.send(JSON.stringify(m));}catch(e){}}

// ---------------------------------------------------------------- refs
var R={};
("offsheet offReason op devCount link linkTxt "+
 "nScan sName sState sStateTxt sChips sPh pProg pipScan sNote ring ringV ringL "+
 "tRadius tChip tFe tEnergy tCool tAge tHits tVeins clampLine "+
 "cfgPreset cfgFilter presets rVal btnRMinus btnRPlus btnRMax btnPulse "+
 "nSurvey qState qStateTxt qPh planC planMeta secC secMeta "+
 "qTotal qVeins qRadius qAge qSkip qOrigin btnMobs "+
 "nDepth dState dStateTxt dPh dY dYield dBand dHits histC histMeta "+
 "nVein vState vStateTxt vPh btnSortDist btnSortRare btnOnly onlyTxt vRange rows rowUp rowDn rowPos "+
 "searchIn btnSearchClr "+
 "stLamp stTxt tbFrame clock "+
 "alCount alPos alarms alUp alDn tlCount tlPos tally tlUp tlDn siCount siPos sites siUp siDn "+
 "walk needle wCard wBear wDist wDepth wBlock").split(" ").forEach(function(k){R[k]=document.getElementById(k);});
R.arc=R.ring?R.ring.querySelector(".rv"):null;
var ARC=251.3;

// ---------------------------------------------------------------- one-time wiring
/* `cur` is everything a click needs to know; it is refreshed by every render, so a control can never act
   on a field the page merely remembers from a stale frame. */
var cur={live:false,scanning:false,cool:0,sel:null,focus:null,mobsOn:false,mobsHave:false,
         page:0,pages:1,sort:"dist",only:null,search:""};
function attr(ev,name){var n=ev.target;
  while(n&&n!==ev.currentTarget){if(n.getAttribute&&n.getAttribute(name)!=null)return n.getAttribute(name);n=n.parentNode;}
  return null;}
function on(node,fn){if(node)node.addEventListener("click",fn);}

on(R.sChips,function(ev){var v=attr(ev,"data-id");if(v)send({action:"select",id:v});});
on(R.btnPulse,function(){if(cur.live&&!cur.scanning)send({action:"pulse"});});
on(R.presets,function(ev){var k=attr(ev,"data-p");if(k&&cur.live)send({action:"preset",key:k});});
on(R.btnRMinus,function(){if(cur.live)send({action:"radius",delta:-4});});
on(R.btnRPlus,function(){if(cur.live)send({action:"radius",delta:4});});
on(R.btnRMax,function(){if(cur.live)send({action:"radius",max:true});});
on(R.btnSortDist,function(){if(cur.sort!=="dist")send({action:"sort",mode:"dist"});});
on(R.btnSortRare,function(){if(cur.sort!=="rarity")send({action:"sort",mode:"rarity"});});
on(R.btnMobs,function(){if(cur.mobsHave)send({action:"mobs",on:!cur.mobsOn});});
/* a row click FOCUSES the vein: the block's hologram highlights it and the compass in its slot points at
   it. The server re-validates the id against the survey it holds. */
on(R.rows,function(ev){var id=attr(ev,"data-id");if(id)send({action:"focus",id:id});});
/* the ONLY view filter — two ways in, one way out. A tally row sets it (and clears it if it is already the
   active one, so the picker is its own toggle); the chip in the vein card clears it. The server owns the
   filter, so every viewer of a shared screen is looking at the same narrowed survey. */
on(R.tally,function(ev){var b=attr(ev,"data-b");
  if(b)send({action:"only",block:(b===cur.only?null:b)});});
on(R.btnOnly,function(){if(cur.only)send({action:"only",block:null});});

/* ------------------------------------------- SEARCH ------------------------------------------------------
   Free text, applied on the SERVER as you type — so it composes with ONLY (logical AND), with the sort and
   with the paging, and so every viewer of one wall screen is looking at the same narrowed rows, exactly like
   ONLY / the sort / the page. Which makes the ECHO the real problem: the state push carries the live query
   back, and writing it into the box on every push would fight the caret of whoever is typing. The protocol:

     * a local edit is sent DEBOUNCED (SEND_MS) — a keystroke must not be a round-trip;
     * `pend` is the value we last sent, and is cleared only when the server echoes EXACTLY it. Until then the
       box is never written from state, so a push that was BUILT BEFORE our message landed cannot resurrect
       the older query over what the operator just typed;
     * the box IS written from state whenever nothing local is in flight (no timer armed, nothing pending) —
       which is what lets another viewer's query, and the server's own length clamp, show up here;
     * a newer local value always wins, because a send only ever carries `box.value` as read at flush time,
       and the queue delivers in order;
     * if an echo never arrives (a dropped web_message — the event queue is capped) the send is retried a
       couple of times and then abandoned, so the box can never end up permanently ignoring the server.
       ponytail: retry ceiling is ACK_TRIES sends; past that the box snaps to whatever actually landed, which
       is honest, and the operator's next keystroke starts a fresh attempt.
   Enter is a CONVENIENCE ONLY (an early flush) and nothing requires it: MC fires no charTyped for Enter, so
   its delivery through MCEF is a special case that needed a hand-made \r CHAR event in the SilicaOS Folders
   editor — a search that needed Enter simply would not work here. */
var SEARCH_MAX=32;              /* must match SEARCH_MAX in entrypoint.js — the server slices and wins */
var SEND_MS=250,ACK_MS=1500,ACK_TRIES=3;
var sTimer=null,pend=null,pendAt=0,pendN=0;
function sendSearch(v){pend=v;pendAt=Date.now();pendN=1;send({action:"search",q:v});}
function armSearch(){if(sTimer)clearTimeout(sTimer);
  sTimer=setTimeout(function(){sTimer=null;flushSearch();},SEND_MS);}
function flushSearch(){
  if(sTimer){clearTimeout(sTimer);sTimer=null;}
  var b=R.searchIn;if(!b)return;
  if(b.value.length>SEARCH_MAX)b.value=b.value.slice(0,SEARCH_MAX);
  if(pend!==b.value)sendSearch(b.value);}
/* the ack watch, ridden on the existing poll tick rather than a timer of its own */
function ackSearch(){
  if(pend==null||sTimer)return;
  if(Date.now()-pendAt<ACK_MS)return;
  var b=R.searchIn;
  if(pendN<ACK_TRIES&&b&&b.value===pend){pendN++;pendAt=Date.now();send({action:"search",q:pend});return;}
  pend=null;}
if(R.searchIn){
  R.searchIn.addEventListener("input",armSearch);
  R.searchIn.addEventListener("keydown",function(ev){
    if(ev.keyCode===13||ev.key==="Enter")flushSearch();});}
/* the ✕ is a CLICK, so it goes immediately like every other control — and it is the only way to clear a query
   from a tap-only wall screen, where the box itself cannot be touched */
on(R.btnSearchClr,function(){var b=R.searchIn;if(b)b.value="";
  if(sTimer){clearTimeout(sTimer);sTimer=null;}
  sendSearch("");});

// ---------------------------------------------------------------- canvas plumbing
/* One context factory for all three plots: size from the CLIENT RECT (so they follow the rem scaling),
   honour devicePixelRatio, and bail out on a zero/absurd rect instead of throwing. */
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
  g.fillStyle=INK+".3)";g.textAlign="center";
  g.font=Math.max(8,Math.round(c.h*.11))+"px monospace";g.fillText(msg,c.w/2,c.h/2+3);}
function dot(g,x,y,r,col){g.fillStyle=col;g.beginPath();g.arc(x,y,r,0,6.284);g.fill();}

/* Focus fade: while a vein is selected every OTHER vein falls back to a ghost in both survey plots, so the
   one you picked reads at a glance instead of competing with a field of equally bright dots. They are dimmed
   rather than dropped — the surrounding ore is still the context that says whether the find is worth the
   shaft. A map row carries only geometry to keep the payload small, and a vein's id is derived from its own
   centre (GeoLogic.veinId), so those offsets are what identifies the focused row.
   The key is returned only when the focused vein is actually IN the map being drawn — otherwise every dot
   would fade to a ghost with nothing left at full strength to have been the point of it. That happens two
   ways: a view filter excluding the focused vein's block (focus and filter must COMPOSE — filter to diamond,
   focus one diamond, and the other diamonds ghost; ONLY and SEARCH both cut the map the same way, on the
   server), and a focus beyond MAP_CAP. The violet ring is drawn from s.focused regardless, so the focused
   vein is still marked either way. */
var FADE=.11;
function focusKey(f,map){
  if(!f||num(f.dx)==null||num(f.dy)==null||num(f.dz)==null)return null;
  var k=[Math.round(f.dx),Math.round(f.dy),Math.round(f.dz)],i;
  if(map)for(i=0;i<map.length;i++)
    if(map[i][0]===k[0]&&map[i][1]===k[1]&&map[i][2]===k[2])return k;
  return null;}
function veinAlpha(k,v){return (k==null||(v[0]===k[0]&&v[1]===k[1]&&v[2]===k[2]))?.9:FADE;}

/* PLAN (XZ) — the survey seen from above, scanner-centred: the SQUARE footprint and its thirds, cardinal
   ticks, one dot per vein sized by how many blocks it holds and coloured by its block, the focused vein
   ringed, and (optionally) the Entity Detector's mobs overlaid — what is living in the cave you are about to
   breach. The boundary is square because the volume is (a cube of edge 2r+1, E3P9-D21): a circle here would
   draw reach the scanner does not have on the axes and hide the corners it does have. */
function drawPlan(s){
  var c=plotCtx(R.planC);if(!c)return;
  var g=c.g,W=c.w,H=c.h;
  var r=num(s.radius),edge=spanOf(s.edge,r);
  if(r==null||!(r>0)){plotEmpty(c,"no survey");return;}
  var padT=Math.max(11,H*.16),padB=Math.max(9,H*.12),padX=6;
  var cx=W/2,cy=padT+(H-padT-padB)/2;
  var rad=Math.max(6,Math.min((W-padX*2)/2,(H-padT-padB)/2));
  var sc=rad/r;

  /* the footprint at r, and its thirds — squares, not rings */
  g.lineWidth=1;
  [1,.666,.333].forEach(function(f,i){
    g.strokeStyle=i?INK+".08)":"rgba(132,205,255,.34)";
    var q=Math.round(rad*f);g.strokeRect(cx-q+.5,cy-q+.5,q*2-1,q*2-1);});
  /* crosshair + cardinals */
  g.strokeStyle=INK+".10)";g.beginPath();
  g.moveTo(cx-rad,cy);g.lineTo(cx+rad,cy);g.moveTo(cx,cy-rad);g.lineTo(cx,cy+rad);g.stroke();
  var fs=Math.max(7,Math.round(H*.075));
  g.font=fs+"px monospace";g.fillStyle=INK+".45)";g.textAlign="center";
  g.fillText("N",cx,cy-rad-2);g.fillText("S",cx,cy+rad+fs);
  g.textAlign="left";g.fillText("E",cx+rad+2,cy+fs*.35);
  g.textAlign="right";g.fillText("W",cx-rad-2,cy+fs*.35);

  /* veins: [dx,dy,dz,count,paletteIndex] — faded back to ghosts while one of them is focused */
  var map=s.map||[],pal=s.palette||[],i,v,px,pz,fk=focusKey(s.focused,map);
  for(i=0;i<map.length;i++){
    v=map[i];px=cx+v[0]*sc;pz=cy+v[2]*sc;
    var n=num(v[3])||1;
    var rr=clamp(1.5+Math.sqrt(n)*.85,1.5,6);
    var id=(v[4]>=0&&v[4]<pal.length)?pal[v[4]]:null;
    dot(g,px,pz,rr,colOf(id,veinAlpha(fk,v)));}

  /* mobs over the ore map: [dx,dz,flag] 0=friendly 1=hostile 2=player */
  var mb=s.mobs||{};
  if(mb.on&&mb.pts&&mb.pts.length){
    for(i=0;i<mb.pts.length;i++){
      var m=mb.pts[i],mx=cx+m[0]*sc,mz=cy+m[1]*sc,q=Math.max(2,Math.min(4,sc*1.4));
      if(m[2]===1){g.strokeStyle=RED;g.lineWidth=1.3;g.beginPath();
        g.moveTo(mx-q,mz-q);g.lineTo(mx+q,mz+q);g.moveTo(mx+q,mz-q);g.lineTo(mx-q,mz+q);g.stroke();}
      else if(m[2]===2){g.strokeStyle=CYAN;g.lineWidth=1.3;g.beginPath();
        g.moveTo(mx,mz-q-.5);g.lineTo(mx+q+.5,mz);g.lineTo(mx,mz+q+.5);g.lineTo(mx-q-.5,mz);
        g.closePath();g.stroke();}
      else{g.strokeStyle=TEAL;g.lineWidth=1.2;g.beginPath();g.arc(mx,mz,q*.8,0,6.284);g.stroke();}}}

  /* the focused vein — ringed and called out */
  var f=s.focused;
  if(f&&num(f.dx)!=null&&num(f.dz)!=null){
    var fx=cx+f.dx*sc,fz=cy+f.dz*sc;
    g.strokeStyle=VIOLET;g.lineWidth=1.4;
    g.beginPath();g.arc(fx,fz,Math.max(4,Math.min(9,sc*2.2)),0,6.284);g.stroke();
    g.beginPath();g.moveTo(cx,cy);g.lineTo(fx,fz);g.setLineDash([2,3]);g.stroke();g.setLineDash([]);}

  /* the scanner itself */
  g.fillStyle=AMBER;g.fillRect(cx-2,cy-2,4,4);

  g.font=Math.max(7,Math.round(H*.085))+"px monospace";
  g.fillStyle=INK+".42)";
  g.textAlign="left";g.fillText(edge==null?("r "+Math.round(r)):(edge+" blk sq"),4,H-4);
  /* "shown" not "veins" while either view filter holds: the count is of a narrowed survey, and this corner
     sits a card away from the whole-survey vein count in the header rule. */
  g.textAlign="right";g.fillText(map.length+((s.only||s.search)?" shown":" veins"),W-4,H-4);}

/* SECTION (Y) — a mine section of the scanned CUBE: horizontal distance from the scanner runs left-to-right,
   world Y runs down the page, and the volume draws as a plain RECTANGLE, because that is exactly what it is
   (E3P9-D21) — a cube of edge 2r+1 hanging ENTIRELY BELOW the machine, its top face one block under it.
   The scanner therefore sits ON the box's top rule: there is no upward reach to draw, and the box IS the
   volume rather than a bulge around it. Every vein plots at its true depth, the recommended shaft band is
   ruled across it, and while a pulse is in flight the sweep's own bottom-up scan line climbs the section
   (E3P9-D3 — the sweep advances one Y layer at a time, deepest first). */
function drawSection(s){
  var c=plotCtx(R.secC);if(!c)return;
  var g=c.g,W=c.w,H=c.h;
  var r=num(s.radius),edge=spanOf(s.edge,r),org=s.origin;
  if(r==null||!(r>0)||edge==null||!(edge>0)){plotEmpty(c,"no survey");return;}
  var gut=Math.max(20,W*.15),padT=Math.max(11,H*.17),padB=Math.max(9,H*.13);
  var bx=gut,bw=Math.max(8,W-gut-8),by=padT,bh=Math.max(8,H-padT-padB);
  /* Horizontal: a square footprint reaches r*sqrt2 at its corners, so the axis runs to there — scaling it to
     r alone would pile every corner vein against the right rule. Vertical: one row per layer of the cube,
     dy = -1 (immediately under the scanner) through dy = -edge (the deepest). */
  var hMax=r*Math.SQRT2,sx=bw/hMax,sy=bh/edge;
  function YE(dy){return by+(-dy-1)*sy;}         /* a layer's TOP edge; dy=-1 -> by, the scanner's own rule */
  function YP(dy){return YE(dy)+sy*.5;}          /* its centre — where a vein at that depth plots */
  function clampY(v){return clamp(v,by,by+bh);}

  /* the swept volume: a rectangle, its top rule the scanner's own level */
  g.strokeStyle="rgba(132,205,255,.3)";g.lineWidth=1;
  g.strokeRect(bx+.5,by+.5,Math.max(1,bw-1),Math.max(1,bh-1));
  g.strokeStyle=INK+".12)";g.beginPath();
  g.moveTo(bx,by);g.lineTo(bx+bw,by);g.stroke();                   /* the scanner's own level */

  var fs=Math.max(7,Math.round(H*.10));
  g.font=fs+"px monospace";g.textAlign="right";g.fillStyle=INK+".5)";
  /* Two labels, and they are the two that now mean something: the scanner's own Y on the top rule (the cube
     starts one block under it) and the deepest layer at the foot. The old +r/0/-r triple described a bubble
     centred on the machine, which no longer exists in either direction. */
  g.fillText(org?String(Math.round(org.y)):"0",bx-4,by+fs*.35);
  g.fillText(org?String(Math.round(org.y-edge)):("-"+edge),bx-4,by+bh+fs*.35);

  /* the recommended shaft band */
  var rec=s.rec;
  if(rec&&org&&rec.band&&rec.band.length===2){
    var lo=Math.min(rec.band[0],rec.band[1])-org.y,hi=Math.max(rec.band[0],rec.band[1])-org.y;
    var yTop=clampY(YE(hi)),yBot=clampY(YE(lo)+sy);
    if(yBot>yTop){
      g.fillStyle="rgba(63,224,194,.16)";g.fillRect(bx,yTop,bw,yBot-yTop);
      g.strokeStyle=TEAL;g.lineWidth=1;
      g.beginPath();g.moveTo(bx,Math.round(yTop)+.5);g.lineTo(bx+bw,Math.round(yTop)+.5);
      g.moveTo(bx,Math.round(yBot)+.5);g.lineTo(bx+bw,Math.round(yBot)+.5);g.stroke();
      /* the label sits just ABOVE the band when there is room, so it never lies across the ore dots */
      g.fillStyle=TEAL;g.textAlign="right";
      g.fillText("SHAFT Y "+Math.round(rec.y),bx+bw-3,(yTop-3>by+fs)?(yTop-3):Math.max(yTop+fs,by+fs));}}

  /* veins at (horizontal distance, depth) — faded back to ghosts while one of them is focused */
  var map=s.map||[],pal=s.palette||[],i,fk=focusKey(s.focused,map);
  for(i=0;i<map.length;i++){
    var v=map[i],hd=Math.sqrt(v[0]*v[0]+v[2]*v[2]);
    var px=bx+Math.min(hd,hMax)*sx,py=YP(clamp(v[1],-edge,-1));
    var id=(v[4]>=0&&v[4]<pal.length)?pal[v[4]]:null;
    dot(g,px,py,clamp(1.4+Math.sqrt(num(v[3])||1)*.75,1.4,5),colOf(id,veinAlpha(fk,v)));}

  /* the focused vein */
  var f=s.focused;
  if(f&&num(f.dx)!=null&&num(f.dz)!=null&&num(f.dy)!=null){
    var fh=Math.sqrt(f.dx*f.dx+f.dz*f.dz);
    var fx=bx+Math.min(fh,hMax)*sx,fy=YP(clamp(f.dy,-edge,-1));
    g.strokeStyle=VIOLET;g.lineWidth=1.4;g.beginPath();g.arc(fx,fy,Math.max(3.5,sy*2.5),0,6.284);g.stroke();}

  /* the live sweep front: bottom-up, so progress 0 is the foot of the cube and 1 the layer under the scanner */
  if(s.scanning){
    var p=clamp((num(s.progress)||0)/100,0,1);
    var fy2=clampY(by+bh*(1-p));
    g.strokeStyle=AMBER;g.lineWidth=1.6;
    g.beginPath();g.moveTo(bx,Math.round(fy2)+.5);g.lineTo(bx+bw,Math.round(fy2)+.5);g.stroke();
    g.fillStyle=AMBER;g.textAlign="left";g.fillText("SWEEP",bx+3,Math.max(by+fs,fy2-2));}

  /* the scanner, ON the top rule: it reads nothing at or above its own level */
  g.strokeStyle=AMBER;g.lineWidth=1.2;
  g.beginPath();g.moveTo(bx-3,by);g.lineTo(bx+3,by);
  g.moveTo(bx,by-3);g.lineTo(bx,by+3);g.stroke();
  g.font=Math.max(7,Math.round(H*.085))+"px monospace";
  g.fillStyle=INK+".42)";g.textAlign="right";
  g.fillText("dist "+Math.round(hMax)+" · "+edge+" down",W-4,H-4);}

/* ORE PER Y — hits per Y slice divided by the blocks the sweep actually READ in that slice. Since the volume
   became a CUBE (E3P9-D21) every slice inside it is the same edge x edge square, so that divisor is a
   constant and the shape you see is the raw distribution, undistorted: the sphere it replaced had a
   mid-bulge (~pi*r^2 blocks through the scanner's own level against a handful at the poles) that pulled
   every histogram towards the middle whatever the rock was doing. Rows run top = high Y, matching the
   section plot beside it; the recommended band is highlighted, and any slice too thin for the
   recommendation to trust (cells < hist.minCells — with a cube, only ever a slice outside the volume) is
   drawn hollow. */
function drawHist(s){
  var c=plotCtx(R.histC);if(!c)return;
  var g=c.g,W=c.w,H=c.h,h=s.hist;
  if(!h||!h.hits||!h.hits.length){plotEmpty(c,"no depth data");return;}
  var n=h.hits.length,i;
  var gut=Math.max(20,W*.16),padT=Math.max(10,H*.15),padB=Math.max(12,H*.16);
  var bx=gut,bw=Math.max(8,W-gut-6),by=padT,bh=Math.max(8,H-padT-padB);
  var band=bh/n;
  var minC=num(h.minCells)||0;
  /* Scale to the peak among the TRUSTWORTHY slices only — the ones the recommendation itself is willing to
     stand on. Under the sphere this was load-bearing (a pole slice was a handful of blocks wide, so one ore
     in it read as an absurd density and squashed every real layer to a hairline); with a cube every slice in
     the volume is the same size, so it survives only as the guard that a slice the sweep never read cannot
     set the scale. Such bars are drawn hollow and clipped to the plot. */
  var dens=[],mx=0,mxAll=0;
  for(i=0;i<n;i++){
    var cl=num(h.cells[i]);var d=(cl&&cl>0)?(h.hits[i]/cl):0;dens.push(d);
    if(d>mxAll)mxAll=d;
    if(d>mx&&(cl||0)>=minC)mx=d;}
  if(!(mx>0))mx=mxAll;
  if(!(mx>0))mx=1;
  /* recommended band, as slice indices */
  var lo=null,hi=null;
  if(s.rec&&s.rec.band&&s.rec.band.length===2){
    lo=Math.min(s.rec.band[0],s.rec.band[1])-h.y0;hi=Math.max(s.rec.band[0],s.rec.band[1])-h.y0;}

  function rowY(i){return by+(n-1-i)*band;}
  for(i=0;i<n;i++){
    var y=rowY(i),ln=clamp(Math.max(dens[i]>0?1:0,dens[i]/mx*bw),0,bw);
    var inBand=(lo!=null&&i>=lo&&i<=hi);
    if(inBand){g.fillStyle="rgba(63,224,194,.14)";g.fillRect(bx,y,bw,Math.max(1,band));}
    if(ln>0){
      var thin=(num(h.cells[i])||0)<minC;
      g.fillStyle=inBand?"rgba(63,224,194,.85)":(thin?"rgba(132,205,255,.28)":"rgba(132,205,255,.6)");
      g.fillRect(bx,y+Math.max(0,band*.12),ln,Math.max(1,band*.76));}}
  g.strokeStyle=INK+".2)";g.lineWidth=1;g.beginPath();
  g.moveTo(bx+.5,by);g.lineTo(bx+.5,by+bh);g.stroke();

  var fs=Math.max(7,Math.round(H*.1));
  g.font=fs+"px monospace";g.textAlign="right";g.fillStyle=INK+".5)";
  g.fillText(String(Math.round(h.y0+n-1)),bx-4,by+fs*.9);
  g.fillText(String(Math.round(h.y0)),bx-4,by+bh);
  if(s.rec){g.fillStyle=TEAL;g.fillText("Y "+Math.round(s.rec.y),bx-4,clamp(rowY(Math.round(s.rec.y-h.y0))+fs*.35,by+fs,by+bh));}
  /* peak density, bottom-right: the top-right corner belongs to the card's own caption */
  g.textAlign="right";g.fillStyle=INK+".38)";
  g.fillText((mx*1000).toFixed(1)+" ore/1k blk",bx+bw,by+bh+fs*.95);}

// ---------------------------------------------------------------- panels
var ST={sweep:["active","sweeping"],ready:["run","survey held"],cool:["warn","cooling down"],
        empty:["idle","idle"],off:["warn","offline"],err:["hot","refused"]};

function scannerState(st){
  if(!st.online)return "off";
  if(st.error)return "err";
  if(st.scanning)return "sweep";
  if(num(st.cooldownTicks)>0)return "cool";
  return st.hasResult?"ready":"empty";}

/* selector chips: rebuilt only when the roster changes (a per-update rebuild blinks + eats clicks) */
function renderChips(list,selId){
  var box=R.sChips;if(!box)return;
  if(list.length<2){cls(box,"chips hide");box.__sig=null;return;}
  cls(box,"chips");
  var sig=list.map(function(d){return d.id+"~"+(d.label||"")+"~"+(d.online?1:0);}).join("|");
  if(box.__sig!==sig){box.__sig=sig;box.innerHTML="";box.__els={};
    list.forEach(function(d){var b=document.createElement("button");
      b.type="button";b.className="chip-b";b.setAttribute("data-id",d.id);
      b.appendChild(el("span","cl"));b.appendChild(el("span","ct",d.label||d.id));
      box.appendChild(b);box.__els[d.id]=b;});}
  list.forEach(function(d){var b=box.__els[d.id];if(!b)return;
    cls(b,"chip-b "+(d.online?"st-run":"st-warn")+(d.id===selId?" sel":""));});}

/* the filter preset buttons come from the SERVER's PRESETS table, so editing entrypoint.js changes the
   sheet with it — the page never holds a filter of its own. */
function renderPresets(list,activeKey,live){
  var box=R.presets;if(!box)return;
  var sig=list.map(function(p){return p.key+"~"+p.label;}).join("|");
  if(box.__sig!==sig){box.__sig=sig;box.innerHTML="";box.__els={};
    list.forEach(function(p){var b=document.createElement("button");
      b.type="button";b.className="pst";b.setAttribute("data-p",p.key);b.textContent=p.label;
      box.appendChild(b);box.__els[p.key]=b;});}
  list.forEach(function(p){var b=box.__els[p.key];if(!b)return;
    cls(b,"pst"+(p.key===activeKey?" on":""));dis(b,!live);});}

function renderScanner(s){
  var st=s.st||{},live=!!(st.online&&!st.error);
  var row=ST[scannerState(st)]||ST.off;
  var dev=null,i,list=s.scanners||[];
  for(i=0;i<list.length;i++)if(list[i].id===s.sel)dev=list[i];

  cur.live=live;cur.scanning=!!st.scanning;cur.cool=num(st.cooldownTicks)||0;cur.sel=s.sel;

  renderChips(list,s.sel);
  txt(R.sName,dev?(dev.label||dev.id):"NO SCANNER");
  cls(R.sState,"n-state "+row[0]);txt(R.sStateTxt,row[1]);
  cls(R.sPh,"ph"+(live?"":" on"));
  if(!live&&R.sPh)R.sPh.firstChild.textContent=st.error?"SCANNER REFUSED THE CALL":"OFFLINE — CHUNK UNLOADED";
  cls(R.nScan,"node scan"+(st.error?" crit":""));

  var p=num(st.progress);
  var shown=st.scanning?(p==null?0:p):(st.hasResult?100:null);
  txt(R.pProg,shown==null?D:Math.round(shown).toString());
  if(R.arc)R.arc.style.strokeDashoffset=(ARC*(1-(shown==null?0:clamp(shown,0,100))/100)).toFixed(1);
  cls(R.pipScan,"pip"+(st.scanning?" on":(st.hasResult?" done":"")));
  txt(R.pipScan,st.scanning?"SWEEPING":(st.hasResult?"SURVEY HELD":"NO SURVEY"));
  txt(R.sNote,!live?"no signal":(st.scanning?"reading the rock, bottom-up"
    :(st.hasResult?("last pulse "+(st.ageText||D)+" ago")
      :(cur.cool>0?("cooldown "+secs(st.cooldownTicks)):"press PULSE to survey"))));
  txt(R.ringV,num(st.radius)==null?D:String(Math.round(st.radius)));
  txt(R.ringL,"radius");

  txt(R.tRadius,num(st.radius)==null?D:(Math.round(st.radius)+" blk"
    +(num(st.maxRadius)==null?"":" / "+Math.round(st.maxRadius))));
  txt(R.tChip,st.chip?pretty(st.chip):"none");
  cls(R.tChip,"v"+(st.chip?"":" warm"));
  txt(R.tFe,num(st.feDraw)==null?D:(group(st.feDraw)+" FE/t"));
  var e=st.energy||{},ep=num(st.energyPct);
  txt(R.tEnergy,(num(e.stored)==null&&num(e.capacity)==null)?D
    :(fmt(e.stored)+"/"+fmt(e.capacity)+(ep==null?"":" · "+Math.round(ep)+"%")));
  cls(R.tEnergy,"v"+(ep==null?"":(ep<5?" crit":(ep<25?" warm":""))));
  txt(R.tCool,cur.cool>0?secs(st.cooldownTicks):"ready");
  cls(R.tCool,"v"+(cur.cool>0?" warm":" up"));
  txt(R.tAge,st.hasResult?(st.ageText||D):D);
  var sv=s.survey||{};
  txt(R.tHits,num(sv.total)==null?D:group(sv.total));
  /* the whole survey's veins, not the ONLY-filtered view: this tag sits beside the survey's block count */
  txt(R.tVeins,num(s.veinsHeld)==null?D:group(s.veinsHeld));

  cls(R.clampLine,"clampline"+(st.clampedByServer?" on":""));
  if(st.clampedByServer)txt(R.clampLine,"Server clamp: geoScannerMaxRange holds the radius at "
    +(num(st.maxRadius)==null?"its cap":Math.round(st.maxRadius))+" — the installed chip's extra range is ignored.");

  var cfg=s.cfg||{};
  txt(R.cfgPreset,cfg.preset?String(cfg.preset).toUpperCase():"CUSTOM");
  txt(R.cfgFilter,(cfg.filter&&cfg.filter.length)?cfg.filter.join("  ·  "):"empty — nothing can match");
  renderPresets(s.presets||[],cfg.preset,live);
  /* the stepper's own readout: the radius it steps, and beside it the cube that radius actually buys */
  var cr=num(cfg.radius);if(cr==null)cr=num(st.radius);
  var ce=spanOf(num(cfg.edge)!=null?cfg.edge:st.edge,cr);
  txt(R.rVal,cr==null?D:(Math.round(cr)+" blk"+(ce==null?"":" · "+ce+"³")));
  dis(R.btnRMinus,!live);dis(R.btnRPlus,!live);dis(R.btnRMax,!live);

  txt(R.btnPulse,st.scanning?"SWEEPING":(cur.cool>0?("COOLDOWN "+secs(st.cooldownTicks)):"PULSE"));
  dis(R.btnPulse,!live||st.scanning);
  if(R.btnPulse)R.btnPulse.classList.toggle("armed",!!(live&&!st.scanning&&cur.cool<=0));}

function renderSurvey(s){
  var st=s.st||{},sv=s.survey||{},live=!!(st.online&&!st.error);
  var have=!!(st.hasResult&&sv);
  cls(R.qState,"n-state "+(st.scanning?"active":(have?(st.partial?"warn":"run"):"idle")));
  txt(R.qStateTxt,st.scanning?"sweeping":(have?(st.partial?"partial":"complete"):"no data"));
  /* The placeholder also hides while SWEEPING: the plots underneath are already drawing the swept volume and
     the live sweep front, so "press pulse" sat on top of a running pulse telling you to start one. It is the
     only card whose body has something to show before a result exists — the depth and vein cards genuinely
     have nothing mid-sweep, so their placeholders stay honest. */
  cls(R.qPh,"ph"+((have||st.scanning)?"":" on"));
  if(!have&&!st.scanning&&R.qPh)R.qPh.firstChild.textContent=live?"NO SURVEY YET — PRESS PULSE":"NO SURVEY";
  cls(R.nSurvey,"node srv"+(st.partial?" crit":""));

  var sr=num(sv.radius);if(sr==null)sr=num(st.radius);
  var sEdge=spanOf(num(sv.edge)!=null?sv.edge:st.edge,sr);
  txt(R.qTotal,num(sv.total)==null?D:group(sv.total));
  txt(R.qVeins,num(sv.veinCount)==null?D:group(sv.veinCount));
  /* the SWEPT extent: the cube, not the radius — a bare "32 blk" reads as a bubble around the machine when
     what was actually read is a 65-block cube hanging under it */
  txt(R.qRadius,sEdge!=null?(sEdge+"³ blk"):(sr==null?D:Math.round(sr)+" blk"));
  txt(R.qAge,st.ageText||D);
  var sk=num(st.skippedChunks);if(sk==null)sk=num(sv.skippedChunks);
  txt(R.qSkip,sk==null?D:(sk+" chunk"+(sk===1?"":"s")));
  cls(R.qSkip,"v"+(sk?" warm":""));
  var o=s.origin;
  txt(R.qOrigin,o?(Math.round(o.x)+", "+Math.round(o.y)+", "+Math.round(o.z)):D);

  /* the plots narrow with BOTH view filters, so the caption names whichever are holding */
  txt(R.planMeta,(s.map&&s.map.length)
    ?(s.map.length+" plotted"+(s.only?" · ONLY":"")+(s.search?" · FIND":""))
    :(s.search?("no match for "+s.search):(s.only?("no "+pretty(s.only)):"nothing plotted")));
  var mb=s.mobs||{};
  txt(R.secMeta,s.rec?("shaft Y "+Math.round(s.rec.y)):(st.scanning?"sweep in flight":"no shaft advice"));

  cur.mobsHave=!!mb.have;cur.mobsOn=!!mb.on;
  txt(R.btnMobs,!mb.have?"MOBS: NO DETECTOR"
    :(mb.on?("MOBS: "+mb.count):"MOBS: OFF"));
  cls(R.btnMobs,"sw"+(mb.on?" on":""));
  dis(R.btnMobs,!mb.have);

  var view={radius:sr,edge:sEdge,map:s.map,palette:s.palette,focused:s.focused,mobs:mb,origin:o,
            rec:s.rec,scanning:!!st.scanning,progress:num(st.progress),
            only:s.only||null,search:s.search||""};
  drawPlan(have||st.scanning?view:{});
  drawSection(have||st.scanning?view:{});}

function renderDepth(s){
  var rec=s.rec,h=s.hist,prov=!!s.truncated||!!(s.st&&s.st.partial);
  var have=!!(rec&&h);
  cls(R.dPh,"ph"+(h?"":" on"));
  if(!h&&R.dPh)R.dPh.firstChild.textContent=(s.st&&s.st.hasResult)?"NOTHING FOUND TO ADVISE ON":"NO DEPTH DATA";
  cls(R.dState,"n-state "+(!have?"idle":(prov?"warn":"run")));
  txt(R.dStateTxt,!have?"no advice":(prov?"provisional":"advised"));

  txt(R.dY,rec?String(Math.round(rec.y)):D);
  cls(R.dY,"t-v"+(rec?" up":""));
  txt(R.dYield,rec?(rec.per100==null?D:rec.per100.toFixed(1)):D);
  txt(R.dBand,rec&&rec.band?(Math.round(Math.min(rec.band[0],rec.band[1]))+".."
    +Math.round(Math.max(rec.band[0],rec.band[1]))):D);
  txt(R.dHits,rec?group(rec.hits):D);
  if(R.dY&&R.dY.parentNode)R.dY.parentNode.className="tile"+(prov&&rec?" prov":"");

  txt(R.histMeta,!h?"-":((num(h.sampled)==null?0:group(h.sampled))+" hits"
    +(s.truncated?" · TRUNCATED":"")));
  drawHist(s);}

/* The search box's echo guard: the ONE place state is allowed to write the field — see the SEARCH block for
   why. Also drives the two things that say a query is live: the field's violet border and the ✕. */
function renderSearchBox(q){
  var b=R.searchIn;
  if(b){
    if(pend!=null&&pend===q)pend=null;               /* our own edit came back — acknowledged */
    if(!sTimer&&pend==null&&b.value!==q)b.value=q;   /* otherwise the operator's caret owns the box */
    cls(b,"s-in"+(q?" on":""));}
  cls(R.btnSearchClr,"sw tiny sclr"+(q?" on":""));}

/* The vein table. Rows are rebuilt only when the page's CONTENT changes; the focused row's highlight is
   patched separately, so focusing a vein does not rebuild the table under the click that did it. */
function renderVeins(s){
  var box=R.rows;if(!box)return;
  var rows=s.rows||[],st=s.st||{};
  var total=num(s.rowTotal)||0,rank=num(s.rank)||1;
  cur.page=num(s.page)||0;cur.pages=num(s.pages)||1;cur.sort=s.sort||"dist";
  cur.focus=(s.focused&&s.focused.id)?s.focused.id:null;

  cls(R.vState,"n-state "+(total?"run":"idle"));
  /* "shown", not "found", while EITHER view filter holds — the survey found far more than this. */
  txt(R.vStateTxt,total?(total+((cur.only||cur.search)?" shown":" found")):"none");
  cls(R.vPh,"ph"+(rows.length?"":" on"));
  /* an empty table always says WHICH of the four reasons it is empty for — a query that matches nothing must
     not read as a broken survey, and it must not read as an empty ONLY either (they compose) */
  if(!rows.length&&R.vPh)R.vPh.firstChild.textContent=
    !st.hasResult?"NO SURVEY YET"
    :(cur.search?("NO VEIN MATCHES “"+cur.search.toUpperCase()+"”"
        +(cur.only?(" IN "+pretty(cur.only)):""))
      :(cur.only?("NO "+pretty(cur.only)+" IN THIS SURVEY"):"NOTHING MATCHED THE SCAN FILTER"));
  cls(R.btnSortDist,"sw tiny"+(cur.sort==="dist"?" on":""));
  cls(R.btnSortRare,"sw tiny"+(cur.sort==="rarity"?" on":""));
  /* the chip is the filter made visible from the card it is narrowing, and the only ✕ that clears it */
  cls(R.btnOnly,"sw tiny only"+(cur.only?" on":""));
  txt(R.onlyTxt,cur.only?pretty(cur.only):D);
  txt(R.vRange,total?(rank+"–"+Math.min(total,rank+rows.length-1)+" of "+total):D);
  txt(R.rowPos,cur.pages>1?("pg "+(cur.page+1)+"/"+cur.pages):("pg 1/1"));

  var maxR=num(s.maxRarity)||0;
  /* typeCount is in the signature as well as rarity: it is what the cell PRINTS, and the published rarity is
     rounded, so two different per-scan totals can share a rarity and would otherwise leave a stale number on
     screen after a re-pulse. */
  /* Both view filters are in the signature as well as the rows they produced. The rows are derived from them,
     so this is insurance rather than the mechanism — but a filtered page CAN be row-identical to the
     unfiltered one (a survey holding a single ore, say), and a signature that cannot see the filter that
     produced it is exactly the class of bug the tally's `more` field already cost this file once. */
  var sig=cur.page+"~"+cur.sort+"~"+(cur.only||"")+"~"+cur.search+"~"+rows.map(function(v){
    return (v.id||"")+"~"+v.count+"~"+v.dist+"~"+v.typeCount+"~"+v.rarity;}).join("|");
  if(box.__sig!==sig){
    var view=cur.page+"~"+(cur.only||"")+"~"+cur.search;
    box.__sig=sig;box.__n=rows.length;box.innerHTML="";box.__els={};
    rows.forEach(function(v){
      var b=document.createElement("button");
      b.type="button";b.className="vrow";
      if(v.id)b.setAttribute("data-id",v.id);
      var nm=el("span","nm");
      var d=el("span","sw-dot");d.style.color=colOf(v.block);
      nm.appendChild(d);nm.appendChild(el("span",null,pretty(v.block)));
      b.appendChild(nm);
      b.appendChild(el("span","c",num(v.count)==null?D:String(v.count)));
      b.appendChild(el("span","c",num(v.dist)==null?D:(Math.round(v.dist)+"m")));
      /* cardinal only: the exact bearing in degrees lives in the WALK TO panel for the focused vein, and
         "NNE 261°" does not survive this column's width on a 512px wall screen */
      b.appendChild(el("span","c",v.cardinal||"?"));
      b.appendChild(el("span","c",num(v.depth)==null?D:(v.depth>0?"+":"")+Math.round(v.depth)));
      /* FOUND: how many of this ore the whole scan turned up (E3P9-D22), which is the number that explains
         the RAREST order — "x3" says why allthemodium is at the top and "0.9998" says nothing. The bar is
         still the rarity fraction against the page's maximum, so the bulk ore reads as a stub and everything
         scarce reads as full. The bar is capped at 60% of the cell so the count can never be squeezed out of
         a narrow column on a wall screen. */
      var rar=el("span","c rar");
      var i2=document.createElement("i");
      i2.style.width=(maxR>0&&num(v.rarity)!=null?clamp(v.rarity/maxR*100,3,100):0).toFixed(0)+"%";
      i2.style.maxWidth="60%";
      rar.appendChild(i2);
      rar.appendChild(el("em",null,num(v.typeCount)==null?D:("×"+v.typeCount)));
      b.appendChild(rar);
      box.appendChild(b);if(v.id)box.__els[v.id]=b;});
    /* A new page — or a new VIEW, i.e. a different set of rows arriving under the same page number because
       ONLY or SEARCH changed — starts at the top. The same view on the same page keeps where the operator had
       paged to. */
    if(box.__view!==view){box.scrollTop=0;box.__view=view;}
  }
  rows.forEach(function(v){var b=v.id?box.__els[v.id]:null;if(!b)return;
    cls(b,"vrow"+(v.id===cur.focus?" sel":""));});
  syncRows();}

/* Paging, the only way to reach an off-screen row: the buttons scroll WITHIN the current page first and
   fall through to the server's page when there is nothing left to scroll. (MCEF forwards no wheel and a
   wall screen is tap-only, so a scrollbar alone is unreachable furniture.) */
function syncRows(){
  var box=R.rows;if(!box)return;
  var max=Math.max(0,box.scrollHeight-box.clientHeight),t=box.scrollTop;
  dis(R.rowUp,t<=1&&cur.page<=0);
  dis(R.rowDn,t>=max-1&&cur.page>=cur.pages-1);}
function pageRows(dir){
  var box=R.rows;if(!box)return;
  var max=Math.max(0,box.scrollHeight-box.clientHeight),step=Math.max(24,box.clientHeight*.8);
  if(dir<0&&box.scrollTop>1){box.scrollTop=Math.max(0,box.scrollTop-step);syncRows();return;}
  if(dir>0&&box.scrollTop<max-1){box.scrollTop=Math.min(max,box.scrollTop+step);syncRows();return;}
  if((dir<0&&cur.page>0)||(dir>0&&cur.page<cur.pages-1))send({action:"page",delta:dir});}
on(R.rowUp,function(){pageRows(-1);});
on(R.rowDn,function(){pageRows(1);});

/* Same pager idea for the three foot lists — content-driven scroll, button-driven paging, position mark. */
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
var syncAl=pager(R.alarms,R.alUp,R.alDn,R.alPos),
    syncTl=pager(R.tally,R.tlUp,R.tlDn,R.tlPos),
    syncSi=pager(R.sites,R.siUp,R.siDn,R.siPos);

function renderAlarms(list){
  var box=R.alarms;if(!box)return;
  txt(R.alCount,String(list.length));
  var sig=list.map(function(a){return (a.level||"")+"~"+(a.text||"");}).join("|");
  if(box.__sig!==sig){
    var keep=box.scrollTop;box.__sig=sig;box.__n=list.length;box.innerHTML="";
    if(!list.length)box.appendChild(el("div","al none","NO ADVISORIES"));
    else list.forEach(function(a){
      var lv=a.level==="crit"?"crit":(a.level==="none"?"none":"warn");
      box.appendChild(el("div","al "+lv,a.text||D));});
    box.scrollTop=keep;}
  syncAl();}

/* The tally: block -> count, with a share bar behind each row — and the ONLY picker, so every row is a real
   button carrying its block id. Tap one to narrow the vein table and both plots to that block; tap the
   active one again to clear. The active filter is part of the rebuild SIGNATURE, or the selected state
   would never repaint; scrollTop is preserved across the rebuild (a full innerHTML rebuild that forgets it
   throws the operator back to the top of the list on every poll). */
function renderTally(list,more,total,only){
  var box=R.tally;if(!box)return;
  txt(R.tlCount,String(list.length+(more||0)));
  /* `more` belongs in the signature too: it is the one field that changes what is RENDERED (the "+N more"
     tail) without changing the list, so leaving it out left a stale tail behind a fresh count. */
  var sig=(total||0)+"~"+(only||"")+"~"+(more||0)+"~"+list.map(function(t){return t[0]+"~"+t[1];}).join("|");
  if(box.__sig!==sig){
    var keep=box.scrollTop;box.__sig=sig;box.__n=list.length+((more>0)?1:0);box.innerHTML="";
    if(!list.length)box.appendChild(el("div","al none","NOTHING FOUND"));
    else{
      var top=list.length?num(list[0][1])||1:1;
      list.forEach(function(t){
        var row=document.createElement("button");
        row.type="button";row.className="al tal"+(t[0]===only?" on":"");
        row.setAttribute("data-b",t[0]);
        var bar=document.createElement("i");
        bar.style.width=clamp((num(t[1])||0)/top*100,2,100).toFixed(0)+"%";
        row.appendChild(bar);
        /* the same hashed colour the plots and the vein table give this block — the dot is what ties a
           tally row to its dots, and (with the pointer/active styling) what says the row is a control */
        var d=el("span","sw-dot");d.style.color=colOf(t[0]);
        row.appendChild(d);
        row.appendChild(el("span","tnm",pretty(t[0])));
        row.appendChild(el("span","q",group(t[1])));
        box.appendChild(row);});
      if(more>0)box.appendChild(el("div","al","+"+more+" more block type"+(more===1?"":"s")));}
    box.scrollTop=keep;}
  syncTl();}

/* the site log: what changed between pulses, straight off the scanner's own `diff` */
function renderSites(list){
  var box=R.sites;if(!box)return;
  txt(R.siCount,String(list.length));
  var sig=list.map(function(l){return (l.kind||"")+"~"+(l.text||"");}).join("|");
  if(box.__sig!==sig){
    var keep=box.scrollTop;box.__sig=sig;box.__n=list.length;box.innerHTML="";
    if(!list.length)box.appendChild(el("div","ev none","no pulses compared yet"));
    else list.forEach(function(l){
      var k=l.kind==="gone"?"gone":(l.kind==="new"?"new":"none");
      box.appendChild(el("div","ev "+k,l.text||D));});
    box.scrollTop=keep;}
  syncSi();}

/* the walk-to compass: the whole point of `focus` — a bearing you can follow with no map at all */
function renderWalk(f){
  var have=!!(f&&num(f.bearing)!=null);
  cls(R.walk,"walk"+(have?"":" off"));
  if(R.needle)R.needle.style.transform="rotate("+(have?f.bearing:0).toFixed(1)+"deg)";
  txt(R.wCard,have?(f.cardinal||"?"):D);
  txt(R.wBear,have?(Math.round(f.bearing)+"°"):D);
  txt(R.wDist,(f&&num(f.dist)!=null)?(Math.round(f.dist)+" m"):D);
  txt(R.wDepth,(f&&num(f.depth)!=null)?depthTxt(f.depth):D);
  txt(R.wBlock,f?(pretty(f.block)+(num(f.count)==null?"":" x"+f.count)):"no vein focused");}

function renderStatus(last){
  if(!last||!last.text){cls(R.stLamp,"st-lamp");cls(R.stTxt,"st-txt");
    txt(R.stTxt,"Standing by — no operator action yet.");return;}
  cls(R.stLamp,"st-lamp "+(last.ok?"ok":"err"));
  cls(R.stTxt,"st-txt"+(last.ok?"":" err"));
  var head=last.action?String(last.action).toUpperCase():"";
  txt(R.stTxt,head?(head+" — "+last.text):last.text);}

// ---------------------------------------------------------------- main render
var lastState=null,lastRecv=0;
function setLink(live){cls(R.link,"link"+(live?"":" down"));txt(R.linkTxt,live?"LINK LIVE":"NO SIGNAL");}

function render(s){
  var ok=!!(s&&s.ok);
  cls(R.offsheet,"offsheet"+(ok?"":" on"));
  if(!ok){txt(R.offReason,(s&&s.reason)||"No survey signal from the control script.");
    setLink(false);return;}

  /* the two view filters are read by several renderers AND several click handlers, so they are latched here
     rather than as a side effect of whichever renderer happens to run first */
  cur.only=s.only||null;
  cur.search=(typeof s.search==="string")?s.search:"";

  renderSearchBox(cur.search);
  renderScanner(s);
  renderSurvey(s);
  renderDepth(s);
  renderVeins(s);
  renderAlarms(s.alarms||[]);
  renderTally(s.tally||[],num(s.tallyMore)||0,num(s.veinsHeld)||0,cur.only);
  renderSites(s.sites||[]);
  renderWalk(s.focused);
  renderStatus(s.last);

  txt(R.tbFrame,num(s.frame)==null?D:String(s.frame));
  /* the header rule reports the SURVEY, never the current view — an ONLY filter must not look like the
     survey shrank. (`veinsHeld` is the unfiltered count; `rowTotal` is the table's.) */
  txt(R.devCount,(num(s.veinsHeld)==null?"0":group(s.veinsHeld))
    +((s.survey&&num(s.survey.total)!=null)?(" · "+group(s.survey.total)+" blk"):""));
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

/* A bare poll is a heartbeat only: the server answers it from its cache with ZERO device calls, and pushes
   fresh state on its OWN clock (faster while a sweep is in flight). Nothing here paces the survey. */
send({action:"poll"});
setInterval(function(){send({action:"poll"});ackSearch();},POLL_MS);

var rt=null;
window.addEventListener("resize",function(){if(rt)clearTimeout(rt);
  rt=setTimeout(function(){rt=null;if(lastState)mc.onState(lastState);},150);});
})();
