// Recebimentos dos contratos: lista por ano (recebidos, a receber, vencidos e RT), lançamento/baixa,
// "Outras entradas" (sem contrato) e a importação das planilhas do financeiro com prévia.
import { html, api, icon, fmtDate } from '../core.js';
import { toast, sheet, confirmSheet } from '../ui.js';
import { pageHead } from './shared.js';

const BRL = new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' });
const money = v => BRL.format(Number(v) || 0);
const num = v => (v === null || v === undefined || v === '' ? '' : Number(v).toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 }));
export const RC_STATUS = {
  recebido: { label: 'Recebido', cls: 'm-paid' },
  a_receber: { label: 'A receber', cls: 'm-billed' },
  vencido: { label: 'Vencido', cls: 'rc-late' },
};
const badge = r => html`<span class="m-badge ${RC_STATUS[r.status].cls}">${r.status === 'vencido' ? `Vencido há ${r.days_late} d` : RC_STATUS[r.status].label}</span>`;

function denied(state) {
  if (!state.meta.can.contracts) throw new Error('Acesso restrito: solicite ao administrador a liberação de Contratos (Usuários → Editar).');
}

// ---------- Lista (no contrato e em Outras entradas) ----------
const FILTERS = [['todos', 'Todos'], ['aberto', 'A receber'], ['recebido', 'Recebidos'], ['rt', 'RT']];
const pass = (r, f) => f === 'todos' || (f === 'aberto' ? r.status !== 'recebido' : f === 'recebido' ? r.status === 'recebido' : r.kind === 'rt');

function rowHtml(r, client) {
  const title = r.kind === 'rt' ? `RT · ${r.payer || 'fornecedor'}` : [r.description, r.installment && !/vista/i.test(r.installment) ? r.installment : ''].filter(Boolean).join(' · ') || 'Parcela';
  const meta = [
    r.kind !== 'rt' && r.payer && r.payer !== client ? r.payer : '',
    r.doc_number ? `doc. ${r.doc_number}` : '',
    r.status === 'recebido' ? `venc. ${fmtDate(r.due_date)}` : '',
    r.account, r.method,
    r.measurement_code ? `mesmo valor do boletim ${r.measurement_code}` : '',
  ].filter(Boolean).join(' · ');
  const d = r.received_date || r.due_date;
  return html`<button type="button" class="rc-row is-${r.status} ${r.kind === 'rt' ? 'is-rt' : ''} ${r.measurement_id ? 'is-linked' : ''}" data-rc="${r.id}">
    <span class="rc-date"><b>${fmtDate(d, 'short')}</b><small>${r.received_date ? 'recebido' : 'vence'}</small></span>
    <span class="rc-main"><b>${r.kind === 'rt' ? html`<span class="pill pill-sand">RT</span> ` : ''}${title}</b>${meta ? html`<small>${meta}</small>` : ''}</span>
    <span class="rc-val"><b>${money(r.status === 'recebido' ? r.net : r.amount)}</b>${r.status === 'recebido' && r.net !== r.amount ? html`<small>parcela ${money(r.amount)}${r.discount ? ` · desc. ${money(r.discount)}` : ''}${r.interest ? ` · juros ${money(r.interest)}` : ''}</small>` : ''}${badge(r)}</span>
  </button>`;
}

function listBody(list, filter, client) {
  const shown = list.filter(r => pass(r, filter));
  if (!shown.length) return html`<div class="card-body muted">${list.length ? 'Nenhum recebimento neste filtro.' : 'Nenhum recebimento lançado.'}</div>`;
  const years = new Map();
  for (const r of shown) {
    const y = (r.received_date || r.due_date).slice(0, 4);
    if (!years.has(y)) years.set(y, []);
    years.get(y).push(r);
  }
  return html`${[...years.entries()].sort((a, b) => b[0].localeCompare(a[0])).map(([y, rs]) => {
    const rec = rs.filter(r => r.status === 'recebido').reduce((s, r) => s + r.net, 0);
    const open = rs.filter(r => r.status !== 'recebido').reduce((s, r) => s + r.amount, 0);
    return html`<div class="rc-year"><div class="rc-year-h"><b>${y}</b><span>${rec ? html`recebido <b>${money(rec)}</b>` : ''}${rec && open ? ' · ' : ''}${open ? html`a receber <b>${money(open)}</b>` : ''}</span></div>
      ${rs.map(r => rowHtml(r, client))}</div>`;
  })}`;
}

export function receiptsCard(list, { client = '', title = 'Recebimentos', canAdd = true } = {}) {
  const n = k => list.filter(r => pass(r, k)).length;
  return html`<section class="card section rc-card" id="rc-card">
    <div class="card-head"><h2>${icon('wallet')}${title}</h2>
      ${canAdd ? html`<button type="button" class="btn btn-ghost btn-sm" data-rc-new>${icon('plus')}Lançar</button>` : ''}</div>
    <div class="rc-filters chips" role="group" aria-label="Filtrar recebimentos">${FILTERS.filter(([k]) => k !== 'rt' || n('rt')).map(([k, l]) => html`<button type="button" class="chip" data-rcf="${k}" aria-pressed="${k === 'todos'}">${l}<span class="n">${n(k)}</span></button>`)}</div>
    <div class="rc-list" data-rc-list>${listBody(list, 'todos', client)}</div>
  </section>`;
}

const field = (id, label, input, req = false) => html`<div class="field"><label ${req ? 'class="req"' : ''} for="${id}">${label}</label>${input}</div>`;
function formBody(r = {}, { kinds = true } = {}) {
  return html`
    ${kinds ? html`<div class="segmented rc-kind" role="radiogroup" aria-label="Tipo">
      <label><input type="radio" name="kind" value="parcela" ${r.kind !== 'rt' ? 'checked' : ''}>Parcela do cliente<small>pagamento do contrato</small></label>
      <label><input type="radio" name="kind" value="rt" ${r.kind === 'rt' ? 'checked' : ''}>RT<small>reserva técnica paga por fornecedor</small></label></div>` : ''}
    <div class="form-row">${field('rc-due', 'Vencimento', html`<input type="date" id="rc-due" name="due_date" required value="${r.due_date || ''}">`, true)}
      ${field('rc-amt', 'Valor da parcela (R$)', html`<input type="text" id="rc-amt" name="amount" inputmode="decimal" required placeholder="0,00" value="${num(r.amount)}">`, true)}</div>
    ${field('rc-desc', 'Descrição', html`<input type="text" id="rc-desc" name="description" maxlength="400" value="${r.description || ''}" placeholder="Ex.: Parcela, Medição, Projeto…">`)}
    <div class="form-row">${field('rc-inst', 'Parcela/condição', html`<input type="text" id="rc-inst" name="installment" maxlength="40" value="${r.installment || ''}" placeholder="Ex.: 2/3 parcelas">`)}
      ${field('rc-payer', 'Pagador', html`<input type="text" id="rc-payer" name="payer" maxlength="160" value="${r.payer || ''}" placeholder="Cliente ou fornecedor">`)}</div>
    <fieldset class="rc-bx"><legend>Recebimento (baixa)</legend>
      <div class="form-row">${field('rc-rd', 'Data do recebimento', html`<input type="date" id="rc-rd" name="received_date" value="${r.received_date || ''}">`)}
        ${field('rc-ra', 'Valor recebido (R$)', html`<input type="text" id="rc-ra" name="received_amount" inputmode="decimal" placeholder="parcela − desconto + juros" value="${num(r.received_date ? r.received_amount : '')}">`)}</div>
      <div class="form-row">${field('rc-disc', 'Desconto (R$)', html`<input type="text" id="rc-disc" name="discount" inputmode="decimal" placeholder="0,00" value="${r.discount ? num(r.discount) : ''}">`)}
        ${field('rc-int', 'Juros/multa (R$)', html`<input type="text" id="rc-int" name="interest" inputmode="decimal" placeholder="0,00" value="${r.interest ? num(r.interest) : ''}">`)}</div>
      <span class="hint">Deixe a data em branco enquanto não receber. Sem valor recebido, vale parcela − desconto + juros.</span>
    </fieldset>
    <details class="rc-more" ${r.account || r.method || r.doc_number || r.notes ? 'open' : ''}><summary>Mais dados</summary>
      <div class="form-row">${field('rc-acc', 'Conta bancária', html`<input type="text" id="rc-acc" name="account" maxlength="80" value="${r.account || ''}">`)}
        ${field('rc-met', 'Forma', html`<input type="text" id="rc-met" name="method" maxlength="60" value="${r.method || ''}" placeholder="Pix, transferência…">`)}</div>
      <div class="form-row">${field('rc-doc', 'Nº documento', html`<input type="text" id="rc-doc" name="doc_number" maxlength="40" value="${r.doc_number || ''}">`)}
        ${field('rc-comp', 'Competência', html`<input type="date" id="rc-comp" name="competence_date" value="${r.competence_date || ''}">`)}</div>
      ${field('rc-nat', 'Natureza', html`<input type="text" id="rc-nat" name="nature" maxlength="80" value="${r.nature || ''}" placeholder="Prestação de Serviços, Execução de Obras…">`)}
      ${field('rc-notes', 'Observações', html`<textarea id="rc-notes" name="notes" rows="2" maxlength="1000">${r.notes || ''}</textarea>`)}
    </details>
    ${r.id ? html`<button type="button" class="btn btn-ghost btn-danger-text rc-del" data-rc-del>${icon('trash')}Excluir recebimento</button>` : ''}`;
}

// Liga filtros, "Lançar" e a edição (baixa/exclusão). contractId null = Outras entradas.
export function bindReceipts(root, list, { contractId = null, client = '', onChange }) {
  const card = root.querySelector('#rc-card');
  if (!card) return;
  const box = card.querySelector('[data-rc-list]');
  let filter = 'todos';
  card.querySelectorAll('[data-rcf]').forEach(b => b.addEventListener('click', () => {
    filter = b.dataset.rcf;
    card.querySelectorAll('[data-rcf]').forEach(x => x.setAttribute('aria-pressed', String(x === b)));
    box.innerHTML = listBody(list, filter, client).toString();
  }));
  card.querySelector('[data-rc-new]')?.addEventListener('click', async () => {
    const r = await sheet({ title: contractId ? 'Lançar recebimento' : 'Lançar outra entrada', submitLabel: 'Lançar', body: formBody({ payer: contractId ? client : '' }, { kinds: !!contractId }),
      onSubmit: d => api('/receipts', { method: 'POST', body: { ...d, contract_id: contractId } }) });
    if (r?.id) { toast('Recebimento lançado.'); onChange(); }
  });
  box.addEventListener('click', async e => {
    const b = e.target.closest('[data-rc]');
    if (!b) return;
    const r = list.find(x => x.id === Number(b.dataset.rc));
    let deleted = false;
    const p = sheet({ title: r.status === 'recebido' ? 'Recebimento' : 'Recebimento — dar baixa', submitLabel: 'Salvar', body: formBody(r, { kinds: !!contractId }),
      onSubmit: d => api(`/receipts/${r.id}`, { method: 'PUT', body: d }) });
    setTimeout(() => document.querySelector('.sheet [data-rc-del]')?.addEventListener('click', async ev => {
      const s = ev.currentTarget.closest('.sheet-backdrop');
      if (!(await confirmSheet('Excluir recebimento', `Excluir ${money(r.amount)} com vencimento em ${fmtDate(r.due_date)}? Fica registrado na auditoria.`, 'Excluir', true))) return;
      try { await api(`/receipts/${r.id}`, { method: 'DELETE' }); deleted = true; s.querySelector('[data-close]').click(); } catch (ex) { toast(ex.message, 'error'); }
    }), 60);
    const res = await p;
    if (deleted) { toast('Recebimento excluído.'); onChange(); }
    else if (res?.ok) { toast('Recebimento salvo.'); onChange(); }
  });
}

// ---------- Outras entradas (sem contrato) ----------
export async function others({ state, render }) {
  denied(state);
  const d = await api('/receipts/outras');
  return {
    title: 'Outras entradas',
    html: html`${pageHead({ back: { href: '#/contratos', label: 'Contratos' }, eyebrow: 'Contratos · sem contrato', title: 'Outras entradas',
        sub: 'Aporte de sócio, empréstimo, reembolso e entradas sem obra. Ficam fora do faturamento dos contratos.' })}
      <div class="ct-tiles rc-tiles">
        <div class="ct-tile"><span>Recebido</span><b>${money(d.totals.received)}</b><small>${d.totals.count} lançamento(s)</small></div>
        <div class="ct-tile"><span>A receber</span><b>${money(d.totals.open)}</b></div>
      </div>
      ${receiptsCard(d.receipts, { title: 'Entradas' })}`,
    mount(root) { bindReceipts(root, d.receipts, { contractId: null, onChange: render }); },
  };
}

// ---------- Importação das planilhas ----------
const readB64 = f => new Promise((res, rej) => { const fr = new FileReader(); fr.onload = () => res(String(fr.result).split(',')[1]); fr.onerror = () => rej(new Error(`Não foi possível ler ${f.name}.`)); fr.readAsDataURL(f); });

function previewHtml(p) {
  const sum = (a, k) => a.reduce((s, g) => s + g[k], 0);
  const nNew = sum(p.groups, 'new_rows') + p.others.new_rows, nUpd = sum(p.groups, 'update_rows') + p.others.update_rows, nSame = sum(p.groups, 'same_rows') + p.others.same_rows;
  const created = p.groups.filter(g => !g.match).length;
  const opts = g => html`<option value="new" ${!g.match ? 'selected' : ''}>Criar contrato novo</option>
    <optgroup label="Juntar com outra obra desta planilha">${p.groups.filter(o => o.key !== g.key).map(o => html`<option value="g:${o.key}">${o.obra} · ${o.client}</option>`)}</optgroup>
    ${p.contracts.length ? html`<optgroup label="Contrato já cadastrado">${p.contracts.map(c => html`<option value="${c.id}" ${g.match?.id === c.id ? 'selected' : ''}>${c.code} · ${c.client} · ${c.title}</option>`)}</optgroup>` : ''}`;
  const rowsTable = rows => html`<div class="table-wrap"><table class="data ct-table rc-ptable"><thead><tr><th>Vencimento</th><th>Pagador</th><th>Descrição</th><th class="num">Valor</th><th>Recebido</th></tr></thead>
    <tbody>${rows.map(r => html`<tr><td class="nowrap">${fmtDate(r.due_date)}</td><td>${r.kind === 'rt' ? html`<span class="pill pill-sand">RT</span> ` : ''}${r.payer || '—'}</td><td>${[r.description, r.installment].filter(Boolean).join(' · ') || '—'}${r.obra ? html`<div class="t-sub">${r.obra}</div>` : ''}</td>
      <td class="num">${money(r.amount)}</td><td class="nowrap">${r.received_date ? html`${fmtDate(r.received_date)}<div class="t-sub">${money(r.received_amount)}</div>` : html`<span class="m-badge ${r.due_date < new Date().toISOString().slice(0, 10) ? 'rc-late' : 'm-billed'}">em aberto</span>`}</td></tr>`)}</tbody></table></div>`;
  return html`
    <section class="card section">
      <div class="card-head"><h2>${icon('file')}Prévia</h2><span class="sub">${p.files.map(f => `${f.name} (${f.rows})`).join(' · ')}</span></div>
      <div class="card-body">
        <div class="ct-tiles rc-tiles">
          <div class="ct-tile"><span>Lançamentos</span><b>${p.total_rows}</b><small>${nNew} novo(s)${nUpd ? ` · ${nUpd} com baixa nova` : ''}${nSame ? ` · ${nSame} já importado(s)` : ''}</small></div>
          <div class="ct-tile"><span>Contratos (obras)</span><b>${p.groups.length}</b><small>${created} novo(s) · ${p.groups.length - created} já cadastrado(s)</small></div>
          <div class="ct-tile"><span>Recebido</span><b>${money(sum(p.groups, 'received'))}</b><small>${sum(p.groups, 'rt_count')} RT incluída(s)</small></div>
          <div class="ct-tile"><span>A receber</span><b>${money(sum(p.groups, 'open'))}</b><small>${money(sum(p.groups, 'overdue'))} vencido</small></div>
          <div class="ct-tile"><span>Outras entradas</span><b>${money(p.others.received + p.others.open)}</b><small>${p.others.count} sem contrato</small></div>
        </div>
        ${p.warnings.length ? html`<div class="rc-warn">${icon('alert')}<div><b>${p.warnings.length} linha(s) ignorada(s)</b><ul>${p.warnings.slice(0, 10).map(w => html`<li>${w}</li>`)}</ul></div></div>` : ''}
        <p class="hint" style="margin:10px 0 0">Cada obra vira um contrato do cliente que mais pagou. A RT (fornecedor) fica no contrato da obra. Escolha abaixo se a obra cria um contrato novo, junta com outra obra ou entra num contrato já cadastrado.</p>
      </div>
    </section>
    <section class="card section">
      <div class="card-head"><h2>${icon('contract')}Obras → contratos</h2><span class="sub">${p.groups.length} obra(s)</span></div>
      <div class="rc-groups">${p.groups.map(g => html`<div class="rc-group ${g.new_rows ? '' : 'is-done'}">
        <div class="rc-group-h"><div class="rc-group-t"><b>${g.obra}</b><small>${g.client}${g.payers.length > 1 ? ` · +${g.payers.length - 1} pagador(es)` : ''} · ${fmtDate(g.first_due)} → ${fmtDate(g.last_due)}</small></div>
          <div class="rc-group-n"><span>${g.count} lanç.${g.rt_count ? ` · ${g.rt_count} RT` : ''}</span><b>${money(g.received)}</b>${g.open ? html`<small class="${g.overdue ? 'is-late' : ''}">a receber ${money(g.open)}${g.overdue ? ` · vencido ${money(g.overdue)}` : ''}</small>` : ''}</div></div>
        <div class="rc-group-f"><label class="sr-only" for="rcm-${g.key}">Contrato de ${g.obra}</label>
          <select id="rcm-${g.key}" data-rcmap="${g.key}">${opts(g)}</select>
          ${g.new_rows !== g.count ? html`<span class="pill">${g.same_rows} já importado(s)${g.update_rows ? ` · ${g.update_rows} baixa(s) nova(s)` : ''}</span>` : ''}</div>
        <details><summary>Ver lançamentos</summary>${rowsTable(g.rows)}</details>
      </div>`)}</div>
    </section>
    ${p.others.count ? html`<section class="card section">
      <div class="card-head"><h2>${icon('wallet')}Outras entradas (sem contrato)</h2><span class="sub">${p.others.count} lançamento(s)</span></div>
      <div class="card-body"><p class="hint" style="margin:0 0 8px">Aporte de sócio, empréstimo, reembolso e linhas sem obra: ficam em Contratos › Outras entradas, fora do faturamento.</p>${rowsTable(p.others.rows)}</div>
    </section>` : ''}
    <div class="rc-confirm"><button type="button" class="btn btn-accent" data-rc-apply ${nNew || nUpd ? '' : 'disabled'}>${icon('check')}${nNew || nUpd ? `Importar ${nNew} lançamento(s)${nUpd ? ` e ${nUpd} baixa(s)` : ''}` : 'Nada novo para importar'}</button></div>`;
}

export async function importPage({ state, navigate }) {
  denied(state);
  return {
    title: 'Importar recebimentos',
    html: html`${pageHead({ back: { href: '#/contratos', label: 'Contratos' }, eyebrow: 'Contratos', title: 'Importar recebimentos',
        sub: 'Planilhas do financeiro (.xlsx, com Data de Vencimento, Cliente, Obra, Total da Parcela…). Primeiro você confere a prévia; nada é gravado antes de confirmar.' })}
      <section class="card section">
        <div class="card-body rc-pick">
          <label class="rc-drop" for="rc-files">${icon('file')}<span><b>Escolher planilhas</b><small>pode selecionar várias (ex.: 2024, 2025 e 2026)</small></span></label>
          <input type="file" id="rc-files" accept=".xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" multiple hidden>
          <ul class="rc-files" data-rc-names></ul>
          <button type="button" class="btn btn-primary" data-rc-read disabled>Ler e mostrar prévia</button>
          <p class="hint" style="margin:0">Reenviar a mesma planilha não duplica: o que já foi importado é ignorado e as parcelas que foram recebidas depois ganham a baixa.</p>
        </div>
      </section>
      <div data-rc-preview></div>`,
    mount(root) {
      const input = root.querySelector('#rc-files'), names = root.querySelector('[data-rc-names]'), read = root.querySelector('[data-rc-read]'), out = root.querySelector('[data-rc-preview]');
      let files = [];
      input.addEventListener('change', () => {
        files = [...input.files].filter(f => /\.xlsx$/i.test(f.name));
        names.innerHTML = files.map(f => html`<li>${icon('file')}${f.name} <small>${Math.max(1, Math.round(f.size / 1024))} KB</small></li>`).join('');
        read.disabled = !files.length;
        out.innerHTML = '';
        if (files.length < input.files.length) toast('Só arquivos .xlsx são aceitos.', 'error');
      });
      let payload = null;
      read.addEventListener('click', async () => {
        read.disabled = true; read.textContent = 'Lendo…';
        try {
          payload = await Promise.all(files.map(async f => ({ name: f.name, data: await readB64(f) })));
          const p = await api('/receipts/import/preview', { method: 'POST', body: { files: payload } });
          out.innerHTML = previewHtml(p).toString();
          out.scrollIntoView({ behavior: 'smooth', block: 'start' });
          out.querySelector('[data-rc-apply]')?.addEventListener('click', async ev => {
            const btn = ev.currentTarget;
            const mapping = Object.fromEntries([...out.querySelectorAll('[data-rcmap]')].map(s => [s.dataset.rcmap, /^\d+$/.test(s.value) ? Number(s.value) : s.value]));
            btn.disabled = true; btn.textContent = 'Importando…';
            try {
              const r = await api('/receipts/import', { method: 'POST', body: { files: payload, mapping } });
              toast(`${r.inserted} lançamento(s) importado(s)${r.updated ? `, ${r.updated} baixa(s)` : ''}${r.contracts_created.length ? ` · ${r.contracts_created.length} contrato(s) criado(s)` : ''}.`);
              navigate('/contratos?status=todos');
            } catch (ex) { toast(ex.message, 'error'); btn.disabled = false; btn.textContent = 'Tentar de novo'; }
          });
        } catch (ex) { toast(ex.message, 'error'); }
        read.disabled = false; read.textContent = 'Ler e mostrar prévia';
      });
    },
  };
}
