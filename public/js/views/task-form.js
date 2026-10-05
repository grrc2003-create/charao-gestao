import { html, api, icon, PRIORITY, PROOF } from '../core.js';
import { toast, readImages, pickImages } from '../ui.js';
import { pageHead } from './shared.js';

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
  const projects = state.meta.projects.filter(p => !['concluido', 'cancelado'].includes(p.status) || (t && p.id === t.project_id));
  const projectId = String(t?.project_id || query.get('projeto') || (projects.length === 1 ? projects[0].id : ''));
  const v = t || { priority: 'media', proof_type: 'foto', assignee_id: null };
  const pending = []; // imagens de referência escolhidas antes de salvar
  const opt = (val, label, cur) => html`<option value="${val}" ${String(cur ?? '') === String(val) ? 'selected' : ''}>${label}</option>`;

  return {
    title: editing ? `Editar ${t.code}` : 'Nova tarefa',
    html: html`
      ${pageHead({
        back: { href: editing ? `#/tarefas/${t.id}` : projectId ? `#/projetos/${projectId}` : '#/tarefas', label: editing ? t.code : 'Voltar' },
        eyebrow: editing ? t.code : 'Código gerado ao salvar (PRJ-000-00000)',
        title: editing ? 'Editar solicitação' : 'Nova tarefa',
      })}
      <form class="card card-pad form" id="task-form" novalidate style="max-width:860px">
        <fieldset class="fieldset form"><legend>Solicitação</legend>
          <div class="field"><label class="req" for="project_id">Projeto</label>
            <select id="project_id" name="project_id" required ${editing ? 'disabled' : ''}>${opt('', 'Selecione o projeto', projectId)}${projects.map(p => opt(p.id, `${p.code} · ${p.name}`, projectId))}</select>
            ${editing ? html`<span class="hint">O projeto não pode ser alterado após a criação (o código da tarefa depende dele).</span>` : ''}</div>
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
            <div class="field"><label for="due_date">Prazo</label><input id="due_date" name="due_date" type="date" value="${v.due_date || ''}"></div>
          </div>
          <div class="field"><span class="label">Prioridade</span>
            <div class="segmented seg-4">${Object.entries(PRIORITY).map(([k, l]) => html`<label><input type="radio" name="priority" value="${k}" ${v.priority === k ? 'checked' : ''}><span class="prio prio-${k}">${l}</span></label>`)}</div></div>
        </fieldset>

        <fieldset class="fieldset form"><legend>Comprovação exigida</legend>
          <div class="segmented seg-4">${Object.entries(PROOF).map(([k, p]) => html`<label><input type="radio" name="proof_type" value="${k}" ${v.proof_type === k ? 'checked' : ''}>
            <span class="seg-ic" aria-hidden="true">${p.icon}</span>${k === 'nenhuma' ? 'Nenhuma' : p.label}<small>${PROOF_HELP[k]}</small></label>`)}</div>
        </fieldset>

        ${!editing ? html`<fieldset class="fieldset form"><legend>Imagens de referência</legend>
          <div class="thumbs" id="ref-thumbs"><button type="button" class="add-thumb" id="add-ref">${icon('image')}Adicionar imagem</button></div>
          <span class="hint">Fotos do local, croquis ou trechos de projeto. Reduzidas automaticamente para envio.</span>
        </fieldset>` : ''}

        <div class="form-error" hidden></div>
        <div class="form-actions">
          <a class="btn btn-ghost" href="${editing ? `#/tarefas/${t.id}` : '#/tarefas'}">Cancelar</a>
          <button class="btn btn-primary" type="submit">${icon('check')}${editing ? 'Salvar alterações' : 'Criar tarefa'}</button>
        </div>
      </form>`,
    mount(root) {
      const f = root.querySelector('#task-form');
      const err = f.querySelector('.form-error');
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
      f.project_id.addEventListener('change', () => loadAssignees(f.project_id.value));

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
            await api(`/tasks/${t.id}`, { method: 'PATCH', body: data });
            toast('Tarefa atualizada.');
            navigate(`/tarefas/${t.id}`);
          } else {
            data.images = pending.map(p => ({ data: p.data }));
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
