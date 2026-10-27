// Folha de Campo: folhas por obra (diárias da mão de obra própria e % das empreitadas), profissionais, empreitadas e consolidado.
// Valores, documento e PIX aparecem só para quem tem a seção Folha de Campo (que também fecha a folha e gera o pagamento).
import { html, api, icon, fmtDate, todayISO } from '../core.js';
import { toast, sheet, confirmSheet } from '../ui.js';
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
  <a href="#/campo/profissionais" class="${cur === 'prof' ? 'on' : ''}">Profissionais</a>
  <a href="#/campo/empreitadas${obra ? `?obra=${obra}` : ''}" class="${cur === 'emp' ? 'on' : ''}">Empreitadas</a>
  ${cur === 'cons' || obra ? html`<a href="#/campo/consolidado?obra=${obra || ''}" class="${cur === 'cons' ? 'on' : ''}" data-money-tab>Consolidado</a>` : ''}</nav>`;

// ---------- Folhas ----------
export async function list({ query, navigate, state }) {
  const obra = Number(query.get('obra')) || 0;
  const d = await api('/field/sheets', { query: { obra: obra || '' } });
  const mny = d.can_money;
  const projOpts = sel => d.projects.map(p => html`<option value="${p.id}" ${sel === p.id ? 'selected' : ''}>${p.code} · ${p.name}</option>`);
  return {
    title: 'Folha de Campo',
    html: html`
      ${pageHead({
        eyebrow: 'Gestão de Obras',
        title: 'Folha de Campo',
        sub: 'Medição da mão de obra própria (diárias) e das empreitadas por obra.',
        actions: html`<button type="button" class="btn btn-primary" data-new>${icon('plus')}Nova folha</button>`,
      })}
      ${fieldTabs('folhas', mny ? obra : 0)}
      <div class="fc-filter section"><label for="fc-obra">Obra</label><select id="fc-obra"><option value="">Todas as obras</option>${projOpts(obra)}</select></div>
      ${d.sheets.length ? html`<div class="pf-months">${d.sheets.map(s => html`<a class="pf-mcard" href="#/campo/${s.id}">
          <div class="pf-mtop"><b>${s.project_code} · ${s.code}</b>${stTag(s.status)}</div>
          <div class="pf-mper">${s.project_name}</div>
          <div class="pf-mper">${fmtDate(s.start_date)} a ${fmtDate(s.end_date)}</div>
          ${mny ? html`<div class="pf-mtotal">${money(s.totals.total)}</div>` : html`<div class="pf-mtotal">${n2(s.diarias)} diária(s)</div>`}
          <div class="pf-mfoot"><span>${s.people} pessoa(s)</span>${s.contracts ? html`<span>${s.contracts} empreitada(s)</span>` : ''}${mny ? html`<span>${n2(s.diarias)} diária(s)</span>${s.totals.client ? html`<span>Cliente ${money(s.totals.client)}</span>` : ''}${payTag(s.payment)}` : ''}</div>
        </a>`)}</div>`
        : html`<div class="empty-state"><h2>Nenhuma folha${obra ? ' nesta obra' : ''}</h2><p>Crie a folha do período: marque as diárias de cada pessoa por dia e o % executado das empreitadas.</p></div>`}
      <button type="button" class="fab" data-new aria-label="Nova folha">${icon('plus')}</button>`,
    mount(root) {
      root.querySelector('#fc-obra').addEventListener('change', e => navigate(`/campo${e.target.value ? `?obra=${e.target.value}` : ''}`));
      if (!mny) root.querySelector('[data-money-tab]')?.remove();
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
  const dayChips = e => html`<div class="fc-days">${s.days.map(d => {
    const q = Number(e.days[d]) || 0;
    return html`<button type="button" class="fc-day ${q === 1 ? 'q1' : q ? 'qh' : ''} ${[0, 6].includes(wd(d)) ? 'we' : ''}" data-day="${d}" data-w="${e.worker_id}" ${dis} aria-label="${WD[wd(d)]} ${dm(d)}: ${q || 0} diária">
      <small>${WD[wd(d)]}</small><span>${d.slice(8, 10)}</span><b>${qLabel(q)}</b></button>`;
  })}</div>`;
  const personCalc = e => {
    const c = pCalc(e);
    return mny ? html`${n2(c.diarias)} diária(s) × ${money(e.rate)} = <b>${money(c.gross)}</b>${num(e.adjust) ? html` · ajuste ${money(e.adjust)}` : ''}${num(e.client_paid) ? html` · cliente ${money(e.client_paid)}` : ''} · <b>empresa paga ${money(c.company)}</b>`
      : html`<b>${n2(c.diarias)} diária(s)</b>`;
  };
  const personCard = e => html`<li class="fc-person" data-p="${e.worker_id}">
    <div class="fc-ph"><div><b>${e.name}</b><small>${e.role || ''}${mny && e.pix ? ` · PIX ${e.pix_type ? `(${e.pix_type}) ` : ''}${e.pix}` : ''}</small></div>
      ${edit ? html`<span class="fc-pa"><button type="button" class="btn btn-ghost btn-sm" data-wk="${e.worker_id}" title="Marcar seg a sex">Seg–Sex</button><button type="button" class="icon-btn" data-rm="${e.worker_id}" aria-label="Retirar ${e.name} da folha">${icon('x')}</button></span>` : ''}</div>
    ${dayChips(e)}
    <div class="fc-pf">
      <label>Apropriar (serviço)<input type="text" list="fc-services" data-f="service" value="${e.service || ''}" ${dis} placeholder="Ex.: Demolição"></label>
      ${mny ? html`<label>Pago pelo cliente<input type="number" step="0.01" min="0" data-f="client_paid" value="${e.client_paid || ''}" ${dis}></label>
        <label>Ajuste (±)<input type="number" step="0.01" data-f="adjust" value="${e.adjust || ''}" ${dis} placeholder="desconto / adiantamento"></label>
        <label>Motivo do ajuste<input type="text" data-f="adjust_note" value="${e.adjust_note || ''}" ${dis}></label>` : ''}
    </div>
    <div class="fc-calc" data-calc="${e.worker_id}">${personCalc(e)}</div>
  </li>`;
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
      ${mny && s.payment ? html`<div class="notice section">${icon('wallet')}<span>Pagamento no Financeiro: <b>${money(s.payment.amount)}</b> com vencimento em ${fmtDate(s.payment.due_date)} — ${s.payment.status === 'paga' ? 'pago' : 'pendente'}.</span></div>` : ''}
      ${!mny ? html`<div class="notice section">${icon('info')}<span>Marque as diárias de cada pessoa por dia (toque: 1 → ½ → vazio) e o % executado das empreitadas. Valores e fechamento ficam com o escritório.</span></div>` : ''}
      <div class="pf-kpis section" id="fc-tot">${totals()}</div>
      <datalist id="fc-services">${s.services.map(x => html`<option value="${x}">`)}</datalist>
      <section class="card section">
        <div class="card-head"><h2>${icon('users')}Mão de obra própria (diárias)</h2><span class="sub">${st.people.length}</span></div>
        ${st.people.length ? html`<ul class="fc-list">${st.people.map(personCard)}</ul>` : html`<p class="muted card-body">Nenhuma pessoa nesta folha.</p>`}
        ${edit ? html`<div class="card-body pf-add fc-add"><select id="fc-addp"><option value="">Incluir profissional…</option>${s.available_workers.map(w => html`<option value="${w.id}">${w.name}${w.role ? ` · ${w.role}` : ''}</option>`)}</select>
          <button type="button" class="btn btn-ghost btn-sm" id="fc-addb">${icon('plus')}Incluir</button>
          <button type="button" class="btn btn-ghost btn-sm" id="fc-neww">${icon('user')}Novo profissional</button></div>` : ''}
      </section>
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
      const markDirty = () => { dirty = true; const el = root.querySelector('#fc-dirty'); if (el) el.hidden = false; };
      const refresh = () => {
        root.querySelector('#fc-tot').innerHTML = totals().toString();
        for (const e of st.people) { const el = root.querySelector(`[data-calc="${e.worker_id}"]`); if (el) el.innerHTML = personCalc(e).toString(); }
        for (const c of st.contracts) {
          const el = root.querySelector(`[data-ccalc="${c.contract_id}"]`); if (el) el.innerHTML = contractCalc(c).toString();
          const bar = root.querySelector(`[data-bar="${c.contract_id}"]`); if (bar) bar.style.width = `${Math.min(100 - c.before_pct, num(c.pct))}%`;
        }
      };
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
      root.addEventListener('click', e => {
        const chip = e.target.closest('.fc-day');
        if (chip && edit) {
          const p = st.people.find(x => x.worker_id === Number(chip.dataset.w));
          const q = NEXT[Number(p.days[chip.dataset.day]) || 0] ?? 0;
          if (q) p.days[chip.dataset.day] = q; else delete p.days[chip.dataset.day];
          chip.classList.toggle('q1', q === 1); chip.classList.toggle('qh', q === 0.5);
          chip.querySelector('b').textContent = qLabel(q);
          markDirty(); refresh();
          return;
        }
        const wk = e.target.closest('[data-wk]');
        if (wk) {
          const p = st.people.find(x => x.worker_id === Number(wk.dataset.wk));
          for (const d of s.days) if (wd(d) >= 1 && wd(d) <= 5) p.days[d] = 1;
          root.querySelectorAll(`.fc-day[data-w="${p.worker_id}"]`).forEach(c => { const q = Number(p.days[c.dataset.day]) || 0; c.classList.toggle('q1', q === 1); c.classList.toggle('qh', q === 0.5); c.querySelector('b').textContent = qLabel(q); });
          markDirty(); refresh();
        }
      });
      root.addEventListener('input', e => {
        const f = e.target.dataset.f, cf = e.target.dataset.cf;
        if (f) { st.people.find(x => x.worker_id === Number(e.target.closest('[data-p]').dataset.p))[f] = e.target.value; markDirty(); refresh(); }
        if (cf) { st.contracts.find(x => x.contract_id === Number(e.target.closest('[data-c]').dataset.c))[cf] = e.target.value; markDirty(); refresh(); }
        if (e.target.id === 'fc-act' || e.target.id === 'fc-payd') markDirty();
      });
      // Incluir/retirar salva o que já foi lançado e recarrega
      const saveAnd = async (fn, msg) => { try { const b = body(); fn(b); await api(`/field/sheets/${s.id}`, { method: 'PUT', body: b }); dirty = false; if (msg) toast(msg); render(); } catch (ex) { toast(ex.message, 'error'); } };
      root.querySelectorAll('[data-rm]').forEach(b => b.addEventListener('click', async () => {
        const p = st.people.find(x => x.worker_id === Number(b.dataset.rm));
        if (!(await confirmSheet('Retirar da folha', `Retirar ${p.name} desta folha? As diárias marcadas serão perdidas.`, 'Retirar', true))) return;
        saveAnd(x => { x.people = x.people.filter(y => y.worker_id !== p.worker_id); });
      }));
      root.querySelectorAll('[data-rmc]').forEach(b => b.addEventListener('click', () => saveAnd(x => { x.contracts = x.contracts.filter(y => y.contract_id !== Number(b.dataset.rmc)); })));
      root.querySelector('#fc-addb')?.addEventListener('click', () => {
        const v = Number(root.querySelector('#fc-addp').value);
        if (v) saveAnd(x => { x.people.push({ worker_id: v, days: {} }); });
      });
      root.querySelector('#fc-addcb')?.addEventListener('click', () => {
        const v = Number(root.querySelector('#fc-addc').value);
        if (v) saveAnd(x => { x.contracts.push({ contract_id: v, pct: 0 }); });
      });
      root.querySelector('#fc-neww')?.addEventListener('click', () => workerSheet(null, mny, async w => saveAnd(x => { x.people.push({ worker_id: w.id, days: {} }); }, 'Profissional cadastrado e incluído.')));
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
function workerSheet(w, mny, done, pixTypes = ['CPF', 'CNPJ', 'Telefone', 'E-mail', 'Aleatória']) {
  const v = w || { kind: 'diarista', active: 1 };
  return sheet({
    title: w ? w.name : 'Novo profissional',
    body: html`<div class="field"><label class="req" for="fw-n">Nome</label><input type="text" id="fw-n" name="name" required maxlength="120" value="${v.name || ''}"></div>
      <div class="form-row"><div class="field"><label for="fw-k">Tipo</label><select id="fw-k" name="kind"><option value="diarista" ${v.kind === 'diarista' ? 'selected' : ''}>Diarista (mão de obra própria)</option><option value="empreiteiro" ${v.kind === 'empreiteiro' ? 'selected' : ''}>Empreiteiro</option></select></div>
        <div class="field"><label for="fw-r">Função</label><input type="text" id="fw-r" name="role" maxlength="60" value="${v.role || ''}" placeholder="Pedreiro, Ajudante, Mestre…"></div></div>
      ${mny ? html`<div class="form-row"><div class="field"><label for="fw-d">Valor da diária</label><input type="number" step="0.01" min="0" id="fw-d" name="daily_rate" value="${v.daily_rate ?? ''}"></div>
          <div class="field"><label for="fw-doc">CPF / CNPJ</label><input type="text" id="fw-doc" name="doc" maxlength="30" value="${v.doc || ''}"></div></div>
        <div class="form-row"><div class="field"><label for="fw-pt">Tipo do PIX</label><select id="fw-pt" name="pix_type"><option value="">—</option>${pixTypes.map(t => html`<option ${v.pix_type === t ? 'selected' : ''}>${t}</option>`)}</select></div>
          <div class="field"><label for="fw-p">Chave PIX</label><input type="text" id="fw-p" name="pix" maxlength="120" value="${v.pix || ''}"></div></div>
        <div class="field"><label for="fw-ph">Telefone</label><input type="text" id="fw-ph" name="phone" maxlength="30" value="${v.phone || ''}"></div>
        <div class="field"><label for="fw-no">Observações</label><textarea id="fw-no" name="notes" rows="2">${v.notes || ''}</textarea></div>
        ${w ? html`<label class="pr-se-check"><input type="checkbox" name="active" value="1" ${v.active ? 'checked' : ''}> Ativo</label>` : ''}`
        : html`<span class="hint">Valor da diária, documento e PIX são preenchidos pelo escritório.</span>`}`,
    submitLabel: w ? 'Salvar' : 'Cadastrar',
    async onSubmit(f) {
      if (w) f.active = f.active ? 1 : 0;
      const r = await api(w ? `/field/workers/${w.id}` : '/field/workers', { method: w ? 'PUT' : 'POST', body: f });
      await done?.(r);
      return r;
    },
  });
}

export async function workers({ render }) {
  const d = await api('/field/workers');
  const mny = d.can_money;
  const row = w => html`<li class="fc-wrow ${w.active ? '' : 'fc-off'}"><div class="grow"><div class="row-title">${w.name}${w.active ? '' : ' (inativo)'}</div>
    <div class="row-meta"><span>${w.kind === 'empreiteiro' ? 'Empreiteiro' : 'Diarista'}</span>${w.role ? html`<span>${w.role}</span>` : ''}${mny && w.kind === 'diarista' ? html`<span>Diária ${money(w.daily_rate)}</span>` : ''}${mny && w.pix ? html`<span>PIX ${w.pix_type ? `(${w.pix_type}) ` : ''}${w.pix}</span>` : ''}${mny && !w.daily_rate && w.kind === 'diarista' ? html`<span class="fc-warn">sem valor da diária</span>` : ''}</div></div>
    ${mny ? html`<button type="button" class="btn btn-ghost btn-sm" data-ed="${w.id}">${icon('edit')}Editar</button>` : ''}</li>`;
  const group = (k, label) => { const l = d.workers.filter(w => w.kind === k); return html`<section class="card section"><div class="card-head"><h2>${label}</h2><span class="sub">${l.length}</span></div>
    ${l.length ? html`<ul class="rows">${l.map(row)}</ul>` : html`<p class="muted card-body">Nenhum cadastrado.</p>`}</section>`; };
  return {
    title: 'Profissionais · Folha de Campo',
    html: html`${pageHead({ eyebrow: 'Folha de Campo', title: 'Profissionais', sub: mny ? 'Diaristas (função e valor da diária) e empreiteiros, com documento e PIX.' : 'Diaristas e empreiteiros da Folha de Campo.',
        actions: html`<button type="button" class="btn btn-primary" data-new>${icon('plus')}Novo profissional</button>` })}
      ${fieldTabs('prof', 0)}
      ${group('diarista', 'Diaristas (mão de obra própria)')}${group('empreiteiro', 'Empreiteiros')}`,
    mount(root) {
      if (!mny) root.querySelector('[data-money-tab]')?.remove();
      root.querySelector('[data-new]').addEventListener('click', () => workerSheet(null, mny, () => { toast('Profissional cadastrado.'); render(); }, d.pix_types));
      root.querySelectorAll('[data-ed]').forEach(b => b.addEventListener('click', () => workerSheet(d.workers.find(w => w.id === Number(b.dataset.ed)), mny, () => { toast('Cadastro salvo.'); render(); }, d.pix_types)));
    },
  };
}

// ---------- Empreitadas ----------
export async function contracts({ query, navigate, render }) {
  const obra = Number(query.get('obra')) || 0;
  const [list, sh, wk] = await Promise.all([api('/field/contracts', { query: { obra: obra || '' } }), api('/field/sheets'), api('/field/workers')]);
  const mny = wk.can_money;
  const projects = sh.projects;
  const emp = wk.workers.filter(w => w.kind === 'empreiteiro' && w.active);
  const form = c => sheet({
    title: c ? c.service : 'Nova empreitada',
    body: html`<div class="field"><label class="req" for="ec-p">Obra</label><select id="ec-p" name="project_id" required ${c ? 'disabled' : ''}>${!obra && !c ? html`<option value="">Escolha…</option>` : ''}${projects.map(p => html`<option value="${p.id}" ${(c ? c.project_id : obra) === p.id ? 'selected' : ''}>${p.code} · ${p.name}</option>`)}</select></div>
      <div class="field"><label class="req" for="ec-w">Empreiteiro</label><select id="ec-w" name="worker_id" required><option value="">Escolha…</option>${emp.map(w => html`<option value="${w.id}" ${c?.worker_id === w.id ? 'selected' : ''}>${w.name}</option>`)}</select>
        ${!emp.length ? html`<span class="hint">Cadastre o empreiteiro em Profissionais (tipo Empreiteiro).</span>` : ''}</div>
      <div class="field"><label class="req" for="ec-s">Serviço</label><input type="text" id="ec-s" name="service" required maxlength="200" value="${c?.service || ''}" placeholder="Ex.: Pintura da fachada"></div>
      <div class="form-row"><div class="field"><label class="req" for="ec-t">Valor total</label><input type="number" step="0.01" min="0" id="ec-t" name="total" required value="${c?.total ?? ''}"></div>
        <div class="field"><label for="ec-d">Início</label><input type="date" id="ec-d" name="start_date" value="${c?.start_date || ''}"></div></div>
      <div class="field"><label for="ec-n">Observações</label><textarea id="ec-n" name="notes" rows="2">${c?.notes || ''}</textarea></div>
      ${c ? html`<label class="pr-se-check"><input type="checkbox" name="encerrada" value="1" ${c.status === 'encerrada' ? 'checked' : ''}> Encerrada (não aparece mais para medir)</label>` : ''}`,
    submitLabel: c ? 'Salvar' : 'Cadastrar',
    async onSubmit(f) {
      if (c) { f.project_id = c.project_id; f.status = f.encerrada ? 'encerrada' : 'ativa'; }
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
      ${list.length ? html`<section class="card section"><ul class="rows">${list.map(c => html`<li class="fc-wrow ${c.status === 'encerrada' ? 'fc-off' : ''}"><div class="grow">
          <div class="row-title">${c.service} · ${c.worker_name}${c.status === 'encerrada' ? ' (encerrada)' : ''}</div>
          <div class="row-meta"><span>${c.project_code}</span>${mny ? html`<span>Contrato ${money(c.total)}</span><span>Medido ${money(c.measured)}</span><span>Saldo ${money(c.balance)}</span>` : ''}<span>${n2(c.measured_pct)}% medido</span></div>
          <div class="fc-bar"><span style="width:${Math.min(100, c.measured_pct)}%"></span></div></div>
          ${mny ? html`<button type="button" class="btn btn-ghost btn-sm" data-ed="${c.id}">${icon('edit')}Editar</button>` : ''}</li>`)}</ul></section>`
        : html`<div class="empty-state"><h2>Nenhuma empreitada${obra ? ' nesta obra' : ''}</h2><p>${mny ? 'Cadastre a empreitada (empreiteiro, serviço e valor total) para medi-la nas folhas.' : 'O escritório cadastra as empreitadas da obra.'}</p></div>`}`,
    mount(root) {
      if (!mny) root.querySelector('[data-money-tab]')?.remove();
      root.querySelector('#ec-obra').addEventListener('change', e => navigate(`/campo/empreitadas${e.target.value ? `?obra=${e.target.value}` : ''}`));
      root.querySelector('[data-new]')?.addEventListener('click', () => form(null));
      root.querySelectorAll('[data-ed]').forEach(b => b.addEventListener('click', () => form(list.find(c => c.id === Number(b.dataset.ed)))));
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
