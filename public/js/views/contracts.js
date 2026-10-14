// Contratos (liberação por usuário): faturamento global, contratos, planilha contratual e medições (boletins).
import { html, api, icon, fmtDate } from '../core.js';
import { toast, sheet, confirmSheet } from '../ui.js';
import { pageHead, kpi } from './shared.js';

const BRL = new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' });
export const money = v => BRL.format(Number(v) || 0);
const qtyFmt = new Intl.NumberFormat('pt-BR', { maximumFractionDigits: 4 });
export const qty = v => qtyFmt.format(Number(v) || 0);
const pct = v => (v === null || v === undefined ? '—' : `${String(v).replace('.', ',')}%`);

const CT_STATUS = { vigente: 'Vigente', suspenso: 'Suspenso', encerrado: 'Encerrado' };
export const M_STATUS = {
  rascunho: { label: 'Rascunho', cls: 'm-draft' },
  emitida: { label: 'Emitida', cls: 'm-issued' },
  faturada: { label: 'Faturada', cls: 'm-billed' },
  recebida: { label: 'Recebida', cls: 'm-paid' },
};
export const mBadge = s => html`<span class="m-badge ${M_STATUS[s].cls}">${M_STATUS[s].label}</span>`;
const MONTHS = ['jan', 'fev', 'mar', 'abr', 'mai', 'jun', 'jul', 'ago', 'set', 'out', 'nov', 'dez'];
const ym = s => `${MONTHS[Number(s.slice(5, 7)) - 1]}/${s.slice(2, 4)}`;

function denied(state) {
  if (!state.meta.can.contracts) throw new Error('Acesso restrito: solicite ao administrador a liberação de Contratos (Usuários → Editar).');
}

// ---------- Faturamento global + lista de contratos ----------
export async function list({ state, query, setQuery, render }) {
  denied(state);
  const d = await api('/contracts/dashboard');
  const t = d.totals;
  const filter = query.get('status') || 'vigente';
  const shown = d.contracts.filter(c => filter === 'todos' || c.status === filter);
  const max = Math.max(1, ...d.series.flatMap(s => [s.measured, s.billed, s.received]));
  const bar = (v, cls, label) => html`<i class="${cls}" style="height:${Math.max(v ? 2 : 0, Math.round((v / max) * 100))}%" title="${label}: ${money(v)}"></i>`;

  const card = c => {
    const s = c.summary;
    return html`<a class="card ct-card" href="#/contratos/${c.id}">
      <div class="card-body" style="display:grid;gap:8px">
        <div style="display:flex;justify-content:space-between;gap:8px;align-items:center"><span class="mono muted" style="font-weight:600">${c.code}</span>
          <span class="pill ${c.status === 'vigente' ? '' : 'pill-sand'}">${CT_STATUS[c.status]}</span></div>
        <div><h2 style="font-size:16px">${c.client}</h2><div class="muted" style="font-size:13px">${c.title}${c.number ? ` · contrato ${c.number}` : ''}</div></div>
        <div class="ct-prog"><div class="ct-prog-bar"><i style="width:${Math.min(100, s.pct || 0)}%"></i></div><b>${pct(s.pct)}</b></div>
        <div class="ct-nums">
          <span><small>Contratado</small><b>${money(s.value)}</b></span>
          <span><small>Medido</small><b>${money(s.measured_total)}</b></span>
          <span><small>A receber</small><b class="${s.to_receive ? 'is-due' : ''}">${money(s.to_receive)}</b></span>
          <span><small>Saldo a medir</small><b>${money(s.balance)}</b></span>
        </div>
        <div class="stat-inline"><span>${s.measurements} medição(ões)</span>${s.last ? html`<span>Última: <b>${s.last.code}</b> · ${ym(s.last.ref_month)} ${mBadge(s.last.status)}</span>` : ''}
          ${s.drafts ? html`<span class="m-badge m-draft">${s.drafts} rascunho</span>` : ''}</div>
      </div></a>`;
  };

  return {
    title: 'Contratos',
    html: html`
      ${pageHead({
        eyebrow: 'Acesso restrito · liberação por usuário',
        title: 'Contratos e faturamento',
        sub: 'Contratos fechados pela Charão, medições (boletins) e o faturamento global: medido, faturado, recebido e a receber.',
        actions: html`${d.area_id ? html`<a class="btn btn-ghost" href="#/projetos/${d.area_id}">${icon('tasks')}Tarefas de contratos</a>` : ''}<a class="btn btn-accent" href="#/contratos/novo">${icon('plus')}Novo contrato</a>`,
      })}
      <div class="kpis kpis-6">
        ${kpi({ label: 'Contratado (vigentes)', value: money(t.value), color: '#2A3D50', foot: `${t.active} vigente(s) de ${t.contracts}` })}
        ${kpi({ label: 'Medido (emitido)', value: money(t.measured), color: '#2F6FB3', foot: 'boletins emitidos, faturados e recebidos' })}
        ${kpi({ label: 'Faturado', value: money(t.billed), color: '#8E6CB0', foot: `${money(t.to_bill)} emitido aguardando NF` })}
        ${kpi({ label: 'Recebido', value: money(t.received), color: '#2E8B57' })}
        ${kpi({ label: 'A receber', value: money(t.to_receive), color: '#C0392B', foot: 'faturado e ainda não recebido' })}
        ${kpi({ label: 'Saldo a medir', value: money(t.balance), color: '#707E8B', foot: t.drafts ? `${t.drafts} medição(ões) em rascunho` : 'contratos vigentes' })}
      </div>
      <section class="card section">
        <div class="card-head"><h2>${icon('reports')}Faturamento mensal</h2><span class="sub">últimos 12 meses</span></div>
        <div class="card-body">
          <div class="ct-chart-wrap"><div class="ct-chart" role="img" aria-label="Medido, faturado e recebido por mês">
            ${d.series.map(s => html`<div class="ct-col"><div class="ct-bars">${bar(s.measured, 'b-med', 'Medido')}${bar(s.billed, 'b-fat', 'Faturado')}${bar(s.received, 'b-rec', 'Recebido')}</div><span>${s.label}</span></div>`)}
          </div></div>
          <div class="ct-legend"><span><i class="b-med"></i>Medido (mês de referência)</span><span><i class="b-fat"></i>Faturado (mês da NF)</span><span><i class="b-rec"></i>Recebido (mês do pagamento)</span></div>
        </div>
      </section>
      ${d.by_client.length > 1 ? html`<section class="card section"><div class="card-head"><h2>Por cliente</h2></div>
        <div class="table-wrap"><table class="data ct-table"><thead><tr><th>Cliente</th><th class="num">Contratos</th><th class="num">Contratado</th><th class="num">Medido</th><th class="num">Faturado</th><th class="num">Recebido</th><th class="num">A receber</th></tr></thead>
        <tbody>${d.by_client.map(b => html`<tr><td>${b.client}</td><td class="num">${b.contracts}</td><td class="num">${money(b.value)}</td><td class="num">${money(b.measured)}</td><td class="num">${money(b.billed)}</td><td class="num">${money(b.received)}</td><td class="num">${money(b.to_receive)}</td></tr>`)}</tbody></table></div></section>` : ''}
      <div class="chips section" role="group" aria-label="Filtrar contratos" style="margin-bottom:12px">
        ${[['vigente', 'Vigentes'], ['suspenso', 'Suspensos'], ['encerrado', 'Encerrados'], ['todos', 'Todos']].map(([k, l]) =>
          html`<button class="chip" data-ctf="${k}" aria-pressed="${filter === k}">${l}<span class="n">${k === 'todos' ? d.contracts.length : d.contracts.filter(c => c.status === k).length}</span></button>`)}
      </div>
      ${shown.length ? html`<div class="grid grid-3">${shown.map(card)}</div>` : html`<div class="card empty-state"><p>${d.contracts.length ? 'Nenhum contrato neste filtro.' : 'Nenhum contrato cadastrado. Comece em “Novo contrato”.'}</p></div>`}`,
    mount(root) {
      root.querySelectorAll('[data-ctf]').forEach(b => b.addEventListener('click', () => { setQuery({ status: b.dataset.ctf }); render(); }));
    },
  };
}

// ---------- Cadastro / edição ----------
const itemRow = (i = {}) => html`<tr class="ct-item" data-id="${i.id || ''}">
  <td class="mono ct-seq"></td>
  <td><input type="text" data-f="description" maxlength="300" value="${i.description || ''}" placeholder="Descrição do item" aria-label="Descrição" required></td>
  <td><input type="text" data-f="unit" maxlength="12" value="${i.unit || 'vb'}" aria-label="Unidade" class="ct-unit"></td>
  <td><input type="text" data-f="unit_price" inputmode="decimal" value="${i.unit_price !== undefined ? String(i.unit_price).replace('.', ',') : ''}" placeholder="0,00" aria-label="Preço unitário" class="ct-num"></td>
  <td><input type="text" data-f="quantity" inputmode="decimal" value="${i.quantity !== undefined ? String(i.quantity).replace('.', ',') : ''}" placeholder="0" aria-label="Quantidade" class="ct-num"></td>
  <td class="num ct-value"></td>
  <td><label class="ct-add" title="Item incluído por aditivo"><input type="checkbox" data-f="additive" ${i.additive ? 'checked' : ''}>Aditivo</label></td>
  <td><button type="button" class="icon-btn" data-rm-item ${i.used ? 'disabled' : ''} title="${i.used ? 'Item já medido: não pode ser removido' : 'Remover item'}" aria-label="Remover item">✕</button></td>
</tr>`;
const parseNum = v => { const s = String(v ?? '').trim(); if (!s) return 0; const n = Number(s.includes(',') ? s.replace(/\./g, '').replace(',', '.') : s); return Number.isFinite(n) ? n : 0; };

export async function form({ params, state, navigate }) {
  denied(state);
  const editing = !!params.id;
  const c = editing ? await api(`/contracts/${params.id}`) : { status: 'vigente', items: [{}], bulletin_prefix: '' };
  const projects = state.meta.projects || [];
  const opt = (val, label, cur) => html`<option value="${val}" ${String(cur ?? '') === String(val) ? 'selected' : ''}>${label}</option>`;
  return {
    title: editing ? `Editar ${c.code}` : 'Novo contrato',
    html: html`
      ${pageHead({ back: { href: editing ? `#/contratos/${c.id}` : '#/contratos', label: editing ? c.code : 'Contratos' }, eyebrow: editing ? c.code : 'Código gerado automaticamente (CT-000)', title: editing ? 'Editar contrato' : 'Novo contrato' })}
      <form class="card card-pad form" id="ct-form" novalidate style="max-width:1000px">
        <fieldset class="fieldset form"><legend>Contrato</legend>
          <div class="form-row">
            <div class="field"><label class="req" for="client">Cliente</label><input id="client" name="client" maxlength="160" required value="${c.client || ''}"></div>
            <div class="field"><label for="client_doc">CNPJ/CPF do cliente</label><input id="client_doc" name="client_doc" maxlength="30" value="${c.client_doc || ''}"></div>
          </div>
          <div class="form-row">
            <div class="field"><label class="req" for="title">Objeto</label><input id="title" name="title" maxlength="200" required value="${c.title || ''}" placeholder="Ex.: Gerenciamento de obra"></div>
            <div class="field"><label for="number">Nº do contrato</label><input id="number" name="number" maxlength="60" value="${c.number || ''}"></div>
          </div>
          <div class="field"><label for="scope">Escopo (aparece no boletim)</label><textarea id="scope" name="scope" rows="2" maxlength="2000">${c.scope || ''}</textarea></div>
          <div class="form-row form-row-3">
            <div class="field"><label for="start_date">Início</label><input id="start_date" name="start_date" type="date" value="${c.start_date || ''}"></div>
            <div class="field"><label for="end_date">Término</label><input id="end_date" name="end_date" type="date" value="${c.end_date || ''}"></div>
            <div class="field"><label for="status">Situação</label><select id="status" name="status">${Object.entries(CT_STATUS).map(([k, l]) => opt(k, l, c.status))}</select></div>
          </div>
          <div class="form-row">
            <div class="field"><label class="req" for="bulletin_prefix">Prefixo do boletim</label><input id="bulletin_prefix" name="bulletin_prefix" maxlength="10" required value="${c.bulletin_prefix || ''}" placeholder="Ex.: ORBE" style="text-transform:uppercase">
              <span class="hint">Numeração dos boletins: prefixo + sequência + ano (ex.: ORBE0036.26).</span></div>
            <div class="field"><label for="project_id">Obra/projeto relacionado</label><select id="project_id" name="project_id"><option value="">—</option>${projects.map(p => opt(p.id, `${p.code} · ${p.name}`, c.project_id))}</select></div>
          </div>
          <div class="field"><label for="payment_info">Dados para pagamento (rodapé do boletim)</label><textarea id="payment_info" name="payment_info" rows="3" maxlength="1000" placeholder="Banco, agência, conta, CNPJ/PIX">${c.payment_info || ''}</textarea></div>
          <div class="field"><label for="notes">Observações internas</label><textarea id="notes" name="notes" rows="2" maxlength="3000">${c.notes || ''}</textarea></div>
        </fieldset>
        <fieldset class="fieldset form"><legend>Planilha contratual (itens e aditivos)</legend>
          <div class="table-wrap"><table class="data ct-items"><thead><tr><th>Item</th><th>Descrição</th><th>Unid.</th><th class="num">Preço unit. (R$)</th><th class="num">Quantidade</th><th class="num">Valor</th><th></th><th></th></tr></thead>
            <tbody id="ct-items">${(c.items.length ? c.items : [{}]).map(itemRow)}</tbody>
            <tfoot><tr><td colspan="5" class="num"><b>Valor do contrato</b></td><td class="num"><b id="ct-total"></b></td><td colspan="2"></td></tr></tfoot></table></div>
          <div><button type="button" class="btn btn-ghost btn-sm" id="ct-add-item">${icon('plus')}Incluir item</button></div>
          <span class="hint">Aditivos: inclua um novo item e marque “Aditivo”. Itens já medidos não podem ser removidos.</span>
        </fieldset>
        <div class="form-error" hidden></div>
        <div class="form-actions"><a class="btn btn-ghost" href="${editing ? `#/contratos/${c.id}` : '#/contratos'}">Cancelar</a>
          <button class="btn btn-primary" type="submit">${icon('check')}${editing ? 'Salvar contrato' : 'Cadastrar contrato'}</button></div>
      </form>`,
    mount(root) {
      const f = root.querySelector('#ct-form');
      const tb = root.querySelector('#ct-items');
      const recalc = () => {
        let total = 0;
        [...tb.querySelectorAll('.ct-item')].forEach((tr, k) => {
          tr.querySelector('.ct-seq').textContent = k + 1;
          const v = parseNum(tr.querySelector('[data-f=unit_price]').value) * parseNum(tr.querySelector('[data-f=quantity]').value);
          tr.querySelector('.ct-value').textContent = money(v);
          total += v;
        });
        root.querySelector('#ct-total').textContent = money(total);
      };
      tb.addEventListener('input', recalc);
      tb.addEventListener('click', e => { if (e.target.closest('[data-rm-item]')) { e.target.closest('tr').remove(); recalc(); } });
      root.querySelector('#ct-add-item').addEventListener('click', () => { tb.insertAdjacentHTML('beforeend', itemRow({}).toString()); recalc(); tb.lastElementChild.querySelector('input').focus(); });
      recalc();
      f.addEventListener('submit', async e => {
        e.preventDefault();
        const data = Object.fromEntries(new FormData(f));
        data.items = [...tb.querySelectorAll('.ct-item')].map(tr => ({
          id: tr.dataset.id ? Number(tr.dataset.id) : null,
          description: tr.querySelector('[data-f=description]').value,
          unit: tr.querySelector('[data-f=unit]').value,
          unit_price: tr.querySelector('[data-f=unit_price]').value,
          quantity: tr.querySelector('[data-f=quantity]').value,
          additive: tr.querySelector('[data-f=additive]').checked,
        }));
        const err = f.querySelector('.form-error');
        err.hidden = true;
        try {
          let id = c.id;
          if (editing) await api(`/contracts/${id}`, { method: 'PUT', body: data });
          else id = (await api('/contracts', { method: 'POST', body: data })).id;
          toast(editing ? 'Contrato atualizado.' : 'Contrato cadastrado.');
          navigate(`/contratos/${id}`);
        } catch (ex) { err.textContent = ex.message; err.hidden = false; }
      });
    },
  };
}

// ---------- Contrato: itens e medições ----------
export async function view({ params, state, navigate }) {
  denied(state);
  const c = await api(`/contracts/${params.id}`);
  const s = c.summary;
  const today = new Date();
  const nextRef = (() => {
    const last = c.measurements.at(-1)?.ref_month;
    if (!last) return `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}`;
    let [y, m] = last.split('-').map(Number);
    m++; if (m > 12) { m = 1; y++; }
    return `${y}-${String(m).padStart(2, '0')}`;
  })();
  return {
    title: `${c.code} · ${c.client}`,
    html: html`
      ${pageHead({ back: { href: '#/contratos', label: 'Contratos' }, eyebrow: `${c.code} · ${CT_STATUS[c.status]}`, title: c.client, sub: `${c.title}${c.number ? ` · contrato ${c.number}` : ''}${c.start_date ? ` · ${fmtDate(c.start_date)} → ${fmtDate(c.end_date)}` : ''}`,
        actions: html`<a class="btn btn-ghost" href="#/contratos/${c.id}/editar">${icon('edit')}Editar</a>${c.status !== 'encerrado' ? html`<button type="button" class="btn btn-accent" id="new-m">${icon('plus')}Nova medição</button>` : ''}` })}
      <div class="kpis kpis-6">
        ${kpi({ label: 'Valor do contrato', value: money(s.value), color: '#2A3D50', foot: `${c.items.length} item(ns)` })}
        ${kpi({ label: 'Medido', value: money(s.measured_total), color: '#2F6FB3', foot: `${pct(s.pct)} do contrato` })}
        ${kpi({ label: 'Faturado', value: money(s.billed), color: '#8E6CB0' })}
        ${kpi({ label: 'Recebido', value: money(s.received), color: '#2E8B57' })}
        ${kpi({ label: 'A receber', value: money(s.to_receive), color: '#C0392B' })}
        ${kpi({ label: 'Saldo a medir', value: money(s.balance), color: '#707E8B' })}
      </div>
      <section class="card section">
        <div class="card-head"><h2>${icon('file')}Medições (boletins)</h2><span class="sub">${c.measurements.length} medição(ões)</span></div>
        ${c.measurements.length ? html`<div class="table-wrap"><table class="data ct-table"><thead><tr><th>Boletim</th><th>Referência</th><th>Período</th><th class="num">A faturar</th><th>Situação</th><th>NF</th><th>Recebido</th></tr></thead>
          <tbody>${[...c.measurements].reverse().map(m => html`<tr data-href="#/medicoes/${m.id}" tabindex="0"><td class="mono"><b>${m.code}</b></td><td>${ym(m.ref_month)}</td><td class="nowrap">${fmtDate(m.period_start)} → ${fmtDate(m.period_end)}</td>
            <td class="num">${money(m.total)}</td><td>${mBadge(m.status)}</td><td>${m.nf_number ? html`${m.nf_number}<div class="t-sub">${fmtDate(m.nf_date)}</div>` : '—'}</td>
            <td>${m.paid_date ? html`${money(m.paid_amount ?? m.total)}<div class="t-sub">${fmtDate(m.paid_date)}</div>` : '—'}</td></tr>`)}</tbody></table></div>`
          : html`<div class="card-body muted">Nenhuma medição ainda. Use “Nova medição”.</div>`}
      </section>
      <section class="card section">
        <div class="card-head"><h2>Planilha contratual</h2><span class="sub">medido = boletins emitidos</span></div>
        <div class="table-wrap"><table class="data ct-table"><thead><tr><th>Item</th><th>Descrição</th><th>Unid.</th><th class="num">Preço unit.</th><th class="num">Qtd. contrato</th><th class="num">Valor</th><th class="num">Qtd. medida</th><th class="num">Saldo (qtd.)</th><th class="num">Saldo (R$)</th></tr></thead>
          <tbody>${c.items.map(i => html`<tr><td class="mono">${i.seq}</td><td>${i.description}${i.additive ? html` <span class="pill pill-sand">Aditivo</span>` : ''}</td><td>${i.unit}</td><td class="num">${money(i.unit_price)}</td>
            <td class="num">${qty(i.quantity)}</td><td class="num">${money(i.value)}</td><td class="num">${qty(i.measured_qty)}</td><td class="num ${i.balance_qty < 0 ? 'is-neg' : ''}">${qty(i.balance_qty)}</td><td class="num ${i.balance_value < 0 ? 'is-neg' : ''}">${money(i.balance_value)}</td></tr>`)}</tbody></table></div>
      </section>
      ${c.scope || c.payment_info || c.notes ? html`<section class="card section"><div class="card-body"><dl class="kv">
        ${c.scope ? html`<dt>Escopo</dt><dd>${c.scope}</dd>` : ''}${c.payment_info ? html`<dt>Pagamento</dt><dd style="white-space:pre-line">${c.payment_info}</dd>` : ''}
        ${c.project_code ? html`<dt>Obra</dt><dd><a href="#/projetos/${c.project_id}">${c.project_code} · ${c.project_name}</a></dd>` : ''}${c.notes ? html`<dt>Observações</dt><dd style="white-space:pre-line">${c.notes}</dd>` : ''}</dl></div></section>` : ''}`,
    mount(root) {
      root.querySelectorAll('tr[data-href]').forEach(tr => tr.addEventListener('click', () => (location.hash = tr.dataset.href)));
      root.querySelector('#new-m')?.addEventListener('click', async () => {
        const [y, m] = nextRef.split('-').map(Number);
        const last = new Date(Date.UTC(y, m, 0)).getUTCDate();
        const r = await sheet({
          title: 'Nova medição',
          submitLabel: 'Criar medição',
          body: html`<div class="field"><label class="req" for="nm-ref">Mês de referência</label><input type="month" id="nm-ref" name="ref_month" required value="${nextRef}"></div>
            <div class="form-row"><div class="field"><label for="nm-ps">Período medido — de</label><input type="date" id="nm-ps" name="period_start" value="${nextRef}-01"></div>
              <div class="field"><label for="nm-pe">até</label><input type="date" id="nm-pe" name="period_end" value="${nextRef}-${String(last).padStart(2, '0')}"></div></div>
            <span class="hint">A medição nasce em rascunho, com as quantidades zeradas e os descontos/acréscimos da medição anterior (para preencher o valor do mês).</span>`,
          onSubmit: d => api(`/contracts/${c.id}/measurements`, { method: 'POST', body: d }),
        });
        if (r?.id) { toast('Medição criada.'); navigate(`/medicoes/${r.id}`); }
      });
    },
  };
}

// ---------- Medição (boletim) ----------
export async function measurement({ params, state, render, navigate }) {
  denied(state);
  const m = await api(`/measurements/${params.id}`);
  const c = m.contract;
  const T = m.totals;
  const edit = m.can.edit;
  const qIn = r => html`<input type="text" inputmode="decimal" class="ct-num m-qty" data-item="${r.item_id}" value="${r.qty ? String(r.qty).replace('.', ',') : ''}" placeholder="0" aria-label="Quantidade medida — ${r.description}">`;
  const adjRow = a => html`<tr class="m-adj" data-adj>
    <td>${edit ? html`<input type="text" data-a="description" maxlength="200" value="${a.description || ''}" placeholder="Ex.: Desconto AMIL" aria-label="Descrição" required>` : a.description}</td>
    <td class="num">${money(a.prev || 0)}</td>
    <td class="num">${edit ? html`<input type="text" inputmode="decimal" class="ct-num" data-a="amount" value="${a.amount ? String(a.amount).replace('.', ',') : ''}" placeholder="−0,00" aria-label="Valor">` : money(a.amount)}</td>
    <td class="num">${money(a.acc || 0)}</td>
    ${edit ? html`<td><button type="button" class="icon-btn" data-rm-adj aria-label="Remover">✕</button></td>` : ''}</tr>`;
  return {
    title: `Boletim ${m.code}`,
    html: html`
      ${pageHead({ back: { href: `#/contratos/${c.id}`, label: c.code }, eyebrow: `${c.client} · ${c.code}`, title: html`Medição ${m.ref_label} · ${m.code}`,
        sub: html`Período ${fmtDate(m.period_start)} → ${fmtDate(m.period_end)} · ${mBadge(m.status)}${m.nf_number ? html` · NF ${m.nf_number} (${fmtDate(m.nf_date)})` : ''}${m.paid_date ? html` · recebido ${money(m.paid_amount)} em ${fmtDate(m.paid_date)}` : ''}`,
        actions: html`<a class="btn btn-ghost" href="#/imprimir/medicao/${m.id}">${icon('print')}Boletim (PDF)</a>
          ${m.can.issue ? html`<button type="button" class="btn btn-primary" data-ma="issue">${icon('send')}Emitir</button>` : ''}
          ${m.can.bill ? html`<button type="button" class="btn btn-primary" data-ma="bill">${icon('file')}Registrar faturamento</button>` : ''}
          ${m.can.receive ? html`<button type="button" class="btn btn-success" data-ma="receive">${icon('check')}Registrar recebimento</button>` : ''}
          ${m.can.reopen ? html`<button type="button" class="btn btn-ghost" data-ma="reopen">${icon('history')}Reabrir</button>` : ''}
          ${m.can.undo ? html`<button type="button" class="btn btn-ghost" data-ma="undo">${icon('history')}${m.status === 'recebida' ? 'Desfazer recebimento' : 'Desfazer faturamento'}</button>` : ''}
          ${m.can.delete ? html`<button type="button" class="btn btn-ghost" data-ma="delete">${icon('trash')}Excluir rascunho</button>` : ''}` })}
      <div class="kpis kpis-4">
        ${kpi({ label: 'Medição do mês', value: money(T.measured), color: '#2F6FB3' })}
        ${kpi({ label: 'Descontos / acréscimos', value: money(T.adj), color: '#B7791F' })}
        ${kpi({ label: 'Total a faturar', value: money(T.to_bill), color: '#2A3D50', hero: true })}
        ${kpi({ label: 'Saldo contratual', value: money(T.balance), color: '#707E8B', foot: `acumulado ${money(T.acc_total)}` })}
      </div>
      <form id="m-form" novalidate>
        ${edit ? html`<section class="card section"><div class="card-body form"><div class="form-row form-row-3">
          <div class="field"><label for="m-ref">Mês de referência</label><input type="month" id="m-ref" name="ref_month" value="${m.ref_month}"></div>
          <div class="field"><label for="m-ps">Período — de</label><input type="date" id="m-ps" name="period_start" value="${m.period_start || ''}"></div>
          <div class="field"><label for="m-pe">até</label><input type="date" id="m-pe" name="period_end" value="${m.period_end || ''}"></div></div></div></section>` : ''}
        <section class="card section">
          <div class="card-head"><h2>Itens medidos</h2><span class="sub">${edit ? 'informe a quantidade medida no período' : 'quantidades e valores do boletim'}</span></div>
          <div class="table-wrap"><table class="data ct-table m-table">
            <thead><tr><th rowspan="2">Item</th><th rowspan="2">Descrição</th><th rowspan="2">Unid.</th><th rowspan="2" class="num">Preço unit.</th>
              <th colspan="2" class="c">Contrato</th><th colspan="2" class="c">Acumulado anterior</th><th colspan="2" class="c m-hl">Medição</th><th colspan="2" class="c">Acumulado atual</th><th colspan="2" class="c">Saldo</th></tr>
              <tr>${[0, 1, 2, 3, 4].map(k => html`<th class="num ${k === 2 ? 'm-hl' : ''}">Qtd.</th><th class="num ${k === 2 ? 'm-hl' : ''}">Valor</th>`)}</tr></thead>
            <tbody>${m.rows.map(r => html`<tr class="${r.exceeded ? 'is-exceeded' : ''}" data-row="${r.item_id}" data-price="${r.unit_price}" data-prev="${r.prev_qty}" data-cq="${r.contract_qty}">
              <td class="mono">${r.seq}</td><td>${r.description}${r.additive ? html` <span class="pill pill-sand">Aditivo</span>` : ''}</td><td>${r.unit}</td><td class="num">${money(r.unit_price)}</td>
              <td class="num">${qty(r.contract_qty)}</td><td class="num">${money(r.contract_value)}</td>
              <td class="num">${qty(r.prev_qty)}</td><td class="num">${money(r.prev_value)}</td>
              <td class="num m-hl">${edit ? qIn(r) : qty(r.qty)}</td><td class="num m-hl" data-v="value">${money(r.value)}</td>
              <td class="num" data-v="acc_qty">${qty(r.acc_qty)}</td><td class="num" data-v="acc_value">${money(r.acc_value)}</td>
              <td class="num" data-v="bal_qty">${qty(r.bal_qty)}</td><td class="num" data-v="bal_value">${money(r.bal_value)}</td></tr>`)}</tbody>
            <tfoot><tr><td colspan="5"><b>Medição</b></td><td class="num">${money(T.contract)}</td><td></td><td class="num">${money(T.prev)}</td><td></td><td class="num m-hl"><b id="t-measured">${money(T.measured)}</b></td><td></td><td class="num">${money(T.acc)}</td><td></td><td class="num">${money(T.balance)}</td></tr></tfoot>
          </table></div>
          ${m.rows.some(r => r.exceeded) ? html`<div class="card-body"><div class="notice notice-warn">${icon('alert')}<span>Há itens com quantidade acumulada acima do contratado (saldo negativo). Avalie um aditivo.</span></div></div>` : ''}
        </section>
        <section class="card section">
          <div class="card-head"><h2>Descontos / acréscimos</h2><span class="sub">valores negativos = desconto</span></div>
          <div class="table-wrap"><table class="data ct-table"><thead><tr><th>Descrição</th><th class="num">Acumulado anterior</th><th class="num">Neste boletim</th><th class="num">Acumulado atual</th>${edit ? html`<th></th>` : ''}</tr></thead>
            <tbody id="m-adjs">${m.adjustments.filter(a => edit ? a.id !== null : true).map(adjRow)}</tbody></table></div>
          ${edit ? html`<div class="card-body"><button type="button" class="btn btn-ghost btn-sm" id="m-add-adj">${icon('plus')}Incluir desconto/acréscimo</button></div>` : ''}
        </section>
        <section class="card section"><div class="card-body form">
          <div class="field"><label for="m-notes">Observações do boletim</label>${edit ? html`<textarea id="m-notes" name="notes" rows="2" maxlength="2000">${m.notes || ''}</textarea>` : html`<div>${m.notes || '—'}</div>`}</div>
          ${edit ? html`<div class="form-actions" style="justify-content:flex-start"><button type="submit" class="btn btn-primary">${icon('check')}Salvar medição</button></div>` : ''}
        </div></section>
      </form>`,
    mount(root) {
      const f = root.querySelector('#m-form');
      const collect = () => ({
        ref_month: f.ref_month?.value, period_start: f.period_start?.value, period_end: f.period_end?.value, notes: f.notes?.value,
        lines: Object.fromEntries([...root.querySelectorAll('.m-qty')].map(i => [i.dataset.item, i.value])),
        adjustments: [...root.querySelectorAll('[data-adj]')].map(tr => ({ description: tr.querySelector('[data-a=description]').value, amount: tr.querySelector('[data-a=amount]').value })).filter(a => a.description.trim()),
      });
      // Recalcula a linha ao digitar (prévia; o servidor confirma ao salvar)
      root.querySelectorAll('.m-qty').forEach(inp => inp.addEventListener('input', () => {
        const tr = inp.closest('tr');
        const price = Number(tr.dataset.price), prev = Number(tr.dataset.prev), cq = Number(tr.dataset.cq);
        const q = parseNum(inp.value);
        tr.querySelector('[data-v=value]').textContent = money(q * price);
        tr.querySelector('[data-v=acc_qty]').textContent = qty(prev + q);
        tr.querySelector('[data-v=acc_value]').textContent = money((prev + q) * price);
        tr.querySelector('[data-v=bal_qty]').textContent = qty(cq - prev - q);
        tr.querySelector('[data-v=bal_value]').textContent = money((cq - prev - q) * price);
        tr.classList.toggle('is-exceeded', prev + q > cq + 1e-9);
        root.querySelector('#t-measured').textContent = money([...root.querySelectorAll('.m-qty')].reduce((s, i) => s + parseNum(i.value) * Number(i.closest('tr').dataset.price), 0));
      }));
      root.querySelector('#m-add-adj')?.addEventListener('click', () => {
        root.querySelector('#m-adjs').insertAdjacentHTML('beforeend', adjRow({ description: '', prev: 0, amount: 0, acc: 0 }).toString());
        root.querySelector('#m-adjs').lastElementChild.querySelector('input').focus();
      });
      root.querySelector('#m-adjs')?.addEventListener('click', e => { if (e.target.closest('[data-rm-adj]')) e.target.closest('tr').remove(); });
      const save = () => api(`/measurements/${m.id}`, { method: 'PUT', body: collect() });
      f.addEventListener('submit', async e => {
        e.preventDefault();
        try { await save(); toast('Medição salva.'); render(); } catch (ex) { toast(ex.message, 'err'); }
      });
      const act = async (a, body) => {
        try {
          const r = await api(`/measurements/${m.id}/actions/${a}`, { method: 'POST', body });
          if (r.deleted) { toast('Rascunho excluído.'); return navigate(`/contratos/${r.contract_id}`); }
          toast({ issue: 'Medição emitida.', bill: 'Faturamento registrado.', receive: 'Recebimento registrado.', reopen: 'Medição reaberta.', undo: 'Desfeito.' }[a] || 'Feito.');
          render();
        } catch (ex) { toast(ex.message, 'err'); }
      };
      root.querySelectorAll('[data-ma]').forEach(b => b.addEventListener('click', async () => {
        const a = b.dataset.ma;
        if (a === 'issue') {
          if (edit) { try { await save(); } catch (ex) { return toast(ex.message, 'err'); } }
          const fresh = await api(`/measurements/${m.id}`);
          if (await confirmSheet('Emitir medição', `Emitir o boletim ${fresh.code} com total a faturar de ${money(fresh.totals.to_bill)}? Depois de emitida, a medição só pode ser corrigida reabrindo-a.`, 'Emitir')) act('issue');
        } else if (a === 'bill') {
          const r = await sheet({ title: 'Registrar faturamento', submitLabel: 'Registrar',
            body: html`<div class="form-row"><div class="field"><label class="req" for="nf">Nº da nota fiscal</label><input id="nf" name="nf_number" maxlength="40" required></div>
              <div class="field"><label for="nfd">Data da NF</label><input type="date" id="nfd" name="nf_date" value="${new Date().toISOString().slice(0, 10)}"></div></div>
              <span class="hint">Valor faturado: <b>${money(T.to_bill)}</b>.</span>` });
          if (r) act('bill', r);
        } else if (a === 'receive') {
          const r = await sheet({ title: 'Registrar recebimento', submitLabel: 'Registrar',
            body: html`<div class="form-row"><div class="field"><label for="pd">Data do recebimento</label><input type="date" id="pd" name="paid_date" value="${new Date().toISOString().slice(0, 10)}"></div>
              <div class="field"><label for="pa">Valor recebido (R$)</label><input id="pa" name="paid_amount" inputmode="decimal" value="${String(T.to_bill).replace('.', ',')}"></div></div>
              <span class="hint">Em branco = valor do boletim (${money(T.to_bill)}).</span>` });
          if (r) act('receive', { ...r, paid_amount: r.paid_amount ? parseNum(r.paid_amount) : '' });
        } else if (a === 'delete') {
          if (await confirmSheet('Excluir rascunho', `Excluir a medição ${m.code}? A numeração será reaproveitada.`, 'Excluir', true)) act('delete');
        } else if (a === 'reopen') {
          if (await confirmSheet('Reabrir medição', 'A medição volta para rascunho para correção. Deseja reabrir?', 'Reabrir')) act('reopen');
        } else if (a === 'undo') {
          if (await confirmSheet('Desfazer', m.status === 'recebida' ? 'Desfazer o registro de recebimento?' : 'Desfazer o faturamento (NF)?', 'Desfazer')) act('undo');
        }
      }));
    },
  };
}
