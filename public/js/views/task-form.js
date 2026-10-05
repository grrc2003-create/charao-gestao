import { html, api, icon, PRIORITY, PROOF } from '../core.js';
import { toast, readImages, pickImages } from '../ui.js';
import { pageHead, projectOptions } from './shared.js';
import { recurrenceFieldset, bindRecurrence } from './recurrence-fields.js';

const PROOF_HELP = {
  nenhuma: 'Envio para conferência sem anexos obrigatórios',
  foto: 'Exige ao menos uma foto da execução',
  descricao: 'Exige texto descrevendo a execução',
  foto_descricao: 'Exige foto e descrição',
};

export async function view({ params, query, state, navigate }) {
  const editing = !!params.id;
  const t = editing ? await api(`/tasks/${params.id}`) : null;
  if (editing && !t.can.edit) throw new Error('Você não pode editar esta tarefa.');
  // Subtarefa: herda o projeto da tarefa principal
  const parent = !editing && query.get('pai') ? await api(`/tasks/${query.get('pai')}`) : editing && t.parent_id ? { id: t.parent_id, code: t.parent_code, title: t.parent_title } : null;
  if (parent && !editing && !parent.can.add_subtask) throw new Error('Você não pode criar subtarefas nesta tarefa.');
  const projects = state.meta.projects.filter(p => !['concluido', 'cancelado'].includes(p.status) || (t && p.id === t.project_id));
  const projectId = String(t?.project_id || parent?.project_id || query.get('projeto') || (projects.length === 1 ? projects[0].id : ''));
  const v = t || (parent
    ? { priority: parent.priority, proof_type: parent.proof_type, assignee_id: parent.assignee_id, due_date: parent.due_date, stage_id: parent.stage_id }
    : { priority: 'media', proof_type: 'foto', assignee_id: null });
  const pending = []; // imagens de referência escolhidas antes de salvar
  const opt = (val, label, cur) => html`<option value="${val}" ${String(cur ?? '') === String(val) ? 'selected' : ''}>${label}</option>`;

  return {
    title: editing ? `Editar ${t.code}` : parent ? `Nova subtarefa · ${parent.code}` : 'Nova tarefa',
    html: html`
      ${pageHead({
        back: { href: editing ? `#/tarefas/${t.id}` : parent ? `#/tarefas/${parent.id}` : projectId ? `#/projetos/${projectId}` : '#/tarefas', label: editing ? t.code : parent ? parent.code : 'Voltar' },
        eyebrow: editing ? t.code : parent ? `Código gerado ao salvar (${parent.code}-00)` : 'Código gerado ao salvar (PRJ-000-00000)',
        title: editing ? 'Editar solicitação' : parent ? 'Nova subtarefa' : 'Nova tarefa',
      })}
      ${parent ? html`<div class="notice" style="max-width:860px;margin-bottom:14px">${icon('tasks')}<span>Subtarefa de <b>${parent.code}</b> · ${parent.title}. Ela tem responsável, prazo, comprovação, fotos, conferência e histórico próprios.${!editing && parent.due_date ? ` Prazo da tarefa principal: ${parent.due_date.split('-').reverse().join('/')}.` : ''}</span></div>` : ''}
      <form class="card card-pad form" id="task-form" novalidate style="max-width:860px">
        <fieldset class="fieldset form"><legend>Solicitação</legend>
          <div class="field"><label class="req" for="project_id">Projeto</label>
            <select id="project_id" name="project_id" required ${editing || parent ? 'disabled' : ''}>${opt('', 'Selecione o projeto ou área interna', projectId)}${projectOptions(projects, projectId, opt)}</select>
            ${editing ? html`<span class="hint">O projeto não pode ser alterado após a criação (o código da tarefa depende dele).</span>` : ''}</div>
          <div class="field"><label for="stage_id">Classificação (Grupo/Local/Etapa)</label>
            <select id="stage_id" name="stage_id"><option value="">Geral</option></select>
            <span class="hint">Opcional. Sem classificação, a tarefa fica em <b>Geral</b>. As opções são cadastradas no projeto.</span></div>
          <div class="field"><label class="req" for="title">Título</label><input id="title" name="title" type="text" maxlength="160" required value="${v.title || ''}" placeholder="Ex.: Conferir armação das vigas do 4º pavimento"></div>
          <div class="field"><label class="req" for="description">Descrição detalhada</label>
            <textarea id="description" name="description" rows="5" maxlength="5000" required placeholder="O que deve ser feito, onde, critérios de aceite e referências de projeto.">${v.description || ''}</textarea></div>
          <div class="field"><label for="field_summary">Resumo para lista de campo</label>
            <input id="field_summary" name="field_summary" type="text" maxlength="180" value="${v.field_summary || ''}" placeholder="Frase curta e objetiva (até 180 caracteres)">
            <span class="hint">Aparece na lista de campo impressa. Se vazio, usamos o início da descrição.</span></div>
          <div class="field"><label for="notes">Observações</label><textarea id="notes" name="notes" rows="2" maxlength="2000" placeholder="Informação importante para quem vai executar">${v.notes || ''}</textarea></div>
        </fieldset>

        <fieldset class="fieldset form"><legend>Responsável e prazo</legend>
          <div class="form-row">
            <div class="field"><label for="assignee_id">Responsável</label>
              <select id="assignee_id" name="assignee_id"><option value="">Selecione o projeto primeiro</option></select>
              <span class="hint">Somente usuários com acesso ao projeto.</span></div>
            <div class="field"><label for="due_date" id="due-label">Prazo</label><input id="due_date" name="due_date" type="date" value="${v.due_date || ''}"></div>
          </div>
          <div class="form-row" id="start-row">
            <div class="field"><label for="start_date">Início previsto</label><input id="start_date" name="start_date" type="date" value="${v.start_date || ''}">
              <span class="hint">Opcional. Usado no cronograma (Gantt) dos relatórios.</span></div>
          </div>
          ${editing && t.due_date ? html`<div class="notice notice-proto" id="resched-fields" hidden>
            <div style="display:grid;gap:10px;width:100%">
              <span>${icon('reschedule')} <b>Reagendamento</b> — o prazo atual é ${t.due_date.split('-').reverse().join('/')}${t.reschedule_count ? ` (já reagendada ${t.reschedule_count}x)` : ''}. Informe a justificativa.</span>
              <div class="field"><label class="req" for="reschedule_reason_id">Justificativa</label>
                <select id="reschedule_reason_id" name="reschedule_reason_id"><option value="">Selecione a justificativa</option></select></div>
              <div class="field"><label for="reschedule_note">Observação do reagendamento</label>
                <textarea id="reschedule_note" name="reschedule_note" rows="2" maxlength="1000" placeholder="Obrigatória para “Outro motivo”"></textarea></div>
            </div></div>` : ''}
          <div class="field"><span class="label">Prioridade</span>
            <div class="segmented seg-4">${Object.entries(PRIORITY).map(([k, l]) => html`<label><input type="radio" name="priority" value="${k}" ${v.priority === k ? 'checked' : ''}><span class="prio prio-${k}">${l}</span></label>`)}</div></div>
        </fieldset>

        <fieldset class="fieldset form"><legend>Comprovação exigida</legend>
          <div class="segmented seg-4">${Object.entries(PROOF).map(([k, p]) => html`<label><input type="radio" name="proof_type" value="${k}" ${v.proof_type === k ? 'checked' : ''}>
            <span class="seg-ic" aria-hidden="true">${p.icon}</span>${k === 'nenhuma' ? 'Nenhuma' : p.label}<small>${PROOF_HELP[k]}</small></label>`)}</div>
        </fieldset>

        ${!editing && !parent ? recurrenceFieldset() : ''}

        ${!editing ? html`<fieldset class="fieldset form"><legend>Imagens de referência</legend>
          <div class="thumbs" id="ref-thumbs"><button type="button" class="add-thumb" id="add-ref">${icon('image')}Adicionar imagem</button></div>
          <span class="hint">Fotos do local, croquis ou trechos de projeto. Reduzidas automaticamente para envio.</span>
        </fieldset>` : ''}

        <div class="form-error" hidden></div>
        <div class="form-actions">
          <a class="btn btn-ghost" href="${editing ? `#/tarefas/${t.id}` : parent ? `#/tarefas/${parent.id}` : '#/tarefas'}">Cancelar</a>
          <button class="btn btn-primary" type="submit">${icon('check')}${editing ? 'Salvar alterações' : 'Criar tarefa'}</button>
        </div>
      </form>`,
    mount(root) {
      const f = root.querySelector('#task-form');
      const err = f.querySelector('.form-error');
      // Tarefa recorrente: o prazo passa a ser o da 1ª ocorrência; início previsto vem da duração
      const rec = root.querySelector('#rec-fs') ? bindRecurrence(root, f, {
        onToggle: on => {
          root.querySelector('#due-label').textContent = on ? 'Prazo da 1ª ocorrência' : 'Prazo';
          root.querySelector('#due-label').classList.toggle('req', on);
          root.querySelector('#start-row').hidden = on;
          f.querySelector('[type=submit]').lastChild.textContent = on ? 'Criar tarefa recorrente' : 'Criar tarefa';
        },
      }) : null;
      // Reagendamento: alterar um prazo já definido exige justificativa
      const reschedBox = root.querySelector('#resched-fields');
      if (reschedBox) {
        api('/settings/reasons').then(list => {
          f.reschedule_reason_id.insertAdjacentHTML('beforeend', html`${list.map(x => html`<option value="${x.id}">${x.name}</option>`)}`.toString());
        }).catch(e => toast(e.message, 'err'));
        const sync = () => { reschedBox.hidden = f.due_date.value === t.due_date; };
        f.due_date.addEventListener('input', sync);
        f.due_date.addEventListener('change', sync);
      }
      const assigneeSel = f.querySelector('#assignee_id');

      const loadAssignees = async pid => {
        if (!pid) { assigneeSel.innerHTML = '<option value="">Selecione o projeto primeiro</option>'; return; }
        try {
          const users = await api(`/projects/${pid}/assignees`);
          const cur = assigneeSel.value || v.assignee_id || (editing ? '' : state.user.id);
          assigneeSel.innerHTML = html`<option value="">Sem responsável (definir depois)</option>${users.map(u => opt(u.id, `${u.name}${u.job_title ? ` · ${u.job_title}` : ''}`, cur))}`.toString();
        } catch (e) { toast(e.message, 'err'); }
      };
      loadAssignees(projectId);
      // Classificações do projeto selecionado (cadastradas no projeto; "Geral" é a padrão)
      const stageSel = f.querySelector('#stage_id');
      const loadStages = (pid, cur) => {
        const proj = state.meta.projects.find(p => String(p.id) === String(pid));
        const stages = proj?.stages || [];
        const def = stages.find(s => s.is_default);
        const others = stages.filter(s => !s.is_default);
        stageSel.innerHTML = html`<option value="${def?.id || ''}">Geral</option>${others.map(s => opt(s.id, s.name, cur))}`.toString();
        stageSel.disabled = !pid;
        if (cur && others.some(s => String(s.id) === String(cur))) stageSel.value = String(cur);
      };
      loadStages(projectId, v.stage_id);
      f.project_id.addEventListener('change', () => { loadAssignees(f.project_id.value); loadStages(f.project_id.value, null); });

      const thumbsEl = root.querySelector('#ref-thumbs');
      const drawThumbs = () => {
        thumbsEl.querySelectorAll('.thumb').forEach(n => n.remove());
        pending.forEach((img, i) => {
          const fig = document.createElement('figure');
          fig.className = 'thumb';
          fig.innerHTML = `<img alt="Referência ${i + 1}"><button type="button" class="rm" aria-label="Remover">✕</button>`;
          fig.querySelector('img').src = img.data;
          fig.querySelector('.rm').onclick = () => { pending.splice(i, 1); drawThumbs(); };
          thumbsEl.insertBefore(fig, thumbsEl.lastElementChild);
        });
      };
      root.querySelector('#add-ref')?.addEventListener('click', async () => {
        const files = await pickImages();
        if (!files) return;
        try { pending.push(...(await readImages(files))); drawThumbs(); } catch (e) { toast(e.message, 'err'); }
      });

      f.addEventListener('submit', async e => {
        e.preventDefault();
        const data = Object.fromEntries(new FormData(f));
        err.hidden = true;
        const btn = f.querySelector('[type=submit]');
        btn.disabled = true;
        try {
          if (editing) {
            delete data.project_id;
            if (reschedBox && reschedBox.hidden) { delete data.reschedule_reason_id; delete data.reschedule_note; }
            if (reschedBox && !reschedBox.hidden && !data.reschedule_reason_id) throw new Error('Selecione a justificativa do reagendamento.');
            await api(`/tasks/${t.id}`, { method: 'PATCH', body: data });
            toast('Tarefa atualizada.');
            navigate(`/tarefas/${t.id}`);
          } else {
            data.images = pending.map(p => ({ data: p.data }));
            if (parent) { data.parent_id = parent.id; data.project_id = parent.project_id; }
            if (rec?.enabled()) {
              const r = await api('/recurrences', { method: 'POST', body: { ...data, ...rec.read() } });
              toast(r.generated ? `Recorrência criada: ${r.generated} ocorrência(s) já gerada(s).` : 'Recorrência criada. As ocorrências serão geradas conforme a antecedência.');
              navigate(`/recorrencias/${r.id}`);
              return;
            }
            const r = await api('/tasks', { method: 'POST', body: data });
            toast('Tarefa criada.');
            navigate(`/tarefas/${r.id}`);
          }
        } catch (ex) {
          err.textContent = ex.message;
          err.hidden = false;
          btn.disabled = false;
          err.scrollIntoView({ block: 'center', behavior: 'smooth' });
        }
      });
    },
  };
}
