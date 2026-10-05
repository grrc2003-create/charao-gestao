// Lista de campo: folha compacta com várias tarefas para imprimir, levar à obra e marcar à mão.
import { html, api, icon, STATUS, PRIORITY, fmtDate, fmtDateTime } from '../core.js';
import { STATUS_COLOR } from './shared.js';
import { printToolbar, bindPrintToolbar, setPageFooter } from './print-common.js';

export async function view({ query }) {
  const q = Object.fromEntries(query);
  const d = await api('/field-list', { query: q });
  const c = d.context;
  const showNotesLines = q.lines === '1';
  const grouped = q.group === '1';
  const stageKey = t => (c.show_project ? `${t.project_code} · ${t.stage_name || 'Geral'}` : (t.stage_name || 'Geral'));

  const item = (t, i) => html`<li class="fl-item">
    <span class="fl-box" aria-hidden="true"></span>
    <div class="fl-main">
      <div class="fl-top">
        <span class="fl-num">${i + 1}.</span>
        <span class="fl-code">${t.code}</span>
        <span class="fl-st" style="--c:${STATUS_COLOR[t.eff_status]}">${STATUS[t.eff_status].label}</span>
        ${t.priority === 'urgente' || t.priority === 'alta' ? html`<span class="fl-prio">${PRIORITY[t.priority]}</span>` : ''}
        <span class="fl-due ${t.eff_status === 'atrasada' ? 'late' : ''}">Prazo: <b>${fmtDate(t.due_date)}</b>${t.days_late ? ` (${t.days_late}d atraso)` : ''}${t.reschedule_count ? html` <span class="fl-resched">↻ ${t.reschedule_count}x${t.chronic ? ' crônica' : ''} · orig. ${fmtDate(t.original_due)}</span>` : ''}</span>
      </div>
      <div class="fl-title">${t.title}</div>
      ${t.parent_code ? html`<div class="fl-meta">↳ Subtarefa de <b>${t.parent_code}</b></div>` : ''}
      <div class="fl-desc">${t.short}</div>
      <div class="fl-meta">
        ${!grouped && t.stage_name && !t.stage_default ? html`<span>Classificação: <b>${t.stage_name}</b></span>` : ''}
        ${c.show_project ? html`<span>Projeto: <b>${t.project_code}</b> ${t.project_name}</span>` : ''}
        ${c.show_assignee ? html`<span>Resp.: <b>${t.assignee_name || '—'}</b></span>` : ''}
        ${t.proof_type !== 'nenhuma' ? html`<span>Comprovar: ${{ foto: 'foto', descricao: 'descrição', foto_descricao: 'foto + descrição' }[t.proof_type]}</span>` : ''}
      </div>
      ${t.notes ? html`<div class="fl-note">⚠ ${t.notes}</div>` : ''}
      ${showNotesLines ? html`<div class="fl-lines"><span></span><span></span></div>` : ''}
    </div>
  </li>`;

  // Agrupamento por classificação: ordem do projeto ("Geral" primeiro), numeração contínua
  const groupedList = () => {
    const order = (a, b) => a.project_code.localeCompare(b.project_code) || (b.stage_default || 0) - (a.stage_default || 0)
      || (a.stage_order || 0) - (b.stage_order || 0) || (a.stage_name || '').localeCompare(b.stage_name || '');
    const groups = new Map();
    for (const t of [...d.tasks].sort(order)) {
      const k = stageKey(t);
      if (!groups.has(k)) groups.set(k, []);
      groups.get(k).push(t);
    }
    let n = 0;
    return html`${[...groups].map(([label, items]) => html`<div class="fl-group">${label}<span>${items.length} tarefa(s)</span></div>
      <ol class="fl-list">${items.map(t => item(t, n++))}</ol>`)}`;
  };

  const back = c.kind === 'projeto' ? `#/projetos/${q.project}` : `#/usuarios/${q.user}`;
  const toggle = (key, label, on) => html`<label class="pt-opt"><input type="checkbox" data-opt="${key}" ${on ? 'checked' : ''}>${label}</label>`;

  return {
    title: `Lista de campo · ${c.title}`,
    html: html`${printToolbar({
      back, title: `Lista de campo — ${c.title}`,
      extra: html`${toggle('include_review', 'Em conferência', q.include_review !== '0')}${toggle('include_done', 'Concluídas', q.include_done === '1')}${toggle('lines', 'Linhas p/ anotação', showNotesLines)}${toggle('group', 'Agrupar por classificação', grouped)}`,
    })}
    <div class="doc-stage">
      <article class="doc a4 field-doc">
        <header class="fl-header">
          <img src="/assets/logo.webp" alt="Charão Engenharia & Construção" class="fl-logo">
          <div class="fl-head-txt">
            <div class="fl-kicker">LISTA DE CAMPO · ${c.kind === 'projeto' ? 'PROJETO' : 'RESPONSÁVEL'}</div>
            <h1>${c.title}</h1>${c.stage ? html`<div class="fl-sub"><b>Classificação: ${c.stage}</b></div>` : ''}
            <div class="fl-sub">${c.subtitle}</div>
          </div>
        </header>
        <div class="fl-info">
          <span>Emitida em <b>${fmtDateTime(d.issued_at)}</b> por ${d.issued_by}</span>
          <span><b>${d.tasks.length}</b> tarefas · <b style="color:${STATUS_COLOR.atrasada}">${d.summary.late}</b> atrasadas</span>
        </div>
        <div class="fl-fill">
          <span>Data da visita: <i></i></span><span>Conferido por: <i></i></span><span>Assinatura: <i></i></span>
        </div>
        ${d.tasks.length ? (grouped ? groupedList() : html`<ol class="fl-list">${d.tasks.map(item)}</ol>`) : html`<p class="muted" style="padding:20px 0">Nenhuma tarefa pendente neste contexto.</p>`}
        <div class="fl-legend">☐ Marque a caixa ao concluir no local. Registre fotos e descrição no aplicativo para enviar à conferência.</div>
      </article>
    </div>`,
    mount(root, ctx) {
      setPageFooter(`Charão · Lista de campo · ${c.title}`);
      bindPrintToolbar(root);
      root.querySelectorAll('[data-opt]').forEach(cb => cb.addEventListener('change', () => {
        const k = cb.dataset.opt;
        const next = { ...q };
        if (k === 'include_review') next.include_review = cb.checked ? '' : '0';
        else next[k] = cb.checked ? '1' : '';
        ctx.setQuery(next);
        ctx.render();
      }));
    },
  };
}
