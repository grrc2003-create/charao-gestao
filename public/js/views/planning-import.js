// Projeto › Importar planejamento: planilha modelo (com as classificações do projeto), envio e prévia por linha
// (tarefas, subtarefas recuadas, dependências, erros e avisos). Só importa quando não há erro.
// No cadastro de um projeto novo, a planilha escolhida no formulário chega aqui (setPendingPlanning) e a prévia abre direto.
import { html, api, icon, fmtDate } from '../core.js';
import { toast } from '../ui.js';
import { pageHead } from './shared.js';

// Planilha escolhida no cadastro do projeto: fica guardada até a prévia carregar (a tela pode ser desenhada mais de uma vez)
let pending = null;
export const setPendingPlanning = (f, projectId) => { pending = f ? { file: f, projectId: Number(projectId), at: Date.now() } : null; };
const readB64 = f => new Promise((res, rej) => { const fr = new FileReader(); fr.onload = () => res(String(fr.result).split(',')[1]); fr.onerror = () => rej(new Error(`Não foi possível ler ${f.name}.`)); fr.readAsDataURL(f); });

export async function downloadPlanningTemplate(projectId = null) {
  const r = await fetch(`/api/planning/template${projectId ? `?projeto=${projectId}` : ''}`, { credentials: 'same-origin', headers: { 'X-Requested-With': 'charao-app' } });
  if (!r.ok) throw new Error('Não foi possível gerar a planilha modelo.');
  const url = URL.createObjectURL(await r.blob());
  const a = Object.assign(document.createElement('a'), { href: url, download: 'planejamento-modelo.xlsx' });
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}

function previewHtml(p) {
  const t = p.totals;
  return html`<section class="card section">
      <div class="card-head"><h2>${icon('file')}Prévia</h2><span class="sub">${p.file}</span></div>
      <div class="card-body">
        <div class="ct-tiles fi-tiles pl-tiles">
          <div class="ct-tile"><span>Linhas</span><b>${t.rows}</b><small>${t.ok - t.subtasks} tarefa(s) · ${t.subtasks} subtarefa(s)</small></div>
          <div class="ct-tile"><span>Dependências</span><b>${t.deps}</b><small>datas ajustadas pela dependência</small></div>
          <div class="ct-tile"><span>Com erro</span><b class="${t.erro ? 'is-neg' : ''}">${t.erro}</b><small>${t.erro ? 'corrija na planilha e envie de novo' : 'nenhum'}</small></div>
          <div class="ct-tile"><span>Acesso ao projeto</span><b>${t.access}</b><small>responsável(is) que ganham acesso</small></div>
        </div>
        ${t.erro ? html`<div class="bi-warn">${icon('alert')}<div><b>O planejamento só é importado sem erros</b> — subtarefas e dependências ligam as linhas entre si. Corrija as linhas marcadas e envie a planilha de novo.</div></div>` : ''}
      </div>
      <ul class="fi-list pl-list">${p.rows.map(r => html`<li class="is-${r.status} ${r.parent ? 'is-sub' : ''}"><div class="pl-row">
        <span class="fi-line">ID ${r.ref || '—'}<br>linha ${r.line}</span>
        <span class="fi-main"><b>${r.parent ? '↳ ' : ''}${r.view.title || '(sem título)'}</b>
          <small>${[r.view.stage, r.view.assignee ? `resp. ${r.view.assignee}` : '', r.view.start_date || r.view.due_date ? `${fmtDate(r.view.start_date)} → ${fmtDate(r.view.due_date)}` : 'sem datas', r.view.priority, r.view.proof !== 'Nenhuma' ? `comprovação: ${r.view.proof}` : '',
            r.parent ? `subtarefa de ${r.parent}` : '', r.view.deps.length ? `depende de ${r.view.deps.join(', ')}${r.view.lag ? ` (+${r.view.lag} d)` : ''}` : ''].filter(Boolean).join(' · ')}</small>
          ${r.errors.length ? html`<em class="fi-errs">${r.errors.join(' · ')}</em>` : ''}
          ${r.notes.length ? html`<em class="fi-note">${r.notes.join(' · ')}</em>` : ''}</span>
        <span class="fi-val"><span class="m-badge ${r.status === 'ok' ? 'm-paid' : 'fi-err'}">${r.status === 'ok' ? 'Pronta' : 'Com erro'}</span></span>
      </div></li>`)}</ul>
    </section>
    <div class="bi-confirm"><button type="button" class="btn btn-accent" data-pl-apply ${t.erro || !t.ok ? 'disabled' : ''}>${icon('check')}${t.erro ? 'Corrija os erros para importar' : `Importar ${t.ok} tarefa(s)`}</button></div>`;
}

export async function importPage({ params, state, navigate }) {
  const p = await api(`/projects/${params.id}`);
  if (!p.can_create_task) throw new Error('Você não pode criar tarefas neste projeto.');
  const auto = pending && pending.projectId === p.id && Date.now() - pending.at < 120e3 ? pending.file : null;
  return {
    title: `Importar planejamento · ${p.code}`,
    html: html`${pageHead({ back: { href: `#/projetos/${p.id}`, label: p.code }, eyebrow: `${p.code} · ${p.name}`, title: 'Importar planejamento',
        sub: 'Suba o planejamento completo (tarefas, subtarefas, responsáveis, datas e dependências) por planilha. Você confere a prévia antes; nada é gravado sem confirmar.' })}
      <section class="card section">
        <div class="card-body bi-pick">
          <div class="fi-steps">
            <div class="fi-step"><span class="fi-n">1</span><div><b>Baixe a planilha modelo deste projeto</b><small>já vem com as classificações do projeto (${p.stages.map(s => s.name).join(', ')}), os responsáveis e as listas de prioridade e comprovação</small>
              <button type="button" class="btn btn-ghost btn-sm" data-pl-template>${icon('file')}Baixar planilha modelo</button></div></div>
            <div class="fi-step"><span class="fi-n">2</span><div><b>Preencha e envie</b><small>uma linha por tarefa na aba "Planejamento"; subtarefa = informe o ID da tarefa principal</small>
              <label class="bi-drop" for="pl-file">${icon('file')}<span><b>Escolher planilha preenchida</b><small>arquivo .xlsx</small></span></label>
              <input type="file" id="pl-file" accept=".xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" hidden>
              <ul class="bi-files" data-pl-name></ul></div></div>
          </div>
          <button type="button" class="btn btn-primary" data-pl-read disabled>Ler e mostrar prévia</button>
        </div>
      </section>
      <div data-pl-preview></div>`,
    mount(root) {
      const input = root.querySelector('#pl-file'), nameBox = root.querySelector('[data-pl-name]'), read = root.querySelector('[data-pl-read]'), out = root.querySelector('[data-pl-preview]');
      let file = null;
      const pick = f => {
        file = f && /\.xlsx$/i.test(f.name) ? f : null;
        nameBox.innerHTML = file ? html`<li>${icon('file')}${file.name} <small>${Math.max(1, Math.round(file.size / 1024))} KB</small></li>`.toString() : '';
        read.disabled = !file; out.innerHTML = '';
        if (f && !file) toast('Envie um arquivo .xlsx.', 'error');
      };
      root.querySelector('[data-pl-template]').addEventListener('click', async ev => {
        const b = ev.currentTarget; b.disabled = true;
        try { await downloadPlanningTemplate(p.id); toast('Planilha modelo baixada.'); } catch (ex) { toast(ex.message, 'error'); }
        b.disabled = false;
      });
      input.addEventListener('change', () => pick(input.files[0]));
      const load = async () => {
        read.disabled = true; read.textContent = 'Lendo…';
        try {
          const payload = { name: file.name, data: await readB64(file) };
          const pv = await api(`/projects/${p.id}/planning/preview`, { method: 'POST', body: { file: payload } });
          out.innerHTML = previewHtml(pv).toString();
          if (pending && pending.file === file) pending = null;
          out.scrollIntoView({ behavior: 'smooth', block: 'start' });
          out.querySelector('[data-pl-apply]')?.addEventListener('click', async ev => {
            const btn = ev.currentTarget;
            btn.disabled = true; btn.lastChild.textContent = 'Importando…';
            try {
              const r = await api(`/projects/${p.id}/planning`, { method: 'POST', body: { file: payload } });
              toast(`${r.tasks} tarefa(s), ${r.subtasks} subtarefa(s) e ${r.deps} dependência(s) importadas${r.granted.length ? ` · acesso liberado: ${r.granted.join(', ')}` : ''}.`);
              navigate(`/projetos/${p.id}`);
            } catch (ex) { toast(ex.message, 'error'); btn.disabled = false; btn.lastChild.textContent = 'Tentar de novo'; }
          });
        } catch (ex) { toast(ex.message, 'error'); }
        read.disabled = !file; read.textContent = 'Ler e mostrar prévia';
      };
      read.addEventListener('click', load);
      if (auto) { pick(auto); load(); }
    },
  };
}
