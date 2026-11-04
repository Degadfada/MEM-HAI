// Single-file dashboard. No external requests. The token arrives in the URL fragment (never sent to
// the server in a request line).
//
// NOTE: this whole file is one template literal, so the browser JS below must use string
// concatenation. A backtick would close the literal early and a ${...} would be interpolated at
// build time.
export const UI_HTML = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Handoff Ledger</title>
<style>
:root{--bg:#fafaf8;--fg:#1d1d1b;--mut:#6b6b66;--card:#fff;--line:#e4e3de;--acc:#2f5fd0;--ok:#1f7a45;--bad:#b3261e;--warn:#9a6700;--tabh:58px}
@media(prefers-color-scheme:dark){:root{--bg:#161615;--fg:#ececea;--mut:#9a9a94;--card:#1f1f1d;--line:#33332f;--acc:#7ea2ff;--ok:#5fcf8f;--bad:#ff8a80;--warn:#e0b04a}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--fg);font:15px/1.5 system-ui,sans-serif}
main{max-width:1040px;margin:0 auto;padding:16px 16px calc(var(--tabh) + 28px)}
h1{font-size:19px;margin:0}h2{font-size:14px;text-transform:uppercase;letter-spacing:.06em;color:var(--mut);margin:0 0 10px}
.card{background:var(--card);border:1px solid var(--line);border-radius:10px;padding:16px;margin-top:14px}
.row{display:flex;gap:12px;flex-wrap:wrap}.stat{flex:1 1 130px}.stat b{display:block;font-size:22px}.stat span{color:var(--mut);font-size:13px}
table{width:100%;border-collapse:collapse;font-size:13px}td,th{text-align:left;padding:6px 8px;border-bottom:1px solid var(--line);vertical-align:top}th{color:var(--mut);font-weight:500}
.tag{display:inline-block;padding:1px 8px;border-radius:99px;border:1px solid var(--line);font-size:12px}
.human{color:var(--acc)}.ai{color:var(--warn)}.approved{color:var(--ok)}.denied{color:var(--bad)}
button,select,input,textarea{font:inherit;color:var(--fg);background:var(--card);border:1px solid var(--line);border-radius:8px;padding:8px 12px}
button{cursor:pointer;background:var(--acc);color:#fff;border:0}button.sec{background:var(--card);color:var(--fg);border:1px solid var(--line)}
button:disabled{opacity:.5;cursor:default}
pre{white-space:pre-wrap;background:var(--bg);border:1px solid var(--line);border-radius:8px;padding:12px;max-height:380px;overflow:auto;font-size:13px}
.mut{color:var(--mut)}.rev{text-decoration:line-through;opacity:.55}#err{color:var(--bad);min-height:1.4em}
.cf{font-size:11px;padding:0 6px;border-radius:99px;border:1px solid var(--line);margin-left:6px;vertical-align:1px;white-space:nowrap}
.cf-exact,.cf-recorded{color:var(--ok);border-color:currentColor}
.cf-inferred,.cf-cited{color:var(--acc);border-color:currentColor}
.cf-declared{color:var(--warn);border-color:currentColor}
.cf-unattributed,.cf-absent{color:var(--mut)}
.sess{border-left:3px solid var(--acc);padding:8px 0 8px 12px;margin:10px 0}.sess.ai{border-left-color:var(--warn)}.sess.unknown{border-left-color:var(--line)}
.sess h4{margin:0 0 2px;font-size:14px;font-weight:600}.sess .when{color:var(--mut);font-size:12px}
.sess ul{margin:6px 0 0;padding-left:18px;font-size:13px}.sess code{font-size:12px;background:var(--bg);padding:1px 4px;border-radius:4px}
.daybtn{display:inline-block;margin:2px 4px 2px 0;padding:3px 9px;border-radius:7px;border:1px solid var(--line);background:var(--card);cursor:pointer;font-size:13px}
.daybtn.on{background:var(--acc);color:#fff;border-color:var(--acc)}
.why{font-size:12px;color:var(--mut);padding:2px 0 6px 8px;border-left:2px solid var(--line);margin:2px 0 0}
.why b{color:var(--fg);font-weight:500}
.prow{cursor:pointer}.prow:hover{background:var(--bg)}
.bar{height:6px;border-radius:99px;background:var(--line);overflow:hidden;min-width:70px}
.bar i{display:block;height:100%;background:var(--ok)}
nav{position:fixed;left:0;right:0;bottom:0;height:var(--tabh);display:flex;background:var(--card);border-top:1px solid var(--line);z-index:10;padding-bottom:env(safe-area-inset-bottom)}
nav button{flex:1;background:none;color:var(--mut);border:0;border-radius:0;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:2px;font-size:11px;padding:6px 2px}
nav button.on{color:var(--acc);box-shadow:inset 0 2px 0 var(--acc)}
nav button .ic{font-size:17px;line-height:1}
nav .pill{position:absolute;top:4px;transform:translateX(16px);background:var(--bad);color:#fff;border-radius:99px;font-size:10px;padding:0 5px}
.view{display:none}.view.on{display:block}
.head{display:flex;align-items:center;gap:10px;flex-wrap:wrap;margin-bottom:6px}
</style></head><body><main>
<div id="login" class="card" hidden><h2>Sign in</h2><div class="row"><input id="pw" type="password" placeholder="password" autocomplete="current-password"><button id="lgo">Sign in</button></div><div id="lerr" class="denied"></div></div>

<div class="head"><h1>Handoff Ledger</h1><select id="psel" class="sec" title="project"></select></div>
<div class="mut" id="sub">connecting&hellip;</div><div id="err"></div>

<section class="view on" id="v-projects">
  <div class="card"><div class="row" id="stats"></div></div>
  <div class="card"><h2>Projects with memory</h2>
    <table><thead><tr><th>project</th><th>actions</th><th>last touched</th><th>AIs</th><th>why recorded</th><th>chain</th></tr></thead><tbody id="plist"></tbody></table>
    <div class="mut" style="margin-top:8px">Open a folder in VS Code to register it. Click a row to see its history.</div>
  </div>
  <div class="card"><h2>Understandings across projects</h2><div id="lessons" class="mut">none yet</div></div>
</section>

<section class="view" id="v-history">
  <div class="card"><h2>Any day, any AI</h2>
    <div class="row" style="align-items:center"><input id="hdate" type="date"><button id="hgo" class="sec">Show that day</button>
    <span class="mut">idle gap</span><select id="hidle"><option value="">15 min</option><option value="5">5 min</option><option value="30">30 min</option><option value="60">60 min</option></select></div>
    <div id="hdays" style="margin-top:10px"></div><div id="hmoredays"></div>
    <div id="hsum" class="mut" style="margin-top:10px"></div><div id="hbody"></div>
  </div>
  <div class="card"><h2>Everything, newest first</h2>
    <div class="row" style="margin-bottom:8px"><select id="fprov"><option value="">any provenance</option><option value="recorded">recorded</option><option value="cited">cited</option><option value="declared">declared</option><option value="absent">unexplained</option></select><input id="factor" placeholder="actor, e.g. copilot" style="flex:1"><button id="fgo" class="sec">Filter</button></div>
    <table><thead><tr><th>#</th><th>when</th><th>who</th><th>what</th><th>approval</th><th></th></tr></thead><tbody id="ev"></tbody></table>
    <div class="row" style="margin-top:10px;align-items:center"><button id="older" class="sec">Load older</button><span class="mut" id="evcount"></span></div>
  </div>
</section>

<section class="view" id="v-why">
  <div class="card"><h2>Actions with no reason on record</h2>
    <div class="mut" id="whysum">&hellip;</div>
    <table><thead><tr><th>#</th><th>when</th><th>who</th><th>what</th><th>reason</th></tr></thead><tbody id="whylist"></tbody></table>
    <div class="row" style="margin-top:10px"><button id="whyolder" class="sec">Load older</button></div>
    <div class="mut" style="margin-top:8px">A reason added here is appended as its own event citing the original. Nothing is rewritten.</div>
  </div>
</section>

<section class="view" id="v-rules">
  <div class="card"><h2>Guardrails (all AIs)</h2><table><tbody id="gr"></tbody></table>
    <div class="row" style="margin-top:10px"><input id="gt" placeholder="rule in plain words" style="flex:2"><select id="gk"><option value="command">command (regex)</option><option value="path">path (glob)</option><option value="action">action</option></select><input id="gp" placeholder="pattern" style="flex:1"><select id="gl"><option value="block">block</option><option value="advise">advise</option></select><button id="gadd">Add</button></div>
    <div class="mut" style="margin-top:8px">block is enforced wherever we sit in the path. advise is told to every AI.</div>
  </div>
</section>

<section class="view" id="v-contracts">
  <div class="card"><h2>Asked vs done</h2><div id="ct" class="mut">none open</div>
    <div class="row" style="margin-top:10px"><input id="ci" placeholder="id e.g. login-limit" style="flex:1"><input id="cg" placeholder="goal" style="flex:2"><input id="ca" placeholder="done when (a;b)" style="flex:2"><input id="cs" placeholder="only touch (src/**;test/**)" style="flex:2"><button id="cadd">Open</button></div>
  </div>
</section>

<section class="view" id="v-ais">
  <div class="card"><h2>Switch AI and push memory</h2>
    <div class="row"><input id="to" placeholder="new AI, e.g. copilot" list="ais"><datalist id="ais"><option>claude-code<option>copilot<option>codex<option>gemini<option>cursor</datalist>
    <select id="target"><option value="claude-md">CLAUDE.md</option><option value="agents-md">AGENTS.md</option><option value="system-prompt">system prompt</option><option value="mcp-json">MCP JSON</option></select>
    <label class="mut"><input type="checkbox" id="write"> write file into project</label><button id="go">Switch and generate brief</button></div>
    <div id="vr" class="mut" style="margin-top:10px"></div><pre id="brief" hidden></pre>
  </div>
  <div class="card"><h2>AIs plugged in</h2><div class="mut" id="bud"></div><table><tbody id="pv"></tbody></table>
    <div class="mut">At most one editor and one steward are awake. Waking one puts the previous holder to sleep.</div>
  </div>
  <div class="card"><h2>Tell the steward what to do</h2>
    <div class="row"><input id="dt" placeholder="e.g. fix the login bug where sessions expire" style="flex:3"><input id="dc" placeholder="contract id (optional)" style="flex:1"><button id="dgo">Compile and queue</button></div>
    <pre id="dout" hidden></pre><table><tbody id="qu"></tbody></table>
  </div>
  <div class="card"><h2>Steward review</h2><pre id="rv" style="max-height:200px">&hellip;</pre></div>
</section>
</main>

<nav>
  <button data-tab="projects" class="on"><span class="ic">&#9634;</span>Projects</button>
  <button data-tab="history"><span class="ic">&#8986;</span>History</button>
  <button data-tab="why"><span class="ic">&#63;</span>Why<span class="pill" id="whypill" hidden></span></button>
  <button data-tab="rules"><span class="ic">&#9873;</span>Rules</button>
  <button data-tab="contracts"><span class="ic">&#9745;</span>Contracts</button>
  <button data-tab="ais"><span class="ic">&#9673;</span>AIs</button>
</nav>

<script>
const tok=new URLSearchParams(location.hash.slice(1)).get("token");
let tab=(location.hash.match(/tab=([a-z]+)/)||[])[1]||"projects";
history.replaceState(null,"",location.pathname+location.search);
const $=id=>document.getElementById(id);
const esc=s=>String(s==null?"":s).replace(/[&<>"]/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;"}[c]));
let proj=new URLSearchParams(location.search).get("project")||"";

async function api(p,o){o=o||{};const h={"content-type":"application/json","x-handoff":"1"};if(tok)h.authorization="Bearer "+tok;
  const u=proj?p+(p.indexOf("?")>=0?"&":"?")+"project="+encodeURIComponent(proj):p;
  const r=await fetch(u,Object.assign({},o,{headers:h}));const j=await r.json();
  if(r.status===401){$("login").hidden=false;throw new Error("login required")}
  if(!r.ok)throw new Error(j.error||r.status);return j}

const CF=c=>'<span class="cf cf-'+c+'">'+c+'</span>';
const dur=ms=>ms<60000?"under a minute":(ms<3600000?Math.round(ms/60000)+"m":Math.floor(ms/3600000)+"h "+Math.round(ms%3600000/60000)+"m");
const clock=t=>new Date(t).toLocaleTimeString([],{hour:"2-digit",minute:"2-digit"});
const ago=t=>{if(!t)return"never";const d=(Date.now()-new Date(t))/1000;
  if(d<90)return"just now";if(d<5400)return Math.round(d/60)+"m ago";if(d<172800)return Math.round(d/3600)+"h ago";return Math.round(d/86400)+"d ago"};
const prov=e=>(e.rationale&&e.rationale.provenance)||"absent";

/* The handshake, on one line under the action: what was asked, what the actor said, who approved. */
function whyLine(e){
  const r=e.rationale;if(!r||prov(e)==="absent")return"";
  const bits=[];
  if(r.ask)bits.push("<b>asked:</b> "+esc(r.ask));
  if(r.reason)bits.push("<b>said:</b> "+esc(r.reason));
  if(r.approvedBy)bits.push("<b>approved by:</b> "+esc(r.approvedBy));
  if(!bits.length)return"";
  return '<div class="why">'+bits.join(" &middot; ")+"</div>";
}

/* ---------- tabs ---------- */
function show(t){tab=t;
  for(const s of document.querySelectorAll(".view"))s.classList.toggle("on",s.id==="v-"+t);
  for(const b of document.querySelectorAll("nav button"))b.classList.toggle("on",b.dataset.tab===t);
  refresh(t)}
for(const b of document.querySelectorAll("nav button"))b.onclick=()=>show(b.dataset.tab);

/* ---------- projects ---------- */
async function loadProjects(){
  const s=await api("/api/summary");
  $("sub").textContent="Current AI: "+(s.currentAi||"none")+"  \\u00b7  AI history: "+((s.aiTrail||[]).join(" \\u2192 ")||"none");
  const st=[["actions",s.events],["by AI",s.aiEvents],["by you",s.humanEvents],["approved",(s.approvals||{}).approved||0],["denied",(s.approvals||{}).denied||0],["ledger",s.verify.ok?"intact":"BROKEN"]];
  $("stats").innerHTML=st.map(kv=>'<div class="stat"><b class="'+(kv[0]==="ledger"&&kv[1]==="BROKEN"?"denied":"")+'">'+esc(kv[1])+'</b><span>'+kv[0]+"</span></div>").join("");

  let ps=[];try{ps=await api("/api/projects")}catch(x){}
  $("psel").innerHTML='<option value="">this project</option>'+ps.map(p=>'<option value="'+esc(p.name)+'"'+(p.name===proj?" selected":"")+">"+esc(p.name)+"</option>").join("");
  $("plist").innerHTML=ps.length?ps.map(p=>{
    const chain=p.chain==="intact"?'<span class="approved">intact</span>':'<span class="denied">'+esc(p.chain)+"</span>";
    const cov='<div class="row" style="gap:6px;align-items:center"><span class="bar"><i style="width:'+p.coverage+'%"></i></span><span class="mut">'+p.coverage+"%</span></div>";
    return '<tr class="prow" data-proj="'+esc(p.name)+'"><td><b>'+esc(p.name)+'</b><div class="mut">'+esc(p.root)+"</div></td><td>"+p.events+"</td><td>"+esc(ago(p.lastActivity))+"</td><td>"+esc((p.ais||[]).join(", ")||"\\u2014")+"</td><td>"+cov+"</td><td>"+chain+"</td></tr>"}).join("")
    :'<tr><td colspan="6" class="mut">No projects registered yet.</td></tr>';

  let ls=[];try{ls=await api("/api/lessons")}catch(x){}
  $("lessons").innerHTML=ls.length?ls.map(x=>"<div>&bull; "+esc(x.text)+' <span class="tag">'+esc(x.projects.join(", "))+"</span></div>").join(""):"none yet (register two or more projects, then run consolidate)";
}

/* ---------- history: days ---------- */
let hDay=null,dayCursor=null;
async function loadDays(append){
  const r=await api("/api/days?limit=60"+(append&&dayCursor?"&before="+encodeURIComponent(dayCursor):""));
  const d=r.days||[];
  if(!d.length&&!append){$("hdays").innerHTML='<span class="mut">no history yet</span>';return}
  const html=d.map(x=>'<span class="daybtn'+(x.date===hDay?" on":"")+'" data-d="'+x.date+'">'+x.date+' <span class="mut">'+x.events+"</span></span>").join("");
  if(append)$("hdays").insertAdjacentHTML("beforeend",html);else $("hdays").innerHTML=html;
  dayCursor=r.nextBefore;
  $("hmoredays").innerHTML=dayCursor?'<button class="sec" id="moredays" style="margin-top:8px">Earlier days</button>':"";
  if($("moredays"))$("moredays").onclick=()=>loadDays(true);
  for(const b of $("hdays").querySelectorAll(".daybtn"))b.onclick=()=>{$("hdate").value=b.dataset.d;showDay(b.dataset.d)};
  if(!hDay&&d.length){$("hdate").value=d[0].date;showDay(d[0].date)}
}
async function showDay(date){
  hDay=date;
  for(const b of $("hdays").querySelectorAll(".daybtn"))b.classList.toggle("on",b.dataset.d===date);
  const idle=$("hidle").value;
  const r=await api("/api/day?date="+encodeURIComponent(date)+(idle?"&idle="+idle:""));
  if(!r.events){$("hsum").textContent="Nothing was recorded on "+date+".";$("hbody").innerHTML="";return}
  const who=r.byAi.map(a=>"<b>"+esc(a.name)+"</b> "+dur(a.durationMs)+" ("+a.events+" actions, "+a.files+" files)").join(" &middot; ");
  const c=r.confidence;
  $("hsum").innerHTML=r.events+" actions in "+r.sessions.length+" session(s) &mdash; "+who
    +'<div style="margin-top:4px">attribution: '+c.exact+" exact, "+c.inferred+" inferred, "+c.unattributed+" unattributed"
    +(r.reversed?" &middot; "+r.reversed+" later undone":"")+"</div>";
  $("hbody").innerHTML=r.sessions.map(sx=>{
    const acts=Object.keys(sx.actions).map(k=>esc(k)+" &times;"+sx.actions[k]).join(", ");
    const files=sx.files.length?"<li>files: "+sx.files.slice(0,10).map(f=>"<code>"+esc(f)+"</code>").join(" ")+(sx.files.length>10?' <span class="mut">+'+(sx.files.length-10)+" more</span>":"")+"</li>":"";
    const cmds=sx.commands.length?"<li>commands: "+sx.commands.slice(0,5).map(x=>"<code>"+esc(x.slice(0,80))+"</code>").join(" ")+"</li>":"";
    const mix=Object.keys(sx.confidence).filter(k=>sx.confidence[k]>0).map(k=>CF(k)+'<span class="mut">'+sx.confidence[k]+"</span>").join(" ");
    const span=sx.observed==="single-event"?'<span class="mut"> (one action, no span)</span>':"";
    const via=sx.aiInUse&&sx.actor.kind!=="ai"?' <span class="mut">via '+esc(sx.aiInUse)+"</span>":"";
    const undone=sx.reversed?'<li class="denied">'+sx.reversed+" of these were later undone</li>":"";
    return '<div class="sess '+esc(sx.actor.kind)+'"><h4>'+esc(sx.actor.name)+via+" "+mix+"</h4>"
      +'<div class="when">'+clock(sx.start)+" &ndash; "+clock(sx.end)+" &middot; "+dur(sx.durationMs)+span+"</div>"
      +"<ul><li>"+acts+"</li>"+files+cmds+undone+"</ul></div>"}).join("");
}

/* ---------- history: the event stream, paged back to the first memory ---------- */
let evCursor=null,evDone=false;
function evQuery(){let q="/api/events?limit=100";
  if($("fprov").value)q+="&provenance="+encodeURIComponent($("fprov").value);
  if($("factor").value.trim())q+="&actor="+encodeURIComponent($("factor").value.trim());
  return q}
function evRow(e){
  const who=esc(e.actor.kind+":"+e.actor.name)+CF(e.confidence||(e.actor.kind==="unknown"?"unattributed":"exact"));
  const what=esc(e.action)+' <span class="mut">'+esc(e.target||e.summary||"")+"</span>"+CF(prov(e));
  return '<tr class="'+(e.reversed?"rev":"")+'"><td>'+e.seq+"</td><td>"+esc(String(e.ts).slice(0,10))+" "+esc(String(e.ts).slice(11,19))
    +'</td><td class="'+e.actor.kind+'">'+who+"</td><td>"+what+whyLine(e)
    +'</td><td class="'+e.approval.status+'">'+esc(e.approval.status==="unknown"?"":e.approval.status)+"</td><td>"
    +(e.delta===1&&!e.reversed?'<button class="sec" data-undo="'+e.id+'">undo</button>':"")+"</td></tr>"}
async function loadEvents(append){
  if(append&&evDone)return;
  const r=await api(evQuery()+(append&&evCursor!==null?"&before="+evCursor:""));
  const html=r.events.map(evRow).join("");
  if(append)$("ev").insertAdjacentHTML("beforeend",html);else $("ev").innerHTML=html||'<tr><td colspan="6" class="mut">nothing matches</td></tr>';
  evCursor=r.nextBefore;evDone=r.nextBefore===null;
  $("older").disabled=evDone;
  $("older").textContent=evDone?"That is the first memory logged":"Load older";
  $("evcount").textContent=$("ev").querySelectorAll("tr").length+" shown of "+r.total;
}

/* ---------- why ---------- */
let whyCursor=null,whyDone=false;
function whyRow(e){
  return '<tr><td>'+e.seq+"</td><td>"+esc(String(e.ts).slice(0,10))+" "+esc(String(e.ts).slice(11,19))
    +'</td><td class="'+e.actor.kind+'">'+esc(e.actor.name)+"</td><td>"+esc(e.action)+' <span class="mut">'+esc(e.target||e.summary||"")
    +'</span></td><td><div class="row" style="gap:6px"><input placeholder="why did this happen?" data-wid="'+e.id+'" style="flex:1;padding:4px 8px"><button class="sec" data-wsave="'+e.id+'">Save</button></div></td></tr>'}
async function loadWhy(append){
  if(append&&whyDone)return;
  const r=await api("/api/why?limit=50"+(append&&whyCursor!==null?"&before="+whyCursor:""));
  const html=r.events.map(whyRow).join("");
  if(append)$("whylist").insertAdjacentHTML("beforeend",html);else $("whylist").innerHTML=html||'<tr><td colspan="5" class="mut">Every action on record explains itself.</td></tr>';
  whyCursor=r.nextBefore;whyDone=r.nextBefore===null;
  $("whyolder").disabled=whyDone;
  const pct=r.total?Math.round((1-r.unexplained/r.total)*100):100;
  $("whysum").textContent=r.unexplained+" of "+r.total+" actions have no reason recorded ("+pct+"% explained).";
  const pill=$("whypill");
  if(r.unexplained){pill.hidden=false;pill.textContent=r.unexplained>999?"999+":r.unexplained}else pill.hidden=true;
}

/* ---------- rules, contracts, ais ---------- */
async function loadRules(){
  const gs=await api("/api/guardrails");
  $("gr").innerHTML=gs.length?gs.map(g=>'<tr><td class="'+(g.level==="block"?"denied":"mut")+'">'+g.level+"</td><td>"+esc(g.text)+'</td><td class="mut">'+esc(g.match.kind+": "+g.match.pattern)+'</td><td><button class="sec" data-undo="'+g.id+'">remove</button></td></tr>').join(""):'<tr><td class="mut">no guardrails yet</td></tr>';
}
async function loadContracts(){
  const cs=await api("/api/contracts");
  $("ct").innerHTML=cs.length?cs.map(c=>'<div style="margin-bottom:12px"><b>'+esc(c.id)+'</b> <span class="tag '+(c.audit.verdict==="drifting"?"denied":c.audit.verdict==="complete"?"approved":"")+'">'+c.audit.verdict+"</span> "+esc(c.goal)
    +'<div class="mut">'+c.acceptance.map((a,i)=>(c.audit.accepted.indexOf(i)>=0?"\\u2611 ":"\\u2610 ")+esc(a)+(c.audit.accepted.indexOf(i)>=0?"":' <a href="#" data-acc="'+esc(c.id)+":"+i+'">confirm</a>')).join(" &middot; ")+"</div>"
    +(c.audit.outOfScope.length?'<div class="denied">out of scope: '+c.audit.outOfScope.map(o=>esc(o.target+" ("+o.who+")")).join(", ")+"</div>":"")
    +' <a href="#" data-close="'+esc(c.id)+'">close</a></div>').join(""):"none open";
}
async function loadAis(){
  const pv=await api("/api/providers");
  $("bud").textContent="Tokens today: "+pv.usedToday+" of "+pv.dailyTokens;
  $("pv").innerHTML=pv.providers.length?pv.providers.map(p=>"<tr><td><b>"+esc(p.name)+'</b> <span class="mut">'+esc(p.kind+"/"+p.model)+'</span></td><td class="'+(p.role==="asleep"?"mut":"approved")+'">'+p.role+"</td><td>"+(p.keySet?"":'<span class="denied">key missing</span>')+"</td><td>"
    +(p.role==="asleep"?'<button class="sec" data-wake="'+esc(p.name)+':editor">wake as editor</button> <button class="sec" data-wake="'+esc(p.name)+':steward">wake as steward</button>':'<button class="sec" data-sleep="'+esc(p.name)+'">sleep</button>')+"</td></tr>").join("")
    :'<tr><td class="mut">none yet. Add one: handoff providers add &hellip;</td></tr>';
  const qu=await api("/api/queue");
  $("qu").innerHTML=qu.slice(-8).reverse().map(q=>'<tr><td class="'+(q.status==="pending-approval"?"denied":"mut")+'">'+q.status+(q.remote?" (remote)":"")+"</td><td>"+esc(q.task)+'</td><td class="mut">'+esc(q.arm)+"</td><td>"
    +(q.status==="pending-approval"?'<button class="sec" data-approve="'+q.id+'">approve</button>':q.status==="taken"?'<button class="sec" data-fin="'+q.id+'">mark finished</button>':"")+"</td></tr>").join("");
  const rv=await api("/api/review");$("rv").textContent=rv.text;
}

/* ---------- refresh ---------- */
async function refresh(which){
  try{
    if(which==="projects")await loadProjects();
    if(which==="history"){await loadDays(false);await loadEvents(false)}
    if(which==="why")await loadWhy(false);
    if(which==="rules")await loadRules();
    if(which==="contracts")await loadContracts();
    if(which==="ais")await loadAis();
    $("err").textContent=""
  }catch(x){$("err").textContent=x.message}
}
/* The Why badge is the health number, so it stays current whichever tab is open. */
async function pollBadge(){try{const r=await api("/api/why?limit=1");const p=$("whypill");
  if(r.unexplained){p.hidden=false;p.textContent=r.unexplained>999?"999+":r.unexplained}else p.hidden=true}catch(x){}}

/* ---------- actions ---------- */
async function doLogin(){const r=await fetch("/login",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({password:$("pw").value})});
  const j=await r.json();if(r.ok){$("login").hidden=true;$("pw").value="";refresh(tab)}else $("lerr").textContent=j.error+(j.retryAfterSec?" (try again in "+j.retryAfterSec+"s)":"")}
$("lgo").onclick=doLogin;$("pw").onkeydown=e=>{if(e.key==="Enter")doLogin()};

$("psel").onchange=()=>{proj=$("psel").value;hDay=null;dayCursor=null;evCursor=null;evDone=false;refresh(tab)};
$("hgo").onclick=()=>$("hdate").value&&showDay($("hdate").value);
$("hidle").onchange=()=>hDay&&showDay(hDay);
$("older").onclick=()=>loadEvents(true).catch(x=>$("err").textContent=x.message);
$("whyolder").onclick=()=>loadWhy(true).catch(x=>$("err").textContent=x.message);
$("fgo").onclick=()=>{evCursor=null;evDone=false;loadEvents(false).catch(x=>$("err").textContent=x.message)};
$("fprov").onchange=()=>$("fgo").click();

document.addEventListener("click",async e=>{
  const t=e.target.dataset||{};
  try{
    if(t.proj!==undefined&&e.target.closest(".prow")){proj=e.target.closest(".prow").dataset.proj;$("psel").value=proj;hDay=null;dayCursor=null;evCursor=null;evDone=false;show("history");return}
    if(t.undo){await api("/api/reverse",{method:"POST",body:JSON.stringify({id:t.undo,by:"human"})});refresh(tab)}
    if(t.wake){const p=t.wake.split(":");await api("/api/providers/wake",{method:"POST",body:JSON.stringify({name:p[0],role:p[1]})});refresh(tab)}
    if(t.sleep){await api("/api/providers/sleep",{method:"POST",body:JSON.stringify({name:t.sleep})});refresh(tab)}
    if(t.approve){await api("/api/queue/approve",{method:"POST",body:JSON.stringify({id:t.approve})});refresh(tab)}
    if(t.fin){await api("/api/queue/finish",{method:"POST",body:JSON.stringify({id:t.fin})});refresh(tab)}
    if(t.acc){e.preventDefault();const p=t.acc.split(":");await api("/api/contracts/accept",{method:"POST",body:JSON.stringify({id:p[0],item:+p[1]})});refresh(tab)}
    if(t.close){e.preventDefault();await api("/api/contracts/close",{method:"POST",body:JSON.stringify({id:t.close})});refresh(tab)}
    if(t.wsave){const inp=document.querySelector('[data-wid="'+t.wsave+'"]');if(inp&&inp.value.trim()){
      await api("/api/why",{method:"POST",body:JSON.stringify({id:t.wsave,reason:inp.value.trim(),by:"human"})});whyCursor=null;whyDone=false;loadWhy(false)}}
  }catch(x){$("err").textContent=x.message}
});

$("gadd").onclick=async()=>{try{await api("/api/guardrails",{method:"POST",body:JSON.stringify({text:$("gt").value,level:$("gl").value,match:{kind:$("gk").value,pattern:$("gp").value}})});$("gt").value=$("gp").value="";loadRules()}catch(x){$("err").textContent=x.message}};
$("cadd").onclick=async()=>{const sp=v=>v.split(";").map(x=>x.trim()).filter(Boolean);
  try{await api("/api/contracts",{method:"POST",body:JSON.stringify({id:$("ci").value,goal:$("cg").value,acceptance:sp($("ca").value),inScope:sp($("cs").value)})});
  $("ci").value=$("cg").value=$("ca").value=$("cs").value="";loadContracts()}catch(x){$("err").textContent=x.message}};
$("dgo").onclick=async()=>{try{const r=await api("/api/dispatch",{method:"POST",body:JSON.stringify({task:$("dt").value,contract:$("dc").value||undefined})});
  $("dout").hidden=false;$("dout").textContent="["+r.status+" \\u00b7 "+r.arm+" \\u00b7 "+r.tokens+" tokens from "+r.sourceTokens+(r.via==="llm"?" \\u00b7 compressed by the steward AI":(r.why?" \\u00b7 AI draft rejected: "+r.why:""))+"]\\n\\n"+r.prompt;
  $("dt").value="";loadAis()}catch(x){$("err").textContent=x.message}};
$("go").onclick=async()=>{const to=$("to").value.trim();if(!to)return;$("go").disabled=true;
  try{const r=await api("/api/switch",{method:"POST",body:JSON.stringify({to,target:$("target").value,write:$("write").checked})});
  $("brief").hidden=false;$("brief").textContent=r.text;const v=r.verification,m=r.metrics;
  $("vr").textContent=(v.pass?"\\u2714 verified":"\\u2718 NOT verified")+" \\u2014 "+v.statement+"  |  "+m.briefTokens+" tokens from "+m.rawTokens+" ("+m.compressionRatio.toFixed(1)+"x), hard rules kept "+m.hardKept+"/"+m.hardTotal+(r.wrote?"  |  wrote "+r.wrote:"");
  loadAis()}catch(x){$("err").textContent=x.message}$("go").disabled=false};

show(tab);pollBadge();setInterval(()=>{pollBadge();if(tab==="projects")loadProjects().catch(x=>{})},8000);
</script></body></html>`;
