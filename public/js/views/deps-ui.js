// Dependências (predecessora → sucessora, Término → Início + folga): bloco da tarefa, ligações dos itens do check-list
// e a janela para escolher a outra tarefa/item do projeto.
import { html, api, icon, fmtDate } from '../core.js';
import { toast, sheet, confirmSheet } from '../ui.js';

const TYPE = { tarefa: 'Tarefa', subtarefa: 'Subtarefa', checklist: 'Check-list', item: 'Item' };
const sit = d => (d.cancelled ? html`<span class="dep-st is-cancel">cancelada</span>` : d.done ? html`<span class="dep-st is-done">concluída</span>` : html`<span class="dep-st is-open">em aberto</span>`);

// Linha de uma ligação
const depRow = (d, canEdit) => html`<li class="dep-row">
  <span class="dep-type">${TYPE[d.type] || d.type}</span>
  <div class="dep-main">${d.link ? html`<a href="${d.link}"><b class="mono">${d.code}</b> ${d.title}</a>` : html`<b class="mono">${d.code}</b> ${d.title}`}
    <span class="dep-meta">prazo ${d.due_date ? fmtDate(d.due_date) : '—'}${d.lag_days ? ` · folga de ${d.lag_days} dia${d.lag_days > 1 ? 's' : ''}` : ''}</span></div>
  ${sit(d)}
  ${canEdit ? html`<button type="button" class="icon-btn" data-dep-rm="${d.id}" aria-label="Remover dependência" title="Remover dependência">✕</button>` : ''}
</li>`;

export const depLists = (dep, canEdit, selfKey) => html`
  <div class="dep-col"><div class="sub-label">Depende de (predecessoras)</div>
    ${dep.predecessors.length ? html`<ul class="dep-list">${dep.predecessors.map(d => depRow(d, canEdit))}</ul>` : html`<p class="muted dep-empty">Nenhuma.</p>`}
    ${canEdit ? html`<button type="button" class="btn btn-ghost btn-sm" data-dep-add="pred" data-dep-self="${selfKey}">${icon('plus')}Predecessora</button>` : ''}</div>
  <div class="dep-col"><div class="sub-label">Libera (sucessoras)</div>
    ${dep.successors.length ? html`<ul class="dep-list">${dep.successors.map(d => depRow(d, canEdit))}</ul>` : html`<p class="muted dep-empty">Nenhuma.</p>`}
    ${canEdit ? html`<button type="button" class="btn btn-ghost btn-sm" data-dep-add="succ" data-dep-self="${selfKey}">${icon('plus')}Sucessora</button>` : ''}</div>`;

// Aviso "Aguardando" (predecessoras ainda em aberto)
export const waitingNotice = dep => (dep?.waiting?.length ? html`<div class="notice dep-waiting">${icon('clock')}<span><b>Aguardando</b> ${dep.waiting.map((d, i) => html`${i ? ' · ' : ''}${d.link ? html`<a href="${d.link}">${d.code} ${d.title}</a>` : d.code}`)}
  — esta tarefa depende ${dep.waiting.length > 1 ? 'delas' : 'dela'} (Término → Início).</span></div>` : '');

// Bloco da tarefa (recolhido; abre sozinho quando há ligações)
export function depsBlock(t, canEdit) {
  const dep = t.dependencies || { predecessors: [], successors: [], waiting: [] };
  const n = dep.predecessors.length + dep.successors.length;
  if (!n && !canEdit) return '';
  return html`<details class="card block block-fold block-deps" ${n ? 'open' : ''}>
    <summary class="block-head"><span class="step" style="background:var(--steel)">${icon('history')}</span><h2>Dependências</h2>
      <span class="right muted" style="font-size:12px">${n ? `${dep.predecessors.length} predecessora(s) · ${dep.successors.length} sucessora(s)` : 'nenhuma · toque para ligar tarefas'}</span>
      <span class="fold-chev" aria-hidden="true">${icon('chevron')}</span></summary>
    <div class="block-body dep-body">${depLists(dep, canEdit, `t:${t.id}`)}
      <p class="hint" style="margin:0">Término → Início: a sucessora só começa depois que a predecessora termina (+ folga). Liga tarefas, subtarefas e itens de check-list do mesmo projeto.</p></div>
  </details>`;
}

// Janela para escolher a outra ponta
async function pick({ projectId, selfKey, direction, exclude }) {
  let nodes;
  try { nodes = await api(`/projects/${projectId}/nodes`); } catch (e) { toast(e.message, 'err'); return null; }
  const opts = nodes.filter(n => n.key !== selfKey && !exclude.has(n.key));
  if (!opts.length) { toast('Não há outras tarefas neste projeto para ligar.', 'warn'); return null; }
  const groups = [['tarefa', 'Tarefas'], ['checklist', 'Check-lists'], ['subtarefa', 'Subtarefas'], ['item', 'Itens de check-list']];
  const optHtml = list => html`${groups.map(([k, lbl]) => {
    const g = list.filter(n => n.type === k);
    return g.length ? html`<optgroup label="${lbl}">${g.map(n => html`<option value="${n.key}">${n.code} · ${n.title}${n.due_date ? ` (prazo ${fmtDate(n.due_date)})` : ''}</option>`)}</optgroup>` : '';
  })}`;
  const opened = sheet({
    title: direction === 'pred' ? 'Adicionar predecessora' : 'Adicionar sucessora',
    submitLabel: 'Ligar',
    body: html`<p class="muted" style="margin:0 0 8px">${direction === 'pred' ? 'Escolha a tarefa/item que precisa terminar antes desta começar.' : 'Escolha a tarefa/item que só começa depois que esta terminar.'}</p>
      <div class="field"><label for="dep-q">Buscar</label><input id="dep-q" type="search" placeholder="Código ou parte do título" autocomplete="off"></div>
      <div class="field"><label class="req" for="dep-o">${direction === 'pred' ? 'Predecessora' : 'Sucessora'}</label>
        <select id="dep-o" name="other" size="8" required class="dep-select">${optHtml(opts)}</select></div>
      <div class="field"><label for="dep-l">Folga (dias)</label><input id="dep-l" name="lag_days" type="number" min="0" max="365" value="0" inputmode="numeric">
        <span class="hint">Dias de espera entre o término da predecessora e o início da sucessora (ex.: cura do concreto).</span></div>`,
    onSubmit: d => {
      if (!d.other) throw new Error('Escolha a tarefa ou o item.');
      return api('/dependencies', { method: 'POST', body: direction === 'pred' ? { pred: d.other, succ: selfKey, lag_days: d.lag_days } : { pred: selfKey, succ: d.other, lag_days: d.lag_days } });
    },
  });
  // Busca dentro da janela (a janela já está na tela neste ponto)
  const q = document.querySelector('.sheet #dep-q');
  const sel = document.querySelector('.sheet #dep-o');
  q?.addEventListener('input', () => {
    const term = q.value.trim().toLowerCase();
    sel.querySelectorAll('option').forEach(o => (o.hidden = !!term && !o.textContent.toLowerCase().includes(term)));
    sel.querySelectorAll('optgroup').forEach(g => (g.hidden = ![...g.querySelectorAll('option')].some(o => !o.hidden)));
  });
  q?.focus();
  return opened;
}

// Liga botões de adicionar/remover dentro de root. exclude: chaves que não podem ser escolhidas (ex.: subtarefas, itens do próprio check-list)
export function bindDeps(root, { projectId, exclude = new Set(), onChange }) {
  root.querySelectorAll('[data-dep-add]').forEach(b => b.addEventListener('click', async e => {
    e.preventDefault();
    e.stopPropagation();
    const extra = (b.dataset.depExclude || '').split(',').filter(Boolean);
    const opened = pick({ projectId, selfKey: b.dataset.depSelf, direction: b.dataset.depAdd, exclude: new Set([...exclude, ...extra]) });
    const r = await opened;
    if (r && r.id) { toast('Dependência criada.'); onChange?.(); }
  }));
  root.querySelectorAll('[data-dep-rm]').forEach(b => b.addEventListener('click', async e => {
    e.preventDefault();
    e.stopPropagation();
    if (!(await confirmSheet('Remover dependência', 'A ligação entre as tarefas será desfeita (fica registrado no histórico).', 'Remover', true))) return;
    try { await api(`/dependencies/${b.dataset.depRm}`, { method: 'DELETE' }); toast('Dependência removida.'); onChange?.(); } catch (er) { toast(er.message, 'err'); }
  }));
}

// Prévia do reagendamento: quais sucessoras serão empurradas (mostrada antes de confirmar)
export async function renderImpactPreview(box, taskId, newDue) {
  if (!box) return;
  if (!newDue) { box.innerHTML = ''; return; }
  try {
    const r = await api(`/tasks/${taskId}/impact-preview`, { method: 'POST', body: { due_date: newDue } });
    box.innerHTML = (r.impacted.length ? html`<div class="notice dep-preview">${icon('alert')}<div><b>Esta mudança empurra ${r.impacted.length} tarefa(s)/item(ns)</b>
      (ajuste por dependência, sem penalizá-las; o impacto fica registrado nesta tarefa):
      <ul>${r.impacted.map(i => html`<li><b class="mono">${i.code}</b> ${i.title} · ${fmtDate(i.old_due)} → <b>${fmtDate(i.new_due)}</b> (+${i.days}d)</li>`)}</ul></div></div>`
      : html`<p class="hint" style="margin:0">Nenhuma sucessora precisa ser empurrada.</p>`).toString();
  } catch { box.innerHTML = ''; }
}

// Quadro de impacto (tarefa que causou atraso) e ajuste recebido (tarefa empurrada)
export function impactBox(t) {
  const im = t.impact;
  const sh = t.dep_shift;
  return html`${im ? html`<details class="notice dep-impact"><summary>${icon('alert')}<span><b>Impacto deste atraso:</b> empurrou ${im.tasks} tarefa(s)/item(ns) ·
      <b>${im.days} dia(s)-tarefa</b>${im.project_end_days ? html` · <b>fim do projeto +${im.project_end_days} dia(s)</b>` : ''} <em>ver detalhes</em></span></summary>
      <ul>${im.shifts.map(x => html`<li><a href="${x.link}"><b class="mono">${x.code}</b> ${x.title}</a> · ${fmtDate(x.old_due)} → ${fmtDate(x.new_due)} (+${x.days}d)</li>`)}</ul></details>` : ''}
    ${sh ? html`<div class="notice dep-shifted">${icon('info')}<span>Prazo <b>ajustado por dependência</b> ${sh.times > 1 ? `${sh.times} vezes ` : ''}(+${sh.days} dia(s) no total)${sh.last_cause ? html` · causa mais recente: <a href="#/tarefas/${sh.last_cause_id}">${sh.last_cause}</a>` : ''}.
      Não conta como reagendamento desta tarefa.</span></div>` : ''}`;
}

// Ranking "Atrasos com maior impacto"
export function impactRankingSection(list, { sub = '' } = {}) {
  if (!list?.length) return '';
  return html`<section class="card section dep-rank">
    <div class="card-head"><h2>${icon('alert')}Atrasos com maior impacto</h2><span class="sub">${sub || 'tarefas que, ao atrasar, empurraram outras'}</span></div>
    <div class="table-wrap"><table class="data">
      <thead><tr><th>Tarefa que causou</th><th>Responsável</th><th class="num">Tarefas impactadas</th><th class="num">Dias-tarefa</th><th class="num">Fim do projeto</th></tr></thead>
      <tbody>${list.map(r => html`<tr data-href="#/tarefas/${r.id}" tabindex="0"><td><b class="mono">${r.code}</b> ${r.title}</td><td>${r.assignee_name || '—'}</td>
        <td class="num">${r.tasks}</td><td class="num"><b>${r.days}</b></td><td class="num">${r.project_end_days ? `+${r.project_end_days} dia(s)` : '—'}</td></tr>`)}</tbody></table></div>
    <p class="hint" style="padding:0 16px 12px;margin:0">Dias-tarefa = soma dos dias que cada tarefa/item foi empurrado. As tarefas empurradas não são penalizadas: o atraso conta só para a causa.</p>
  </section>`;
}
