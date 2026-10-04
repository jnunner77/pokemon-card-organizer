(() => {
"use strict";
const $ = (s, r = document) => r.querySelector(s);
const esc = v => String(v ?? "").replace(/[&<>"']/g, c => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));
const rid = () => (crypto.randomUUID ? crypto.randomUUID().replace(/-/g,"").slice(0,16) : Math.random().toString(36).slice(2,14));
const today = () => new Date().toLocaleDateString("en-CA");
const nowISO = () => new Date().toISOString();
const store = { get(k,d){ try{ const v = localStorage.getItem("bl:"+k); return v==null?d:JSON.parse(v);}catch(e){return d;} }, set(k,v){ try{ localStorage.setItem("bl:"+k, JSON.stringify(v)); }catch(e){} } };

const BINDER_COLORS = ["#F2B705","#D8432F","#2F6FD8","#2E9B5E","#7B4BC9","#2A2F36","#E07A1F","#D14C8A"];
const POCKETS = {4:{cols:2}, 9:{cols:3}, 12:{cols:4}, 16:{cols:4}};
const STATUSES = [["binder","In binder"],["listed","Listed for sale"],["grading","Out for grading"],["sold","Sold"],["traded","Traded"]];
const PTYPES = [["market","Market price"],["comp","Sold comp"],["paid","I paid"],["listed","My listing"],["mysale","I sold it"]];
const RARITIES = ["Common","Uncommon","Rare","Holo Rare","Double Rare","Ultra Rare","Illustration Rare","Special Illustration Rare","Hyper Rare","Mega Hyper Rare","ACE SPEC Rare","Shiny Rare","Secret Rare","Promo","Other"];
const CONDITIONS = ["Near Mint","Lightly Played","Moderately Played","Heavily Played","Damaged"];
const GRADERS = ["Raw","PSA","CGC","BGS","TAG","ACE"];
const LANGS = ["English","Japanese","Korean","Chinese (Traditional)","Chinese (Simplified)","Other"];

const S = {
  db:null, assets:null, downloads:null, mode:"loading",
  binders:[], cards:[], settings:{usdToCad:1.37},
  binderId: null, page: 1, view: store.get("view","pages") === "list" ? "list" : "pages",
  q:"", scope: store.get("scope","binder"), sort: store.get("sort",{k:"loc",d:1}),
  sel:null, draft:null, dirty:false, editPrice:null, confirm:null,
  pick:null, pickConfirm:false, shown:[], found:null
};

/* ---------- money ---------- */
const fmtCAD = new Intl.NumberFormat("en-CA",{style:"currency",currency:"CAD"});
const fmtUSD = new Intl.NumberFormat("en-CA",{style:"currency",currency:"USD"});
const money = (n, cur="CAD") => n==null || isNaN(n) ? "—" : (cur==="USD" ? "US" + fmtUSD.format(n).replace("US","") : fmtCAD.format(n));
const toCAD = p => p.currency === "USD" ? p.amount * (Number(S.settings.usdToCad)||1) : p.amount;
const byDateDesc = (a,b) => (b.date||"").localeCompare(a.date||"") || (b.at||"").localeCompare(a.at||"");
const prices = c => Array.isArray(c.prices) ? c.prices.slice().sort(byDateDesc) : [];
const latestOf = (c, types) => prices(c).find(p => types.includes(p.type) && typeof p.amount === "number");
const valueOf = c => { const p = latestOf(c, ["comp","market"]); return p ? toCAD(p) : null; };
const paidOf = c => { const p = latestOf(c, ["paid"]); return p ? toCAD(p) : null; };
const soldOf = c => { const p = latestOf(c, ["mysale"]); return p ? toCAD(p) : null; };
const held = c => !["sold","traded"].includes(c.status);
/* a placeholder holds its pocket for a card not owned yet: priced, but not counted or sold */
const owned = c => held(c) && !c.placeholder;
/* sale record: quick sells store a snapshot; cards sold through the price log are worked out on the fly. Paid beats market as the cost basis. */
function costBasis(c){ const pd = paidOf(c); if(pd!=null) return {cost:pd, basis:"paid"}; const v = valueOf(c); if(v!=null) return {cost:v, basis:"market"}; return {cost:null, basis:"none"}; }
function saleInfo(c){
  if(c.sale && typeof c.sale.soldCAD === "number") return {...c.sale, quick:true};
  const sd = soldOf(c); if(sd==null) return null;
  const p = latestOf(c,["mysale"]), cb = costBasis(c);
  return {soldCAD:sd, amount:p.amount, currency:p.currency, date:p.date, where:p.where, at:p.at, cost:cb.cost, basis:cb.basis, profit: cb.cost!=null ? Math.round((sd-cb.cost)*100)/100 : null, quick:false};
}
const salesList = () => S.cards.map(c=>({c, s:saleInfo(c)})).filter(x=>x.s).sort((a,b)=>(b.s.date||"").localeCompare(a.s.date||"") || (b.s.at||"").localeCompare(a.s.at||""));
function salesTotals(){ const l = salesList(); return {n:l.length, rev:l.reduce((t,x)=>t+x.s.soldCAD,0), cost:l.reduce((t,x)=>t+(x.s.cost??0),0), profit:l.reduce((t,x)=>t+(x.s.profit??0),0), nobasis:l.filter(x=>x.s.profit==null).length}; }
const signed = n => n==null ? "—" : (n>=0?"+":"−") + money(Math.abs(n));
const BASIS_LABEL = {paid:"vs paid", market:"vs market", none:"no cost"};

/* ---------- lookups ---------- */
const binderById = id => S.binders.find(b => b.id === id);
const sortedBinders = () => S.binders.slice().sort((a,b)=>(a.order??0)-(b.order??0) || (a.name||"").localeCompare(b.name||""));
const curBinder = () => S.binderId === "__loose" || S.binderId === "__sales" ? null : binderById(S.binderId);
const cardsIn = id => S.cards.filter(c => c.binderId === id);
const looseCards = () => S.cards.filter(c => (!c.binderId || !binderById(c.binderId)) && !(c.sale && c.status==="sold"));
const cardAt = (bid, page, slot) => S.cards.find(c => c.binderId===bid && c.page===page && c.slot===slot);
const pocketsOf = b => POCKETS[b?.pockets] ? b.pockets : 9;
const maxPage = bid => Math.max(1, ...cardsIn(bid).map(c => c.page||1));
const locText = c => { const b = binderById(c.binderId); return b ? `${b.name} · Page ${c.page} · Pocket ${c.slot}` : "Not in a binder"; };
const locShort = c => { const b = binderById(c.binderId); return b ? `${b.name.replace(/^Binder\s*/i,"B")} · p${c.page} · #${c.slot}` : "Loose"; };
const metaLine = c => [c.setCode || c.set, c.number].filter(Boolean).join(" ");
/* the card Find just took you to: highlighted for a few seconds */
const isFound = id => !!S.found && S.found.id===id && Date.now() < S.found.until;
const isInline = id => typeof id==="string" && id.startsWith("data:");
const imgURL = id => !id ? "" : isInline(id) ? id : "blob/" + encodeURIComponent(id);
/* the picture to show: the official high-resolution image when there is one, unless the person picked their own photo */
const shown = c => (c.officialImageId && (c.imagePref !== "photo" || !c.imageId)) ? c.officialImageId : c.imageId;
async function delAsset(id){ if(!id || isInline(id) || !S.assets) return; return S.assets.delete(id); }
function firstFree(bid){
  const b = binderById(bid); if(!b) return null; const n = pocketsOf(b);
  for(let p=1;p<=maxPage(bid)+1;p++) for(let s=1;s<=n;s++) if(!cardAt(bid,p,s)) return {page:p, slot:s};
  return {page:maxPage(bid)+1, slot:1};
}

/* ---------- toast ---------- */
let toastT;
function toast(msg, action){
  const r = $("#toastRoot"); clearTimeout(toastT);
  r.innerHTML = `<div class="toast" role="status">${esc(msg)}${action?`<button class="toastbtn" type="button">${esc(action.label)}</button>`:""}</div>`;
  if(action) r.querySelector(".toastbtn").onclick = () => { clearTimeout(toastT); r.innerHTML = ""; action.run(); };
  toastT = setTimeout(()=> r.innerHTML="", action ? 12000 : 2600);
}
function writeErr(e){
  const code = e && e.code;
  if(code==="quota_exceeded") return toast("The ledger is full. Delete some cards to add more.");
  if(code==="invalid_argument") return toast(`That change wasn't saved${e.message?`: ${e.message}`:"."}`);
  if(code==="forbidden") return toast(e.message || "You have view-only access.");
  if(code==="revoked"||code==="not_granted") return toast("Saving isn't available in this view.");
  toast("Couldn't save. Check your connection and try again.");
  console.error(e);
}
async function guard(fn){ if(!S.db){ toast("Saving isn't available in this view."); return false; } try{ await fn(); return true; }catch(e){ writeErr(e); return false; } }

/* ---------- rendering ---------- */
function render(){
  renderBanner(); renderTabs(); renderStats(); renderMain(); renderDrawer();
}
function renderBanner(){
  const el = $("#banner");
  if(S.mode==="loading") el.innerHTML = `<div class="banner">Opening your binders…</div>`;
  else if(S.mode==="nodb") el.innerHTML = `<div class="banner" data-kind="warn">Can't reach the ledger's server, so nothing you enter here will be kept. Check your connection and reload the page.</div>`;
  else if(S.me?.user?.role==="viewer") el.innerHTML = `<div class="banner">You have view-only access. Ask an administrator if you need to make changes.</div>`;
  else el.innerHTML = "";
}
function renderTabs(){
  const loose = looseCards().length;
  const bs = sortedBinders();
  let h = bs.map(b => `<button class="tab" role="tab" type="button" data-binder="${esc(b.id)}" aria-selected="${S.binderId===b.id}" title="${S.binderId===b.id?"Click to rename or edit this binder":esc(b.name)}" style="--bc:${esc(b.color||BINDER_COLORS[0])}"><span class="swatch"></span><span>${esc(b.name)}</span><span class="count">${cardsIn(b.id).length}</span>${S.binderId===b.id?`<span class="edit" data-rename="${esc(b.id)}" title="Rename binder" aria-hidden="true"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 20h4L19 9l-4-4L4 16z"/><path d="m14 6 4 4"/></svg></span>`:""}</button>`).join("");
  if(loose || S.binderId==="__loose") h += `<button class="tab loose" role="tab" type="button" data-binder="__loose" aria-selected="${S.binderId==="__loose"}"><span class="swatch"></span><span>Not in a binder</span><span class="count">${loose}</span></button>`;
  const nSales = salesList().length;
  if(nSales || S.binderId==="__sales") h += `<button class="tab sales" role="tab" type="button" data-binder="__sales" aria-selected="${S.binderId==="__sales"}"><span class="swatch"></span><span>Sales</span><span class="count">${nSales}</span></button>`;
  h += `<button class="tab add" type="button" id="btnNewBinder">+ New binder</button>`;
  $("#tabs").innerHTML = h;
  const b = curBinder(); $("#sheet").style.setProperty("--bc", b?.color || "#77838F"); $("#btnBinderSettings").hidden = !b;
  $("#btnSortBinder").hidden = !b || S.me?.user?.role==="viewer" || cardsIn(b.id).length < 2;
}
function statsFor(list){
  const heldList = list.filter(owned), ph = list.filter(c => held(c) && c.placeholder).length;
  const val = heldList.reduce((s,c)=> s + (valueOf(c)||0), 0);
  const priced = heldList.filter(c => valueOf(c)!=null).length;
  const paid = list.reduce((s,c)=> s + (paidOf(c)||0), 0);
  const sold = list.reduce((s,c)=> s + (soldOf(c)||0), 0);
  return {n:list.length, held:heldList.length, val, priced, paid, sold, ph};
}
function renderStats(){
  const b = curBinder();
  const list = b ? cardsIn(b.id) : (S.binderId==="__loose" ? looseCards() : S.binderId==="__sales" ? salesList().map(x=>x.c) : []);
  const st = statsFor(list), all = statsFor(S.cards);
  const label = b ? esc(b.name) : (S.binderId==="__loose" ? "Loose cards" : S.binderId==="__sales" ? "Sales" : "No binder");
  const tot = salesTotals();
  $("#stats").innerHTML = `
    <div class="stat"><span class="k">${label}</span><span class="v">${st.n} <small>cards${b?` · ${maxPage(b.id)} pg`:""}</small></span></div>
    <div class="stat"><span class="k">Est. value held</span><span class="v">${money(st.val)} <small>${st.priced}/${st.held} priced${st.ph?` · ${st.ph} placeholder${st.ph===1?"":"s"} not counted`:""}</small></span></div>
    <div class="stat"><span class="k">Paid</span><span class="v">${money(st.paid)}</span></div>
    <div class="stat"><span class="k">Sold for</span><span class="v">${money(st.sold)}</span></div>
    ${checkCount()?`<button class="stat chkstat" type="button" id="btnChecks" title="Cards whose details or price need you"><span class="k">To check</span><span class="v">${checkCount()} <small>card${checkCount()===1?"":"s"}</small></span></button>`:""}
    <div class="stat"><span class="k">All binders</span><span class="v">${money(all.val)} <small>${all.n} cards</small></span></div>
    ${tot.n?`<div class="stat"><span class="k">Sales profit</span><span class="v ${tot.profit>=0?"pos":"neg"}">${signed(tot.profit)} <small>${tot.n} sold</small></span></div>`:""}
    ${pricingStat()}`;
  $("#vPages").setAttribute("aria-pressed", S.view==="pages");
  $("#vList").setAttribute("aria-pressed", S.view==="list");
}
function pickBar(){
  if(!S.pick) return "";
  const n = S.pick.size, allOn = S.shown.length && S.shown.every(id=>S.pick.has(id));
  const right = S.pickConfirm
    ? `<span class="confirm">Delete ${n} card${n===1?"":"s"} and their price history? <button class="btn sm danger solid" type="button" id="pickDelYes">Delete ${n}</button><button class="btn sm" type="button" id="pickDelNo">Keep</button></span>`
    : `<button class="btn sm" type="button" id="pickAll">${allOn?"Clear all":"Select all"}</button><button class="btn sm" type="button" id="pickCancel">Cancel</button><button class="btn sm primary" type="button" id="pickSell" ${nSellable()?"":"disabled"}>Quick sell${nSellable()?` ${nSellable()}`:""}</button><button class="btn sm" type="button" id="pickPh" ${n?"":"disabled"} title="${pickAllPh()?"You have these cards now: count them in your totals":"Hold these pockets for cards you don't have yet: not counted in your totals"}">${pickAllPh()?"Owned":"Placeholder"}${n?` ${n}`:""}</button><button class="btn sm" type="button" id="pickDup" ${n?"":"disabled"}>Duplicate${n?` ${n}`:""}</button><button class="btn sm danger solid" type="button" id="pickDel" ${n?"":"disabled"}>Delete${n?` ${n}`:""}</button>`;
  return `<div class="pickbar" role="toolbar" aria-label="Selection"><span class="cnt">${n} selected</span>${right}</div>`;
}
const nSellable = () => S.pick ? [...S.pick].filter(id => { const c = S.cards.find(x=>x.id===id); return c && owned(c); }).length : 0;
/* the selection's placeholder button: mark them all, or all owned when every one is a placeholder */
const pickedCards = () => S.pick ? [...S.pick].map(id=>S.cards.find(c=>c.id===id)).filter(Boolean) : [];
const pickAllPh = () => { const l = pickedCards(); return l.length>0 && l.every(c=>c.placeholder); };
async function placeholderPicked(){
  const l = pickedCards(), on = !pickAllPh(); if(!l.length) return;
  const res = await Promise.allSettled(l.map(c => S.db.doc("cards/"+c.id).update({placeholder:on, updatedAt:nowISO()})));
  const ok = res.filter(r=>r.status==="fulfilled").length;
  toast(ok===l.length ? (on ? `${ok} card${ok===1?" is a placeholder":"s are placeholders"}: not counted in your totals` : `${ok} card${ok===1?"":"s"} counted in your totals now`) : `${ok} of ${l.length} saved. Try the rest again.`);
  endPick();
}
function startPick(id){ S.pick = new Set(id?[id]:[]); S.pickConfirm=false; try{ navigator.vibrate?.(15); }catch(_){} if(S.sel) closeDrawer(); else renderMain(); }
function endPick(){ S.pick=null; S.pickConfirm=false; renderMain(); }
function renderMain(){
  if(S.pick){ for(const id of [...S.pick]) if(!S.cards.some(c=>c.id===id)) S.pick.delete(id); }
  const a = document.activeElement, keep = a && a.id==="q" ? a.selectionStart : null;
  renderMainInner();
  $("#main").classList.toggle("picking", !!S.pick);
  if(S.pick) $("#main").insertAdjacentHTML("afterbegin", pickBar());
  updatePhotosBtn();
  if(keep!=null){ const q=$("#q"); if(q){ q.focus(); try{ q.setSelectionRange(keep,keep); }catch(_){} } }
}
function renderMainInner(){
  const m = $("#main");
  if(S.mode==="loading"){ m.innerHTML = `<div class="empty-state">Loading…</div>`; return; }
  if(S.binderId==="__sales") return renderSales(m);
  if(S.view==="list") return renderList(m);
  const b = curBinder();
  if(S.binderId==="__loose"){ S.view="list"; return renderList(m); }
  if(!b){ m.innerHTML = `<div class="empty-state"><p>No binders yet.</p><p style="display:flex;flex-wrap:wrap;gap:8px;justify-content:center"><button class="btn primary" type="button" id="btnFirstBinder">Create your first binder</button>${S.cards.length || (S.me?.user && S.me.user.role!=="admin")?"":`<button class="btn" type="button" id="btnFirstRestore">Restore from a backup</button>`}</p></div>`; return; }
  const n = pocketsOf(b), cols = POCKETS[n].cols, mp = maxPage(b.id);
  S.page = Math.min(Math.max(1, S.page|0), mp+1);
  let cells = ""; S.shown = cardsIn(b.id).filter(c=>c.page===S.page).map(c=>c.id);
  for(let s=1;s<=n;s++){
    const c = cardAt(b.id, S.page, s);
    if(!c){ cells += `<button class="pocket empty" type="button" data-empty="${s}" aria-label="Empty pocket ${s}, add a card"><span class="slotno">${s}</span><span class="plus">+</span><span>Add card</span></button>`; continue; }
    const v = valueOf(c), flag = c.placeholder && held(c) ? `<span class="flag placeholder">Placeholder</span>` : c.status && c.status!=="binder" ? `<span class="flag ${esc(c.status)}">${esc((STATUSES.find(x=>x[0]===c.status)||[,""])[1].replace("Listed for sale","Listed").replace("Out for grading","Grading"))}</span>` : "";
    const inner = shown(c)
      ? `<img src="${imgURL(shown(c))}" alt="${esc(c.name||"Card")}" loading="lazy"><span class="cap"><span class="n">${esc(c.name||"Unnamed card")}</span><span class="m">${esc(metaLine(c))}</span></span>`
      : `<span class="face"><span class="n">${esc(c.name||"Unnamed card")}</span><span class="m">${esc(metaLine(c)||"No set yet")}</span><span class="np">No photo</span></span>`;
    cells += `<button class="pocket${S.sel===c.id?" sel":""}${held(c)?"":" dim"}${c.placeholder&&held(c)?" ph":""}${S.pick?.has(c.id)?" picked":""}${isFound(c.id)?" found":""}" type="button" data-card="${esc(c.id)}" aria-label="${esc((c.name||"Unnamed card")+(c.placeholder&&held(c)?" (placeholder)":"")+", pocket "+s+(cardChecks(c).length?", needs checking":""))}"${S.pick?` aria-pressed="${S.pick.has(c.id)}"`:""}><span class="slotno">${s}</span>${cardChecks(c).length?`<span class="chkmark" title="${esc(cardChecks(c)[0].title)}" aria-hidden="true">!</span>`:""}<span class="tick" aria-hidden="true">✓</span>${inner}${v!=null?`<span class="price">${esc(money(v).replace(".00",""))}</span>`:""}${flag}</button>`;
  }
  const pageCards = cardsIn(b.id).filter(c=>c.page===S.page);
  const pst = statsFor(pageCards);
  let chips = ""; for(let p=1;p<=mp;p++) chips += `<button class="pchip" type="button" data-page="${p}" aria-current="${p===S.page}">${p}</button>`;
  chips += `<button class="pchip new" type="button" data-page="${mp+1}" aria-current="${S.page===mp+1}" title="Start a new page">+</button>`;
  m.innerHTML = `<div class="pageview">
    <div class="binder-page" style="--bc:${esc(b.color||BINDER_COLORS[0])}"><div class="grid" style="--cols:${cols}">${cells}</div></div>
    <aside class="pagenav">
      <div>
        <div class="row" style="margin-bottom:8px"><button class="btn sm" type="button" data-step="-1" ${S.page<=1?"disabled":""} aria-label="Previous page">‹</button><span class="lbl">Page ${S.page} of ${mp}${S.page>mp?" (new)":""}</span><button class="btn sm" type="button" data-step="1" ${S.page>mp?"disabled":""} aria-label="Next page">›</button></div>
        <div class="pagechips">${chips}</div>
      </div>
      <div class="pageinfo">
        <span><b>${pageCards.length}</b> of ${n} pockets filled</span>
        <span>Page value <b>${money(pst.val)}</b></span>
        <span class="hint">${n}-pocket pages. Tap a card to price it or move it. Tap an empty pocket to add one. Tap Photos to flip through every picture full screen. Swipe left or right on the page to flip pages. Press and hold a card to quick sell it, or to select several to sell, mark as placeholders, duplicate or delete.</span>
      </div>
    </aside></div>`;
}
const SORTS = {
  name: c => (c.name||"").toLowerCase(),
  set: c => ((c.setCode||c.set||"")+" "+(c.number||"").padStart(8,"0")).toLowerCase(),
  loc: c => { const b = binderById(c.binderId); return b ? String(b.order??0).padStart(4,"0")+String(c.page||0).padStart(4,"0")+String(c.slot||0).padStart(3,"0") : "~"; },
  released: c => c.released || "9999",
  status: c => c.status||"binder",
  value: c => valueOf(c) ?? -1,
  paid: c => paidOf(c) ?? -1
};
function renderList(m){
  const q = S.q.trim().toLowerCase();
  let list = S.scope==="all" ? S.cards : S.binderId==="__loose" ? looseCards() : cardsIn(S.binderId);
  if(q) list = list.filter(c => [c.name,c.set,c.setCode,c.number,c.rarity,c.variant,c.artist,c.notes].join(" ").toLowerCase().includes(q));
  const f = SORTS[S.sort.k] || SORTS.loc;
  list = list.slice().sort((a,b)=>{ const x=f(a), y=f(b); return (x<y?-1:x>y?1:0)*S.sort.d; });
  S.shown = list.map(c=>c.id);
  const th = (k,l,cls="") => `<th class="${cls}"><button type="button" data-sort="${k}">${l}${S.sort.k===k?(S.sort.d>0?" ▲":" ▼"):""}</button></th>`;
  const rows = list.map(c => {
    const st = STATUSES.find(x=>x[0]===(c.status||"binder"));
    return `<tr data-card="${esc(c.id)}" class="${S.sel===c.id?"sel":""}${S.pick?.has(c.id)?" picked":""}${isFound(c.id)?" found":""}"${S.pick?` aria-selected="${S.pick.has(c.id)}"`:""}>
      ${S.pick?`<td class="tdtick"><span class="rowtick" aria-hidden="true">✓</span></td>`:""}<td>${shown(c)?`<img class="thumb" src="${imgURL(shown(c))}" alt="" loading="lazy">`:`<span class="thumb"></span>`}</td>
      <td class="cellname"><b>${esc(c.name||"Unnamed card")}${cardChecks(c).length?` <span class="chkmark inline" title="${esc(cardChecks(c)[0].title)}">!</span>`:""}</b><span>${esc([c.rarity,c.variant].filter(Boolean).join(" · "))}</span></td>
      <td class="mono">${esc(metaLine(c))}</td>
      <td class="mono">${esc(c.released||"—")}</td>
      <td class="mono">${esc(locShort(c))}</td>
      <td><span class="chip ${esc(c.status||"")}">${esc(st?st[1]:"In binder")}</span>${c.placeholder&&held(c)?` <span class="chip placeholder">Placeholder</span>`:""}</td>
      <td class="r mono">${money(valueOf(c))}</td>
      <td class="r mono">${money(paidOf(c))}</td></tr>`;
  }).join("");
  m.innerHTML = `<div class="listbar">
      <label class="search"><svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/></svg><input id="q" type="search" placeholder="Search name, set, number, rarity…" value="${esc(S.q)}" aria-label="Search cards"></label>
      <div class="seg" role="group" aria-label="Scope"><button type="button" data-scope="binder" aria-pressed="${S.scope!=="all"}">${S.binderId==="__loose"?"Loose":"This binder"}</button><button type="button" data-scope="all" aria-pressed="${S.scope==="all"}">All cards</button></div>
      <span class="hint">${list.length} shown${S.pick||!list.length?"":" · hold a row to quick sell or select"}</span></div>
    <div class="tablewrap"><table><thead><tr>${S.pick?"<th></th>":""}<th></th>${th("name","Card")}${th("set","Set · No.")}${th("released","Released")}${th("loc","Location")}${th("status","Status")}${th("value","Value","r")}${th("paid","Paid","r")}</tr></thead>
    <tbody>${rows || `<tr><td colspan="${S.pick?9:8}" class="empty-state">${q?"No cards match that search.":"No cards here yet."}</td></tr>`}</tbody></table></div>`;
}

/* ---------- sales ---------- */
function renderSales(m){
  S.shown = [];
  const l = salesList(), t = salesTotals();
  if(!l.length){ m.innerHTML = `<div class="empty-state"><p>No sales yet.</p><p class="hint">Press and hold a card in a binder, then tap Quick sell.</p></div>`; return; }
  // A bundle's cards go together, under one row for the bundle, where its first card falls.
  const groups = []; const byBundle = new Map();
  for(const x of l){ const b = x.s.bundle?.id; if(!b){ groups.push(x); continue; } if(!byBundle.has(b)){ const g = {bundle:x.s.bundle, items:[]}; byBundle.set(b, g); groups.push(g); } byBundle.get(b).items.push(x); }
  const saleRow = ({c,s}, inBundle) => `<tr data-sale="${esc(c.id)}" class="${isFound(c.id)?"found":""}${inBundle?" inbundle":""}">
      <td class="mono">${inBundle?"":esc(s.date||"—")}</td>
      <td class="hide-sm">${shown(c)?`<img class="thumb" src="${imgURL(shown(c))}" alt="" loading="lazy">`:`<span class="thumb"></span>`}</td>
      <td class="cellname"><b>${esc(c.name||"Unnamed card")}</b><span>${esc([metaLine(c), s.where].filter(Boolean).join(" · "))}</span></td>
      <td class="r mono">${money(s.soldCAD)}${s.currency==="USD"?`<br><small class="hint">${money(s.amount,"USD")}</small>`:""}</td>
      <td class="hide-sm"><span class="chip ${s.basis==="paid"?"paid":s.basis==="market"?"market":""}">${esc(BASIS_LABEL[s.basis]||"no cost")}</span></td>
      <td class="r mono hide-sm">${money(s.cost)}</td>
      <td class="r mono ${s.profit==null?"":s.profit>=0?"pos":"neg"}">${signed(s.profit)}<small class="show-sm hint">${esc(BASIS_LABEL[s.basis]||"")}</small></td>
      <td class="r">${s.quick&&!inBundle?`<button class="btn sm ghost" type="button" data-unsell="${esc(c.id)}" title="Put the card back where it was">Undo</button>`:""}</td></tr>`;
  const bundleRow = g => {
    const s0 = g.items[0].s, rev = g.items.reduce((a,x)=>a+x.s.soldCAD,0), cost = g.items.reduce((a,x)=>a+(x.s.cost??0),0);
    const profs = g.items.filter(x=>x.s.profit!=null), prof = profs.reduce((a,x)=>a+x.s.profit,0);
    const how = {value:"split by market value", even:"split evenly", manual:"split by hand"}[g.bundle.split] || "";
    return `<tr class="bundlerow" data-bundle="${esc(g.bundle.id)}">
      <td class="mono">${esc(s0.date||"—")}</td>
      <td class="hide-sm"><span class="bundleicon" aria-hidden="true">${g.items.length}</span></td>
      <td class="cellname"><b>Bundle of ${g.items.length} cards</b><span>${esc([`${money(g.bundle.total, g.bundle.currency||"CAD")} together`, how, s0.where].filter(Boolean).join(" · "))}</span></td>
      <td class="r mono">${money(rev)}</td>
      <td class="hide-sm"></td>
      <td class="r mono hide-sm">${money(cost)}</td>
      <td class="r mono ${!profs.length?"":prof>=0?"pos":"neg"}">${profs.length?signed(prof):"—"}</td>
      <td class="r"><button class="btn sm ghost" type="button" data-unbundle="${esc(g.bundle.id)}" title="Put all ${g.items.length} cards back where they were">Undo</button></td></tr>`;
  };
  const rows = groups.map(g => g.bundle ? bundleRow(g) + g.items.map(x=>saleRow(x, true)).join("") : saleRow(g, false)).join("");
  m.innerHTML = `<div class="salesum">
      <div class="stat"><span class="k">Cards sold</span><span class="v">${t.n}</span></div>
      <div class="stat"><span class="k">Sold for</span><span class="v">${money(t.rev)}</span></div>
      <div class="stat"><span class="k">Cost basis</span><span class="v">${money(t.cost)}</span></div>
      <div class="stat"><span class="k">Profit</span><span class="v ${t.profit>=0?"pos":"neg"}">${signed(t.profit)}</span></div>
      ${t.nobasis?`<span class="hint" style="align-self:end">${t.nobasis} sale${t.nobasis===1?"":"s"} had no paid or market price, so ${t.nobasis===1?"it's":"they're"} left out of profit.</span>`:""}
    </div>
    <p class="hint" style="margin:10px 16px 0">Profit is sale price minus what you paid. If there's no paid price, it's measured against the market price at the time of sale.</p>
    <div class="tablewrap"><table class="salestbl"><thead><tr><th>Date</th><th class="hide-sm"></th><th>Card</th><th class="r">Sold for</th><th class="hide-sm">Basis</th><th class="r hide-sm">Cost</th><th class="r">Profit</th><th></th></tr></thead><tbody>${rows}</tbody></table></div>`;
}
/* Quick sell: one card, or several, each at its own price or together for one price (a bundle)
   split across them by market value, evenly or by hand (public/sales.js). */
function quickSellModal(ids){
  if(!S.db) return toast("Saving isn't available in this view.");
  const list = ids.map(id=>S.cards.find(c=>c.id===id)).filter(c=>c && owned(c));
  if(!list.length) return toast("Those cards are already sold.");
  const many = list.length > 1;
  const rows = list.map(c => { const cb = costBasis(c), v = valueOf(c);
    const basis = cb.basis==="paid" ? `Paid ${money(cb.cost)}${v!=null?` · market ${money(v)}`:""}` : cb.basis==="market" ? `No paid price · market ${money(cb.cost)}` : "No paid or market price, so profit isn't tracked";
    return `<div class="qs-row" data-qs="${esc(c.id)}">
      ${shown(c)?`<img class="thumb" src="${imgURL(shown(c))}" alt="">`:`<span class="thumb"></span>`}
      <div class="cellname"><b>${esc(c.name||"Unnamed card")}</b><span class="hint">${esc(locShort(c))}</span><span class="basis">${esc(basis)}</span></div>
      <div><input type="number" step="0.01" min="0" inputmode="decimal" placeholder="${v!=null?esc(v.toFixed(2)):"0.00"}" aria-label="Sale price for ${esc(c.name||"card")}" data-qsamt><div class="pl" data-qspl></div></div>
    </div>`; }).join("");
  $("#modalRoot").innerHTML = `<div class="modal" data-mclose><div class="mcard narrow" id="qs_card" role="dialog" aria-modal="true" aria-label="Quick sell" style="width:min(560px,100%)">
    <h2>Quick sell${many?` ${list.length} cards`:""}</h2>
    <p class="lead" id="qs_lead"></p>
    ${many?`<div class="seg qs-mode" role="group" aria-label="How they sold"><button type="button" data-qsmode="each" aria-pressed="true">Price each card</button><button type="button" data-qsmode="bundle" aria-pressed="false">One price for all</button></div>
    <div class="qs-bundle" id="qs_bundle" hidden>
      <div class="field"><label for="qs_btotal">Sold together for</label><input id="qs_btotal" type="number" step="0.01" min="0" inputmode="decimal" placeholder="0.00"></div>
      <div class="field"><label for="qs_split">Split it</label><select id="qs_split"><option value="value">By market value</option><option value="even">Evenly</option><option value="manual">By hand</option></select></div>
    </div>`:""}
    <div class="qs-list">${rows}</div>
    <div class="qs-opts">
      <div class="field"><label for="qs_cur">Currency</label><select id="qs_cur">${opt(["CAD","USD"],"CAD")}</select></div>
      <div class="field"><label for="qs_date">Date</label><input id="qs_date" type="date" value="${today()}"></div>
      <div class="field"><label for="qs_where">Sold where <span class="hint">(optional)</span></label><input id="qs_where" list="qs_dl" value="Card show" placeholder="FB Marketplace, card show…"><datalist id="qs_dl">${["Facebook Marketplace","eBay","Local card shop","Card show","Trade","Friend"].map(s=>`<option value="${s}">`).join("")}</datalist></div>
    </div>
    <div class="qs-total" id="qs_total"></div>
    <div class="mfoot"><button class="btn" type="button" data-mclose>Cancel</button><button class="btn primary" type="button" id="qs_go" disabled>Sell</button></div>
  </div></div>`;
  const card = $("#qs_card"), qs = {mode:"each"};
  const inputs = () => [...card.querySelectorAll("[data-qsamt]")];
  const bundleTotal = () => { const v = parseFloat($("#qs_btotal")?.value); return isNaN(v) || v < 0 ? null : v; };
  /* bundle: the shares from the total and the chosen split (not "by hand", which the person types) */
  const fillShares = () => {
    const t = bundleTotal(), how = $("#qs_split").value; if(how==="manual") return;
    const shares = t==null ? list.map(()=>null) : window.BinderSales.split(t, list.map(c=>valueOf(c)), how);
    inputs().forEach((el,i) => { el.value = shares[i]==null ? "" : shares[i].toFixed(2); });
  };
  const setMode = mode => {
    qs.mode = mode;
    card.querySelectorAll("[data-qsmode]").forEach(b => b.setAttribute("aria-pressed", b.dataset.qsmode===mode));
    $("#qs_bundle").hidden = mode!=="bundle";
    inputs().forEach(el => el.setAttribute("aria-label", el.getAttribute("aria-label").replace(/^(Sale price|Share of the bundle)/, mode==="bundle" ? "Share of the bundle" : "Sale price")));
    if(mode==="bundle"){ if(bundleTotal()==null){ const sum = inputs().reduce((a,el)=>a+(parseFloat(el.value)||0),0); if(sum>0) $("#qs_btotal").value = sum.toFixed(2); } fillShares(); setTimeout(()=>$("#qs_btotal").focus(), 0); }
    read();
  };
  const read = () => {
    const cur = $("#qs_cur").value, bundle = qs.mode==="bundle"; let n=0, rev=0, prof=0, anyProf=false, missing=0;
    $("#qs_lead").textContent = bundle
      ? `Enter what the ${list.length} cards sold for together. It's split across them so each gets its own sale price and profit, and they stay together as one bundle on the Sales tab.`
      : `Enter what ${many?"each one":"it"} sold for. ${many?"They come":"It comes"} out of the binder, get${many?"":"s"} marked sold, and the profit goes on the Sales tab.`;
    card.querySelectorAll("[data-qs]").forEach(r => {
      const c = S.cards.find(x=>x.id===r.dataset.qs); const raw = r.querySelector("[data-qsamt]").value.trim(); const pl = r.querySelector("[data-qspl]");
      const a = parseFloat(raw);
      if(raw==="" || isNaN(a) || a<0){ pl.textContent=""; pl.className="pl"; missing++; return; }
      const cad = toCAD({amount:a, currency:cur}), cb = c ? costBasis(c) : {cost:null};
      n++; rev += cad;
      if(cb.cost!=null){ const p = cad - cb.cost; prof += p; anyProf = true; pl.textContent = `${signed(p)} ${BASIS_LABEL[cb.basis]}`; pl.className = "pl " + (p>=0?"pos":"neg"); }
      else { pl.textContent = "no cost basis"; pl.className = "pl hint"; }
    });
    const go = $("#qs_go");
    if(bundle){
      const t = bundleTotal(), left = t==null ? null : window.BinderSales.remaining(t, inputs().map(el=>parseFloat(el.value)||0));
      const ok = t!=null && !missing && left===0;
      $("#qs_total").innerHTML = t==null ? `<span class="hint">Enter the total to split it.</span>`
        : `<span>Bundle <b>${money(toCAD({amount:t, currency:cur}))}</b> for ${list.length} cards</span>${anyProf?`<span>Profit <b class="${prof>=0?"pos":"neg"}">${signed(prof)}</b></span>`:""}${missing?`<span class="warn-text">Give every card a share (0 is fine)</span>`:left!==0?`<span class="warn-text">${left>0?`${money(left,cur)} left to place`:`${money(-left,cur)} too much`}: the shares have to add up to the total</span>`:""}`;
      go.disabled = !ok; go.textContent = `Sell bundle of ${list.length}`;
      return;
    }
    $("#qs_total").innerHTML = n ? `<span>Sale total <b>${money(rev)}</b></span>${anyProf?`<span>Profit <b class="${prof>=0?"pos":"neg"}">${signed(prof)}</b></span>`:""}${missing&&many?`<span class="hint">${missing} without a price won't be sold</span>`:""}` : "";
    go.disabled = !n; go.textContent = n ? `Sell ${n>1?n+" cards":""}`.trim() : "Sell";
  };
  card.addEventListener("click", e => { const b = e.target.closest("[data-qsmode]"); if(b) setMode(b.dataset.qsmode); });
  card.addEventListener("input", e => {
    if(qs.mode==="bundle"){
      if(e.target.id==="qs_btotal") fillShares();
      else if(e.target.matches("[data-qsamt]")) $("#qs_split").value = "manual"; // a share typed by hand
    }
    read();
  });
  card.addEventListener("change", e => { if(e.target.id==="qs_split") fillShares(); read(); });
  card.addEventListener("keydown", e => { if(e.key==="Enter" && e.target.matches("[data-qsamt],#qs_btotal")){ e.preventDefault(); const ins=inputs(); const i=ins.indexOf(e.target); if(i>=0 && i<ins.length-1) ins[i+1].focus(); else $("#qs_go").click(); } });
  $("#qs_go").onclick = () => void doQuickSell(card, qs.mode==="bundle" ? {total:bundleTotal(), split:$("#qs_split").value} : null);
  read(); setTimeout(()=> card.querySelector("[data-qsamt]")?.focus(), 30);
}
async function doQuickSell(card, bundleOpts){
  const go = $("#qs_go"); if(go.disabled) return; go.disabled = true;
  const cur = $("#qs_cur").value, date = $("#qs_date").value || today(), where = $("#qs_where").value.trim();
  const rowsIn = [...card.querySelectorAll("[data-qs]")];
  const bundle = bundleOpts ? {id:rid(), total:Math.round(bundleOpts.total*100)/100, currency:cur, count:rowsIn.length, split:bundleOpts.split} : null;
  const jobs = [];
  rowsIn.forEach(r => {
    const a = parseFloat(r.querySelector("[data-qsamt]").value); if(isNaN(a) || a<0) return;
    const c = S.cards.find(x=>x.id===r.dataset.qs); if(!c || !owned(c)) return;
    const amount = Math.round(a*100)/100, soldCAD = Math.round(toCAD({amount, currency:cur})*100)/100, cb = costBasis(c);
    const pid = rid(), at = nowISO();
    const note = bundle ? `Bundle of ${bundle.count} · ${money(bundle.total, cur)} together` : "Quick sell";
    const price = {id:pid, at, type:"mysale", amount, currency:cur, date, where, note};
    const sale = {amount, currency:cur, soldCAD, cost: cb.cost!=null ? Math.round(cb.cost*100)/100 : null, basis:cb.basis, profit: cb.cost!=null ? Math.round((soldCAD-cb.cost)*100)/100 : null, date, where, at, priceId:pid, from:{binderId:c.binderId||null, page:c.page||null, slot:c.slot||null}, ...(bundle?{bundle}:{})};
    jobs.push({c, sale, patch:{prices:[...(c.prices||[]), price], status:"sold", binderId:null, page:null, slot:null, sale, updatedAt:nowISO()}});
  });
  if(!jobs.length || (bundle && jobs.length!==rowsIn.length)){ go.disabled=false; return; }
  const res = await Promise.allSettled(jobs.map(j => S.db.doc("cards/"+j.c.id).update(j.patch)));
  const ok = jobs.filter((_,i)=>res[i].status==="fulfilled"), failed = jobs.length-ok.length;
  if(failed){ const err = res.find(r=>r.status==="rejected")?.reason; console.error(err); if(!ok.length){ go.disabled=false; writeErr(err); return; } }
  closeModal(); if(S.pick) endPick(); if(ok.some(j=>j.c.id===S.sel)) closeDrawer();
  const prof = ok.reduce((t,j)=>t+(j.sale.profit??0),0), anyProf = ok.some(j=>j.sale.profit!=null);
  const what = bundle ? `Sold ${ok.length} cards together for ${money(toCAD({amount:bundle.total, currency:cur}))}` : ok.length===1 ? `Sold ${ok[0].c.name||"card"} for ${money(ok[0].sale.soldCAD)}` : `Sold ${ok.length} cards`;
  toast(`${what}${anyProf?` · profit ${signed(prof)}`:""}${failed?`. ${failed} didn't save.`:""}`);
  render();
}
/* a bundle's cards all go back, one after another so each finds its old pocket or the next free one */
async function undoBundle(bid){
  const ids = S.cards.filter(c => c.sale?.bundle?.id===bid).map(c=>c.id);
  let ok = 0;
  for(const id of ids) if(await undoSale(id, true)) ok++;
  toast(ok===ids.length ? `The ${ok} cards from the bundle are back` : `${ok} of ${ids.length} cards are back. Try Undo again for the rest.`);
}
async function undoSale(id, quiet){
  const c = S.cards.find(x=>x.id===id); if(!c || !c.sale) return false;
  const f = c.sale.from || {};
  let loc = {binderId:null, page:null, slot:null};
  if(f.binderId && binderById(f.binderId)){ loc = f.page && f.slot && !cardAt(f.binderId, f.page, f.slot) ? {binderId:f.binderId, page:f.page, slot:f.slot} : {binderId:f.binderId, ...firstFree(f.binderId)}; }
  const prices = (c.prices||[]).filter(p => p.id !== c.sale.priceId);
  if(!(await updateCard(id, {...loc, prices, status:"binder", sale:null}))) return false;
  // Seen at once by the next card of a bundle, before the live update arrives.
  Object.assign(c, loc, {prices, status:"binder", sale:null});
  if(!quiet) toast(loc.binderId ? `${c.name||"Card"} is back in ${locText(loc)}` : `${c.name||"Card"} is back under Not in a binder`);
  return true;
}

/* ---------- drawer ---------- */
function selCard(){ return S.sel==="__new" ? S.draft : S.cards.find(c=>c.id===S.sel); }
function openCard(id){ S.pricePick=null; S.pickRes=null; S.sel=id; S.draft=null; S.dirty=false; S.editPrice=null; S.confirm=null; renderMain(); renderDrawer(true); }
function openNew(loc){
  const bid = loc?.binderId ?? (curBinder()?.id || null);
  const spot = loc?.slot ? loc : (bid ? firstFree(bid) : null);
  S.sel="__new"; S.dirty=true; S.editPrice=null; S.confirm=null;
  S.draft = {id:"__new", name:"", set:"", setCode:"", number:"", rarity:"", variant:"", language:"English", condition:"Near Mint", grader:"Raw", grade:"", artist:"", notes:"", status:"binder", prices:[], imageId:null, binderId: bid, page: spot?.page||null, slot: spot?.slot||null};
  renderMain(); renderDrawer(true);
}
function closeDrawer(){ S.pricePick=null; S.pickRes=null; S.sel=null; S.draft=null; S.dirty=false; S.editPrice=null; S.confirm=null; renderMain(); renderDrawer(true); }
const opt = (list, v) => list.map(o => { const [val,lab] = Array.isArray(o)?o:[o,o]; return `<option value="${esc(val)}" ${String(v)===String(val)?"selected":""}>${esc(lab)}</option>`; }).join("");
function renderDrawer(force){
  const root = $("#drawerRoot");
  const c = selCard();
  if(!c){ root.innerHTML=""; root.dataset.showing=""; return; }
  if(!force && root.dataset.showing===S.sel && $("#cardForm")){ if(S.sel!=="__new") refreshParts(c); return; }
  S.priceTouched=false; S.moveTouched=false; root.dataset.showing=S.sel; resetLookup();
  const isNew = S.sel==="__new";
  const sets = [...new Set(S.cards.map(x=>x.set).filter(Boolean))].sort();
  const codes = [...new Set(S.cards.map(x=>x.setCode).filter(Boolean))].sort();
  root.innerHTML = `<div class="scrim" data-close></div>
  <aside class="drawer" role="dialog" aria-modal="true" aria-label="Card details">
    <div class="dhead"><div><h2 id="dTitle">${esc(c.name|| (isNew?"New card":"Unnamed card"))}</h2><div class="loc" id="dLoc">${esc(isNew ? (c.binderId?`Goes in ${locText(c)}`:"Not in a binder") : locText(c))}</div></div>
      <button class="btn ghost" type="button" data-close aria-label="Close">✕</button></div>
    <div class="dbody">
      <div class="sec imgrow">
        <div class="bigimg" id="bigImg">${imgInner(c)}</div>
        <div class="valuebox" id="valueBox"></div>
      </div>
      ${photoSection(c)}
      <form class="sec" id="cardForm" autocomplete="off">
        <h3>Card details</h3>
        <div class="form">
          <div class="field full"><label for="f_name">Pokémon / card name</label><input id="f_name" name="name" value="${esc(c.name)}" placeholder="e.g. Alolan Exeggutor" required></div>
          <div class="field full"><label for="f_set">Set</label><input id="f_set" name="set" list="dl_sets" value="${esc(c.set)}" placeholder="e.g. 30th Celebration"></div>
          <div class="field"><label for="f_setCode">Set code</label><input id="f_setCode" class="mono" name="setCode" list="dl_codes" value="${esc(c.setCode)}" placeholder="30C, MEP, SVI"></div>
          <div class="field"><label for="f_number">Number</label><input id="f_number" class="mono" name="number" value="${esc(c.number)}" placeholder="129/128"></div>
          <div class="field full detailshint" id="detailsHint" aria-live="polite" hidden></div>
          <div class="field"><label for="f_rarity">Rarity</label><input id="f_rarity" name="rarity" list="dl_rar" value="${esc(c.rarity)}"></div>
          <div class="field"><label for="f_variant">Variant / stamp</label><input id="f_variant" name="variant" value="${esc(c.variant)}" placeholder="Reverse holo, 30th stamp…"></div>
          <div class="field"><label for="f_language">Language</label><select id="f_language" name="language">${opt(LANGS,c.language||"English")}</select></div>
          <div class="field"><label for="f_condition">Condition</label><select id="f_condition" name="condition">${opt(CONDITIONS,c.condition||"Near Mint")}</select></div>
          <div class="field"><label for="f_grader">Graded by</label><select id="f_grader" name="grader">${opt(GRADERS,c.grader||"Raw")}</select></div>
          <div class="field"><label for="f_grade">Grade</label><input id="f_grade" class="mono" name="grade" value="${esc(c.grade)}" placeholder="10, 9.5…"></div>
          <div class="field"><label for="f_artist">Illustrator</label><input id="f_artist" name="artist" value="${esc(c.artist)}"></div>
          <div class="field"><label for="f_released">Released</label><input id="f_released" class="mono" value="${esc(c.released)}" readonly placeholder="${S.sel==="__new"?"Filled in after saving":"Not found yet"}" title="When the card's set came out, from TCGdex. Used to sort a binder by release date."></div>
          <div class="field"><label for="f_status">Status</label><select id="f_status" name="status">${opt(STATUSES,c.status||"binder")}</select></div>
          <div class="field full"><label class="phswitch"><input type="checkbox" id="f_placeholder" role="switch" ${c.placeholder?"checked":""}><span><b>Placeholder</b> <span class="hint">Holds this pocket for a card you don't have yet. Its price is tracked but not counted in your totals.${isNew?"":" Saves straight away."}</span></span></label></div>
          <div class="field full"><label for="f_notes">Notes</label><textarea id="f_notes" name="notes" placeholder="Centering, where you pulled it, trade notes…">${esc(c.notes)}</textarea></div>
        </div>
        <datalist id="dl_sets">${sets.map(s=>`<option value="${esc(s)}">`).join("")}</datalist>
        <datalist id="dl_codes">${codes.map(s=>`<option value="${esc(s)}">`).join("")}</datalist>
        <datalist id="dl_rar">${RARITIES.map(s=>`<option value="${esc(s)}">`).join("")}</datalist>
        <div class="formfoot">
          <button class="btn primary" type="submit" id="btnSave" ${S.dirty?"":"disabled"}>${isNew?"Add card":"Save changes"}</button>
          ${isNew?"":`<span style="display:flex;flex-wrap:wrap;gap:8px;align-items:center">${held(c)?`<button class="btn sm primary" type="button" id="btnQuickSell" ${c.placeholder?"hidden":""}>Quick sell</button>`:""}<button class="btn sm" type="button" id="btnDup" title="Make another copy of this card">Duplicate</button><span id="delZone">${delZone()}</span></span>`}
        </div>
      </form>
      ${isNew?"":moveSection(c)}
      ${isNew?`<p class="hint">Add the card first, then log prices and move it around.</p>`:autoSection(c)+priceSection(c)}
      <div class="sec"><h3>Look up prices</h3><div class="links">${lookupLinks(c)}</div></div>
    </div>
  </aside>`;
  renderPriceSummary(c);
  if(force && isNew) setTimeout(()=>$("#f_name")?.focus(), 30);
}
const imgInner = c => shown(c) ? `<img src="${imgURL(shown(c))}" alt="${esc(c.name)}"><button type="button" class="zoom" data-lbopen aria-label="View photo full screen" title="View full screen"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M15 3h6v6M9 21H3v-6M21 3l-7 7M3 21l7-7"/></svg></button>` : `<span class="face">No photo yet</span>`;
const findPhotoLink = c => { const q=[c.name, c.set||c.setCode, c.number, "pokemon card"].filter(Boolean).join(" ").trim(); return `<a href="https://www.google.com/search?tbm=isch&q=${encodeURIComponent(q)}" target="_blank" rel="noopener">Find photo</a>`; };
const PASTE_PH = "Or copy a picture, then press and hold here and tap Paste.";
const envNotice = () => "";
const canClipRead = () => !!(navigator.clipboard && navigator.clipboard.read);
const picKey = c => [c.imageId, c.officialImageId, c.imagePref].map(x=>x||"").join("|");
const photoSection = c => `<div class="sec" id="photoSec" data-img="${esc(picKey(c))}"><h3>Picture</h3>${picChoice(c)}<h3 style="margin-top:12px">Your photo</h3><div class="links">${envNotice("Choose photo, Take photo, Browse files and Paste")}<span class="btn sm filebtn" data-pick>${c.imageId?"Replace photo":"Choose photo"}<input id="photoPicker" data-photo type="file" accept="image/*" aria-label="${c.imageId?"Replace photo":"Choose photo"}"></span><span class="btn sm filebtn" data-pick>Take photo<input data-photo type="file" accept="image/*" capture="environment" aria-label="Take photo"></span><span class="btn sm filebtn" data-pick>Browse files<input data-photo type="file" aria-label="Browse files"></span>${canClipRead()?`<button class="btn sm" type="button" id="btnPasteImg">Paste photo</button>`:""}${c.imageId?`<button class="btn sm ghost" type="button" id="btnRmImg">Remove photo</button>`:""}${findPhotoLink(c)}<div class="pastebox" id="photoPaste" contenteditable="true" role="textbox" aria-label="Paste a photo here">${PASTE_PH}</div><span class="hint" id="imgNote">Choose photo opens your library, Take photo opens the camera, Browse files opens Files. If a button doesn't open anything here, copy the picture and paste it in the box.</span></div></div>`;
const delZone = () => S.confirm==="delete" ? `<span class="confirm">Delete this card and its price history? <button class="btn sm danger solid" type="button" id="btnDelYes">Delete</button><button class="btn sm" type="button" id="btnDelNo">Keep</button></span>` : `<button class="btn sm danger" type="button" id="btnDel">Delete card</button>`;
function refreshParts(c, o={}){
  if(!c || S.sel==="__new") return;
  renderPriceSummary(c);
  const bi=$("#bigImg"); if(bi) bi.innerHTML = imgInner(c);
  const ph=$("#photoSec"); if(ph && ph.dataset.img!==picKey(c) && !S.photoBusy && !pickPending()) ph.outerHTML = photoSection(c);
  const dl=$("#dLoc"); if(dl) dl.textContent = locText(c);
  if(!S.dirty){ const t=$("#dTitle"); if(t) t.textContent = c.name || "Unnamed card"; }
  const psec=$("#priceSec"); if(psec && (o.price || (!S.editPrice && !S.priceTouched))){ psec.outerHTML = priceSection(c); S.priceTouched=false; }
  const msec=$("#moveSec"); if(msec && (o.move || !S.moveTouched)){ msec.outerHTML = moveSection(c); S.moveTouched=false; }
  const ai=$("#autoInfo"); if(ai) ai.innerHTML = autoInfo(c);
}
function lookupLinks(c){
  const q = [c.name, c.number].filter(Boolean).join(" ").trim() || "pokemon card";
  const qs = encodeURIComponent(q), qp = qs;
  return `<a href="https://www.tcgplayer.com/search/pokemon/product?q=${qs}" target="_blank" rel="noopener">TCGplayer</a>
    <a href="https://www.pricecharting.com/search-products?type=prices&q=${qp}" target="_blank" rel="noopener">PriceCharting</a>
    <a href="https://www.ebay.ca/sch/i.html?_nkw=${qp}&LH_Sold=1&LH_Complete=1" target="_blank" rel="noopener">eBay.ca sold</a>
    <a href="https://www.ebay.com/sch/i.html?_nkw=${qp}&LH_Sold=1&LH_Complete=1" target="_blank" rel="noopener">eBay.com sold</a>`;
}
function renderPriceSummary(c){
  const box = $("#valueBox"); if(!box) return;
  const v = valueOf(c), lp = latestOf(c,["comp","market"]), pd = paidOf(c), sd = soldOf(c);
  const basis = lp ? `${(PTYPES.find(t=>t[0]===lp.type)||[,""])[1]} · ${lp.date||""}${lp.where?` · ${lp.where}`:""}` : "Log a sold comp or market price below";
  const si = saleInfo(c);
  const gain = si ? si.profit : (v != null && pd != null ? v - pd : null);
  box.innerHTML = `<span class="stat"><span class="k">Current value</span></span><span class="big">${money(v)}</span><span class="sub">${esc(basis)}</span>
    <dl class="kv"><dt>Paid</dt><dd>${money(pd)}</dd>${sd!=null?`<dt>Sold for</dt><dd>${money(sd)}</dd>`:""}${gain!=null?`<dt>${si?`Profit ${BASIS_LABEL[si.basis]}`:"Unrealized"}</dt><dd class="${gain>=0?"pos":"neg"}">${gain>=0?"+":""}${money(gain)}</dd>`:""}<dt>Entries</dt><dd>${prices(c).length}</dd></dl>`;
}
function moveSection(c){
  const bs = sortedBinders();
  const bid = c.binderId && binderById(c.binderId) ? c.binderId : "";
  const n = bid ? pocketsOf(binderById(bid)) : 9;
  return `<div class="sec" id="moveSec"><h3>Location <span class="mono" style="letter-spacing:0;text-transform:none;font-weight:400">${esc(locShort(c))}</span></h3>
    <div class="movebox">
      <div class="field"><label for="m_binder">Binder</label><select id="m_binder">${bs.map(b=>`<option value="${esc(b.id)}" ${b.id===bid?"selected":""}>${esc(b.name)}</option>`).join("")}<option value="" ${bid?"":"selected"}>Not in a binder</option></select></div>
      <div class="field"><label for="m_page">Page</label><input id="m_page" class="mono" type="number" min="1" inputmode="numeric" value="${esc(c.page||1)}" ${bid?"":"disabled"}></div>
      <div class="field"><label for="m_slot">Pocket</label><select id="m_slot" class="mono" ${bid?"":"disabled"}>${Array.from({length:n},(_,i)=>`<option value="${i+1}" ${c.slot===i+1?"selected":""}>${i+1}</option>`).join("")}</select></div>
      <div class="note" id="moveNote"></div>
      <div class="btns"><button class="btn" type="button" id="btnMove">Move card</button><button class="btn ghost sm" type="button" id="btnFree">Next empty pocket</button>${bid?`<button class="btn ghost sm" type="button" id="btnTakeOut">Take out of binder</button>`:""}</div>
    </div></div>`;
}
function priceRowView(p){
  const t = PTYPES.find(x=>x[0]===p.type) || [p.type,p.type];
  if(S.editPrice===p.id) return `<div class="prow editing" data-pid="${esc(p.id)}">${priceFields("e", p)}<div class="formfoot" style="margin-top:8px"><span></span><span style="display:flex;gap:6px"><button class="btn sm" type="button" data-pcancel>Cancel</button><button class="btn sm primary" type="button" data-psave="${esc(p.id)}">Save entry</button></span></div></div>`;
  const conf = S.confirm==="p:"+p.id;
  return `<div class="prow" data-pid="${esc(p.id)}">
    <span class="date">${esc(p.date||"—")}</span>
    <span><span class="chip ${esc(p.type)}">${esc(t[1])}</span></span>
    <span class="amt">${money(p.amount, p.currency)}${p.currency==="USD"?`<small>≈ ${money(toCAD(p))}</small>`:""}</span>
    <span class="acts">${conf?`<button class="btn sm danger solid" type="button" data-pdelyes="${esc(p.id)}">Delete</button><button class="btn sm" type="button" data-pdelno>Keep</button>`:`<button class="btn sm ghost" type="button" data-pedit="${esc(p.id)}" aria-label="Edit entry">Edit</button><button class="btn sm ghost" type="button" data-pdel="${esc(p.id)}" aria-label="Delete entry">✕</button>`}</span>
    ${(p.where||p.note)?`<span class="where" style="grid-column:1/-1">${esc(p.where||"")}${p.note?`<small>${esc(p.note)}</small>`:""}</span>`:""}
  </div>`;
}
function priceFields(pre, p={}){
  return `<div class="pricebox">
    <div class="field"><label for="${pre}_type">Type</label><select id="${pre}_type">${opt(PTYPES,p.type||"market")}</select></div>
    <div class="field"><label for="${pre}_amount">Amount</label><input id="${pre}_amount" class="mono" type="number" step="0.01" min="0" inputmode="decimal" value="${p.amount!=null?esc(p.amount):""}" placeholder="0.00"></div>
    <div class="field"><label for="${pre}_cur">Currency</label><select id="${pre}_cur">${opt(["CAD","USD"],p.currency||"CAD")}</select></div>
    <div class="field"><label for="${pre}_date">Date</label><input id="${pre}_date" type="date" value="${esc(p.date||today())}"></div>
    <div class="field w2"><label for="${pre}_where">Where</label><input id="${pre}_where" list="dl_where" value="${esc(p.where ?? (pre==="n"?"PriceCharting":""))}" placeholder="eBay, TCGplayer, FB Marketplace, card show…"></div>
    <div class="field full"><label for="${pre}_note">Note</label><input id="${pre}_note" value="${esc(p.note||"")}" placeholder="Condition, grade, lot of 3, shipping incl…"></div>
  </div>`;
}
function priceSection(c){
  const list = prices(c), mine = list.filter(p=>!p.auto), daily = list.filter(p=>p.auto);
  const dailyLog = daily.length ? `<details class="autolog" id="autoLog"${S.autoLogOpen?" open":""}><summary>Daily prices · ${daily.length} day${daily.length===1?"":"s"}, latest ${esc(money(daily[0].amount))} on ${esc(daily[0].date||"")}</summary><div class="plog">${daily.map(priceRowView).join("")}</div></details>` : "";
  return `<div class="sec" id="priceSec"><h3>Price log <span class="hint" style="letter-spacing:0;text-transform:none;font-weight:400">newest first</span></h3>
    ${mine.length?`<div class="plog" id="plog">${mine.map(priceRowView).join("")}</div>`:daily.length?"":`<p class="hint" style="margin:0">No prices logged yet.</p>`}${dailyLog}
    <datalist id="dl_where">${["eBay","TCGplayer","PriceCharting","Facebook Marketplace","Local card shop","Card show","Collectr","Trade"].map(s=>`<option value="${s}">`).join("")}</datalist>
    <div style="margin-top:14px;border:1px dashed var(--line);border-radius:8px;padding:12px">
      <h3 style="margin-bottom:8px">Add a price</h3>
      ${priceFields("n")}
      <div class="formfoot" style="margin-top:10px"><span class="hint">“Market price” and “Sold comp” set the card's value. “I sold it” marks the card sold.</span><button class="btn primary sm" type="button" id="btnAddPrice">Add entry</button></div>
    </div></div>`;
}
function readPriceFields(pre){
  const amount = parseFloat($("#"+pre+"_amount").value);
  if(isNaN(amount) || amount < 0){ toast("Enter an amount, like 42.50."); $("#"+pre+"_amount").focus(); return null; }
  return { type: $("#"+pre+"_type").value, amount: Math.round(amount*100)/100, currency: $("#"+pre+"_cur").value, date: $("#"+pre+"_date").value || today(), where: $("#"+pre+"_where").value.trim(), note: $("#"+pre+"_note").value.trim() };
}
function readForm(){
  const f = $("#cardForm"); const o = {};
  ["name","set","setCode","number","rarity","variant","language","condition","grader","grade","artist","status","notes"].forEach(k => { o[k] = (f.elements[k].value||"").trim(); });
  return o;
}


/* ---------- automatic prices and official images ---------- */
const SRC = {pricecharting:"PriceCharting", tcgplayer:"TCGplayer"};
const isLinked = p => !!p && (p.source==="pricecharting" || p.source==="tcgplayer") && !!p.id;
const dailyPrices = c => (Array.isArray(c.prices)?c.prices:[]).filter(p=>p.auto && typeof p.amount==="number").sort((a,b)=>(a.date||"").localeCompare(b.date||""));
const picChoice = c => !c.officialImageId
  ? `<p class="hint" style="margin:0">The official high-resolution picture is added automatically once the card is matched to a price site.</p>`
  : `<div class="seg" role="group" aria-label="Picture to show"><button type="button" data-pic="official" aria-pressed="${shown(c)===c.officialImageId}">Official image</button><button type="button" data-pic="photo" aria-pressed="${shown(c)!==c.officialImageId}" ${c.imageId?"":"disabled title=\"Add a photo below first\""}>Your photo</button></div>`;
function sparkline(list){
  if(list.length < 2) return "";
  const w = 300, h = 64, pad = 5, vals = list.map(p=>p.amount), lo = Math.min(...vals), hi = Math.max(...vals), span = hi-lo || 1;
  const pts = list.map((p,i)=>[pad + i*(w-2*pad)/(list.length-1), h-pad - (p.amount-lo)*(h-2*pad)/span].map(n=>n.toFixed(1)).join(",")).join(" ");
  const first = list[0], last = list[list.length-1];
  return `<figure class="spark"><svg viewBox="0 0 ${w} ${h}" preserveAspectRatio="none" role="img" aria-label="Daily price from ${esc(first.date)} to ${esc(last.date)}: ${esc(money(first.amount))} to ${esc(money(last.amount))}"><polyline points="${pts}"/></svg>
    <figcaption><span>${esc(first.date)}<b>${esc(money(first.amount))}</b></span><span>low ${esc(money(lo))} · high ${esc(money(hi))}</span><span>${esc(last.date)}<b>${esc(money(last.amount))}</b></span></figcaption></figure>`;
}
function candList(list, from){
  if(!list || !list.length) return `<p class="hint">Nothing found. Try a different search, like the card name and number.</p>`;
  return `<ul class="cands">${list.map((x,i)=>`<li>${x.thumb?`<img src="${esc(x.thumb)}" alt="" loading="lazy" referrerpolicy="no-referrer">`:`<span class="thumb"></span>`}<div><b>${esc(x.title)}</b><span>${esc(x.set||"")}${x.number?` · #${esc(x.number)}`:""}</span><span>${esc(SRC[x.source]||x.source)}${x.usd!=null?` · US$${Number(x.usd).toFixed(2)}`:""}${x.url?` · <a href="${esc(x.url)}" target="_blank" rel="noopener">view</a>`:""}</span></div><button class="btn sm primary" type="button" data-cand="${from}:${i}">Use this</button></li>`).join("")}</ul>`;
}
function autoInfo(c){
  const p = c.pricing || null, daily = dailyPrices(c), last = daily[daily.length-1];
  const busy = S.priceBusy===c.id ? `<p class="hint">Working…</p>` : "";
  if(isLinked(p)) return `<p class="autoline"><a href="${esc(p.url||"#")}" target="_blank" rel="noopener">${esc(SRC[p.source])}: ${esc(p.title||"")}${p.set?` · ${esc(p.set)}`:""}</a> <span class="chip">${p.linkedBy==="user"?"you chose this":"matched automatically"}</span></p>
    ${last?`<p class="hint" style="margin:4px 0 0">Latest ${esc(money(last.amount))} on ${esc(last.date)}${last.usd!=null?` (US$${Number(last.usd).toFixed(2)})`:""}. Updated every day; the last 30 days are kept.</p>`:`<p class="hint" style="margin:4px 0 0">No price yet.</p>`}
    ${p.error?`<p class="autoerr">${esc(p.error)}</p>`:""}${sparkline(daily)}${busy}
    <div class="links"><button class="btn sm" type="button" data-pr="refresh">Update now</button><button class="btn sm" type="button" data-pr="pick">Change match</button><button class="btn sm ghost" type="button" data-pr="off">Turn off</button></div>`;
  if(p && p.source==="off") return `<p class="hint" style="margin:0">Automatic pricing is off for this card, so its value comes from the prices you log.</p>${busy}<div class="links"><button class="btn sm" type="button" data-pr="auto">Turn it back on</button></div>`;
  if(p && p.source==="none") return `<p class="autoerr">No certain match on PriceCharting or TCGplayer. If one of these is the card, choose it.</p>${p.error?`<p class="autoerr">${esc(p.error)}</p>`:""}${candList(p.candidates||[], "stored")}${busy}<div class="links"><button class="btn sm" type="button" data-pr="pick">Search</button><button class="btn sm ghost" type="button" data-pr="off">Turn off</button></div>`;
  return `<p class="hint" style="margin:0">This card is matched to PriceCharting or TCGplayer at the next daily update. You can do it now.</p>${p&&p.error?`<p class="autoerr">${esc(p.error)}</p>`:""}${busy}<div class="links"><button class="btn sm primary" type="button" data-pr="refresh">Find its price now</button><button class="btn sm" type="button" data-pr="pick">Choose the match</button></div>`;
}
const pickerQuery = c => S.pickQ ?? [c.name, String(c.number||"").split("/")[0]].filter(Boolean).join(" ");
function pickerHTML(c){
  const r = S.pickRes;
  return `<div class="picker"><form class="search" id="pickForm" role="search"><input id="pickQ" type="search" value="${esc(pickerQuery(c))}" aria-label="Search PriceCharting and TCGplayer"><button class="btn sm" type="submit">Search</button></form>
    ${r==="loading"?`<p class="hint">Searching PriceCharting and TCGplayer…</p>`:r&&r.error?`<p class="autoerr">${esc(r.error)}</p>`:Array.isArray(r)?candList(r,"search"):""}
    <button class="btn sm ghost" type="button" data-pr="cancel">Close search</button></div>`;
}
const autoSection = c => `<div class="sec" id="autoSec"><h3>Automatic price</h3><div id="autoInfo">${autoInfo(c)}</div><div id="pickZone">${S.pricePick===c.id?pickerHTML(c):""}</div></div>`;
const renderPicker = () => { const z=$("#pickZone"), c=selCard(); if(z && c) z.innerHTML = S.pricePick===c.id ? pickerHTML(c) : ""; };
const renderAutoInfo = () => { const a=$("#autoInfo"), c=selCard(); if(a && c) a.innerHTML = autoInfo(c); };
async function priceCall(method, url, body){
  try{ return await window.ledgerApi.call(method, url, body); }
  catch(e){ toast(e?.message || "That didn't work. Try again."); throw e; }
}
const OUTCOME = {updated:"Price updated", needsMatch:"No certain match found. Choose one from the list.", noPrice:"Matched, but the site has no price for it yet.", failed:"The price site didn't answer. It'll try again tomorrow.", skipped:"Sold and traded cards aren't priced automatically.", off:"Automatic pricing turned off"};
async function priceAction(kind, c, arg){
  if(!c || S.sel==="__new") return;
  if(kind==="pick"){ S.pricePick=c.id; S.pickQ=null; renderPicker(); return void pickSearch(c); }
  if(kind==="cancel"){ S.pricePick=null; S.pickRes=null; return renderPicker(); }
  S.priceBusy=c.id; renderAutoInfo();
  try{
    const r = kind==="refresh" ? await priceCall("POST", "api/pricing/refresh/"+encodeURIComponent(c.id))
      : await priceCall("POST", "api/pricing/link/"+encodeURIComponent(c.id), kind==="link" ? arg : {source:kind});
    if(kind==="link"){ S.pricePick=null; S.pickRes=null; renderPicker(); }
    toast(kind==="auto" && r.outcome==="updated" ? "Automatic pricing is back on" : OUTCOME[r.outcome] || "Done");
  }catch(_){}
  finally{ S.priceBusy=null; renderAutoInfo(); }
}
async function pickSearch(c){
  S.pickRes="loading"; renderPicker();
  try{ const r = await window.ledgerApi.call("GET", "api/pricing/search?card="+encodeURIComponent(c.id)+"&q="+encodeURIComponent(pickerQuery(c))); S.pickRes = r.candidates; }
  catch(e){ S.pickRes = {error: e?.message || "The search didn't work. Try again."}; }
  if(S.pricePick===c.id) renderPicker();
}
const pricingStatus = () => S.pricing || {};
function pricingStat(){
  const st = pricingStatus(), last = st.lastRun, need = S.cards.filter(c=>held(c) && c.pricing && c.pricing.source==="none").length;
  const v = st.running ? `Updating <small>${st.done||0}/${st.total||0}</small>` : last ? `${esc(String(last.date).slice(5))} <small>${need?`${need} need a match`:"daily"}</small>` : `— <small>not run yet</small>`;
  return `<button type="button" class="stat statbtn" id="btnPriceStatus" title="Automatic prices"><span class="k">Prices updated</span><span class="v">${v}</span></button>`;
}
function pricingSettingsHTML(){
  const st = pricingStatus(), last = st.lastRun, c = last?.counts || {};
  const need = S.cards.filter(x=>held(x) && x.pricing && x.pricing.source==="none");
  return `<div class="sec" style="margin-top:18px;border-top:1px solid var(--line-2);padding-top:14px" id="sPricing">
    <h3>Automatic prices</h3>
    <p class="hint" style="margin:0 0 8px">Every morning each card's market price is read from PriceCharting (TCGplayer for cards it doesn't list), converted to Canadian dollars at the Bank of Canada's rate, and added to its price log. The last 30 days are kept. Prices you log yourself are never changed.</p>
    ${st.running?`<p><b>Updating now:</b> ${st.done||0} of ${st.total||0} cards…</p>`:last?`<p style="margin:0 0 6px">Last update <b>${esc(last.date)}</b> (${esc(last.reason==="manual"?"started by you":"daily")}) · ${c.updated||0} updated${c.needsMatch?` · ${c.needsMatch} need a match`:""}${c.noPrice?` · ${c.noPrice} without a price`:""}${c.failed?` · ${c.failed} failed`:""} · US$1 = C$${Number(last.rate).toFixed(4)}</p>`:`<p class="hint">Not run yet.</p>`}
    ${last && last.errors && last.errors.length?`<details class="autolog"><summary>Problems (${last.errors.length})</summary><ul class="errs">${last.errors.map(e=>`<li><b>${esc(e.card)}</b>: ${esc(e.error)}</li>`).join("")}</ul></details>`:""}
    ${need.length?`<p style="margin:8px 0 4px">These cards need you to choose their match:</p><div class="links">${need.map(x=>`<button class="btn sm" type="button" data-openc="${esc(x.id)}">${esc(x.name||"Unnamed card")} ${esc(metaLine(x))}</button>`).join("")}</div>`:""}
    <div class="links" style="margin-top:10px"><button class="btn sm primary" type="button" id="sRunPrices" ${st.running?"disabled":""}>Update all prices now</button></div>
  </div>`;
}

/* ---------- card details: set, set code, rarity and illustrator from TCGdex ---------- */
/* Typing a name and number fills the empty fields (never what the person typed); several matches
   are offered as pictures to choose from. The server does the same for cards added any other way. */
const DETAIL_INPUTS = {set:"f_set", setCode:"f_setCode", rarity:"f_rarity", artist:"f_artist"};
const DETAIL_FIELDS = Object.keys(DETAIL_INPUTS);
let DL = {key:"", t:0, seq:0, res:[], auto:{}};
function resetLookup(){ clearTimeout(DL.t); DL = {key:"", t:0, seq:DL.seq+1, res:[], auto:{}}; }
const fieldVal = id => ($("#"+id)?.value || "").trim();
/* a field counts as empty if it's blank or still holds what the lookup put there */
const lookupOwns = f => { const v = fieldVal(DETAIL_INPUTS[f]); return !v || DL.auto[f]===v; };
function detailsHint(html){ const h=$("#detailsHint"); if(!h) return; h.hidden = !html; h.innerHTML = html || ""; }
function scheduleLookup(){
  clearTimeout(DL.t);
  if(S.me?.user?.role==="viewer") return;
  if(!fieldVal("f_name") || !fieldVal("f_number")){ DL.key=""; detailsHint(""); return; }
  if(!DETAIL_FIELDS.some(lookupOwns)) return;
  DL.t = setTimeout(runLookup, 650);
}
async function runLookup(){
  const name = fieldVal("f_name"), number = fieldVal("f_number");
  if(!name || !number || !DETAIL_FIELDS.some(lookupOwns)) return;
  const set = lookupOwns("set") ? "" : fieldVal("f_set"), setCode = lookupOwns("setCode") ? "" : fieldVal("f_setCode");
  const key = [name, number, set, setCode].join("|").toLowerCase(); if(key===DL.key) return;
  DL.key = key; const seq = ++DL.seq;
  detailsHint(`<span class="hint">Looking up ${esc(name)} ${esc(number)}…</span>`);
  try{
    const q = new URLSearchParams({name, number}); if(set) q.set("set", set); if(setCode) q.set("setCode", setCode);
    const r = await window.ledgerApi.call("GET", "api/cards/lookup?"+q);
    if(seq!==DL.seq || !$("#cardForm")) return;
    DL.res = Array.isArray(r?.matches) ? r.matches : [];
    if(DL.res.length===1) return applyDetails(DL.res[0]);
    if(!DL.res.length) return detailsHint(`<span class="hint">${esc(name)} ${esc(number)} isn't in the card database (TCGdex). Fill in the rest by hand; brand-new and some promo cards take a while to appear.</span>`);
    detailsHint(`<p class="hint" style="margin:0 0 6px">${DL.res.length} cards are ${esc(name)} ${esc(number)}. Which one is yours?</p>
      <div class="dchoices">${DL.res.map((m,i)=>`<button type="button" class="dchoice" data-dpick="${i}">${m.thumb?`<img src="${esc(m.thumb)}" alt="" loading="lazy">`:`<span class="thumb"></span>`}<span class="dtxt"><b>${esc(m.set)}</b><span class="mono">${esc([m.setCode, m.number+(m.total?`/${m.total}`:"")].filter(Boolean).join(" "))}</span><span class="hint">${esc([m.rarity, m.artist].filter(Boolean).join(" · "))}</span></span></button>`).join("")}</div>
      <p class="hint" style="margin:6px 0 0">Or add the set size to the number (like 51/162), or type the set code.</p>`);
  }catch(e){
    if(seq!==DL.seq) return; DL.key = "";
    detailsHint(`<span class="hint">${e?.code==="upstream_error" || e?.code==="unavailable" ? "The card database didn't answer. Fill in the rest by hand, or change the number to try again." : esc(e?.message || "Couldn't look the card up.")}</span>`);
  }
}
function applyDetails(m){
  const vals = {set:m.set, setCode:m.setCode, rarity:m.rarity, artist:m.artist}, filled = [];
  for(const f of DETAIL_FIELDS){
    const el = $("#"+DETAIL_INPUTS[f]); if(!el || !vals[f] || !lookupOwns(f)) continue;
    el.value = vals[f]; DL.auto[f] = vals[f]; el.classList.add("autofilled"); filled.push(f);
  }
  if(filled.length){ S.dirty = true; const b=$("#btnSave"); if(b) b.disabled = false; }
  const what = [m.set, m.setCode, m.rarity, m.artist].filter(Boolean).join(" · ");
  detailsHint(`<span class="dok">${filled.length?"Filled in from TCGdex":"Matches TCGdex"}: <b>${esc(what)}</b></span>${filled.length?` <button type="button" class="btn sm ghost" data-dundo>Undo</button>`:""}`);
}
function undoDetails(){
  for(const f of DETAIL_FIELDS){ const el=$("#"+DETAIL_INPUTS[f]); if(el && DL.auto[f] && el.value===DL.auto[f]){ el.value=""; el.classList.remove("autofilled"); } }
  DL.auto = {}; detailsHint(`<span class="hint">Cleared. Type the details by hand, or change the name or number to look it up again.</span>`);
}
/* Settings: what new cards get, and Fill in missing details for the cards already here */
const lookedUpThisWeek = c => c.details?.checkedAt && Date.now()-Date.parse(c.details.checkedAt) < 7*86400000;
/* cards looked up before the current checks are looked up again straight away (same rule as the server) */
const DETAILS_VERSION = 2;
const detailsOutdated = c => { const d = c.details; return !!d?.checkedAt && d.v!==DETAILS_VERSION && (!!d.id || d.result==="notFound" || d.result==="several"); };
const wantsDetails = c => c.name && c.number && (!c.language || /^en/i.test(c.language)) && (detailsOutdated(c) || [...DETAIL_FIELDS,"released"].some(f=>!String(c[f]??"").trim()) && !lookedUpThisWeek(c));
function detailsSettingsHTML(){
  const st = S.detailsRun || {}, last = st.lastRun, n = S.cards.filter(wantsDetails).length;
  return `<div class="sec" style="margin-top:18px;border-top:1px solid var(--line-2);padding-top:14px" id="sDetails">
    <h3>Card details</h3>
    <p class="hint" style="margin:0 0 8px">New cards get their set, set code, rarity, illustrator and release date from TCGdex, a free card database, and then their price and picture, as soon as they're added. Only empty fields are filled; what you type always stays.</p>
    ${st.running?`<p><b>Filling in now:</b> ${st.done||0} of ${st.total||0} cards…</p>`:last?`<p style="margin:0 0 6px">Last fill-in: ${last.filled||0} card${last.filled===1?"":"s"} filled${last.several?` · ${last.several} with several matches (open them to choose)`:""}${last.notFound?` · ${last.notFound} not in the database`:""}${last.error?` · ${last.error} failed`:""}</p>`:""}
    <div class="links" style="margin-top:6px"><button class="btn sm" type="button" id="sFillDetails" ${st.running||!n?"disabled":""}>Fill in missing details${n?` (${n} card${n===1?"":"s"})`:""}</button></div>
  </div>`;
}

/* ---------- writes ---------- */
async function saveCard(){
  const c = selCard(); if(!c) return;
  const data = readForm();
  if(!data.name){ toast("Give the card a name."); $("#f_name").focus(); return; }
  if(S.sel==="__new"){
    const loc = {binderId:c.binderId||null, page:c.binderId?c.page:null, slot:c.binderId?c.slot:null};
    if(loc.binderId && cardAt(loc.binderId, loc.page, loc.slot)){ const f = firstFree(loc.binderId); loc.page=f.page; loc.slot=f.slot; }
    const id = rid();
    const ok = await guard(()=> S.db.collection("cards").doc(id).set({...data, ...loc, placeholder:!!$("#f_placeholder")?.checked, imageId:c.imageId||null, prices:[], createdAt:nowISO(), updatedAt:nowISO()}));
    if(ok){ toast(`Added ${data.name}. Looking up its price and picture…`); S.sel=id; S.draft=null; S.dirty=false; if(loc.binderId){ S.binderId=loc.binderId; S.page=loc.page; persistNav(); } render(); renderDrawer(true); }
    return;
  }
  const ok = await guard(()=> S.db.doc("cards/"+c.id).update({...data, updatedAt:nowISO()}));
  if(ok){ S.dirty=false; const b=$("#btnSave"); if(b) b.disabled=true; toast("Saved"); refreshParts(selCard()); }
}
async function updateCard(id, patch){ return guard(()=> S.db.doc("cards/"+id).update({...patch, updatedAt:nowISO()})); }
async function addPrice(){
  const c = selCard(); const p = readPriceFields("n"); if(!p) return;
  p.id = rid(); p.at = nowISO();
  const patch = {prices:[...(c.prices||[]), p]};
  if(p.type==="mysale") patch.status="sold";
  if(p.type==="listed" && (c.status||"binder")==="binder") patch.status="listed";
  if(await updateCard(c.id, patch)){ S.priceTouched=false; refreshParts(selCard(),{price:true}); toast(p.type==="mysale"?"Sale logged. Card marked sold.":"Price added"); }
}
async function savePrice(pid){
  const c = selCard(); const p = readPriceFields("e"); if(!p) return;
  const list = (c.prices||[]).map(x => x.id===pid ? {...x, ...p} : x);
  if(await updateCard(c.id, {prices:list})){ S.editPrice=null; refreshParts(selCard(),{price:true}); toast("Entry updated"); }
}
async function delPrice(pid){
  const c = selCard();
  if(await updateCard(c.id, {prices:(c.prices||[]).filter(x=>x.id!==pid)})){ S.confirm=null; refreshParts(selCard(),{price:true}); toast("Entry deleted"); }
}
async function moveCard(c, bid, page, slot){
  if(!bid){ if(await updateCard(c.id,{binderId:null,page:null,slot:null})){ S.moveTouched=false; render(); refreshParts(selCard(),{move:true}); toast(`${c.name||"Card"} taken out of the binder`); } return; }
  const other = cardAt(bid, page, slot);
  if(other && other.id===c.id) return toast("It's already there.");
  if(other){
    const back = c.binderId && binderById(c.binderId) ? {binderId:c.binderId, page:c.page, slot:c.slot} : {binderId:null,page:null,slot:null};
    if(!(await updateCard(other.id, back))) return;
  }
  if(await updateCard(c.id, {binderId:bid, page, slot})){
    toast(other ? `Swapped with ${other.name||"the card there"}` : `Moved to ${locText({binderId:bid,page,slot})}`);
    S.binderId = bid; S.page = page; S.moveTouched=false; persistNav(); render(); refreshParts(selCard(),{move:true});
  }
}
/* duplicate: same details and photo, market/comp prices carried over; paid, listing and sale entries stay with the original */
function nextFreeAfter(bid, page, slot, taken){
  const b = binderById(bid); if(!b) return null; const n = pocketsOf(b);
  const busy = (p,s) => cardAt(bid,p,s) || taken.has(p+":"+s);
  const last = maxPage(bid) + Math.ceil((taken.size+1)/n) + 1;
  for(let p=Math.max(1,page||1); p<=last; p++) for(let s=(p===(page||1)?(slot||0)+1:1); s<=n; s++) if(!busy(p,s)) return {page:p, slot:s};
  for(let p=1; p<=last; p++) for(let s=1; s<=n; s++) if(!busy(p,s)) return {page:p, slot:s};
  return {page:last+1, slot:1};
}
function dupData(c, spot){
  const {id, createdAt, updatedAt, prices:pr, status, binderId, page, slot, ...rest} = c;
  const keep = (Array.isArray(pr)?pr:[]).filter(p => p.type==="comp" || p.type==="market").map(p => ({...p, id:rid()}));
  const loc = binderId && binderById(binderId) && spot ? {binderId, page:spot.page, slot:spot.slot} : {binderId:null, page:null, slot:null};
  return {...rest, ...loc, status:"binder", prices:keep, createdAt:nowISO(), updatedAt:nowISO()};
}
async function duplicateCards(ids){
  if(!S.db){ toast("Saving isn't available in this view."); return []; }
  const src = ids.map(id => S.cards.find(c=>c.id===id)).filter(Boolean)
    .sort((a,b)=> SORTS.loc(a) < SORTS.loc(b) ? -1 : SORTS.loc(a) > SORTS.loc(b) ? 1 : 0);
  const taken = {}, jobs = [];
  for(const c of src){
    const inB = c.binderId && binderById(c.binderId);
    let spot = null;
    if(inB){ const t = taken[c.binderId] ||= new Set(); spot = nextFreeAfter(c.binderId, c.page, c.slot, t); t.add(spot.page+":"+spot.slot); }
    const nid = rid(), data = dupData(c, spot);
    jobs.push({nid, data, name:c.name});
  }
  const res = await Promise.allSettled(jobs.map(j => S.db.collection("cards").doc(j.nid).set(j.data)));
  const ok = jobs.filter((_,i)=>res[i].status==="fulfilled"), failed = jobs.length-ok.length;
  if(failed){ const err = res.find(r=>r.status==="rejected")?.reason; console.error(err);
    toast(ok.length ? `Duplicated ${ok.length}. ${failed} couldn't be copied.` : (err?.code==="invalid_argument"||err?.code==="not_granted" ? "Nothing was copied. You may only have view access." : err?.code==="quota_exceeded" ? "The ledger is full. Delete some cards to add more." : "Couldn't duplicate. Check your connection and try again.")); }
  return ok;
}
async function duplicateCard(){
  const c = selCard(); if(!c || S.sel==="__new") return;
  if(S.dirty){ toast("Save or discard your changes first, then duplicate."); return; }
  const [j] = await duplicateCards([c.id]); if(!j) return;
  const d = j.data;
  toast(d.binderId ? `Copy of ${c.name||"card"} added to ${locText(d)}` : `Copy of ${c.name||"card"} added`);
  S.sel = j.nid; S.draft=null; S.dirty=false; S.editPrice=null; S.confirm=null;
  if(d.binderId){ S.binderId=d.binderId; S.page=d.page; persistNav(); }
  render(); renderDrawer(true);
}
async function duplicatePicked(){
  const ids = [...(S.pick||[])]; if(!ids.length) return;
  const ok = await duplicateCards(ids);
  if(ok.length && ok.length===ids.length){ toast(`Duplicated ${ok.length} card${ok.length===1?"":"s"}`); endPick(); }
}
async function deleteCard(){
  const c = selCard(); if(!c || S.sel==="__new") return;
  const img = c.imageId;
  if(await guard(()=> S.db.doc("cards/"+c.id).delete())){
    if(img && S.assets && !S.cards.some(x=>x.id!==c.id && x.imageId===img)){ try{ await delAsset(img); }catch(e){} }
    if(c.officialImageId && S.assets){ try{ await delAsset(c.officialImageId); }catch(e){} }
    toast(`Deleted ${c.name||"card"}`); closeDrawer();
  }
}
async function deletePicked(){
  const ids = [...(S.pick||[])]; if(!ids.length) return;
  if(!S.db){ toast("Saving isn't available in this view."); return; }
  const gone = S.cards.filter(c=>ids.includes(c.id));
  const res = await Promise.allSettled(ids.map(id => S.db.doc("cards/"+id).delete()));
  const okIds = ids.filter((_,i)=>res[i].status==="fulfilled"), failed = ids.length-okIds.length;
  if(S.assets){
    const left = S.cards.filter(c=>!okIds.includes(c.id));
    const imgs = [...new Set(gone.filter(c=>okIds.includes(c.id) && c.imageId).map(c=>c.imageId))].filter(img=>!left.some(c=>c.imageId===img));
    for(const img of imgs){ try{ await delAsset(img); }catch(e){} }
    for(const c of gone) if(okIds.includes(c.id) && c.officialImageId){ try{ await delAsset(c.officialImageId); }catch(e){} }
  }
  if(failed){ const err = res.find(r=>r.status==="rejected")?.reason; console.error(err);
    S.pick = new Set(ids.filter(id=>!okIds.includes(id))); S.pickConfirm=false; renderMain();
    toast(okIds.length ? `Deleted ${okIds.length}. ${failed} couldn't be deleted.` : (err?.code==="invalid_argument"||err?.code==="not_granted" ? "Those cards weren't deleted. You may only have view access." : "Couldn't delete. Check your connection and try again."));
    return; }
  toast(`Deleted ${okIds.length} card${okIds.length===1?"":"s"}`); endPick();
}
async function decodeImage(file){
  if(window.createImageBitmap){
    try{ return await createImageBitmap(file, {imageOrientation:"from-image"}); }catch(e){}
    try{ return await createImageBitmap(file); }catch(e){}
  }
  const tryImg = src => new Promise((res,rej)=>{ const i=new Image(); i.onload=()=> i.naturalWidth ? res(i) : rej(new Error("empty")); i.onerror=()=>rej(new Error("img")); i.src=src; });
  let url = null;
  try{ url = URL.createObjectURL(file); return await tryImg(url); }catch(e){}
  finally{ if(url){ const u=url; setTimeout(()=>URL.revokeObjectURL(u), 30000); } }
  try{
    const d = await new Promise((res,rej)=>{ const r=new FileReader(); r.onload=()=>res(r.result); r.onerror=()=>rej(r.error); r.readAsDataURL(file); });
    return await tryImg(d);
  }catch(e){}
  throw Object.assign(new Error("decode"), {code:"decode"});
}
async function downscale(file, max=1000){
  const img = await decodeImage(file);
  const w = img.naturalWidth || img.width, h = img.naturalHeight || img.height;
  if(!w || !h) throw Object.assign(new Error("decode"), {code:"decode"});
  for(const m of [max, 800, 600]){
    const k = Math.min(1, m/Math.max(w,h));
    const cv = document.createElement("canvas"); cv.width=Math.max(1,Math.round(w*k)); cv.height=Math.max(1,Math.round(h*k));
    const ctx = cv.getContext("2d"); if(!ctx) continue;
    ctx.drawImage(img,0,0,cv.width,cv.height);
    const blob = await new Promise(r=>cv.toBlob(r,"image/jpeg",.86));
    cv.width = cv.height = 0;
    if(blob && blob.size) { try{ img.close && img.close(); }catch(e){} return blob; }
  }
  try{ img.close && img.close(); }catch(e){}
  throw Object.assign(new Error("encode"), {code:"decode"});
}
const sleep = ms => new Promise(r=>setTimeout(r,ms));
/* keep a small copy of the photo inside the card itself: used when this view can't store uploads */
async function inlinePhoto(blob){
  const img = await decodeImage(blob);
  const w = img.naturalWidth || img.width, h = img.naturalHeight || img.height;
  if(!w || !h) throw Object.assign(new Error("decode"), {code:"decode"});
  try{
    for(const [m,q] of [[440,.8],[380,.74],[320,.68],[260,.62]]){
      const k = Math.min(1, m/Math.max(w,h));
      const cv = document.createElement("canvas"); cv.width=Math.max(1,Math.round(w*k)); cv.height=Math.max(1,Math.round(h*k));
      const ctx = cv.getContext("2d"); if(!ctx) continue;
      ctx.drawImage(img,0,0,cv.width,cv.height);
      const d = cv.toDataURL("image/jpeg", q); cv.width = cv.height = 0;
      if(d && d.startsWith("data:image/jpeg") && d.length <= 110000) return d;
    }
  } finally { try{ img.close && img.close(); }catch(e){} }
  throw Object.assign(new Error("too_large"), {code:"too_large"});
}
/* upload to the artifact's photo storage; if that isn't available here, fall back to the in-card copy */
async function storePhoto(blob){
  let err = null;
  if(S.assets){
    for(let i=0;i<2;i++){
      try{ const r = await S.assets.upload(blob, {type:"image/jpeg"}); if(r && r.id) return r.id; err = {code:"upstream_error"}; }
      catch(e){ err = e; console.error("assets.upload failed", e); if(e?.code!=="store_unavailable" && e?.code!=="upstream_error") break; await sleep(700); }
    }
  }
  S.photoFallback = err?.code || "no_storage";
  return inlinePhoto(blob);
}
/* store the original file untouched (used when this view can't open the picture to shrink it) */
async function storeRaw(file){
  let err = null;
  for(let i=0;i<2;i++){
    try{ const r = await S.assets.upload(file, {type:file.type}); if(r && r.id) return r.id; err = {code:"upstream_error"}; }
    catch(e){ err = e; console.error("raw upload failed", e); if(e?.code!=="store_unavailable") break; await sleep(700); }
  }
  throw err || {code:"upstream_error"};
}
function uploadErr(e){
  const m = {too_large:"That photo is too large. Try a screenshot of it instead.", unsupported_type:"That file type isn't supported. Use a JPG, PNG or WebP.", quota_or_state:"Photo storage is full. Remove some photos first.", rate_limited:"Too many uploads at once. Wait a moment and try again.", not_granted:"You need edit access to add photos.", capability_disabled:"Photo uploads aren't available in this view.", decode:"That picture couldn't be opened here. Take a screenshot of it and use the screenshot instead.", heic:"That's an iPhone HEIC photo this view can't open. Take a screenshot of it and use the screenshot, or set Settings › Camera › Formats to Most Compatible.", notimage:"That file isn't a picture. Pick a JPG, PNG or screenshot."};
  const code = e?.code || e?.name || "";
  const msg = m[code] || `The photo didn't save${code?` (${code})`:""}. Try again, or take a screenshot of the picture and use that.`;
  toast(msg); console.error(e); return msg;
}
async function setPhoto(input, targetId, orig){
  if(!S.db) return toast("Saving isn't available in this view.");
  const tid = targetId ?? S.sel; if(!tid) return;
  photoNote("Saving the photo…");
  S.photoBusy = true; let errMsg = "", saved = null;
  try{
    const file = await input;
    if(!file || !file.size) throw {code:"decode"};
    const name = orig?.name || "";
    let blob = null, raw = false;
    try{ blob = await downscale(file); }
    catch(e){
      if(S.assets && /^image\/(jpeg|png|webp|gif)$/.test(file.type) && file.size <= 20*1024*1024){ blob = file; raw = true; }
      else if(/hei[cf]/i.test(file.type) || /\.hei[cf]$/i.test(name)) throw {code:"heic"};
      else throw e;
    }
    const r = {id: raw ? await storeRaw(blob) : await storePhoto(blob)};
    if(tid==="__new"){
      if(S.sel==="__new" && S.draft){ S.draft = {...S.draft, ...readForm(), imageId:r.id}; renderDrawer(true); }
      toast("Photo added"); return;
    }
    const c = S.cards.find(x=>x.id===tid); if(!c) return;
    const old = c.imageId;
    if(await updateCard(tid, {imageId:r.id})){
      saved = r.id; const cc = S.cards.find(x=>x.id===tid); if(cc) cc.imageId = r.id;
      if(old && !S.cards.some(x=>x.id!==tid && x.imageId===old)){ try{ await delAsset(old); }catch(e){} }
      toast("Photo saved");
    } else errMsg = "The photo was ready but the card didn't save. Check your connection and try again.";
  }catch(e){ errMsg = uploadErr(e); }
  finally{
    S.photoBusy = false;
    const c = selCard(); const ph=$("#photoSec");
    if(c && ph && S.sel===tid && S.sel!=="__new"){
      const cur = saved ? {...c, imageId:saved} : c;
      ph.outerHTML = photoSection(cur); const bi=$("#bigImg"); if(bi) bi.innerHTML = imgInner(cur);
    }
    if(saved && S.mode==="ready") renderMain();
    if(errMsg) photoNote(errMsg);
  }
}

/* ---------- binders ---------- */
function newBinder(){ binderModal(null); }
function binderModal(id){
  const isNew = !id;
  let b = isNew ? null : binderById(id); if(!isNew && !b) return;
  if(isNew){ const k = S.binders.length + 1; let nm = `Binder ${k}`, j=k; while(S.binders.some(x=>x.name===nm)) nm = `Binder ${++j}`; b = {name:nm, color:BINDER_COLORS[(k-1)%BINDER_COLORS.length], pockets:9}; }
  const count = isNew ? 0 : cardsIn(id).length;
  const n = pocketsOf(b);
  $("#modalRoot").innerHTML = `<div class="modal" data-mclose><div class="mcard narrow" role="dialog" aria-modal="true" aria-label="${isNew?"New binder":"Binder settings"}">
    <h2>${isNew?"New binder":"Binder settings"}</h2><p class="lead">${isNew?"Give it a name you'll recognise, like \u201cVintage holos\u201d or \u201cTrade binder\u201d.":`${count} card${count===1?"":"s"} across ${maxPage(id)} page${maxPage(id)===1?"":"s"}.`}</p>
    <div class="form" style="grid-template-columns:1fr">
      <div class="field"><label for="b_name">Binder name</label><input id="b_name" value="${esc(b.name)}" maxlength="40" placeholder="e.g. Vintage holos" autocomplete="off"></div>
      <div class="field"><label>Cover colour</label><div class="swatches" id="b_colors">${BINDER_COLORS.map(c=>`<button type="button" style="--c:${c}" data-color="${c}" aria-pressed="${(b.color||BINDER_COLORS[0])===c}" aria-label="Colour ${c}"></button>`).join("")}</div></div>
      <div class="field"><label for="b_pockets">Pockets per page</label><select id="b_pockets">${[4,9,12,16].map(p=>`<option value="${p}" ${p===n?"selected":""}>${p}-pocket</option>`).join("")}</select><span class="hint">Changing this doesn't move cards. Pockets past the new size stay listed but won't show on the page.</span></div>
    </div>
    <div class="mfoot" style="justify-content:space-between"><span id="bDelZone">${isNew?"":count?`<span class="hint">Move or delete its ${count} cards to remove this binder.</span>`:`<button class="btn sm danger" type="button" id="bDel">Delete binder</button>`}</span>
      <span style="display:flex;gap:8px"><button class="btn" type="button" data-mclose>Cancel</button><button class="btn primary" type="button" id="bSave">${isNew?"Create binder":"Save"}</button></span></div>
  </div></div>`;
  let color = b.color || BINDER_COLORS[0];
  $("#b_colors").onclick = e => { const t = e.target.closest("[data-color]"); if(!t) return; color = t.dataset.color; $("#b_colors").querySelectorAll("button").forEach(x=>x.setAttribute("aria-pressed", x===t)); };
  const nameIn = $("#b_name");
  setTimeout(()=>{ nameIn.focus(); nameIn.select(); }, 30);
  nameIn.addEventListener("keydown", e => { if(e.key==="Enter"){ e.preventDefault(); $("#bSave").click(); } });
  $("#bSave").onclick = async () => {
    const name = nameIn.value.trim() || b.name;
    const pockets = +$("#b_pockets").value;
    if(isNew){
      const nid = rid();
      if(await guard(()=> S.db.collection("binders").doc(nid).set({name, color, pockets, order:Math.max(0,...S.binders.map(x=>x.order||0))+1, createdAt:nowISO()}))){
        closeModal(); S.binderId=nid; S.page=1; persistNav(); toast(`${name} created`); render();
      }
      return;
    }
    if(await guard(()=> S.db.doc("binders/"+id).update({name, color, pockets}))){ closeModal(); toast(name!==b.name?`Renamed to ${name}`:"Binder saved"); }
  };
  const del = isNew ? null : $("#bDel");
  if(del) del.onclick = () => {
    $("#bDelZone").innerHTML = `<span class="confirm">Delete ${esc(b.name)}? <button class="btn sm danger solid" type="button" id="bDelYes">Delete</button></span>`;
    $("#bDelYes").onclick = async () => { if(await guard(()=> S.db.doc("binders/"+id).delete())){ closeModal(); S.binderId = sortedBinders().find(x=>x.id!==id)?.id || null; persistNav(); toast("Binder deleted"); render(); } };
  };
}
/* ---------- cards to check ----------
   What the nightly check against TCGdex (server/details.ts) found wrong with a card, plus cards
   without a certain price match. The same rules as status.txt (server/status.ts, detailsProblem). */
const checkIdentity = c => `${String(c.name??"").trim().toLowerCase()}|${String(c.number??"").replace(/\s+/g,"").toLowerCase()}`;
const normLabel = s => String(s??"").toLowerCase().replace(/[^a-z0-9]/g,"");
const CHECK_KINDS = [
  {k:"set", h:"Filed under another set"},
  {k:"name", h:"Name may be misspelled"},
  {k:"several", h:"Several cards match"},
  {k:"missing", h:"Not in the card database"},
  {k:"price", h:"No certain price match"}
];
function cardChecks(c){
  const out = [], d = c.details;
  if(d && d.v===DETAILS_VERSION && c.checksIgnored!==checkIdentity(c)){
    if(d.filedUnder && normLabel(c.set)===normLabel(d.filedUnder.as)) out.push({k:"set", title:"Filed under the wrong set", text:`Filed under ${d.filedUnder.name}, but ${c.name} ${c.number} is from ${d.set}${c.released?` (${c.released.slice(0,4)})`:""}.`});
    else if(d.result==="notFound" && d.suggest?.length) out.push({k:"name", title:"Name may be misspelled", text:`Not in the card database. Did you mean ${d.suggest.map(x=>x.name).join(" or ")}?`});
    else if(d.result==="several") out.push({k:"several", title:"Several cards match", text:`${(d.options||[]).length || "Several"} cards are ${c.name} ${c.number}. Which one is yours?`});
    else if(d.result==="notFound" && !pricedFromProduct(c)) out.push({k:"missing", title:"Not in the card database", text:"TCGdex doesn't have it. Check the name and number, or ignore it if it's right (brand-new and some box-set cards aren't listed; it's checked again weekly)."});
  }
  const p = c.pricing;
  if(p && c.status!=="sold" && c.status!=="traded"){
    if(p.source==="none" && !p.error && Array.isArray(p.candidates)) out.push({k:"price", title:"No certain price match", text:"The price sites had no certain match. Open it and choose the product."});
    else if(typeof p.error==="string" && p.error.includes("has no price for this printing")) out.push({k:"price", title:"No price yet", text:p.error});
  }
  return out;
}
const checkCount = () => S.cards.filter(c=>cardChecks(c).length).length;
/* linked to a product on a price site: that confirms its name and number, and fills its set and release date */
function pricedFromProduct(c){ const p = c.pricing; return !!p && (p.source==="pricecharting" || p.source==="tcgplayer") && !!p.id; }
/* the person's own label for a set: another card matched to it (Pokemon Base Set 2 · PBS), else TCGdex's */
function labelForSet(c){
  const d = c.details, mine = S.cards.find(x => x.id!==c.id && x.details?.setId===d.setId && x.set && !(x.details?.filedUnder && normLabel(x.set)===normLabel(x.details.filedUnder.as)));
  return mine ? {set:mine.set, setCode:mine.setCode||d.setCode||""} : {set:d.set, setCode:d.setCode||""};
}
/* "Mega Eelektross ex" typed as "… EX": keep the person's way of writing the last word */
function suggestedName(c, s){
  const mine = String(c.name||"").trim().split(/\s+/), theirs = s.name.split(/\s+/);
  if(mine.length && theirs.length && mine.at(-1).toLowerCase()===theirs.at(-1).toLowerCase()) theirs[theirs.length-1] = mine.at(-1);
  return theirs.join(" ");
}
let CHK = {done:new Set()};
function checksModal(){
  CHK = {done:new Set()};
  $("#modalRoot").innerHTML = `<div class="modal" data-mclose><div class="mcard" id="chkCard" role="dialog" aria-modal="true" aria-labelledby="chkTitle">
    <h2 id="chkTitle">Cards to check</h2>
    <p class="lead">Each night the binder checks every card against TCGdex, a free card database. These look wrong or couldn't be confirmed. Fix one in a tap, open it, or ignore it if it's right. An ignored card comes back if you change its name or number.</p>
    <div id="chkList"></div>
    <div class="mfoot"><button class="btn" type="button" data-mclose>Close</button></div>
  </div></div>`;
  $("#chkList").onclick = e => void checkAction(e);
  renderChecks();
}
function renderChecks(){
  const box = $("#chkList"); if(!box) return;
  const items = S.cards.flatMap(c => cardChecks(c).map(x => ({c, ...x}))).filter(x => !CHK.done.has(x.c.id+"|"+x.k));
  if(!items.length){ box.innerHTML = `<p class="empty-state">Nothing to check. Every card matches the card database or has been ignored.</p>`; return; }
  const viewer = S.me?.user?.role==="viewer";
  box.innerHTML = CHECK_KINDS.map(K => {
    const list = items.filter(x=>x.k===K.k); if(!list.length) return "";
    return `<section class="chksec"><h3>${esc(K.h)} <span class="hint">${list.length}</span></h3><ul class="chklist">${list.map(x => {
      const c = x.c, d = c.details || {}, id = esc(c.id);
      let fix = "";
      if(!viewer && x.k==="set"){ const l = labelForSet(c); fix = `<button class="btn sm primary" type="button" data-cfix="set" data-cid="${id}">File under ${esc(l.set)}</button>`; }
      if(!viewer && x.k==="name") fix = d.suggest.map((s,i)=>`<button class="btn sm primary" type="button" data-cfix="name" data-cid="${id}" data-copt="${i}">Rename to ${esc(suggestedName(c, s))}</button>`).join("");
      const choices = !viewer && x.k==="several" && d.options?.length ? `<div class="dchoices">${d.options.map(o=>`<button type="button" class="dchoice" data-cfix="pick" data-cid="${id}" data-copt="${esc(o.id)}">${o.thumb?`<img src="${esc(o.thumb)}" alt="" loading="lazy">`:`<span class="thumb"></span>`}<span class="dtxt"><b>${esc(o.set)}</b><span class="mono">${esc([o.setCode, o.number+(o.total?`/${o.total}`:"")].filter(Boolean).join(" "))}</span></span></button>`).join("")}</div>` : "";
      const ign = !viewer && x.k!=="price" ? `<button class="btn sm ghost" type="button" data-cfix="ignore" data-cid="${id}">Ignore</button>` : "";
      return `<li><div class="chkhead">${shown(c)?`<img class="thumb" src="${imgURL(shown(c))}" alt="" loading="lazy">`:`<span class="thumb"></span>`}<div><b>${esc(c.name||"Unnamed card")}</b> <span class="mono hint">${esc(metaLine(c))}</span><p>${esc(x.text)}</p><p class="hint">${esc(whereIs(c).label)}</p></div></div>
        ${choices}<div class="chkacts">${fix}<button class="btn sm" type="button" data-cfix="open" data-cid="${id}">Open</button>${ign}</div></li>`;
    }).join("")}</ul></section>`;
  }).join("");
}
async function checkAction(e){
  const b = e.target.closest("[data-cfix]"); if(!b) return;
  const c = S.cards.find(x=>x.id===b.dataset.cid); if(!c) return;
  const kind = b.dataset.cfix, k = {set:"set", name:"name", pick:"several"}[kind];
  if(kind==="open"){ closeModal(); return showCard(c.id); }
  b.disabled = true;
  let ok = false, msg = "";
  if(kind==="set"){ const l = labelForSet(c); ok = await updateCard(c.id, {set:l.set, setCode:l.setCode}); msg = `${c.name} is filed under ${l.set}`; }
  if(kind==="name"){ const n = suggestedName(c, c.details.suggest[+b.dataset.copt]); ok = await updateCard(c.id, {name:n}); msg = `Renamed to ${n}. Its details and price are being looked up.`; }
  if(kind==="pick"){
    try{ await window.ledgerApi.call("POST", `api/cards/${encodeURIComponent(c.id)}/details`, {id:b.dataset.copt}); ok = true; msg = `${c.name}: set filled in. Its price is being looked up.`; }
    catch(err){ toast(err?.message || "Couldn't use that card. Try again."); }
  }
  if(kind==="ignore"){ ok = await updateCard(c.id, {checksIgnored:checkIdentity(c)}); msg = `${c.name} won't be flagged unless its name or number changes`; }
  if(!ok){ b.disabled = false; return; }
  for(const x of cardChecks(c)) if(kind==="ignore" ? x.k!=="price" : x.k===k) CHK.done.add(c.id+"|"+x.k);
  toast(msg); renderChecks(); renderStats();
}

/* ---------- sort a binder ----------
   Puts every card of a binder in order (release date or price) from page 1, pocket 1 with no
   gaps, after a preview. The server saves all the moves together; Undo sends the old places back. */
const BINDER_ORDERS = [
  {k:"old", label:"Release date, oldest first"},
  {k:"new", label:"Release date, newest first"},
  {k:"high", label:"Price, highest first"},
  {k:"low", label:"Price, lowest first"}
];
function binderOrder(list, k){
  const cmp = (x,y) => x<y?-1:x>y?1:0;
  const byDate = k==="old" || k==="new", dir = k==="old" || k==="low" ? 1 : -1;
  const key = c => byDate ? (c.released || null) : valueOf(c);
  const tie = (a,b) => (byDate ? 0 : cmp(a.released||"9999", b.released||"9999")) || cmp(SORTS.set(a), SORTS.set(b)) || cmp(SORTS.name(a), SORTS.name(b)) || cmp(SORTS.loc(a), SORTS.loc(b));
  const known = list.filter(c=>key(c)!=null).sort((a,b)=> dir*cmp(key(a), key(b)) || tie(a,b));
  const rest = list.filter(c=>key(c)==null).sort((a,b)=> cmp(SORTS.loc(a), SORTS.loc(b)));
  return {order:[...known, ...rest], missing:rest.length};
}
function sortPlan(b, k){
  const n = pocketsOf(b), {order, missing} = binderOrder(cardsIn(b.id), k);
  const moves = order.map((c,i)=>({id:c.id, page:Math.floor(i/n)+1, slot:i%n+1}));
  const moved = moves.filter((m,i)=> order[i].page!==m.page || order[i].slot!==m.slot).length;
  return {n, order, moves, moved, missing, pages:Math.ceil(order.length/n)};
}
let sortK = "old";
function sortModal(id){
  const b = binderById(id); if(!b) return;
  $("#modalRoot").innerHTML = `<div class="modal" data-mclose><div class="mcard narrow" role="dialog" aria-modal="true" aria-labelledby="sortTitle">
    <h2 id="sortTitle">Sort ${esc(b.name)}</h2>
    <p class="lead">Moves every card into the order you choose, from page 1, pocket 1 with no gaps, so you can rearrange the binder to match. Nothing moves until you press Sort; Undo puts every card back.</p>
    <fieldset class="sortopts" id="sortOpts"><legend class="sr-only">Order</legend>${BINDER_ORDERS.map(o=>`<label><input type="radio" name="sortk" value="${o.k}" ${o.k===sortK?"checked":""}>${esc(o.label)}</label>`).join("")}</fieldset>
    <div id="sortPrev"></div>
    <div class="mfoot"><button class="btn" type="button" data-mclose>Cancel</button><button class="btn primary" type="button" id="sortGo">Sort binder</button></div>
  </div></div>`;
  const show = () => {
    const p = sortPlan(b, sortK), byDate = sortK==="old" || sortK==="new";
    const what = byDate ? "release date" : "price";
    let rows = "", page = 0;
    p.order.slice(0, 400).forEach((c,i) => {
      const m = p.moves[i];
      if(m.page!==page){ page = m.page; rows += `<li class="pg">Page ${page}</li>`; }
      const k = byDate ? c.released : valueOf(c)!=null ? money(valueOf(c)) : null;
      rows += `<li class="${k==null?"none":""}"><span class="k">#${m.slot}</span><span class="nm">${esc(c.name||"Unnamed card")} <span class="hint">${esc(metaLine(c))}</span></span><span class="k">${esc(k ?? "no "+what)}</span></li>`;
    });
    $("#sortPrev").innerHTML = `<p class="sortsum">${p.moved ? `<b>${p.moved} of ${p.order.length} cards move</b>, across ${p.pages} page${p.pages===1?"":"s"}.` : `<b>Already in this order.</b>`}${p.missing ? ` ${p.missing} card${p.missing===1?" has":"s have"} no ${what} and go${p.missing===1?"es":""} at the end, in their current order.${byDate?" Release dates are filled in overnight, or from Settings → Fill in missing details.":""}` : ""}</p>
      <ol class="sortprev" aria-label="New order">${rows}</ol>`;
    $("#sortGo").disabled = !p.moved;
  };
  $("#sortOpts").onchange = e => { sortK = e.target.value; show(); };
  $("#sortGo").onclick = async () => {
    const p = sortPlan(b, sortK), go = $("#sortGo");
    const before = cardsIn(b.id).map(c=>({id:c.id, page:c.page, slot:c.slot}));
    go.disabled = true;
    try{
      const r = await window.ledgerApi.call("POST", `api/binders/${encodeURIComponent(b.id)}/arrange`, {moves:p.moves});
      closeModal(); S.page = 1; persistNav(); render();
      toast(`Sorted ${b.name}: ${r.moved} card${r.moved===1?"":"s"} moved`, {label:"Undo", run:() => void undoSort(b, before, p.moves)});
    }catch(e){ go.disabled = false; toast(e?.message || "Couldn't sort the binder. Try again."); }
  };
  show();
  setTimeout(()=> $("#sortOpts input:checked")?.focus(), 30);
}
async function undoSort(b, before, after){
  // Cards that had no page or pocket keep their new place.
  const old = new Map(before.filter(m=>m.page && m.slot).map(m=>[m.id, m]));
  const moves = after.map(m => old.get(m.id) || m);
  try{
    await window.ledgerApi.call("POST", `api/binders/${encodeURIComponent(b.id)}/arrange`, {moves});
    toast(`${b.name} is back the way it was`); render();
  }catch(e){ toast(e?.message || "Couldn't undo the sort."); }
}
function settingsModal(){
  const nc = S.cards.length, nb = S.binders.length;
  $("#modalRoot").innerHTML = `<div class="modal" data-mclose><div class="mcard narrow" role="dialog" aria-modal="true" aria-label="Settings">
    <h2>Settings</h2><p class="lead">Totals are shown in Canadian dollars. Prices you log in US dollars are converted with this rate.</p>
    <div class="field"><label for="s_rate">1 USD = ? CAD</label><input id="s_rate" class="mono" type="number" step="0.0001" min="0.5" max="3" value="${esc(S.settings.usdToCad)}"></div>
    <p class="hint">${S.settings.usdToCadSource?`Updated every day from the ${esc(S.settings.usdToCadSource)}${S.settings.usdToCadDate?` (${esc(S.settings.usdToCadDate)})`:""}. It converts prices you log in US dollars; automatic prices are converted on the day they're logged.`:"It changes every total that includes a USD price."}</p>
    <div class="mfoot"><button class="btn" type="button" data-mclose>Cancel</button><button class="btn primary" type="button" id="sSave">Save</button></div>
    <div class="sec" style="margin-top:18px;border-top:1px solid var(--line-2);padding-top:14px">
      <h3>Backups</h3>
      <p class="hint" style="margin:0 0 10px">A full backup is one file with every binder, card, price and photo. Keep one somewhere safe, or use it to move the ledger to another server.</p>
      <div class="links"><button class="btn sm" type="button" id="sBackup">Download full backup</button>${!S.me?.user || S.me.user.role==="admin"?`<span class="btn sm filebtn">Restore from backup…<input id="sRestore" type="file" accept=".json,application/json" aria-label="Restore from backup"></span>`:""}</div>
      <div id="sRestoreZone" style="margin-top:10px"></div>
    </div>
    ${pricingSettingsHTML()}
    ${detailsSettingsHTML()}
    ${S.me?.user?`<div class="mfoot" style="justify-content:space-between;align-items:center;border-top:1px solid var(--line-2);padding-top:14px"><span class="hint">Signed in as <b>${esc(S.me.user.name)}</b> (${esc(S.me.user.username)}, ${esc(S.me.user.role)})</span><span style="display:flex;gap:8px">${S.me.user.role==="admin"?`<a class="btn sm" href="admin.html">Administration</a>`:""}${S.me.authEnabled?`<button class="btn sm" type="button" id="sSignOut">Sign out</button>`:""}</span></div>`:""}
    </div></div>`;
  $("#sSave").onclick = async () => {
    const r = parseFloat($("#s_rate").value); if(!(r>0)) return toast("Enter a rate like 1.37.");
    if(await guard(()=> S.db.doc("settings/main").set({...S.settings, usdToCad:r}))){ closeModal(); toast("Rate saved"); }
  };
  $("#sBackup").onclick = () => window.ledgerBackup?.download();
  const signOut = $("#sSignOut"); if(signOut) signOut.onclick = async () => { try{ await window.ledgerApi.call("POST","api/auth/logout"); }catch(_){} location.replace("login.html"); };
  if($("#sRestore")) $("#sRestore").onchange = e => {
    const f = e.target.files && e.target.files[0]; e.target.value = ""; if(!f) return;
    const zone = $("#sRestoreZone");
    zone.innerHTML = `<span class="confirm">${nc||nb?`Replace your ${nb} binder${nb===1?"":"s"} and ${nc} card${nc===1?"":"s"} with ${esc(f.name)}? The current ledger is kept on the server, in its backups folder.`:`Restore ${esc(f.name)}?`} <button class="btn sm danger solid" type="button" id="sRestoreYes">Restore</button><button class="btn sm" type="button" id="sRestoreNo">Cancel</button></span>`;
    $("#sRestoreNo").onclick = () => { zone.innerHTML = ""; };
    $("#sRestoreYes").onclick = async () => {
      zone.innerHTML = `<span class="progress">Restoring…</span>`;
      try{
        const r = await window.ledgerBackup.restore(f);
        closeModal(); S.binderId = null; S.page = 1; S.sel = null; persistNav();
        toast(`Restored ${r.binders} binder${r.binders===1?"":"s"}, ${r.cards} card${r.cards===1?"":"s"} and ${r.photos} photo${r.photos===1?"":"s"}${r.missingPhotos?`. ${r.missingPhotos} photo${r.missingPhotos===1?" was":"s were"} missing from the file`:""}`);
      }catch(err){ console.error(err); zone.innerHTML = `<span class="hint" style="color:var(--bad)">${esc(err?.message || "The restore didn't work.")} Nothing was changed.</span>`; }
    };
  };
}
function closeModal(){ $("#modalRoot").innerHTML=""; }

/* ---------- page-photo import ---------- */
function solve(A,b){ const n=b.length; A=A.map((r,i)=>[...r,b[i]]);
  for(let i=0;i<n;i++){ let m=i; for(let r=i+1;r<n;r++) if(Math.abs(A[r][i])>Math.abs(A[m][i])) m=r; [A[i],A[m]]=[A[m],A[i]];
    for(let r=0;r<n;r++){ if(r===i) continue; const f=A[r][i]/A[i][i]; for(let k=i;k<=n;k++) A[r][k]-=f*A[i][k]; } }
  return A.map((r,i)=>r[n]/r[i]); }
function unitToQuad(q){ // maps unit square -> quad (TL,TR,BR,BL)
  const src=[[0,0],[1,0],[1,1],[0,1]], A=[], b=[];
  for(let i=0;i<4;i++){ const [x,y]=src[i],[u,v]=q[i]; A.push([x,y,1,0,0,0,-u*x,-u*y]); b.push(u); A.push([0,0,0,x,y,1,-v*x,-v*y]); b.push(v); }
  const h = solve(A,b); return (x,y)=>{ const w=h[6]*x+h[7]*y+1; return [(h[0]*x+h[1]*y+h[2])/w,(h[3]*x+h[4]*y+h[5])/w]; };
}
function importModal(){
  const b = curBinder();
  if(!b) return toast("Pick or create a binder first.");
  if(!S.db) return toast("Saving isn't available in this view.");
  const n = pocketsOf(b), cols = POCKETS[n].cols, rows = n/cols, mp = maxPage(b.id);
  const startPage = Math.min(S.page, mp+1);
  $("#modalRoot").innerHTML = `<div class="modal"><div class="mcard" role="dialog" aria-modal="true" aria-label="Import page photo">
    <h2>Import a page photo</h2>
    <p class="lead">Photograph one binder page, then drag the four yellow corners to the outer corners of the pocket grid. Each pocket becomes that card's photo in ${esc(b.name)}.</p>${envNotice("Choose photo")}
    <div class="opts" style="margin-top:0">
      <span class="btn filebtn">Choose photo<input id="ip_file" type="file" accept="image/*" aria-label="Choose photo"></span>
      <label>Page <input id="ip_page" class="mono" type="number" min="1" value="${startPage}" style="width:64px;border:1px solid var(--line);border-radius:6px;padding:5px 7px;background:var(--surface-2)"></label>
      <span class="hint">${n}-pocket layout (${cols} × ${rows})</span>
    </div>
    <div id="ip_stage" style="margin-top:12px"></div>
    <div class="opts" id="ip_opts" hidden>
      <label><input type="checkbox" id="ip_replace" checked> Replace photos cards already have</label>
      <label><input type="checkbox" id="ip_create" checked> Add entries for empty pockets</label>
      <label>Trim edges <input type="range" id="ip_trim" min="0" max="10" value="3" style="width:90px"></label>
    </div>
    <div id="ip_slices"></div>
    <div class="mfoot"><span class="progress" id="ip_prog" style="margin-right:auto"></span><button class="btn" type="button" data-mclose>Cancel</button><button class="btn" type="button" id="ip_split" disabled>Preview pockets</button><button class="btn primary" type="button" id="ip_save" disabled>Save photos</button></div>
  </div></div>`;
  let src=null, quad=null, slices=[], dispK=1;
  const stage = $("#ip_stage");
  $("#ip_file").onchange = async e => {
    const f = e.target.files[0]; if(!f) return;
    const url = URL.createObjectURL(f);
    const img = await new Promise((res,rej)=>{ const i=new Image(); i.onload=()=>res(i); i.onerror=rej; i.src=url; }).catch(()=>null);
    if(!img){ toast("That photo couldn't be opened."); return; }
    const k = Math.min(1, 2200/Math.max(img.naturalWidth,img.naturalHeight));
    src = document.createElement("canvas"); src.width=Math.round(img.naturalWidth*k); src.height=Math.round(img.naturalHeight*k);
    src.getContext("2d").drawImage(img,0,0,src.width,src.height); URL.revokeObjectURL(url);
    const W=src.width,H=src.height, ix=W*.08, iy=H*.12;
    quad=[[ix,iy],[W-ix,iy],[W-ix,H-iy],[ix,H-iy]];
    drawStage(); $("#ip_split").disabled=false; $("#ip_opts").hidden=false; $("#ip_slices").innerHTML=""; $("#ip_save").disabled=true;
  };
  function drawStage(){
    const maxW = Math.min(stage.clientWidth-20, 720), maxH = Math.max(320, window.innerHeight*.6);
    dispK = Math.min(maxW/src.width, maxH/src.height, 1);
    const cw = Math.round(src.width*dispK), ch = Math.round(src.height*dispK);
    stage.innerHTML = `<div class="stagewrap"><div class="stage" id="ip_st" style="width:${cw}px"><canvas width="${cw}" height="${ch}"></canvas><svg viewBox="0 0 ${cw} ${ch}" preserveAspectRatio="none"></svg>${["Top left","Top right","Bottom right","Bottom left"].map((l,i)=>`<div class="handle" data-h="${i}" tabindex="0" aria-label="${l} corner"><span>${l}</span></div>`).join("")}</div></div>`;
    stage.querySelector("canvas").getContext("2d").drawImage(src,0,0,cw,ch);
    placeHandles();
    stage.querySelectorAll(".handle").forEach(h => {
      h.addEventListener("pointerdown", ev => {
        ev.preventDefault(); h.setPointerCapture(ev.pointerId); const i=+h.dataset.h; const st=$("#ip_st").getBoundingClientRect();
        const mv = e2 => { const x=Math.min(Math.max(0,e2.clientX-st.left),st.width), y=Math.min(Math.max(0,e2.clientY-st.top),st.height); const s = src.width/st.width; quad[i]=[x*s,y*s]; placeHandles(); };
        const up = () => { h.removeEventListener("pointermove",mv); h.removeEventListener("pointerup",up); h.removeEventListener("pointercancel",up); };
        h.addEventListener("pointermove",mv); h.addEventListener("pointerup",up); h.addEventListener("pointercancel",up);
      });
      h.addEventListener("keydown", ev => { const d={ArrowLeft:[-1,0],ArrowRight:[1,0],ArrowUp:[0,-1],ArrowDown:[0,1]}[ev.key]; if(!d) return; ev.preventDefault(); const i=+h.dataset.h, s=(ev.shiftKey?20:4)/dispK; quad[i]=[quad[i][0]+d[0]*s, quad[i][1]+d[1]*s]; placeHandles(); });
    });
  }
  function placeHandles(){
    const st=$("#ip_st"); if(!st) return; const k = st.getBoundingClientRect().width/src.width || dispK;
    st.querySelectorAll(".handle").forEach(h=>{ const [x,y]=quad[+h.dataset.h]; h.style.left=(x*k)+"px"; h.style.top=(y*k)+"px"; });
    const svg = st.querySelector("svg"); const vb = svg.viewBox.baseVal, s = vb.width/src.width;
    const map = unitToQuad(quad); let lines="";
    for(let c=0;c<=cols;c++){ const a=map(c/cols,0), z=map(c/cols,1); lines+=`<line x1="${a[0]*s}" y1="${a[1]*s}" x2="${z[0]*s}" y2="${z[1]*s}"/>`; }
    for(let r=0;r<=rows;r++){ const a=map(0,r/rows), z=map(1,r/rows); lines+=`<line x1="${a[0]*s}" y1="${a[1]*s}" x2="${z[0]*s}" y2="${z[1]*s}"/>`; }
    svg.innerHTML = `<g stroke="#F5C12E" stroke-width="2" fill="none" opacity=".95">${lines}</g>`;
  }
  $("#ip_split").onclick = () => {
    const map = unitToQuad(quad), trim = (+$("#ip_trim").value)/100;
    const sctx = src.getContext("2d"), sd = sctx.getImageData(0,0,src.width,src.height).data, SW=src.width, SH=src.height;
    const OW=420, OH=Math.round(420*88/63); slices=[];
    for(let r=0;r<rows;r++) for(let c=0;c<cols;c++){
      const out = document.createElement("canvas"); out.width=OW; out.height=OH; const octx=out.getContext("2d"); const od=octx.createImageData(OW,OH);
      for(let y=0;y<OH;y++){ const gy=(r + trim + (1-2*trim)*(y+.5)/OH)/rows;
        for(let x=0;x<OW;x++){ const gx=(c + trim + (1-2*trim)*(x+.5)/OW)/cols; const [sx,sy]=map(gx,gy);
          const ix=Math.min(SW-1,Math.max(0,sx|0)), iy=Math.min(SH-1,Math.max(0,sy|0)), si=(iy*SW+ix)*4, di=(y*OW+x)*4;
          od.data[di]=sd[si]; od.data[di+1]=sd[si+1]; od.data[di+2]=sd[si+2]; od.data[di+3]=255; } }
      octx.putImageData(od,0,0); slices.push({slot:r*cols+c+1, canvas:out, on:true});
    }
    renderSlices(); $("#ip_save").disabled=false;
  };
  function renderSlices(){
    const page = Math.max(1, +$("#ip_page").value||1);
    $("#ip_slices").innerHTML = `<p class="hint" style="text-align:center;margin:14px 0 0">Tap a pocket to skip it.</p><div class="slices" style="--cols:${cols}">${slices.map((s,i)=>{ const c = cardAt(b.id,page,s.slot); return `<button type="button" class="slice${s.on?"":" off"}" data-i="${i}"><img src="${s.canvas.toDataURL("image/jpeg",.7)}" alt="Pocket ${s.slot}"><span class="tag">${s.slot} · ${esc(c?(c.name||"Unnamed"):"new entry")}</span></button>`; }).join("")}</div>`;
  }
  $("#ip_slices").onclick = e => { const t=e.target.closest("[data-i]"); if(!t) return; const s=slices[+t.dataset.i]; s.on=!s.on; t.classList.toggle("off",!s.on); };
  $("#ip_page").onchange = () => { if(slices.length) renderSlices(); };
  $("#ip_save").onclick = async () => {
    const page = Math.max(1, +$("#ip_page").value||1), replace=$("#ip_replace").checked, create=$("#ip_create").checked;
    const todo = slices.filter(s=>s.on && (cardAt(b.id,page,s.slot) ? (replace || !cardAt(b.id,page,s.slot).imageId) : create));
    if(!todo.length) return toast("Nothing to save with those options.");
    $("#ip_save").disabled=true; $("#ip_split").disabled=true; let done=0;
    for(const s of todo){
      $("#ip_prog").textContent = `Saving ${done+1} of ${todo.length}…`;
      try{
        const blob = await new Promise(r=>s.canvas.toBlob(r,"image/jpeg",.86));
        const up = {id: await storePhoto(blob)};
        const c = cardAt(b.id,page,s.slot);
        if(c){ const old=c.imageId; await S.db.doc("cards/"+c.id).update({imageId:up.id, updatedAt:nowISO()}); if(old && !S.cards.some(x=>x.id!==c.id && x.imageId===old)){ try{ await delAsset(old);}catch(e){} } }
        else await S.db.collection("cards").doc(rid()).set({name:"", set:"", setCode:"", number:"", rarity:"", variant:"", language:"English", condition:"Near Mint", grader:"Raw", grade:"", artist:"", notes:"", status:"binder", prices:[], imageId:up.id, binderId:b.id, page, slot:s.slot, createdAt:nowISO(), updatedAt:nowISO()});
        done++;
      }catch(e){ if(e && e.code && e.code in {too_large:1,unsupported_type:1,quota_or_state:1,rate_limited:1}) uploadErr(e); else writeErr(e); break; }
    }
    closeModal(); S.page=page; S.view="pages"; persistNav(); render();
    toast(done===todo.length ? `Saved ${done} photo${done===1?"":"s"} to page ${page}` : `Saved ${done} of ${todo.length}. Try the rest again.`);
  };
}

/* ---------- CSV ---------- */
async function exportCSV(){
  const cols = ["Binder","Page","Pocket","Name","Set","Set code","Number","Rarity","Variant","Language","Condition","Graded by","Grade","Illustrator","Status","Placeholder","Value (CAD)","Value basis","Paid (CAD)","Sold for (CAD)","Price entries","Notes"];
  const q = v => { const s = String(v ?? ""); return /[",\n]/.test(s) ? `"${s.replace(/"/g,'""')}"` : s; };
  const rows = S.cards.slice().sort((a,b)=> SORTS.loc(a)<SORTS.loc(b)?-1:1).map(c => {
    const lp = latestOf(c,["comp","market"]);
    return [binderById(c.binderId)?.name||"", c.page||"", c.slot||"", c.name, c.set, c.setCode, c.number, c.rarity, c.variant, c.language, c.condition, c.grader, c.grade, c.artist, (STATUSES.find(s=>s[0]===(c.status||"binder"))||[,""])[1], c.placeholder?"yes":"", valueOf(c)?.toFixed(2)??"", lp?`${lp.type} ${lp.date} ${lp.where||""}`.trim():"", paidOf(c)?.toFixed(2)??"", soldOf(c)?.toFixed(2)??"", prices(c).map(p=>`${p.date} ${p.type} ${p.amount} ${p.currency}${p.where?" @"+p.where:""}`).join(" | "), c.notes].map(q).join(",");
  });
  const csv = [cols.join(","), ...rows].join("\n");
  if(!S.downloads) return toast("Downloads aren't available in this view.");
  try{ await S.downloads.save({filename:`binder-ledger-${today()}.csv`, data:csv}); }
  catch(e){ if(e?.code!=="declined") toast("The export didn't download. Try again."); }
}

/* ---------- CSV import ---------- */
const norm = s => String(s ?? "").toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g,"").replace(/[^a-z0-9]/g,"");
const CI_COLS = [
  {k:"binder", h:"Binder", a:["bindername"], d:"Binder name, spelled as on its tab. Leave blank for a card that isn't in a binder. A name that doesn't exist yet creates a new binder."},
  {k:"page", h:"Page", a:["pg","pageno","pagenumber"], d:"Whole number, 1 or more."},
  {k:"slot", h:"Pocket", a:["slot","pocketno","pocketnumber","position"], d:"Whole number from 1 to the binder's pockets per page. Leave Page and Pocket both blank to use the next empty pocket. If that pocket already has a card, the imported card replaces it (you can change this in the import box)."},
  {k:"name", h:"Name", a:["cardname","pokemon","card"], req:true, d:"The Pokémon or card name, e.g. Umbreon VMAX."},
  {k:"set", h:"Set", a:["setname","expansion"], d:"Set name, e.g. Evolving Skies."},
  {k:"setCode", h:"Set code", a:["code","setabbr","setid"], d:"Short code, e.g. EVS, SVI, 30C."},
  {k:"number", h:"Number", a:["no","num","cardno","cardnumber","collectornumber"], d:"Collector number, e.g. 215/203."},
  {k:"rarity", h:"Rarity", a:[], d:"Any text. Standard names like Illustration Rare or Special Illustration Rare are matched regardless of capitals."},
  {k:"variant", h:"Variant", a:["variantstamp","stamp","finish"], d:"Reverse holo, stamp, alternate art…"},
  {k:"language", h:"Language", a:["lang"], d:LANGS.join(", ")+". Blank means English. EN, JP and KR also work."},
  {k:"condition", h:"Condition", a:["cond"], d:CONDITIONS.join(", ")+". Blank means Near Mint. NM, LP, MP, HP and DMG also work."},
  {k:"grader", h:"Graded by", a:["grader","gradingcompany","company"], d:GRADERS.join(", ")+". Blank means Raw."},
  {k:"grade", h:"Grade", a:["score"], d:"Number from 1 to 10, halves allowed (9.5). Only for graded cards."},
  {k:"artist", h:"Illustrator", a:["artist","illustratedby"], d:"The card's illustrator."},
  {k:"placeholder", h:"Placeholder", a:["proxy","wanted","needed","notowned"], d:"yes holds the pocket for a card you don't have yet: its price is tracked but not counted in your totals. Blank or no means you have it."},
  {k:"status", h:"Status", a:["state"], d:STATUSES.map(s=>s[1]).join(", ")+". Blank means In binder. Short forms like listed, grading and sold work."},
  {k:"paid", h:"Paid", a:["paidcad","pricepaid","cost","boughtfor"], d:"What you paid, e.g. 12.50. Logged as an “I paid” price entry."},
  {k:"paidDate", h:"Paid date", a:["datepaid","boughton","purchasedate"], d:"YYYY-MM-DD. Blank means today."},
  {k:"paidWhere", h:"Paid where", a:["boughtfrom","boughtat"], d:"Shop, seller or site."},
  {k:"value", h:"Value", a:["valuecad","marketprice","marketvalue","price","currentvalue"], d:"What it's worth now, e.g. 18.50. Sets the card's value."},
  {k:"valueType", h:"Value type", a:["pricetype"], d:"Market price or Sold comp. Blank means Market price."},
  {k:"valueDate", h:"Value date", a:["pricedate","datevalued"], d:"YYYY-MM-DD. Blank means today."},
  {k:"valueWhere", h:"Value source", a:["valuewhere","pricesource","source"], d:"TCGplayer, eBay, PriceCharting…"},
  {k:"soldFor", h:"Sold for", a:["soldforcad","soldprice","saleprice"], d:"What you sold it for. Marks the card Sold."},
  {k:"soldDate", h:"Sold date", a:["datesold","saledate"], d:"YYYY-MM-DD. Blank means today."},
  {k:"soldWhere", h:"Sold where", a:["soldto","soldon","soldat"], d:"Buyer, shop or site."},
  {k:"currency", h:"Currency", a:["cur","ccy"], d:"CAD or USD, for Paid, Value and Sold for. Blank means CAD. One amount can override it, like US$20."},
  {k:"notes", h:"Notes", a:["note","comments"], d:"Anything else: centering, where you pulled it, trade notes."}
];
const CI_H = Object.fromEntries(CI_COLS.map(c=>[c.k,c.h]));
const CI_MAP = (()=>{ const m={}; CI_COLS.forEach(c=>[c.h,...c.a].forEach(x=>{ m[norm(x)] ??= c.k; })); return m; })();
const syn = pairs => { const m={}; for(const [v,keys] of pairs) for(const k of keys) m[norm(k)]=v; return m; };
const LANG_SYN = syn([["English",["English","en","eng"]],["Japanese",["Japanese","jp","ja","jpn","jap"]],["Korean",["Korean","kr","ko","kor"]],["Chinese (Traditional)",["Chinese (Traditional)","Traditional Chinese","tc","zh-tw","cht"]],["Chinese (Simplified)",["Chinese (Simplified)","Simplified Chinese","sc","zh-cn","chs"]],["Other",["Other"]]]);
const COND_SYN = syn([["Near Mint",["Near Mint","nm","mint","nm/m","nm-mt"]],["Lightly Played",["Lightly Played","lp","light play","excellent"]],["Moderately Played",["Moderately Played","mp","played"]],["Heavily Played",["Heavily Played","hp"]],["Damaged",["Damaged","dmg","dm","poor"]]]);
const GRADER_SYN = syn([["Raw",["Raw","ungraded","none","n/a"]],["PSA",["PSA"]],["CGC",["CGC"]],["BGS",["BGS","Beckett"]],["TAG",["TAG"]],["ACE",["ACE"]]]);
const STATUS_SYN = syn([["binder",["In binder","binder","held","owned","collection"]],["listed",["Listed for sale","listed","for sale","selling"]],["grading",["Out for grading","grading","at grading","submitted"]],["sold",["Sold"]],["traded",["Traded","trade","traded away"]]]);
const VTYPE_SYN = syn([["market",["Market price","market","mkt"]],["comp",["Sold comp","comp","sold","last sold"]]]);
const CUR_SYN = syn([["CAD",["CAD","ca","cdn","c"]],["USD",["USD","us","u"]]]);
const ciQ = v => { const s = String(v ?? ""); return /[",\r\n]/.test(s) ? `"${s.replace(/"/g,'""')}"` : s; };

function parseCSV(text){
  text = String(text).replace(/^﻿/,"");
  const first = text.split(/\r?\n/,1)[0] || "";
  const d = [",",";","\t"].map(c=>[c, first.split(c).length]).sort((a,b)=>b[1]-a[1])[0][0];
  const rows=[]; let row=[], f="", q=false, i=0;
  while(i<text.length){
    const ch = text[i];
    if(q){ if(ch==='"'){ if(text[i+1]==='"'){ f+='"'; i+=2; continue; } q=false; i++; continue; } f+=ch; i++; continue; }
    if(ch==='"' && !f.trim()){ f=""; q=true; i++; continue; }
    if(ch===d){ row.push(f); f=""; i++; continue; }
    if(ch==="\r"){ i++; continue; }
    if(ch==="\n"){ row.push(f); rows.push(row); row=[]; f=""; i++; continue; }
    f+=ch; i++;
  }
  if(f!=="" || row.length){ row.push(f); rows.push(row); }
  return {rows, unclosed:q};
}
function parseMoney(s){
  let cur = null;
  if(/US\s*\$|USD|^\s*U\$/i.test(s)) cur="USD"; else if(/CAD|CDN|C\s*\$|CA\s*\$/i.test(s)) cur="CAD";
  let t = s.replace(/[a-z$\s]/gi,"");
  if(/^\d{1,3}(,\d{3})+(\.\d+)?$/.test(t)) t = t.replace(/,/g,"");
  else if(/^\d+,\d{1,2}$/.test(t)) return {err:`“${s}” uses a comma for decimals. Write it like 12.50.`};
  if(!/^(\d+(\.\d+)?|\.\d+)$/.test(t)) return {err:`“${s}” isn't an amount. Write it like 12.50.`};
  return {amount: Math.round(parseFloat(t)*100)/100, cur};
}
function parseDate(s){
  if(!s) return {v:null};
  const m = s.match(/^(\d{4})[-\/.](\d{1,2})[-\/.](\d{1,2})(?:[ T].*)?$/);
  if(!m) return {err:`“${s}” isn't in YYYY-MM-DD form, like 2026-09-25.`};
  const y=+m[1], mo=+m[2], dd=+m[3], dt=new Date(Date.UTC(y,mo-1,dd));
  if(dt.getUTCFullYear()!==y || dt.getUTCMonth()!==mo-1 || dt.getUTCDate()!==dd) return {err:`${s} isn't a real date.`};
  const v = `${y}-${String(mo).padStart(2,"0")}-${String(dd).padStart(2,"0")}`;
  return {v, future: v > today()};
}
const toInt = s => /^\d+(\.0+)?$/.test(s) && +s >= 1 ? Math.round(+s) : null;
const dupKey = d => norm(d.name)+"|"+norm(d.number || d.set || d.setCode);

function ciValidate(P, o){
  const res = {fatal:null, notices:[], rows:[], newBinders:new Map(), header:[]};
  const all = P.rows;
  if(!all.length || all.every(r=>r.every(c=>!c.trim()))){ res.fatal = "That file is empty."; return res; }
  const hdr = all[0].map(h=>h.trim()); res.header = all[0];
  const idx = {}, ignored = [], dup = [];
  hdr.forEach((h,i)=>{ if(!h) return; const k = CI_MAP[norm(h)]; if(!k){ ignored.push(h); return; } if(k in idx){ dup.push(h); return; } idx[k]=i; });
  if(!("name" in idx)){ const seen = hdr.filter(Boolean).slice(0,6).join(", "); res.fatal = `There's no Name column. The first row has to be the column headings from the template${seen?` (this file starts with: ${seen})`:""}.`; return res; }
  if(P.unclosed) res.notices.push("A quote mark near the end of the file is never closed, so some rows may have merged into one. Look for a stray \" in a cell.");
  if(ignored.length) res.notices.push(`Ignored columns: ${ignored.join(", ")}. Only the template's columns are imported.`);
  if(dup.length) res.notices.push(`Repeated columns: ${dup.join(", ")}. The first of each is used.`);
  const bkeyOf = s => s.trim().toLowerCase().replace(/\s+/g," ");
  const exist = new Map(S.binders.map(b=>[bkeyOf(b.name||""), b]));
  const pocketsFor = k => k.startsWith("id:") ? pocketsOf(binderById(k.slice(3))) : res.newBinders.get(k).pockets;
  const occ = new Map(), occCard = new Map(), occRow = new Map();
  S.cards.forEach(c=>{ if(c.binderId && binderById(c.binderId) && c.page && c.slot){ const k=`id:${c.binderId}|${c.page}|${c.slot}`; occ.set(k, `${c.name||"a card"} (already in your ledger)`); occCard.set(k, c); } });
  const have = new Set(S.cards.filter(c=>c.name).map(dupKey));
  const MAX = 2000; let count = 0;
  for(let i=1;i<all.length;i++){
    const raw = all[i]; if(raw.every(c=>!c.trim())) continue;
    if(++count > MAX) continue;
    const cell = k => k in idx ? String(raw[idx[k]] ?? "").trim() : "";
    const r = {line:i+1, raw, errors:[], warns:[], data:{}, prices:[], bkey:null, bname:"", page:null, slot:null, auto:false, isNew:false};
    const E = t => r.errors.push(t), W = t => r.warns.push(t), d = r.data;
    if(raw.length > hdr.length && raw.slice(hdr.length).some(c=>c.trim())) W("This row has more cells than there are headings. A comma inside a value may have split it; put that value in quotes.");
    d.name = cell("name"); if(!d.name) E("Name is blank.");
    for(const k of ["set","setCode","number","variant","artist","notes"]) d[k] = cell(k);
    const rar = cell("rarity"), rarHit = RARITIES.find(x=>norm(x)===norm(rar));
    d.rarity = rar ? (rarHit || rar) : "";
    if(rar && !rarHit) W(`Rarity “${rar}” isn't one of the standard names, so it's kept as written.`);
    const en = (k, table, def, label, allowed) => { const v = cell(k); if(!v) return def; const m = table[norm(v)]; if(m) return m; E(`${label} “${v}” isn't recognised. Use ${allowed}.`); return def; };
    d.language = en("language", LANG_SYN, "English", "Language", LANGS.join(", "));
    d.condition = en("condition", COND_SYN, "Near Mint", "Condition", "Near Mint, Lightly Played, Moderately Played, Heavily Played or Damaged");
    d.grader = en("grader", GRADER_SYN, "Raw", "Graded by", GRADERS.join(", "));
    const phRaw = cell("placeholder");
    d.placeholder = /^(y|yes|true|1|x|✓)$/i.test(phRaw);
    if(phRaw && !d.placeholder && !/^(n|no|false|0)$/i.test(phRaw)) E(`Placeholder “${phRaw}” should be yes or no.`);
    const stRaw = cell("status");
    d.status = en("status", STATUS_SYN, "binder", "Status", STATUSES.map(s=>s[1]).join(", "));
    const g = cell("grade"); d.grade = "";
    if(g){
      const gn = g.replace(/^(psa|cgc|bgs|tag|ace)\s*/i,"");
      if(/^\d{1,2}(\.5)?$/.test(gn) && +gn>=1 && +gn<=10){ d.grade = String(+gn); if(d.grader==="Raw") W("Grade is filled in but Graded by is Raw. Set Graded by to PSA, CGC, BGS, TAG or ACE."); }
      else E(`Grade “${g}” should be a number from 1 to 10, like 9 or 9.5.`);
    } else if(d.grader!=="Raw") W(`Graded by is ${d.grader} but Grade is blank.`);
    const curRaw = cell("currency"), cur = curRaw ? CUR_SYN[norm(curRaw)] : "CAD";
    if(curRaw && !cur) E(`Currency “${curRaw}” isn't recognised. Use CAD or USD.`);
    const addP = (aK, dK, wK, type) => {
      const a = cell(aK), dt = cell(dK), wh = cell(wK);
      if(!a){ const extra = [dt&&CI_H[dK], wh&&CI_H[wK]].filter(Boolean); if(extra.length) W(`${CI_H[aK]} is blank, so ${extra.join(" and ")} ${extra.length>1?"are":"is"} ignored.`); return false; }
      const m = parseMoney(a); if(m.err){ E(`${CI_H[aK]}: ${m.err}`); return false; }
      const pd = parseDate(dt); if(pd.err){ E(`${CI_H[dK]}: ${pd.err}`); return false; }
      if(pd.future) W(`${CI_H[dK]} ${pd.v} is in the future.`);
      r.prices.push({id:rid(), at:nowISO(), type, amount:m.amount, currency:m.cur || cur || "CAD", date:pd.v || today(), where:wh, note:""});
      return true;
    };
    addP("paid","paidDate","paidWhere","paid");
    const vtRaw = cell("valueType"); let vt = "market";
    if(vtRaw){ vt = VTYPE_SYN[norm(vtRaw)]; if(!vt){ E(`Value type “${vtRaw}” isn't recognised. Use Market price or Sold comp.`); vt = "market"; } }
    addP("value","valueDate","valueWhere",vt);
    if(addP("soldFor","soldDate","soldWhere","mysale")){
      if(!stRaw) d.status = "sold";
      else if(!["sold","traded"].includes(d.status)){ W(`Sold for is filled in, so Status changes from ${(STATUSES.find(s=>s[0]===d.status)||[,""])[1]} to Sold.`); d.status = "sold"; }
    }
    const bn = cell("binder"), pg = cell("page"), sl = cell("slot");
    if(!bn){ if(pg||sl) W("Binder is blank, so Page and Pocket are ignored. The card goes under Not in a binder."); }
    else {
      const key = bkeyOf(bn), b = exist.get(key);
      if(b){ r.bkey = "id:"+b.id; r.bname = b.name; }
      else if(o.create){ r.bkey = "new:"+key; r.bname = bn.slice(0,40); r.isNew = true; if(!res.newBinders.has(r.bkey)) res.newBinders.set(r.bkey, {name:bn.slice(0,40), pockets:o.pockets}); }
      else E(`There's no binder called “${bn}”. Check the spelling against its tab, or set “Binders that don't exist yet” to Create them.`);
      if(r.bkey){
        const n = pocketsFor(r.bkey);
        if(!pg && !sl) r.auto = true;
        else if(!pg || !sl) E("Fill in both Page and Pocket, or leave both blank to use the next empty pocket.");
        else {
          const P1 = toInt(pg), S1 = toInt(sl);
          if(P1==null) E(`Page “${pg}” should be a whole number, 1 or more.`);
          if(S1==null) E(`Pocket “${sl}” should be a whole number, 1 or more.`);
          else if(S1 > n) E(`Pocket ${S1} doesn't exist in ${r.bname}. Its pages have ${n} pockets.`);
          r.page = P1; r.slot = S1;
        }
      }
    }
    if(d.name && have.has(dupKey(d))) W("Your ledger already has a card with this name and number. This adds another copy.");
    res.rows.push(r);
  }
  if(count > MAX) res.notices.push(`Only the first ${MAX} card rows were checked. Put the rest in a second file.`);
  if(!res.rows.length){ res.fatal = "The file has headings but no card rows."; return res; }
  const ok = r => !r.errors.length;
  for(const r of res.rows){
    if(!ok(r) || !r.bkey || r.auto) continue;
    const k = `${r.bkey}|${r.page}|${r.slot}`, who = occ.get(k);
    if(who && o.taken==="replace"){
      const prev = occRow.get(k), old = occCard.get(k);
      if(prev){
        prev.errors.push(`Replaced by row ${r.line} (${r.data.name}), which uses the same page and pocket later in the file.`);
        prev.replaced = true; prev.warns = prev.warns.filter(w=>!w.startsWith("Replaces "));
        if(prev.replaceId){ r.replaceId = prev.replaceId; r.replaceName = prev.replaceName; r.replaceOld = prev.replaceOld; }
      } else if(old){ r.replaceId = old.id; r.replaceName = old.name || "Unnamed card"; r.replaceOld = old; }
      if(r.replaceId) r.warns.push(`Replaces ${r.replaceName} in page ${r.page}, pocket ${r.slot}. Its details and price log are overwritten.`);
      occ.set(k, `row ${r.line} (${r.data.name})`); occRow.set(k, r);
    } else if(who){
      if(o.taken==="next"){ r.auto = true; r.warns.push(`Page ${r.page}, pocket ${r.slot} is taken by ${who}, so this card goes in the next empty pocket.`); }
      else r.errors.push(`Page ${r.page}, pocket ${r.slot} is already taken by ${who}.`);
    } else { occ.set(k, `row ${r.line} (${r.data.name})`); occRow.set(k, r); }
  }
  for(const r of res.rows){
    if(!ok(r) || !r.bkey || !r.auto) continue;
    const n = pocketsFor(r.bkey); let p = 1, s = 1;
    while(occ.has(`${r.bkey}|${p}|${s}`)){ if(++s > n){ s = 1; p++; } }
    r.page = p; r.slot = s; occ.set(`${r.bkey}|${p}|${s}`, `row ${r.line} (${r.data.name})`);
  }
  return res;
}

let CI = null;
function csvImportModal(){
  CI = {P:null, file:"", o:{create:true, taken:"replace", pockets:9}, res:null, filter:"all", busy:false, done:false};
  $("#modalRoot").innerHTML = `<div class="modal"><div class="mcard" id="ci_card" role="dialog" aria-modal="true" aria-label="Import cards from CSV">
    <h2>Import cards from CSV</h2>
    <p class="lead">Fill in the template in Excel, Numbers or Google Sheets, save it as CSV and choose it here. Every row is checked first, and nothing is saved until you press Import. The template's three example rows show the format; replace them with your cards.</p>
    <div class="drop" id="ci_drop">
      <button class="btn" type="button" id="ci_tpl"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 3v12m0 0-4-4m4 4 4-4M4 17v3h16v-3"/></svg>Download template</button>
      <span class="btn primary filebtn">Choose CSV file<input id="ci_file" type="file" accept=".csv,text/csv,.tsv,.txt" aria-label="Choose CSV file"></span>
      <span class="fname" id="ci_fname">or drop a .csv file here</span>
    </div>
    <details class="ci-guide"><summary>What goes in each column</summary><div class="tablewrap"><table><thead><tr><th>Column</th><th>What to put in it</th></tr></thead><tbody>${CI_COLS.map(c=>`<tr><td>${esc(c.h)}${c.req?` <span class="chip err">required</span>`:""}</td><td>${esc(c.d)}</td></tr>`).join("")}</tbody></table></div></details>
    <div class="ci-opts">
      <div class="field"><label for="ci_create">Binders that don't exist yet</label><select id="ci_create"><option value="1">Create them</option><option value="0">Flag as an error</option></select></div>
      <div class="field"><label for="ci_taken">If a pocket already has a card</label><select id="ci_taken"><option value="replace" selected>Replace that card</option><option value="next">Use the next empty pocket</option><option value="error">Flag as an error</option></select></div>
      <div class="field"><label for="ci_pockets">Pockets per page for new binders</label><select id="ci_pockets">${[4,9,12,16].map(p=>`<option value="${p}" ${p===9?"selected":""}>${p}-pocket</option>`).join("")}</select></div>
    </div>
    <div id="ci_res"></div>
    <div class="mfoot"><span class="progress" id="ci_prog" style="margin-right:auto"></span><button class="btn" type="button" id="ci_close">Cancel</button><button class="btn primary" type="button" id="ci_go" disabled>Import cards</button></div>
  </div></div>`;
  $("#ci_tpl").onclick = () => void ciTemplate();
  $("#ci_file").onchange = e => { const f = e.target.files[0]; if(f) ciLoad(f); e.target.value = ""; };
  const card = $("#ci_card"), drop = $("#ci_drop");
  card.addEventListener("dragover", e => { if([...(e.dataTransfer?.types||[])].includes("Files")){ e.preventDefault(); drop.classList.add("over"); } });
  card.addEventListener("dragleave", e => { if(!card.contains(e.relatedTarget)) drop.classList.remove("over"); });
  card.addEventListener("drop", e => { e.preventDefault(); drop.classList.remove("over"); const f = e.dataTransfer?.files?.[0]; if(f) ciLoad(f); });
  ["ci_create","ci_taken","ci_pockets"].forEach(id => $("#"+id).onchange = () => { CI.o = {create:$("#ci_create").value==="1", taken:$("#ci_taken").value, pockets:+$("#ci_pockets").value}; ciCheck(); });
  $("#ci_close").onclick = () => { if(!CI.busy) closeModal(); };
  $("#ci_go").onclick = () => void ciRun();
  $("#ci_res").onclick = e => { const f = e.target.closest("[data-cifilter]"); if(f){ CI.filter = f.dataset.cifilter; ciRenderRes(); return; } if(e.target.closest("#ci_fix")) ciFixFile(); };
}
async function ciLoad(f){
  if(CI.busy || CI.done) return;
  if(f.size > 5*1024*1024) return toast("That file is over 5 MB. Split it into smaller files.");
  let text; try{ text = await f.text(); }catch(e){ return toast("That file couldn't be read."); }
  CI.file = f.name; CI.P = parseCSV(text); CI.filter = "all";
  const fn = $("#ci_fname"); if(fn){ fn.textContent = f.name; fn.classList.add("has"); }
  ciCheck();
}
function ciCheck(){ if(!CI.P) return; CI.res = ciValidate(CI.P, CI.o); ciRenderRes(); }
function ciWhere(r){
  if(!r.bkey) return "Not in a binder";
  if(!r.page || !r.slot) return `${r.bname}${r.isNew?" (new)":""}`;
  return `${r.bname}${r.isNew?" (new)":""} · p${r.page} · #${r.slot}${r.auto?" · next empty":""}${r.replaceId?` · replaces ${r.replaceName}`:""}`;
}
function ciRowHTML(r){
  const st = r.saved ? `<span class="chip ok">Saved</span>` : r.replaced ? `<span class="chip">Skipped</span>` : r.errors.length ? `<span class="chip err">${r.failed?"Not saved":"Error"}</span>` : r.warns.length ? `<span class="chip warn">Warning</span>` : `<span class="chip ok">Ready</span>`;
  const iss = [...r.errors.map(t=>`<li class="e">${esc(t)}</li>`), ...r.warns.map(t=>`<li class="w">${esc(t)}</li>`)].join("");
  return `<tr><td class="r mono">${r.line}</td><td class="cellname"><b>${esc(r.data.name||"(no name)")}</b><span>${esc([r.data.setCode||r.data.set, r.data.number].filter(Boolean).join(" "))}</span></td><td class="mono">${esc(ciWhere(r))}</td><td>${st}${iss?`<ul class="ci-iss">${iss}</ul>`:""}</td></tr>`;
}
function ciRenderRes(){
  const R = CI.res, box = $("#ci_res"), go = $("#ci_go"); if(!box || !go) return;
  if(!R){ box.innerHTML = ""; go.disabled = true; return; }
  if(R.fatal){ box.innerHTML = `<div class="ci-notice bad">${esc(R.fatal)}</div>`; go.disabled = true; go.textContent = "Import cards"; return; }
  const rows = R.rows, nSkip = rows.filter(r=>r.replaced).length, nErr = rows.filter(r=>r.errors.length && !r.replaced).length, nWarn = rows.filter(r=>!r.errors.length && r.warns.length).length, nOk = rows.length - nErr - nSkip, nRep = rows.filter(r=>!r.errors.length && r.replaceId).length;
  const nb = new Set(rows.filter(r=>!r.errors.length && r.isNew).map(r=>r.bkey)).size;
  const list = CI.filter==="issues" ? rows.filter(r=>r.errors.length || r.warns.length) : rows;
  box.innerHTML = `${R.notices.map(n=>`<div class="ci-notice">${esc(n)}</div>`).join("")}
    <div class="ci-sum">
      ${CI.done ? `<span class="chip ok">${rows.filter(r=>r.saved).length} saved</span>` : `<span class="chip ok">${nOk} ready</span>`}${nWarn?`<span class="chip warn">${nWarn} with warnings</span>`:""}${nErr?`<span class="chip err">${nErr} ${CI.done?"not imported":"with errors"}</span>`:""}${nRep && !CI.done?`<span class="chip warn">${nRep} replace${nRep===1?"s a card":" cards"}</span>`:""}${nSkip?`<span class="chip">${nSkip} skipped (same pocket as a later row)</span>`:""}${nb && !CI.done?`<span class="chip">${nb} new binder${nb===1?"":"s"}</span>`:""}
      <span class="seg" role="group" aria-label="Show rows"><button type="button" data-cifilter="all" aria-pressed="${CI.filter==="all"}">All ${rows.length}</button><button type="button" data-cifilter="issues" aria-pressed="${CI.filter==="issues"}">Problems ${nErr+nWarn+nSkip}</button></span>
    </div>
    ${nErr?`<div class="ci-fixrow"><span>${CI.done?`${nErr} row${nErr===1?"":"s"} weren't imported.`:`${nErr} row${nErr===1?"":"s"} with errors will be skipped.`} Fix ${nErr===1?"it":"them"} in your spreadsheet and import again.</span><button class="btn sm" type="button" id="ci_fix">Download rows to fix</button></div>`:""}
    <div class="ci-rows tablewrap"><table><thead><tr><th class="r">Row</th><th>Card</th><th>Goes to</th><th>Check</th></tr></thead><tbody>${list.map(ciRowHTML).join("") || `<tr><td colspan="4" class="empty-state">No problems found.</td></tr>`}</tbody></table></div>`;
  if(CI.done){ go.hidden = true; const cl = $("#ci_close"); if(cl){ cl.textContent = "Close"; cl.disabled = false; } return; }
  go.disabled = !nOk || CI.busy;
  go.textContent = nOk ? `Import ${nOk} card${nOk===1?"":"s"}` : "Import cards";
}
async function ciSave(filename, data){
  if(!S.downloads) return toast("Downloads aren't available in this view.");
  try{ await S.downloads.save({filename, data}); }
  catch(e){ if(e?.code!=="declined") toast("The file didn't download. Try again."); }
}
async function ciTemplate(){
  const H = CI_COLS.map(c=>c.h);
  const ex = [
    {"Binder":"Binder 1","Page":"1","Pocket":"1","Name":"Charizard ex","Set":"Obsidian Flames","Set code":"OBF","Number":"125/197","Rarity":"Double Rare","Language":"English","Condition":"Near Mint","Graded by":"Raw","Status":"In binder","Paid":"12.00","Paid date":"2026-06-14","Paid where":"Local card shop","Value":"18.50","Value type":"Market price","Value date":"2026-09-20","Value source":"TCGplayer","Currency":"CAD","Notes":"Example row. Replace with your own cards."},
    {"Binder":"Binder 1","Name":"Umbreon VMAX","Set":"Evolving Skies","Set code":"EVS","Number":"215/203","Rarity":"Secret Rare","Variant":"Alternate art","Language":"English","Condition":"Near Mint","Graded by":"PSA","Grade":"10","Status":"Listed for sale","Value":"1850.00","Value type":"Sold comp","Value date":"2026-09-18","Value source":"eBay","Currency":"USD","Notes":"Example row. Page and Pocket blank, so it goes in the next empty pocket."},
    {"Name":"Pikachu","Set":"Celebrations","Set code":"CEL","Number":"005/025","Rarity":"Holo Rare","Language":"English","Condition":"Lightly Played","Graded by":"Raw","Status":"Sold","Paid":"2.00","Paid date":"2026-03-02","Paid where":"Card show","Sold for":"8.00","Sold date":"2026-08-30","Sold where":"Facebook Marketplace","Currency":"CAD","Notes":"Example row. No binder, so it goes under Not in a binder."}
  ];
  const csv = [H.map(ciQ).join(","), ...ex.map(o=>H.map(h=>ciQ(o[h]??"")).join(","))].join("\r\n") + "\r\n";
  await ciSave("binder-ledger-import-template.csv", "﻿" + csv);
}
async function ciFixFile(){
  const bad = CI.res?.rows.filter(r=>r.errors.length && !r.replaced) || []; if(!bad.length) return;
  const w = CI.res.header.length;
  const lines = [[...CI.res.header, "Import problems"], ...bad.map(r=>[...Array.from({length:w},(_,i)=>r.raw[i]??""), r.errors.join(" ")])].map(a=>a.map(ciQ).join(","));
  await ciSave(`${(CI.file||"import").replace(/\.[^.]+$/,"")}-to-fix.csv`, "﻿" + lines.join("\r\n") + "\r\n");
}
async function ciTry(fn){
  for(let a=0;;a++){
    try{ return await fn(); }
    catch(e){ if(a<4 && (e?.code==="resource_exhausted" || e?.code==="unavailable")){ await new Promise(r=>setTimeout(r, 500*2**a + Math.random()*300)); continue; } throw e; }
  }
}
function ciErrText(e){
  const c = e?.code;
  if(c==="quota_exceeded") return "Not saved: the ledger is full. Delete some cards and import this row again.";
  if(c==="invalid_argument" || c==="not_granted" || c==="revoked") return "Not saved: you may only have view access to this ledger.";
  if(c==="binder") return "Not saved: its new binder couldn't be created. Import this row again.";
  return "Not saved: the connection dropped. Import this row again.";
}
async function ciRun(){
  if(!CI || CI.busy || CI.done || !CI.res || CI.res.fatal) return;
  if(!S.db) return toast("Saving isn't available in this view.");
  const rows = CI.res.rows.filter(r=>!r.errors.length); if(!rows.length) return;
  CI.busy = true;
  ["ci_create","ci_taken","ci_pockets","ci_file","ci_go","ci_close"].forEach(id => { const el = $("#"+id); if(el) el.disabled = true; });
  const prog = t => { const p = $("#ci_prog"); if(p) p.textContent = t; };
  const FATAL = new Set(["quota_exceeded","invalid_argument","not_granted","revoked"]);
  const ids = {}; let order = Math.max(0, ...S.binders.map(x=>x.order||0)), ci = S.binders.length, stop = null;
  for(const [k, nb] of CI.res.newBinders){
    if(!rows.some(r=>r.bkey===k) || stop) continue;
    prog(`Creating ${nb.name}…`);
    const nid = rid();
    try{ await ciTry(()=> S.db.collection("binders").doc(nid).set({name:nb.name, color:BINDER_COLORS[ci++ % BINDER_COLORS.length], pockets:nb.pockets, order:++order, createdAt:nowISO()})); ids[k] = nid; }
    catch(e){ console.error(e); if(FATAL.has(e?.code)) stop = e; }
  }
  let done = 0, i = 0, replacedN = 0;
  const fail = (r, e) => { r.failed = true; r.errors.push(ciErrText(e)); };
  const bidOf = r => !r.bkey ? null : r.bkey.startsWith("id:") ? r.bkey.slice(3) : ids[r.bkey];
  async function worker(){
    while(i < rows.length){
      const r = rows[i++];
      if(stop){ fail(r, stop); continue; }
      const bid = bidOf(r);
      if(r.bkey && !bid){ fail(r, {code:"binder"}); continue; }
      try{
        const old = r.replaceId ? (S.cards.find(c=>c.id===r.replaceId) || r.replaceOld) : null;
        const keepImg = old && old.imageId && dupKey(old)===dupKey(r.data) ? old.imageId : null;
        await ciTry(()=> S.db.collection("cards").doc(r.replaceId || rid()).set({...r.data, binderId:bid, page:bid?r.page:null, slot:bid?r.slot:null, imageId:keepImg, prices:r.prices, createdAt:old?.createdAt||nowISO(), updatedAt:nowISO()}));
        if(old && old.imageId && !keepImg && S.assets && !S.cards.some(x=>x.id!==old.id && x.imageId===old.imageId)){ try{ await delAsset(old.imageId); }catch(e){} }
        if(r.replaceId) replacedN++;
        r.saved = true; done++; prog(`Saved ${done} of ${rows.length}…`);
      }catch(e){ console.error(e); if(FATAL.has(e?.code)) stop = e; fail(r, e); }
    }
  }
  prog(`Saving 1 of ${rows.length}…`);
  await Promise.all([worker(), worker(), worker()]);
  CI.busy = false;
  const failed = rows.filter(r=>r.failed).length, first = rows.find(r=>r.saved);
  if(first){ const bid = bidOf(first); if(bid){ S.binderId = bid; S.page = first.page; S.view = "pages"; } else { S.binderId = "__loose"; S.view = "list"; } persistNav(); }
  const repTxt = replacedN ? ` (${replacedN} replaced)` : "";
  if(!failed && $("#ci_card")){ closeModal(); render(); toast(`Imported ${done} card${done===1?"":"s"}${repTxt}`); return; }
  CI.done = true; CI.filter = failed ? "issues" : "all";
  prog(failed ? `Saved ${done} of ${rows.length}. ${failed} didn't save.` : `Saved ${done} card${done===1?"":"s"}.`);
  ciRenderRes(); render();
  if(!$("#ci_card")) toast(failed ? `Imported ${done}. ${failed} didn't save.` : `Imported ${done} card${done===1?"":"s"}`);
}

/* ---------- events ---------- */
function persistNav(){ store.set("binder",S.binderId); store.set("page",S.page); store.set("view",S.view); store.set("scope",S.scope); store.set("sort",S.sort); }
/* press and hold to select */
const HOLD_MS = 480;
let hold = null, suppressClick = false;
document.addEventListener("pointerdown", e => {
  suppressClick=false; if(e.button>0) return;
  const cd = e.target.closest("[data-card]"); if(!cd || cd.closest(".drawer") || S.mode!=="ready") return;
  clearTimeout(hold?.t);
  hold = {x:e.clientX, y:e.clientY, t:setTimeout(()=>{
    hold=null; suppressClick=true; const id=cd.dataset.card;
    if(S.pick){ S.pick.has(id)?S.pick.delete(id):S.pick.add(id); S.pickConfirm=false; renderMain(); } else startPick(id);
  }, HOLD_MS)};
});
const cancelHold = () => { if(hold){ clearTimeout(hold.t); hold=null; } };
document.addEventListener("pointermove", e => { if(hold && Math.hypot(e.clientX-hold.x, e.clientY-hold.y) > 10) cancelHold(); });
document.addEventListener("pointerup", cancelHold);
document.addEventListener("pointercancel", cancelHold);
document.addEventListener("scroll", cancelHold, true);
/* swipe between pages */
let swipe = null, swipeEat = 0;
document.addEventListener("pointerdown", e => {
  swipe = null; if(e.pointerType==="mouse" || S.view==="list" || S.mode!=="ready") return;
  const pg = e.target.closest("#main .binder-page"); if(!pg) return;
  swipe = {x:e.clientX, y:e.clientY, t:Date.now(), id:e.pointerId};
});
document.addEventListener("pointerup", e => {
  const sw = swipe; swipe = null; if(!sw || sw.id!==e.pointerId) return;
  const dx = e.clientX-sw.x, dy = e.clientY-sw.y;
  if(Math.abs(dx) < 50 || Math.abs(dx) < Math.abs(dy)*1.5 || Date.now()-sw.t > 800) return;
  const b = curBinder(); if(!b) return;
  const mp = maxPage(b.id), dir = dx < 0 ? 1 : -1, np = S.page + dir;
  if(np < 1 || np > mp+1) return;
  cancelHold(); swipeEat = Date.now(); S.page = np; persistNav(); renderMain();
  const pg = $("#main .binder-page"); if(pg) pg.classList.add(dir>0?"slide-l":"slide-r");
});
document.addEventListener("pointercancel", () => { swipe = null; });
document.addEventListener("click", e => { if(swipeEat && Date.now()-swipeEat < 450){ swipeEat=0; e.preventDefault(); e.stopPropagation(); } }, true);
document.addEventListener("contextmenu", e => { if(e.target.closest("#main [data-card]")) e.preventDefault(); });
function pickPending(){ return S.pickAt && Date.now()-S.pickAt < 60000; }
function photoNote(t){ const n=$("#imgNote"); if(n) n.textContent = t; }
function sniffType(u){
  if(u[0]===0xFF && u[1]===0xD8) return "image/jpeg";
  if(u[0]===0x89 && u[1]===0x50 && u[2]===0x4E && u[3]===0x47) return "image/png";
  if(u[0]===0x47 && u[1]===0x49 && u[2]===0x46) return "image/gif";
  if(u[0]===0x52 && u[1]===0x49 && u[2]===0x46 && u[3]===0x46 && u[8]===0x57 && u[9]===0x45 && u[10]===0x42 && u[11]===0x50) return "image/webp";
  if(/^ftyp(heic|heix|hevc|heim|heis|mif1|msf1)/.test(String.fromCharCode(...u.slice(4,12)))) return "image/heic";
  return "";
}
/* copy the picture's bytes straight away: some phones stop letting the page read a pasted or picked file once the event is over */
function snapshot(f){
  let p; try{ p = f.arrayBuffer ? f.arrayBuffer() : new Response(f).arrayBuffer(); }catch(e){ p = Promise.reject(e); }
  return p.then(buf => {
    const t = f.type && f.type!=="application/octet-stream" ? f.type : sniffType(new Uint8Array(buf.slice(0,16)));
    return new Blob([buf], {type: t || ""});
  }).catch(e => { console.error("couldn't copy the photo", e); return f; });
}
let lastTakeAt = 0;
function takePhotoFile(f, how){
  if(!f){ photoNote("No photo came back. Try again, or paste one in the box above."); return; }
  if(Date.now()-lastTakeAt < 800) return; lastTakeAt = Date.now();
  const target = S.photoFor ?? S.sel; S.pickAt = 0;
  const looksImg = !f.type || /^image\//.test(f.type) || f.type==="application/octet-stream" || /\.(jpe?g|png|gif|webp|hei[cf]|bmp|tiff?)$/i.test(f.name||"");
  if(!looksImg){ uploadErr({code:"notimage"}); photoNote("That file isn't a picture. Pick a JPG, PNG or screenshot."); return; }
  const snap = snapshot(f);
  photoNote(`Got the photo${how?` (${how})`:""}. Saving…`);
  setPhoto(snap, target, f);
}
document.addEventListener("click", e => { if(e.target.closest && e.target.closest("[data-pick]")){ S.photoFor = S.sel; S.pickAt = Date.now(); photoNote("Opening… If nothing opens, copy the picture and paste it in the box instead."); } });
/* catch the picker's result even if the drawer redrew while the phone's picker was open */
function watchPicker(){
  document.querySelectorAll("input[data-photo]").forEach(p => { if(p._w) return; p._w = 1; const h = () => { const f = p.files && p.files[0]; if(!f) return; takePhotoFile(f); try{ p.value = ""; }catch(_){} }; p.addEventListener("change",h); p.addEventListener("input",h); });
  const b = $("#photoPaste"), img = b && b.querySelector("img");
  if(img && !img._t){ img._t = 1; const src = img.currentSrc || img.src; resetPasteBox(); if(src) fromSrc(src).then(ok => { if(!ok) photoNote("That picture couldn't be read here. Save it to your photos and use Choose photo, or take a screenshot of it and paste that."); }); }
}
new MutationObserver(watchPicker).observe(document.body,{childList:true,subtree:true});
document.addEventListener("visibilitychange", () => {
  if(document.visibilityState!=="visible" || !S.pickAt) return; const at = S.pickAt;
  setTimeout(() => { if(S.pickAt!==at || S.photoBusy) return;
    const p = [...document.querySelectorAll("input[data-photo]")].find(x => x.files && x.files[0]);
    if(p){ takePhotoFile(p.files[0]); try{ p.value=""; }catch(_){} }
    else { S.pickAt = 0; photoNote("No photo came back. Try again, or copy the picture and paste it in the box above."); }
  }, 1200);
});
/* paste / drop */
function resetPasteBox(){ const b = $("#photoPaste"); if(b){ b.textContent = PASTE_PH; b.blur(); } }
function clipImageFile(dt){
  if(!dt) return null;
  const items = [...(dt.items||[])];
  const it = items.find(i => i.kind==="file" && /^image\//.test(i.type)) || items.find(i => i.kind==="file");
  let f = null; try{ f = it ? it.getAsFile() : null; }catch(_){}
  if(!f){ const fs = [...(dt.files||[])]; f = fs.find(x => /^image\//.test(x.type)) || fs[0] || null; }
  return f;
}
function imgSrcFromHtml(dt){ try{ const h = dt && dt.getData && dt.getData("text/html"); const m = h && h.match(/<img[^>]+src=["'](data:image\/[^"']+|blob:[^"']+)["']/i); return m ? m[1] : null; }catch(_){ return null; } }
async function fromSrc(src){ try{ const r = await fetch(src); const b = await r.blob(); if(!b.size) return false; S.photoFor = S.sel; takePhotoFile(b, "pasted"); return true; }catch(e){ console.error(e); return false; } }
document.addEventListener("paste", e => {
  if(!e.target.closest || !e.target.closest("#photoPaste")) return;
  const f = clipImageFile(e.clipboardData);
  if(f){ e.preventDefault(); S.photoFor = S.sel; takePhotoFile(f, "pasted"); resetPasteBox(); return; }
  const src = imgSrcFromHtml(e.clipboardData);
  if(src){ e.preventDefault(); resetPasteBox(); fromSrc(src); return; }
  /* let the phone paste it into the box: the watcher above picks up any picture that lands there */
  const txt = (() => { try{ return (e.clipboardData?.getData("text/plain")||"").trim(); }catch(_){ return ""; } })();
  setTimeout(() => { const b = $("#photoPaste"); if(!b || b.querySelector("img")) return; resetPasteBox();
    if(Date.now()-lastTakeAt < 1500) return;
    photoNote(/^https?:\/\//i.test(txt) ? "That's a link to a picture, not the picture. Open it, press and hold the picture, tap Copy, then paste here." : "There's no picture on your clipboard. Press and hold the picture itself and tap Copy, then paste here."); }, 450);
});
document.addEventListener("beforeinput", e => {
  if(!(e.target.closest && e.target.closest("#photoPaste"))) return;
  if(e.inputType==="insertFromPaste" || e.inputType==="insertReplacementText"){ const f = clipImageFile(e.dataTransfer); if(f){ e.preventDefault(); S.photoFor = S.sel; takePhotoFile(f, "pasted"); resetPasteBox(); } return; }
  e.preventDefault();
});
document.addEventListener("dragover", e => { const b=e.target.closest && e.target.closest("#photoPaste"); if(b){ e.preventDefault(); b.classList.add("over"); } });
document.addEventListener("dragleave", e => { const b=e.target.closest && e.target.closest("#photoPaste"); if(b) b.classList.remove("over"); });
document.addEventListener("drop", e => { const b=e.target.closest && e.target.closest("#photoPaste"); if(!b) return; e.preventDefault(); b.classList.remove("over"); const f=clipImageFile(e.dataTransfer); if(f){ S.photoFor=S.sel; takePhotoFile(f,"dropped"); } else toast("Drop a picture file here."); });
async function pasteFromClipboard(){
  S.photoFor = S.sel;
  try{
    const items = await navigator.clipboard.read();
    for(const it of items){ const t = it.types.find(x => /^image\//.test(x)); if(t){ const b = await it.getType(t); takePhotoFile(b.type ? b : new Blob([b],{type:t}), "pasted"); return; } }
    photoNote("There's no picture on your clipboard. Press and hold the picture itself and tap Copy, then tap Paste photo again.");
  }catch(e){ console.error(e); const b = $("#photoPaste"); if(b) b.focus(); photoNote("This view didn't let the button read your clipboard. Press and hold the box above and tap Paste instead."); }
}
document.addEventListener("click", e => {
  const t = e.target;
  if(suppressClick){ suppressClick=false; if(t.closest("[data-card]")){ e.preventDefault(); return; } }
  if(S.pick){
    if(t.closest("#pickCancel")) return endPick();
    if(t.closest("#pickAll")){ const allOn = S.shown.every(id=>S.pick.has(id)); S.shown.forEach(id=> allOn?S.pick.delete(id):S.pick.add(id)); S.pickConfirm=false; return renderMain(); }
    if(t.closest("#pickDel")){ S.pickConfirm=true; return renderMain(); }
    if(t.closest("#pickDelNo")){ S.pickConfirm=false; return renderMain(); }
    if(t.closest("#pickDelYes")) return void deletePicked();
    if(t.closest("#pickDup")) return void duplicatePicked();
    if(t.closest("#pickPh")) return void placeholderPicked();
    if(t.closest("#pickSell")) return quickSellModal([...S.pick]);
    const pcd = t.closest("#main [data-card]");
    if(pcd){ const id=pcd.dataset.card; S.pick.has(id)?S.pick.delete(id):S.pick.add(id); S.pickConfirm=false; if(!S.pick.size) return endPick(); return renderMain(); }
    if(t.closest("#main [data-empty]")) return;
    if(t.closest("[data-binder],#btnAdd,#btnImport")){ S.pick=null; S.pickConfirm=false; }
  }
  const tab = t.closest("[data-binder]");
  if(tab){ const id = tab.dataset.binder; if(S.binderId===id && id!=="__loose" && id!=="__sales"){ binderModal(id); return; } S.binderId=id; S.page=1; if(id==="__loose") S.view="list"; persistNav(); render(); return; }
  if(t.closest("#btnNewBinder") || t.closest("#btnFirstBinder")) return void newBinder();
  if(t.closest("#vPages")){ if(S.binderId==="__loose" || S.binderId==="__sales") S.binderId = sortedBinders()[0]?.id || null; S.view="pages"; persistNav(); render(); return; }
  if(t.closest("#vList")){ if(S.binderId==="__sales") S.binderId = sortedBinders()[0]?.id || "__loose"; S.view="list"; persistNav(); render(); return; }
  if(t.closest("#btnPhotos")) return openViewer();
  if(t.closest("#btnFind")) return openFind();
  if(t.closest("#btnAdd")) return openNew();
  if(t.closest("#btnImport")) return importModal();
  if(t.closest("#btnCsvImport")) return csvImportModal();
  if(t.closest("#btnExport")) return void exportCSV();
  if(t.closest("#btnSettings") || t.closest("#btnFirstRestore") || t.closest("#btnPriceStatus")) return settingsModal();
  if(t.closest("#sFillDetails")){ t.closest("#sFillDetails").disabled = true; window.ledgerApi.call("POST","api/cards/fill-details").then(r=>toast(r.cards ? `Looking up ${r.cards} card${r.cards===1?"":"s"} in TCGdex. This takes about a second each.` : "Nothing to fill in."), e=>toast(e?.message||"Couldn't start it.")); return; }
  if(t.closest("#sRunPrices")){ t.closest("#sRunPrices").disabled = true; window.ledgerApi.call("POST","api/pricing/run").then(()=>toast("Updating every card's price. This takes a few minutes."), e=>toast(e?.message||"Couldn't start the update.")); return; }
  const oc = t.closest("[data-openc]"); if(oc){ closeModal(); return openCard(oc.dataset.openc); }
  if(t.closest("#btnBinderSettings")){ const b=curBinder(); if(b) binderModal(b.id); return; }
  if(t.closest("#btnSortBinder")){ const b=curBinder(); if(b) sortModal(b.id); return; }
  if(t.closest("#btnChecks")) return checksModal();
  const pc = t.closest("[data-page]"); if(pc){ S.page=+pc.dataset.page; persistNav(); renderMain(); return; }
  const stp = t.closest("[data-step]"); if(stp){ S.page+= +stp.dataset.step; persistNav(); renderMain(); return; }
  const em = t.closest("[data-empty]"); if(em){ return openNew({binderId:curBinder().id, page:S.page, slot:+em.dataset.empty}); }
  const sc = t.closest("[data-sort]"); if(sc){ const k=sc.dataset.sort; S.sort = {k, d: S.sort.k===k ? -S.sort.d : (k==="value"||k==="paid"?-1:1)}; persistNav(); renderMain(); return; }
  const scp = t.closest("[data-scope]"); if(scp){ S.scope=scp.dataset.scope; persistNav(); renderMain(); return; }
  const us = t.closest("[data-unsell]"); if(us) return void undoSale(us.dataset.unsell);
  const ub = t.closest("[data-unbundle]"); if(ub) return void undoBundle(ub.dataset.unbundle);
  const sr = t.closest("[data-sale]"); if(sr){ return openCard(sr.dataset.sale); }
  const cd = t.closest("[data-card]"); if(cd && !t.closest(".drawer")){ return openCard(cd.dataset.card); }
  if(t.closest("[data-close]")){ return closeDrawer(); }
  if(t.matches("[data-mclose]") || t.closest("button[data-mclose]")) return closeModal();
  // drawer actions
  if(t.closest("#bigImg img, #bigImg [data-lbopen]")) return openViewer(S.sel);
  if(t.closest("#btnDel")){ S.confirm="delete"; $("#delZone").innerHTML=delZone(); return; }
  if(t.closest("#btnDelNo")){ S.confirm=null; $("#delZone").innerHTML=delZone(); return; }
  if(t.closest("#btnDelYes")) return void deleteCard();
  if(t.closest("#btnDup")) return void duplicateCard();
  if(t.closest("#btnQuickSell")){ if(S.dirty) return toast("Save or discard your changes first."); return quickSellModal([S.sel]); }
  if(t.closest("#btnAddPrice")) return void addPrice();
  const pe = t.closest("[data-pedit]"); if(pe){ S.editPrice=pe.dataset.pedit; S.confirm=null; refreshParts(selCard(),{price:true}); return; }
  if(t.closest("[data-pcancel]")){ S.editPrice=null; refreshParts(selCard(),{price:true}); return; }
  const ps = t.closest("[data-psave]"); if(ps) return void savePrice(ps.dataset.psave);
  const pd = t.closest("[data-pdel]"); if(pd){ S.confirm="p:"+pd.dataset.pdel; refreshParts(selCard(),{price:true}); return; }
  if(t.closest("[data-pdelno]")){ S.confirm=null; refreshParts(selCard(),{price:true}); return; }
  const py = t.closest("[data-pdelyes]"); if(py) return void delPrice(py.dataset.pdelyes);
  if(t.closest("#btnPasteImg")) return void pasteFromClipboard();
  const dp = t.closest("[data-dpick]"); if(dp){ const m = DL.res[+dp.dataset.dpick]; if(m) applyDetails(m); return; }
  if(t.closest("[data-dundo]")) return undoDetails();
  const pr = t.closest("[data-pr]"); if(pr) return void priceAction(pr.dataset.pr, selCard());
  const cd2 = t.closest("[data-cand]"); if(cd2){ const [from, i] = cd2.dataset.cand.split(":"); const c = selCard(); const list = from==="stored" ? (c?.pricing?.candidates||[]) : (Array.isArray(S.pickRes)?S.pickRes:[]); const x = list[+i]; if(x) priceAction("link", c, {source:x.source, id:x.id, url:x.url, title:x.title, set:x.set}); return; }
  const pc2 = t.closest("[data-pic]"); if(pc2 && !pc2.disabled){ const c = selCard(); if(c && S.sel!=="__new") updateCard(c.id, {imagePref: pc2.dataset.pic}).then(ok=>{ if(ok){ refreshParts(selCard()); renderMain(); } }); return; }
  if(t.closest("#btnRmImg")){ const c=selCard(); if(S.sel==="__new"){ S.draft.imageId=null; renderDrawer(true); } else updateCard(c.id,{imageId:null}).then(ok=>ok&&toast("Photo removed from card")); return; }
  if(t.closest("#btnMove")){ const c=selCard(); const bid=$("#m_binder").value; return void moveCard(c, bid||null, Math.max(1, +$("#m_page").value||1), +$("#m_slot").value); }
  if(t.closest("#btnFree")){ const bid=$("#m_binder").value; if(!bid) return; const f=firstFree(bid); $("#m_page").value=f.page; $("#m_slot").value=f.slot; updateMoveNote(); return; }
  if(t.closest("#btnTakeOut")){ const c=selCard(); return void moveCard(c, null); }
});
document.addEventListener("input", e => {
  if(e.target.id==="f_placeholder" && S.sel!=="__new") return;
  if(e.target.closest("#cardForm")){ S.dirty=true; const b=$("#btnSave"); if(b) b.disabled=false; if(e.target.id==="f_name") $("#dTitle").textContent = e.target.value || "New card";
    if(e.target.classList.contains("autofilled")) e.target.classList.remove("autofilled");
    if(/^f_(name|number|set|setCode)$/.test(e.target.id)) scheduleLookup(); }
  if(e.target.id==="q"){ S.q=e.target.value; clearTimeout(S._qt); S._qt=setTimeout(renderMain,120); }
  if(e.target.id==="findQ"){ FIND.q=e.target.value; findRun(); }
  if(e.target.closest("#priceSec")) S.priceTouched=true;
  if(e.target.closest("#moveSec")){ S.moveTouched=true; updateMoveNote(); }
});
/* the drawer's Placeholder switch on a saved card: saves at once, without touching the form */
async function switchPlaceholder(box){
  const c = selCard(), on = box.checked; if(!c) return;
  if(!(await updateCard(c.id, {placeholder:on}))){ box.checked = !on; return; }
  const qs = $("#btnQuickSell"); if(qs) qs.hidden = on;
  toast(on ? `${c.name||"Card"} is a placeholder: not counted in your totals` : `${c.name||"Card"} is counted in your totals now`);
}
document.addEventListener("change", e => {
  if(e.target.closest("#priceSec")) S.priceTouched=true;
  if(e.target.closest("#moveSec")) S.moveTouched=true;
  if(e.target.id==="f_placeholder" && S.sel!=="__new") return void switchPlaceholder(e.target);
  if(e.target.closest("#cardForm")){ S.dirty=true; const b=$("#btnSave"); if(b) b.disabled=false; }
  if(e.target.matches && e.target.matches("input[data-photo]")){ const f=e.target.files && e.target.files[0]; if(f){ takePhotoFile(f); try{ e.target.value=""; }catch(_){} } }
  if(e.target.id==="m_binder"){ const bid=e.target.value; const b=binderById(bid); $("#m_page").disabled=!bid; $("#m_slot").disabled=!bid;
    if(b){ const n=pocketsOf(b); $("#m_slot").innerHTML=Array.from({length:n},(_,i)=>`<option value="${i+1}">${i+1}</option>`).join(""); const f=firstFree(bid); $("#m_page").value=f.page; $("#m_slot").value=f.slot; }
    updateMoveNote(); }
});
document.addEventListener("submit", e => {
  if(e.target.id==="cardForm"){ e.preventDefault(); saveCard(); }
  if(e.target.id==="pickForm"){ e.preventDefault(); S.pickQ = $("#pickQ").value; const c = selCard(); if(c) pickSearch(c); }
});
document.addEventListener("toggle", e => { if(e.target.id==="autoLog") S.autoLogOpen = e.target.open; }, true);
document.addEventListener("keydown", e => {
  if(FIND.open) return findKey(e);
  if(!LB.open && !$("#modalRoot").innerHTML && !isTyping(e.target) && !e.altKey && ((e.key==="/" && !e.ctrlKey && !e.metaKey) || ((e.key==="k" || e.key==="K") && (e.ctrlKey || e.metaKey)))){ e.preventDefault(); return openFind(); }
  if(LB.open){ if(e.key==="Escape"){ e.preventDefault(); closeViewer(); } else if(e.key==="ArrowLeft"||e.key==="ArrowRight"){ e.preventDefault(); lbGo(LB.i+(e.key==="ArrowLeft"?-1:1)); } else if(e.key==="Home"||e.key==="End"){ e.preventDefault(); lbGo(e.key==="Home"?0:LB.list.length-1); } return; }
  if(e.key==="Escape"){ if($("#modalRoot").innerHTML){ if(!CI?.busy || !$("#ci_card")) closeModal(); } else if(S.sel) closeDrawer(); else if(S.pick) endPick(); } });
function updateMoveNote(){
  const n=$("#moveNote"); if(!n) return; const c=selCard(); const bid=$("#m_binder").value;
  if(!bid){ n.textContent="The card stays in your ledger under “Not in a binder”."; return; }
  const o = cardAt(bid, Math.max(1,+$("#m_page").value||1), +$("#m_slot").value);
  n.textContent = o && o.id!==c.id ? `${o.name||"Another card"} is in that pocket. They'll swap places.` : o ? "That's where it is now." : "That pocket is empty.";
}

/* ---------- find a card ---------- */
/* Find (button or "/"): type a Pokémon name, set, set code or number; each match can be shown where
   it sits (binder page, Not in a binder, or Sales) or opened full screen. Matching is in search.js. */
const FIND = {open:false, q:"", res:[], i:0, back:null};
const FOUND_MS = 6000;
const reduceMotion = () => !!(window.matchMedia && matchMedia("(prefers-reduced-motion: reduce)").matches);
const isTyping = t => !!t && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName));
function whereIs(c){
  const b = binderById(c.binderId);
  if(b) return {kind:"binder", label:`${b.name} · Page ${c.page} · Pocket ${c.slot}`, act:"Show in binder"};
  if(saleInfo(c) && !looseCards().some(x=>x.id===c.id)) return {kind:"sales", label:"Sold", act:"Show in sales"};
  return {kind:"loose", label:"Not in a binder", act:"Show in list"};
}
function openFind(){
  if(FIND.open){ $("#findQ")?.focus(); return; }
  FIND.open = true; FIND.back = document.activeElement;
  $("#findRoot").innerHTML = `<div class="find" data-find="backdrop">
    <div class="find-card" role="dialog" aria-modal="true" aria-label="Find a card">
      <div class="find-bar">
        <label class="search"><svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/></svg><input id="findQ" type="search" placeholder="Name, set, set code or number" value="${esc(FIND.q)}" autocomplete="off" autocapitalize="off" spellcheck="false" enterkeyhint="search" aria-label="Find a card" aria-describedby="findNote" aria-controls="findList"></label>
        <button type="button" class="btn ghost" data-find="close">Close</button>
      </div>
      <p class="find-note hint" id="findNote" aria-live="polite"></p>
      <ul class="find-list" id="findList" aria-label="Matching cards"></ul>
    </div></div>`;
  document.documentElement.style.overflow = "hidden";
  findRun();
  const q = $("#findQ"); q.focus(); q.select();
}
function closeFind(restoreFocus=true){
  if(!FIND.open) return;
  FIND.open = false; $("#findRoot").innerHTML = ""; document.documentElement.style.overflow = "";
  const b = FIND.back; FIND.back = null;
  if(restoreFocus && b && document.contains(b)) try{ b.focus({preventScroll:true}); }catch(_){}
}
function findRun(){
  FIND.res = window.BinderSearch ? window.BinderSearch.search(S.cards, FIND.q, {limit:50, order:SORTS.loc}) : [];
  FIND.i = 0; findRender();
}
function findRender(){
  const list = $("#findList"), note = $("#findNote"); if(!list) return;
  const q = FIND.q.trim(), n = FIND.res.length;
  const keys = window.matchMedia && matchMedia("(pointer: fine)").matches ? " · Enter shows it, Shift+Enter opens it full screen" : "";
  note.textContent = !q ? (S.cards.length ? `Type a Pokémon name, a set (Base Set), a set code (PBS) or a number (7/15). ${S.cards.length} cards to look through.` : "No cards yet.")
    : !n ? `No card matches “${q}”. Try fewer words, a set code like PBS, or a number like 7/15.`
    : `${n===50?"The best 50 matches":`${n} match${n===1?"":"es"}`}${keys}`;
  list.innerHTML = FIND.res.map(({card:c}, k) => {
    const w = whereIs(c), pic = shown(c);
    const st = c.status && c.status!=="binder" && c.status!=="sold" ? ` · ${(STATUSES.find(x=>x[0]===c.status)||[,""])[1]}` : "";
    const meta = [c.set, [c.setCode, c.number].filter(Boolean).join(" ")].filter(Boolean).join(" · ") || "No set yet";
    return `<li class="find-item" id="fi${k}" data-fi="${k}">
      <button type="button" class="find-main" data-find="show" data-fi="${k}" aria-label="${esc(`${c.name||"Unnamed card"}, ${meta}, ${w.label}. ${w.act}`)}">
        ${pic?`<img class="thumb" src="${imgURL(pic)}" alt="" loading="lazy">`:`<span class="thumb"></span>`}
        <span class="find-txt"><b>${esc(c.name||"Unnamed card")}</b><span class="mono">${esc(meta)}</span><span class="find-loc">${esc(w.label + st)}</span></span>
      </button>
      <span class="find-acts"><button type="button" class="btn sm" data-find="show" data-fi="${k}">${esc(w.act)}</button><button type="button" class="btn sm" data-find="full" data-fi="${k}" ${pic?"":`disabled title="No picture of this card yet"`}>Full screen</button></span>
    </li>`;
  }).join("");
  findSync();
}
function findSync(){
  document.querySelectorAll("#findList .find-item").forEach((li,k) => li.classList.toggle("cur", k===FIND.i));
  const cur = document.getElementById("fi"+FIND.i); if(cur) cur.scrollIntoView({block:"nearest"});
}
function findAct(kind, k){
  const r = FIND.res[k]; if(!r) return;
  const c = S.cards.find(x=>x.id===r.card.id) || r.card;
  if(kind==="full" && shown(c)){
    const list = FIND.res.map(x=>S.cards.find(y=>y.id===x.card.id) || x.card).filter(x=>shown(x));
    closeFind(false); return openViewer(c.id, list);
  }
  if(S.dirty) return toast("Save or discard the card you're editing first.");
  closeFind(false);
  if(kind==="full") toast("No picture of this card yet, so here it is instead.");
  showCard(c.id);
}
/* Take the person to a card: its binder and page (or the list it's in), scrolled to and highlighted. */
function showCard(id){
  const c = S.cards.find(x=>x.id===id); if(!c) return toast("That card isn't in the ledger any more.");
  if(S.dirty) return toast("Save or discard the card you're editing first.");
  S.pick = null; S.pickConfirm = false;
  S.pricePick = null; S.pickRes = null; S.sel = null; S.draft = null; S.editPrice = null; S.confirm = null;
  const w = whereIs(c);
  if(w.kind==="binder"){ S.binderId = c.binderId; S.view = "pages"; S.page = c.page || 1; }
  else if(w.kind==="loose"){ S.binderId = "__loose"; S.view = "list"; S.scope = "binder"; S.q = ""; }
  else S.binderId = "__sales";
  S.found = {id:c.id, until:Date.now()+FOUND_MS};
  persistNav(); render();
  const sel = CSS.escape(c.id), el = $(`#main [data-card="${sel}"], #main [data-sale="${sel}"]`);
  if(el){ el.scrollIntoView({block:"center", behavior: reduceMotion() ? "auto" : "smooth"}); try{ el.focus({preventScroll:true}); }catch(_){} }
  clearTimeout(S._foundT);
  S._foundT = setTimeout(() => { S.found = null; document.querySelectorAll("#main .found").forEach(x=>x.classList.remove("found")); }, FOUND_MS);
  toast(`${c.name||"Card"}: ${w.label}`);
}
function findKey(e){
  if(e.key==="Escape"){ e.preventDefault(); return closeFind(); }
  if(e.target.id!=="findQ") return;
  const n = FIND.res.length;
  if(e.key==="ArrowDown" || e.key==="ArrowUp"){ if(!n) return; e.preventDefault(); FIND.i = (FIND.i + (e.key==="ArrowDown" ? 1 : -1) + n) % n; return findSync(); }
  if(e.key==="Enter"){ e.preventDefault(); if(n) findAct(e.shiftKey ? "full" : "show", FIND.i); }
}
$("#findRoot").addEventListener("click", e => {
  e.stopPropagation();
  const a = e.target.closest("[data-find]"); if(!a) return;
  const k = a.dataset.find;
  if(k==="backdrop"){ if(e.target===a) closeFind(); return; }
  if(k==="close") return closeFind();
  if(k==="show" || k==="full") return findAct(k, +a.dataset.fi);
});
$("#findRoot").addEventListener("pointermove", e => {
  const li = e.target.closest && e.target.closest(".find-item"); if(!li || e.pointerType!=="mouse") return;
  const k = +li.dataset.fi; if(k!==FIND.i){ FIND.i = k; document.querySelectorAll("#findList .find-item").forEach((x,j) => x.classList.toggle("cur", j===k)); }
});

/* ---------- full-screen photo viewer ---------- */
const LB = {open:false, list:[], i:0, fromDrawer:false, back:null, raf:0};
function photoScope(){
  if(S.mode==="loading") return [];
  if(S.view==="list" || S.binderId==="__loose"){ const m = new Map(S.cards.map(c=>[c.id,c])); return S.shown.map(id=>m.get(id)).filter(c=>c && shown(c)); }
  const b = curBinder(); if(!b) return [];
  return cardsIn(b.id).filter(c=>shown(c)).sort((x,y)=>(x.page||0)-(y.page||0) || (x.slot||0)-(y.slot||0));
}
function updatePhotosBtn(){
  const b = $("#btnPhotos"); if(!b) return;
  const n = photoScope().length;
  b.disabled = !n; b.querySelector(".cnt").textContent = n ? String(n) : "";
  b.title = n ? `Flip through ${n} photo${n===1?"":"s"} full screen` : "No card photos here yet";
}
const lbTrack = () => $("#lbTrack");
function lbCaption(c){
  const st = c.status && c.status!=="binder" ? (STATUSES.find(x=>x[0]===c.status)||[,""])[1] : "";
  const v = valueOf(c);
  return `<span class="n">${esc(c.name||"Unnamed card")}</span>
    <span class="m">${esc([metaLine(c), c.rarity].filter(Boolean).join(" · ") || "No set yet")}</span>
    <span class="m">${esc(c.id==="__new" ? "New card" : locShort(c))}${st?` · ${esc(st)}`:""}</span>
    ${v!=null?`<span class="v">${esc(money(v))}</span>`:""}`;
}
/* only: show just these cards (Find's matches) instead of the current binder's */
function openViewer(startId, only){
  let list = only && only.length ? only : photoScope();
  if(startId && !list.some(c=>c.id===startId)){ const c = selCard(); list = c && shown(c) ? [c] : list; }
  if(!list.length){ toast("No card photos here yet."); return; }
  let i = startId ? list.findIndex(c=>c.id===startId) : (S.view==="pages" && S.binderId!=="__loose" ? list.findIndex(c=>c.page===S.page) : 0);
  if(i<0) i = 0;
  Object.assign(LB, {open:true, list, i, fromDrawer: !!startId && !only, fromFind: !!only, back: document.activeElement});
  const n = list.length;
  const slides = list.map((c,k)=>`<div class="lb-slide" role="group" aria-roledescription="slide" aria-label="${k+1} of ${n}: ${esc(c.name||"Unnamed card")}"><img data-src="${esc(imgURL(shown(c)))}" alt="${esc(c.name||"Card")}" draggable="false"></div>`).join("");
  const thumbs = n>1 ? `<div class="lb-strip" id="lbStrip">${list.map((c,k)=>`<button type="button" class="lb-th" data-lbi="${k}" aria-label="Photo ${k+1}: ${esc(c.name||"Unnamed card")}"><img src="${esc(imgURL(shown(c)))}" alt="" loading="lazy" draggable="false"></button>`).join("")}</div>` : "";
  $("#lbRoot").innerHTML = `<div class="lb" role="dialog" aria-modal="true" aria-label="Card photos">
    <div class="lb-top"><span class="lb-count" id="lbCount" aria-live="polite"></span>
      <div class="lb-acts">${LB.fromFind?`<button type="button" class="lb-btn" data-lb="locate">Show in binder</button>`:""}${LB.fromDrawer?"":`<button type="button" class="lb-btn" data-lb="details">Card details</button>`}<button type="button" class="lb-btn" data-lb="close" aria-label="Close photos">✕ Close</button></div></div>
    <div class="lb-stage">
      <div class="lb-track" id="lbTrack" tabindex="-1">${slides}</div>
      ${n>1?`<button type="button" class="lb-nav prev" data-lb="prev" aria-label="Previous photo">‹</button><button type="button" class="lb-nav next" data-lb="next" aria-label="Next photo">›</button>`:""}
    </div>
    <div class="lb-cap" id="lbCap"></div>
    ${thumbs}</div>`;
  document.documentElement.style.overflow = "hidden";
  const tr = lbTrack();
  tr.addEventListener("scroll", () => { cancelAnimationFrame(LB.raf); LB.raf = requestAnimationFrame(lbSync); }, {passive:true});
  LB.last = -1; lbLoad(i);
  requestAnimationFrame(() => { tr.style.scrollBehavior="auto"; tr.scrollLeft = i * tr.clientWidth; lbSync(true); });
  const cl = $('#lbRoot [data-lb="close"]'); if(cl) cl.focus({preventScroll:true});
}
function lbLoad(i){
  document.querySelectorAll("#lbTrack img").forEach((im,k) => { if(Math.abs(k-i)<=2 && !im.getAttribute("src")) im.src = im.dataset.src; });
}
function lbSync(force){
  const tr = lbTrack(); if(!tr || !LB.open) return;
  const n = LB.list.length, i = Math.min(n-1, Math.max(0, Math.round(tr.scrollLeft / Math.max(1, tr.clientWidth))));
  if(i===LB.last && force!==true) return;
  LB.i = i; LB.last = i; lbLoad(i);
  const c = LB.list[i];
  $("#lbCount").textContent = `${i+1} / ${n}`;
  $("#lbCap").innerHTML = lbCaption(c);
  const lo = $('#lbRoot [data-lb="locate"]'); if(lo) lo.textContent = whereIs(c).act;
  const pv = $('#lbRoot [data-lb="prev"]'), nx = $('#lbRoot [data-lb="next"]');
  if(pv) pv.disabled = i<=0; if(nx) nx.disabled = i>=n-1;
  const strip = $("#lbStrip");
  if(strip){
    strip.querySelectorAll(".lb-th").forEach((b,k) => b.setAttribute("aria-current", k===i));
    const th = strip.children[i];
    if(th){ const l = th.offsetLeft - (strip.clientWidth - th.offsetWidth)/2; strip.scrollTo({left: Math.max(0,l), behavior: force===true ? "auto" : "smooth"}); }
  }
}
function lbGo(k){
  const tr = lbTrack(); if(!tr) return;
  k = Math.min(LB.list.length-1, Math.max(0, k)); lbLoad(k);
  const reduce = window.matchMedia && matchMedia("(prefers-reduced-motion: reduce)").matches;
  tr.scrollTo({left: k * tr.clientWidth, behavior: reduce ? "auto" : "smooth"});
}
function closeViewer(){
  if(!LB.open) return;
  LB.open = false; $("#lbRoot").innerHTML = ""; document.documentElement.style.overflow = "";
  const b = LB.back; LB.list = []; if(b && document.contains(b)) try{ b.focus({preventScroll:true}); }catch(_){}
}
$("#lbRoot").addEventListener("click", e => {
  const t = e.target; e.stopPropagation();
  const a = t.closest("[data-lb]");
  if(a){ const k = a.dataset.lb;
    if(k==="close") return closeViewer();
    if(k==="prev") return lbGo(LB.i-1);
    if(k==="next") return lbGo(LB.i+1);
    if(k==="locate"){ const id = LB.list[LB.i]?.id; closeViewer(); if(id) showCard(id); return; }
    if(k==="details"){ const id = LB.list[LB.i]?.id; closeViewer(); if(id && S.cards.some(c=>c.id===id)) openCard(id); return; }
  }
  const th = t.closest("[data-lbi]"); if(th) return lbGo(+th.dataset.lbi);
});
$("#lbRoot").addEventListener("contextmenu", e => { if(e.target.closest(".lb-slide img")) e.preventDefault(); });
window.addEventListener("resize", () => { if(!LB.open) return; const tr = lbTrack(); if(tr){ tr.style.scrollBehavior="auto"; tr.scrollLeft = LB.i * tr.clientWidth; } });

/* ---------- boot ---------- */
function pickDefaults(){
  if(S.mode!=="nodb" && !got.b) return;
  if(S.binderId!=="__loose" && S.binderId!=="__sales" && !binderById(S.binderId)){ const sb = sortedBinders(); S.binderId = (sb.find(b=>/^binder\s*1$/i.test((b.name||"").trim())) || sb[0])?.id || (looseCards().length?"__loose":null); }
}
let got = {b:false,c:false};
async function boot(){
  render();
  const [db, assets, downloads] = await Promise.all([
    window.claude?.use?.("db") ?? null, window.claude?.use?.("assets") ?? null, window.claude?.use?.("downloads") ?? null
  ].map(p => Promise.resolve(p).catch(()=>null)));
  S.db=db; S.assets=assets; S.downloads=downloads;
  window.ledgerApi?.call("GET","api/auth/me").then(r=>{ S.me=r; renderBanner(); }, ()=>{});
  if(!db){ S.mode="nodb"; pickDefaults(); render(); return; }
  const done = () => { if(got.b && got.c && S.mode==="loading"){ S.mode="ready"; } pickDefaults(); render(); };
  const onErr = e => { console.error(e); if(e?.code==="revoked"||e?.code==="not_granted"){ S.mode="nodb"; render(); } };
  db.collection("binders").onSnapshot(s => { S.binders = s.docs.map(d=>({id:d.id, ...d.data()})); got.b=true; done(); }, onErr);
  db.collection("cards").onSnapshot(s => { S.cards = s.docs.map(d=>({id:d.id, ...d.data()})); got.c=true; if(S.sel && S.sel!=="__new" && !S.cards.some(c=>c.id===S.sel)) { S.sel=null; } done(); if($("#chkCard")) renderChecks(); }, onErr);
  db.doc("settings/main").onSnapshot(s => { if(s.exists) S.settings = {...S.settings, ...s.data()}; if(S.mode==="ready") render(); }, onErr);
  db.doc("settings/details").onSnapshot(s => { S.detailsRun = s.exists ? s.data() : {}; const sd=$("#sDetails"); if(sd) sd.outerHTML = detailsSettingsHTML(); }, onErr);
  db.doc("settings/pricing").onSnapshot(s => { S.pricing = s.exists ? s.data() : {}; if(S.mode==="ready"){ renderStats(); const sp=$("#sPricing"); if(sp) sp.outerHTML = pricingSettingsHTML(); } }, onErr);
}
boot();
})();
