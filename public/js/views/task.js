// Tela interna da tarefa — prioriza o celular: informações principais, Solicitação, Execução e Histórico.
import { html, api, icon, STATUS, PROOF, PRIORITY, statusBadge, priorityTag, fmtDate, fmtDateTime, dueInfo, avatar } from '../core.js';
import { toast, sheet, confirmSheet, readImages, pickImages, lightbox } from '../ui.js';
import { pageHead } from './shared.js';

const relDue = t => t.eff_status === 'atrasada' ? `${t.days_late} dia(s) de atraso`
  : t.days_to_due === 0 ? 'Vence hoje' : t.days_to_due === 1 ? 'Vence amanhã' : `Faltam ${t.days_to_due} dias`;

export async function view(ctx) {
  const t = await api(`/tasks/${ctx.params.id}`);
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

  const thumbs = (files, removable) => html`${files.map(f => html`<figure class="thumb" data-src="/api/files/${f.id}" data-caption="${f.caption || ''}">
    <img src="/api/files/${f.id}" alt="${f.caption || 'Imagem da tarefa'}" loading="lazy">
    ${f.caption ? html`<figcaption>${f.caption}</figcaption>` : ''}
    ${removable ? html`<button type="button" class="rm" data-rm="${f.id}" aria-label="Remover imagem">✕</button>` : ''}</figure>`)}`;

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
        ${tile('photos', 'camera', 'Adicionar fotos', photos.length > 0, pc.need_photo)}
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
      <button type="button" class="btn btn-success btn-block ${pc.ok ? 'hide-mobile' : ''}" data-act="submit" ${pc.ok ? '' : 'disabled'}>${icon('send')}Enviar para conferência</button>
      ${!pc.ok ? html`<span class="muted" style="font-size:12.5px">Para enviar, registre: ${pc.missing.join(' e ')}.</span>` : ''}
    </div>` : '';

  const reviewActions = can.review ? html`<div class="grid grid-2 hide-mobile-grid" style="gap:8px">
      <button type="button" class="btn btn-success" data-act="approve">${icon('check')}Aprovar e concluir</button>
      <button type="button" class="btn btn-warn" data-act="return">${icon('back')}Devolver para ajustes</button></div>` : '';

  const back = ctx.query.get('from') === 'project' ? `#/projetos/${t.project_id}` : '#/tarefas';

  return {
    title: `${t.code} · ${t.title}`,
    html: html`
      ${pageHead({ back: { href: back, label: back === '#/tarefas' ? 'Tarefas' : t.project_code }, title: '' })}
      <article class="card task-hero st-${t.eff_status}">
        <div class="code"><span>${t.code}</span>${priorityTag(t.priority)}</div>
        <h1>${t.title}</h1>
        <div class="facts">
          <div class="fact"><div class="k">Status</div><div class="v">${statusBadge(t.eff_status)}</div></div>
          <div class="fact"><div class="k">${icon('user')}Responsável</div><div class="v">${t.assignee_id ? html`<a href="#/usuarios/${t.assignee_id}">${t.assignee_name}</a>` : 'Sem responsável'}</div></div>
          <div class="fact"><div class="k">${icon('calendar')}Prazo</div><div class="v ${due.cls}">${fmtDate(t.due_date)}<small>${t.due_date && !t.delivered ? relDue(t) : t.on_time === true ? 'Entregue no prazo' : t.on_time === false ? `Entregue com ${t.days_late}d de atraso` : ''}</small></div></div>
          <div class="fact"><div class="k">${icon('projects')}Projeto</div><div class="v"><a href="#/projetos/${t.project_id}">${t.project_code}</a><small>${t.project_name}</small></div></div>
          <div class="fact fact-wide"><div class="k">${icon('shield')}Comprovação exigida</div><div class="v">${proof.icon} ${proof.label}</div></div>
        </div>
        ${can.edit || can.reopen || can.conclude_directly ? html`<div style="display:flex;gap:8px;flex-wrap:wrap;margin-top:12px">
          ${can.edit ? html`<a class="btn btn-ghost btn-sm" href="#/tarefas/${t.id}/editar">${icon('edit')}Editar solicitação</a>` : ''}
          ${can.conclude_directly ? html`<button type="button" class="btn btn-ghost btn-sm" data-act="conclude">${icon('check')}Concluir diretamente</button>` : ''}
          ${can.reopen ? html`<button type="button" class="btn btn-ghost btn-sm" data-act="reopen">${icon('history')}Reabrir tarefa</button>` : ''}
        </div>` : ''}
      </article>

      <section class="card block block-req" aria-labelledby="blk-req">
        <header class="block-head"><span class="step">1</span><h2 id="blk-req">Solicitação</h2>
          <span class="right muted" style="font-size:12px">por ${t.creator_name}</span></header>
        <div class="block-body">
          <div><div class="sub-label">O que precisa ser feito</div><div class="text-content">${t.description}</div></div>
          ${t.field_summary ? html`<div><div class="sub-label">Resumo para campo</div><div>${t.field_summary}</div></div>` : ''}
          ${t.notes ? html`<div><div class="sub-label">Observações</div><div class="note-box">${t.notes}</div></div>` : ''}
          <div><div class="sub-label">${icon('image')} Imagens e referências (${refs.length})</div>
            ${refs.length || can.edit ? html`<div class="thumbs">${thumbs(refs, can.edit)}
              ${can.edit ? html`<button type="button" class="add-thumb" data-act="refs">${icon('image')}Anexar referência</button>` : ''}</div>`
              : html`<div class="muted" style="font-size:13.5px">Nenhuma imagem de referência.</div>`}
          </div>
          <dl class="kv" style="font-size:13px">
            <dt>Criada por</dt><dd>${t.creator_name} · ${fmtDateTime(t.created_at)}</dd>
            ${t.assigned_by_name && t.assigned_by_id !== t.assignee_id ? html`<dt>Atribuída por</dt><dd>${t.assigned_by_name}</dd>` : ''}
            <dt>Prioridade</dt><dd>${PRIORITY[t.priority]}</dd>
          </dl>
        </div>
      </section>

      <section class="card block block-exec" aria-labelledby="blk-exec">
        <header class="block-head"><span class="step">2</span><h2 id="blk-exec">Execução</h2>
          <span class="right">${t.status === 'concluida' ? statusBadge('concluida', { short: true }) : t.status === 'aguardando_conferencia' ? statusBadge('aguardando_conferencia', { short: true }) : ''}</span></header>
        <div class="block-body">
          ${reviewBox()}
          ${hasReturn ? html`
            ${t.exec_description ? html`<div><div class="sub-label">Descrição da execução</div><div class="text-content">${t.exec_description}</div></div>` : ''}
            ${photos.length || can.execute ? html`<div><div class="sub-label">${icon('camera')} Fotos da execução (${photos.length})</div>
              <div class="thumbs">${thumbs(photos, can.execute)}
              ${can.execute ? html`<button type="button" class="add-thumb" data-act="photos">${icon('camera')}Adicionar foto</button>` : ''}</div></div>` : ''}
            ${t.exec_notes ? html`<div><div class="sub-label">Observações do responsável</div><div class="note-box">${t.exec_notes}</div></div>` : ''}`
          : html`<div class="empty-exec">
              <div class="big">Ainda não há retorno do responsável</div>
              <div class="muted" style="font-size:13.5px">${can.execute ? 'Registre a execução abaixo e envie para conferência.' : `Aguardando ${t.assignee_name || 'definição do responsável'}.`}</div>
            </div>`}
          ${execActions}
          ${reviewActions}
        </div>
      </section>

      <section class="card block">
        <header class="block-head"><span class="step" style="background:var(--steel)">${icon('history')}</span><h2>Histórico</h2></header>
        <div class="block-body"><ul class="timeline">${t.history.map(h => html`<li>
          <div class="act">${h.action}</div>${h.details ? html`<div class="det">${h.details}</div>` : ''}
          <div class="who">${h.user_name || 'Sistema'} · ${fmtDateTime(h.created_at)}</div></li>`)}</ul></div>
      </section>

      ${can.submit && pc.ok ? html`<div class="sticky-actions only-mobile" style="display:flex"><button type="button" class="btn btn-success" data-act="submit">${icon('send')}Enviar para conferência</button></div>` : ''}
      ${can.review ? html`<div class="sticky-actions only-mobile" style="display:flex">
        <button type="button" class="btn btn-success" data-act="approve">${icon('check')}Aprovar</button>
        <button type="button" class="btn btn-warn" data-act="return">Devolver</button></div>` : ''}`,
    mount: root => mount(root, t, ctx),
  };
}

function mount(root, t, ctx) {
  const refresh = updated => {
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
    const files = await pickImages({ capture: false });
    if (!files) return;
    await run(async () => {
      toast('Enviando imagens…', 'warn');
      const imgs = await readImages(files);
      return api(`/tasks/${t.id}/files`, { method: 'POST', body: { kind, images: imgs.map(i => ({ data: i.data })) } });
    }, kind === 'execucao' ? 'Fotos da execução anexadas.' : 'Referências anexadas.');
  };

  const textSheet = (field, title, label, value, hint) => sheet({
    title,
    body: html`<div class="field"><label for="tx">${label}</label><textarea id="tx" name="text" rows="6" maxlength="5000">${value || ''}</textarea>
      ${hint ? html`<span class="hint">${hint}</span>` : ''}</div>`,
    onSubmit: data => api(`/tasks/${t.id}/execution`, { method: 'PATCH', body: { [field]: data.text } }),
  });

  const actions = {
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

  root.querySelectorAll('[data-act]').forEach(b => b.addEventListener('click', e => {
    e.preventDefault();
    actions[b.dataset.act]?.();
  }));
  root.querySelectorAll('.thumb').forEach(f => f.addEventListener('click', e => {
    if (e.target.closest('[data-rm]')) return;
    lightbox(f.dataset.src, f.dataset.caption);
  }));
  root.querySelectorAll('[data-rm]').forEach(b => b.addEventListener('click', async e => {
    e.stopPropagation();
    if (!(await confirmSheet('Remover imagem', 'A remoção ficará registrada no histórico.', 'Remover', true))) return;
    run(() => api(`/tasks/${t.id}/files/${b.dataset.rm}`, { method: 'DELETE' }), 'Imagem removida.');
  }));
}
