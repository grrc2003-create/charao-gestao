// Vendas e Prospecção: funil em Kanban (colunas personalizadas), ficha da oportunidade e passagem para Contratos.
// Cada coluna tem um tipo de etapa e exigências editáveis (para entrar e para sair e seguir); o que faltar é pedido numa janela antes de mover.
import { html, api, icon, fmtDate, fmtDateTime, avatar } from '../core.js';
import { toast, sheet, confirmSheet, readAttachments } from '../ui.js';
import { pageHead } from './shared.js';
import { money, CO_SHORT } from './contracts.js';
import { salesKpis, salesAnalytics, bindAnalytics } from './sales-analytics.js';

const CO_NAME = { charao: 'Charão Engenharia & Construção', lus: 'Ludimila Siqueira Arquitetura & Design' };
const coBadge = co => html`<span class="co-badge co-${co}" title="${CO_NAME[co] || ''}">${CO_SHORT[co] || co}</span>`;
const KIND_CLS = { prospeccao: 'k-pro', apresentacao: 'k-apr', proposta: 'k-prop', negociacao: 'k-neg', ganho: 'k-won', perdido: 'k-lost', livre: 'k-free' };
const LIST_OF = { source_id: 'source', lost_reason_id: 'loss', profile_id: 'profile' };
const LIST_NEW = { source: 'Nova origem', loss: 'Novo motivo', profile: 'Nova avaliação' };
const parseNum = v => { const s = String(v ?? '').trim(); if (!s) return null; const n = Number(s.includes(',') || /^-?\d{1,3}(\.\d{3})+$/.test(s) ? s.replace(/\./g, '').replace(',', '.') : s); return Number.isFinite(n) ? n : null; };
const numIn = v => (v === null || v === undefined || v === '' ? '' : String(v).replace('.', ','));
const daysSince = ts => (ts ? Math.max(0, Math.floor((Date.now() - Date.parse(String(ts).replace(' ', 'T') + 'Z')) / 86400e3)) : 0);
const pctTxt = v => `${String(Math.round(v * 100) / 100).replace('.', ',')}%`;

function denied(state) {
  if (!state.meta.can.sales) throw new Error('A seção Vendas e Prospecção não está liberada para o seu usuário. Solicite ao administrador (Cadastro da Equipe → Seções).');
}

// Exigências por coluna (mesma regra do servidor): sempre o cadastro básico + o que a coluna de destino exige para entrar;
// indo para a frente, também o que a coluna de origem e as do caminho exigem para sair. Voltar não pede o que é de saída.
const BASE_REQ = ['client', 'address', 'source_id', 'company'];
const closingKind = k => k === 'ganho' || k === 'perdido';
const rulesOf = s => s?.rules || { entry: [], exit: [] };
function requiredFor(to, from, stages) {
  const req = new Set(BASE_REQ);
  if (to.kind === 'perdido') req.add('lost_reason_id');
  rulesOf(to).entry.forEach(k => req.add(k));
  if (to.kind === 'perdido') return req;
  const pos = new Map(stages.map((x, i) => [x.id, i]));
  const ti = pos.get(to.id) ?? stages.length, fi = from ? pos.get(from.id) ?? -1 : -1;
  if (!from || ti > fi) stages.forEach((x, i) => { if (i >= Math.max(fi, 0) && i < ti && !closingKind(x.kind)) rulesOf(x).exit.forEach(k => req.add(k)); });
  return req;
}
function missingOf(o, req) {
  const miss = [];
  for (const k of req) {
    if (k === 'proposal_file') { if (!(o.files_count > 0)) miss.push(k); continue; }
    const v = o[k];
    if (k === 'proposal_value' ? !(Number(v) > 0) : (v === null || v === undefined || !String(v).trim())) miss.push(k);
  }
  return miss;
}

// ---------- Campos ----------
const LABEL = {
  company: 'Empresa', client: 'Cliente', client_doc: 'CNPJ/CPF', contact_name: 'Contato', phone: 'Telefone', email: 'E-mail',
  address: 'Endereço', city: 'Cidade', source_id: 'De onde veio (origem)', source_detail: 'Detalhe da origem', title: 'Oportunidade (serviço)',
  possible_scope: 'Escopo possível', final_scope: 'Escopo final', proposal_value: 'Valor da proposta (R$)', discount_pct: 'Desconto (%)',
  profile_id: 'Avaliação do cliente para fechamento', negotiation_notes: 'Observações da negociação', lost_reason_id: 'Motivo da perda',
  lost_notes: 'Observação (detalhe da perda)', owner_id: 'Responsável', notes: 'Observações', proposal_file: 'Proposta (PDF ou imagem)',
};
const HINT = {
  source_detail: 'Ex.: indicado por João Silva, anúncio de outubro…',
  possible_scope: 'O que o cliente pode contratar (ainda em discussão).',
  final_scope: 'Escopo fechado na proposta. Vira o escopo do contrato.',
  proposal_value: 'Valor cheio; o desconto é aplicado em seguida.',
};
function field(k, o, d, req) {
  const r = req.has(k);
  const lab = html`<label class="${r ? 'req' : ''}" for="sv-${k}">${LABEL[k]}</label>`;
  const hint = HINT[k] ? html`<span class="hint">${HINT[k]}</span>` : '';
  const v = o[k] ?? '';
  if (k === 'company') {
    return html`<div class="field sv-f-company"><span class="lbl ${r ? 'req' : ''}">Empresa</span><div class="segmented ct-company" role="radiogroup" aria-label="Empresa">
      <label><input type="radio" name="company" value="charao" ${o.company !== 'lus' ? 'checked' : ''}>Charão<small>${CO_NAME.charao}</small></label>
      <label><input type="radio" name="company" value="lus" ${o.company === 'lus' ? 'checked' : ''}>LuS<small>${CO_NAME.lus}</small></label></div></div>`;
  }
  if (LIST_OF[k]) {
    const kind = LIST_OF[k];
    const list = (d.lists[kind] || []).filter(t => t.active || t.id === o[k]);
    return html`<div class="field">${lab}<div class="sv-list-row">
      <select id="sv-${k}" name="${k}" ${r ? 'required' : ''} data-list="${kind}"><option value="">Escolha…</option>${list.map(t => html`<option value="${t.id}" ${t.id === o[k] ? 'selected' : ''}>${t.name}${t.active ? '' : ' (inativo)'}</option>`)}</select>
      <button type="button" class="btn btn-ghost btn-sm" data-list-new="${kind}" data-for="sv-${k}">${icon('plus')}${LIST_NEW[kind]}</button></div>
      <div class="sv-list-add" data-add-for="sv-${k}" hidden><input type="text" maxlength="60" placeholder="${LIST_NEW[kind]}…" aria-label="${LIST_NEW[kind]}">
        <button type="button" class="btn btn-primary btn-sm" data-list-save="${kind}">Incluir</button></div>${hint}</div>`;
  }
  if (k === 'owner_id') {
    return html`<div class="field">${lab}<select id="sv-owner_id" name="owner_id"><option value="">—</option>${d.users.map(u => html`<option value="${u.id}" ${u.id === o.owner_id ? 'selected' : ''}>${u.name}</option>`)}</select></div>`;
  }
  if (['possible_scope', 'final_scope', 'negotiation_notes', 'lost_notes', 'notes'].includes(k)) {
    return html`<div class="field">${lab}<textarea id="sv-${k}" name="${k}" rows="${k.endsWith('scope') ? 4 : 3}" maxlength="${k.endsWith('scope') ? 4000 : 3000}" ${r ? 'required' : ''}>${v}</textarea>${hint}</div>`;
  }
  if (k === 'proposal_value' || k === 'discount_pct') {
    return html`<div class="field">${lab}<input id="sv-${k}" name="${k}" type="text" inputmode="decimal" class="ct-num" value="${k === 'proposal_value' && o[k] ? Number(o[k]).toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) : numIn(o[k])}" placeholder="${k === 'discount_pct' ? '0' : '0,00'}" ${r ? 'required' : ''}>${hint}</div>`;
  }
  if (k === 'proposal_file') {
    return html`<div class="field sv-file">${lab}<input id="sv-proposal_file" type="file" accept="application/pdf,.pdf,image/*" ${r ? 'required' : ''}>
      <span class="hint">Fica registrada como revisão R00 (as próximas revisões são anexadas na negociação). Até 8 MB.</span></div>`;
  }
  const type = k === 'email' ? 'email' : k === 'phone' ? 'tel' : 'text';
  const max = { client: 160, client_doc: 30, contact_name: 120, phone: 40, email: 160, address: 300, city: 120, source_detail: 200, title: 200 }[k] || 200;
  return html`<div class="field">${lab}<input id="sv-${k}" name="${k}" type="${type}" maxlength="${max}" value="${v}" ${r ? 'required' : ''}>${hint}</div>`;
}
const rows = (keys, o, d, req) => {
  const out = [];
  for (let i = 0; i < keys.length;) {
    const k = keys[i];
    const wide = ['company', 'possible_scope', 'final_scope', 'negotiation_notes', 'lost_notes', 'notes', 'proposal_file', 'address'].includes(k) || LIST_OF[k];
    if (wide || i === keys.length - 1) { out.push(field(k, o, d, req)); i += 1; continue; }
    const k2 = keys[i + 1];
    const w2 = ['company', 'possible_scope', 'final_scope', 'negotiation_notes', 'lost_notes', 'notes', 'proposal_file', 'address'].includes(k2) || LIST_OF[k2];
    if (w2) { out.push(field(k, o, d, req)); i += 1; continue; }
    out.push(html`<div class="form-row">${field(k, o, d, req)}${field(k2, o, d, req)}</div>`);
    i += 2;
  }
  return out;
};

// "+ Nova origem / Novo motivo / Nova avaliação": inclui na lista (Configurações) e já seleciona
function bindListAdd(root, d) {
  root.addEventListener('click', async e => {
    const nb = e.target.closest('[data-list-new]');
    if (nb) {
      const box = root.querySelector(`[data-add-for="${nb.dataset.for}"]`);
      box.hidden = !box.hidden;
      if (!box.hidden) box.querySelector('input').focus();
      return;
    }
    const sb = e.target.closest('[data-list-save]');
    if (!sb) return;
    const box = sb.closest('.sv-list-add');
    const inp = box.querySelector('input');
    if (!inp.value.trim()) return inp.focus();
    sb.disabled = true;
    try {
      const r = await api(`/sales/lists/${sb.dataset.listSave}`, { method: 'POST', body: { name: inp.value } });
      d.lists[sb.dataset.listSave] = r.list;
      const sel = root.querySelector(`#${box.dataset.addFor}`);
      const item = r.list.find(t => t.id === r.id);
      if (![...sel.options].some(op => Number(op.value) === r.id)) sel.add(new Option(item.name, r.id));
      sel.value = String(r.id);
      inp.value = '';
      box.hidden = true;
      toast(`“${item.name}” incluído na lista.`);
    } catch (ex) { toast(ex.message, 'err'); } finally { sb.disabled = false; }
  });
  root.addEventListener('keydown', e => {
    if (e.key === 'Enter' && e.target.closest('.sv-list-add')) { e.preventDefault(); e.target.closest('.sv-list-add').querySelector('[data-list-save]').click(); }
  });
}

// Lê os campos do formulário (e o arquivo da proposta, se houver)
async function readForm(form) {
  const data = {};
  form.querySelectorAll('[name]').forEach(el => {
    if (el.type === 'radio') { if (el.checked) data[el.name] = el.value; return; }
    if (el.type === 'file') return;
    data[el.name] = el.value;
  });
  for (const k of ['proposal_value', 'discount_pct']) if (k in data) data[k] = data[k] === '' ? '' : parseNum(data[k]) ?? data[k];
  const fi = form.querySelector('#sv-proposal_file');
  if (fi?.files?.length) {
    const [f] = await readAttachments(fi.files);
    data.proposals = [{ file: f.data, name: f.name || fi.files[0].name, value: data.proposal_value, discount_pct: data.discount_pct, notes: 'Proposta inicial' }];
  }
  return data;
}
const checkRequired = form => {
  const bad = [...form.querySelectorAll('[required]')].find(el => (el.type === 'file' ? !el.files?.length : !String(el.value).trim()));
  if (bad) { bad.focus(); throw new Error(`Preencha: ${form.querySelector(`label[for="${bad.id}"]`)?.textContent || 'campo obrigatório'}.`); }
};

// ---------- Mover entre colunas ----------
// Pede o que faltar para a coluna de destino; no contrato fechado pergunta (Sim/Não, sem padrão) se cria o contrato
async function moveFlow(o, stage, { position, d, navigate, done }) {
  const from = d.stages.find(x => x.id === o.stage_id) || null;
  const req = requiredFor(stage, from, d.stages);
  const miss = missingOf(o, req);
  const forward = from && d.stages.indexOf(stage) > d.stages.indexOf(from) && stage.kind !== 'perdido';
  const exitMiss = forward ? miss.filter(k => !requiredFor(stage, stage, d.stages).has(k)) : [];
  const body = { stage_id: stage.id, ...(position !== undefined ? { position } : {}) };
  if (stage.kind === 'perdido' || miss.length) {
    const stop = sheetObserver(d);
    const keys = stage.kind === 'perdido' ? [...new Set([...miss.filter(k => k !== 'lost_reason_id'), 'lost_reason_id', 'lost_notes'])] : miss.flatMap(k => (k === 'proposal_value' ? ['proposal_value', 'discount_pct'] : [k]));
    const r = await sheet({
      title: `Mover ${o.code} para “${stage.name}”`,
      wide: true,
      submitLabel: 'Salvar e mover',
      danger: stage.kind === 'perdido',
      body: html`<div class="sv-move-sheet" data-sv-sheet>
        <p class="muted" style="margin:0 0 4px">${stage.kind === 'perdido' ? html`Informe o motivo da perda de <b>${o.client}</b>. Os motivos são cadastrados em <b>Configurações</b> (e aqui mesmo, em “Novo motivo”).`
          : exitMiss.length ? html`Para sair de <b>${from.name}</b> e seguir para <b>${stage.name}</b>, preencha os campos abaixo de <b>${o.client}</b>.`
          : html`A coluna <b>${stage.name}</b> exige os campos abaixo para <b>${o.client}</b>.`}</p>
        ${rows(keys, o, d, req)}
        <div class="field"><label for="sv-stage_note">Observação da etapa (${stage.name})</label><textarea id="sv-stage_note" name="stage_note" rows="2" maxlength="4000" placeholder="Opcional"></textarea></div></div>`,
      onSubmit: async (_data, form) => {
        checkRequired(form);
        const data = await readForm(form);
        return api(`/sales/opportunities/${o.id}`, { method: 'PUT', body: { ...data, ...body } });
      },
    });
    stop();
    if (!r) return done(false);
  } else {
    try { await api(`/sales/opportunities/${o.id}`, { method: 'PUT', body }); } catch (ex) { toast(ex.message, 'err'); return done(false); }
  }
  toast(`${o.code} movida para ${stage.name}.`);
  if (stage.kind === 'ganho' && !o.contract_id) await askContract(o, d, navigate);
  done(true);
}
// O sheet é montado no body: liga o "+ Novo" das listas assim que ele aparece
const sheetObserver = d => {
  const mo = new MutationObserver(() => {
    const s = document.querySelector('[data-sv-sheet]:not([data-bound])');
    if (s) { s.dataset.bound = '1'; bindListAdd(s, d); }
  });
  mo.observe(document.body, { childList: true, subtree: true });
  return () => mo.disconnect();
};

export async function askContract(o, d, navigate) {
  const can = d.can_contracts;
  const r = await sheet({
    title: 'Contrato fechado',
    submitLabel: 'Continuar',
    body: html`<div class="sv-ask">
      <p style="margin:0 0 10px"><b>${o.code} · ${o.client}</b> entrou em contrato fechado. Quer criar o contrato agora na área de Contratos, aproveitando os dados da oportunidade?</p>
      ${can ? '' : html`<p class="muted" style="margin:0 0 10px">Seu usuário não tem a liberação de Contratos: escolha “Não” e peça a quem tem acesso para criar o contrato pela oportunidade.</p>`}
      <div class="segmented" role="radiogroup" aria-label="Criar o contrato agora?">
        <label><input type="radio" name="ask" value="sim" ${can ? '' : 'disabled'} required>Sim<small>Abre o cadastro do contrato já preenchido</small></label>
        <label><input type="radio" name="ask" value="nao" required>Não<small>Criar depois pelo botão na oportunidade</small></label></div></div>`,
    onSubmit: data => { if (!data.ask) throw new Error('Escolha Sim ou Não.'); return data; },
  });
  if (r?.ask === 'sim') navigate(`/contratos/novo?oportunidade=${o.id}`);
}

// ---------- Quadro (Kanban) ----------
const card = (o, s) => {
  const dd = daysSince(o.stage_since);
  return html`<li class="sv-card ${o.missing?.length ? 'is-missing' : ''}" draggable="true" data-id="${o.id}">
    <a class="sv-card-link" href="#/vendas/${o.id}">
      <div class="sv-card-top"><span class="mono sv-code">${o.code}</span>${coBadge(o.company)}</div>
      <b class="sv-client">${o.client}</b>
      ${o.title ? html`<span class="sv-title">${o.title}</span>` : ''}
      ${o.notes_count ? html`<span class="sv-ncount" title="${o.notes_count} observação(ões)">${icon('note')}${o.notes_count}</span>` : ''}
      ${o.final_value ? html`<span class="sv-value">${money(o.final_value)}${o.discount_pct ? html`<small>−${pctTxt(o.discount_pct)}</small>` : ''}</span>` : ''}
      <div class="sv-tags">
        ${o.source_name ? html`<span class="sv-tag">${o.source_name}</span>` : ''}
        ${s.kind === 'perdido' && o.lost_reason_name ? html`<span class="sv-tag t-lost">${o.lost_reason_name}</span>` : ''}
        ${s.kind === 'negociacao' && o.profile_name ? html`<span class="sv-tag t-neg">${o.profile_name}</span>` : ''}
        ${o.contract_code ? html`<span class="sv-tag t-won">${icon('contract')}${o.contract_code}</span>` : s.kind === 'ganho' ? html`<span class="sv-tag t-warn">sem contrato</span>` : ''}
      </div>
      ${o.missing?.length ? html`<span class="sv-warn">${icon('alert')}Falta: ${o.missing.map(k => LABEL[k]).join(', ')}</span>` : ''}
      ${o.next?.length ? html`<span class="sv-next" title="O que esta coluna exige para o cartão seguir adiante">Para avançar: ${o.next.map(k => LABEL[k]).join(', ')}</span>` : ''}
    </a>
    <div class="sv-card-foot">${o.owner_name ? html`<span class="sv-owner" title="Responsável: ${o.owner_name}">${avatar(o.owner_name, 'sm sv-av', o.owner_id)}<span>${o.owner_name.split(' ')[0]}</span></span>` : '<span></span>'}
      <span class="sv-days ${dd > 30 ? 'is-old' : ''}" title="Na coluna desde ${fmtDateTime(o.stage_since)}">${icon('clock')}${dd === 0 ? 'hoje' : `${dd} ${dd === 1 ? 'dia' : 'dias'}`}</span>
      <button type="button" class="icon-btn sv-move" data-move="${o.id}" aria-label="Mover ${o.code} para outra coluna" title="Mover para outra coluna">${icon('move')}</button></div>
  </li>`;
};

export async function board({ state, query, setQuery, render, navigate }) {
  denied(state);
  const d = await api('/sales/board');
  const empresa = ['charao', 'lus'].includes(query.get('empresa')) ? query.get('empresa') : '';
  const q = (query.get('q') || '').trim();
  const norm = s => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
  const visible = d.opportunities.filter(o => (!empresa || o.company === empresa) && (!q || norm(`${o.code} ${o.client} ${o.title} ${o.contact_name} ${o.city}`).includes(norm(q))));
  for (const o of visible) {
    const st = d.stages.find(x => x.id === o.stage_id);
    o.missing = st ? missingOf(o, requiredFor(st, st, d.stages)) : [];
    o.next = st && !closingKind(st.kind) && !o.missing.length ? missingOf(o, rulesOf(st).exit) : [];
  }
  const byStage = new Map(d.stages.map(s => [s.id, visible.filter(o => o.stage_id === s.id)]));
  const sum = l => l.reduce((s, o) => s + (o.final_value || 0), 0);
  const chip = (val, label) => html`<button type="button" class="chip co-chip ${val ? `co-${val}` : ''}" data-empresa="${val}" aria-pressed="${String(empresa === val)}">${label}</button>`;

  return {
    title: 'Vendas e Prospecção',
    html: html`
      ${pageHead({ eyebrow: 'Gestão da Empresa', title: 'Vendas e Prospecção', sub: 'Funil de oportunidades: arraste os cartões entre as colunas. O que cada etapa exige é pedido ao mover.',
        actions: html`<button type="button" class="btn btn-ghost" id="sv-cols">${icon('settings')}Colunas</button>
          <button type="button" class="btn btn-primary" id="sv-new">${icon('plus')}Nova oportunidade</button>` })}
      ${salesKpis(visible, d.stages)}
      ${salesAnalytics(visible, d.stages)}
      <div class="sv-filter">
        <div class="chips" role="group" aria-label="Empresa">${chip('', 'Todas')}${chip('charao', 'Charão')}${chip('lus', 'LuS')}</div>
        <label class="search sv-search">${icon('search')}<input type="search" id="sv-q" value="${q}" placeholder="Buscar cliente, código, cidade…" aria-label="Buscar oportunidade"></label>
      </div>
      <nav class="sv-jump" aria-label="Ir para a coluna">${d.stages.map(s => html`<button type="button" class="sv-jump-b ${KIND_CLS[s.kind]}" data-jump="${s.id}">${s.name}<b>${(byStage.get(s.id) || []).length}</b></button>`)}</nav>
      <div class="sv-board" id="sv-board" style="--n:${d.stages.length}">
        ${d.stages.map(s => {
          const list = byStage.get(s.id) || [];
          const same = s.name.toLocaleLowerCase('pt-BR') === s.kind_label.toLocaleLowerCase('pt-BR');
          return html`<section class="sv-col ${KIND_CLS[s.kind]}" data-stage="${s.id}" id="sv-col-${s.id}" aria-label="${s.name}">
            <header class="sv-col-head"><div class="sv-col-t"><b>${s.name}</b>${same ? '' : html`<small>${s.kind_label.replace(' (sem exigência extra)', '')}</small>`}</div>
              <span class="sv-col-n">${list.length}</span>
              <button type="button" class="icon-btn sv-col-add" data-new-in="${s.id}" aria-label="Nova oportunidade em ${s.name}" title="Nova oportunidade em ${s.name}">${icon('plus')}</button></header>
            <div class="sv-col-sum">${list.length ? money(sum(list)) : html`<span class="muted">—</span>`}</div>
            <ul class="sv-cards" data-stage="${s.id}">${list.map(o => card(o, s))}
              ${list.length ? '' : html`<li class="sv-empty">Arraste um cartão para cá</li>`}</ul>
          </section>`;
        })}
      </div>`,
    mount(root) {
      bindAnalytics(root);
      const byId = new Map(d.opportunities.map(o => [o.id, o]));
      const reload = () => render();
      root.querySelectorAll('[data-empresa]').forEach(b => b.addEventListener('click', () => { setQuery({ empresa: b.dataset.empresa, q }); reload(); }));
      let qt;
      root.querySelector('#sv-q').addEventListener('input', e => { clearTimeout(qt); qt = setTimeout(() => { setQuery({ empresa, q: e.target.value.trim() }); reload(); }, 350); });
      const go = (o, stage, position) => moveFlow(o, stage, { position, d, navigate, done: () => reload() });

      // Arrastar e soltar (computador)
      let dragId = null;
      const boardEl = root.querySelector('#sv-board');
      boardEl.addEventListener('dragstart', e => {
        const c = e.target.closest('.sv-card');
        if (!c) return;
        dragId = Number(c.dataset.id);
        c.classList.add('is-drag');
        e.dataTransfer.effectAllowed = 'move';
        e.dataTransfer.setData('text/plain', String(dragId));
      });
      boardEl.addEventListener('dragend', () => { dragId = null; root.querySelectorAll('.is-drag,.is-over').forEach(x => x.classList.remove('is-drag', 'is-over')); root.querySelector('.sv-drop')?.remove(); });
      const indexAt = (ul, y) => [...ul.querySelectorAll('.sv-card:not(.is-drag)')].filter(c => { const r = c.getBoundingClientRect(); return y > r.top + r.height / 2; }).length;
      boardEl.addEventListener('dragover', e => {
        const ul = e.target.closest('.sv-cards');
        if (!ul || !dragId) return;
        e.preventDefault();
        root.querySelectorAll('.sv-col.is-over').forEach(x => x.classList.remove('is-over'));
        ul.closest('.sv-col').classList.add('is-over');
        const mark = root.querySelector('.sv-drop') || Object.assign(document.createElement('li'), { className: 'sv-drop' });
        const cards = [...ul.querySelectorAll('.sv-card:not(.is-drag)')];
        const i = indexAt(ul, e.clientY);
        if (cards[i]) cards[i].before(mark); else ul.appendChild(mark);
      });
      boardEl.addEventListener('drop', e => {
        const ul = e.target.closest('.sv-cards');
        if (!ul || !dragId) return;
        e.preventDefault();
        const o = byId.get(dragId);
        const stage = d.stages.find(s => s.id === Number(ul.dataset.stage));
        const pos = indexAt(ul, e.clientY);
        root.querySelector('.sv-drop')?.remove();
        if (stage.id === o.stage_id) {
          api(`/sales/opportunities/${o.id}`, { method: 'PUT', body: { position: pos } }).then(reload).catch(ex => toast(ex.message, 'err'));
        } else go(o, stage, pos);
      });

      // Mover pelo botão (celular e teclado)
      boardEl.addEventListener('click', async e => {
        const b = e.target.closest('[data-move]');
        if (!b) return;
        e.preventDefault();
        const o = byId.get(Number(b.dataset.move));
        const r = await sheet({
          title: `Mover ${o.code}`,
          submitLabel: 'Mover',
          body: html`<p class="muted" style="margin:0 0 8px">${o.client} · está em <b>${o.stage_name}</b></p>
            <div class="sv-pick">${d.stages.filter(s => s.id !== o.stage_id).map(s => html`<label class="sv-pick-opt ${KIND_CLS[s.kind]}"><input type="radio" name="to" value="${s.id}" required><span><b>${s.name}</b><small>${s.kind_label}</small></span></label>`)}</div>`,
          onSubmit: data => { if (!data.to) throw new Error('Escolha a coluna.'); return data; },
        });
        if (r?.to) go(o, d.stages.find(s => s.id === Number(r.to)));
      });

      root.querySelectorAll('[data-jump]').forEach(b => b.addEventListener('click', () => root.querySelector(`#sv-col-${b.dataset.jump}`).scrollIntoView({ behavior: 'smooth', inline: 'start', block: 'nearest' })));
      root.querySelector('#sv-new').addEventListener('click', () => newOpportunity(d, reload, d.stages.find(s => s.kind !== 'ganho' && s.kind !== 'perdido') || d.stages[0], navigate));
      root.querySelectorAll('[data-new-in]').forEach(b => b.addEventListener('click', () => newOpportunity(d, reload, d.stages.find(s => s.id === Number(b.dataset.newIn)), navigate)));
      root.querySelector('#sv-cols').addEventListener('click', () => editColumns(d, reload));
    },
  };
}

// ---------- Nova oportunidade ----------
const KIND_EXTRA = {
  apresentacao: ['possible_scope'],
  proposta: ['possible_scope', 'final_scope', 'proposal_value', 'discount_pct', 'proposal_file'],
  negociacao: ['final_scope', 'proposal_value', 'discount_pct', 'proposal_file', 'profile_id', 'negotiation_notes'],
  ganho: ['final_scope', 'proposal_value', 'discount_pct', 'proposal_file'],
  perdido: ['lost_reason_id', 'lost_notes'],
};
async function newOpportunity(d, reload, stage, navigate) {
  const o = { company: 'charao' };
  const req = requiredFor(stage, null, d.stages);
  const ruleExtra = [...req].filter(k => !BASE_FIELDS.includes(k) && !(KIND_EXTRA[stage.kind] || []).includes(k));
  const extra = [...(KIND_EXTRA[stage.kind] || []), ...ruleExtra.flatMap(k => (k === 'proposal_value' ? ['proposal_value', 'discount_pct'] : [k]))].filter((k, i, a) => a.indexOf(k) === i);
  const stop = sheetObserver(d);
  const r = await sheet({
    title: `Nova oportunidade em “${stage.name}”`,
    wide: true,
    submitLabel: 'Cadastrar',
    body: html`<div data-sv-sheet>
      <p class="muted" style="margin:0 0 4px">O cartão entra direto na coluna <b>${stage.name}</b>${extra.length ? ' — por isso, além do cadastro, ela pede os campos marcados com *' : ''}.</p>
      ${rows(BASE_FIELDS, o, d, req)}
      ${extra.length ? html`<div class="sv-sub">${stage.name}</div>${rows(extra, o, d, req)}` : ''}
      <div class="field"><label for="sv-stage_note">Observação da etapa (${stage.name})</label><textarea id="sv-stage_note" name="stage_note" rows="2" maxlength="4000" placeholder="Opcional"></textarea></div></div>`,
    onSubmit: async (_data, form) => {
      checkRequired(form);
      const data = await readForm(form);
      return api('/sales/opportunities', { method: 'POST', body: { ...data, stage_id: stage.id } });
    },
  });
  stop();
  if (!r) return;
  toast('Oportunidade cadastrada.');
  if (stage.kind === 'ganho') {
    const opp = await api(`/sales/opportunities/${r.id}`);
    await askContract(opp, d, navigate);
  }
  reload();
}

// ---------- Colunas ----------
// Exigências de uma coluna: o que pede para entrar e para sair e seguir (campos da oportunidade)
const ruleBox = (s, d, kindLabel = null) => {
  const r = s.rules || { entry: d.kind_entry[s.kind || 'livre'] || [], exit: [] };
  const chk = (kind, k, on) => html`<label><input type="checkbox" data-rule="${kind}" value="${k}" ${on ? 'checked' : ''}>${LABEL[k]}</label>`;
  return html`<div class="sv-rules" hidden>
    <p class="hint" style="margin:0">Sempre exigidos: cliente, endereço, origem e empresa${(s.kind || '') === 'perdido' ? ' e o motivo da perda' : ''}.</p>
    <div class="sv-rule-g"><b>Para entrar nesta coluna</b><div class="sv-rule-opts">${d.rule_fields.map(k => chk('entry', k, r.entry.includes(k)))}</div></div>
    ${['ganho', 'perdido'].includes(s.kind) ? '' : html`<div class="sv-rule-g"><b>Para sair e seguir para as próximas colunas</b><div class="sv-rule-opts">${d.rule_fields.map(k => chk('exit', k, r.exit.includes(k)))}</div>
      <span class="hint">Pedido ao levar o cartão para a frente (inclusive pulando colunas). Voltar para uma coluna anterior não pede.</span></div>`}
  </div>`;
};
const ruleCount = s => { const r = s.rules || { entry: [], exit: [] }; return r.entry.length + r.exit.length; };
async function editColumns(d, reload) {
  const kinds = Object.entries(d.kinds);
  window.__svRuleCtx = d;
  const row = s => html`<li class="sv-colrow" data-id="${s.id || ''}">
    <span class="stage-move"><button type="button" class="icon-btn" data-up aria-label="Mover para cima">▲</button><button type="button" class="icon-btn" data-down aria-label="Mover para baixo">▼</button></span>
    <input type="text" maxlength="40" value="${s.name || ''}" aria-label="Nome da coluna" required>
    <select aria-label="Tipo de etapa">${kinds.map(([k, l]) => html`<option value="${k}" ${k === (s.kind || 'livre') ? 'selected' : ''}>${l}</option>`)}</select>
    <span class="stage-count">${s.use_count ? `${s.use_count} op.` : 'vazia'}</span>
    <button type="button" class="btn btn-ghost btn-sm sv-rule-tog" data-rules>Exigências (${ruleCount(s)})</button>
    <button type="button" class="icon-btn" data-rm aria-disabled="${s.use_count ? 'true' : 'false'}" aria-label="Excluir coluna" title="${s.use_count ? 'Mova as oportunidades antes de excluir' : 'Excluir'}">✕</button>
    ${ruleBox(s, d)}</li>`;
  const r = await sheet({
    title: 'Colunas do funil',
    wide: true,
    submitLabel: 'Salvar colunas',
    body: html`<p class="muted" style="margin:0 0 8px">Renomeie, reordene ou crie colunas. Em <b>Exigências</b>, escolha o que cada coluna pede <b>para entrar</b>
        e o que pede <b>para sair e seguir</b> para as próximas (ex.: sair de Apresentação só com o escopo final e o valor). O <b>tipo de etapa</b> sugere as exigências
        de entrada (Proposta: escopo final e valor · Negociação: também a avaliação do cliente) e define o fechamento: Contrato fechado (pergunta se cria o contrato)
        e Contrato perdido (motivo).</p>
      <ul class="sv-colist" id="sv-colist">${d.stages.map(row)}</ul>
      <button type="button" class="btn btn-ghost btn-sm" id="sv-col-add">${icon('plus')}Nova coluna</button>`,
    onSubmit: (_data, form) => {
      const pick = (li, kind) => [...li.querySelectorAll(`[data-rule="${kind}"]:checked`)].map(i => i.value);
      const stages = [...form.querySelectorAll('.sv-colrow')].map(li => ({ id: li.dataset.id ? Number(li.dataset.id) : null, name: li.querySelector('input[type=text]').value, kind: li.querySelector('select').value,
        entry_fields: pick(li, 'entry'), exit_fields: ['ganho', 'perdido'].includes(li.querySelector('select').value) ? [] : pick(li, 'exit') }));
      return api('/sales/stages', { method: 'PUT', body: { stages } });
    },
  });
  if (r) { toast('Colunas salvas.'); reload(); }
}
// Delegação dos botões do editor de colunas (o sheet fica no body)
document.addEventListener('click', e => {
  const list = e.target.closest('.sheet')?.querySelector('#sv-colist');
  if (!list) return;
  if (e.target.closest('#sv-col-add')) {
    list.insertAdjacentHTML('beforeend', html`<li class="sv-colrow" data-id="">
      <span class="stage-move"><button type="button" class="icon-btn" data-up aria-label="Mover para cima">▲</button><button type="button" class="icon-btn" data-down aria-label="Mover para baixo">▼</button></span>
      <input type="text" maxlength="40" value="" placeholder="Nome da coluna" aria-label="Nome da coluna" required>
      <select aria-label="Tipo de etapa">${['prospeccao', 'apresentacao', 'proposta', 'negociacao', 'ganho', 'perdido', 'livre'].map(k => html`<option value="${k}" ${k === 'livre' ? 'selected' : ''}>${{ prospeccao: 'Prospecção', apresentacao: 'Apresentação', proposta: 'Proposta', negociacao: 'Negociação', ganho: 'Contrato fechado', perdido: 'Contrato perdido', livre: 'Livre (sem exigência extra)' }[k]}</option>`)}</select>
      <span class="stage-count">nova</span><button type="button" class="btn btn-ghost btn-sm sv-rule-tog" data-rules>Exigências (0)</button><button type="button" class="icon-btn" data-rm aria-label="Excluir coluna">✕</button>
      ${ruleBox({ kind: 'livre', rules: { entry: [], exit: [] } }, window.__svRuleCtx)}</li>`.toString());
    list.lastElementChild.querySelector('input').focus();
    return;
  }
  const li = e.target.closest('.sv-colrow');
  if (!li) return;
  if (e.target.closest('[data-rules]')) { const b = li.querySelector('.sv-rules'); b.hidden = !b.hidden; return; }
  if (e.target.closest('[data-rm]')) { if (e.target.closest('[data-rm]').getAttribute('aria-disabled') === 'true') toast('Mova as oportunidades desta coluna antes de excluí-la.', 'warn'); else li.remove(); }
  if (e.target.closest('[data-up]') && li.previousElementSibling) li.previousElementSibling.before(li);
  if (e.target.closest('[data-down]') && li.nextElementSibling) li.nextElementSibling.after(li);
});

// ---------- Ficha da oportunidade ----------
// Organizada pelas colunas do funil: cada etapa mostra os seus campos (editáveis) e as observações feitas nela.
const BASE_FIELDS = ['company', 'client', 'client_doc', 'contact_name', 'phone', 'email', 'address', 'city', 'source_id', 'source_detail', 'title', 'owner_id'];
const noteItem = n => html`<li class="sv-note" data-note="${n.id}">
  <div class="sv-note-body">${n.body}</div>
  <div class="sv-note-meta"><span>${n.user_name || '—'} · ${fmtDateTime(n.created_at)}${n.updated_at ? html` · <i>editada${n.editor_name && n.editor_name !== n.user_name ? ` por ${n.editor_name}` : ''} em ${fmtDateTime(n.updated_at)}</i>` : ''}</span>
    ${n.can_edit ? html`<span class="sv-note-act"><button type="button" class="btn btn-ghost btn-sm" data-note-edit="${n.id}">${icon('edit')}Editar</button>
      <button type="button" class="icon-btn" data-note-del="${n.id}" aria-label="Excluir observação">${icon('trash')}</button></span>` : ''}</div></li>`;
const notesBlock = (stageId, stageName, notes) => html`<div class="sv-notes" data-stage-notes="${stageId}">
  <div class="sv-notes-head">${icon('note')}<b>Observações da etapa</b><span class="sv-notes-n">${notes.length || ''}</span></div>
  <ul class="sv-note-list">${notes.map(noteItem)}</ul>
  <div class="sv-note-add"><textarea rows="2" maxlength="4000" placeholder="Acrescentar observação em ${stageName}…" aria-label="Nova observação em ${stageName}"></textarea>
    <button type="button" class="btn btn-ghost btn-sm" data-note-add="${stageId}">${icon('plus')}Adicionar</button></div></div>`;

export async function view({ params, state, navigate, render }) {
  denied(state);
  const o = await api(`/sales/opportunities/${params.id}`);
  o.files_count = o.proposals.filter(p => p.has_file).length;
  const d = o;
  const curSt = o.stages.find(x => x.id === o.stage_id);
  const req = curSt ? requiredFor(curSt, curSt, o.stages) : new Set(BASE_REQ);
  const kind = o.stage_kind;
  const showLost = kind === 'perdido' || o.lost_reason_id;
  const stageChip = html`<span class="sv-stage ${KIND_CLS[kind]}">${o.stage_name}</span>`;
  const canCreate = kind === 'ganho' && !o.contract_id;
  const propRow = p => html`<tr><td class="mono">R${String(p.rev).padStart(2, '0')}</td><td>${fmtDate(p.created_at.slice(0, 10))}${p.created_by_name ? html`<small class="muted"> · ${p.created_by_name.split(' ')[0]}</small>` : ''}</td>
    <td class="num">${p.value ? money(p.value) : '—'}</td><td class="num">${p.discount_pct ? pctTxt(p.discount_pct) : '—'}</td><td class="num"><b>${p.final_value ? money(p.final_value) : '—'}</b></td>
    <td>${p.has_file ? html`<a href="/api/sales/files/${p.id}" target="_blank" rel="noopener">${icon('file')}${p.original_name || 'arquivo'}</a>` : html`<span class="muted">sem arquivo</span>`}${p.notes ? html`<div class="muted sv-pnote">${p.notes}</div>` : ''}</td>
    <td><button type="button" class="icon-btn" data-del-prop="${p.id}" aria-label="Excluir revisão R${String(p.rev).padStart(2, '0')}">${icon('trash')}</button></td></tr>`;
  const proposalBlock = html`${rows(['final_scope', 'proposal_value', 'discount_pct'], o, d, req)}
    <div class="sv-final">Valor final: <b id="sv-final">${money(o.final_value)}</b></div>
    <div class="sv-props">
      <div class="sv-props-head"><b class="${req.has('proposal_file') ? 'req' : ''}">Propostas e revisões</b>
        <button type="button" class="btn btn-ghost btn-sm" id="sv-add-prop">${icon('plus')}${o.proposals.length ? 'Nova revisão' : 'Anexar proposta'}</button></div>
      ${o.proposals.length ? html`<div class="table-wrap"><table class="data sv-ptable"><thead><tr><th>Rev.</th><th>Data</th><th class="num">Valor</th><th class="num">Desc.</th><th class="num">Final</th><th>Arquivo</th><th></th></tr></thead>
        <tbody>${o.proposals.map(propRow)}</tbody></table></div>` : html`<p class="muted" style="margin:6px 0 0">Nenhuma proposta anexada.</p>`}
      <span class="hint">Cada revisão guarda valor, desconto e arquivo; a mais recente passa a ser o valor da proposta.</span>
    </div>`;
  const fieldsOf = k => {
    if (k === 'prospeccao') return rows(BASE_FIELDS, o, d, req);
    if (k === 'apresentacao') return rows(['possible_scope'], o, d, req);
    if (k === 'proposta') return proposalBlock;
    if (k === 'negociacao') return rows(['profile_id', 'negotiation_notes'], o, d, req);
    if (k === 'perdido') return showLost ? rows(['lost_reason_id', 'lost_notes'], o, d, req) : html`<p class="muted sv-hint-line">O motivo da perda é pedido ao mover a oportunidade para esta coluna.</p>`;
    if (k === 'ganho') {
      return o.contract_id ? html`<p class="sv-hint-line">${icon('contract')}Contrato <a href="#/contratos/${o.contract_id}"><b>${o.contract_code}</b></a> criado a partir desta oportunidade.</p>`
        : html`<p class="muted sv-hint-line">Ao entrar nesta coluna, o sistema pergunta se cria o contrato com os dados da oportunidade.</p>`;
    }
    return '';
  };
  // Os campos de cada tipo ficam na primeira coluna daquele tipo; tipos sem coluna vão para "Outros dados"
  const firstOfKind = new Map();
  for (const s of o.stages) if (!firstOfKind.has(s.kind)) firstOfKind.set(s.kind, s.id);
  const curIdx = o.stages.findIndex(s => s.id === o.stage_id);
  const stageIds = new Set(o.stages.map(s => s.id));
  const orphanKinds = ['prospeccao', 'apresentacao', 'proposta', 'negociacao'].filter(k => !firstOfKind.has(k)).concat(showLost && !firstOfKind.has('perdido') ? ['perdido'] : []);
  const orphanNotes = o.notes.filter(n => !stageIds.has(n.stage_id));
  const sections = o.stages.map((s, i) => {
    const notes = o.notes.filter(n => n.stage_id === s.id);
    const later = i > curIdx && !['perdido'].includes(s.kind) ? 'is-later' : '';
    return html`<fieldset class="fieldset form sv-stageset ${KIND_CLS[s.kind]} ${s.id === o.stage_id ? 'is-current' : later}" id="sv-set-${s.id}">
      <legend><span class="sv-dot"></span>${i + 1} · ${s.name}${s.id === o.stage_id ? html`<em class="sv-here">etapa atual</em>` : ''}</legend>
      ${firstOfKind.get(s.kind) === s.id ? fieldsOf(s.kind) : ''}
      ${notesBlock(s.id, s.name, notes)}</fieldset>`;
  });
  return {
    title: `${o.code} · ${o.client}`,
    html: html`
      ${pageHead({ back: { href: '#/vendas', label: 'Vendas e Prospecção' }, eyebrow: o.code, title: o.client,
        sub: html`${stageChip} ${coBadge(o.company)} ${o.title ? html`· ${o.title}` : ''} · ${daysSince(o.stage_since) ? `na coluna há ${daysSince(o.stage_since)} dia(s)` : 'na coluna desde hoje'}`,
        actions: html`<button type="button" class="btn btn-ghost" id="sv-mv">${icon('move')}Mover</button>
          ${o.contract_id ? html`<a class="btn btn-ghost" href="#/contratos/${o.contract_id}">${icon('contract')}Contrato ${o.contract_code}</a>` : ''}
          ${canCreate ? html`<button type="button" class="btn btn-primary" id="sv-ct" ${o.can_contracts ? '' : 'aria-disabled="true"'} title="${o.can_contracts ? 'Abre o cadastro do contrato já preenchido' : 'Requer a liberação de Contratos'}">${icon('contract')}Criar contrato</button>` : ''}
          ${o.contract_id ? '' : html`<button type="button" class="icon-btn" id="sv-del" aria-label="Excluir oportunidade" title="Excluir oportunidade">${icon('trash')}</button>`}` })}
      ${o.missing_here.length ? html`<div class="sv-banner">${icon('alert')}<span>Para ficar em <b>${o.stage_name}</b> falta: ${o.missing_here.map(k => LABEL[k]).join(', ')}.</span></div>`
        : o.missing_next?.length ? html`<div class="sv-banner is-next">${icon('info')}<span>Para sair de <b>${o.stage_name}</b> e seguir adiante falta: ${o.missing_next.map(k => LABEL[k]).join(', ')}.</span></div>` : ''}
      <nav class="sv-steps" aria-label="Etapas">${o.stages.map((s, i) => html`<button type="button" data-step="${s.id}" class="sv-step ${KIND_CLS[s.kind]} ${s.id === o.stage_id ? 'is-current' : i < curIdx ? 'is-done' : ''}">
        <span>${s.name}</span>${o.notes.filter(n => n.stage_id === s.id).length ? html`<b>${o.notes.filter(n => n.stage_id === s.id).length}</b>` : ''}</button>`)}</nav>
      <div class="sv-detail">
        <form class="card card-pad form" id="sv-form" novalidate data-sv-sheet>
          ${sections}
          ${orphanKinds.length ? html`<fieldset class="fieldset form"><legend>Outros dados</legend>${orphanKinds.map(k => fieldsOf(k))}</fieldset>` : ''}
          ${orphanNotes.length ? html`<fieldset class="fieldset form"><legend>Observações de colunas excluídas</legend><ul class="sv-note-list">${orphanNotes.map(n => html`<li class="sv-note"><div class="sv-note-body">${n.body}</div><div class="sv-note-meta"><span>${n.stage_name} · ${n.user_name || '—'} · ${fmtDateTime(n.created_at)}</span></div></li>`)}</ul></fieldset>` : ''}
          <fieldset class="fieldset form"><legend>Observações gerais</legend>${rows(['notes'], o, d, req)}</fieldset>
          <div class="form-error" hidden></div>
          <div class="form-actions sv-save-bar"><a class="btn btn-ghost" href="#/vendas">Voltar ao funil</a><button class="btn btn-primary" type="submit">${icon('check')}Salvar dados</button></div>
        </form>
        <aside class="card sv-hist"><div class="card-head"><h2>${icon('history')}Histórico</h2></div>
          <ul class="sv-moves">${o.moves.map(m => html`<li><b>${m.from_stage ? html`${m.from_stage} → ${m.to_stage}` : html`Cadastrada em ${m.to_stage}`}</b><small>${fmtDateTime(m.created_at)}${m.user_name ? ` · ${m.user_name}` : ''}</small></li>`)}</ul>
          ${o.closed_at ? html`<p class="muted sv-closed">Encerrada em ${fmtDateTime(o.closed_at)}</p>` : ''}
        </aside>
      </div>`,

    mount(root) {
      const f = root.querySelector('#sv-form');
      bindListAdd(f, d);
      const reload = () => render();
      const fin = () => { if (!f.querySelector('#sv-proposal_value')) return; const v = parseNum(f.querySelector('#sv-proposal_value').value) || 0; const dc = parseNum(f.querySelector('#sv-discount_pct').value) || 0; root.querySelector('#sv-final').textContent = money(v * (1 - dc / 100)); };
      f.addEventListener('input', e => { if (e.target.matches('#sv-proposal_value,#sv-discount_pct')) fin(); });
      f.addEventListener('submit', async e => {
        e.preventDefault();
        const err = f.querySelector('.form-error');
        err.hidden = true;
        try {
          const data = await readForm(f);
          await api(`/sales/opportunities/${o.id}`, { method: 'PUT', body: data });
          toast('Oportunidade salva.');
          reload();
        } catch (ex) { err.textContent = ex.message; err.hidden = false; }
      });
      root.querySelectorAll('[data-step]').forEach(b => b.addEventListener('click', () => root.querySelector(`#sv-set-${b.dataset.step}`).scrollIntoView({ behavior: 'smooth', block: 'start' })));
      // Observações por etapa: gravam na hora, sem recarregar a ficha (não perde o que estiver sendo editado nos campos)
      const recount = box => { const n = box.querySelectorAll('.sv-note[data-note]').length; box.querySelector('.sv-notes-n').textContent = n || ''; };
      f.addEventListener('click', async e => {
        const add = e.target.closest('[data-note-add]');
        if (add) {
          const box = add.closest('.sv-notes');
          const ta = box.querySelector('.sv-note-add textarea');
          if (!ta.value.trim()) return ta.focus();
          add.disabled = true;
          try {
            const n = await api(`/sales/opportunities/${o.id}/notes`, { method: 'POST', body: { stage_id: Number(add.dataset.noteAdd), body: ta.value } });
            box.querySelector('.sv-note-list').insertAdjacentHTML('beforeend', noteItem(n).toString());
            ta.value = '';
            recount(box);
            toast('Observação incluída.');
          } catch (ex) { toast(ex.message, 'err'); } finally { add.disabled = false; }
          return;
        }
        const ed = e.target.closest('[data-note-edit]');
        if (ed) {
          const li = ed.closest('.sv-note');
          if (li.querySelector('.sv-note-edit')) return;
          const body = li.querySelector('.sv-note-body');
          body.hidden = true;
          body.insertAdjacentHTML('afterend', html`<div class="sv-note-edit"><textarea rows="3" maxlength="4000" aria-label="Editar observação">${body.textContent}</textarea>
            <div class="sv-note-edit-act"><button type="button" class="btn btn-ghost btn-sm" data-note-cancel>Cancelar</button><button type="button" class="btn btn-primary btn-sm" data-note-save="${li.dataset.note}">Salvar observação</button></div></div>`.toString());
          li.querySelector('.sv-note-edit textarea').focus();
          return;
        }
        if (e.target.closest('[data-note-cancel]')) {
          const li = e.target.closest('.sv-note');
          li.querySelector('.sv-note-edit').remove();
          li.querySelector('.sv-note-body').hidden = false;
          return;
        }
        const sv = e.target.closest('[data-note-save]');
        if (sv) {
          const li = sv.closest('.sv-note');
          sv.disabled = true;
          try {
            const n = await api(`/sales/notes/${sv.dataset.noteSave}`, { method: 'PUT', body: { body: li.querySelector('.sv-note-edit textarea').value } });
            li.outerHTML = noteItem(n).toString();
            toast('Observação atualizada.');
          } catch (ex) { toast(ex.message, 'err'); sv.disabled = false; }
          return;
        }
        const del = e.target.closest('[data-note-del]');
        if (del) {
          if (!(await confirmSheet('Excluir observação', 'A observação será excluída.', 'Excluir', true))) return;
          const box = del.closest('.sv-notes');
          try { await api(`/sales/notes/${del.dataset.noteDel}`, { method: 'DELETE' }); del.closest('.sv-note').remove(); recount(box); toast('Observação excluída.'); } catch (ex) { toast(ex.message, 'err'); }
        }
      });
      root.querySelector('#sv-add-prop')?.addEventListener('click', async () => {
        const r = await sheet({
          title: o.proposals.length ? 'Nova revisão da proposta' : 'Anexar proposta',
          submitLabel: 'Salvar',
          body: html`<div class="form-row"><div class="field"><label for="pp-v">Valor (R$)</label><input id="pp-v" name="value" inputmode="decimal" class="ct-num" value="${numIn(o.proposal_value)}"></div>
            <div class="field"><label for="pp-d">Desconto (%)</label><input id="pp-d" name="discount_pct" inputmode="decimal" class="ct-num" value="${numIn(o.discount_pct)}"></div></div>
            <div class="field"><label for="pp-f">Arquivo (PDF ou imagem)</label><input id="pp-f" type="file" accept="application/pdf,.pdf,image/*"></div>
            <div class="field"><label for="pp-n">Observação da revisão</label><input id="pp-n" name="notes" maxlength="1000" placeholder="Ex.: ajuste de escopo pedido pelo cliente"></div>`,
          onSubmit: async (data, form) => {
            const fi = form.querySelector('#pp-f');
            const p = { value: parseNum(data.value), discount_pct: parseNum(data.discount_pct), notes: data.notes };
            if (fi.files?.length) { const [a] = await readAttachments(fi.files); p.file = a.data; p.name = a.name || fi.files[0].name; }
            if (!p.file && p.value === null) throw new Error('Informe o valor ou anexe o arquivo.');
            return api(`/sales/opportunities/${o.id}`, { method: 'PUT', body: { proposals: [p] } });
          },
        });
        if (r) { toast('Proposta registrada.'); reload(); }
      });
      root.querySelectorAll('[data-del-prop]').forEach(b => b.addEventListener('click', async () => {
        if (!(await confirmSheet('Excluir revisão', 'A revisão e o arquivo anexado serão excluídos.', 'Excluir', true))) return;
        try { await api(`/sales/proposals/${b.dataset.delProp}`, { method: 'DELETE' }); toast('Revisão excluída.'); reload(); } catch (ex) { toast(ex.message, 'err'); }
      }));
      root.querySelector('#sv-mv').addEventListener('click', async () => {
        const r = await sheet({
          title: `Mover ${o.code}`,
          submitLabel: 'Mover',
          body: html`<div class="sv-pick">${o.stages.filter(s => s.id !== o.stage_id).map(s => html`<label class="sv-pick-opt ${KIND_CLS[s.kind]}"><input type="radio" name="to" value="${s.id}" required><span><b>${s.name}</b><small>${o.kinds[s.kind]}</small></span></label>`)}</div>`,
          onSubmit: data => { if (!data.to) throw new Error('Escolha a coluna.'); return data; },
        });
        if (r?.to) moveFlow(o, o.stages.find(s => s.id === Number(r.to)), { d, navigate, done: () => reload() });
      });
      root.querySelector('#sv-ct')?.addEventListener('click', () => { if (o.can_contracts) navigate(`/contratos/novo?oportunidade=${o.id}`); else toast('A criação do contrato requer a liberação de Contratos.', 'warn'); });
      root.querySelector('#sv-del')?.addEventListener('click', async () => {
        if (!(await confirmSheet('Excluir oportunidade', `${o.code} · ${o.client} e as propostas anexadas serão excluídas. Esta ação não pode ser desfeita.`, 'Excluir', true))) return;
        try { await api(`/sales/opportunities/${o.id}`, { method: 'DELETE' }); toast('Oportunidade excluída.'); navigate('/vendas'); } catch (ex) { toast(ex.message, 'err'); }
      });
    },
  };
}

// Editor de colunas: trocar o tipo sugere as exigências de entrada do novo tipo; contador acompanha as marcações
document.addEventListener('change', e => {
  const li = e.target.closest('.sheet .sv-colrow');
  if (!li) return;
  const d = window.__svRuleCtx;
  if (e.target.matches('select') && d) {
    const k = e.target.value, def = d.kind_entry[k] || [];
    li.querySelectorAll('[data-rule="entry"]').forEach(i => { i.checked = def.includes(i.value); });
    const ex = li.querySelector('[data-rule="exit"]')?.closest('.sv-rule-g');
    if (ex) ex.hidden = ['ganho', 'perdido'].includes(k);
  }
  const n = li.querySelectorAll('[data-rule]:checked').length;
  const t = li.querySelector('[data-rules]'); if (t) t.textContent = `Exigências (${n})`;
});
