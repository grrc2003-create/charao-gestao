// Tarefas recorrentes: lista de séries, detalhe (regra, próximas datas, ocorrências) e edição.
import { html, api, icon, fmtDate, fmtDateTime, PRIORITY, PROOF } from '../core.js';
import { toast, sheet } from '../ui.js';
import { pageHead, taskList, bindCommon } from './shared.js';
import { endFields, bindEndFields } from './recurrence-fields.js';

const statusPill = r => (r.active
  ? html`<span class="pill" style="color:#1F6B41;background:var(--st-concluida-bg);border-color:#B7DCC6">Ativa</span>`
  : html`<span class="pill pill-sand">Encerrada</span>`);

const row = r => html`<li><a class="row-link" href="#/recorrencias/${r.id}">
  <div class="grow">
    <div class="row-title"><span class="rec-tag">${r.project_code}</span>${r.title} ${statusPill(r)}</div>
    <div class="row-meta"><span>${r.rule_text}</span></div>
    <div class="row-meta"><span>${icon('user')} ${r.assignee_name || 'Sem responsável'}</span>
      <span>${r.task_count} ocorrência(s) criada(s) · ${r.done_count} concluída(s)</span>
      ${r.active && r.next_dates.length ? html`<span>Próxima: <b>${fmtDate(r.next_dates[0])}</b></span>` : ''}</div>
  </div><span class="chev">${icon('chevron')}</span></a></li>`;

export const recurrenceRows = list => html`<ul class="rows">${list.map(row)}</ul>`;

export async function list({ query, state }) {
  const project = query.get('project') || '';
  const items = await api('/recurrences', { query: { project } });
  const proj = state.meta.projects.find(p => String(p.id) === project);
  return {
    title: 'Tarefas recorrentes',
    html: html`
      ${pageHead({
        back: { href: proj ? `#/projetos/${proj.id}` : '#/tarefas', label: proj ? proj.code : 'Tarefas' },
        eyebrow: proj ? `${proj.code} · ${proj.name}` : 'Repetição automática de tarefas',
        title: 'Tarefas recorrentes',
        sub: 'Cada ocorrência é criada automaticamente como uma tarefa normal, com a antecedência definida na série.',
        actions: html`<a class="btn btn-accent" href="#/tarefas/nova${proj ? `?projeto=${proj.id}` : ''}">${icon('plus')}Nova tarefa recorrente</a>`,
      })}
      ${items.length ? html`<section class="card">${recurrenceRows(items)}</section>`
        : html`<div class="card empty-state"><p>Nenhuma tarefa recorrente${proj ? ' neste projeto' : ''}.</p>
          <p class="muted">Para criar, use <b>Nova tarefa</b> e ative <b>Repetir esta tarefa</b>.</p></div>`}`,
  };
}

export async function view({ params, navigate }) {
  const r = await api(`/recurrences/${params.id}`);
  return {
    title: `Recorrência · ${r.title}`,
    html: html`
      ${pageHead({
        back: { href: `#/recorrencias?project=${r.project_id}`, label: 'Recorrências' },
        eyebrow: `${r.project_code} · Tarefa recorrente`,
        title: r.title,
        actions: r.can_manage && r.active ? html`<a class="btn btn-ghost" href="#/recorrencias/${r.id}/editar">${icon('edit')}Editar</a>
          <button type="button" class="btn btn-danger-ghost" id="end-rec">${icon('x')}Encerrar recorrência</button>` : '',
      })}
      ${!r.active ? html`<div class="cancel-banner">${icon('info')}<div><b>Recorrência encerrada</b>
        ${r.ended_by_name ? `por ${r.ended_by_name} ` : ''}em ${fmtDateTime(r.ended_at)} — ${r.end_reason}</div></div>` : ''}
      <div class="grid grid-2">
        <section class="card card-pad">
          <div class="sub-label">Regra</div>
          <div style="font-weight:650;font-size:15px">${r.rule_text}</div>
          <dl class="kv" style="margin-top:12px">
            <dt>Situação</dt><dd>${statusPill(r)}</dd>
            <dt>Antecedência</dt><dd>cria cada ocorrência ${r.lead_days} dia(s) antes do prazo</dd>
            <dt>Duração</dt><dd>${r.duration_days} dia(s) por ocorrência</dd>
            <dt>Criadas</dt><dd>${r.generated_count}${r.total_planned ? ` de ${r.total_planned}` : ''} ocorrência(s)</dd>
            <dt>Criada por</dt><dd>${r.creator_name} · ${fmtDateTime(r.created_at)}</dd>
          </dl>
          ${r.active && r.next_dates.length ? html`<div class="sub-label" style="margin-top:12px">Próximas ocorrências</div>
            <div class="rec-dates">${r.next_dates.map(d => html`<span>${fmtDate(d)}</span>`)}</div>` : ''}
        </section>
        <section class="card card-pad">
          <div class="sub-label">Molde da tarefa (vale para as próximas ocorrências)</div>
          <div class="text-content" style="font-size:14px">${r.description}</div>
          <dl class="kv" style="margin-top:10px">
            <dt>Responsável</dt><dd>${r.assignee_name || 'Sem responsável'}</dd>
            <dt>Classificação</dt><dd>${r.stage_name || 'Geral'}</dd>
            <dt>Prioridade</dt><dd>${PRIORITY[r.priority]}</dd>
            <dt>Comprovação</dt><dd>${PROOF[r.proof_type].label}</dd>
            ${r.notes ? html`<dt>Observações</dt><dd>${r.notes}</dd>` : ''}
          </dl>
          ${r.files.length ? html`<div class="thumbs" style="margin-top:10px">${r.files.map(f => html`<figure class="thumb"><img src="/api/recurrence-files/${f.id}" alt="Referência"></figure>`)}</div>` : ''}
        </section>
      </div>
      <section class="section">
        <div class="page-head" style="margin-bottom:10px"><div><h2>Ocorrências criadas</h2><p>${r.tasks.length} tarefa(s)</p></div></div>
        ${taskList(r.tasks, { showProject: false, empty: 'Nenhuma ocorrência criada ainda — elas surgem conforme a antecedência configurada.' })}
      </section>`,
    mount(root, ctx) {
      bindCommon(root);
      root.querySelector('#end-rec')?.addEventListener('click', async () => {
        const futureOpen = r.tasks.filter(t => t.status === 'aberta' && !t.cancelled_at).length;
        const res = await sheet({
          title: 'Encerrar recorrência',
          body: html`<p class="muted" style="margin:0">Nenhuma nova ocorrência será criada. As tarefas já criadas continuam normalmente.</p>
            <div class="field"><label class="req" for="er">Motivo do encerramento</label><textarea id="er" name="reason" rows="3" maxlength="1000" required></textarea></div>
            ${futureOpen ? html`<label class="switch"><input type="checkbox" name="cancel_future">Cancelar também as ocorrências futuras ainda não iniciadas</label>` : ''}`,
          submitLabel: 'Encerrar', danger: true,
          onSubmit: d => api(`/recurrences/${r.id}/end`, { method: 'POST', body: { reason: d.reason, cancel_future: !!d.cancel_future } }),
        });
        if (res) { toast(res.cancelled ? `Recorrência encerrada · ${res.cancelled} ocorrência(s) cancelada(s).` : 'Recorrência encerrada.', 'warn'); ctx.render(); }
      });
    },
  };
}

export async function edit({ params, state, navigate }) {
  const r = await api(`/recurrences/${params.id}`);
  if (!r.can_manage || !r.active) throw new Error('Esta recorrência não pode ser editada.');
  const [assignees] = await Promise.all([api(`/projects/${r.project_id}/assignees`)]);
  const proj = state.meta.projects.find(p => p.id === r.project_id);
  const opt = (v, l, cur) => html`<option value="${v}" ${String(cur ?? '') === String(v) ? 'selected' : ''}>${l}</option>`;
  return {
    title: `Editar recorrência · ${r.title}`,
    html: html`
      ${pageHead({ back: { href: `#/recorrencias/${r.id}`, label: 'Recorrência' }, eyebrow: `${r.project_code} · ${r.rule_text}`, title: 'Editar tarefa recorrente' })}
      <div class="notice" style="max-width:860px;margin-bottom:14px">${icon('info')}<span>As alterações valem para as <b>próximas ocorrências</b>. As tarefas já criadas não mudam.
        Frequência e 1ª ocorrência não podem ser alteradas — para isso, encerre esta recorrência e crie outra.</span></div>
      <form class="card card-pad form" id="rec-form" novalidate style="max-width:860px">
        <fieldset class="fieldset form"><legend>Molde da tarefa</legend>
          <div class="field"><label class="req" for="title">Título</label><input id="title" name="title" type="text" maxlength="160" required value="${r.title}"></div>
          <div class="field"><label class="req" for="description">Descrição detalhada</label><textarea id="description" name="description" rows="4" maxlength="5000" required>${r.description}</textarea></div>
          <div class="field"><label for="field_summary">Resumo para lista de campo</label><input id="field_summary" name="field_summary" type="text" maxlength="180" value="${r.field_summary || ''}"></div>
          <div class="field"><label for="notes">Observações</label><textarea id="notes" name="notes" rows="2" maxlength="2000">${r.notes || ''}</textarea></div>
          <div class="form-row">
            <div class="field"><label for="assignee_id">Responsável</label><select id="assignee_id" name="assignee_id"><option value="">Sem responsável</option>${assignees.map(u => opt(u.id, u.name, r.assignee_id))}</select></div>
            <div class="field"><label for="stage_id">Classificação</label><select id="stage_id" name="stage_id">${(proj?.stages || []).map(s => opt(s.id, s.is_default ? 'Geral' : s.name, r.stage_id))}</select></div>
          </div>
          <div class="form-row">
            <div class="field"><label for="priority">Prioridade</label><select id="priority" name="priority">${Object.entries(PRIORITY).map(([k, l]) => opt(k, l, r.priority))}</select></div>
            <div class="field"><label for="proof_type">Comprovação exigida</label><select id="proof_type" name="proof_type">${Object.entries(PROOF).map(([k, p]) => opt(k, p.label, r.proof_type))}</select></div>
          </div>
        </fieldset>
        <fieldset class="fieldset form"><legend>Término e antecedência</legend>${endFields(r)}</fieldset>
        <div class="form-error" hidden></div>
        <div class="form-actions"><a class="btn btn-ghost" href="#/recorrencias/${r.id}">Cancelar</a><button class="btn btn-primary" type="submit">${icon('check')}Salvar</button></div>
      </form>`,
    mount(root) {
      const f = root.querySelector('#rec-form');
      bindEndFields(f);
      f.addEventListener('submit', async e => {
        e.preventDefault();
        const err = f.querySelector('.form-error');
        err.hidden = true;
        const d = Object.fromEntries(new FormData(f));
        try {
          await api(`/recurrences/${r.id}`, { method: 'PUT', body: { ...d, end_count: Number(d.end_count), lead_days: Number(d.lead_days), duration_days: Number(d.duration_days) } });
          toast('Recorrência atualizada.');
          navigate(`/recorrencias/${r.id}`);
        } catch (ex) { err.textContent = ex.message; err.hidden = false; }
      });
    },
  };
}
