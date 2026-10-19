// Folha (Administrativa): folhas do mês, pessoas da folha, lançamentos (faltas, home office, diferenças, reembolso),
// fechamento (gera os pagamentos em Tarefas financeiras) e recibos.
import { html, api, icon, avatar, fmtDate } from '../core.js';
import { toast, sheet, confirmSheet } from '../ui.js';
import { pageHead } from './shared.js';
import { filesLinks, rejectSheet } from './reimb-ui.js';

export const BRL = new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' });
export const money = v => BRL.format(Number(v) || 0);
export const refLabel = ref => `${ref.slice(5, 7)}/${ref.slice(0, 4)}`;
const MONTHS = ['janeiro', 'fevereiro', 'março', 'abril', 'maio', 'junho', 'julho', 'agosto', 'setembro', 'outubro', 'novembro', 'dezembro'];
export const refLong = ref => `${MONTHS[Number(ref.slice(5, 7)) - 1]} de ${ref.slice(0, 4)}`;
export const WD = { 1: 'Seg', 2: 'Ter', 3: 'Qua', 4: 'Qui', 5: 'Sex' };
export const dm = d => (d ? fmtDate(d).slice(0, 5) : '—');
export const scheduleText = (s, k) => {
  const days = Object.keys(WD).filter(w => s?.[w]?.[k]);
  return days.length === 5 ? 'seg a sex' : days.length ? days.map(w => WD[w].toLowerCase()).join(', ') : '';
};
const finLabel = c => `${c.title} · ${refLabel(c.ref_month)} · ${money(c.amount_expected)}${c.estimated ? ' (estimado)' : ''}`;
const finOptions = (list, ref, selected) => {
  const pick = selected ?? list.find(c => c.ref_month === ref)?.id ?? '';
  return html`<option value="" ${pick === '' && list.length ? 'selected' : ''} disabled>Escolha a folha pré-lançada…</option>
    ${list.map(c => html`<option value="${c.id}" data-ref="${c.ref_month}" ${pick === c.id ? 'selected' : ''}>${finLabel(c)}</option>`)}
    <option value="nenhuma" ${!list.length || selected === null ? 'selected' : ''}>Nenhuma: gerar um pagamento por pessoa</option>`;
};
const stTag = st => html`<span class="pf-st pf-st-${st}">${st === 'fechada' ? 'Fechada' : 'Aberta'}</span>`;

// ---------- Folhas ----------
export async function list({ navigate, render }) {
  const [data, pend] = await Promise.all([api('/payroll/months'), api('/reimbursements/pending')]);
  return {
    title: 'Folha (Administrativa)',
    html: html`
      ${pageHead({
        eyebrow: 'Gestão da Empresa',
        title: 'Folha (Administrativa)',
        sub: 'Bolsa/valor proporcional do mês anterior + VT e VR adiantados do mês, recibos e pagamentos.',
        actions: html`<a class="btn btn-ghost" href="#/folha/pessoas">${icon('users')}Pessoas da folha</a>
          <button type="button" class="btn btn-primary" data-new>${icon('plus')}Nova folha</button>`,
      })}
      ${!data.people_count ? html`<div class="notice notice-warn section">${icon('info')}<span>Comece cadastrando as <a href="#/folha/pessoas">pessoas da folha</a>: valor mensal, turno, PIX e a escala de VT/VR de cada uma.</span></div>` : ''}
      ${pend.length ? html`<section class="card section"><div class="card-head"><h2>${icon('wallet')}Reembolsos aguardando a folha</h2><span class="sub">${pend.length} · ${money(pend.reduce((s, r) => s + r.amount, 0))}</span></div>
        <ul class="rows">${pend.map(r => html`<li class="rb-row"><div class="grow"><div class="row-title">${r.user_name} · ${r.description}</div>
          <div class="row-meta"><span>${fmtDate(r.expense_date)}</span>${filesLinks(r.files)}${r.in_payroll ? html`<span>Puxe para o pagamento dentro da folha do mês</span>` : html`<span class="rb-why">Pessoa fora da folha: inclua-a em Pessoas da folha ou recuse</span>`}</div></div>
          <div class="rb-right"><b>${money(r.amount)}</b><button type="button" class="btn btn-ghost btn-sm pf-danger" data-rb-reject="${r.id}">Recusar</button></div></li>`)}</ul></section>` : ''}
      ${data.months.length ? html`<div class="pf-months">${data.months.map(m => html`<a class="pf-mcard" href="#/folha/${m.id}">
          <div class="pf-mtop"><b>Folha ${refLabel(m.ref)}</b>${stTag(m.status)}</div>
          <div class="pf-mper">Bolsa ${dm(m.bolsa.start)} a ${dm(m.bolsa.end)} · VT/VR ${dm(m.benefit.start)} a ${dm(m.benefit.end)}</div>
          <div class="pf-mtotal">${money(m.totals.total)}</div>
          <div class="pf-mfoot"><span>${m.people} pessoa(s)</span><span>Bolsa ${money(m.totals.base)}</span><span>VT ${money(m.totals.vt)}</span><span>VR ${money(m.totals.vr)}</span>${m.totals.reimbursement ? html`<span>Reemb. ${money(m.totals.reimbursement)}</span>` : ''}</div>
        </a>`)}</div>`
        : html`<div class="empty-state"><h2>Nenhuma folha ainda</h2><p>Crie a folha do mês: o sistema calcula a bolsa proporcional, o VT e o VR de cada pessoa e gera os recibos.</p></div>`}
      <button type="button" class="fab" data-new aria-label="Nova folha">${icon('plus')}</button>`,
    mount(root) {
      root.querySelectorAll('[data-rb-reject]').forEach(b => b.addEventListener('click', () => rejectSheet(pend.find(r => r.id === Number(b.dataset.rbReject)), render)));
      // Ao trocar o mês, pré-seleciona a folha pré-lançada daquele mês
      document.addEventListener('change', function onRef(e) {
        if (!root.isConnected) return document.removeEventListener('change', onRef);
        if (e.target.id !== 'nf-ref') return;
        const sel = document.getElementById('nf-fin');
        const opt = sel && [...sel.options].find(o => o.dataset.ref === e.target.value);
        if (opt) sel.value = opt.value;
      });
      root.querySelectorAll('[data-new]').forEach(b => b.addEventListener('click', () => sheet({
        title: 'Nova folha',
        body: html`<div class="field"><label class="req" for="nf-ref">Mês do pagamento</label><input type="month" id="nf-ref" name="ref" required value="${data.suggested_ref}">
            <span class="hint">Ex.: folha 10/2026 = bolsa de setembro (proporcional) + VT/VR de outubro (adiantados).</span></div>
          <div class="form-row form-row-3">
            <div class="field"><label for="nf-vt">Passagem (VT)</label><input type="number" id="nf-vt" name="vt_fare" step="0.01" min="0" value="${data.defaults.vt_fare}"></div>
            <div class="field"><label for="nf-vr">VR por dia</label><input type="number" id="nf-vr" name="vr_daily" step="0.01" min="0" value="${data.defaults.vr_daily}"></div>
            <div class="field"><label for="nf-pay">Pagamento</label><input type="date" id="nf-pay" name="pay_date"></div>
          </div>
          <div class="field"><label class="req" for="nf-fin">Folha pré-lançada em Tarefas financeiras</label>
            <select id="nf-fin" name="finance_item_id" required>${finOptions(data.finance_candidates, data.suggested_ref)}</select>
            <span class="hint">${data.finance_candidates.length ? 'No fechamento, o valor estimado dessa parcela é corrigido para o total da folha.' : 'Nenhuma folha pré-lançada (categoria Folha de pagamento) pendente: no fechamento será gerado um pagamento por pessoa.'}</span></div>
          <span class="hint">Pessoas ativas da folha entram automaticamente.</span>`,
        submitLabel: 'Criar folha',
        async onSubmit(d) {
          if (!d.finance_item_id) throw new Error('Selecione a folha pré-lançada em Tarefas financeiras (ou “Nenhuma”).');
          const m = await api('/payroll/months', { method: 'POST', body: d });
          toast('Folha criada.');
          navigate(`/folha/${m.id}`);
          return m;
        },
      })));
    },
  };
}

// ---------- Folha do mês ----------
export async function month({ params, render }) {
  const m = await api(`/payroll/months/${params.id}`);
  const open = m.status === 'aberta';
  const t = m.totals;
  const row = e => {
    const c = e.calc;
    return html`<li class="pf-row">
      <div class="pf-who">${avatar(e.name, 'sm')}<div><b>${e.name}</b><small>${e.job_title || ''}${e.kind === 'profissional' ? ' · Profissional' : ''} · ${e.company_name}</small></div></div>
      <dl class="pf-nums">
        <div><dt>Dias</dt><dd>${c.worked_days}/${c.business_days}</dd></div>
        <div><dt>Faltas</dt><dd>${c.absences || '—'}</dd></div>
        <div><dt>HO</dt><dd>${c.ho_days || '—'}</dd></div>
        <div><dt>${e.kind === 'profissional' ? 'Valor' : 'Bolsa'}</dt><dd>${money(c.base)}</dd></div>
        <div><dt>VT</dt><dd>${money(c.vt)}</dd></div>
        <div><dt>VR</dt><dd>${money(c.vr)}</dd></div>
        <div><dt>Reemb.${e.requests?.length ? ` (${e.requests.length})` : ''}</dt><dd>${money(c.reimbursement)}</dd></div>
        <div class="pf-tot"><dt>Total</dt><dd>${money(c.total)}</dd></div>
      </dl>
      <div class="pf-acts">${open ? html`<button type="button" class="btn btn-ghost btn-sm" data-edit="${e.id}">${icon('edit')}Lançar</button>` : ''}
        <a class="btn btn-ghost btn-sm" href="#/imprimir/folha/${m.id}?pessoa=${e.id}">${icon('print')}Recibo</a></div>
    </li>`;
  };
  return {
    title: `Folha ${refLabel(m.ref)}`,
    html: html`
      ${pageHead({
        back: { href: '#/folha', label: 'Folha (Administrativa)' },
        eyebrow: 'Folha (Administrativa)',
        title: html`Folha ${refLabel(m.ref)} ${stTag(m.status)}`,
        sub: open ? 'Lance faltas, home office, diferenças e reembolsos. Ao fechar, os valores ficam congelados e os pagamentos são gerados.'
          : `Fechada por ${m.closed_by_name || '—'} em ${fmtDate(m.closed_at?.slice(0, 10))}.`,
        actions: html`<a class="btn btn-ghost" href="#/imprimir/folha/${m.id}">${icon('print')}Recibos</a>
          ${open ? html`<button type="button" class="btn btn-primary" data-close>${icon('check')}Fechar folha</button>` : html`<button type="button" class="btn btn-ghost" data-reopen>${icon('edit')}Reabrir</button>`}`,
      })}
      <section class="card section"><div class="card-body pf-params">
        <div><span class="sub-label">Bolsa (mês anterior)</span><b>${dm(m.bolsa.start)} a ${dm(m.bolsa.end)}</b><small>${m.business_days} dias úteis</small></div>
        <div><span class="sub-label">VT e VR (adiantamento)</span><b>${dm(m.benefit.start)} a ${dm(m.benefit.end)}</b><small>${m.benefit_days} dias úteis</small></div>
        <form class="pf-pform" id="pf-params">
          <label>Passagem (VT)<input type="number" name="vt_fare" step="0.01" min="0" value="${m.vt_fare}" ${open ? '' : 'disabled'}></label>
          <label>VR por dia<input type="number" name="vr_daily" step="0.01" min="0" value="${m.vr_daily}" ${open ? '' : 'disabled'}></label>
          <label>Pagamento<input type="date" name="pay_date" value="${m.pay_date || ''}" ${open ? '' : 'disabled'}></label>
          ${open ? html`<label class="pf-fin">Folha pré-lançada (Tarefas financeiras)<select name="finance_item_id">${finOptions(m.finance_item ? [m.finance_item, ...m.finance_candidates.filter(c => c.id !== m.finance_item.id)] : m.finance_candidates, m.ref, m.finance_item ? m.finance_item.id : null)}</select></label>` : ''}
          ${open ? html`<button type="submit" class="btn btn-ghost btn-sm">Salvar</button>` : ''}
        </form>
        ${m.finance_item ? html`<div class="pf-link">${icon('wallet')}<span>${open
          ? html`Vinculada a <b>${m.finance_item.title} · ${refLabel(m.finance_item.ref_month)}</b>: valor ${m.finance_item.estimated ? 'estimado' : 'previsto'} ${money(m.finance_item.amount_expected)} → será corrigido para <b>${money(t.total)}</b> no fechamento.`
          : html`Valor corrigido em Tarefas financeiras: <b>${m.finance_item.title} · ${refLabel(m.finance_item.ref_month)}</b> = ${money(m.finance_item.amount_expected)}${m.finance_estimate != null ? ` (estimado era ${money(m.finance_estimate)})` : ''}.`}</span></div>`
          : html`<div class="pf-link pf-link-none">${icon('info')}<span>Sem folha pré-lançada: ${open ? 'no fechamento será gerado um pagamento por pessoa em Tarefas financeiras.' : 'foi gerado um pagamento por pessoa em Tarefas financeiras.'}</span></div>`}
      </div></section>
      <div class="pf-kpis section">
        <div><span>Bolsa / valores</span><b>${money(t.base)}</b></div>
        <div><span>Vale transporte</span><b>${money(t.vt)}</b></div>
        <div><span>Vale alimentação (VR)</span><b>${money(t.vr)}</b></div>
        <div><span>Reembolsos</span><b>${money(t.reimbursement)}</b></div>
        <div class="pf-kt"><span>Total da folha</span><b>${money(t.total)}</b></div>
      </div>
      ${open && m.pending_reimbursements.length ? html`<section class="card section rb-pend"><div class="card-head"><h2>${icon('wallet')}Reembolsos lançados pelas pessoas</h2>
          <button type="button" class="btn btn-primary btn-sm" data-rb-all>${icon('check')}Incluir todos (${money(m.pending_reimbursements.reduce((s, r) => s + r.amount, 0))})</button></div>
        <ul class="rows">${m.pending_reimbursements.map(r => html`<li class="rb-row"><div class="grow"><div class="row-title">${r.user_name} · ${r.description}</div>
          <div class="row-meta"><span>${fmtDate(r.expense_date)}</span>${filesLinks(r.files)}</div></div>
          <div class="rb-right"><b>${money(r.amount)}</b><button type="button" class="btn btn-ghost btn-sm" data-rb-inc="${r.id}" data-entry="${r.entry_id}">${icon('plus')}Incluir na folha</button>
            <button type="button" class="btn btn-ghost btn-sm pf-danger" data-rb-reject="${r.id}">Recusar</button></div></li>`)}</ul></section>` : ''}
      <section class="card section">
        <div class="card-head"><h2>${icon('users')}Pessoas</h2><span class="sub">${m.entries.length}</span></div>
        ${m.entries.length ? html`<ul class="pf-rows">${m.entries.map(row)}</ul>` : html`<p class="muted card-body">Nenhuma pessoa nesta folha.</p>`}
        ${open && m.available.length ? html`<div class="card-body pf-add"><select id="pf-addp"><option value="">Incluir pessoa da folha…</option>${m.available.map(p => html`<option value="${p.id}">${p.name}</option>`)}</select>
          <button type="button" class="btn btn-ghost btn-sm" id="pf-addb">${icon('plus')}Incluir</button></div>` : ''}
      </section>
      <p class="muted pf-foot">Dias úteis pelo calendário da empresa (feriados de Configurações). VT/VR não contam os dias de férias aprovadas. Home office do mês anterior desconta o VT já adiantado (dias × 2 × passagem).</p>`,
    mount(root) {
      root.querySelector('#pf-params')?.addEventListener('submit', async e => {
        e.preventDefault();
        try { await api(`/payroll/months/${m.id}`, { method: 'PUT', body: Object.fromEntries(new FormData(e.target)) }); toast('Parâmetros salvos e valores recalculados.'); render(); } catch (ex) { toast(ex.message, 'error'); }
      });
      root.querySelector('#pf-addb')?.addEventListener('click', async () => {
        const v = root.querySelector('#pf-addp').value;
        if (!v) return;
        try { await api(`/payroll/months/${m.id}/people`, { method: 'POST', body: { person_id: Number(v) } }); render(); } catch (ex) { toast(ex.message, 'error'); }
      });
      root.querySelectorAll('[data-edit]').forEach(b => b.addEventListener('click', () => entrySheet(m, m.entries.find(x => x.id === Number(b.dataset.edit)), render)));
      const include = async list => {
        try { for (const r of list) await api(`/reimbursements/${r.id}/include`, { method: 'POST', body: { entry_id: r.entry_id } }); toast(list.length > 1 ? 'Reembolsos incluídos na folha.' : 'Reembolso incluído na folha.'); render(); } catch (ex) { toast(ex.message, 'error'); render(); }
      };
      root.querySelectorAll('[data-rb-inc]').forEach(b => b.addEventListener('click', () => include(m.pending_reimbursements.filter(r => r.id === Number(b.dataset.rbInc)))));
      root.querySelector('[data-rb-all]')?.addEventListener('click', () => include(m.pending_reimbursements));
      root.querySelectorAll('[data-rb-reject]').forEach(b => b.addEventListener('click', () => rejectSheet(m.pending_reimbursements.find(r => r.id === Number(b.dataset.rbReject)), render)));
      root.querySelector('[data-close]')?.addEventListener('click', async () => {
        const n = m.entries.filter(e => e.calc.total > 0).length;
        const fi = m.finance_item;
        const msg = fi ? `Total de ${money(t.total)}. Os valores ficam congelados e a folha pré-lançada "${fi.title} · ${refLabel(fi.ref_month)}" passa de ${money(fi.amount_expected)} para ${money(t.total)} em Tarefas financeiras. Para corrigir depois, use Reabrir.`
          : `Total de ${money(t.total)}. Os valores ficam congelados e são gerados ${n} pagamento(s) em Tarefas financeiras${m.pay_date ? `, com vencimento em ${fmtDate(m.pay_date)}` : ''}. Para corrigir depois, use Reabrir.`;
        if (!(await confirmSheet(`Fechar a folha ${refLabel(m.ref)}`, msg, fi ? 'Fechar e corrigir o valor' : 'Fechar e gerar pagamentos'))) return;
        try { const r = await api(`/payroll/months/${m.id}/close`, { method: 'POST' }); toast(r.corrected ? 'Folha fechada. Valor corrigido em Tarefas financeiras.' : `Folha fechada. ${r.generated} pagamento(s) gerado(s).`); render(); } catch (ex) { toast(ex.message, 'error'); }
      });
      root.querySelector('[data-reopen]')?.addEventListener('click', async () => {
        if (!(await confirmSheet('Reabrir a folha', m.finance_item ? 'A folha pré-lançada em Tarefas financeiras volta ao valor estimado e será corrigida de novo no próximo fechamento. Se já foi paga, desfaça o pagamento antes.' : 'Os pagamentos pendentes gerados por esta folha serão removidos de Tarefas financeiras e voltarão a ser gerados no próximo fechamento. Se algum já foi pago, desfaça o pagamento antes.', 'Reabrir', true))) return;
        try { await api(`/payroll/months/${m.id}/reopen`, { method: 'POST' }); toast('Folha reaberta.'); render(); } catch (ex) { toast(ex.message, 'error'); }
      });
    },
  };
}

function entrySheet(m, e, render) {
  const c = e.calc, i = e.input;
  const pro = e.kind === 'profissional';
  sheet({
    title: e.name,
    body: html`<p class="muted" style="margin-top:0">${e.job_title || ''} · ${pro ? 'Valor mensal' : 'Bolsa'} ${money(e.monthly_value)}${!pro && scheduleText(e.schedule, 'vt') ? ` · VT: ${scheduleText(e.schedule, 'vt')}` : ''}${!pro && scheduleText(e.schedule, 'vr') ? ` · VR: ${scheduleText(e.schedule, 'vr')}` : ''}</p>
      <div class="form-row">
        <div class="field"><label for="le-s">Início no mês da bolsa</label><input type="date" id="le-s" name="start_date" min="${m.bolsa.start}" max="${m.bolsa.end}" value="${i.start_date || c.start || ''}"></div>
        <div class="field"><label for="le-e">Fim no mês da bolsa</label><input type="date" id="le-e" name="end_date" min="${m.bolsa.start}" max="${m.bolsa.end}" value="${i.end_date || c.end || ''}"></div>
      </div>
      <div class="form-row">
        <div class="field"><label for="le-f">Faltas (dias)</label><input type="number" id="le-f" name="absences" min="0" max="31" value="${i.absences || 0}"><span class="hint">Descontam da ${pro ? 'remuneração' : 'bolsa'} proporcional.</span></div>
        ${pro ? '' : html`<div class="field"><label for="le-h">Dias em home office</label><input type="number" id="le-h" name="ho_days" min="0" max="31" value="${i.ho_days || 0}"><span class="hint">Descontam o VT já adiantado.</span></div>`}
      </div>
      ${pro ? '' : html`<div class="form-row">
        <div class="field"><label for="le-vt">VT diferença (R$)</label><input type="number" id="le-vt" name="vt_adjust" step="0.01" value="${i.vt_adjust || 0}"><span class="hint">Positivo soma, negativo desconta.</span></div>
        <div class="field"><label for="le-vr">VR diferença (R$)</label><input type="number" id="le-vr" name="vr_adjust" step="0.01" value="${i.vr_adjust || 0}"></div>
      </div>`}
      ${e.requests?.length ? html`<div class="field"><label>Reembolsos lançados pela pessoa (incluídos)</label><ul class="rb-inlist">${e.requests.map(r => html`<li><span>${fmtDate(r.expense_date)} · ${r.description}</span><b>${money(r.amount)}</b>${filesLinks(r.files)}<button type="button" class="btn btn-ghost btn-sm" data-rb-rel="${r.id}">Tirar</button></li>`)}</ul></div>` : ''}
      <div class="form-row">
        <div class="field"><label for="le-r">${e.requests?.length ? 'Outro reembolso (manual, R$)' : 'Reembolso / outros (R$)'}</label><input type="number" id="le-r" name="reimbursement" step="0.01" min="0" value="${i.reimbursement || 0}"></div>
        <div class="field"><label for="le-rn">Descrição do reembolso</label><input type="text" id="le-rn" name="reimbursement_note" maxlength="300" value="${e.reimbursement_note || ''}" placeholder="Ex.: material de escritório"></div>
      </div>
      <div class="field"><label for="le-o">Observação no recibo</label><textarea id="le-o" name="notes" rows="2" maxlength="1000">${e.notes || ''}</textarea></div>
      <button type="button" class="btn btn-ghost btn-sm pf-danger" data-rm>${icon('trash')}Tirar desta folha</button>`,
    submitLabel: 'Salvar e recalcular',
    async onSubmit(d) {
      await api(`/payroll/entries/${e.id}`, { method: 'PUT', body: d });
      toast('Lançamento salvo.');
      render();
    },
  });
  setTimeout(() => document.querySelectorAll('.sheet [data-rb-rel]').forEach(b => b.addEventListener('click', async () => {
    try { await api(`/reimbursements/${b.dataset.rbRel}/release`, { method: 'POST' }); document.querySelector('.sheet [data-close]')?.click(); toast('Reembolso retirado da folha (volta a aguardar).'); render(); } catch (ex) { toast(ex.message, 'error'); }
  })), 60);
  setTimeout(() => document.querySelector('.sheet [data-rm]')?.addEventListener('click', async () => {
    document.querySelector('.sheet [data-close]')?.click();
    if (!(await confirmSheet('Tirar desta folha', `${e.name} sai da folha ${refLabel(m.ref)} (continua no cadastro da folha).`, 'Tirar', true))) return;
    try { await api(`/payroll/entries/${e.id}`, { method: 'DELETE' }); render(); } catch (ex) { toast(ex.message, 'error'); }
  }), 60);
}

// ---------- Pessoas da folha ----------
export async function people() {
  const data = await api('/payroll/people');
  return {
    title: 'Pessoas da folha',
    html: html`
      ${pageHead({
        back: { href: '#/folha', label: 'Folha (Administrativa)' },
        eyebrow: 'Folha (Administrativa)',
        title: 'Pessoas da folha',
        sub: 'Valor mensal, turno, empresa do recibo, PIX e escala de VT/VR. As pessoas vêm do Cadastro da Equipe.',
        actions: html`<a class="btn btn-primary" href="#/folha/pessoas/nova">${icon('plus')}Incluir pessoa</a>`,
      })}
      ${data.people.length ? html`<section class="card"><ul class="rows">${data.people.map(p => html`<li><a class="row-link ${p.active ? '' : 'is-off'}" href="#/folha/pessoas/${p.id}">
          ${avatar(p.name, 'sm', p.user_id)}<div class="grow"><div class="row-title">${p.name}${p.active ? '' : html` <span class="pf-st pf-st-fechada">Inativa</span>`}</div>
          <div class="row-meta"><span>${p.job_title || '—'}</span><span>${p.kind === 'profissional' ? 'Profissional' : 'Estágio'}</span><span>${money(p.monthly_value)}</span>
            ${p.kind !== 'profissional' && scheduleText(p.schedule, 'vt') ? html`<span>VT ${scheduleText(p.schedule, 'vt')}</span>` : ''}${p.kind !== 'profissional' && scheduleText(p.schedule, 'vr') ? html`<span>VR ${scheduleText(p.schedule, 'vr')}</span>` : ''}<span>${p.company_name}</span></div></div>
          <span class="chev">${icon('chevron')}</span></a></li>`)}</ul></section>`
        : html`<div class="empty-state"><h2>Nenhuma pessoa na folha</h2><p>Inclua as pessoas (estagiários e demais) com o valor mensal e a escala de VT/VR.</p></div>`}`,
  };
}

export async function personForm({ params, navigate }) {
  const editing = !!params.id;
  const [data, p] = await Promise.all([api('/payroll/people'), editing ? api(`/payroll/people/${params.id}`) : Promise.resolve(null)]);
  const v = p || { company: 'charao', kind: 'estagio', regime: 'Mensalista', schedule: {}, active: 1 };
  return {
    title: editing ? p.name : 'Incluir pessoa na folha',
    html: html`
      ${pageHead({ back: { href: '#/folha/pessoas', label: 'Pessoas da folha' }, eyebrow: 'Folha (Administrativa)', title: editing ? p.name : 'Incluir pessoa na folha' })}
      <form class="card card-pad form" id="pp-form" novalidate style="max-width:860px">
        ${editing ? html`<p class="muted" style="margin:0">${p.job_title || 'Sem função cadastrada'} · nome e função vêm do <a href="#/equipe/cadastro/${p.user_id}">Cadastro da Equipe</a>.</p>`
          : html`<div class="field"><label class="req" for="pp-u">Pessoa</label><select id="pp-u" name="user_id" required><option value="">Escolha…</option>
              ${data.candidates.map(u => html`<option value="${u.id}">${u.name}${u.job_title ? ` · ${u.job_title}` : ''}${u.login_enabled ? '' : ' (sem acesso)'}</option>`)}</select>
            <span class="hint">Não encontrou? Cadastre antes no <a href="#/equipe/cadastro/novo">Cadastro da Equipe</a> (pode ser sem acesso ao sistema).</span></div>`}
        <div class="form-row">
          <div class="field"><label for="pp-k">Tipo</label><select id="pp-k" name="kind">${data.kinds.map(k => html`<option value="${k.key}" ${v.kind === k.key ? 'selected' : ''}>${k.label}</option>`)}</select></div>
          <div class="field"><label for="pp-c">Empresa (logo do recibo)</label><select id="pp-c" name="company">${data.companies.map(c => html`<option value="${c.key}" ${v.company === c.key ? 'selected' : ''}>${c.name}</option>`)}</select></div>
        </div>
        <div class="form-row form-row-3">
          <div class="field"><label class="req" for="pp-v">Valor mensal (bolsa)</label><input type="number" id="pp-v" name="monthly_value" step="0.01" min="0" required value="${v.monthly_value ?? ''}"></div>
          <div class="field"><label for="pp-t">Turno</label><input type="text" id="pp-t" name="shift" maxlength="60" value="${v.shift || ''}" placeholder="08:00 às 12:00"></div>
          <div class="field"><label for="pp-r">Regime</label><input type="text" id="pp-r" name="regime" maxlength="40" value="${v.regime || 'Mensalista'}"></div>
        </div>
        <div class="form-row form-row-3">
          <div class="field"><label for="pp-s">Início do contrato</label><input type="date" id="pp-s" name="start_date" value="${v.start_date || ''}"></div>
          <div class="field"><label for="pp-e">Término do contrato</label><input type="date" id="pp-e" name="end_date" value="${v.end_date || ''}"></div>
          <div class="field"><label for="pp-cc">Centro de custo</label><input type="text" id="pp-cc" name="cost_center" maxlength="80" value="${v.cost_center || ''}" placeholder="CEC00-100%"></div>
        </div>
        <div class="field"><label for="pp-p">PIX</label><input type="text" id="pp-p" name="pix" maxlength="120" value="${v.pix || ''}" placeholder="Chave PIX (celular, e-mail, CPF…)"></div>
        <fieldset class="fieldset form pp-sched" ${v.kind === 'profissional' ? 'hidden' : ''}><legend>Escala de benefícios (dias presenciais)</legend>
          <span class="hint">Marque em quais dias a pessoa recebe VT (2 passagens) e VR. O valor do mês = quantidade de cada dia útil do mês × valor.</span>
          <table class="pp-grid"><thead><tr><th></th>${Object.values(WD).map(d => html`<th>${d}</th>`)}</tr></thead><tbody>
            ${['vt', 'vr'].map(k => html`<tr><th>${k.toUpperCase()}</th>${Object.keys(WD).map(w => html`<td><input type="checkbox" data-w="${w}" data-k="${k}" ${v.schedule?.[w]?.[k] ? 'checked' : ''} aria-label="${k.toUpperCase()} ${WD[w]}"></td>`)}</tr>`)}
          </tbody></table></fieldset>
        <div class="field"><label for="pp-n">Observações</label><textarea id="pp-n" name="notes" rows="2" maxlength="1000">${v.notes || ''}</textarea></div>
        ${editing ? html`<label class="pr-se-check"><input type="checkbox" name="active" ${v.active ? 'checked' : ''}> Ativa na folha (entra automaticamente nas novas folhas)</label>` : ''}
        <div class="form-actions"><a class="btn btn-ghost" href="#/folha/pessoas">Cancelar</a><button type="submit" class="btn btn-primary">${icon('check')}Salvar</button></div>
      </form>`,
    mount(root) {
      const f = root.querySelector('#pp-form');
      f.querySelector('[name=kind]').addEventListener('change', e => { f.querySelector('.pp-sched').hidden = e.target.value === 'profissional'; });
      f.addEventListener('submit', async e => {
        e.preventDefault();
        const d = Object.fromEntries(new FormData(f));
        d.schedule = {};
        f.querySelectorAll('[data-w]').forEach(c => { (d.schedule[c.dataset.w] ||= {})[c.dataset.k] = c.checked; });
        if (editing) d.active = !!f.querySelector('[name=active]')?.checked;
        try {
          await api(editing ? `/payroll/people/${p.id}` : '/payroll/people', { method: editing ? 'PUT' : 'POST', body: d });
          toast('Cadastro da folha salvo.');
          navigate('/folha/pessoas');
        } catch (ex) { toast(ex.message, 'error'); }
      });
    },
  };
}
