// Ausência combinada (Meu painel): falta com reposição (dia inteiro, reposta até o fim do mês seguinte) ou falta descontada.
// A pessoa pede e o gestor aprova; o gestor também lança pela equipe e confere se a reposição foi cumprida.
import { html, api, icon, fmtDate, todayISO } from '../core.js';
import { toast, sheet, confirmSheet } from '../ui.js';
import { conflictBlock, readConflicts, proposalsBox, newConflictsBox, readApprovalConflicts } from './vacation-ui.js';

const KIND = { reposicao: 'Falta com reposição', descontada: 'Falta descontada' };
const ST = { solicitada: ['Aguardando aprovação', '#B7791F'], aprovada: ['Aprovada', '#1F6B41'], recusada: ['Recusada', '#9E2B20'], cancelada: ['Cancelada', '#8A96A3'] };
const MK = { pendente: ['Reposição pendente', '#1F5F9E'], cumprida: ['Reposição cumprida', '#1F6B41'], nao_cumprida: ['Não cumprida · descontada', '#9E2B20'] };
const pill = ([l, c]) => html`<span class="rg-st" style="--c:${c}">${l}</span>`;
const lastDayNextMonth = d => { const [y, m] = d.split('-').map(Number); return new Date(Date.UTC(y, m + 1, 0)).toISOString().slice(0, 10); };
const what = a => html`<b>${fmtDate(a.off_date)}</b> · ${KIND[a.kind]}${a.kind === 'reposicao' && a.makeup_date ? html` · repõe em <b>${fmtDate(a.makeup_date)}</b>` : ''}`;

export async function absenceSheet({ people = null, mode = null } = {}) {
  const p = sheet({
    title: people ? 'Lançar ausência combinada' : 'Combinar uma ausência',
    body: html`
      ${people ? html`<div class="field"><label class="req" for="ab-user">Pessoa</label><select id="ab-user" name="user_id" required><option value="">Escolha…</option>${people.map(x => html`<option value="${x.id}">${x.name}${x.job_title ? ` · ${x.job_title}` : ''}</option>`)}</select></div>` : ''}
      <div class="segmented" role="radiogroup" aria-label="Tipo">
        <label><input type="radio" name="kind" value="reposicao" required>Falta com reposição<small>Repõe um dia inteiro até o fim do mês seguinte</small></label>
        <label><input type="radio" name="kind" value="descontada" required>Falta descontada<small>Sem reposição: desconta na Folha</small></label></div>
      <div class="form-row">
        <div class="field"><label class="req" for="ab-off">Dia da ausência</label><input type="date" id="ab-off" name="off_date" required min="${people ? '' : todayISO()}"></div>
        <div class="field" id="ab-mk-f" hidden><label class="req" for="ab-mk">Dia da reposição</label><input type="date" id="ab-mk" name="makeup_date"><span class="hint" id="ab-mk-h"></span></div>
      </div>
      <div class="vs-conf" id="ab-conf" hidden></div>
      <div class="field"><label for="ab-note">Combinado / motivo</label><textarea id="ab-note" name="note" rows="2" maxlength="1000" placeholder="Ex.: consulta médica; repõe no sábado das 8h às 17h"></textarea></div>
      ${mode === 'estagio' ? html`<p class="hint" style="margin:0">Estagiário: para usar dias do recesso (sem reposição e sem desconto), use <b>Solicitar recesso</b>.</p>` : ''}
      <p class="hint" style="margin:0">${people ? 'Lançada pelo gestor, já fica aprovada.' : 'O gestor aprova o combinado.'} Depois do dia da reposição, o gestor confirma se foi cumprida; se não, vira falta descontada na Folha.</p>`,
    submitLabel: people ? 'Lançar' : 'Enviar ao gestor',
    onSubmit: (d, form) => {
      if (!d.kind) throw new Error('Escolha o tipo: com reposição ou descontada.');
      const reschedules = readConflicts(form);
      for (const k of Object.keys(d)) if (k.startsWith('rsm_')) delete d[k];
      return api('/absences', { method: 'POST', body: { ...d, user_id: d.user_id ? Number(d.user_id) : null, reschedules } });
    },
  });
  const form = document.querySelector('.sheet-backdrop:last-child form');
  const upd = () => {
    const rep = form.querySelector('input[name=kind]:checked')?.value === 'reposicao';
    form.querySelector('#ab-mk-f').hidden = !rep;
    form.querySelector('#ab-mk').required = rep;
    const off = form.querySelector('#ab-off').value;
    if (off) { const lim = lastDayNextMonth(off); form.querySelector('#ab-mk').max = lim; form.querySelector('#ab-mk-h').textContent = `Até ${fmtDate(lim)} (fim do mês seguinte).`; }
  };
  let last = '';
  const conflicts = async () => {
    const off = form.querySelector('#ab-off').value, uid = form.querySelector('#ab-user')?.value || '';
    const key = `${uid}|${off}`;
    if (!off || (people && !uid) || key === last) return;
    last = key;
    const box = form.querySelector('#ab-conf');
    try {
      const r = await api('/absences/preview', { method: 'POST', body: { user_id: uid ? Number(uid) : null, off_date: off } });
      box.hidden = !r.conflicts.length;
      box.innerHTML = conflictBlock(r.conflicts, { what: `em ${fmtDate(off)}`, when: people ? 'for lançada' : 'o gestor aprovar' }).toString();
    } catch { box.hidden = true; }
  };
  form.addEventListener('change', e => { if (!e.target.closest('[data-rs-row]')) { upd(); conflicts(); } });
  const r = await p;
  if (r) toast(r.status === 'aprovada' ? 'Ausência lançada.' : 'Combinado enviado ao gestor.');
  return r;
}

export function myAbsenceCard(d) {
  if (!d) return '';
  const mine = d.mine.filter(a => a.status !== 'cancelada' && (a.off_date >= todayISO() || a.status === 'solicitada' || a.makeup_status === 'pendente')).slice(0, 6);
  return html`<section class="card" id="my-abs"><div class="card-head"><h2>${icon('calendar')}Ausências combinadas</h2></div>
    <div class="card-body ab-body">
      ${mine.length ? html`<ul class="ab-list">${mine.map(a => html`<li><span>${what(a)}${a.note ? html`<small>${a.note}</small>` : ''}${a.reschedules?.length ? html`<small>${a.reschedules.length} tarefa(s) no dia: ${a.reschedules.map(r => (r.new_due === r.old_due ? `${r.code} prazo mantido` : `${r.code} → ${fmtDate(r.new_due).slice(0, 5)}`)).join(', ')}</small>` : ''}</span>
        <span class="ab-st">${pill(ST[a.status])}${a.status === 'aprovada' && a.makeup_status ? pill(MK[a.makeup_status]) : ''}${a.status === 'solicitada' ? html`<button type="button" class="icon-btn" data-ab-cancel="${a.id}" title="Cancelar" aria-label="Cancelar">✕</button>` : ''}</span></li>`)}</ul>`
        : html`<p class="muted" style="margin:0">Precisa faltar um dia? Combine com o gestor: com reposição (até o fim do mês seguinte) ou descontada.</p>`}
      <div class="rg-task-acts"><button type="button" class="btn btn-primary btn-sm" data-ab-new>${icon('plus')}Combinar ausência</button>
        ${d.people.length ? html`<button type="button" class="btn btn-ghost btn-sm" data-ab-team>Lançar para a equipe</button>` : ''}</div>
    </div></section>
    ${d.approvals.length ? html`<section class="card" id="ab-appr"><div class="card-head"><h2>${icon('team')}Ausências para aprovar</h2><span class="sub">${d.approvals.length}</span></div>
      <ul class="rows">${d.approvals.map(a => html`<li class="vac-appr"><div class="grow"><div class="row-title">${a.user_name}</div><div class="row-meta"><span>${what(a)}</span>${a.note ? html`<span>“${a.note}”</span>` : ''}</div>${proposalsBox(a.reschedules, false)}${newConflictsBox(a.new_conflicts)}</div>
        <div class="vac-appr-acts"><button type="button" class="btn btn-success btn-sm" data-ab-act="approve" data-ab="${a.id}">${icon('check')}Aprovar</button><button type="button" class="btn btn-ghost btn-sm" data-ab-act="reject" data-ab="${a.id}">Recusar</button></div></li>`)}</ul></section>` : ''}
    ${d.checks.length ? html`<section class="card" id="ab-check"><div class="card-head"><h2>${icon('check')}Reposições a conferir</h2><span class="sub">${d.checks.length}</span></div>
      <ul class="rows">${d.checks.map(a => html`<li class="vac-appr"><div class="grow"><div class="row-title">${a.user_name}</div><div class="row-meta"><span>Faltou ${fmtDate(a.off_date)} · reposição combinada para <b>${fmtDate(a.makeup_date)}</b></span>${a.note ? html`<span>“${a.note}”</span>` : ''}</div></div>
        <div class="vac-appr-acts"><span class="muted" style="font-size:12.5px">Cumpriu?</span><button type="button" class="btn btn-success btn-sm" data-ab-act="makeup_done" data-ab="${a.id}">Sim</button><button type="button" class="btn btn-ghost btn-sm" data-ab-act="makeup_missed" data-ab="${a.id}">Não</button></div></li>`)}</ul></section>` : ''}`;
}

export function bindAbsenceCard(root, d, mode, render) {
  if (!d) return;
  root.querySelector('[data-ab-new]')?.addEventListener('click', async () => { if (await absenceSheet({ mode })) render(); });
  root.querySelector('[data-ab-team]')?.addEventListener('click', async () => { if (await absenceSheet({ people: d.people })) render(); });
  root.querySelectorAll('[data-ab-cancel]').forEach(b => b.addEventListener('click', async () => {
    if (!(await confirmSheet('Cancelar ausência', 'O pedido de ausência combinada será cancelado.', 'Cancelar pedido', true))) return;
    try { await api(`/absences/${b.dataset.abCancel}/cancel`, { method: 'POST', body: {} }); toast('Pedido cancelado.'); render(); } catch (e) { toast(e.message, 'err'); }
  }));
  root.querySelectorAll('[data-ab-act]').forEach(b => b.addEventListener('click', async () => {
    const act = b.dataset.abAct, id = b.dataset.ab;
    try {
      if (act === 'reject') {
        const r = await sheet({ title: 'Recusar ausência', body: html`<div class="field"><label class="req" for="ab-r">Motivo</label><textarea id="ab-r" name="note" rows="3" required></textarea></div>`,
          submitLabel: 'Recusar', danger: true, onSubmit: x => api(`/absences/${id}/reject`, { method: 'POST', body: x }) });
        if (!r) return;
      } else if (act === 'makeup_missed') {
        if (!(await confirmSheet('Reposição não cumprida', 'A falta passa a ser descontada na Folha (no mês da data combinada para a reposição).', 'Confirmar: não cumprida', true))) return;
        await api(`/absences/${id}/makeup_missed`, { method: 'POST', body: {} });
      } else await api(`/absences/${id}/${act}`, { method: 'POST', body: act === 'approve' ? { reschedules: readApprovalConflicts(b.closest('li')) } : {} });
      toast({ approve: 'Ausência aprovada.', reject: 'Ausência recusada.', makeup_done: 'Reposição cumprida.', makeup_missed: 'Marcada como não cumprida: será descontada na Folha.' }[act]);
      render();
    } catch (e) { toast(e.message, 'err'); }
  }));
}
