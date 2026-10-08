// Tela interna da tarefa — prioriza o celular: informações principais, Solicitação, Execução e Histórico.
import { html, api, icon, STATUS, PROOF, PRIORITY, statusBadge, priorityTag, fmtDate, fmtDateTime, dueInfo, avatar, progress } from '../core.js';
import { toast, sheet, confirmSheet, readAttachments, pickAttachments, batchBySize, lightbox, galleryFrom, fileInput } from '../ui.js';
import { pageHead } from './shared.js';
import { checklistSection, bindChecklist, PHOTO_RULE, checklistReportLink, projectSpecialties } from './checklist-ui.js';

const relDue = t => t.eff_status === 'atrasada' ? `${t.days_late} dia(s) de atraso`
  : t.days_to_due === 0 ? 'Vence hoje' : t.days_to_due === 1 ? 'Vence amanhã' : `Faltam ${t.days_to_due} dias`;

export async function view(ctx) {
  const t = await api(`/tasks/${ctx.params.id}`);
  // Check-list: equipe do projeto para atribuir itens (só para quem gerencia os itens)
  if (t.checklist?.can_manage_items) {
    t._team = await api(`/projects/${t.project_id}/assignees`).catch(() => []);
    t._groups = (ctx.state.meta.projects.find(p => p.id === t.project_id)?.stages || []).map(s => s.name);
  }
  // Especialidades do modelo escolhido na obra (ordem da lista e passo "Especialidade" do novo item)
  if (t.checklist) {
    const sp = projectSpecialties(ctx.state.meta, t.project_id);
    t._specs = sp.list;
    t._specsOwn = sp.own;
  }
  return build(t, ctx);
}

function build(t, ctx) {
  const due = dueInfo(t);
  const can = t.can;
  const pc = t.proof_check;
  const refs = t.files.filter(f => f.kind === 'referencia');
  const photos = t.files.filter(f => f.kind === 'execucao');
  const hasReturn = !!(t.exec_description || t.exec_notes || photos.length);
  const proof = PROOF[t.proof_type];
  const subPending = (t.sub_total || 0) - (t.sub_done || 0);
  const canSend = pc.ok && !subPending;

  const rmBtn = (f, removable) => (removable ? html`<button type="button" class="rm" data-rm="${f.id}" aria-label="Remover anexo">✕</button>` : '');
  const thumbs = (files, removable) => html`${files.map(f => (f.mime === 'application/pdf'
    ? html`<figure class="thumb thumb-pdf"><a href="/api/files/${f.id}" target="_blank" rel="noopener" title="Abrir ${f.original_name || 'PDF'}">
        ${icon('file')}<span class="pdf-tag">PDF</span><span class="pdf-name">${f.original_name || 'documento.pdf'}</span></a>${rmBtn(f, removable)}</figure>`
    : html`<figure class="thumb" data-src="/api/files/${f.id}" data-caption="${f.caption || ''}">
    <img src="/api/files/${f.id}" alt="${f.caption || 'Imagem da tarefa'}" loading="lazy">
    ${f.caption ? html`<figcaption>${f.caption}</figcaption>` : ''}
    ${rmBtn(f, removable)}</figure>`))}`;

  const reviewBox = () => {
    if (t.status === 'aguardando_conferencia') return html`<div class="review-box review-pendente"><b>${icon('clock')} Aguardando conferência</b>
      Enviada em ${fmtDateTime(t.delivered_at)}${t.on_time === false ? ` · entregue com ${t.days_late} dia(s) de atraso` : t.on_time ? ' · dentro do prazo' : ''}.</div>`;
    if (t.review_status === 'aprovada') return html`<div class="review-box review-aprovada"><b>${icon('check')} Conferência aprovada</b>
      Por ${t.reviewer_name || '—'} em ${fmtDateTime(t.reviewed_at)}${t.review_comment ? html`<div class="text-content" style="margin-top:4px">“${t.review_comment}”</div>` : ''}</div>`;
    if (t.review_status === 'devolvida') return html`<div class="review-box review-devolvida"><b>${icon('alert')} Devolvida para ajustes</b>
      Por ${t.reviewer_name || '—'} em ${fmtDateTime(t.reviewed_at)}<div class="text-content" style="margin-top:4px">“${t.review_comment}”</div></div>`;
    return '';
  };

  const tile = (action, ic, label, state, required) => html`<button type="button" class="action-tile ${state ? 'done' : ''} ${required ? 'required' : ''}" data-act="${action}">
    ${icon(ic)}${label}<small>${state ? '✓ Registrado' : required ? 'Obrigatório' : 'Opcional'}</small></button>`;

  const execActions = can.execute ? html`
    <div>
      <div class="sub-label">Registrar retorno</div>
      <div class="action-grid">
        ${tile('desc', 'edit', t.exec_description ? 'Editar descrição' : 'Adicionar descrição', !!t.exec_description, pc.need_desc)}
        <label class="action-tile ${pc.has_photo ? 'done' : ''} ${pc.need_photo ? 'required' : ''}">${fileInput({ camera: true, data: 'data-upload="execucao"' })}
          ${icon('camera')}Tirar foto<small>${pc.has_photo ? '✓ Registrado' : 'Abre a câmera'}</small></label>
        ${tile('photos', 'image', 'Galeria ou PDF', photos.length > 0, false)}
        ${tile('notes', 'note', t.exec_notes ? 'Editar observação' : 'Adicionar observação', !!t.exec_notes, false)}
        ${can.start ? html`<button type="button" class="action-tile" data-act="start">${icon('clock')}Iniciar execução<small>Marca como em andamento</small></button>` : ''}
      </div>
    </div>
    <div class="submit-bar">
      <div class="sub-label">Comprovação exigida: ${proof.label}</div>
      <ul class="proof-check">
        ${pc.need_photo ? html`<li class="${pc.has_photo ? 'ok' : 'no'}">${pc.has_photo ? '✓' : '○'} Foto da execução</li>` : ''}
        ${pc.need_desc ? html`<li class="${pc.has_desc ? 'ok' : 'no'}">${pc.has_desc ? '✓' : '○'} Descrição da execução</li>` : ''}
        ${!pc.need_photo && !pc.need_desc ? html`<li class="ok">✓ Nenhuma comprovação obrigatória</li>` : ''}
      </ul>
      <button type="button" class="btn btn-success btn-block ${canSend ? 'hide-mobile' : ''}" data-act="submit" ${canSend ? '' : 'disabled'}>${icon('send')}Enviar para conferência</button>
      ${!pc.ok ? html`<span class="muted" style="font-size:12.5px">Para enviar, registre: ${pc.missing.join(' e ')}.</span>` : ''}
      ${subPending ? html`<span class="muted" style="font-size:12.5px">Conclua antes ${subPending} subtarefa(s) pendente(s).</span>` : ''}
    </div>` : '';

  const reviewActions = can.review ? html`<div class="grid grid-2 hide-mobile-grid" style="gap:8px">
      <button type="button" class="btn btn-success" data-act="approve">${icon('check')}Aprovar e concluir</button>
      <button type="button" class="btn btn-warn" data-act="return">${icon('back')}Devolver para ajustes</button></div>` : '';

  const back = t.parent_id && t.parent_visible ? `#/tarefas/${t.parent_id}`
    : ctx.query.get('from') === 'project' ? `#/projetos/${t.project_id}` : '#/tarefas';
  const backLabel = back.startsWith('#/tarefas/') ? t.parent_code : back === '#/tarefas' ? 'Tarefas' : t.project_code;

  const activeSubs = t.subtasks.filter(s => !s.cancelled_at);
  const subDone = activeSubs.filter(s => s.status === 'concluida').length;
  const subtaskRow = s => {
    const d = dueInfo(s);
    return html`<li><a class="row-link subtask-row st-${s.eff_status}" href="#/tarefas/${s.id}">
      <div class="grow"><div class="row-title"><span class="mono muted" style="font-size:12px">${s.code}</span>${priorityTag(s.priority)}<span style="margin-left:auto">${statusBadge(s.eff_status, { short: true })}</span></div>
        <div style="font-weight:600">${s.title}</div>
        <div class="row-meta"><span>${icon('user')} ${s.assignee_name || 'Sem responsável'}</span><span class="${d.cls}">${icon('calendar')} ${d.text}</span>
          <span>${PROOF[s.proof_type].icon} ${PROOF[s.proof_type].short}</span></div></div>
      <span class="chev">${icon('chevron')}</span></a></li>`;
  };
  const subtasksBlock = !t.parent_id && (t.subtasks.length || can.add_subtask) ? html`
      <section class="card block" aria-labelledby="blk-sub">
        <header class="block-head"><span class="step" style="background:var(--navy-700)">${icon('tasks')}</span><h2 id="blk-sub">Subtarefas</h2>
          <span class="right muted" style="font-size:12px">${activeSubs.length ? `${subDone} de ${activeSubs.length} concluídas` : ''}${t.subtasks.length > activeSubs.length ? ` · ${t.subtasks.length - activeSubs.length} cancelada(s)` : ''}</span></header>
        ${t.subtasks.length ? html`<div style="padding:12px 16px 0">${progress(activeSubs.length ? Math.round((subDone / activeSubs.length) * 100) : 0, 'Subtarefas concluídas')}</div>
          <ul class="rows">${t.subtasks.map(subtaskRow)}</ul>` : html`<div class="block-body"><p class="muted" style="margin:0">Divida esta tarefa em etapas com responsável, prazo e comprovação próprios.</p></div>`}
        ${can.add_subtask ? html`<div class="block-body" style="padding-top:8px"><a class="btn btn-ghost" href="#/tarefas/nova?pai=${t.id}">${icon('plus')}Adicionar subtarefa</a></div>` : ''}
        ${activeSubs.length && subDone < activeSubs.length ? html`<div class="block-body" style="padding-top:0"><div class="notice">${icon('info')}<span>A tarefa principal só pode ser enviada para conferência ou concluída depois que todas as subtarefas estiverem concluídas.</span></div></div>` : ''}
      </section>` : '';

  // Solicitação: em check-list fica recolhida (abre ao tocar no título)
  const reqBody = html`<div class="block-body">
          ${t.description || !t.checklist ? html`<div><div class="sub-label">O que precisa ser feito</div><div class="text-content">${t.description}</div></div>` : ''}
          ${t.field_summary ? html`<div><div class="sub-label">Resumo para campo</div><div>${t.field_summary}</div></div>` : ''}
          ${t.notes ? html`<div><div class="sub-label">Observações</div><div class="note-box">${t.notes}</div></div>` : ''}
          ${t.checklist && !refs.length ? '' : html`<div><div class="sub-label">${icon('image')} Imagens e referências (${refs.length})</div>
            ${refs.length || can.edit ? html`<div class="thumbs">${thumbs(refs, can.edit)}
              ${can.edit ? html`<button type="button" class="add-thumb" data-act="refs">${icon('image')}Anexar referência</button>` : ''}</div>`
              : html`<div class="muted" style="font-size:13.5px">Nenhuma imagem de referência.</div>`}
          </div>`}
          <dl class="kv" style="font-size:13px">
            <dt>Criada por</dt><dd>${t.creator_name} · ${fmtDateTime(t.created_at)}</dd>
            ${t.assigned_by_name && t.assigned_by_id !== t.assignee_id ? html`<dt>Atribuída por</dt><dd>${t.assigned_by_name}</dd>` : ''}
            <dt>Prioridade</dt><dd>${PRIORITY[t.priority]}</dd>
            <dt>Classificação</dt><dd>${t.stage_name || 'Geral'}</dd>
            ${t.start_date ? html`<dt>Início previsto</dt><dd>${fmtDate(t.start_date)}</dd>` : ''}
          </dl>
        </div>`;
  return {
    title: `${t.code} · ${t.title}`,
    html: html`
      ${pageHead({ back: { href: back, label: backLabel }, title: '' })}
      ${t.cancelled_at ? html`<div class="cancel-banner" role="status">${icon('x')}<div><b>Tarefa cancelada</b>
        por ${t.cancelled_by_name || '—'} em ${fmtDateTime(t.cancelled_at)} — ${t.cancel_reason}
        <div class="muted" style="font-size:12.5px;margin-top:2px">Não aparece nas listas, indicadores, relatórios nem na lista de campo. ${can.reactivate_blocked || ''}</div></div></div>` : ''}
      <article class="card task-hero st-${t.eff_status}">
        <div class="code"><span>${t.code}</span>${t.parent_id ? html`<span class="pill pill-sand">Subtarefa</span>` : ''}${priorityTag(t.priority)}${t.stage_name ? html`<a class="stage-tag" href="#/tarefas?project=${t.project_id}&stage=${t.stage_id}" title="Classificação (Grupo/Local/Etapa)">${t.stage_name}</a>` : ''}
          ${t.recurrence_id ? html`<a class="rec-tag" href="#/recorrencias/${t.recurrence_id}" title="Tarefa recorrente: ${t.recurrence_title}">Recorrente · ${t.recurrence_seq}ª</a>` : ''}</div>
        ${t.parent_id ? html`<div class="parent-link">↳ Subtarefa de ${t.parent_visible ? html`<a href="#/tarefas/${t.parent_id}"><b>${t.parent_code}</b> · ${t.parent_title}</a>` : html`<b>${t.parent_code}</b>`}</div>` : ''}
        <h1>${t.title}</h1>
        <div class="facts">
          <div class="fact"><div class="k">Status</div><div class="v">${statusBadge(t.eff_status)}</div></div>
          <div class="fact"><div class="k">${icon('user')}Responsável</div><div class="v">${t.assignee_id ? html`<a href="#/usuarios/${t.assignee_id}">${t.assignee_name}</a>` : 'Sem responsável'}
            ${t.assignee_external ? html`<small>Terceirizado${t.assignee_company ? ` · ${t.assignee_company}` : ''} · líder: ${t.assignee_leader_name || '—'}</small>` : ''}</div></div>
          <div class="fact"><div class="k">${icon('calendar')}Prazo</div><div class="v ${due.cls}">${fmtDate(t.due_date)}<small>${t.cancelled_at ? 'Tarefa cancelada' : can.due_from_items && !t.delivered ? `${relDue(t)} · maior prazo dos itens` : t.due_date && !t.delivered ? relDue(t) : t.on_time === true ? 'Entregue no prazo' : t.on_time === false ? `Entregue com ${t.days_late}d de atraso` : ''}</small>
            <span style="display:flex;flex-wrap:wrap;gap:4px;margin-top:4px">
            ${t.reschedule_count ? html`<button type="button" class="resched-badge ${t.chronic ? 'is-chronic' : ''}" data-act="goresched" style="cursor:pointer" title="Prazo original: ${fmtDate(t.original_due)}">↻ ${t.reschedule_count}x reagendada${t.chronic ? ' · crônica' : ''}</button>` : ''}
            ${t.late_episodes ? html`<i class="late-badge" title="Repactuações após vencer + entrega após o prazo + atraso atual">atrasou ${t.late_episodes}x</i>` : ''}</span></div></div>
          <div class="fact"><div class="k">${icon('projects')}Projeto</div><div class="v"><a href="#/projetos/${t.project_id}">${t.project_code}</a><small>${t.project_name}</small></div></div>
          ${t.checklist ? html`<div class="fact fact-wide"><div class="k">${icon('checklist')}Check-list</div><div class="v">${t.checklist.summary.total} itens · ${t.checklist.summary.pct}% respondido<small>${PHOTO_RULE[t.checklist.photo_rule]}</small></div></div>`
            : html`<div class="fact fact-wide"><div class="k">${icon('shield')}Comprovação exigida</div><div class="v">${proof.icon} ${proof.label}</div></div>`}
        </div>
        ${t.checklist || can.edit || can.reassign || can.reopen || can.conclude_directly || can.cancel || can.reactivate || can.delete || can.delete_blocked || can.duplicate ? html`<details class="act-menu">
          <summary class="btn btn-ghost btn-sm">${icon('more')}Ações<span class="act-chev">${icon('chevron')}</span></summary>
          <div class="act-list" role="menu">
          ${t.checklist ? html`<a class="act-item" data-cl-report href="${checklistReportLink(t)}">${icon('print')}Relatório PDF</a>` : ''}
          ${can.edit ? html`<a class="act-item" href="#/tarefas/${t.id}/editar">${icon('edit')}Editar solicitação</a>` : ''}
          ${can.reassign ? html`<button type="button" class="act-item" data-act="reassign">${icon('user')}Alterar responsável</button>` : ''}
          ${can.reschedule ? html`<button type="button" class="act-item" data-act="reschedule">${icon('reschedule')}Reagendar prazo</button>` : ''}
          ${can.duplicate ? html`<button type="button" class="act-item" data-act="duplicate">${icon('file')}Duplicar${t.parent_id ? ' subtarefa' : t.subtasks?.length ? ' com subtarefas' : ' tarefa'}</button>` : ''}
          ${can.conclude_directly ? html`<button type="button" class="act-item" data-act="conclude">${icon('check')}Concluir diretamente</button>` : ''}
          ${can.reopen ? html`<button type="button" class="act-item" data-act="reopen">${icon('history')}Reabrir tarefa</button>` : ''}
          ${can.reactivate ? html`<button type="button" class="act-item is-primary" data-act="reactivate">${icon('history')}Reativar tarefa</button>` : ''}
          ${can.cancel ? html`<button type="button" class="act-item is-danger" data-act="cancel">${icon('x')}Cancelar tarefa</button>` : ''}
          ${can.delete ? html`<button type="button" class="act-item is-danger" data-act="delete">${icon('trash')}Excluir definitivamente</button>` : ''}
          ${!can.delete && can.delete_blocked ? html`<span class="act-note">${icon('info')} Exclusão definitiva indisponível: ${can.delete_blocked.replace(/^Não pode ser excluída: /, '')}</span>` : ''}
          </div>
        </details>` : ''}
      </article>

      ${t.checklist
        ? html`<details class="card block block-req block-fold">
        <summary class="block-head"><span class="step">1</span><h2 id="blk-req">Solicitação</h2>
          <span class="right muted" style="font-size:12px">por ${t.creator_name} · <span class="fold-hint">ver detalhes</span></span><span class="fold-chev" aria-hidden="true">${icon('chevron')}</span></summary>
        ${reqBody}</details>`
        : html`<section class="card block block-req" aria-labelledby="blk-req">
        <header class="block-head"><span class="step">1</span><h2 id="blk-req">Solicitação</h2>
          <span class="right muted" style="font-size:12px">por ${t.creator_name}</span></header>
        ${reqBody}</section>`}

      ${t.checklist ? checklistSection(t, { reviewBox: reviewBox(), reviewActions, can }) : html`<section class="card block block-exec" aria-labelledby="blk-exec">
        <header class="block-head"><span class="step">2</span><h2 id="blk-exec">Execução</h2>
          <span class="right">${t.status === 'concluida' ? statusBadge('concluida', { short: true }) : t.status === 'aguardando_conferencia' ? statusBadge('aguardando_conferencia', { short: true }) : ''}</span></header>
        <div class="block-body">
          ${reviewBox()}
          ${hasReturn ? html`
            ${t.exec_description ? html`<div><div class="sub-label">Descrição da execução</div><div class="text-content">${t.exec_description}</div></div>` : ''}
            ${photos.length || can.execute ? html`<div><div class="sub-label">${icon('camera')} Fotos e anexos da execução (${photos.length})</div>
              <div class="thumbs">${thumbs(photos, can.execute)}
              ${can.execute ? html`<label class="add-thumb">${fileInput({ camera: true, data: 'data-upload="execucao"' })}${icon('camera')}Tirar foto</label>
                <button type="button" class="add-thumb" data-act="photos">${icon('image')}Galeria ou PDF</button>` : ''}</div></div>` : ''}
            ${t.exec_notes ? html`<div><div class="sub-label">Observações do responsável</div><div class="note-box">${t.exec_notes}</div></div>` : ''}`
          : html`<div class="empty-exec">
              <div class="big">Ainda não há retorno do responsável</div>
              <div class="muted" style="font-size:13.5px">${can.execute ? (t.assignee_external && !t.assignee_login && t.assignee_id !== ctx.state.user.id ? `Você é o líder de ${t.assignee_name} (terceirizado sem login): registre a execução em nome dele; depois você mesmo confere a entrega.` : 'Registre a execução abaixo e envie para conferência.')
                : t.assignee_external && !t.assignee_login ? `Aguardando o registro do líder ${t.assignee_leader_name || ''} em nome de ${t.assignee_name} (terceirizado).` : `Aguardando ${t.assignee_name || 'definição do responsável'}.`}</div>
            </div>`}
          ${execActions}
          ${reviewActions}
        </div>
      </section>`}

      ${subtasksBlock}

      ${t.reschedules.length ? html`<section class="card block" id="resched" aria-labelledby="blk-resched">
        <header class="block-head"><span class="step" style="background:var(--orange-700)">${icon('reschedule')}</span><h2 id="blk-resched">Reagendamentos</h2>
          <span class="right muted" style="font-size:12px">${t.reschedules.length}x · prazo original ${fmtDate(t.original_due)}</span></header>
        <div class="block-body" style="padding-bottom:0"><div class="stat-inline">
          <span><b>${t.reschedules_preventive}</b> preventiva(s)</span><span><b>${t.reschedules_corrective}</b> corretiva(s)</span>
          <span><b>${t.days_added > 0 ? '+' : ''}${t.days_added}</b> dia(s) no prazo</span><span>ficou atrasada <b>${t.late_episodes}</b>x</span>
          ${t.chronic ? html`<span class="resched-badge is-chronic">crônica (${t.chronic_min}+ reagendamentos)</span>` : ''}</div></div>
        <div class="block-body"><ol class="resched-list">${t.reschedules.map((r, i) => html`<li>
          <div class="dates"><span class="resched-badge">${i + 1}º</span><s>${fmtDate(r.old_due)}</s> → <span>${r.new_due ? fmtDate(r.new_due) : 'sem prazo'}</span>
            <span class="kind-tag kind-${r.kind}" title="${r.kind === 'corretiva' ? 'Reagendada com o prazo já vencido' : 'Reagendada antes de vencer'}">${r.kind === 'corretiva' ? `Corretiva · ${r.late_days_at}d após vencer` : 'Preventiva'}</span></div>
          <div class="why"><b>Justificativa:</b> ${r.reason_name}${r.note ? html` — ${r.note}` : ''}</div>
          <div class="who">${r.user_name || '—'} · ${fmtDateTime(r.created_at)}</div></li>`)}</ol></div>
      </section>` : ''}

      <details class="card block block-fold block-hist">
        <summary class="block-head"><span class="step" style="background:var(--steel)">${icon('history')}</span><h2>Histórico</h2>
          <span class="right muted" style="font-size:12px">${t.history.length} registro(s) · <span class="fold-hint">ver histórico</span></span><span class="fold-chev" aria-hidden="true">${icon('chevron')}</span></summary>
        <div class="block-body"><ul class="timeline">${t.history.map(h => html`<li>
          <div class="act">${h.action}</div>${h.details ? html`<div class="det">${h.details}</div>` : ''}
          <div class="who">${h.user_name || 'Sistema'} · ${fmtDateTime(h.created_at)}</div></li>`)}</ul></div>
      </details>

      ${can.submit && canSend ? html`<div class="sticky-actions only-mobile" style="display:flex"><button type="button" class="btn btn-success" data-act="submit">${icon('send')}Enviar para conferência</button></div>` : ''}
      ${can.review ? html`<div class="sticky-actions only-mobile" style="display:flex">
        <button type="button" class="btn btn-success" data-act="approve">${icon('check')}Aprovar</button>
        <button type="button" class="btn btn-warn" data-act="return">Devolver</button></div>` : ''}`,
    mount: root => mount(root, t, ctx),
  };
}

function mount(root, t, ctx) {
  const refresh = updated => {
    if (t._team && !updated._team) { updated._team = t._team; updated._groups = t._groups; }
    if (t._specs && !updated._specs) { updated._specs = t._specs; updated._specsOwn = t._specsOwn; }
    const v = build(updated, ctx);
    root.innerHTML = v.html.toString();
    v.mount(root);
  };
  const run = async (fn, okMsg) => {
    try {
      const updated = await fn();
      if (okMsg) toast(okMsg);
      if (updated) refresh(updated);
    } catch (e) {
      toast(e.message, 'err');
    }
  };
  const upload = async kind => {
    const files = await pickAttachments();
    if (files) await uploadFiles(kind, files);
  };
  const uploadFiles = async (kind, files) => {
    await run(async () => {
      toast('Enviando arquivos…', 'warn');
      const items = await readAttachments(files);
      let updated;
      for (const batch of batchBySize(items)) {
        updated = await api(`/tasks/${t.id}/files`, { method: 'POST', body: { kind, images: batch.map(i => ({ data: i.data, name: i.name })) } });
      }
      return updated;
    }, kind === 'execucao' ? 'Comprovação da execução anexada.' : 'Referências anexadas.');
  };

  const textSheet = (field, title, label, value, hint) => sheet({
    title,
    body: html`<div class="field"><label for="tx">${label}</label><textarea id="tx" name="text" rows="6" maxlength="5000">${value || ''}</textarea>
      ${hint ? html`<span class="hint">${hint}</span>` : ''}</div>`,
    onSubmit: data => api(`/tasks/${t.id}/execution`, { method: 'PATCH', body: { [field]: data.text } }),
  });

  const actions = {
    // Duplicar a tarefa (com subtarefas / itens do check-list); responsáveis e prazos só se marcados
    duplicate: async () => {
      const nSubs = (t.subtasks || []).filter(s => !s.cancelled_at).length;
      const projects = (ctx.state.meta.projects || []).filter(p => !['concluido', 'cancelado'].includes(p.status));
      const r = await sheet({
        title: t.parent_id ? 'Duplicar subtarefa' : 'Duplicar tarefa',
        submitLabel: 'Duplicar',
        body: html`<p class="muted" style="margin:0 0 10px">Cria uma cópia ${t.parent_id ? `dentro de <b>${t.parent_code}</b>` : ''} com título, descrição, observações, prioridade, comprovação,
            classificação e referências${nSubs ? html`, <b>e as ${nSubs} subtarefa(s)</b>` : ''}${t.checklist ? html`, <b>e os ${t.checklist.items.length} itens do check-list</b> (sem respostas e sem fotos)` : ''}.
            A cópia nasce aberta, sem execução nem histórico.</p>
          <div class="field"><label class="req" for="dup-t">Título da cópia</label><input id="dup-t" name="title" type="text" maxlength="160" required value="${t.title} (cópia)"></div>
          ${!t.parent_id ? html`<div class="field"><label for="dup-p">Projeto</label><select id="dup-p" name="project_id">
            ${projects.map(p => html`<option value="${p.id}" ${p.id === t.project_id ? 'selected' : ''}>${p.code} · ${p.name}</option>`)}</select>
            <span class="hint">Em outro projeto, a classificação é mantida se lá existir uma com o mesmo nome.</span></div>` : ''}
          <label class="switch"><input type="checkbox" name="keep_assignees" value="1">Manter os responsáveis</label>
          <label class="switch"><input type="checkbox" name="keep_dates" value="1">Manter os prazos</label>
          <span class="hint">Sem marcar, a cópia fica sem responsável e sem prazo, para definir depois.</span>`,
        onSubmit: d => api(`/tasks/${t.id}/duplicate`, { method: 'POST', body: d }),
      });
      if (!r || !r.id) return;
      toast(`Cópia criada: ${r.code}${r.subtasks ? ` com ${r.subtasks} subtarefa(s)` : ''}.`);
      ctx.navigate(`/tarefas/${r.id}`);
    },
    reassign: async () => {
      let people;
      try { people = await api(`/projects/${t.project_id}/assignees`); } catch (e) { return toast(e.message, 'err'); }
      const others = people.filter(u => u.id !== t.assignee_id);
      if (!others.length) return toast('Não há outras pessoas com acesso a este projeto. Inclua-as na equipe do projeto.', 'warn');
      const r = await sheet({
        title: 'Alterar responsável',
        submitLabel: 'Alocar tarefa',
        body: html`<p class="muted" style="margin:0 0 10px">Responsável atual: <b>${t.assignee_name || 'sem responsável'}</b></p>
          <div class="field"><label class="req" for="na">Novo responsável</label>
            <select id="na" name="assignee_id" required><option value="">Selecione</option>${others.map(u => html`<option value="${u.id}">${u.name}${u.is_external ? ` · Terceirizado${u.company ? ` (${u.company})` : ''}` : u.job_title ? ` · ${u.job_title}` : ''}</option>`)}</select>
            <span class="hint">Somente pessoas da equipe do projeto ${t.project_code}.</span></div>
          <div class="field"><label for="nn">Motivo (opcional)</label><input id="nn" name="note" type="text" maxlength="500" placeholder="Ex.: assume a frente de serviço do bloco B"></div>`,
        onSubmit: d => {
          if (!d.assignee_id) throw new Error('Selecione o novo responsável.');
          return api(`/tasks/${t.id}/assignee`, { method: 'POST', body: d });
        },
      });
      if (!r || !r.id) return;
      toast(`Tarefa alocada para ${r.assignee_name}.`);
      if (r.hidden) ctx.navigate('/tarefas'); else refresh(r);
    },
    goresched: () => root.querySelector('#resched')?.scrollIntoView({ behavior: 'smooth', block: 'start' }),
    reschedule: async () => {
      let reasons;
      try { reasons = await api('/settings/reasons'); } catch (e) { return toast(e.message, 'err'); }
      const r = await sheet({
        title: 'Reagendar prazo',
        body: html`<div class="notice">${icon('info')}<span>Prazo atual: <b>${fmtDate(t.due_date)}</b>${t.reschedule_count ? ` · já reagendada ${t.reschedule_count}x (original ${fmtDate(t.original_due)})` : ''}.</span></div>
          <div class="field"><label class="req" for="nd">Novo prazo</label><input id="nd" name="due_date" type="date" required value="${t.due_date}"></div>
          <div class="field"><label class="req" for="rs">Justificativa</label>
            <select id="rs" name="reason_id" required><option value="">Selecione a justificativa</option>${reasons.map(x => html`<option value="${x.id}">${x.name}</option>`)}</select>
            <span class="hint">Lista cadastrada em Configurações, comum a todos os projetos.</span></div>
          <div class="field"><label for="rn">Observação</label><textarea id="rn" name="note" rows="3" maxlength="1000" placeholder="Detalhe o motivo (obrigatório para “Outro motivo”)"></textarea></div>`,
        submitLabel: 'Reagendar',
        onSubmit: d => api(`/tasks/${t.id}/reschedule`, { method: 'POST', body: d }),
      });
      if (r) { toast('Prazo reagendado.'); refresh(r); }
    },
    desc: async () => {
      const r = await textSheet('exec_description', 'Descrição da execução', 'O que foi executado', t.exec_description, 'Descreva o serviço realizado, materiais e conferências feitas.');
      if (r) { toast('Descrição registrada.'); refresh(r); }
    },
    notes: async () => {
      const r = await textSheet('exec_notes', 'Observação da execução', 'Observação', t.exec_notes, 'Pendências, interferências ou informações para o conferente.');
      if (r) { toast('Observação registrada.'); refresh(r); }
    },
    photos: () => upload('execucao'),
    refs: () => upload('referencia'),
    start: () => run(() => api(`/tasks/${t.id}/actions/start`, { method: 'POST' }), 'Execução iniciada.'),
    submit: async () => {
      if (!(await confirmSheet('Enviar para conferência', 'A tarefa ficará bloqueada para edição até a conferência. Deseja enviar?', 'Enviar'))) return;
      run(() => api(`/tasks/${t.id}/actions/submit`, { method: 'POST' }), 'Enviada para conferência.');
    },
    approve: async () => {
      const r = await sheet({
        title: 'Aprovar e concluir',
        body: html`<div class="field"><label for="c">Comentário (opcional)</label><textarea id="c" name="comment" rows="3" maxlength="1000"></textarea></div>`,
        submitLabel: 'Aprovar',
        onSubmit: d => api(`/tasks/${t.id}/actions/approve`, { method: 'POST', body: d }),
      });
      if (r) { toast('Tarefa concluída.'); refresh(r); }
    },
    return: async () => {
      const r = await sheet({
        title: 'Devolver para ajustes',
        body: html`<div class="field"><label class="req" for="c">Motivo da devolução</label><textarea id="c" name="comment" rows="4" maxlength="1000" required></textarea>
          <span class="hint">O responsável verá este motivo no bloco de execução.</span></div>`,
        submitLabel: 'Devolver', danger: true,
        onSubmit: d => api(`/tasks/${t.id}/actions/return`, { method: 'POST', body: d }),
      });
      if (r) { toast('Tarefa devolvida ao responsável.', 'warn'); refresh(r); }
    },
    conclude: async () => {
      const r = await sheet({
        title: 'Concluir diretamente',
        body: html`<p class="muted">Use quando a conferência já foi feita pessoalmente. A ação fica registrada no histórico.</p>
          <div class="field"><label for="c">Comentário</label><textarea id="c" name="comment" rows="3" maxlength="1000"></textarea></div>`,
        submitLabel: 'Concluir',
        onSubmit: d => api(`/tasks/${t.id}/actions/conclude`, { method: 'POST', body: d }),
      });
      if (r) { toast('Tarefa concluída.'); refresh(r); }
    },
    cancel: async () => {
      const subs = t.subtasks.filter(s => !s.cancelled_at && s.status !== 'concluida').length;
      const r = await sheet({
        title: 'Cancelar tarefa',
        body: html`<p class="muted" style="margin:0">A tarefa sai das listas, indicadores, relatórios e da lista de campo, mas continua consultável pelo filtro <b>Canceladas</b> e pode ser reativada.</p>
          ${subs ? html`<div class="notice notice-proto">${icon('alert')}<span>${subs} subtarefa(s) não concluída(s) também serão canceladas.</span></div>` : ''}
          <div class="field"><label class="req" for="cr">Motivo do cancelamento</label><textarea id="cr" name="reason" rows="3" maxlength="1000" required placeholder="Ex.: serviço retirado do escopo pelo cliente"></textarea></div>`,
        submitLabel: 'Cancelar tarefa', danger: true,
        onSubmit: d => api(`/tasks/${t.id}/cancel`, { method: 'POST', body: d }),
      });
      if (r) { toast('Tarefa cancelada.', 'warn'); refresh(r); }
    },
    reactivate: async () => {
      const r = await sheet({
        title: 'Reativar tarefa',
        body: html`<p class="muted" style="margin:0">A tarefa volta ao status anterior ao cancelamento e às listas e indicadores.</p>
          <div class="field"><label for="rn2">Observação (opcional)</label><textarea id="rn2" name="note" rows="2" maxlength="1000"></textarea></div>`,
        submitLabel: 'Reativar',
        onSubmit: d => api(`/tasks/${t.id}/reactivate`, { method: 'POST', body: d }),
      });
      if (r) { toast('Tarefa reativada.'); refresh(r); }
    },
    delete: async () => {
      const r = await sheet({
        title: 'Excluir definitivamente',
        body: html`<div class="notice notice-proto">${icon('alert')}<span><b>Esta ação não pode ser desfeita.</b> A tarefa ${t.code}, o histórico dela e as imagens de referência serão apagados.
          A exclusão fica registrada na Auditoria. Para tarefas que só deixaram de ser necessárias, prefira <b>Cancelar</b>.</span></div>
          <div class="field"><label class="req" for="dr">Motivo da exclusão</label><textarea id="dr" name="reason" rows="3" maxlength="1000" required placeholder="Ex.: cadastrada em duplicidade"></textarea></div>
          <label class="switch"><input type="checkbox" name="confirm" required>Entendo que a exclusão é definitiva</label>`,
        submitLabel: 'Excluir definitivamente', danger: true,
        onSubmit: d => {
          if (!d.confirm) throw new Error('Marque a confirmação para excluir.');
          return api(`/tasks/${t.id}`, { method: 'DELETE', body: { reason: d.reason } });
        },
      });
      if (r) {
        toast(`Tarefa ${t.code} excluída.`, 'warn');
        ctx.navigate(r.parent_id ? `/tarefas/${r.parent_id}` : `/projetos/${r.project_id}`);
      }
    },
    reopen: async () => {
      const r = await sheet({
        title: 'Reabrir tarefa',
        body: html`<div class="field"><label class="req" for="c">Motivo da reabertura</label><textarea id="c" name="comment" rows="3" maxlength="1000" required></textarea></div>`,
        submitLabel: 'Reabrir', danger: true,
        onSubmit: d => api(`/tasks/${t.id}/actions/reopen`, { method: 'POST', body: d }),
      });
      if (r) { toast('Tarefa reaberta.', 'warn'); refresh(r); }
    },
  };

  if (t.checklist) bindChecklist(root, t, ctx, refresh);
  // Menu de ações da tarefa: fecha ao escolher, ao clicar fora ou com Esc
  const actMenu = root.querySelector('.act-menu');
  if (actMenu) {
    actMenu.querySelectorAll('.act-item').forEach(i => i.addEventListener('click', () => { actMenu.open = false; }));
    const outside = e => { if (!actMenu.contains(e.target)) actMenu.open = false; };
    document.addEventListener('click', outside);
    actMenu.addEventListener('keydown', e => { if (e.key === 'Escape') { actMenu.open = false; actMenu.querySelector('summary').focus(); } });
  }
  root.querySelectorAll('[data-act]').forEach(b => b.addEventListener('click', e => {
    e.preventDefault();
    actions[b.dataset.act]?.();
  }));
  // Botões nativos de câmera: a foto chega pelo evento change do próprio input
  root.querySelectorAll('input[data-upload]').forEach(inp => inp.addEventListener('change', () => {
    const files = [...(inp.files || [])];
    inp.value = '';
    if (files.length) uploadFiles(inp.dataset.upload, files);
  }));
  root.querySelectorAll('.thumb[data-src]').forEach(f => f.addEventListener('click', e => {
    if (e.target.closest('[data-rm]')) return;
    lightbox(f.dataset.src, f.dataset.caption, galleryFrom(f.closest('.thumbs') || root, '.thumb[data-src]'));
  }));
  root.querySelectorAll('[data-rm]').forEach(b => b.addEventListener('click', async e => {
    e.stopPropagation();
    if (!(await confirmSheet('Remover anexo', 'A remoção ficará registrada no histórico.', 'Remover', true))) return;
    run(() => api(`/tasks/${t.id}/files/${b.dataset.rm}`, { method: 'DELETE' }), 'Anexo removido.');
  }));
}
