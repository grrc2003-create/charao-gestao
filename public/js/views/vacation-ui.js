// Férias: janela de solicitação/lançamento (com prévia das regras de férias), aprovações e card do Meu painel.
import { html, api, icon, fmtDate, todayISO } from '../core.js';
import { toast, sheet } from '../ui.js';

export const VAC_ST = {
  disponivel: ['Disponível', '#1F6B41'], vencendo: ['Vencendo', '#B7791F'], vencida: ['Vencida (em dobro)', '#C0392B'],
  em_aquisicao: ['Em aquisição', '#707E8B'], quitado: ['Quitado (antes do sistema)', '#8A96A3'], concluido: ['Em dia', '#1F6B41'], sem_admissao: ['Sem data de admissão', '#B7791F'],
};
const REQ_ST = { solicitada: ['Aguardando aprovação', '#B7791F'], aprovada: ['Aprovada', '#1F6B41'], recusada: ['Recusada', '#9E2B20'], cancelada: ['Cancelada', '#8A96A3'] };
export const vacPill = s => (s && VAC_ST[s] ? html`<span class="rg-st" style="--c:${VAC_ST[s][1]}">${VAC_ST[s][0]}</span>` : '');
export const reqPill = s => html`<span class="rg-st" style="--c:${REQ_ST[s][1]}">${REQ_ST[s][0]}</span>`;
const dm = d => fmtDate(d).slice(0, 5);

// Tarefas com entrega no período (férias ou ausência): novo prazo OU manter o prazo explicando (acordado com o líder)
export function conflictBlock(list, { keep = new Map(), what = 'nas férias', when = 'o gestor aprovar' } = {}) {
  if (!list.length) return '';
  return html`<div class="vs-conf-head">${icon('reschedule')}<span><b>${list.length} tarefa(s) com entrega ${what}.</b> Para cada uma, proponha um <b>novo prazo</b> ou <b>mantenha o prazo explicando</b> como fica (ex.: entrego antes, outra pessoa cobre). Vale quando ${when}.</span></div>
    <ul class="vs-conf-list">${list.map(t => { const k = keep.get(String(t.id)) || {}; const mode = k.mode || 'date'; return html`<li data-rs-row="${t.id}"><div class="grow"><b class="mono">${t.code}</b> ${t.title}<small>${t.project_code || ''} · prazo atual ${fmtDate(t.due_date)}</small></div>
      <div class="vs-rs-opts">
        <label class="vs-rs-opt"><input type="radio" name="rsm_${t.id}" value="date" ${mode === 'date' ? 'checked' : ''}>Novo prazo <input type="date" data-rs-task="${t.id}" value="${k.date || t.suggested || ''}"></label>
        <label class="vs-rs-opt"><input type="radio" name="rsm_${t.id}" value="keep" ${mode === 'keep' ? 'checked' : ''}>Manter o prazo <input type="text" data-rs-why="${t.id}" maxlength="500" placeholder="Explique: ex. entrego antes" value="${k.why || ''}"></label>
      </div></li>`; })}</ul>`;
}
export const readConflicts = root => [...root.querySelectorAll('[data-rs-row]')].map(li => {
  const id = Number(li.dataset.rsRow);
  const mode = li.querySelector(`input[name="rsm_${id}"]:checked`)?.value || 'date';
  return mode === 'keep' ? { task_id: id, explanation: li.querySelector('[data-rs-why]').value.trim() } : { task_id: id, new_due: li.querySelector('[data-rs-task]').value };
});
const keepConflicts = root => new Map([...root.querySelectorAll('[data-rs-row]')].map(li => { const id = li.dataset.rsRow; return [id, { mode: li.querySelector(`input[name="rsm_${id}"]:checked`)?.value, date: li.querySelector('[data-rs-task]').value, why: li.querySelector('[data-rs-why]').value }]; }));
const proposalText = r => (r.new_due === r.old_due ? html`prazo mantido (${dm(r.old_due)}) — “${r.explanation || ''}”` : html`${dm(r.old_due)} → <b>${dm(r.new_due)}</b>${r.explanation ? ` — “${r.explanation}”` : ''}`);
export const proposalsBox = (items, applied) => (items?.length ? html`<div class="vac-rs"><b>Tarefas no período (${applied ? 'aplicado' : 'vale ao aprovar'}):</b>${items.map(r => html`<span><span class="mono">${r.code}</span> ${r.title}: ${proposalText(r)}</span>`)}</div>` : '');
export const newConflictsBox = list => (list?.length ? html`<div class="vac-rs is-new"><b>Tarefas novas com entrega no período — novo prazo ou explicação para aprovar:</b>${list.map(c => html`<span class="vs-ap-row"><span class="mono">${c.code}</span> ${c.title} (${dm(c.due_date)})
  <input type="date" data-ap-rs="${c.id}" value="${c.suggested}" aria-label="Novo prazo"><input type="text" data-ap-why="${c.id}" maxlength="500" placeholder="ou explique para manter o prazo" aria-label="Explicação"></span>`)}</div>` : '');
export const readApprovalConflicts = li => [...li.querySelectorAll('[data-ap-rs]')].map(i => { const id = Number(i.dataset.apRs); const why = li.querySelector(`[data-ap-why="${id}"]`)?.value.trim(); return why ? { task_id: id, explanation: why } : { task_id: id, new_due: i.value }; });

// Solicitar (própria pessoa) ou lançar (gestor/RH) férias, com prévia das regras
export async function vacationSheet({ people = null, userId = null, title = 'Solicitar férias', mode = null } = {}) {
  const p = sheet({
    title,
    body: html`
      ${people ? html`<div class="field"><label class="req" for="vs-user">Pessoa</label><select id="vs-user" name="user_id" required>
        <option value="">Escolha…</option>${people.map(x => html`<option value="${x.id}" ${userId === x.id ? 'selected' : ''}>${x.name}${x.job_title ? ` · ${x.job_title}` : ''}</option>`)}</select></div>` : ''}
      <div class="form-row">
        <div class="field"><label class="req" for="vs-start">Início</label><input id="vs-start" name="start_date" type="date" min="${people ? '' : todayISO()}" required></div>
        <div class="field"><label class="req" for="vs-days">Dias</label><select id="vs-days" name="days">${Array.from({ length: 30 }, (_, i) => 30 - i).map(n => html`<option value="${n}" ${mode && mode !== 'clt' && n === 1 ? 'selected' : ''}>${n} ${n === 1 ? 'dia' : 'dias'}</option>`)}</select></div>
      </div>
      <div class="field"><label for="vs-note">Observação</label><textarea id="vs-note" name="note" rows="2" maxlength="1000"></textarea></div>
      <div class="vs-preview" id="vs-prev"><span class="muted">Informe o início para ver o período e as regras.</span></div>
      <div class="vs-conf" id="vs-conf" hidden></div>
      <p class="hint" style="margin:0" id="vs-rules">${mode && mode !== 'clt' ? '' : 'Regras: até 3 partes por período aquisitivo (uma com 14 dias ou mais, as demais com 5 ou mais) e início fora dos 2 dias antes de feriado ou domingo.'}</p>`,
    submitLabel: people ? 'Lançar férias' : 'Enviar solicitação',
    onSubmit: (d, form) => {
      const reschedules = readConflicts(form);
      for (const k of Object.keys(d)) if (k.startsWith('rs_') || k.startsWith('rsm_')) delete d[k];
      return api('/vacations', { method: 'POST', body: { ...d, user_id: d.user_id ? Number(d.user_id) : userId, days: Number(d.days), reschedules } });
    },
  });
  const form = document.querySelector('.sheet-backdrop:last-child form');
  const prev = form.querySelector('#vs-prev');
  const conf = form.querySelector('#vs-conf');
  let seq = 0;
  const refresh = async () => {
    const start = form.querySelector('#vs-start').value;
    const uid = form.querySelector('#vs-user')?.value || userId;
    if (!start || (people && !uid)) return;
    const my = ++seq;
    try {
      const r = await api('/vacations/preview', { method: 'POST', body: { user_id: uid ? Number(uid) : null, start_date: start, days: Number(form.querySelector('#vs-days').value) } });
      if (my !== seq) return;
      if (r.rules) form.querySelector('#vs-rules').textContent = r.rules;
      prev.innerHTML = (r.ok
        ? html`<div class="vs-ok">${icon('check')}<span><b>${fmtDate(r.start_date)} a ${fmtDate(r.end_date)}</b> (${r.days} ${r.days === 1 ? 'dia' : 'dias'})${r.mode && r.mode !== 'clt' ? html` · ${r.label}` : html` · período aquisitivo ${fmtDate(r.period.start)}–${fmtDate(r.period.end)}`} ·
            saldo depois: <b>${r.period.balance_after} dia(s)</b>${r.period.concession_end ? html` · gozar até ${fmtDate(r.period.concession_end)}` : ''}</span></div>
          ${r.warnings.map(w => html`<div class="vs-warn">${icon('alert')}<span>${w}</span></div>`)}`
        : html`<div class="vs-err">${icon('x')}<span>${r.error}</span></div>`).toString();
      // Entregas dentro do período: novo prazo ou explicação de cada uma (vale quando o líder aprovar)
      const keep = keepConflicts(conf);
      const list = r.ok ? r.conflicts || [] : [];
      conf.hidden = !list.length;
      conf.innerHTML = conflictBlock(list, { keep, what: `n${r.mode === 'estagio' ? 'o recesso' : 'as férias'}`, when: people ? 'for lançado' : 'o gestor aprovar' }).toString();
    } catch (e) { prev.textContent = e.message; }
  };
  form.addEventListener('change', e => { if (!e.target.closest('[data-rs-row]')) refresh(); });
  const res = await p;
  if (res) toast(res.status === 'aprovada' ? 'Lançado.' : 'Solicitação enviada ao gestor.');
  return res;
}

// Lista de solicitações aguardando aprovação (com botões)
export function approvalsList(items) {
  return html`<ul class="rows">${items.map(v => html`<li class="vac-appr"><div class="grow"><div class="row-title">${v.user_name}</div>
    <div class="row-meta"><span><b>${fmtDate(v.start_date)} a ${fmtDate(v.end_date)}</b> · ${v.days} dias</span>${v.note ? html`<span>“${v.note}”</span>` : ''}<span>pedido por ${v.requested_by_name}</span></div>
    ${proposalsBox(v.reschedules, false)}
    ${newConflictsBox(v.new_conflicts)}</div>
    <div class="vac-appr-acts"><button type="button" class="btn btn-success btn-sm" data-vapprove="${v.id}">${icon('check')}Aprovar</button>
      <button type="button" class="btn btn-ghost btn-sm" data-vreject="${v.id}">Recusar</button></div></li>`)}</ul>`;
}
export function bindApprovals(root, after) {
  root.querySelectorAll('[data-vapprove]').forEach(b => b.addEventListener('click', async () => {
    const reschedules = readApprovalConflicts(b.closest('li'));
    try { await api(`/vacations/${b.dataset.vapprove}/approve`, { method: 'POST', body: { reschedules } }); toast(reschedules.length || b.closest('li').querySelector('.vac-rs') ? 'Férias aprovadas e prazos reagendados.' : 'Férias aprovadas.'); after(); } catch (e) { toast(e.message, 'err'); }
  }));
  root.querySelectorAll('[data-vreject]').forEach(b => b.addEventListener('click', async () => {
    const r = await sheet({ title: 'Recusar férias', body: html`<div class="field"><label class="req" for="vr-n">Motivo</label><textarea id="vr-n" name="note" rows="3" required></textarea></div>`,
      submitLabel: 'Recusar', danger: true, onSubmit: d => api(`/vacations/${b.dataset.vreject}/reject`, { method: 'POST', body: d }) });
    if (r) { toast('Solicitação recusada.'); after(); }
  }));
}

// Histórico de férias de uma pessoa (períodos aquisitivos e pedidos), com cancelamento
export function periodsTable(d) {
  return html`${d.periods.length ? html`<div class="table-wrap"><table class="data"><thead><tr><th>Período aquisitivo</th><th>Gozar até</th><th class="num">Gozados</th><th class="num">Pedidos</th><th class="num">Saldo</th><th>Situação</th></tr></thead>
    <tbody>${d.periods.map(p => html`<tr><td class="nowrap">${fmtDate(p.start)} – ${fmtDate(p.end)}</td><td class="nowrap">${p.acquired && p.concession_end ? fmtDate(p.concession_end) : p.right !== undefined ? `${p.right} dia(s) de direito` : '—'}</td>
      <td class="num">${p.used}</td><td class="num">${p.pending}</td><td class="num"><b>${p.acquired || p.right !== undefined ? p.balance : '—'}</b></td><td>${vacPill(p.status === 'concluido' ? 'concluido' : p.status)}</td></tr>`)}</tbody></table></div>` : ''}
    ${d.requests.length ? html`<ul class="rows" style="margin-top:10px">${d.requests.map(v => html`<li><div class="row-link"><div class="grow"><div class="row-title">${fmtDate(v.start_date)} a ${fmtDate(v.end_date)} · ${v.days} dias</div>
      <div class="row-meta"><span>pedido por ${v.requested_by_name}</span>${v.decided_by_name ? html`<span>${v.status === 'aprovada' ? 'aprovado' : v.status === 'recusada' ? 'recusado' : 'cancelado'} por ${v.decided_by_name}</span>` : ''}${v.decision_note ? html`<span>“${v.decision_note}”</span>` : ''}
        ${v.reschedules?.length ? html`<span>${v.reschedules.length} tarefa(s) no período: ${v.reschedules.map(r => (r.new_due === r.old_due ? `${r.code} prazo mantido` : `${r.code} → ${dm(r.new_due)}`)).join(', ')}</span>` : ''}</div></div>
      ${reqPill(v.status)}${['solicitada', 'aprovada'].includes(v.status) && v.end_date >= todayISO() ? html`<button type="button" class="icon-btn" data-vcancel="${v.id}" title="Cancelar" aria-label="Cancelar férias">✕</button>` : ''}</div></li>`)}</ul>`
      : html`<p class="muted">Nenhuma férias registrada.</p>`}`;
}
export function bindCancel(root, after) {
  root.querySelectorAll('[data-vcancel]').forEach(b => b.addEventListener('click', async () => {
    const r = await sheet({ title: 'Cancelar férias', body: html`<div class="field"><label for="vc-n">Motivo</label><textarea id="vc-n" name="note" rows="2"></textarea></div>`,
      submitLabel: 'Cancelar férias', danger: true, onSubmit: d => api(`/vacations/${b.dataset.vcancel}/cancel`, { method: 'POST', body: d }) });
    if (r) { toast('Férias canceladas.'); after(); }
  }));
}

// Card do Meu painel: minhas férias + aprovações pendentes da minha equipe
export function myVacationCard(v, user, { bare = false } = {}) {
  if (user.is_external) return '';
  const s = v.summary || {};
  const next = v.requests.filter(r => r.status === 'aprovada' && r.end_date >= todayISO()).sort((a, b) => a.start_date.localeCompare(b.start_date))[0];
  const pend = v.requests.filter(r => r.status === 'solicitada');
  const cards = html`
    <section class="card" id="my-vac"><div class="card-head"><h2>${icon('calendar')}${s.mode === 'estagio' ? 'Meu recesso' : 'Minhas férias'}</h2>${vacPill(s.status)}</div>
      <div class="card-body vac-mine">
        ${s.status === 'sem_admissao' ? html`<p class="muted" style="margin:0">Sua data de admissão ainda não foi informada. Peça à Gestão da Equipe para completar o seu cadastro.</p>` : html`
          <div class="vac-big"><b>${s.available}</b><span>dia(s) disponíveis${s.deadline ? html` · gozar até <b>${fmtDate(s.deadline)}</b>` : ''}${s.mode && s.mode !== 'clt' ? html` · proporcional ao tempo de contrato${s.advance ? ` (pode antecipar até ${s.advance} dias)` : ''}` : ''}</span></div>
          ${s.mode && s.mode !== 'clt' ? html`<div class="muted" style="font-size:12.5px">${s.label}: ${s.rules}</div>` : ''}
          ${s.next_right ? html`<div class="muted" style="font-size:13px">Próximo período de 30 dias a partir de ${fmtDate(s.next_right)}</div>` : ''}
          ${next ? html`<div class="vac-next">${icon('check')}Próximas férias: <b>${fmtDate(next.start_date)} a ${fmtDate(next.end_date)}</b> (${next.days} dias)</div>` : ''}
          ${pend.map(r => html`<div class="vac-next is-pend">${icon('clock')}Aguardando aprovação: <b>${dm(r.start_date)} a ${dm(r.end_date)}</b> (${r.days} dias)</div>`)}
          <div class="rg-task-acts"><button type="button" class="btn btn-primary btn-sm" data-vac-req>${icon('plus')}Solicitar ${s.mode === 'estagio' ? 'recesso' : 'férias'}</button>
            <button type="button" class="btn btn-ghost btn-sm" data-vac-hist>Histórico</button>
            <a class="btn btn-ghost btn-sm" href="#/painel/ausencias-ferias">Solicitações</a></div>`}
      </div></section>
    ${v.approvals.length ? html`<section class="card" id="vac-appr"><div class="card-head"><h2>${icon('team')}Férias para aprovar</h2><span class="sub">${v.approvals.length}</span></div>
      ${approvalsList(v.approvals)}</section>` : ''}`;
  return bare ? cards : html`<div class="grid grid-dash section">${cards}</div>`;
}
export function bindMyVacationCard(root, v, render) {
  root.querySelector('[data-vac-req]')?.addEventListener('click', async () => { if (await vacationSheet({ mode: v.summary?.mode, title: v.summary?.mode === 'estagio' ? 'Solicitar recesso' : 'Solicitar férias' })) render(); });
  root.querySelector('[data-vac-hist]')?.addEventListener('click', () => {
    sheet({ title: 'Minhas férias', wide: true, body: periodsTable(v), submitLabel: 'Fechar' });
    bindCancel(document.querySelector('.sheet-backdrop:last-child'), () => { document.querySelector('.sheet-backdrop:last-child [data-close]')?.click(); render(); });
  });
  bindApprovals(root.querySelector('#vac-appr') || document.createElement('div'), render);
}
