// Single-file dashboard. No external requests. The token arrives in the URL fragment (never sent to the server in a request line).
export const UI_HTML = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Handoff Ledger</title>
<style>
:root{--bg:#fafaf8;--fg:#1d1d1b;--mut:#6b6b66;--card:#fff;--line:#e4e3de;--acc:#2f5fd0;--ok:#1f7a45;--bad:#b3261e;--warn:#9a6700}
@media(prefers-color-scheme:dark){:root{--bg:#161615;--fg:#ececea;--mut:#9a9a94;--card:#1f1f1d;--line:#33332f;--acc:#7ea2ff;--ok:#5fcf8f;--bad:#ff8a80;--warn:#e0b04a}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--fg);font:15px/1.5 system-ui,sans-serif}
main{max-width:1040px;margin:0 auto;padding:20px 16px 60px}h1{font-size:20px;margin:0 0 4px}h2{font-size:14px;text-transform:uppercase;letter-spacing:.06em;color:var(--mut);margin:0 0 10px}
.card{background:var(--card);border:1px solid var(--line);border-radius:10px;padding:16px;margin-top:16px}
.row{display:flex;gap:12px;flex-wrap:wrap}.stat{flex:1 1 140px}.stat b{display:block;font-size:24px}.stat span{color:var(--mut);font-size:13px}
table{width:100%;border-collapse:collapse;font-size:13px}td,th{text-align:left;padding:6px 8px;border-bottom:1px solid var(--line);vertical-align:top}th{color:var(--mut);font-weight:500}
.tag{display:inline-block;padding:1px 8px;border-radius:99px;border:1px solid var(--line);font-size:12px}.human{color:var(--acc)}.ai{color:var(--warn)}.approved{color:var(--ok)}.denied{color:var(--bad)}
button,select,input{font:inherit;color:var(--fg);background:var(--card);border:1px solid var(--line);border-radius:8px;padding:8px 12px}button{cursor:pointer;background:var(--acc);color:#fff;border:0}button.sec{background:var(--card);color:var(--fg);border:1px solid var(--line)}
pre{white-space:pre-wrap;background:var(--bg);border:1px solid var(--line);border-radius:8px;padding:12px;max-height:380px;overflow:auto;font-size:13px}
.mut{color:var(--mut)}.rev{text-decoration:line-through;opacity:.55}#err{color:var(--bad)}
</style></head><body><main>
<div id="login" class="card" hidden><h2>Sign in</h2><div class="row"><input id="pw" type="password" placeholder="password" autocomplete="current-password"><button id="lgo">Sign in</button></div><div id="lerr" class="denied"></div></div>
<h1>Handoff Ledger</h1><div class="mut" id="sub">connecting…</div><div id="err"></div>
<div class="card"><div class="row" id="stats"></div></div>
<div class="card"><h2>Switch AI</h2>
<div class="row"><input id="to" placeholder="new AI, e.g. copilot" list="ais"><datalist id="ais"><option>claude-code<option>copilot<option>codex<option>gemini<option>cursor</datalist>
<select id="target"><option value="claude-md">CLAUDE.md</option><option value="agents-md">AGENTS.md</option><option value="system-prompt">system prompt</option><option value="mcp-json">MCP JSON</option></select>
<label class="mut"><input type="checkbox" id="write"> write file into project</label><button id="go">Switch and generate brief</button></div>
<div id="vr" class="mut" style="margin-top:10px"></div><pre id="brief" hidden></pre></div>
<div class="card"><h2>AIs plugged in</h2><div class="mut" id="bud"></div><table><tbody id="pv"></tbody></table><div class="mut">At most one editor and one steward are awake. Waking one puts the previous holder to sleep.</div></div>
<div class="card"><h2>Tell the steward what to do</h2><div class="row"><input id="dt" placeholder="e.g. fix the login bug where sessions expire" style="flex:3"><input id="dc" placeholder="contract id (optional)" style="flex:1"><button id="dgo">Compile and queue</button></div><pre id="dout" hidden></pre><table><tbody id="qu"></tbody></table></div>
<div class="card"><h2>Steward review</h2><pre id="rv" style="max-height:200px">…</pre></div>
<div class="card"><h2>Across projects</h2><div id="lessons" class="mut">none yet</div></div>
<div class="card"><h2>Guardrails (all AIs)</h2><table><tbody id="gr"></tbody></table>
<div class="row" style="margin-top:10px"><input id="gt" placeholder="rule in plain words" style="flex:2"><select id="gk"><option value="command">command (regex)</option><option value="path">path (glob)</option><option value="action">action</option></select><input id="gp" placeholder="pattern" style="flex:1"><select id="gl"><option value="block">block</option><option value="advise">advise</option></select><button id="gadd">Add</button></div></div>
<div class="card"><h2>Task contracts: asked vs done</h2><div id="ct" class="mut">none open</div>
<div class="row" style="margin-top:10px"><input id="ci" placeholder="id e.g. login-limit" style="flex:1"><input id="cg" placeholder="goal" style="flex:2"><input id="ca" placeholder="done when (a;b)" style="flex:2"><input id="cs" placeholder="only touch (src/**;test/**)" style="flex:2"><button id="cadd">Open</button></div></div>
<div class="card"><h2>Recent events</h2><table><thead><tr><th>#</th><th>time</th><th>who</th><th>AI in use</th><th>action</th><th>approval</th><th></th></tr></thead><tbody id="ev"></tbody></table></div>
</main><script>
const tok=new URLSearchParams(location.hash.slice(1)).get("token");history.replaceState(null,"",location.pathname);
const $=id=>document.getElementById(id);const esc=s=>String(s??"").replace(/[&<>"]/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;"}[c]));
const proj=new URLSearchParams(location.search).get("project");
async function api(p,o={}){const h={"content-type":"application/json","x-handoff":"1"};if(tok)h.authorization="Bearer "+tok;const u=proj?p+(p.includes("?")?"&":"?")+"project="+encodeURIComponent(proj):p;const r=await fetch(u,{...o,headers:h});const j=await r.json();if(r.status===401){showLogin();throw new Error("login required")}if(!r.ok)throw new Error(j.error||r.status);return j}
function showLogin(){$("login").hidden=false}
async function doLogin(){const r=await fetch("/login",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({password:$("pw").value})});const j=await r.json();if(r.ok){$("login").hidden=true;$("pw").value="";load()}else $("lerr").textContent=j.error+(j.retryAfterSec?" (try again in "+j.retryAfterSec+"s)":"")}
async function load(){try{
const s=await api("/api/summary"),ev=await api("/api/events?limit=60");
$("sub").textContent="Current AI: "+(s.currentAi||"none")+"  ·  AI history: "+(s.aiTrail.join(" → ")||"none");
$("stats").innerHTML=[["events",s.events],["by AI",s.aiEvents],["by human",s.humanEvents],["approved",s.approvals.approved||0],["denied",s.approvals.denied||0],["ledger",s.verify.ok?"intact":"BROKEN"]].map(([k,v])=>'<div class="stat"><b class="'+(k=="ledger"&&v=="BROKEN"?"denied":"")+'">'+esc(v)+'</b><span>'+k+'</span></div>').join("");
$("ev").innerHTML=ev.map(e=>'<tr class="'+(e.reversed?"rev":"")+'"><td>'+e.seq+'</td><td>'+esc(e.ts.slice(11,19))+'</td><td class="'+e.actor.kind+'">'+esc(e.actor.kind+":"+e.actor.name)+'</td><td>'+esc(e.aiInUse||"")+'</td><td>'+esc(e.action)+' <span class="mut">'+esc(e.target||e.summary||"")+'</span></td><td class="'+e.approval.status+'">'+esc(e.approval.status==="unknown"?"":e.approval.status)+'</td><td>'+(e.delta===1&&!e.reversed?'<button class="sec" data-undo="'+e.id+'">undo</button>':"")+'</td></tr>').join("");
const pv=await api("/api/providers");$("bud").textContent="Tokens today: "+pv.usedToday+" of "+pv.dailyTokens;$("pv").innerHTML=pv.providers.length?pv.providers.map(p=>'<tr><td><b>'+esc(p.name)+'</b> <span class="mut">'+esc(p.kind+"/"+p.model)+'</span></td><td class="'+(p.role==="asleep"?"mut":"approved")+'">'+p.role+'</td><td>'+(p.keySet?"":'<span class="denied">key missing</span>')+'</td><td>'+(p.role==="asleep"?'<button class="sec" data-wake="'+esc(p.name)+':editor">wake as editor</button> <button class="sec" data-wake="'+esc(p.name)+':steward">wake as steward</button>':'<button class="sec" data-sleep="'+esc(p.name)+'">sleep</button>')+'</td></tr>').join(""):'<tr><td class="mut">none yet. Add one: handoff providers add …</td></tr>';
const qu=await api("/api/queue");$("qu").innerHTML=qu.slice(-8).reverse().map(q=>'<tr><td class="'+(q.status==="pending-approval"?"denied":"mut")+'">'+q.status+(q.remote?" (remote)":"")+'</td><td>'+esc(q.task)+'</td><td class="mut">'+esc(q.arm)+'</td><td>'+(q.status==="pending-approval"?'<button class="sec" data-approve="'+q.id+'">approve</button>':q.status==="taken"?'<button class="sec" data-fin="'+q.id+'">mark finished</button>':"")+'</td></tr>').join("");
const rv=await api("/api/review");$("rv").textContent=rv.text;
const ls=await api("/api/lessons");$("lessons").innerHTML=ls.length?ls.map(x=>'<div>• '+esc(x.text)+' <span class="tag">'+esc(x.projects.join(", "))+'</span></div>').join(""):"none yet (run consolidate from the CLI after registering two or more projects)";
const gs=await api("/api/guardrails");$("gr").innerHTML=gs.length?gs.map(g=>'<tr><td class="'+(g.level==="block"?"denied":"mut")+'">'+g.level+'</td><td>'+esc(g.text)+'</td><td class="mut">'+esc(g.match.kind+": "+g.match.pattern)+'</td><td><button class="sec" data-undo="'+g.id+'">remove</button></td></tr>').join(""):'<tr><td class="mut">no guardrails yet</td></tr>';
const cs=await api("/api/contracts");$("ct").innerHTML=cs.length?cs.map(c=>'<div style="margin-bottom:12px"><b>'+esc(c.id)+'</b> <span class="tag '+(c.audit.verdict==="drifting"?"denied":c.audit.verdict==="complete"?"approved":"")+'">'+c.audit.verdict+'</span> '+esc(c.goal)+'<div class="mut">'+c.acceptance.map((a,i)=>(c.audit.accepted.includes(i)?"☑ ":"☐ ")+esc(a)+(c.audit.accepted.includes(i)?"":' <a href="#" data-acc="'+esc(c.id)+':'+i+'">confirm</a>')).join(" · ")+'</div>'+(c.audit.outOfScope.length?'<div class="denied">out of scope: '+c.audit.outOfScope.map(o=>esc(o.target+" ("+o.who+")")).join(", ")+'</div>':"")+' <a href="#" data-close="'+esc(c.id)+'">close</a></div>').join(""):"none open";
$("err").textContent=""}catch(x){$("err").textContent=x.message}}
document.addEventListener("click",async e=>{const id=e.target.dataset&&e.target.dataset.undo;if(id){await api("/api/reverse",{method:"POST",body:JSON.stringify({id,by:"human"})});load()}});
$("lgo").onclick=doLogin;$("pw").onkeydown=e=>{if(e.key==="Enter")doLogin()};
$("dgo").onclick=async()=>{try{const r=await api("/api/dispatch",{method:"POST",body:JSON.stringify({task:$("dt").value,contract:$("dc").value||undefined})});$("dout").hidden=false;$("dout").textContent="["+r.status+" · "+r.arm+" · "+r.tokens+" tokens from "+r.sourceTokens+(r.via==="llm"?" · compressed by the steward AI":(r.why?" · AI draft rejected: "+r.why:""))+"]\\n\\n"+r.prompt;$("dt").value="";load()}catch(x){$("err").textContent=x.message}};
document.addEventListener("click",async e=>{const t=e.target.dataset||{};try{
if(t.wake){const[n,r]=t.wake.split(":");await api("/api/providers/wake",{method:"POST",body:JSON.stringify({name:n,role:r})});load()}
if(t.sleep){await api("/api/providers/sleep",{method:"POST",body:JSON.stringify({name:t.sleep})});load()}
if(t.approve){await api("/api/queue/approve",{method:"POST",body:JSON.stringify({id:t.approve})});load()}
if(t.fin){await api("/api/queue/finish",{method:"POST",body:JSON.stringify({id:t.fin})});load()}
}catch(x){$("err").textContent=x.message}
if(t.acc){e.preventDefault();const[id,i]=t.acc.split(":");await api("/api/contracts/accept",{method:"POST",body:JSON.stringify({id,item:+i})});load()}if(t.close){e.preventDefault();await api("/api/contracts/close",{method:"POST",body:JSON.stringify({id:t.close})});load()}});
$("gadd").onclick=async()=>{try{await api("/api/guardrails",{method:"POST",body:JSON.stringify({text:$("gt").value,level:$("gl").value,match:{kind:$("gk").value,pattern:$("gp").value}})});$("gt").value=$("gp").value="";load()}catch(x){$("err").textContent=x.message}};
$("cadd").onclick=async()=>{const sp=v=>v.split(";").map(x=>x.trim()).filter(Boolean);try{await api("/api/contracts",{method:"POST",body:JSON.stringify({id:$("ci").value,goal:$("cg").value,acceptance:sp($("ca").value),inScope:sp($("cs").value)})});$("ci").value=$("cg").value=$("ca").value=$("cs").value="";load()}catch(x){$("err").textContent=x.message}};
$("go").onclick=async()=>{const to=$("to").value.trim();if(!to)return;$("go").disabled=true;try{
const r=await api("/api/switch",{method:"POST",body:JSON.stringify({to,target:$("target").value,write:$("write").checked})});
$("brief").hidden=false;$("brief").textContent=r.text;const v=r.verification,m=r.metrics;
$("vr").textContent=(v.pass?"✔ verified":"✘ NOT verified")+" — "+v.statement+"  |  "+m.briefTokens+" tokens from "+m.rawTokens+" ("+m.compressionRatio.toFixed(1)+"x), hard rules kept "+m.hardKept+"/"+m.hardTotal+(r.wrote?"  |  wrote "+r.wrote:"");
load()}catch(x){$("err").textContent=x.message}$("go").disabled=false};
load();setInterval(load,4000);
</script></body></html>`;
