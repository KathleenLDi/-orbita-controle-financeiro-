/* ==========================================================
   Órbita · seu controle financeiro (versão nuvem)
   ----------------------------------------------------------
   Mesma lógica de meses, parcelas e render do app original.
   O que mudou:
     • localStorage → Firestore (espacos/{id}/expenses|cards|incomes)
     • toda mutação chama a nuvem e NÃO chama render():
       quem redesenha são os ouvintes em tempo real — é isso
       que sincroniza a tela de todos os membros do espaço.
     • login obrigatório + seletor de espaços + convites.
   ========================================================== */
'use strict';

import { exigirLogin, sair } from "./auth.js";
import * as nuvem from "./cloud-store.js";

/* =============== Estado =============== */
const KEY='orbita-financas-v1'; // usado só para migrar dados antigos deste navegador
const CATS=['Moradia','Mercado','Transporte','Saúde','Educação','Lazer','Assinaturas','Vestuário','Pets','Outros'];
const CAT_COLORS=['#7C8CFF','#3ADFA5','#FFC65C','#FF6B7A','#5AC8FA','#C792EA','#F78C6C','#82D8D8','#E5A9FF','#98A2C0'];
const CARD_COLORS=['#7C8CFF','#8A2BE2','#3ADFA5','#FF6B7A','#FFC65C','#5AC8FA','#FF9F43','#C0C7DD'];

let state={incomes:[],cards:[],expenses:[]}; // agora preenchido pela nuvem
let usuario=null;
let espacos=[];        // espaços dos quais sou membro
let convites=[];       // convites pendentes para mim
let espacoAtivo=null;  // id do espaço selecionado
let pararDados=[];     // canceladores dos ouvintes de dados
let prontos=0;         // quantas coleções já chegaram (3 = tudo pronto)
let migracaoOferecida=false;

const uid=()=>Date.now().toString(36)+Math.random().toString(36).slice(2,7);
const espacoAtual=()=>espacos.find(e=>e.id===espacoAtivo)||null;
const souDono=()=>espacoAtual()?.dono===usuario?.uid;

function falha(err){
  console.error(err);
  alert('Não foi possível salvar na nuvem. Verifique sua conexão e tente de novo.');
}

/* =============== Datas / meses =============== */
const pad=n=>String(n).padStart(2,'0');
const ymNow=()=>{const d=new Date();return d.getFullYear()+'-'+pad(d.getMonth()+1)};
function ymAdd(ym,n){const[y,m]=ym.split('-').map(Number);const t=y*12+(m-1)+n;return Math.floor(t/12)+'-'+pad(t%12+1)}
function ymDiff(a,b){const[ya,ma]=a.split('-').map(Number);const[yb,mb]=b.split('-').map(Number);return (ya*12+ma)-(yb*12+mb)}
function ymLabel(ym){const[y,m]=ym.split('-').map(Number);return new Date(y,m-1,1).toLocaleDateString('pt-BR',{month:'long',year:'numeric'})}
function ymShort(ym){const[y,m]=ym.split('-').map(Number);return new Date(y,m-1,1).toLocaleDateString('pt-BR',{month:'short'}).replace('.','')}
function dueDate(ym,day){const[y,m]=ym.split('-').map(Number);const last=new Date(y,m,0).getDate();return new Date(y,m-1,Math.min(day,last))}
let viewYM=ymNow();

/* =============== Regras de negócio =============== */
function occ(exp,ym){
  const d=ymDiff(ym,exp.inicio);
  if(d<0) return null;
  if(exp.tipo==='unico'){ if(d!==0) return null; return {valor:exp.valor}; }
  if(exp.tipo==='fixo'){ return {valor:exp.valor}; }
  if(d>=exp.parcelas) return null;
  return {valor:exp.valor/exp.parcelas, idx:d+1, total:exp.parcelas};
}
function expDueDay(exp){
  if(exp.metodo.startsWith('card:')){
    const c=state.cards.find(c=>c.id===exp.metodo.slice(5));
    if(c) return c.venc;
  }
  return exp.dia||1;
}
function monthExpenses(ym){
  const out=[];
  for(const e of state.expenses){
    const o=occ(e,ym);
    if(o) out.push({exp:e,...o,dia:expDueDay(e),pago:!!(e.pagas&&e.pagas[ym])});
  }
  out.sort((a,b)=>a.dia-b.dia);
  return out;
}
const monthIncomeTotal=()=>state.incomes.reduce((s,i)=>s+i.valor,0);
const monthExpenseTotal=ym=>monthExpenses(ym).reduce((s,o)=>s+o.valor,0);

function togglePaid(expId,ym){
  const e=state.expenses.find(x=>x.id===expId); if(!e) return;
  const pagas={...(e.pagas||{})};
  if(pagas[ym]) delete pagas[ym]; else pagas[ym]=true;
  nuvem.editar(espacoAtivo,'expenses',expId,{pagas}).catch(falha);
}
function cardName(metodo){
  if(!metodo.startsWith('card:')) return null;
  return state.cards.find(c=>c.id===metodo.slice(5))||null;
}
function metodoLabel(m){
  if(m==='pix')return'Pix'; if(m==='debito')return'Débito'; if(m==='dinheiro')return'Dinheiro';
  const c=cardName(m); return c?c.nome:'Cartão removido';
}

/* =============== Alertas de vencimento =============== */
function computeAlerts(){
  const today=new Date(); today.setHours(0,0,0,0);
  const list=[];
  for(const ym of [ymNow(), ymAdd(ymNow(),1)]){
    for(const o of monthExpenses(ym)){
      if(o.pago) continue;
      const dd=dueDate(ym,o.dia);
      const days=Math.round((dd-today)/86400000);
      if(days<=5 && days>=-15) list.push({...o,ym,dd,days});
    }
  }
  list.sort((a,b)=>a.dd-b.dd);
  return list;
}

/* =============== Formatação =============== */
const BRL=v=>v.toLocaleString('pt-BR',{style:'currency',currency:'BRL'});
const esc=s=>String(s).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));

/* =============== Navegação =============== */
let tab='dash';
document.querySelectorAll('nav button').forEach(b=>b.addEventListener('click',()=>{
  tab=b.dataset.tab;
  document.querySelectorAll('nav button').forEach(x=>x.classList.toggle('active',x===b));
  render();
}));
document.getElementById('prevM').onclick=()=>{viewYM=ymAdd(viewYM,-1);render()};
document.getElementById('nextM').onclick=()=>{viewYM=ymAdd(viewYM,1);render()};
document.getElementById('todayM').onclick=()=>{viewYM=ymNow();render()};

/* =============== Render =============== */
const view=document.getElementById('view');
function render(){
  document.getElementById('monthLabel').textContent=ymLabel(viewYM);
  if(!espacoAtivo){
    view.innerHTML='<div class="empty"><div class="big">◌</div>Preparando seu espaço…</div>';
    return;
  }
  if(tab==='dash') renderDash();
  else if(tab==='gastos') renderGastos();
  else if(tab==='cartoes') renderCartoes();
  else renderRendas();
}

function statsRibbon(){
  const inc=monthIncomeTotal();
  const occs=monthExpenses(viewYM);
  const exp=occs.reduce((s,o)=>s+o.valor,0);
  const saldo=inc-exp;
  const pagos=occs.filter(o=>o.pago).length;
  const tot=inc+exp;
  const pIn=tot?inc/tot*100:50, pOut=tot?exp/tot*100:50;
  const pct=inc?Math.round(exp/inc*100):0;
  return `
  <div class="ribbon">
    <div class="stats">
      <div class="stat"><div class="k">Entradas</div><div class="v income">${BRL(inc)}</div></div>
      <div class="stat"><div class="k">Gastos</div><div class="v expense">${BRL(exp)}</div></div>
      <div class="stat"><div class="k">Saldo do mês</div><div class="v" style="color:${saldo>=0?'var(--income)':'var(--expense)'}">${BRL(saldo)}</div></div>
      <div class="stat"><div class="k">Contas pagas</div><div class="v">${pagos}<span style="color:var(--muted);font-size:14px">/${occs.length}</span></div></div>
<div class="stat"><div class="k">Renda comprometida</div><div class="v" style="color:${pct>100?'var(--expense)':pct>70?'var(--warn)':'var(--text)'}">${pct}%</div></div>
    </div>
    <div class="flow-bar" role="img" aria-label="Proporção entre entradas e gastos">
      <div class="in" style="width:${pIn}%"></div><div class="out" style="width:${pOut}%"></div>
    </div>
    <div class="flow-legend">
      <span><i class="dot" style="background:var(--income)"></i>Entradas</span>
      <span><i class="dot" style="background:var(--expense)"></i>Gastos</span>
    </div>
  </div>`;
}

function alertsHTML(){
  const al=computeAlerts();
  if(!al.length) return '';
  return `<div class="alerts">${al.map(a=>{
    const when=a.days<0?`venceu há ${-a.days} dia${a.days<-1?'s':''}`:a.days===0?'vence hoje':`vence em ${a.days} dia${a.days>1?'s':''}`;
    const parc=a.idx?` · parcela ${a.idx}/${a.total}`:'';
    return `<div class="alert ${a.days<0?'overdue':''}">
      <span>${a.days<0?'⚠':'⏰'}</span>
      <span><b>${esc(a.exp.desc)}</b>${parc} — ${when} (dia ${pad(a.dia)}/${a.ym.split('-')[1]})</span>
      <span class="amount">${BRL(a.valor)}</span>
    </div>`;
  }).join('')}</div>`;
}

function renderDash(){
  const occs=monthExpenses(viewYM);
  const byCat={};
  occs.forEach(o=>{byCat[o.exp.categoria]=(byCat[o.exp.categoria]||0)+o.valor});
  const entries=Object.entries(byCat).sort((a,b)=>b[1]-a[1]);
  const totalExp=entries.reduce((s,e)=>s+e[1],0);
  let donut='<div class="empty"><div class="big">◔</div>Nenhum gasto neste mês ainda.</div>';
  if(entries.length){
    let acc=0; const stops=[];
    const legend=entries.map(([cat,val],i)=>{
      const color=CAT_COLORS[CATS.indexOf(cat)%CAT_COLORS.length]||CAT_COLORS[i%CAT_COLORS.length];
      const from=acc/totalExp*360; acc+=val; const to=acc/totalExp*360;
      stops.push(`${color} ${from}deg ${to}deg`);
      return `<div class="row"><i class="dot" style="background:${color}"></i><span class="name">${esc(cat)}</span><span class="val">${BRL(val)} · ${Math.round(val/totalExp*100)}%</span></div>`;
    }).join('');
    donut=`<div class="donut-wrap">
      <div class="donut" style="background:conic-gradient(${stops.join(',')})">
        <div class="center"><div><b>${BRL(totalExp)}</b><span>no mês</span></div></div>
      </div>
      <div class="legend">${legend}</div>
    </div>`;
  }
  const months=[]; for(let i=5;i>=0;i--) months.push(ymAdd(viewYM,-i));
  const inc=monthIncomeTotal();
  const data=months.map(m=>({m,inc,exp:monthExpenseTotal(m)}));
  const max=Math.max(1,...data.map(d=>Math.max(d.inc,d.exp)));
  const bars=data.map(d=>`
    <div class="bar-col">
      <div class="bar-pair">
        <div class="bar in" style="height:${d.inc/max*100}%" title="Entradas ${ymShort(d.m)}: ${BRL(d.inc)}"></div>
        <div class="bar out" style="height:${d.exp/max*100}%" title="Gastos ${ymShort(d.m)}: ${BRL(d.exp)}"></div>
      </div>
      <div class="m">${ymShort(d.m)}${d.m===viewYM?' •':''}</div>
    </div>`).join('');

  const next=occs.filter(o=>!o.pago).slice(0,6);
  const nextHTML=next.length?`<div class="list">${next.map(o=>rowHTML(o,false)).join('')}</div>`
    :'<div class="empty">Tudo pago neste mês ✓</div>';

  view.innerHTML=`
    ${alertsHTML()}
    ${statsRibbon()}
    <div class="grid cols-2">
      <div class="panel"><h2>Gastos por categoria</h2>${donut}</div>
      <div class="panel"><h2>Últimos 6 meses</h2><div class="bars">${bars}</div>
        <div class="flow-legend" style="margin-top:10px">
          <span><i class="dot" style="background:var(--income)"></i>Entradas</span>
          <span><i class="dot" style="background:var(--expense)"></i>Gastos</span>
        </div>
      </div>
    </div>
    <div class="panel"><h2>A pagar em ${ymLabel(viewYM)}</h2>${nextHTML}</div>`;
  bindRows();
}

function rowHTML(o,withActions=true){
  const c=cardName(o.exp.metodo);
  const catColor=CAT_COLORS[CATS.indexOf(o.exp.categoria)%CAT_COLORS.length]||'#98A2C0';
  return `<div class="item ${o.pago?'paid':''}">
    <button class="pay-check ${o.pago?'on':''}" data-pay="${o.exp.id}" title="${o.pago?'Desmarcar pagamento':'Marcar como pago'}" aria-label="Marcar como pago">✓</button>
    <div class="main">
      <div class="title">${esc(o.exp.desc)}
        ${o.idx?`<span class="chip parcela">${o.idx}/${o.total}</span>`:''}
        ${o.exp.tipo==='fixo'?'<span class="chip fixo">fixo</span>':''}
      </div>
      <div class="meta">
        <span class="chip"><i class="cdot" style="background:${catColor}"></i>${esc(o.exp.categoria)}</span>
        <span class="chip">${c?`<i class="cdot" style="background:${c.cor}"></i>`:''}${esc(metodoLabel(o.exp.metodo))}</span>
        <span>vence dia ${pad(o.dia)}</span>
      </div>
    </div>
    <div class="value">${BRL(o.valor)}</div>
    ${withActions?`<div class="actions">
      <button class="icon-btn" data-edit="${o.exp.id}" title="Editar">✎</button>
      <button class="icon-btn" data-del="${o.exp.id}" title="Excluir">🗑</button>
    </div>`:''}
  </div>`;
}
function bindRows(){
  view.querySelectorAll('[data-pay]').forEach(b=>b.onclick=()=>togglePaid(b.dataset.pay,viewYM));
  view.querySelectorAll('[data-edit]').forEach(b=>b.onclick=()=>openExpense(b.dataset.edit));
  view.querySelectorAll('[data-del]').forEach(b=>b.onclick=()=>{
    const e=state.expenses.find(x=>x.id===b.dataset.del);
    if(e&&confirm(`Excluir "${e.desc}" (todas as ocorrências)?`)){
      nuvem.excluir(espacoAtivo,'expenses',e.id).catch(falha);
    }
  });
}

function renderGastos(){
  const occs=monthExpenses(viewYM);
  const total=occs.reduce((s,o)=>s+o.valor,0);
  const pagos=occs.filter(o=>o.pago).reduce((s,o)=>s+o.valor,0);
  view.innerHTML=`
    ${alertsHTML()}
    <div class="panel">
      <div class="sec-head">
        <h2>Gastos de ${ymLabel(viewYM)}</h2>
        <div style="display:flex;gap:12px;align-items:center;flex-wrap:wrap">
          <span class="total-line">Total <b>${BRL(total)}</b> · pago <b style="color:var(--income)">${BRL(pagos)}</b></span>
          <button class="btn primary small" id="addExp">+ Novo gasto</button>
        </div>
      </div>
      ${occs.length?`<div class="list">${occs.map(o=>rowHTML(o)).join('')}</div>`
        :'<div class="empty"><div class="big">◎</div>Nenhum gasto neste mês.<br>Adicione o primeiro no botão acima.</div>'}
    </div>`;
  document.getElementById('addExp').onclick=()=>openExpense();
  bindRows();
}

function renderCartoes(){
  const html=state.cards.map(c=>{
    const occs=monthExpenses(viewYM).filter(o=>o.exp.metodo==='card:'+c.id);
    const fatura=occs.reduce((s,o)=>s+o.valor,0);
    const pagas=occs.filter(o=>o.pago).length;
    const allPaid=occs.length>0&&pagas===occs.length;
    const parcAtivas=state.expenses.filter(e=>e.metodo==='card:'+c.id&&e.tipo==='parcelado'&&occ(e,viewYM)).length;
    const limitHTML=c.limite?`<div class="limit-bar"><i style="width:${Math.min(100,fatura/c.limite*100)}%"></i></div>
      <div class="sub" style="margin-top:5px">${Math.round(fatura/c.limite*100)}% do limite de ${BRL(c.limite)}</div>`:'';
    return `<div class="ccard" style="--cc:${c.cor}">
      <div class="top">
        <i class="cdot"></i><span class="name">${esc(c.nome)}</span>
        <span class="actions">
          <button class="icon-btn" data-cedit="${c.id}" title="Editar">✎</button>
          <button class="icon-btn" data-cdel="${c.id}" title="Excluir">🗑</button>
        </span>
      </div>
      <div class="fatura">${BRL(fatura)}</div>
      <div class="sub">fatura de ${ymShort(viewYM)} · ${occs.length} lançamento${occs.length!==1?'s':''} · ${parcAtivas} parcelamento${parcAtivas!==1?'s':''}</div>
      ${limitHTML}
      <div class="foot">
        <span class="venc-chip">vencimento dia <b>${pad(c.venc)}</b></span>
        ${occs.length?`<button class="btn small ${allPaid?'':'primary'}" data-cpay="${c.id}">${allPaid?'✓ Fatura paga':'Marcar fatura paga'}</button>`:''}
      </div>
    </div>`;
  }).join('');
  view.innerHTML=`
    <div class="panel">
      <div class="sec-head">
        <h2>Cartões de crédito</h2>
        <button class="btn primary small" id="addCard">+ Novo cartão</button>
      </div>
      ${state.cards.length?`<div class="cards-grid">${html}</div>`
        :'<div class="empty"><div class="big">▭</div>Nenhum cartão cadastrado.</div>'}
    </div>`;
  document.getElementById('addCard').onclick=()=>openCard();
  view.querySelectorAll('[data-cedit]').forEach(b=>b.onclick=()=>openCard(b.dataset.cedit));
  view.querySelectorAll('[data-cdel]').forEach(b=>b.onclick=()=>{
    const c=state.cards.find(x=>x.id===b.dataset.cdel);
    if(c&&confirm(`Excluir o cartão "${c.nome}"? Os gastos dele continuam na lista.`)){
      nuvem.excluir(espacoAtivo,'cards',c.id).catch(falha);
    }
  });
  view.querySelectorAll('[data-cpay]').forEach(b=>b.onclick=()=>{
    const id='card:'+b.dataset.cpay;
    const occs=monthExpenses(viewYM).filter(o=>o.exp.metodo===id);
    const allPaid=occs.every(o=>o.pago);
    const itens=occs.map(o=>{
      const pagas={...(o.exp.pagas||{})};
      if(allPaid) delete pagas[viewYM]; else pagas[viewYM]=true;
      return {id:o.exp.id,dados:{pagas}};
    });
    nuvem.editarLote(espacoAtivo,'expenses',itens).catch(falha);
  });
}

function renderRendas(){
  const total=monthIncomeTotal();
  const html=state.incomes.map(i=>`
    <div class="item">
      <div class="main">
        <div class="title">${esc(i.nome)} <span class="chip">${esc(i.pessoa)}</span></div>
        <div class="meta"><span>recebe dia ${pad(i.dia)}</span></div>
      </div>
      <div class="value income">${BRL(i.valor)}</div>
      <div class="actions">
        <button class="icon-btn" data-iedit="${i.id}" title="Editar">✎</button>
        <button class="icon-btn" data-idel="${i.id}" title="Excluir">🗑</button>
      </div>
    </div>`).join('');
  view.innerHTML=`
    <div class="panel">
      <div class="sec-head">
        <h2>Rendas mensais</h2>
        <div style="display:flex;gap:12px;align-items:center;flex-wrap:wrap">
          <span class="total-line">Total <b style="color:var(--income)">${BRL(total)}</b>/mês</span>
          <button class="btn primary small" id="addInc">+ Nova renda</button>
        </div>
      </div>
      ${state.incomes.length?`<div class="list">${html}</div>`
        :'<div class="empty"><div class="big">◈</div>Cadastre suas rendas para começar.</div>'}
    </div>`;
  document.getElementById('addInc').onclick=()=>openIncome();
  view.querySelectorAll('[data-iedit]').forEach(b=>b.onclick=()=>openIncome(b.dataset.iedit));
  view.querySelectorAll('[data-idel]').forEach(b=>b.onclick=()=>{
    const i=state.incomes.find(x=>x.id===b.dataset.idel);
    if(i&&confirm(`Excluir a renda "${i.nome}"?`)){
      nuvem.excluir(espacoAtivo,'incomes',i.id).catch(falha);
    }
  });
}

/* =============== Modal: gasto =============== */
const dlgE=document.getElementById('dlgExpense');
let editingExp=null;
const eCat=document.getElementById('eCat');
eCat.innerHTML=CATS.map(c=>`<option>${c}</option>`).join('');
const eTipo=document.getElementById('eTipo');
eTipo.onchange=()=>{document.getElementById('fParcelas').hidden=eTipo.value!=='parcelado'};
function fillMetodos(sel){
  const s=document.getElementById('eMetodo');
  s.innerHTML=state.cards.map(c=>`<option value="card:${c.id}">💳 ${esc(c.nome)}</option>`).join('')+
    `<option value="pix">Pix</option><option value="debito">Débito</option><option value="dinheiro">Dinheiro</option>`;
  if(sel) s.value=sel;
  toggleDia();
}
function toggleDia(){
  document.getElementById('fDia').hidden=document.getElementById('eMetodo').value.startsWith('card:');
}
document.getElementById('eMetodo').addEventListener('change',toggleDia);
function openExpense(id){
  editingExp=id?state.expenses.find(x=>x.id===id):null;
  document.getElementById('expTitle').textContent=editingExp?'Editar gasto':'Novo gasto';
  document.getElementById('eDesc').value=editingExp?editingExp.desc:'';
  document.getElementById('eValor').value=editingExp?editingExp.valor:'';
  eCat.value=editingExp?editingExp.categoria:CATS[1];
  eTipo.value=editingExp?editingExp.tipo:'unico';
  document.getElementById('fParcelas').hidden=eTipo.value!=='parcelado';
  document.getElementById('eParcelas').value=editingExp&&editingExp.parcelas?editingExp.parcelas:12;
  document.getElementById('eMes').value=editingExp?editingExp.inicio:viewYM;
  document.getElementById('eDia').value=editingExp&&editingExp.dia?editingExp.dia:10;
  fillMetodos(editingExp?editingExp.metodo:undefined);
  dlgE.showModal();
}
document.getElementById('formExpense').addEventListener('submit',()=>{
  const data={
    desc:document.getElementById('eDesc').value.trim(),
    valor:parseFloat(document.getElementById('eValor').value),
    categoria:eCat.value,
    tipo:eTipo.value,
    parcelas:eTipo.value==='parcelado'?Math.max(2,parseInt(document.getElementById('eParcelas').value)||2):null,
    metodo:document.getElementById('eMetodo').value||'pix',
    inicio:document.getElementById('eMes').value||ymNow(),
    dia:Math.min(31,Math.max(1,parseInt(document.getElementById('eDia').value)||1)),
  };
  if(!data.desc||!(data.valor>0)) return;
  if(editingExp) nuvem.editar(espacoAtivo,'expenses',editingExp.id,data).catch(falha);
  else nuvem.salvarComId(espacoAtivo,'expenses',uid(),{pagas:{},...data}).catch(falha);
});

/* =============== Modal: cartão =============== */
const dlgC=document.getElementById('dlgCard');
let editingCard=null, selColor=CARD_COLORS[0];
const cColors=document.getElementById('cColors');
cColors.innerHTML=CARD_COLORS.map(c=>`<button type="button" data-c="${c}" style="background:${c}" aria-label="Cor ${c}"></button>`).join('');
cColors.querySelectorAll('button').forEach(b=>b.onclick=()=>{
  selColor=b.dataset.c;
  cColors.querySelectorAll('button').forEach(x=>x.classList.toggle('sel',x===b));
});
function openCard(id){
  editingCard=id?state.cards.find(x=>x.id===id):null;
  document.getElementById('cardTitle').textContent=editingCard?'Editar cartão':'Novo cartão';
  document.getElementById('cNome').value=editingCard?editingCard.nome:'';
  document.getElementById('cVenc').value=editingCard?editingCard.venc:10;
  document.getElementById('cLimite').value=editingCard&&editingCard.limite?editingCard.limite:'';
  selColor=editingCard?editingCard.cor:CARD_COLORS[0];
  cColors.querySelectorAll('button').forEach(x=>x.classList.toggle('sel',x.dataset.c===selColor));
  dlgC.showModal();
}
document.getElementById('formCard').addEventListener('submit',()=>{
  const data={
    nome:document.getElementById('cNome').value.trim(),
    venc:Math.min(31,Math.max(1,parseInt(document.getElementById('cVenc').value)||10)),
    limite:parseFloat(document.getElementById('cLimite').value)||0,
    cor:selColor,
  };
  if(!data.nome) return;
  if(editingCard) nuvem.editar(espacoAtivo,'cards',editingCard.id,data).catch(falha);
  else nuvem.salvarComId(espacoAtivo,'cards',uid(),data).catch(falha);
});

/* =============== Modal: renda =============== */
const dlgI=document.getElementById('dlgIncome');
let editingInc=null;
function openIncome(id){
  editingInc=id?state.incomes.find(x=>x.id===id):null;
  document.getElementById('incTitle').textContent=editingInc?'Editar renda':'Nova renda';
  document.getElementById('iNome').value=editingInc?editingInc.nome:'Salário';
  document.getElementById('iPessoa').value=editingInc?editingInc.pessoa:'';
  document.getElementById('iDia').value=editingInc?editingInc.dia:5;
  document.getElementById('iValor').value=editingInc?editingInc.valor:'';
  dlgI.showModal();
}
document.getElementById('formIncome').addEventListener('submit',()=>{
  const data={
    nome:document.getElementById('iNome').value.trim(),
    pessoa:document.getElementById('iPessoa').value.trim()||'—',
    dia:Math.min(31,Math.max(1,parseInt(document.getElementById('iDia').value)||1)),
    valor:parseFloat(document.getElementById('iValor').value),
  };
  if(!data.nome||!(data.valor>0)) return;
  if(editingInc) nuvem.editar(espacoAtivo,'incomes',editingInc.id,data).catch(falha);
  else nuvem.salvarComId(espacoAtivo,'incomes',uid(),data).catch(falha);
});

/* fechar modais no cancelar */
document.querySelectorAll('dialog [data-close]').forEach(b=>b.onclick=()=>b.closest('dialog').close());

/* =============== Notificações =============== */
const btnNotif=document.getElementById('btnNotif');
function updateNotifBtn(){
  if(!('Notification' in window)){ btnNotif.hidden=true; return; }
  btnNotif.textContent=Notification.permission==='granted'?'🔔 Lembretes ativos':'🔔 Lembretes';
}
btnNotif.onclick=async()=>{
  if(!('Notification' in window)) return;
  if(Notification.permission==='granted'){ notifyDue(true); return; }
  const p=await Notification.requestPermission();
  updateNotifBtn();
  if(p==='granted') notifyDue(true);
};
function notifyDue(force){
  if(!('Notification' in window)||Notification.permission!=='granted') return;
  const todayKey=new Date().toDateString();
  if(!force&&localStorage.getItem('orbita-notified')===todayKey) return;
  const al=computeAlerts();
  if(al.length){
    const first=al[0];
    const more=al.length>1?` e mais ${al.length-1} conta${al.length>2?'s':''}`:'';
    new Notification('Órbita · vencimentos próximos',{
      body:`${first.exp.desc} (${BRL(first.valor)}) ${first.days<0?'está atrasada':first.days===0?'vence hoje':'vence em '+first.days+' dia'+(first.days>1?'s':'')}${more}.`,
    });
  } else if(force){
    new Notification('Órbita',{body:'Nenhum vencimento nos próximos dias. Tudo em dia ✓'});
  }
  localStorage.setItem('orbita-notified',todayKey);
}

/* ==========================================================
   NUVEM · espaços, convites e sincronização em tempo real
   ========================================================== */

/* ---------- Seletor de espaços ---------- */
const spaceSelect=document.getElementById('spaceSelect');
function renderEspacoBar(){
  const ordenados=[...espacos].sort((a,b)=>
    (a.tipo==='pessoal'?0:1)-(b.tipo==='pessoal'?0:1)||
    (a.criadoEm?.seconds||0)-(b.criadoEm?.seconds||0));
  spaceSelect.innerHTML=ordenados.map(e=>
    `<option value="${e.id}" ${e.id===espacoAtivo?'selected':''}>${e.tipo==='pessoal'?'🔒':'👥'} ${esc(e.nome)}</option>`
  ).join('');
}
spaceSelect.addEventListener('change',()=>selecionarEspaco(spaceSelect.value));

function selecionarEspaco(id){
  if(id===espacoAtivo) return;
  pararDados.forEach(p=>p()); pararDados=[];
  espacoAtivo=id; prontos=0; migracaoOferecida=false;
  state={incomes:[],cards:[],expenses:[]};
  localStorage.setItem('orbita-espaco',id);
  render();
  ligarOuvintes(id,0);
}
function ligarOuvintes(id,tentativa){
  if(id!==espacoAtivo) return; // trocou de espaço no meio do caminho
  pararDados.forEach(p=>p()); pararDados=[];
  const chegou={};
  const aoChegar=(nome)=>(lista)=>{
    const primeira=!chegou[nome];
    chegou[nome]=true;
    state[nome]=lista;
    if(primeira) prontos++;
    limparErroNuvem(nome);
    render();
    if(prontos===3) oferecerMigracao();
  };
  let retryMarcado=false;
  const aoErrar=(nome)=>(err)=>{
    // Corrida do primeiro acesso: o espaço acabou de ser criado e o
    // servidor ainda não confirmou. Tenta de novo em vez de desistir.
    if(err&&err.code==='permission-denied'&&tentativa<4){
      if(!retryMarcado){ retryMarcado=true; setTimeout(()=>ligarOuvintes(id,tentativa+1),1000+600*tentativa); }
      return;
    }
    mostrarErroNuvem(nome,err);
  };
  pararDados.push(
    nuvem.ouvir(id,'expenses',aoChegar('expenses'),aoErrar('gastos')),
    nuvem.ouvir(id,'cards',aoChegar('cards'),aoErrar('cartões')),
    nuvem.ouvir(id,'incomes',aoChegar('incomes'),aoErrar('rendas')),
  );
}

/* ---------- Migração dos dados antigos deste navegador ---------- */
function oferecerMigracao(){
  if(migracaoOferecida) return;
  migracaoOferecida=true;
  const esp=espacoAtual();
  if(!esp||esp.tipo!=='pessoal') return;
  const vazio=!state.expenses.length&&!state.cards.length&&!state.incomes.length;
  if(!vazio) return;
  let antigo=null;
  try{ antigo=JSON.parse(localStorage.getItem(KEY)||localStorage.getItem('fluxo-financas-v1')||'null'); }catch{}
  if(!antigo) return;
  const n=(antigo.expenses?.length||0)+(antigo.cards?.length||0)+(antigo.incomes?.length||0);
  if(!n) return;
  if(confirm(`Encontrei ${n} registro${n>1?'s':''} salvos neste navegador (da versão antiga do Órbita). Quer enviá-los para a nuvem, no seu espaço pessoal?`)){
    nuvem.substituirTudo(espacoAtivo,antigo)
      .then(()=>alert('Prontinho! Seus dados agora estão na nuvem e disponíveis em qualquer dispositivo.'))
      .catch(falha);
  }
}

/* ---------- Avisos da nuvem: convites e erros ---------- */
const cloudMsgs=document.getElementById('cloudMsgs');
let errosNuvem={};
function mostrarErroNuvem(origem,err){
  console.error('[nuvem]',origem,err);
  let dica='Verifique sua conexão.';
  if(err&&err.code==='permission-denied')
    dica='Confira se as regras do Firestore foram publicadas (aba Regras no console do Firebase).';
  else if(err&&err.code==='failed-precondition')
    dica='Abra o console do navegador (F12): deve haver um link "create index" para clicar.';
  else if(err&&err.code==='unavailable')
    dica='Sem conexão com o servidor. Assim que a internet voltar, sincroniza sozinho.';
  errosNuvem[origem]=`Não consegui sincronizar ${origem} (${err&&err.code?err.code:'erro'}). ${dica}`;
  renderMsgs();
}
function limparErroNuvem(origem){
  const chave={expenses:'gastos',cards:'cartões',incomes:'rendas'}[origem]||origem;
  if(errosNuvem[chave]){ delete errosNuvem[chave]; renderMsgs(); }
}
function renderMsgs(){
  const erros=Object.values(errosNuvem).map(msg=>`
    <div class="alert erro-nuvem">
      <span>⚠</span><span>${esc(msg)}</span>
      <span class="acts"><button type="button" class="btn small" onclick="location.reload()">Recarregar</button></span>
    </div>`).join('');
  const conv=convites.map(c=>`
    <div class="alert convite">
      <span>💌</span>
      <span>Você foi convidado(a) para o espaço <b>${esc(c.nome)}</b>.</span>
      <span class="acts">
        <button type="button" class="btn small primary" data-aceitar="${c.id}">Aceitar</button>
        <button type="button" class="btn small ghost" data-recusar="${c.id}">Recusar</button>
      </span>
    </div>`).join('');
  cloudMsgs.innerHTML=erros+conv;
  cloudMsgs.querySelectorAll('[data-aceitar]').forEach(b=>b.onclick=async()=>{
    try{
      await nuvem.aceitarConvite(b.dataset.aceitar);
      selecionarEspaco(b.dataset.aceitar);
    }catch(err){ falha(err); }
  });
  cloudMsgs.querySelectorAll('[data-recusar]').forEach(b=>b.onclick=()=>{
    nuvem.recusarConvite(b.dataset.recusar).catch(falha);
  });
}
function renderConvites(){ renderMsgs(); }

/* ---------- Modal de espaços ---------- */
const dlgS=document.getElementById('dlgSpace');
document.getElementById('btnSpaces').onclick=()=>{renderDlgSpace();dlgS.showModal();};
document.getElementById('btnCreateSpace').onclick=async()=>{
  const nome=document.getElementById('sNome').value.trim();
  if(!nome) return;
  document.getElementById('sNome').value='';
  try{
    const id=await nuvem.criarEspacoCompartilhado(nome);
    selecionarEspaco(id);
    dlgS.close();
  }catch(err){ falha(err); }
};
function renderDlgSpace(){
  document.getElementById('whoami').textContent=
    usuario?`Conectado como ${usuario.displayName||''} · ${usuario.email}`:'';
  const esp=espacoAtual();
  const box=document.getElementById('spaceInfo');
  if(!esp){ box.innerHTML='<div class="hint">Carregando…</div>'; return; }
  const compart=esp.tipo==='compartilhado';
  box.innerHTML=`
    <div class="space-row">
      <span class="chip">${esp.tipo==='pessoal'?'🔒 pessoal':'👥 compartilhado'}</span>
      <b>${esc(esp.nome)}</b>
      <span class="chip">${esp.membros.length} membro${esp.membros.length>1?'s':''}</span>
      ${esp.convites?.length?`<span class="chip">✉ ${esp.convites.length} convite${esp.convites.length>1?'s':''} pendente${esp.convites.length>1?'s':''}</span>`:''}
    </div>
    ${compart&&souDono()?`
      <div class="field" style="margin-top:12px">
        <label for="inviteEmail">Convidar pelo e-mail (a pessoa precisa ter conta no Órbita)</label>
        <div class="invite-row">
          <input id="inviteEmail" type="email" placeholder="email@exemplo.com">
          <button type="button" class="btn primary small" id="btnInvite">Convidar</button>
        </div>
      </div>`:''}
    ${compart&&souDono()?`<button type="button" class="btn small danger" id="btnDelSpace" style="margin-top:8px">Excluir este espaço</button>`:''}
    ${compart&&!souDono()?`<button type="button" class="btn small danger" id="btnLeaveSpace" style="margin-top:8px">Sair deste espaço</button>`:''}
    ${!compart?'<div class="hint" style="margin-top:8px">Seu espaço pessoal é só seu. Para dividir as finanças com alguém, crie um espaço compartilhado abaixo.</div>':''}
  `;
  const btnInvite=document.getElementById('btnInvite');
  if(btnInvite) btnInvite.onclick=async()=>{
    const email=document.getElementById('inviteEmail').value.trim();
    if(!email) return;
    try{
      await nuvem.convidarPorEmail(espacoAtivo,email);
      alert(`Convite enviado! Assim que ${email} entrar no Órbita, verá o convite para aceitar.`);
      renderDlgSpace();
    }catch(err){ falha(err); }
  };
  const btnDel=document.getElementById('btnDelSpace');
  if(btnDel) btnDel.onclick=async()=>{
    if(confirm(`Excluir o espaço "${esp.nome}" e TODOS os dados dele, para todos os membros? Não dá para desfazer.`)){
      try{
        await nuvem.excluirEspaco(espacoAtivo);
        dlgS.close();
        espacoAtivo=null; // o ouvinte de espaços seleciona o pessoal
      }catch(err){ falha(err); }
    }
  };
  const btnLeave=document.getElementById('btnLeaveSpace');
  if(btnLeave) btnLeave.onclick=async()=>{
    if(confirm(`Sair do espaço "${esp.nome}"? Você deixará de ver os dados dele.`)){
      try{
        await nuvem.sairDoEspaco(espacoAtivo);
        dlgS.close();
        espacoAtivo=null;
      }catch(err){ falha(err); }
    }
  };
}
/* ---------- Boot: login → espaços → dados ---------- */
updateNotifBtn();
render(); // "Carregando seus espaços…" até a lista chegar

exigirLogin((user)=>{
  usuario=user;
  document.getElementById('btnSair').onclick=()=>{
    if(confirm('Sair da sua conta?')) sair();
  };

  let criandoEspacoPessoal=false;
  nuvem.ouvirMeusEspacos(async(lista)=>{
    limparErroNuvem('sua lista de espaços');
    espacos=lista;

    // Autocura: conta sem nenhum espaço (ex.: criada fora do site
    // ou cujo único espaço foi excluído) → cria o espaço pessoal.
    if(!lista.length){
      renderEspacoBar();
      render();
      if(!criandoEspacoPessoal){
        criandoEspacoPessoal=true;
        try{ await nuvem.criarEspacoPessoal(); }
        catch(err){ mostrarErroNuvem('a criação do seu espaço',err); }
      }
      return;
    }
    criandoEspacoPessoal=false;

    if(espacoAtivo&&!lista.find(e=>e.id===espacoAtivo)){
      espacoAtivo=null; // fui removido ou o espaço foi excluído
      pararDados.forEach(p=>p()); pararDados=[];
    }
    if(!espacoAtivo&&lista.length){
      const salvo=localStorage.getItem('orbita-espaco');
      const alvo=lista.find(e=>e.id===salvo)||lista.find(e=>e.tipo==='pessoal')||lista[0];
      selecionarEspaco(alvo.id);
    }
    renderEspacoBar();
    if(dlgS.open) renderDlgSpace();
  },(err)=>mostrarErroNuvem('sua lista de espaços',err));

  nuvem.ouvirMeusConvites((lista)=>{
    convites=lista;
    renderMsgs();
  },(err)=>console.warn('[nuvem] convites:',err));

  notifyDue(false);
  nuvem.tourJaVisto().then(v=>{ if(!v) setTimeout(iniciarTour,900); });
});
/* =============== Tour de boas-vindas =============== */
const TOUR_PASSOS=[
 {alvo:null,titulo:'Bem-vinda ao Órbita! 🪐',titulo2:'Bem-vindo(a) ao Órbita! 🪐',texto:'Seu controle financeiro na nuvem. Vou te mostrar rapidinho como tudo funciona.'},
 {alvo:'nav',titulo:'As quatro áreas',texto:'Dashboard é o resumo do mês. Em Gastos você lança contas e marca as pagas. Cartões mostra a fatura de cada cartão, mês a mês. Rendas guarda salários e outras entradas.'},
 {alvo:'.month-nav',titulo:'Navegue pelos meses',texto:'Use as setas para ver meses passados ou futuros. arcelas e gastos fixos já aparecem nos meses certos, com contador (ex.: 3/12). O botão "hoje" volta ao mês atual.'},
 {alvo:'#btnNotif',titulo:'Lembretes de vencimento',texto:'Ative para receber avisos do navegador quando uma conta estiver perto de vencer ou atrasada.'},
 {alvo:'#spaceSelect',titulo:'Seus espaços',texto:'O espaço 🔒 pessoal é só seu — ninguém mais vê. Você também pode participar de espaços 👥 compartilhados e alternar entre eles aqui.'},
 {alvo:'#btnSpaces',titulo:'Compartilhe com alguém',texto:'Aqui você cria um espaço compartilhado e convida outra pessoa pelo e-mail. Tudo que um lançar aparece na tela do outro na hora, em tempo real.'},
 {alvo:null,titulo:'Prontinho! ✨',texto:'Dica para começar: cadastre suas Rendas, depois os Cartões, e então lance os Gastos. Bom controle!'}
];
let tourIdx=0,tourEls=null;
function iniciarTour(){ if(tourEls) return; tourIdx=0;
  const block=document.createElement('div'); block.className='tour-block';
  const spot=document.createElement('div'); spot.className='tour-spot';
  const card=document.createElement('div'); card.className='tour-card';
  document.body.append(block,spot,card);
  tourEls={block,spot,card};
  mostrarPasso();
}
function mostrarPasso(){
  const p=TOUR_PASSOS[tourIdx], {card,spot}=tourEls;
  const alvo=p.alvo?document.querySelector(p.alvo):null;
  if(alvo){
    alvo.scrollIntoView({block:'nearest'});
    const r=alvo.getBoundingClientRect(), pad=6;
    spot.classList.remove('cheio');
    spot.style.left=(r.left-pad)+'px';
    spot.style.top=(r.top-pad)+'px';
    spot.style.width=(r.width+pad*2)+'px';
    spot.style.height=(r.height+pad*2)+'px';
  }else{
    spot.classList.add('cheio');
    spot.style.left='50%';spot.style.top='50%';spot.style.width='0';spot.style.height='0';
  }
  const ultimo=tourIdx===TOUR_PASSOS.length-1;
  card.innerHTML=`
    <div class="t-titulo">${p.titulo}</div>
    <div class="t-texto">${p.texto}</div>
    <div class="t-dots">${TOUR_PASSOS.map((_,i)=>`<i class="${i===tourIdx?'on':''}"></i>`).join('')}</div>
    <div class="t-acoes">
      <button type="button" class="btn ghost small" id="tPular">Pular</button>
      <span style="flex:1"></span>
      ${tourIdx>0?'<button type="button" class="btn small" id="tVoltar">Anterior</button>':''}
      <button type="button" class="btn primary small" id="tProx">${ultimo?'Começar a usar':'Próximo'}</button>
    </div>`;
  posicionarCard(alvo);
  card.querySelector('#tPular').onclick=encerrarTour;
  const v=card.querySelector('#tVoltar'); if(v) v.onclick=()=>{tourIdx--;mostrarPasso();};
  card.querySelector('#tProx').onclick=()=>{ ultimo?encerrarTour():(tourIdx++,mostrarPasso()); };
}
function posicionarCard(alvo){
  const {card}=tourEls;
  card.style.cssText='';
  if(!alvo){ card.style.left='50%';card.style.top='50%';card.style.transform='translate(-50%,-50%)'; return; }
  if(window.innerWidth<640){ card.style.left='50%';card.style.bottom='16px';card.style.transform='translateX(-50%)'; return; }
  const r=alvo.getBoundingClientRect(), cw=340;
  card.style.left=Math.min(Math.max(12,r.left),window.innerWidth-cw-12)+'px';
  let top=r.bottom+16;
  if(top+230>window.innerHeight) top=Math.max(12,r.top-246);
  card.style.top=top+'px';
}
function encerrarTour(){
  if(!tourEls) return;
  tourEls.block.remove(); tourEls.spot.remove(); tourEls.card.remove(); tourEls=null;
  nuvem.marcarTourVisto();
}
/* =============== Resumo em PDF =============== */
document.getElementById('btnPdf').onclick=gerarResumo;
function gerarResumo(){
  const esp=espacoAtual(); if(!esp) return;
  const occs=monthExpenses(viewYM);
  const inc=monthIncomeTotal(), exp=occs.reduce((s,o)=>s+o.valor,0);
  const pagos=occs.filter(o=>o.pago);
  const pct=inc?Math.round(exp/inc*100):0;
  const byCat={}; occs.forEach(o=>{byCat[o.exp.categoria]=(byCat[o.exp.categoria]||0)+o.valor});
  const cats=Object.entries(byCat).sort((a,b)=>b[1]-a[1]);

  const linhas=occs.map(o=>`<tr>
    <td>${o.pago?'✓':''}</td>
    <td>${esc(o.exp.desc)}${o.idx?` <small>(${o.idx}/${o.total})</small>`:''}${o.exp.tipo==='fixo'?' <small>(fixo)</small>':''}</td>
    <td>${esc(o.exp.categoria)}</td>
    <td>${esc(metodoLabel(o.exp.metodo))}</td>
    <td class="c">dia ${pad(o.dia)}</td>
    <td class="r">${BRL(o.valor)}</td></tr>`).join('');

  const rendas=state.incomes.map(i=>`<tr><td>${esc(i.nome)}</td><td>${esc(i.pessoa)}</td><td class="c">dia ${pad(i.dia)}</td><td class="r">${BRL(i.valor)}</td></tr>`).join('');

  const faturas=state.cards.map(c=>{
    const f=occs.filter(o=>o.exp.metodo==='card:'+c.id);
    if(!f.length) return '';
    return `<tr><td>${esc(c.nome)}</td><td class="c">venc. dia ${pad(c.venc)}</td><td class="c">${f.length} lançamento${f.length>1?'s':''}</td><td class="r">${BRL(f.reduce((s,o)=>s+o.valor,0))}</td></tr>`;
  }).join('');

  const catLinhas=cats.map(([c,v])=>`<tr><td>${esc(c)}</td><td class="c">${exp?Math.round(v/exp*100):0}%</td><td class="r">${BRL(v)}</td></tr>`).join('');

  const w=window.open('','_blank');
  w.document.write(`<!DOCTYPE html><html lang="pt-BR"><head><meta charset="UTF-8">
  <title>Órbita · Resumo de ${ymLabel(viewYM)}</title>
  <style>
    body{font-family:Arial,Helvetica,sans-serif;color:#1d2333;margin:36px;font-size:13px}
    h1{font-size:20px;margin:0}
    .sub{color:#6b7390;font-size:12px;margin:2px 0 20px}
    .cards{display:flex;gap:10px;margin-bottom:22px}
    .card{flex:1;border:1px solid #dde1ee;border-radius:10px;padding:10px 12px}
    .card .k{font-size:10px;text-transform:uppercase;letter-spacing:.5px;color:#6b7390}
    .card .v{font-size:16px;font-weight:bold;margin-top:2px}
    .verde{color:#0e9f6e}.vermelho{color:#e02440}
    h2{font-size:13px;text-transform:uppercase;letter-spacing:.5px;color:#6b7390;margin:22px 0 8px;border-bottom:1px solid #dde1ee;padding-bottom:4px}
    table{width:100%;border-collapse:collapse}
    td,th{padding:6px 8px;border-bottom:1px solid #eef0f7;text-align:left;vertical-align:top}
    th{font-size:10.5px;text-transform:uppercase;letter-spacing:.4px;color:#6b7390}
    .r{text-align:right;white-space:nowrap}.c{text-align:center;white-space:nowrap}
    tfoot td{font-weight:bold;border-top:2px solid #dde1ee}
    small{color:#6b7390}
    footer{margin-top:28px;font-size:10.5px;color:#a0a6bd;text-align:center}
    @media print{body{margin:12mm}}
  </style></head><body>
  <h1>🪐 Órbita — Resumo financeiro</h1>
  <div class="sub">${ymLabel(viewYM)} · espaço "${esc(esp.nome)}"${esp.tipo==='compartilhado'?' (compartilhado)':''}</div>
  <div class="cards">
    <div class="card"><div class="k">Entradas</div><div class="v verde">${BRL(inc)}</div></div>
    <div class="card"><div class="k">Gastos</div><div class="v vermelho">${BRL(exp)}</div></div>
    <div class="card"><div class="k">Saldo do mês</div><div class="v ${inc-exp>=0?'verde':'vermelho'}">${BRL(inc-exp)}</div></div>
    <div class="card"><div class="k">Contas pagas</div><div class="v">${pagos.length}/${occs.length}</div></div>
    <div class="card"><div class="k">Renda comprometida</div><div class="v">${pct}%</div></div>
  </div>
  ${occs.length?`<h2>Gastos do mês</h2><table>
    <thead><tr><th></th><th>Descrição</th><th>Categoria</th><th>Pagamento</th><th class="c">Vencimento</th><th class="r">Valor</th></tr></thead>
    <tbody>${linhas}</tbody>
    <tfoot><tr><td colspan="5">Total</td><td class="r">${BRL(exp)}</td></tr></tfoot></table>`:''}
  ${cats.length?`<h2>Por categoria</h2><table><tbody>${catLinhas}</tbody></table>`:''}
  ${faturas?`<h2>Faturas dos cartões</h2><table><tbody>${faturas}</tbody></table>`:''}
  ${rendas?`<h2>Rendas</h2><table><tbody>${rendas}</tbody></table>`:''}
  <footer>Gerado pelo Órbita em ${new Date().toLocaleDateString('pt-BR')} às ${new Date().toLocaleTimeString('pt-BR',{hour:'2-digit',minute:'2-digit'})}</footer>
  <script>window.onload=()=>setTimeout(()=>window.print(),300)<\/script>
  </body></html>`);
  w.document.close();
}