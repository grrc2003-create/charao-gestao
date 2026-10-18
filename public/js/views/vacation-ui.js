// Férias: janela de solicitação/lançamento (com prévia das regras da CLT), aprovações e card do Meu painel.
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

// Solicitar (própria pessoa) ou lançar (gestor/RH) férias, com prévia das regras
export async function vacationSheet({ people = null, userId = null, title = 'Solicitar férias' } = {}) {
  const p = sheet({
    title,
    body: html`
      ${people ? html`<div class="field"><label class="req" for="vs-user">Pessoa</label><select id="vs-user" name="user_id" required>
        <option value="">Escolha…</option>${people.map(x => html`<option value="${x.id}" ${userId === x.id ? 'selected' : ''}>${x.name}${x.job_title ? ` · ${x.job_title}` : ''}</option>`)}</select></div>` : ''}
      <div class="form-row">
        <div class="field"><label class="req" for="vs-start">Início</label><input id="vs-start" name="start_date" type="date" min="${people ? '' : todayISO()}" required></div>
        <div class="field"><label class="req" for="vs-days">Dias</label><select id="vs-days" name="days">${Array.from({ length: 26 }, (_, i) => 30 - i).map(n => html`<option value="${n}">${n} dias</option>`)}</select></div>
      </div>
      <div class="field"><label for="vs-note">Observação</label><textarea id="vs-note" name="note" rows="2" maxlength="1000"></textarea></div>
      <div class="vs-preview" id="vs-prev"><span class="muted">Informe o início para ver o período e as regras.</span></div>
      <p class="hint" style="margin:0">Regras da CLT: até 3 partes por período aquisitivo (uma com 14 dias ou mais, as demais com 5 ou mais) e início fora dos 2 dias antes de feriado ou domingo.</p>`,
    submitLabel: people ? 'Lançar férias' : 'Enviar solicitação',
    onSubmit: d => api('/vacations', { method: 'POST', body: { ...d, user_id: d.user_id ? Number(d.user_id) : userId, days: Number(d.days) } }),
  });
  const form = document.querySelector('.sheet-backdrop:last-child form');
  const prev = form.querySelector('#vs-prev');
  let seq = 0;
  const refresh = async () => {
    const start = form.querySelector('#vs-start').value;
    const uid = form.querySelector('#vs-user')?.value || userId;
    if (!start || (people && !uid)) return;
    const my = ++seq;
    try {
      const r = await api('/vacations/preview', { method: 'POST', body: { user_id: uid ? Number(uid) : null, start_date: start, days: Number(form.querySelector('#vs-days').value) } });
      if (my !== seq) return;
      prev.innerHTML = (r.ok
        ? html`<div class="vs-ok">${icon('check')}<span><b>${fmtDate(r.start_date)} a ${fmtDate(r.end_date)}</b> (${r.days} dias) · período aquisitivo ${fmtDate(r.period.start)}–${fmtDate(r.period.end)} ·
            saldo depois: <b>${r.period.balance_after} dia(s)</b> · gozar até ${fmtDate(r.period.concession_end)}</span></div>
          ${r.warnings.map(w => html`<div class="vs-warn">${icon('alert')}<span>${w}</span></div>`)}`
        : html`<div class="vs-err">${icon('x')}<span>${r.error}</span></div>`).toString();
    } catch (e) { prev.textContent = e.message; }
  };
  form.addEventListener('change', refresh);
  const res = await p;
  if (res) toast(res.status === 'aprovada' ? 'Férias lançadas.' : 'Solicitação enviada ao gestor.');
  return res;
}

// Lista de solicitações aguardando aprovação (com botões)
export function approvalsList(items) {
  return html`<ul class="rows">${items.map(v => html`<li class="vac-appr"><div class="grow"><div class="row-title">${v.user_name}</div>
    <div class="row-meta"><span><b>${fmtDate(v.start_date)} a ${fmtDate(v.end_date)}</b> · ${v.days} dias</span>${v.note ? html`<span>“${v.note}”</span>` : ''}<span>pedido por ${v.requested_by_name}</span></div></div>
    <div class="vac-appr-acts"><button type="button" class="btn btn-success btn-sm" data-vapprove="${v.id}">${icon('check')}Aprovar</button>
      <button type="button" class="btn btn-ghost btn-sm" data-vreject="${v.id}">Recusar</button></div></li>`)}</ul>`;
}
export function bindApprovals(root, after) {
  root.querySelectorAll('[data-vapprove]').forEach(b => b.addEventListener('click', async () => {
    try { await api(`/vacations/${b.dataset.vapprove}/approve`, { method: 'POST' }); toast('Férias aprovadas.'); after(); } catch (e) { toast(e.message, 'err'); }
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
    <tbody>${d.periods.map(p => html`<tr><td class="nowrap">${fmtDate(p.start)} – ${fmtDate(p.end)}</td><td class="nowrap">${p.acquired ? fmtDate(p.concession_end) : '—'}</td>
      <td class="num">${p.used}</td><td class="num">${p.pending}</td><td class="num"><b>${p.acquired ? p.balance : '—'}</b></td><td>${vacPill(p.status === 'concluido' ? 'concluido' : p.status)}</td></tr>`)}</tbody></table></div>` : ''}
    ${d.requests.length ? html`<ul class="rows" style="margin-top:10px">${d.requests.map(v => html`<li><div class="row-link"><div class="grow"><div class="row-title">${fmtDate(v.start_date)} a ${fmtDate(v.end_date)} · ${v.days} dias</div>
      <div class="row-meta"><span>pedido por ${v.requested_by_name}</span>${v.decided_by_name ? html`<span>${v.status === 'aprovada' ? 'aprovado' : v.status === 'recusada' ? 'recusado' : 'cancelado'} por ${v.decided_by_name}</span>` : ''}${v.decision_note ? html`<span>“${v.decision_note}”</span>` : ''}</div></div>
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
export function myVacationCard(v, user) {
  if (user.is_external) return '';
  const s = v.summary || {};
  const next = v.requests.filter(r => r.status === 'aprovada' && r.end_date >= todayISO()).sort((a, b) => a.start_date.localeCompare(b.start_date))[0];
  const pend = v.requests.filter(r => r.status === 'solicitada');
  return html`<div class="grid grid-dash section">
    <section class="card" id="my-vac"><div class="card-head"><h2>${icon('calendar')}Minhas férias</h2>${vacPill(s.status)}</div>
      <div class="card-body vac-mine">
        ${s.status === 'sem_admissao' ? html`<p class="muted" style="margin:0">Sua data de admissão ainda não foi informada. Peça à Gestão da Equipe para completar o seu cadastro.</p>` : html`
          <div class="vac-big"><b>${s.available}</b><span>dia(s) disponíveis${s.deadline ? html` · gozar até <b>${fmtDate(s.deadline)}</b>` : ''}</span></div>
          ${s.next_right ? html`<div class="muted" style="font-size:13px">Próximo período de 30 dias a partir de ${fmtDate(s.next_right)}</div>` : ''}
          ${next ? html`<div class="vac-next">${icon('check')}Próximas férias: <b>${fmtDate(next.start_date)} a ${fmtDate(next.end_date)}</b> (${next.days} dias)</div>` : ''}
          ${pend.map(r => html`<div class="vac-next is-pend">${icon('clock')}Aguardando aprovação: <b>${dm(r.start_date)} a ${dm(r.end_date)}</b> (${r.days} dias)</div>`)}
          <div class="rg-task-acts"><button type="button" class="btn btn-primary btn-sm" data-vac-req>${icon('plus')}Solicitar férias</button>
            <button type="button" class="btn btn-ghost btn-sm" data-vac-hist>Histórico</button></div>`}
      </div></section>
    ${v.approvals.length ? html`<section class="card" id="vac-appr"><div class="card-head"><h2>${icon('team')}Férias para aprovar</h2><span class="sub">${v.approvals.length}</span></div>
      ${approvalsList(v.approvals)}</section>` : ''}
  </div>`;
}
export function bindMyVacationCard(root, v, render) {
  root.querySelector('[data-vac-req]')?.addEventListener('click', async () => { if (await vacationSheet()) render(); });
  root.querySelector('[data-vac-hist]')?.addEventListener('click', () => {
    sheet({ title: 'Minhas férias', wide: true, body: periodsTable(v), submitLabel: 'Fechar' });
    bindCancel(document.querySelector('.sheet-backdrop:last-child'), () => { document.querySelector('.sheet-backdrop:last-child [data-close]')?.click(); render(); });
  });
  bindApprovals(root.querySelector('#vac-appr') || document.createElement('div'), render);
}
