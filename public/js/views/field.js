// Folha de Campo: folhas por obra (diárias da mão de obra própria e % das empreitadas), profissionais, empreitadas e consolidado.
// Valores, documento e PIX aparecem só para quem tem a seção Folha de Campo (que também fecha a folha e gera o pagamento).
import { html, api, icon, fmtDate, todayISO } from '../core.js';
import { toast, sheet, confirmSheet, readAttachments, batchBySize, isPdfFile } from '../ui.js';
import { pageHead } from './shared.js';

const BRL = new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' });
const money = v => BRL.format(Number(v) || 0);
const n2 = v => String(Math.round((Number(v) || 0) * 100) / 100).replace('.', ',');
const dm = d => (d ? fmtDate(d).slice(0, 5) : '—');
const WD = ['Dom', 'Seg', 'Ter', 'Qua', 'Qui', 'Sex', 'Sáb'];
const wd = d => new Date(`${d}T12:00:00Z`).getUTCDay();
const addDays = (d, n) => { const x = new Date(`${d}T12:00:00Z`); x.setUTCDate(x.getUTCDate() + n); return x.toISOString().slice(0, 10); };
const stTag = st => html`<span class="pf-st pf-st-${st}">${st === 'fechada' ? 'Fechada' : 'Aberta'}</span>`;
const payTag = p => (!p ? '' : p.status === 'paga' ? html`<span class="fc-pay fc-pay-ok">Pago</span>` : html`<span class="fc-pay">A pagar ${fmtDate(p.due_date)}</span>`);
const qLabel = q => (q === 1 ? '1' : q === 0.5 ? '½' : q ? n2(q) : '');
const NEXT = { 0: 1, 1: 0.5, 0.5: 0 };
const num = v => { const n = Number(String(v ?? '').replace(',', '.')); return Number.isFinite(n) ? n : 0; };
const fieldTabs = (cur, obra) => html`<nav class="fc-tabs">
  <a href="#/campo${obra ? `?obra=${obra}` : ''}" class="${cur === 'folhas' ? 'on' : ''}">Folhas</a>
  <a href="#/campo/profissionais${obra ? `?obra=${obra}` : ''}" class="${cur === 'prof' ? 'on' : ''}">Profissionais</a>
  <a href="#/campo/empreitadas${obra ? `?obra=${obra}` : ''}" class="${cur === 'emp' ? 'on' : ''}">Empreitadas</a>
  <a href="#/campo/pagamentos${obra ? `?obra=${obra}` : ''}" class="${cur === 'pag' ? 'on' : ''}" data-money-tab>Pagamentos</a>
  <a href="#/campo/resumo${obra ? `?obra=${obra}` : ''}" class="${cur === 'ana' ? 'on' : ''}" data-money-tab>Resumo e análise</a>
  ${cur === 'cons' || obra ? html`<a href="#/campo/consolidado?obra=${obra || ''}" class="${cur === 'cons' ? 'on' : ''}" data-money-tab>Consolidado</a>` : ''}</nav>`;

// ---------- Obras (entrada da Folha de Campo) ----------
const PST = { planejamento: 'Planejamento', em_andamento: 'Em andamento', pausado: 'Pausada', concluido: 'Concluída', cancelado: 'Cancelada' };
function obrasView(d) {
  const mny = d.can_money;
  const card = o => html`<a class="pf-mcard fc-ocard" href="#/campo?obra=${o.id}">
    <div class="pf-mtop"><b>${o.code}</b>${o.open ? html`<span class="pf-st pf-st-aberta">${o.open} aberta(s)</span>` : html`<span class="fc-ost">${PST[o.status] || ''}</span>`}</div>
    <div class="fc-oname">${o.name}</div>
    ${o.client ? html`<div class="pf-mper">${o.client}</div>` : ''}
    <div class="pf-mper">${o.last ? `Última: ${o.last.code} · ${dm(o.last.start_date)} a ${dm(o.last.end_date)}` : 'Nenhuma folha ainda'}</div>
    ${mny && o.sheets ? html`<div class="pf-mtotal">${money(o.total)}</div>` : ''}
    <div class="pf-mfoot"><span>${o.sheets} folha(s)</span><span>${n2(o.diarias)} diária(s)</span>${o.workers ? html`<span>${o.workers} profissional(is)</span>` : ''}${o.contracts ? html`<span>${o.contracts} empreitada(s)</span>` : ''}
      ${mny && o.pending ? html`<span class="fc-pay">A pagar ${money(o.pending)}</span>` : ''}</div>
  </a>`;
  const active = d.overview.filter(o => !['concluido', 'cancelado'].includes(o.status) || o.open);
  const ended = d.overview.filter(o => !active.includes(o));
  return {
    title: 'Folha de Campo',
    html: html`
      ${pageHead({ eyebrow: 'Gestão de Obras', title: 'Folha de Campo', sub: 'Escolha a obra para ver o resumo e criar ou abrir as folhas (diárias da mão de obra própria e % das empreitadas).' })}
      ${fieldTabs('folhas', 0)}
      ${d.overview.length ? html`<div class="pf-months fc-obras">${active.map(card)}</div>
        ${ended.length ? html`<details class="section fc-ended"><summary>Obras concluídas ou canceladas (${ended.length})</summary><div class="pf-months fc-obras">${ended.map(card)}</div></details>` : ''}`
        : html`<div class="empty-state"><h2>Nenhuma obra liberada</h2><p>A Folha de Campo aparece para o responsável e os gestores de cada obra.</p></div>`}`,
    mount(root) { if (!mny) root.querySelectorAll('[data-money-tab]').forEach(x => x.remove()); },
  };
}

// ---------- Medição do terceiro (BM) x folhas ----------
// Medido acima das folhas = pago a menos (sobra); folhas acima do medido = pago a mais
const MEAS_RES = {
  pago_mais: { label: 'Pago a mais', cls: 'fm-mais' },
  pago_menos: { label: 'Pago a menos', cls: 'fm-menos' },
  igual: { label: 'Igual ao medido', cls: 'fm-igual' },
  sem_folhas: { label: 'Sem folhas ligadas', cls: 'fm-sem' },
};
const diffBadge = (result, diff) => { const r = MEAS_RES[result] || MEAS_RES.sem_folhas; return html`<span class="fm-badge ${r.cls}">${r.label}${['pago_mais', 'pago_menos'].includes(result) ? ` ${money(Math.abs(diff))}` : ''}</span>`; };
const resultOf = (amount, total, n) => (!n ? 'sem_folhas' : Math.abs(amount - total) < 0.005 ? 'igual' : amount > total ? 'pago_menos' : 'pago_mais');
const bmLink = f => html`<a class="fm-file" href="/api/field-measurement-files/${f.id}" target="_blank" rel="noopener">${icon(f.mime === 'application/pdf' ? 'file' : 'image')}${f.original_name || (f.mime === 'application/pdf' ? 'BM.pdf' : 'BM (imagem)')}</a>`;
function measSection(m) {
  const t = m.totals;
  return html`<section class="card section fm-card"><div class="card-head"><h2>${icon('contract')}Medição do terceiro</h2>
      <button type="button" class="btn btn-ghost btn-sm" data-meas-new>${icon('plus')}Nova medição</button></div>
    ${m.measurements.length ? html`<div class="pf-kpis fm-kpis">
        <div><span>Medido (BM)</span><b>${money(t.measured)}</b><small>${m.measurements.length} medição(ões)</small></div>
        <div><span>Folhas cobertas</span><b>${money(t.covered)}</b><small>mão de obra + empreitadas</small></div>
        <div><span>Pago a mais até agora</span><b class="${t.paid_more > 0.004 ? 'fm-neg' : ''}">${money(t.paid_more)}</b><small>folhas acima do medido</small></div>
        <div><span>Sobrando da medição</span><b class="${t.left_over > 0.004 ? 'fm-pos' : ''}">${money(t.left_over)}</b><small>medido acima das folhas</small></div>
        <div><span>Saldo (medido − folhas)</span><b class="${t.diff < -0.004 ? 'fm-neg' : t.diff > 0.004 ? 'fm-pos' : ''}">${money(t.diff)}</b>${diffBadge(resultOf(t.measured, t.covered, m.sheets.length - t.uncovered_sheets), t.diff)}</div>
        <div><span>Folhas sem medição</span><b>${t.uncovered_sheets}</b><small>${money(t.uncovered_total)}</small></div>
      </div>
      <ul class="fm-list">${m.measurements.map(x => html`<li class="fm-item">
        <div class="fm-top"><div><b>${x.supplier || 'Terceiro'}</b><small>Medição de ${fmtDate(x.ref_date)}</small></div>
          <button type="button" class="btn btn-ghost btn-sm" data-meas-ed="${x.id}">${icon('edit')}Editar</button></div>
        <div class="fm-cmp">
          <div><span>Medido</span><b>${money(x.amount)}</b></div>
          <div><span>Folhas (${x.sheets.length})</span><b>${money(x.sheets_total)}</b></div>
          <div><span>Diferença</span><b class="${x.diff < -0.004 ? 'fm-neg' : x.diff > 0.004 ? 'fm-pos' : ''}">${money(x.diff)}</b></div>
          ${diffBadge(x.result, x.diff)}
        </div>
        ${x.sheets.length ? html`<div class="fm-sheets">${x.sheets.map(s => html`<a href="#/campo/${s.id}">${s.code} <small>${dm(s.start_date)}–${dm(s.end_date)} · ${money(s.total)}</small></a>`)}</div>` : ''}
        ${x.files.length ? html`<div class="fm-files">${x.files.map(bmLink)}</div>` : html`<p class="fc-warn fm-nofile">${icon('alert')}BM não anexado</p>`}
        ${x.notes ? html`<p class="muted fm-notes">${x.notes}</p>` : ''}
      </li>`)}</ul>`
    : html`<p class="muted card-body">Quando o terceiro medir o serviço desta obra, lance aqui o valor da medição, anexe o BM e escolha as folhas que ela deveria cobrir. O sistema mostra se a folha ficou acima (pago a mais) ou abaixo (pago a menos) do medido.</p>`}
  </section>`;
}
function measForm(m, x, obra, done) {
  const sheets = m.sheets.filter(s => !s.measurement_id || s.measurement_id === x?.id);
  const sel = new Set((x?.sheets || []).map(s => s.id));
  const p = sheet({
    title: x ? 'Editar medição do terceiro' : 'Nova medição do terceiro',
    wide: true,
    body: html`<div class="form-row"><div class="field"><label for="fm-s">Terceiro</label><input type="text" id="fm-s" name="supplier" maxlength="120" list="fm-sup" value="${x?.supplier || ''}" placeholder="Empresa ou pessoa que mediu">
        <datalist id="fm-sup">${m.suppliers.map(s => html`<option value="${s}">`)}</datalist></div>
      <div class="field"><label class="req" for="fm-d">Data da medição</label><input type="date" id="fm-d" name="ref_date" required value="${x?.ref_date || todayISO()}"></div></div>
      <div class="field"><label class="req" for="fm-v">Valor da medição (BM)</label><input type="number" step="0.01" min="0" id="fm-v" name="amount" required value="${x?.amount ?? ''}"></div>
      <fieldset class="field fw-obras"><legend>Folhas que a medição deveria cobrir</legend>
        ${sheets.length ? html`<div class="fw-ob">${sheets.map(s => html`<label><input type="checkbox" data-fm-sheet="${s.id}" data-total="${s.total}" ${sel.has(s.id) ? 'checked' : ''}><span><b>${s.code}</b> ${fmtDate(s.start_date)} a ${fmtDate(s.end_date)} · ${money(s.total)}${s.status === 'aberta' ? ' · aberta' : ''}</span></label>`)}</div>`
          : html`<p class="muted">Todas as folhas desta obra já estão em outra medição.</p>`}</fieldset>
      <div class="fm-live" id="fm-live"></div>
      <div class="field"><label for="fm-f">Anexar BM (PDF)</label><input type="file" id="fm-f" accept="application/pdf,.pdf" multiple>
        <span class="hint">Somente PDF, até 8 MB por arquivo. No relatório, o BM é unido ao final do PDF.</span>
        ${x?.files.length ? html`<div class="fm-files fm-files-ed">${x.files.map(f => html`<span>${bmLink(f)}<button type="button" class="icon-btn" data-fm-rmf="${f.id}" aria-label="Remover ${f.original_name || 'arquivo'}">${icon('x')}</button></span>`)}</div>` : ''}</div>
      <div class="field"><label for="fm-n">Observações</label><textarea id="fm-n" name="notes" rows="2">${x?.notes || ''}</textarea></div>
      ${x ? html`<button type="button" class="btn btn-ghost btn-sm pf-danger" id="fm-del" data-close>${icon('trash')}Excluir medição</button>` : ''}`,
    submitLabel: x ? 'Salvar' : 'Lançar medição',
    async onSubmit(f, form) {
      const body = { ...f, project_id: obra, sheet_ids: [...form.querySelectorAll('[data-fm-sheet]:checked')].map(c => Number(c.dataset.fmSheet)) };
      // BM vai junto no mesmo envio; se for grande demais, o restante segue em lotes depois
      const picked = [...(form.querySelector('#fm-f').files || [])];
      const notPdf = picked.find(x => !isPdfFile(x));
      if (notPdf) throw new Error(`O BM precisa ser PDF ("${notPdf.name}" não é).`);
      const parts = batchBySize(await readAttachments(picked));
      const r = await api(x ? `/field/measurements/${x.id}` : '/field/measurements', { method: x ? 'PUT' : 'POST', body: { ...body, files: parts[0] || [] } });
      for (const part of parts.slice(1)) await api(`/field/measurements/${r.id}/files`, { method: 'POST', body: { files: part } });
      return r;
    },
  });
  // Comparação ao vivo: valor da medição x folhas marcadas
  const live = document.getElementById('fm-live'), form = live.closest('form');
  let del = false;
  const upd = () => {
    const marked = [...form.querySelectorAll('[data-fm-sheet]:checked')];
    const total = marked.reduce((a, c) => a + Number(c.dataset.total), 0), amount = num(form.querySelector('#fm-v').value);
    live.innerHTML = html`<span>Folhas marcadas: <b>${money(total)}</b> (${marked.length})</span><span>Diferença: <b>${money(amount - total)}</b></span>${diffBadge(resultOf(amount, total, marked.length), amount - total)}`.toString();
  };
  form.addEventListener('input', upd); form.addEventListener('change', upd); upd();
  form.querySelectorAll('[data-fm-rmf]').forEach(b => b.addEventListener('click', async () => {
    try { await api(`/field/measurements/${x.id}/files/${b.dataset.fmRmf}`, { method: 'DELETE' }); b.parentElement.remove(); toast('Arquivo removido.'); x.files = x.files.filter(f => f.id !== Number(b.dataset.fmRmf)); }
    catch (ex) { toast(ex.message, 'error'); }
  }));
  document.getElementById('fm-del')?.addEventListener('click', () => { del = true; });
  return p.then(async r => {
    if (del) {
      if (!(await confirmSheet('Excluir medição', `Excluir a medição de ${money(x.amount)}${x.supplier ? ` (${x.supplier})` : ''}? O BM anexado também é apagado. As folhas não mudam.`, 'Excluir', true))) return done(false);
      try { await api(`/field/measurements/${x.id}`, { method: 'DELETE' }); toast('Medição excluída.'); } catch (ex) { toast(ex.message, 'error'); }
      return done(true);
    }
    if (r) toast(x ? 'Medição salva.' : 'Medição lançada.');
    return done(!!r || !!x);
  });
}
function bindMeasurements(root, m, obra, render) {
  root.querySelector('[data-meas-new]')?.addEventListener('click', () => measForm(m, null, obra, ch => ch && render()));
  root.querySelectorAll('[data-meas-ed]').forEach(b => b.addEventListener('click', () => measForm(m, m.measurements.find(x => x.id === Number(b.dataset.measEd)), obra, ch => ch && render())));
}

// ---------- Folhas da obra (resumo + folhas) ----------
export async function list({ query, navigate, state, render }) {
  const obra = Number(query.get('obra')) || 0;
  const d = await api('/field/sheets', { query: { obra: obra || '' } });
  if (!obra || !d.projects.some(p => p.id === obra)) return obrasView(d);
  const mny = d.can_money;
  const meas = mny ? await api('/field/measurements', { query: { obra } }) : null;
  const measOf = new Map((meas?.sheets || []).filter(x => x.measurement_id).map(x => [x.id, x.measurement_id]));
  const o = d.overview.find(x => x.id === obra);
  const projOpts = sel => d.projects.map(p => html`<option value="${p.id}" ${sel === p.id ? 'selected' : ''}>${p.code} · ${p.name}</option>`);
  const kp = (l, v, sub) => html`<div><span>${l}</span><b>${v}</b>${sub ? html`<small>${sub}</small>` : ''}</div>`;
  return {
    title: `${o.code} · Folha de Campo`,
    html: html`
      ${pageHead({
        back: { href: '#/campo', label: 'Voltar · Obras' },
        eyebrow: 'Folha de Campo',
        title: `${o.code} · ${o.name}`,
        sub: o.client || '',
        actions: html`<a class="btn btn-ghost" href="#/campo/relatorio?obra=${obra}">${icon('print')}Relatório</a><button type="button" class="btn btn-primary" data-new>${icon('plus')}Nova folha</button>`,
      })}
      ${fieldTabs('folhas', mny ? obra : 0)}
      <div class="fc-filter section"><label for="fc-obra">Obra</label><select id="fc-obra"><option value="">Todas as obras</option>${projOpts(obra)}</select></div>
      <section class="card section fc-resumo"><div class="card-head"><h2>${icon('dashboard')}Resumo da obra</h2></div>
        <div class="pf-kpis">
          ${kp('Folhas', o.sheets, o.open ? `${o.open} aberta(s)` : o.sheets ? 'todas fechadas' : '')}
          ${kp('Diárias', n2(o.diarias), o.last ? `última ${o.last.code}` : '')}
          ${kp('Profissionais', o.workers, html`<a href="#/campo/profissionais?obra=${obra}">ver lista</a>`)}
          ${kp('Empreitadas', o.contracts, html`<a href="#/campo/empreitadas?obra=${obra}">em andamento</a>`)}
          ${mny ? html`${kp('Total das folhas', money(o.total))}${kp('Em folhas abertas', money(o.in_open))}${kp('A pagar', money(o.pending))}${kp('Pago', money(o.paid))}` : ''}
        </div></section>
      ${meas ? measSection(meas) : ''}
      <h2 class="fc-h2 section">Folhas</h2>
      ${d.sheets.length ? html`<div class="pf-months">${d.sheets.map(s => html`<a class="pf-mcard" href="#/campo/${s.id}">
          <div class="pf-mtop"><b>${s.project_code} · ${s.code}</b>${stTag(s.status)}</div>
          <div class="pf-mper">${s.project_name}</div>
          <div class="pf-mper">${fmtDate(s.start_date)} a ${fmtDate(s.end_date)}</div>
          ${mny ? html`<div class="pf-mtotal">${money(s.totals.total)}</div>` : html`<div class="pf-mtotal">${n2(s.diarias)} diária(s)</div>`}
          <div class="pf-mfoot"><span>${s.people} pessoa(s)</span>${s.contracts ? html`<span>${s.contracts} empreitada(s)</span>` : ''}${mny ? html`<span>${n2(s.diarias)} diária(s)</span>${s.totals.client ? html`<span>Cliente ${money(s.totals.client)}</span>` : ''}${payTag(s.payment)}` : ''}
            ${measOf.has(s.id) ? html`<span class="fc-mtag">${icon('file')}Na medição do terceiro</span>` : ''}</div>
        </a>`)}</div>`
        : html`<div class="empty-state"><h2>Nenhuma folha${obra ? ' nesta obra' : ''}</h2><p>Crie a folha do período: marque as diárias de cada pessoa por dia e o % executado das empreitadas.</p></div>`}
      <button type="button" class="fab" data-new aria-label="Nova folha">${icon('plus')}</button>`,
    mount(root) {
      root.querySelector('#fc-obra').addEventListener('change', e => navigate(`/campo${e.target.value ? `?obra=${e.target.value}` : ''}`));
      if (!mny) root.querySelectorAll('[data-money-tab]').forEach(x => x.remove());
      if (meas) bindMeasurements(root, meas, obra, render);
      root.querySelectorAll('[data-new]').forEach(b => b.addEventListener('click', () => {
        if (!d.projects.length) return toast('Nenhuma obra liberada para a Folha de Campo.', 'error');
        const last = obra && d.sheets.find(s => s.project_id === obra);
        const start = last ? addDays(last.end_date, 1) : addDays(todayISO(), -6);
        const end = start > todayISO() ? start : todayISO();
        sheet({
          title: 'Nova folha de campo',
          body: html`<div class="field"><label class="req" for="nf-p">Obra</label><select id="nf-p" name="project_id" required>${d.projects.length > 1 && !obra ? html`<option value="">Escolha…</option>` : ''}${projOpts(obra)}</select></div>
            <div class="form-row"><div class="field"><label class="req" for="nf-s">Início</label><input type="date" id="nf-s" name="start_date" required value="${start}"></div>
            <div class="field"><label class="req" for="nf-e">Fim</label><input type="date" id="nf-e" name="end_date" required value="${end}"></div></div>
            <span class="hint">Período livre (até 31 dias). As pessoas da folha anterior da obra já entram na nova.</span>`,
          submitLabel: 'Criar folha',
          async onSubmit(f) {
            if (!f.project_id) throw new Error('Escolha a obra.');
            const s = await api('/field/sheets', { method: 'POST', body: f });
            toast('Folha criada.');
            navigate(`/campo/${s.id}`);
            return s;
          },
        });
      }));
    },
  };
}

// ---------- Folha ----------
export async function view({ params, navigate, render }) {
  const s = await api(`/field/sheets/${params.id}`);
  const mny = s.can.money, edit = s.can.edit;
  const st = {
    people: s.people.map(e => ({ ...e, days: { ...e.days } })),
    contracts: s.contracts.map(c => ({ ...c })),
  };
  let dirty = false;
  const pCalc = e => {
    const diarias = Object.values(e.days).reduce((a, v) => a + (Number(v) || 0), 0);
    const gross = diarias * (e.rate || 0), total = gross + num(e.adjust);
    return { diarias, gross, total, company: total - num(e.client_paid) };
  };
  const cCalc = c => { const amount = (c.contract_total || 0) * num(c.pct) / 100; return { amount, company: amount - num(c.client_paid), after: (c.before_pct || 0) + num(c.pct) }; };
  const dis = edit ? '' : 'disabled';
  const chip = (d, q) => html`<button type="button" class="fc-day ${q === 1 ? 'q1' : q ? 'qh' : ''} ${[0, 6].includes(wd(d)) ? 'we' : ''}" data-day="${d}" ${dis} aria-label="${WD[wd(d)]} ${dm(d)}: ${q || 0} diária">
      <small>${WD[wd(d)]}</small><span>${d.slice(8, 10)}</span><b>${qLabel(q)}</b></button>`;
  const dayChips = e => html`<div class="fc-days">${s.days.map(d => chip(d, Number(e.days[d]) || 0))}</div>`;
  const personCalc = e => {
    const c = pCalc(e);
    return mny ? html`${n2(c.diarias)} diária(s) × ${money(e.rate)} = <b>${money(c.gross)}</b>${num(e.adjust) ? html` · ajuste ${money(e.adjust)}` : ''}${num(e.client_paid) ? html` · cliente ${money(e.client_paid)}` : ''} · <b>empresa paga ${money(c.company)}</b>`
      : html`<b>${n2(c.diarias)} diária(s)</b>`;
  };
  // Linha compacta da pessoa (abre a janela das diárias)
  const dots = e => html`<span class="fc-dots" aria-hidden="true">${s.days.map(d => { const q = Number(e.days[d]) || 0; return html`<i class="${q === 1 ? 'q1' : q ? 'qh' : ''} ${[0, 6].includes(wd(d)) ? 'we' : ''}"></i>`; })}</span>`;
  const personRow = e => html`<li><button type="button" class="fc-prow" data-open-p="${e.worker_id}">
    <span class="fc-pw"><b>${e.name}</b><small>${e.role || 'Diarista'}${e.service ? ` · ${e.service}` : ''}</small></span>
    ${dots(e)}<span class="fc-pn">${n2(pCalc(e).diarias)} diária(s)</span>${icon('chevron')}</button></li>`;
  const contractCalc = c => {
    const x = cCalc(c);
    return html`Antes ${n2(c.before_pct)}% · nesta folha ${n2(num(c.pct))}% · acumulado <b>${n2(x.after)}%</b> · saldo ${n2(100 - x.after)}%${mny ? html` · medido <b>${money(x.amount)}</b>${num(c.client_paid) ? html` · cliente ${money(c.client_paid)}` : ''} · empresa paga <b>${money(x.company)}</b>` : ''}`;
  };
  const contractCard = c => html`<li class="fc-person" data-c="${c.contract_id}">
    <div class="fc-ph"><div><b>${c.service}</b><small>${c.worker_name}${mny ? ` · contrato ${money(c.contract_total)}` : ''}${mny && c.pix ? ` · PIX ${c.pix_type ? `(${c.pix_type}) ` : ''}${c.pix}` : ''}</small></div>
      ${edit ? html`<button type="button" class="icon-btn" data-rmc="${c.contract_id}" aria-label="Retirar empreitada da folha">${icon('x')}</button>` : ''}</div>
    <div class="fc-bar"><span style="width:${Math.min(100, c.before_pct)}%"></span><i data-bar="${c.contract_id}" style="left:${Math.min(100, c.before_pct)}%;width:${Math.min(100 - c.before_pct, num(c.pct))}%"></i></div>
    <div class="fc-pf">
      <label>% executado nesta folha<input type="number" step="0.1" min="0" max="${n2(100 - c.before_pct).replace(',', '.')}" data-cf="pct" value="${c.pct || ''}" ${dis}></label>
      ${mny ? html`<label>Pago pelo cliente<input type="number" step="0.01" min="0" data-cf="client_paid" value="${c.client_paid || ''}" ${dis}></label>` : ''}
      <label>Observação<input type="text" data-cf="notes" value="${c.notes || ''}" ${dis}></label>
    </div>
    <div class="fc-calc" data-ccalc="${c.contract_id}">${contractCalc(c)}</div>
  </li>`;
  const totals = () => {
    const ps = st.people.map(pCalc), cs = st.contracts.map(cCalc);
    const diarias = ps.reduce((a, x) => a + x.diarias, 0);
    if (!mny) return html`<div><span>Diárias</span><b>${n2(diarias)}</b></div><div><span>Pessoas</span><b>${st.people.length}</b></div><div><span>Empreitadas</span><b>${st.contracts.length}</b></div>`;
    const mo = ps.reduce((a, x) => a + x.total, 0), emp = cs.reduce((a, x) => a + x.amount, 0);
    const cli = st.people.reduce((a, e) => a + num(e.client_paid), 0) + st.contracts.reduce((a, c) => a + num(c.client_paid), 0);
    return html`<div><span>Diárias</span><b>${n2(diarias)}</b></div><div><span>Mão de obra</span><b>${money(mo)}</b></div><div><span>Empreitadas</span><b>${money(emp)}</b></div>
      <div><span>Pago pelo cliente</span><b>${money(cli)}</b></div><div class="pf-kt"><span>Empresa paga</span><b>${money(mo + emp - cli)}</b></div>`;
  };
  // Incluir pessoa: abre a janela para marcar os dias em que compareceu
  const addBar = edit ? html`<div class="card-body pf-add fc-add"><select id="fc-addp" aria-label="Profissional"><option value="">Incluir profissional…</option>${s.available_workers.map(w => html`<option value="${w.id}">${w.name}${w.role ? ` · ${w.role}` : ''}</option>`)}</select>
    <button type="button" class="btn btn-ghost btn-sm" id="fc-addb">${icon('plus')}Incluir</button>
    <button type="button" class="btn btn-ghost btn-sm" id="fc-neww">${icon('user')}Novo profissional</button></div>` : '';
  return {
    title: `${s.project.code} · ${s.code}`,
    html: html`
      ${pageHead({
        back: { href: `#/campo?obra=${s.project.id}`, label: 'Folha de Campo' },
        eyebrow: `${s.project.code} · ${s.project.name}`,
        title: html`Folha ${s.code} ${stTag(s.status)}`,
        sub: html`${fmtDate(s.start_date)} a ${fmtDate(s.end_date)}${s.status === 'fechada' ? ` · fechada por ${s.closed_by_name || '—'} em ${fmtDate(s.closed_at?.slice(0, 10))}` : ''}`,
        actions: html`${s.can.delete ? html`<button type="button" class="btn btn-ghost pf-danger" data-del>${icon('trash')}Excluir</button>` : ''}
          ${s.can.close ? html`<button type="button" class="btn btn-primary" data-close>${icon('check')}Fechar folha</button>` : ''}
          ${s.can.reopen ? html`<button type="button" class="btn btn-ghost" data-reopen>${icon('edit')}Reabrir</button>` : ''}`,
      })}
      ${!mny ? html`<div class="notice section">${icon('info')}<span>Inclua a pessoa e marque os dias em que ela compareceu (toque: 1 → ½ → vazio). Para corrigir, toque no nome dela na lista. Valores e fechamento ficam com o escritório.</span></div>` : ''}
      <div class="pf-kpis section" id="fc-tot">${totals()}</div>
      <section class="card section"><div class="card-head"><h2>${icon('reports')}Resumo da folha</h2></div><div class="card-body fr-grid" id="fc-sum"></div></section>
      ${mny ? html`<section class="card section fp-card"><div class="card-head"><h2>${icon('wallet')}${edit ? 'A pagar nesta folha' : 'Pagamentos desta folha'}</h2><span id="fc-paytot" class="fp-tot"></span>
          <button type="button" class="btn btn-ghost btn-sm" id="fc-paycopy" data-copy="" data-copy-msg="Lista de pagamentos copiada.">${icon('file')}Copiar lista</button></div>
        ${s.payment ? html`<p class="card-body fp-state">${icon('wallet')}No Financeiro: <b>${money(s.payment.amount)}</b> · vence ${fmtDate(s.payment.due_date)} · ${s.payment.status === 'paga' ? html`<span class="fc-pay fc-pay-ok">Pago</span>` : html`<span class="fc-pay">A pagar</span>`}</p>` : ''}
        <ul class="fp-list" id="fc-pay"></ul>${addBar}</section>` : ''}
      <datalist id="fc-services">${s.services.map(x => html`<option value="${x}">`)}</datalist>
      ${!mny ? html`<section class="card section">
        <div class="card-head"><h2>${icon('users')}Mão de obra própria</h2><span class="sub">${st.people.length}</span></div>
        ${st.people.length ? html`<ul class="fc-plist">${st.people.map(personRow)}</ul>` : html`<p class="muted card-body">Nenhuma pessoa nesta folha.</p>`}
        ${addBar}</section>` : ''}
      <section class="card section">
        <div class="card-head"><h2>${icon('contract')}Empreitadas</h2><span class="sub">${st.contracts.length}</span></div>
        ${st.contracts.length ? html`<ul class="fc-list">${st.contracts.map(contractCard)}</ul>` : html`<p class="muted card-body">Nenhuma empreitada medida nesta folha.</p>`}
        ${edit && s.available_contracts.length ? html`<div class="card-body pf-add fc-add"><select id="fc-addc"><option value="">Medir empreitada…</option>${s.available_contracts.map(c => html`<option value="${c.id}">${c.worker_name} · ${c.service} (saldo ${n2(c.balance_pct)}%)</option>`)}</select>
          <button type="button" class="btn btn-ghost btn-sm" id="fc-addcb">${icon('plus')}Incluir</button></div>`
          : edit && !st.contracts.length ? html`<p class="hint card-body">${mny ? html`Cadastre as empreitadas da obra em <a href="#/campo/empreitadas?obra=${s.project.id}">Empreitadas</a>.` : 'Nenhuma empreitada ativa com saldo nesta obra.'}</p>` : ''}
      </section>
      <section class="card section"><div class="card-head"><h2>${icon('note')}Atividades desenvolvidas</h2></div>
        <div class="card-body"><textarea id="fc-act" rows="4" ${dis} placeholder="Serviços executados no período, observações…">${s.activities || ''}</textarea>
        ${mny && edit ? html`<label class="fc-payd">Pagamento previsto<input type="date" id="fc-payd" value="${s.pay_date || ''}"></label>` : ''}</div></section>
      ${edit ? html`<div class="fc-save"><span id="fc-dirty" hidden>Alterações não salvas</span><button type="button" class="btn btn-primary" id="fc-save">${icon('check')}Salvar folha</button></div>` : ''}`,
    mount(root) {
      bindCopy(root);
      bindPaid(root, render);
      const markDirty = () => { dirty = true; const el = root.querySelector('#fc-dirty'); if (el) el.hidden = false; };
      const payBox = () => {
        const box = root.querySelector('#fc-pay');
        if (!box) return;
        const list = sheetPayList(st.people, st.contracts, pCalc, cCalc);
        const sum = list.reduce((a, p) => a + p.amount, 0);
        const closed = s.status === 'fechada', finPaid = s.payment?.status === 'paga';
        const open = p => (p.worker_id ? { open: p.worker_id } : {});
        const act = p => (!closed ? open(p) : p.paid_at || finPaid ? { ...open(p), paidAt: p.paid_at || s.payment?.paid_date || '', lines: p.line } : { ...open(p), canPay: true, lines: p.line });
        const pend = closed ? list.filter(p => !p.paid_at && !finPaid) : [];
        const paidSum = closed ? list.filter(p => p.paid_at || finPaid).reduce((a, p) => a + p.amount, 0) : 0;
        // Pessoas incluídas sem dia marcado (ou sem valor) também aparecem, com R$ 0,00 — tocam para lançar
        const zero = st.people.filter(e => pCalc(e).company <= 0.004).map(e => ({ worker_id: e.worker_id, name: e.name, role: e.role, pix: e.pix, pix_type: e.pix_type, amount: 0,
          what: `${e.role || 'Diarista'} · ${pCalc(e).diarias ? `${n2(pCalc(e).diarias)} diária(s)` : 'nenhum dia marcado'}` }));
        const rows = [...list.map(p => payRow(p, act(p))), ...zero.map(p => payRow(p, open(p)))];
        box.innerHTML = rows.length ? html`${!closed ? html`<li class="fp-hint">${icon('info')}Toque no nome para ver ou editar as diárias. Feche a folha para marcar os pagamentos (os valores ainda podem mudar).</li>` : ''}${payHead}${rows}
          <li class="fp-row fp-foot"><span><b>Total</b>${closed ? html`<small>Pago ${money(paidSum)} · falta ${money(sum - paidSum)}</small>` : ''}</span><span></span><strong class="fp-num fp-val">${money(sum)}</strong>
          <span class="fp-copy">${pend.length > 1 ? html`<button type="button" class="btn btn-primary btn-sm" data-pay="${pend.map(p => p.line).join(',')}" data-who="Todos que faltam (${pend.length})" data-amt="${pend.reduce((a, p) => a + p.amount, 0)}">${icon('check')}Marcar todos pagos</button>` : ''}</span></li>`.toString()
          : html`<li class="muted fp-none">Nenhuma pessoa nesta folha. Inclua abaixo e marque os dias em que ela compareceu.</li>`.toString();
        root.querySelector('#fc-paytot').textContent = list.length ? `${list.length} · ${money(list.reduce((a, p) => a + p.amount, 0))}` : '';
        root.querySelector('#fc-paycopy').dataset.copy = payText(list);
      };
      // Resumo da folha: equipe por dia, por serviço, por função e situação do pagamento
      const sumBox = () => {
        const box = root.querySelector('#fc-sum');
        const perDay = s.days.map(d => ({ d, n: st.people.filter(e => Number(e.days[d]) > 0).length, q: st.people.reduce((a, e) => a + (Number(e.days[d]) || 0), 0) }));
        const maxQ = Math.max(1, ...perDay.map(x => x.q));
        const group = key => {
          const m = new Map();
          for (const e of st.people) {
            const k = (key === 'service' ? e.service : e.role) || (key === 'service' ? 'Sem apropriação' : 'Sem função');
            const c = pCalc(e);
            const g = m.get(k) || { name: k, people: 0, diarias: 0, value: 0 };
            g.people++; g.diarias += c.diarias; g.value += c.total; m.set(k, g);
          }
          if (key === 'service') for (const c of st.contracts) { const g = m.get(c.service) || { name: c.service, people: 0, diarias: 0, value: 0, emp: true }; g.value += cCalc(c).amount; g.emp = true; m.set(c.service, g); }
          return [...m.values()].sort((a, b) => (mny ? b.value - a.value : b.diarias - a.diarias));
        };
        const svc = group('service'), fun = group('role');
        const tot = mny ? svc.reduce((a, g) => a + g.value, 0) : svc.reduce((a, g) => a + g.diarias, 0);
        const bar = v => html`<div class="fr-bar"><span style="width:${tot ? (v / tot) * 100 : 0}%"></span></div>`;
        const pay = (() => {
          if (!mny) return '';
          const list = sheetPayList(st.people, st.contracts, pCalc, cCalc);
          const total = list.reduce((a, p) => a + p.amount, 0);
          if (s.status !== 'fechada') return html`<div class="fr-block"><h3>Pagamento</h3><p class="fr-big">${money(total)}</p><small class="muted">a pagar pela empresa a ${list.length} pessoa(s) · folha aberta</small></div>`;
          const finPaid = s.payment?.status === 'paga';
          const paid = list.filter(p => p.paid_at || finPaid).reduce((a, p) => a + p.amount, 0);
          const nPaid = list.filter(p => p.paid_at || finPaid).length;
          return html`<div class="fr-block"><h3>Pagamento</h3>
            <div class="fr-pay"><div><small>Pago</small><b class="fr-ok">${money(paid)}</b><small>${nPaid} de ${list.length}</small></div><div><small>Falta pagar</small><b class="${total - paid > 0.004 ? 'fr-due' : ''}">${money(total - paid)}</b><small>${list.length - nPaid} pessoa(s)</small></div></div>
            <div class="fr-bar fr-bar-pay"><span style="width:${total ? (paid / total) * 100 : 0}%"></span></div></div>`;
        })();
        box.innerHTML = html`
          <div class="fr-block"><h3>Equipe por dia</h3><div class="fr-days">${perDay.map(x => html`<div class="fr-day" title="${WD[wd(x.d)]} ${dm(x.d)}: ${x.n} pessoa(s), ${n2(x.q)} diária(s)">
            <em>${x.n || ''}</em><div class="fr-col"><span style="height:${(x.q / maxQ) * 100}%"></span></div><small>${WD[wd(x.d)].slice(0, 1)}<br>${x.d.slice(8, 10)}</small></div>`)}</div>
            <small class="muted">${n2(perDay.reduce((a, x) => a + x.q, 0))} diária(s) · média de ${n2(perDay.filter(x => x.n).length ? perDay.reduce((a, x) => a + x.q, 0) / perDay.filter(x => x.n).length : 0)} pessoa(s) por dia trabalhado</small></div>
          <div class="fr-block"><h3>Por serviço</h3>${svc.length ? html`<ul class="fr-list">${svc.map(g => html`<li><div><span>${g.name}${g.emp ? html` <i class="fr-emp">empreitada</i>` : ''}</span><b>${mny ? money(g.value) : `${n2(g.diarias)} diária(s)`}</b></div>${bar(mny ? g.value : g.diarias)}${g.diarias ? html`<small>${n2(g.diarias)} diária(s) · ${g.people} pessoa(s)</small>` : ''}</li>`)}</ul>` : html`<p class="muted">—</p>`}</div>
          <div class="fr-block"><h3>Por função</h3>${fun.length ? html`<ul class="fr-list">${fun.map(g => html`<li><div><span>${g.name}</span><b>${mny ? money(g.value) : `${n2(g.diarias)} diária(s)`}</b></div><small>${g.people} pessoa(s) · ${n2(g.diarias)} diária(s)</small></li>`)}</ul>` : html`<p class="muted">—</p>`}</div>
          ${pay}`.toString();
      };
      const refresh = () => {
        sumBox();
        payBox();
        root.querySelector('#fc-tot').innerHTML = totals().toString();
        for (const e of st.people) { const el = root.querySelector(`[data-calc="${e.worker_id}"]`); if (el) el.innerHTML = personCalc(e).toString(); }
        for (const c of st.contracts) {
          const el = root.querySelector(`[data-ccalc="${c.contract_id}"]`); if (el) el.innerHTML = contractCalc(c).toString();
          const bar = root.querySelector(`[data-bar="${c.contract_id}"]`); if (bar) bar.style.width = `${Math.min(100 - c.before_pct, num(c.pct))}%`;
        }
      };
      payBox();
      sumBox();
      const body = () => ({
        activities: root.querySelector('#fc-act').value,
        ...(root.querySelector('#fc-payd') ? { pay_date: root.querySelector('#fc-payd').value } : {}),
        people: st.people.map(e => ({ worker_id: e.worker_id, days: e.days, service: e.service, client_paid: e.client_paid, adjust: e.adjust, adjust_note: e.adjust_note })),
        contracts: st.contracts.map(c => ({ contract_id: c.contract_id, pct: c.pct, client_paid: c.client_paid, notes: c.notes })),
      });
      const save = async (quiet = false) => {
        const r = await api(`/field/sheets/${s.id}`, { method: 'PUT', body: body() });
        dirty = false;
        if (!quiet) toast('Folha salva.');
        return r;
      };
      root.addEventListener('input', e => {
        const cf = e.target.dataset.cf;
        if (cf) { st.contracts.find(x => x.contract_id === Number(e.target.closest('[data-c]').dataset.c))[cf] = e.target.value; markDirty(); refresh(); }
        if (e.target.id === 'fc-act' || e.target.id === 'fc-payd') markDirty();
      });
      // Incluir/retirar salva o que já foi lançado e recarrega
      const saveAnd = async (fn, msg) => { try { const b = body(); fn(b); await api(`/field/sheets/${s.id}`, { method: 'PUT', body: b }); dirty = false; if (msg) toast(msg); render(); } catch (ex) { toast(ex.message, 'error'); } };

      // Janela das diárias da pessoa: abre ao incluir e ao tocar no nome dela; salva a folha ao confirmar
      const openPerson = async (workerId, base = {}) => {
        const cur = st.people.find(x => x.worker_id === workerId);
        const isNew = !cur;
        const e = cur ? { ...cur, days: { ...cur.days } } : { worker_id: workerId, name: base.name, role: base.role, rate: base.rate ?? base.daily_rate ?? 0, days: {}, service: '' };
        let remove = false;
        const done = sheet({
          title: e.name,
          wide: true,
          body: html`<p class="muted fc-pd-sub">${e.role || 'Diarista'} · ${fmtDate(s.start_date)} a ${fmtDate(s.end_date)}${edit ? ' · toque no dia: 1 → ½ → vazio' : ''}</p>
            <div id="pd-days">${dayChips(e)}</div>
            ${edit ? html`<div class="fc-pd-acts"><button type="button" class="btn btn-ghost btn-sm" id="pd-wk">Marcar seg a sex</button><button type="button" class="btn btn-ghost btn-sm" id="pd-clr">Limpar dias</button></div>` : ''}
            <div class="fc-pf">
              <label>Apropriar (serviço)<input type="text" list="fc-services" name="service" value="${e.service || ''}" ${dis} placeholder="Ex.: Demolição"></label>
              ${mny ? html`<label>Pago pelo cliente<input type="number" step="0.01" min="0" name="client_paid" value="${e.client_paid || ''}" ${dis}></label>
                <label>Ajuste (±)<input type="number" step="0.01" name="adjust" value="${e.adjust || ''}" ${dis} placeholder="desconto / adiantamento"></label>
                <label>Motivo do ajuste<input type="text" name="adjust_note" value="${e.adjust_note || ''}" ${dis}></label>` : ''}
            </div>
            <div class="fc-calc" id="pd-calc">${personCalc(e)}</div>
            ${edit && !isNew ? html`<button type="button" class="btn btn-ghost btn-sm pf-danger fc-pd-rm" id="pd-rm" data-close>${icon('x')}Retirar da folha</button>` : ''}`,
          submitLabel: !edit ? 'Fechar' : isNew ? 'Incluir na folha' : 'Salvar',
          async onSubmit(f) {
            if (!edit) return true;
            Object.assign(e, { service: f.service }, mny ? { client_paid: f.client_paid, adjust: f.adjust, adjust_note: f.adjust_note } : {});
            const b = body();
            const row = { worker_id: e.worker_id, days: e.days, service: e.service, client_paid: e.client_paid, adjust: e.adjust, adjust_note: e.adjust_note };
            b.people = isNew ? [...b.people, row] : b.people.map(x => (x.worker_id === e.worker_id ? row : x));
            await api(`/field/sheets/${s.id}`, { method: 'PUT', body: b });
            return true;
          },
        });
        const box = document.getElementById('pd-days');
        const form = box?.closest('form');
        const paint = () => {
          box.querySelectorAll('.fc-day').forEach(c => { const q = Number(e.days[c.dataset.day]) || 0; c.classList.toggle('q1', q === 1); c.classList.toggle('qh', q === 0.5); c.querySelector('b').textContent = qLabel(q); });
          document.getElementById('pd-calc').innerHTML = personCalc(e).toString();
        };
        if (edit && box) {
          box.addEventListener('click', ev => {
            const c = ev.target.closest('.fc-day');
            if (!c) return;
            const q = NEXT[Number(e.days[c.dataset.day]) || 0] ?? 0;
            if (q) e.days[c.dataset.day] = q; else delete e.days[c.dataset.day];
            paint();
          });
          document.getElementById('pd-wk').addEventListener('click', () => { for (const d of s.days) if (wd(d) >= 1 && wd(d) <= 5) e.days[d] = 1; paint(); });
          document.getElementById('pd-clr').addEventListener('click', () => { e.days = {}; paint(); });
          form.addEventListener('input', ev => { if (['client_paid', 'adjust'].includes(ev.target.name)) { e[ev.target.name] = ev.target.value; paint(); } });
          document.getElementById('pd-rm')?.addEventListener('click', () => { remove = true; });
        }
        const r = await done;
        if (remove) {
          if (!(await confirmSheet('Retirar da folha', `Retirar ${e.name} desta folha? As diárias marcadas serão perdidas.`, 'Retirar', true))) return;
          return saveAnd(x => { x.people = x.people.filter(y => y.worker_id !== e.worker_id); }, `${e.name} retirado(a) da folha.`);
        }
        if (r && edit) { dirty = false; toast(isNew ? `${e.name} incluído(a) na folha.` : 'Diárias salvas.'); render(); }
      };
      root.addEventListener('click', ev => {
        const b = ev.target.closest('[data-open-p]');
        if (b) openPerson(Number(b.dataset.openP));
      });
      root.querySelectorAll('[data-rmc]').forEach(b => b.addEventListener('click', () => saveAnd(x => { x.contracts = x.contracts.filter(y => y.contract_id !== Number(b.dataset.rmc)); })));
      root.querySelector('#fc-addb')?.addEventListener('click', () => {
        const v = Number(root.querySelector('#fc-addp').value);
        if (!v) return toast('Escolha o profissional.', 'error');
        openPerson(v, s.available_workers.find(w => w.id === v));
      });
      root.querySelector('#fc-addp')?.addEventListener('change', ev => { const v = Number(ev.target.value); if (v) openPerson(v, s.available_workers.find(w => w.id === v)); });
      root.querySelector('#fc-addcb')?.addEventListener('click', () => {
        const v = Number(root.querySelector('#fc-addc').value);
        if (v) saveAnd(x => { x.contracts.push({ contract_id: v, pct: 0 }); });
      });
      root.querySelector('#fc-neww')?.addEventListener('click', () => workerSheet(null, mny, async w => { setTimeout(() => openPerson(w.id, w), 220); }, { obra: s.project.id }));
      root.querySelector('#fc-save')?.addEventListener('click', async e => {
        e.target.disabled = true;
        try { await save(); render(); } catch (ex) { toast(ex.message, 'error'); e.target.disabled = false; }
      });
      root.querySelector('[data-del]')?.addEventListener('click', async () => {
        if (!(await confirmSheet('Excluir folha', `Excluir a folha ${s.code} de ${s.project.code}? As diárias e medições lançadas nela serão apagadas.`, 'Excluir', true))) return;
        try { await api(`/field/sheets/${s.id}`, { method: 'DELETE' }); dirty = false; toast('Folha excluída.'); navigate(`/campo?obra=${s.project.id}`); } catch (ex) { toast(ex.message, 'error'); }
      });
      root.querySelector('[data-close]')?.addEventListener('click', async () => {
        try { if (dirty) await save(true); } catch (ex) { return toast(ex.message, 'error'); }
        const r = await api(`/field/sheets/${s.id}`);
        const pd = root.querySelector('#fc-payd')?.value || r.pay_date || todayISO();
        const ok = await sheet({
          title: `Fechar a folha ${s.code}`,
          body: html`<p class="muted" style="margin-top:0">Total ${money(r.totals.total)} · pago pelo cliente ${money(r.totals.client)}. Os valores, diárias e PIX ficam congelados e é gerado o pagamento de <b>${money(Math.max(0, r.totals.company))}</b> (parte da empresa) no Financeiro, com a lista de PIX por pessoa. Para corrigir depois, use Reabrir.</p>
            <div class="field"><label class="req" for="fc-cpd">Vencimento do pagamento</label><input type="date" id="fc-cpd" name="pay_date" required value="${pd}"></div>`,
          submitLabel: 'Fechar e gerar pagamento',
          onSubmit: f => api(`/field/sheets/${s.id}/close`, { method: 'POST', body: f }),
        });
        if (ok) { toast(ok.generated ? 'Folha fechada. Pagamento gerado no Financeiro.' : 'Folha fechada (sem valor a pagar pela empresa).'); render(); }
      });
      root.querySelector('[data-reopen]')?.addEventListener('click', async () => {
        if (!(await confirmSheet('Reabrir a folha', 'O pagamento pendente gerado por esta folha será removido do Financeiro e gerado de novo no próximo fechamento. Se já foi pago, desfaça o pagamento antes.', 'Reabrir', true))) return;
        try { await api(`/field/sheets/${s.id}/reopen`, { method: 'POST' }); toast('Folha reaberta.'); render(); } catch (ex) { toast(ex.message, 'error'); }
      });
      // Aviso ao sair com alterações não salvas
      const onLeave = e => { if (dirty && root.isConnected) { e.preventDefault(); e.returnValue = ''; } };
      window.addEventListener('beforeunload', onLeave);
      window.addEventListener('hashchange', function off() {
        if (root.isConnected) return;
        window.removeEventListener('beforeunload', onLeave); window.removeEventListener('hashchange', off);
      });
    },
  };
}

// ---------- Profissionais ----------
async function workerSheet(w, mny, done, { pixTypes = ['CPF', 'CNPJ', 'Telefone', 'E-mail', 'Aleatória'], leaders = null, projects = null, obra = 0 } = {}) {
  const v = w || { kind: 'diarista', active: 1 };
  // Líder: pessoa da equipe interna; no organograma ela mostra a equipe de campo por função
  const base = leaders && projects ? null : await api('/field/workers');
  const ld = [...(leaders || base.leaders || [])];
  const obras = projects || base.projects || [];
  if (v.leader_id && !ld.some(x => x.id === v.leader_id)) ld.push({ id: v.leader_id, name: v.leader_name || 'Líder atual', is_external: v.leader_external });
  const ldOpt = x => html`<option value="${x.id}" ${x.id === v.leader_id ? 'selected' : ''}>${x.name}${x.job_title ? ` · ${x.job_title}` : ''}</option>`;
  // Obras em que o profissional aparece; no cadastro feito dentro de uma obra, ela já vem marcada
  const sel = new Set(w ? v.project_ids || [] : obra ? [obra] : []);
  return sheet({
    title: w ? w.name : 'Novo profissional',
    body: html`<div class="field"><label class="req" for="fw-n">Nome</label><input type="text" id="fw-n" name="name" required maxlength="120" value="${v.name || ''}"></div>
      <div class="form-row"><div class="field"><label for="fw-k">Tipo</label><select id="fw-k" name="kind"><option value="diarista" ${v.kind === 'diarista' ? 'selected' : ''}>Diarista (mão de obra própria)</option><option value="empreiteiro" ${v.kind === 'empreiteiro' ? 'selected' : ''}>Empreiteiro</option></select></div>
        <div class="field"><label for="fw-r">Função</label><input type="text" id="fw-r" name="role" maxlength="60" value="${v.role || ''}" placeholder="Pedreiro, Ajudante, Mestre…"></div></div>
      <div class="field"><label for="fw-l">Líder</label><select id="fw-l" name="leader_id"><option value="">Sem líder</option>
          <optgroup label="Equipe">${ld.filter(x => !x.is_external).map(ldOpt)}</optgroup>
          ${ld.some(x => x.is_external) ? html`<optgroup label="Terceirizados">${ld.filter(x => x.is_external).map(ldOpt)}</optgroup>` : ''}</select>
        <span class="hint">Qualquer pessoa do organograma, inclusive terceirizados. No organograma, o líder mostra quantas pessoas por função estão ligadas a ele.</span></div>
      <fieldset class="field fw-obras"><legend>Obras em que aparece</legend>
        ${obras.length ? html`<div class="fw-ob">${obras.map(p => html`<label><input type="checkbox" data-obra="${p.id}" ${sel.has(p.id) ? 'checked' : ''}><span><b>${p.code}</b> ${p.name}</span></label>`)}</div>` : html`<p class="muted">Nenhuma obra liberada.</p>`}
        <span class="hint">O profissional aparece para incluir nas folhas (e nas empreitadas) só das obras marcadas. Sem nenhuma marcada, aparece em todas.</span></fieldset>
      ${mny ? html`<div class="form-row"><div class="field"><label for="fw-d">Valor da diária</label><input type="number" step="0.01" min="0" id="fw-d" name="daily_rate" value="${v.daily_rate ?? ''}"></div>
          <div class="field"><label for="fw-doc">CPF / CNPJ</label><input type="text" id="fw-doc" name="doc" maxlength="30" value="${v.doc || ''}"></div></div>
        <div class="form-row"><div class="field"><label for="fw-pt">Tipo do PIX</label><select id="fw-pt" name="pix_type"><option value="">—</option>${pixTypes.map(t => html`<option ${v.pix_type === t ? 'selected' : ''}>${t}</option>`)}</select></div>
          <div class="field"><label for="fw-p">Chave PIX</label><input type="text" id="fw-p" name="pix" maxlength="120" value="${v.pix || ''}"></div></div>
        <div class="field"><label for="fw-ph">Telefone</label><input type="text" id="fw-ph" name="phone" maxlength="30" value="${v.phone || ''}"></div>
        <div class="field"><label for="fw-no">Observações</label><textarea id="fw-no" name="notes" rows="2">${v.notes || ''}</textarea></div>
        ${w ? html`<label class="pr-se-check"><input type="checkbox" name="active" value="1" ${v.active ? 'checked' : ''}> Ativo</label>` : ''}`
        : html`<span class="hint">Valor da diária, documento e PIX são preenchidos pelo escritório.</span>`}`,
    submitLabel: w ? 'Salvar' : 'Cadastrar',
    async onSubmit(f, form) {
      if (w) f.active = f.active ? 1 : 0;
      f.project_ids = [...form.querySelectorAll('[data-obra]:checked')].map(x => Number(x.dataset.obra));
      const r = await api(w ? `/field/workers/${w.id}` : '/field/workers', { method: w ? 'PUT' : 'POST', body: f });
      await done?.(r);
      return r;
    },
  });
}

export async function workers({ render, query, navigate }) {
  const d = await api('/field/workers');
  const sit = ['inativos', 'todos'].includes(query.get('sit')) ? query.get('sit') : 'ativos';
  const obra = Number(query.get('obra')) || 0;
  // Filtro por obra: os ligados a ela e os sem obra escolhida (aparecem em todas)
  const inObra = w => !obra || !w.project_ids.length || w.project_ids.includes(obra);
  const base = d.workers.filter(inObra);
  const shown = base.filter(w => sit === 'todos' || (sit === 'ativos' ? w.active : !w.active));
  const nAt = base.filter(w => w.active).length;
  const mny = d.can_money;
  const sitHref = k => { const q = new URLSearchParams(); if (obra) q.set('obra', obra); if (k !== 'ativos') q.set('sit', k); const x = q.toString(); return `#/campo/profissionais${x ? `?${x}` : ''}`; };
  const row = w => html`<li class="fc-wrow ${w.active ? '' : 'fc-off'}"><div class="grow"><div class="row-title">${w.name}${w.active ? '' : ' (inativo)'}</div>
    <div class="row-meta"><span>${w.kind === 'empreiteiro' ? 'Empreiteiro' : 'Diarista'}</span>${w.role ? html`<span>${w.role}</span>` : ''}${w.leader_name ? html`<span>Líder: ${w.leader_name}${w.leader_external ? ' (terceirizado)' : ''}</span>` : ''}
      <span class="${w.projects.length ? '' : 'muted'}">${w.projects.length ? `Obras: ${w.projects.map(p => p.code).join(', ')}` : 'Todas as obras'}</span>${mny && w.kind === 'diarista' ? html`<span>Diária ${money(w.daily_rate)}</span>` : ''}${mny && w.pix ? html`<span>PIX ${w.pix_type ? `(${w.pix_type}) ` : ''}${w.pix}</span>` : ''}${mny && !w.daily_rate && w.kind === 'diarista' ? html`<span class="fc-warn">sem valor da diária</span>` : ''}</div></div>
    ${mny ? html`<button type="button" class="btn btn-ghost btn-sm" data-ed="${w.id}">${icon('edit')}Editar</button>` : ''}</li>`;
  const group = (k, label) => { const l = shown.filter(w => w.kind === k); return html`<section class="card section"><div class="card-head"><h2>${label}</h2><span class="sub">${l.length}</span></div>
    ${l.length ? html`<ul class="rows">${l.map(row)}</ul>` : html`<p class="muted card-body">Nenhum cadastrado.</p>`}</section>`; };
  return {
    title: 'Profissionais · Folha de Campo',
    html: html`${pageHead({ eyebrow: 'Folha de Campo', title: 'Profissionais', sub: mny ? 'Diaristas (função e valor da diária) e empreiteiros, com documento e PIX.' : 'Diaristas e empreiteiros da Folha de Campo.',
        actions: html`<button type="button" class="btn btn-primary" data-new>${icon('plus')}Novo profissional</button>` })}
      ${fieldTabs('prof', 0)}
      ${d.projects.length > 1 ? html`<div class="fc-filter section"><label for="fw-obra">Obra</label><select id="fw-obra"><option value="">Todas as obras</option>${d.projects.map(p => html`<option value="${p.id}" ${obra === p.id ? 'selected' : ''}>${p.code} · ${p.name}</option>`)}</select></div>` : ''}
      <div class="fc-chips section">${[['ativos', 'Ativos', nAt], ['inativos', 'Inativos', base.length - nAt], ['todos', 'Todos', base.length]].map(([k, l, n]) => html`<a href="${sitHref(k)}" class="fc-chip ${sit === k ? 'on' : ''}">${l} <b>${n}</b></a>`)}</div>
      ${group('diarista', 'Diaristas (mão de obra própria)')}${group('empreiteiro', 'Empreiteiros')}`,
    mount(root) {
      if (!mny) root.querySelectorAll('[data-money-tab]').forEach(x => x.remove());
      const opts = { pixTypes: d.pix_types, leaders: d.leaders, projects: d.projects, obra };
      root.querySelector('[data-new]').addEventListener('click', () => workerSheet(null, mny, () => { toast('Profissional cadastrado.'); render(); }, opts));
      root.querySelectorAll('[data-ed]').forEach(b => b.addEventListener('click', () => workerSheet(d.workers.find(w => w.id === Number(b.dataset.ed)), mny, () => { toast('Cadastro salvo.'); render(); }, opts)));
      root.querySelector('#fw-obra')?.addEventListener('change', e => { const q = new URLSearchParams(); if (e.target.value) q.set('obra', e.target.value); if (sit !== 'ativos') q.set('sit', sit); const x = q.toString(); navigate(`/campo/profissionais${x ? `?${x}` : ''}`); });
    },
  };
}

// ---------- Empreitadas ----------
const C_ST = { andamento: 'Em andamento', paralisada: 'Paralisada', concluida: 'Concluída', cancelada: 'Cancelada' };
const cTag = st => html`<span class="fc-cst fc-cst-${st}">${C_ST[st] || st}</span>`;
export async function contracts({ query, navigate, render }) {
  const obra = Number(query.get('obra')) || 0;
  const sit = C_ST[query.get('sit')] ? query.get('sit') : 'todas';
  const [all_, sh, wk] = await Promise.all([api('/field/contracts', { query: { obra: obra || '' } }), api('/field/sheets'), api('/field/workers')]);
  const list = all_.filter(c => sit === 'todas' || c.status === sit);
  const sitUrl = k => { const q = new URLSearchParams(); if (obra) q.set('obra', obra); if (k !== 'todas') q.set('sit', k); const x = q.toString(); return `#/campo/empreitadas${x ? `?${x}` : ''}`; };
  const mny = wk.can_money;
  const projects = sh.projects;
  const emp = wk.workers.filter(w => w.kind === 'empreiteiro' && w.active);
  const form = c => sheet({
    title: c ? c.service : 'Nova empreitada',
    body: html`<div class="field"><label class="req" for="ec-p">Obra</label><select id="ec-p" name="project_id" required ${c ? 'disabled' : ''}>${!obra && !c ? html`<option value="">Escolha…</option>` : ''}${projects.map(p => html`<option value="${p.id}" ${(c ? c.project_id : obra) === p.id ? 'selected' : ''}>${p.code} · ${p.name}</option>`)}</select></div>
      <div class="field"><label class="req" for="ec-w">Empreiteiro</label><select id="ec-w" name="worker_id" required><option value="">Escolha…</option>${emp.map(w => html`<option value="${w.id}" data-ob="${w.project_ids.join(',')}" ${c?.worker_id === w.id ? 'selected' : ''}>${w.name}</option>`)}</select>
        ${!emp.length ? html`<span class="hint">Cadastre o empreiteiro em Profissionais (tipo Empreiteiro).</span>` : ''}</div>
      <div class="field"><label class="req" for="ec-s">Serviço</label><input type="text" id="ec-s" name="service" required maxlength="200" value="${c?.service || ''}" placeholder="Ex.: Pintura da fachada"></div>
      <div class="form-row"><div class="field"><label class="req" for="ec-t">Valor total</label><input type="number" step="0.01" min="0" id="ec-t" name="total" required value="${c?.total ?? ''}"></div>
        <div class="field"><label for="ec-d">Início</label><input type="date" id="ec-d" name="start_date" value="${c?.start_date || ''}"></div></div>
      <div class="field"><label for="ec-n">Observações</label><textarea id="ec-n" name="notes" rows="2">${c?.notes || ''}</textarea></div>
      <div class="field"><label for="ec-st">Situação</label><select id="ec-st" name="status">${Object.entries(C_ST).map(([k, l]) => html`<option value="${k}" ${(c?.status || 'andamento') === k ? 'selected' : ''}>${l}</option>`)}</select>
        <span class="hint">Só empreitadas em andamento podem ser medidas nas folhas.</span></div>`,
    submitLabel: c ? 'Salvar' : 'Cadastrar',
    async onSubmit(f) {
      if (c) f.project_id = c.project_id;
      const r = await api(c ? `/field/contracts/${c.id}` : '/field/contracts', { method: c ? 'PUT' : 'POST', body: f });
      toast(c ? 'Empreitada salva.' : 'Empreitada cadastrada.');
      render();
      return r;
    },
  });
  return {
    title: 'Empreitadas · Folha de Campo',
    html: html`${pageHead({ eyebrow: 'Folha de Campo', title: 'Empreitadas', sub: 'Contrato com o empreiteiro na obra: medido em % a cada folha, com acumulado e saldo.',
        actions: mny ? html`<button type="button" class="btn btn-primary" data-new>${icon('plus')}Nova empreitada</button>` : '' })}
      ${fieldTabs('emp', mny ? obra : 0)}
      <div class="fc-filter section"><label for="ec-obra">Obra</label><select id="ec-obra"><option value="">Todas as obras</option>${projects.map(p => html`<option value="${p.id}" ${obra === p.id ? 'selected' : ''}>${p.code} · ${p.name}</option>`)}</select></div>
      <div class="fc-chips section">${[['todas', 'Todas', all_.length], ...Object.entries(C_ST).map(([k, l]) => [k, l, all_.filter(c => c.status === k).length])].map(([k, l, n]) => html`<a href="${sitUrl(k)}" class="fc-chip ${sit === k ? 'on' : ''}">${l} <b>${n}</b></a>`)}</div>
      ${list.length ? html`<section class="card section"><ul class="rows">${list.map(c => html`<li class="fc-wrow ${['concluida', 'cancelada'].includes(c.status) ? 'fc-off' : ''}"><div class="grow">
          <div class="row-title">${c.service} · ${c.worker_name} ${cTag(c.status)}</div>
          <div class="row-meta"><span>${c.project_code}</span>${mny ? html`<span>Contrato ${money(c.total)}</span><span>Medido ${money(c.measured)}</span><span>Saldo ${money(c.balance)}</span>` : ''}<span>${n2(c.measured_pct)}% medido</span></div>
          <div class="fc-bar"><span style="width:${Math.min(100, c.measured_pct)}%"></span></div></div>
          ${mny ? html`<button type="button" class="btn btn-ghost btn-sm" data-ed="${c.id}">${icon('edit')}Editar</button>` : ''}</li>`)}</ul></section>`
        : html`<div class="empty-state"><h2>Nenhuma empreitada${sit !== 'todas' ? ` ${C_ST[sit].toLowerCase()}` : ''}${obra ? ' nesta obra' : ''}</h2><p>${mny ? 'Cadastre a empreitada (empreiteiro, serviço e valor total) para medi-la nas folhas.' : 'O escritório cadastra as empreitadas da obra.'}</p></div>`}`,
    mount(root) {
      if (!mny) root.querySelectorAll('[data-money-tab]').forEach(x => x.remove());
      root.querySelector('#ec-obra').addEventListener('change', e => { const q = new URLSearchParams(); if (e.target.value) q.set('obra', e.target.value); if (sit !== 'todas') q.set('sit', sit); const x = q.toString(); navigate(`/campo/empreitadas${x ? `?${x}` : ''}`); });
      // Empreiteiros da obra escolhida (ou sem obra definida); o atual da empreitada sempre aparece
      const open = c => {
        const done = form(c);
        const p = document.getElementById('ec-p'), w = document.getElementById('ec-w');
        const filter = () => w && [...w.options].forEach(o => {
          if (!o.value) return;
          const ob = o.dataset.ob ? o.dataset.ob.split(',').map(Number) : [];
          const ok = !ob.length || !p.value || ob.includes(Number(p.value)) || Number(o.value) === c?.worker_id;
          o.hidden = !ok; o.disabled = !ok;
          if (!ok && o.selected) w.value = '';
        });
        p?.addEventListener('change', filter);
        filter();
        return done;
      };
      root.querySelector('[data-new]')?.addEventListener('click', () => open(null));
      root.querySelectorAll('[data-ed]').forEach(b => b.addEventListener('click', () => open(list.find(c => c.id === Number(b.dataset.ed)))));
    },
  };
}

// ---------- Consolidado da obra ----------
export async function summary({ query, navigate }) {
  const sh = await api('/field/sheets');
  const obra = Number(query.get('obra')) || sh.projects[0]?.id || 0;
  const d = obra ? await api('/field/summary', { query: { obra } }) : null;
  return {
    title: 'Consolidado · Folha de Campo',
    html: html`${pageHead({ eyebrow: 'Folha de Campo', title: 'Consolidado da obra', sub: 'Por profissional: diárias, medido, pago pelo cliente e parte da empresa (paga ou a pagar no Financeiro).' })}
      ${fieldTabs('cons', obra)}
      <div class="fc-filter section"><label for="cs-obra">Obra</label><select id="cs-obra">${sh.projects.map(p => html`<option value="${p.id}" ${obra === p.id ? 'selected' : ''}>${p.code} · ${p.name}</option>`)}</select></div>
      ${!d ? html`<div class="empty-state"><h2>Nenhuma obra</h2></div>` : html`
        <div class="pf-kpis section">
          <div><span>Folhas</span><b>${d.sheets}</b></div>
          <div><span>Em folhas abertas</span><b>${money(d.totals.open)}</b></div>
          <div><span>A pagar (Financeiro)</span><b>${money(d.totals.pending)}</b></div>
          <div class="pf-kt"><span>Pago pela empresa</span><b>${money(d.totals.paid)}</b></div>
        </div>
        <section class="card section"><div class="card-head"><h2>${icon('users')}Mão de obra própria</h2><span class="sub">${d.workers.length}</span></div>
          ${d.workers.length ? html`<div class="fc-table-wrap"><table class="fc-table"><thead><tr><th>Profissional</th><th>Diárias</th><th>Medido</th><th>Pago cliente</th><th>Empresa paga</th><th>Empresa a pagar</th><th>Em aberto</th></tr></thead>
            <tbody>${d.workers.map(w => html`<tr><td><b>${w.name}</b><small>${w.role || ''} · ${w.sheets} folha(s)</small></td><td>${n2(w.diarias)}</td><td>${money(w.total)}</td><td>${money(w.client)}</td><td>${money(w.company_paid)}</td>
              <td class="${w.company_pending ? 'fc-warn' : ''}">${money(w.company_pending)}</td><td>${money(w.open)}</td></tr>`)}</tbody></table></div>`
            : html`<p class="muted card-body">Nenhuma diária lançada.</p>`}</section>
        <section class="card section"><div class="card-head"><h2>${icon('contract')}Empreitadas</h2><span class="sub">${money(d.totals.contracts_measured)} de ${money(d.totals.contracts_total)}</span></div>
          ${d.contracts.length ? html`<ul class="rows">${d.contracts.map(c => html`<li class="fc-wrow"><div class="grow"><div class="row-title">${c.service} · ${c.worker_name}</div>
            <div class="row-meta"><span>Contrato ${money(c.total)}</span><span>Medido ${money(c.measured)} (${n2(c.measured_pct)}%)</span><span>Saldo ${money(c.balance)}</span></div>
            <div class="fc-bar"><span style="width:${Math.min(100, c.measured_pct)}%"></span></div></div></li>`)}</ul>` : html`<p class="muted card-body">Nenhuma empreitada.</p>`}</section>`}`,
    mount(root) {
      root.querySelector('#cs-obra')?.addEventListener('change', e => navigate(`/campo/consolidado?obra=${e.target.value}`));
    },
  };
}

// ---------- Resumo por obra e análise ----------
// Cores validadas (daltonismo e contraste): mão de obra própria e empreitadas
const C_MO = '#2563A8', C_EMP = '#E0661C';
const MON = ['jan', 'fev', 'mar', 'abr', 'mai', 'jun', 'jul', 'ago', 'set', 'out', 'nov', 'dez'];
const monLabel = ym => `${MON[Number(ym.slice(5, 7)) - 1]}/${ym.slice(2, 4)}`;
const pct = (a, b) => (b ? Math.round((a / b) * 100) : 0);
const kfmt = v => (Math.abs(v) >= 1000 ? `R$ ${n2(Math.round(v / 100) / 10)} mil` : money(v));
const tip = (title, rows) => `${title}|${rows.join('|')}`;
const legend = html`<div class="fa-legend"><span><i style="background:${C_MO}"></i>Mão de obra própria</span><span><i style="background:${C_EMP}"></i>Empreitadas</span></div>`;

function insights(d) {
  const t = d.totals, out = [];
  if (!t.sheets) return out;
  out.push(`Total medido de ${money(t.total)} em ${t.sheets} folha(s): ${pct(t.people, t.total)}% mão de obra própria e ${pct(t.contracts, t.total)}% empreitadas.`);
  if (t.diarias) out.push(`${n2(t.diarias)} diárias com custo médio de ${money(t.avg_daily)} por diária e equipe média de ${n2(t.avg_team)} pessoa(s) por dia trabalhado.`);
  if (d.obras.length > 1) { const o = d.obras[0]; out.push(`${o.code} · ${o.name} concentra ${pct(o.total, t.total)}% do custo medido (${money(o.total)}).`); }
  if (d.months.length > 1) {
    const top = [...d.months].sort((a, b) => b.total - a.total)[0];
    const [prev, last] = d.months.slice(-2);
    const v = prev.total ? Math.round(((last.total - prev.total) / prev.total) * 100) : null;
    out.push(`Mês de maior custo: ${monLabel(top.month)} (${money(top.total)}).${v !== null ? ` ${monLabel(last.month)} ${v >= 0 ? 'subiu' : 'caiu'} ${Math.abs(v)}% em relação a ${monLabel(prev.month)}.` : ''}`);
  }
  const sv = d.services.filter(s => s.name !== 'Sem apropriação');
  if (sv.length) out.push(`Serviço com maior custo: ${sv[0].name} (${money(sv[0].total)}, ${pct(sv[0].total, t.total)}%).`);
  const none = d.services.find(s => s.name === 'Sem apropriação');
  if (none && none.total) out.push(`${money(none.total)} de mão de obra sem serviço apropriado — preencha "Apropriar" nas folhas para a análise por serviço ficar completa.`);
  if (t.client) out.push(`O cliente pagou diretamente ${money(t.client)} (${pct(t.client, t.total)}% do medido).`);
  if (t.pending) out.push(`${money(t.pending)} a pagar no Financeiro (folhas fechadas ainda não pagas).`);
  if (t.open) out.push(`${money(t.open)} em folhas ainda abertas (não fechadas).`);
  const ct = d.contracts.filter(c => c.status === 'andamento');
  if (ct.length) { const tot = ct.reduce((a, c) => a + c.total, 0), med = ct.reduce((a, c) => a + c.measured, 0); out.push(`Empreitadas em andamento: ${pct(med, tot)}% medido, saldo de ${money(tot - med)} a medir.`); }
  return out;
}

export async function analysisView({ query, navigate }) {
  const qs = { obra: query.get('obra') || '', de: query.get('de') || '', ate: query.get('ate') || '' };
  const d = await api('/field/analysis', { query: qs });
  const t = d.totals;
  const maxM = Math.max(1, ...d.months.map(m => m.total));
  const maxS = Math.max(1, ...d.services.map(s => s.total));
  const maxO = Math.max(1, ...d.obras.map(o => o.total));
  const maxW = Math.max(1, ...d.workers.map(w => w.total));
  const sbar = (a, b, max) => html`<div class="fa-hbar">${a ? html`<span style="width:${(a / max) * 100}%;background:${C_MO}"></span>` : ''}${b ? html`<span style="width:${(b / max) * 100}%;background:${C_EMP}"></span>` : ''}</div>`;
  const ins = insights(d);
  return {
    title: 'Resumo e análise · Folha de Campo',
    html: html`${pageHead({ eyebrow: 'Folha de Campo', title: 'Resumo e análise', sub: 'Resumo por obra e análise do custo de mão de obra própria e empreitadas. Cada folha entra no mês do seu fim.' })}
      ${fieldTabs('ana', Number(qs.obra) || 0)}
      <form class="fa-filters section" id="fa-f">
        <label>Obra<select name="obra"><option value="">Todas as obras</option>${d.projects.map(p => html`<option value="${p.id}" ${Number(qs.obra) === p.id ? 'selected' : ''}>${p.code} · ${p.name}</option>`)}</select></label>
        <label>De<input type="month" name="de" value="${qs.de}"></label>
        <label>Até<input type="month" name="ate" value="${qs.ate}"></label>
        ${qs.obra || qs.de || qs.ate ? html`<a class="btn btn-ghost btn-sm" href="#/campo/resumo">Limpar</a>` : ''}
      </form>
      ${!t.sheets ? html`<div class="empty-state"><h2>Nenhuma folha no filtro</h2><p>Ajuste a obra ou o período.</p></div>` : html`
      <div class="pf-kpis fa-kpis section">
        <div class="pf-kt"><span>Total medido</span><b>${money(t.total)}</b></div>
        <div><span>Mão de obra própria</span><b>${money(t.people)}</b></div>
        <div><span>Empreitadas</span><b>${money(t.contracts)}</b></div>
        <div><span>Diárias</span><b>${n2(t.diarias)}</b></div>
        <div><span>Custo médio / diária</span><b>${money(t.avg_daily)}</b></div>
        <div><span>Equipe média / dia</span><b>${n2(t.avg_team)}</b></div>
        <div><span>Pago pelo cliente</span><b>${money(t.client)}</b></div>
        <div><span>Empresa: pago</span><b>${money(t.paid)}</b></div>
        <div><span>Empresa: a pagar</span><b>${money(t.pending)}</b></div>
        <div><span>Em folhas abertas</span><b>${money(t.open)}</b></div>
      </div>
      ${ins.length ? html`<section class="card section"><div class="card-head"><h2>${icon('info')}Destaques</h2></div><ul class="fa-ins">${ins.map(x => html`<li>${x}</li>`)}</ul></section>` : ''}
      <section class="card section"><div class="card-head"><h2>${icon('projects')}Resumo por obra</h2><span class="sub">${d.obras.length}</span></div>
        <div class="fc-table-wrap"><table class="fc-table fa-obras"><thead><tr><th>Obra</th><th>Folhas</th><th>Diárias</th><th>Equipe/dia</th><th>Mão de obra</th><th>Empreitadas</th><th>Total</th><th class="fa-barcol"></th><th>Cliente</th><th>Empresa paga</th><th>A pagar</th><th>Em aberto</th></tr></thead>
          <tbody>${d.obras.map(o => html`<tr data-href="#/campo/consolidado?obra=${o.project_id}" data-tip="${tip(`${o.code} · ${o.name}`, [`Mão de obra: ${money(o.people)}`, `Empreitadas: ${money(o.contracts)}`, `Custo médio/diária: ${money(o.avg_daily)}`, `Última folha até ${fmtDate(o.last_end)}`])}">
            <td><b>${o.code}</b><small>${o.name}${o.open_sheets ? ` · ${o.open_sheets} aberta(s)` : ''}</small></td><td>${o.sheets}</td><td>${n2(o.diarias)}</td><td>${n2(o.avg_team)}</td>
            <td>${money(o.people)}</td><td>${money(o.contracts)}</td><td><b>${money(o.total)}</b></td><td class="fa-barcol">${sbar(o.people, o.contracts, maxO)}</td>
            <td>${money(o.client)}</td><td>${money(o.paid)}</td><td class="${o.pending ? 'fc-warn' : ''}">${money(o.pending)}</td><td>${money(o.open)}</td></tr>`)}</tbody>
          ${d.obras.length > 1 ? html`<tfoot><tr><td><b>Total</b></td><td>${t.sheets}</td><td>${n2(t.diarias)}</td><td>${n2(t.avg_team)}</td><td>${money(t.people)}</td><td>${money(t.contracts)}</td><td><b>${money(t.total)}</b></td><td class="fa-barcol"></td><td>${money(t.client)}</td><td>${money(t.paid)}</td><td>${money(t.pending)}</td><td>${money(t.open)}</td></tr></tfoot>` : ''}</table></div>
        <p class="hint card-body">Toque na obra para ver o consolidado por profissional.</p></section>
      <div class="fa-grid">
        <section class="card section"><div class="card-head"><h2>${icon('calendar')}Custo por mês</h2></div><div class="card-body">${legend}
          <div class="fa-cols">${d.months.map(m => html`<div class="fa-col" data-tip="${tip(monLabel(m.month), [`Mão de obra: ${money(m.people)}`, `Empreitadas: ${money(m.contracts)}`, `Total: ${money(m.total)}`, `${n2(m.diarias)} diárias`])}">
            <em>${kfmt(m.total)}</em><div class="fa-stack" style="height:${(m.total / maxM) * 100}%">${m.contracts ? html`<span style="flex:${m.contracts};background:${C_EMP}"></span>` : ''}${m.people ? html`<span style="flex:${m.people};background:${C_MO}"></span>` : ''}</div><small>${monLabel(m.month)}</small></div>`)}</div></div></section>
        <section class="card section"><div class="card-head"><h2>${icon('checklist')}Custo por serviço (apropriação)</h2></div><div class="card-body">${legend}
          <ul class="fa-bars">${d.services.slice(0, 12).map(s => html`<li data-tip="${tip(s.name, [`Mão de obra: ${money(s.people)} (${n2(s.diarias)} diárias)`, `Empreitadas: ${money(s.contracts)}`, `${pct(s.total, t.total)}% do total`])}"><div class="fa-bl"><span>${s.name}</span><b>${money(s.total)}</b></div>${sbar(s.people, s.contracts, maxS)}</li>`)}</ul></div></section>
      </div>
      <div class="fa-grid">
        <section class="card section"><div class="card-head"><h2>${icon('users')}Por função</h2></div>
          <div class="fc-table-wrap"><table class="fc-table"><thead><tr><th>Função</th><th>Pessoas</th><th>Diárias</th><th>Custo</th><th>Média/diária</th></tr></thead>
            <tbody>${d.roles.map(r => html`<tr><td><b>${r.name}</b></td><td>${r.workers}</td><td>${n2(r.diarias)}</td><td>${money(r.total)}</td><td>${money(r.avg_daily)}</td></tr>`)}</tbody></table></div></section>
        <section class="card section"><div class="card-head"><h2>${icon('user')}Maiores valores por profissional</h2></div><div class="card-body">${legend}
          <ul class="fa-bars">${d.workers.map(w => html`<li data-tip="${tip(w.name, [w.kind === 'empreiteiro' ? 'Empreiteiro' : `${w.role || 'Diarista'} · ${n2(w.diarias)} diárias`, `Total: ${money(w.total)}`, `Obras: ${w.obras.join(', ')}`])}"><div class="fa-bl"><span>${w.name}<small>${w.kind === 'empreiteiro' ? 'Empreiteiro' : `${w.role || ''} · ${n2(w.diarias)} diárias`}</small></span><b>${money(w.total)}</b></div>
            <div class="fa-hbar"><span style="width:${(w.total / maxW) * 100}%;background:${w.kind === 'empreiteiro' ? C_EMP : C_MO}"></span></div></li>`)}</ul></div></section>
      </div>
      ${d.contracts.length ? html`<section class="card section"><div class="card-head"><h2>${icon('contract')}Empreitadas: medido e saldo</h2></div><ul class="rows">${d.contracts.map(c => html`<li class="fc-wrow ${['concluida', 'cancelada'].includes(c.status) ? 'fc-off' : ''}"><div class="grow">
        <div class="row-title">${c.service} · ${c.worker_name} ${cTag(c.status)}</div><div class="row-meta"><span>${c.project_code}</span><span>Contrato ${money(c.total)}</span><span>Medido ${money(c.measured)} (${n2(c.measured_pct)}%)</span><span>Saldo ${money(c.balance)}</span></div>
        <div class="fc-bar"><span style="width:${Math.min(100, c.measured_pct)}%"></span></div></div></li>`)}</ul></section>` : ''}`}
      <div class="fa-tip" hidden></div>`,
    mount(root) {
      const form = root.querySelector('#fa-f');
      form.addEventListener('change', () => {
        const q = new URLSearchParams([...new FormData(form)].filter(([, v]) => v)).toString();
        navigate(`/campo/resumo${q ? `?${q}` : ''}`);
      });
      root.querySelectorAll('tr[data-href]').forEach(tr => tr.addEventListener('click', () => { location.hash = tr.dataset.href; }));
      // Dica ao passar o mouse (ou tocar) em barras, colunas e linhas
      const box = root.querySelector('.fa-tip');
      const show = (el, x, y) => {
        const [title, ...rows] = el.dataset.tip.split('|');
        box.innerHTML = html`<b>${title}</b>${rows.map(r => html`<span>${r}</span>`)}`.toString();
        box.hidden = false;
        const w = box.offsetWidth, h = box.offsetHeight;
        box.style.left = `${Math.max(8, Math.min(window.innerWidth - w - 8, x + 12))}px`;
        box.style.top = `${Math.max(8, y - h - 12)}px`;
      };
      root.querySelectorAll('[data-tip]').forEach(el => {
        el.addEventListener('mousemove', e => show(el, e.clientX, e.clientY));
        el.addEventListener('mouseleave', () => { box.hidden = true; });
        el.addEventListener('touchstart', e => { const p = e.touches[0]; show(el, p.clientX, p.clientY); }, { passive: true });
      });
      window.addEventListener('scroll', function hide() { if (!root.isConnected) return window.removeEventListener('scroll', hide); box.hidden = true; }, { passive: true });
    },
  };
}

// ---------- Pagamentos: quem recebe, quanto e o PIX ----------
async function copyText(text) {
  try { await navigator.clipboard.writeText(text); }
  catch {
    const ta = document.createElement('textarea'); ta.value = text; ta.style.position = 'fixed'; ta.style.opacity = '0';
    document.body.appendChild(ta); ta.select(); document.execCommand('copy'); ta.remove();
  }
}
// Botões "Copiar" (PIX ou lista) em qualquer tela da Folha de Campo
function bindCopy(root) {
  root.addEventListener('click', async e => {
    const b = e.target.closest('[data-copy]');
    if (!b) return;
    await copyText(b.dataset.copy);
    toast(b.dataset.copyMsg || 'Copiado.');
  });
}
const pixCell = p => (p.pix
  ? html`<span class="fp-pix"><span class="fp-pt">${p.pix_type || 'PIX'}</span><code>${p.pix}</code></span>`
  : html`<span class="fp-pix fp-nopix">${icon('alert')}<span>Sem PIX — <a href="#/campo/profissionais">completar</a></span></span>`);
const copyOnly = p => (p.pix ? html`<button type="button" class="btn btn-ghost btn-sm" data-copy="${p.pix}" data-copy-msg="PIX de ${p.name} copiado.">Copiar PIX</button>` : '');
const paidTag = (d, lines) => html`<span class="fp-paid">${icon('check')}Pago${d ? ` ${dm(d)}` : ''}${lines ? html` <button type="button" class="fp-undo" data-unpay="${lines}">desfazer</button>` : ''}</span>`;
// paid: undefined = sem ação (folha aberta); lines = lançamentos a marcar
const actCell = (p, { lines, paidAt, canPay } = {}) => html`<span class="fp-copy">${paidAt !== undefined && paidAt !== null ? paidTag(paidAt, lines) : html`${copyOnly(p)}${canPay ? html`<button type="button" class="btn btn-primary btn-sm" data-pay="${lines}" data-who="${p.name}" data-amt="${p.amount}">${icon('check')}Marcar pago</button>` : ''}`}</span>`;
const copyBtn = p => actCell(p);
const payText = list => list.map(p => `${p.name} — ${money(p.amount)}${p.pix ? ` — PIX ${p.pix_type ? `(${p.pix_type}) ` : ''}${p.pix}` : ' — SEM PIX'}`).join('\n');
// Lista da folha: Quem recebe · PIX · Valor · Copiar
const payHead = html`<li class="fp-row fp-head"><span>Quem recebe</span><span>PIX</span><span class="fp-num">Valor</span><span></span></li>`;
// open: id do profissional — o nome vira botão que abre a janela das diárias
const payRow = (p, act = {}) => html`<li class="fp-row ${act.paidAt ? 'fp-isPaid' : ''}">${act.open
  ? html`<button type="button" class="fp-who fp-edit" data-open-p="${act.open}" title="Ver ou editar as diárias"><b>${p.name}</b><small>${p.what || p.role || ''}</small></button>`
  : html`<span class="fp-who"><b>${p.name}</b><small>${p.what || p.role || ''}</small></span>`}${pixCell(p)}<strong class="fp-num fp-val">${money(p.amount)}</strong>${actCell(p, act)}</li>`;

// Marcar pago (pergunta a data) / desfazer
async function askPaid(lines, who, amount, done) {
  const r = await sheet({
    title: 'Marcar como pago',
    body: html`<p class="muted" style="margin-top:0">${who}${amount ? html` · <b>${money(amount)}</b>` : ''}</p>
      <div class="field"><label class="req" for="mp-d">Data do pagamento</label><input type="date" id="mp-d" name="paid_date" required value="${todayISO()}" max="${todayISO()}"></div>
      <span class="hint">Quando todos da folha estiverem pagos, o pagamento da folha é baixado no Financeiro automaticamente.</span>`,
    submitLabel: 'Marcar pago',
    onSubmit: f => api('/field/paid', { method: 'POST', body: { lines, paid: true, paid_date: f.paid_date } }),
  });
  if (r) { toast('Pagamento marcado.'); done(); }
}
function bindPaid(root, done) {
  root.addEventListener('click', async e => {
    const p = e.target.closest('[data-pay]');
    if (p) return askPaid(p.dataset.pay.split(','), p.dataset.who, Number(p.dataset.amt) || 0, done);
    const u = e.target.closest('[data-unpay]');
    if (u) {
      if (!(await confirmSheet('Desfazer pagamento', 'Volta a ficar a pagar. Se o pagamento da folha já estava baixado no Financeiro, ele volta a pendente.', 'Desfazer', true))) return;
      try { await api('/field/paid', { method: 'POST', body: { lines: u.dataset.unpay.split(','), paid: false } }); toast('Pagamento desfeito.'); done(); } catch (ex) { toast(ex.message, 'error'); }
    }
  });
}

// Lista da própria folha (valores ao vivo enquanto aberta)
function sheetPayList(people, contracts, calcP, calcC) {
  return [...people.map(e => ({ line: `p${e.id}`, worker_id: e.worker_id, paid_at: e.paid_at, name: e.name, role: e.role, pix: e.pix, pix_type: e.pix_type, amount: calcP(e).company, what: `${e.role || 'Diarista'} · ${n2(calcP(e).diarias)} diária(s)` })),
    ...contracts.map(c => ({ line: `c${c.id}`, paid_at: c.paid_at, name: c.worker_name, role: 'Empreiteiro', pix: c.pix, pix_type: c.pix_type, amount: calcC(c).company, what: `Empreitada ${c.service} · ${n2(num(c.pct))}%` }))]
    .filter(p => p.amount > 0.004).sort((a, b) => b.amount - a.amount);
}

export async function paymentsView({ query, navigate, render }) {
  const obra = Number(query.get('obra')) || 0;
  // Sempre com o histórico: já pago, a pagar e previsto por pessoa. Filtro: todos ou só quem tem a receber
  const onlyDue = query.get('ver') === 'areceber';
  const d = await api('/field/payments', { query: { obra: obra || '', pagos: '1' } });
  const qsOf = (o, due) => { const q = new URLSearchParams(); if (o) q.set('obra', o); if (due) q.set('ver', 'areceber'); const x = q.toString(); return `/campo/pagamentos${x ? `?${x}` : ''}`; };
  const t = d.totals;
  const people = d.people.filter(p => !onlyDue || p.pending > 0 || p.open > 0)
    .map(p => ({ ...p, items: [...p.items].sort((a, b) => ({ pending: 0, open: 1, paid: 2 }[a.state] - { pending: 0, open: 1, paid: 2 }[b.state]) || String(b.paid_at || b.period).localeCompare(String(a.paid_at || a.period))) }));
  const nDue = d.people.filter(p => p.pending > 0 || p.open > 0).length;
  const pendList = d.people.filter(p => p.pending > 0).map(p => ({ ...p, amount: p.pending }));
  const stTxt = i => (i.state === 'pending' ? html`<span class="fc-pay">A pagar${i.due_date ? ` ${fmtDate(i.due_date)}` : ''}</span><button type="button" class="btn btn-ghost btn-sm" data-pay="${i.line}" data-who="${i.code}" data-amt="${i.amount}">Marcar pago</button>`
    : i.state === 'paid' ? paidTag(i.paid_at, i.line) : html`<span class="fp-prev">Folha aberta (previsto)</span>`);
  return {
    title: 'Pagamentos · Folha de Campo',
    html: html`${pageHead({ eyebrow: 'Folha de Campo', title: 'Pagamentos', sub: 'Quem recebe, quanto e o PIX: o que já foi pago, o que está a pagar e o previsto de cada pessoa, em todas as folhas.',
        actions: pendList.length ? html`<button type="button" class="btn btn-primary" data-copy="${payText(pendList)}" data-copy-msg="Lista de pagamentos copiada.">${icon('file')}Copiar lista a pagar</button>` : '' })}
      ${fieldTabs('pag', obra)}
      <div class="fc-filter section"><label for="fp-obra">Obra</label><select id="fp-obra"><option value="">Todas as obras</option>${d.projects.map(p => html`<option value="${p.id}" ${obra === p.id ? 'selected' : ''}>${p.code} · ${p.name}</option>`)}</select>
      </div>
      <div class="fc-chips section"><a href="#${qsOf(obra, false)}" class="fc-chip ${!onlyDue ? 'on' : ''}">Todos <b>${d.people.length}</b></a><a href="#${qsOf(obra, true)}" class="fc-chip ${onlyDue ? 'on' : ''}">Com valor a receber <b>${nDue}</b></a></div>
      <div class="pf-kpis fp-kpis section">
        <div class="pf-kt"><span>A pagar (folhas fechadas)</span><b>${money(t.pending)}</b></div>
        <div><span>Previsto (folhas abertas)</span><b>${money(t.open)}</b></div>
        <div><span>Já pago</span><b class="fr-ok">${money(t.paid)}</b></div>
      </div>
      ${people.length ? html`<section class="card section"><ul class="fp-list fp-list2">
          <li class="fp-row fp-head"><span>Quem recebe</span><span>PIX</span><span class="fp-num">Já pago</span><span class="fp-num">A pagar</span><span class="fp-num">Previsto</span><span></span></li>
          ${people.map(p => html`<li class="fp-row"><span class="fp-who"><b>${p.name}</b><small>${p.role || ''}</small></span>${pixCell(p)}
            <span class="fp-num fp-pd" data-l="Já pago">${p.paid ? money(p.paid) : '—'}</span>
            <strong class="fp-num fp-val" data-l="A pagar">${p.pending ? money(p.pending) : '—'}</strong><span class="fp-num fp-open" data-l="Previsto">${p.open ? money(p.open) : '—'}</span>
            ${actCell({ ...p, amount: p.pending }, { canPay: p.pending > 0, lines: p.items.filter(i => i.state === 'pending').map(i => i.line).join(',') })}
            <details class="fp-det"><summary>${p.items.length} lançamento(s) · total ${money(p.paid + p.pending + p.open)}</summary><ul>${p.items.map(i => html`<li><a href="#/campo/${i.sheet_id}"><b>${i.code}</b> · ${i.period}</a><small>${i.project_name} · ${i.what}</small><span>${money(i.amount)} ${stTxt(i)}</span></li>`)}</ul></details></li>`)}
          <li class="fp-row fp-foot"><span><b>Total</b></span><span></span><span class="fp-num fp-pd" data-l="Já pago">${money(people.reduce((a, p) => a + p.paid, 0))}</span><strong class="fp-num fp-val" data-l="A pagar">${money(people.reduce((a, p) => a + p.pending, 0))}</strong><span class="fp-num fp-open" data-l="Previsto">${money(people.reduce((a, p) => a + p.open, 0))}</span><span></span></li></ul></section>`
        : html`<div class="empty-state"><h2>${onlyDue ? 'Ninguém com valor a receber' : 'Nenhum pagamento ainda'}</h2><p>${onlyDue ? 'Todas as folhas fechadas estão pagas.' : 'Os valores aparecem aqui quando houver folhas com diárias ou empreitadas.'}</p></div>`}
      <p class="muted pf-foot">O pagamento é registrado no Financeiro (uma tarefa por folha fechada, com esta mesma lista). Folhas abertas aparecem como previsto até serem fechadas.</p>`,
    mount(root) {
      bindCopy(root);
      bindPaid(root, render);
      root.querySelector('#fp-obra').addEventListener('change', e => navigate(qsOf(e.target.value, onlyDue)));
    },
  };
}
