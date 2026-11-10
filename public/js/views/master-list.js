// Lista Mestra de projetos: os projetos de cada obra (arquitetura, estrutural, complementares…) — etapa atual, próximas
// datas previstas, desvio em relação à data base e o histórico das alterações com o motivo (padrão de mercado:
// linha de base congelada + previsão atual + código do motivo e explicação).
import { html, api, icon, fmtDate, fmtDateTime, todayISO } from '../core.js';
import { toast, sheet, confirmSheet } from '../ui.js';
import { pageHead, kpi, nOf } from './shared.js';
import { printToolbar, bindPrintToolbar, setPageFooter } from './print-common.js';

export const SIT = {
  atrasado: ['Atrasado', 'var(--st-atrasada)'],
  em_dia: ['Em dia', 'var(--st-em_andamento)'],
  sem_datas: ['Sem datas', 'var(--steel)'],
  concluido: ['Concluído', 'var(--st-concluida)'],
};
const STAGE_SIT = { concluida: 'Concluída', atrasada: 'Atrasada', prevista: 'Prevista', sem_data: 'Sem data' };
const KIND = { previsto: 'Data prevista', realizado: 'Data realizada', base: 'Nova linha de base', cadastro: 'Projeto incluído' };
const d0 = v => (v ? fmtDate(v) : '—');
const addDays = (iso, n) => { const d = new Date(`${iso}T12:00:00Z`); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
const diff = (a, b) => Math.round((Date.parse(a) - Date.parse(b)) / 86400e3);

export const sitBadge = s => html`<span class="ml-sit-b" style="--c:${SIT[s][1]}">${SIT[s][0]}</span>`;
// Desvio em dias em relação à data base: + atrasou, − antecipou
export const shiftBadge = n => (n === null || n === undefined ? html`<span class="ml-dev-0">—</span>`
  : n === 0 ? html`<span class="ml-dev-0" title="Igual à data base">0d</span>`
    : html`<span class="ml-dev-b ${n > 0 ? 'is-late' : 'is-early'}" title="${n > 0 ? `${n} dia(s) depois da data base` : `${-n} dia(s) antes da data base`}">${n > 0 ? '+' : '−'}${Math.abs(n)}d</span>`);

const stepTitle = s => `${s.name}: ${STAGE_SIT[s.status]}${s.done_date ? ` em ${fmtDate(s.done_date)}` : s.planned_date ? ` · previsto ${fmtDate(s.planned_date)}` : ''}${s.shift ? ` (${s.shift > 0 ? '+' : ''}${s.shift}d)` : ''}`;
export const steps = it => html`<span class="ml-steps" role="img" aria-label="${it.done_count} de ${it.stages.length} etapas concluídas${it.current ? `; etapa atual: ${it.current.name}` : ''}">
  ${it.stages.map(s => html`<i class="ml-step s-${s.status} ${it.current?.id === s.id ? 'is-cur' : ''}" title="${stepTitle(s)}"></i>`)}</span>`;

// Linha de um projeto (vira cartão no celular)
const itemRow = it => html`<div class="ml-row" data-item="${it.id}" style="--c:${SIT[it.status][1]}">
  <button type="button" class="ml-main" data-toggle aria-expanded="false" aria-controls="mld-${it.id}">
    <span class="ml-name"><b>${it.type_name}</b>${it.name ? html` · ${it.name}` : ''}<small>${it.designer || 'Projetista não informado'}${it.revision ? ` · ${it.revision}` : ''}</small></span>
    <span class="ml-track">${steps(it)}<small>${it.done_count}/${it.stages.length} etapas</small></span>
    <span class="ml-cur"><span class="ml-k">Etapa atual</span>${it.current ? it.current.name : 'Todas concluídas'}</span>
    <span class="ml-date ${it.current?.status === 'atrasada' ? 'is-late' : ''}"><span class="ml-k">Previsto</span>${it.current ? (it.current.planned_date ? html`${fmtDate(it.current.planned_date)}${it.current.status === 'atrasada' ? html`<small>vencida há ${nOf(diff(todayISO(), it.current.planned_date), 'dia', 'dias')}</small>` : ''}` : html`<i class="muted">sem data</i>`) : '—'}</span>
    <span class="ml-dev"><span class="ml-k">Desvio</span>${it.current ? shiftBadge(it.current.shift) : '—'}</span>
    <span class="ml-end"><span class="ml-k">Término</span>${it.finish?.date ? fmtDate(it.finish.date) : '—'} ${it.finish?.shift ? shiftBadge(it.finish.shift) : ''}</span>
    <span class="ml-st">${sitBadge(it.status)}${it.changes ? html`<span class="ml-chg" title="Datas previstas alteradas">${nOf(it.changes, 'alteração', 'alterações')}</span>` : ''}</span>
    <span class="ml-chev" aria-hidden="true">${icon('chevron')}</span>
  </button>
  <div class="ml-detail" id="mld-${it.id}" hidden></div>
</div>`;

const head = html`<div class="ml-head" aria-hidden="true"><span>Projeto</span><span>Etapas</span><span>Etapa atual</span><span>Previsto</span><span>Desvio</span><span>Término</span><span>Situação</span><span></span></div>`;

// Detalhe: etapas (base, previsto, realizado), último motivo, ações e histórico
function detail(it, d, hist) {
  return html`<div class="ml-stages table-wrap"><table class="data ml-st-t"><thead><tr><th>Etapa</th><th>Base</th><th>Previsto</th><th>Realizado</th><th>Desvio</th><th>Situação</th></tr></thead>
    <tbody>${it.stages.map(s => html`<tr class="${it.current?.id === s.id ? 'is-cur' : ''}"><td><i class="ml-step s-${s.status}" aria-hidden="true"></i>${s.name}${s.active ? '' : html` <small class="muted">(inativa)</small>`}</td>
      <td data-l="Base">${d0(s.base_date)}</td><td data-l="Previsto">${d0(s.planned_date)}</td><td data-l="Realizado">${d0(s.done_date)}</td><td data-l="Desvio">${shiftBadge(s.shift)}</td><td data-l="Situação">${STAGE_SIT[s.status]}</td></tr>`)}</tbody></table></div>
    ${it.notes ? html`<p class="ml-notes">${it.notes}</p>` : ''}
    <div class="ml-actions">
      ${it.can_edit ? html`<button type="button" class="btn btn-primary btn-sm" data-dates="${it.id}">${icon('calendar')}Atualizar datas</button>
        <button type="button" class="btn btn-ghost btn-sm" data-edit="${it.id}">${icon('edit')}Editar</button>
        <button type="button" class="btn btn-ghost btn-sm" data-del="${it.id}">${icon('trash')}Excluir</button>` : html`<span class="muted" style="font-size:12.5px">Somente o responsável da obra e os gestores alteram as datas.</span>`}
    </div>
    <div class="ml-hist"><h4>${icon('history')}Histórico de alterações</h4>
      ${hist === null ? html`<p class="muted">Carregando…</p>` : hist.length ? html`<ol class="ml-hl">${hist.map(c => html`<li class="${c.reason && !c.cascade ? 'has-reason' : ''}">
        <div class="ml-hl-top"><b>${c.kind === 'cadastro' ? KIND.cadastro : `${c.stage_name || 'Etapa'} — ${KIND[c.kind]}`}</b>${c.cascade ? html`<span class="ml-auto">deslocada junto</span>` : ''}
          <span class="muted">${fmtDateTime(c.created_at)} · ${c.user_name || '—'}</span></div>
        ${c.kind !== 'cadastro' ? html`<div class="ml-hl-dates">${d0(c.old_date)} → <b>${d0(c.new_date)}</b>${c.old_date && c.new_date ? html` ${shiftBadge(diff(c.new_date, c.old_date))}` : ''}</div>` : ''}
        ${c.reason && !c.cascade ? html`<div class="ml-hl-why"><span class="ml-reason">${c.reason}</span>${c.explanation || ''}</div>` : ''}</li>`)}</ol>` : html`<p class="muted">Nenhuma alteração.</p>`}
    </div>`;
}

const bars = (rows, total) => html`<ul class="ml-bars">${rows.map(r => html`<li><span class="ml-bl">${r.name || r.reason}</span>
  <span class="ml-bt"><i style="width:${Math.max(4, Math.round((r.n / (total || 1)) * 100))}%"></i></span><b>${r.n}</b></li>`)}</ul>`;

export async function view({ params, query, setQuery, render }) {
  const pid = Number(params.id);
  const f = { tipo: Number(query.get('tipo')) || 0, sit: query.get('sit') || '', q: (query.get('q') || '').trim() };
  const d = await api('/master-list', { query: { project: pid } });
  const P = d.project;
  if (!d.enabled) {
    const p = await api(`/projects/${pid}`);
    return {
      title: 'Lista Mestra',
      html: html`${pageHead({ back: { href: `#/projetos/${pid}`, label: p.code }, eyebrow: `${p.code} · ${p.name}`, title: 'Lista Mestra de projetos' })}
        <div class="empty-state"><h2>Este projeto não tem Lista Mestra</h2><p>Para usar, marque <b>Este projeto terá Lista Mestra</b> no cadastro do projeto.</p>
        ${p.can_edit ? html`<a class="btn btn-ghost" href="#/projetos/${pid}/editar">${icon('edit')}Editar o projeto</a>` : ''}</div>`,
    };
  }
  const S = d.summary;
  const norm = s => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
  const items = d.items.filter(i => (!f.tipo || i.type_id === f.tipo)
    && (!f.sit || (f.sit === 'alterado' ? i.changes > 0 : i.status === f.sit))
    && (!f.q || norm(`${i.type_name} ${i.name} ${i.designer} ${i.current?.name}`).includes(norm(f.q))));
  const href = sit => `#/projetos/${pid}/lista-mestra?${new URLSearchParams({ ...(f.tipo ? { tipo: f.tipo } : {}), ...(sit && sit !== f.sit ? { sit } : {}) })}`;
  const chip = (k, label, n, color) => html`<button type="button" class="chip" data-sit="${k}" aria-pressed="${f.sit === k}" style="--c:${color}"><span class="dot"></span>${label}<span class="n">${n}</span></button>`;
  const late = items.filter(i => i.status === 'atrasado').length;
  return {
    title: `Lista Mestra · ${P.code}`,
    html: html`
      ${pageHead({
        back: { href: `#/projetos/${pid}`, label: P.code },
        eyebrow: `${P.code} · ${P.name}`,
        title: 'Lista Mestra de projetos',
        sub: 'Em que etapa está cada projeto da obra, as próximas datas previstas e o porquê de cada alteração.',
        actions: html`${d.items.length ? html`<a class="btn btn-ghost" href="/api/master-list/export.xlsx?project=${pid}" download>${icon('file')}Excel</a>
            <a class="btn btn-ghost" href="#/imprimir/lista-mestra/${pid}">${icon('print')}PDF</a>` : ''}
          ${d.can_manage_types ? html`<a class="btn btn-ghost" href="#/projetos/${pid}/lista-mestra/tipos">${icon('settings')}Tipos e etapas da obra</a>` : ''}
          ${P.can_edit ? html`<button type="button" class="btn btn-accent" data-new="${pid}">${icon('plus')}Novo projeto</button>` : ''}`,
      })}
      ${d.items.length ? html`<div class="kpis kpis-dl ml-kpis">
          ${kpi({ label: 'Projetos na lista', value: S.total, foot: `${S.concluido} concluído(s)`, color: 'var(--navy)', href: href('') })}
          ${kpi({ label: 'Em dia', value: S.em_dia, foot: 'etapa atual dentro do previsto', color: SIT.em_dia[1], href: href('em_dia') })}
          ${kpi({ label: 'Atrasados', value: S.atrasado, foot: 'etapa com previsão vencida', color: SIT.atrasado[1], href: href('atrasado') })}
          ${kpi({ label: 'Com alteração de data', value: S.alterados, foot: S.reasons[0] ? `principal: ${S.reasons[0].reason}` : 'nenhuma alteração', color: '#A86F0E', href: href('alterado') })}
          ${kpi({ label: 'Entregas em 30 dias', value: S.next30, foot: 'etapas previstas', color: 'var(--navy-700)' })}
          ${kpi({ label: 'Sem datas', value: S.sem_datas, foot: 'etapa atual sem previsão', color: SIT.sem_datas[1], href: href('sem_datas') })}
        </div>
        ${S.reasons.length || S.by_stage.length > 1 ? html`<div class="grid grid-2 ml-sum">
          <section class="card"><div class="card-head"><h2>${icon('reschedule')}Motivos das alterações</h2><span class="sub">${S.reasons.reduce((n, r) => n + r.n, 0)} alteração(ões)</span></div>
            <div class="card-body">${S.reasons.length ? bars(S.reasons, Math.max(...S.reasons.map(r => r.n))) : html`<p class="muted">Nenhuma data prevista foi alterada.</p>`}</div></section>
          <section class="card"><div class="card-head"><h2>${icon('projects')}Etapa atual dos projetos</h2><span class="sub">${nOf(S.total, 'projeto', 'projetos')}</span></div>
            <div class="card-body">${bars(S.by_stage, Math.max(...S.by_stage.map(r => r.n)))}</div></section>
        </div>` : ''}
      <form class="toolbar ml-filters" id="ml-f" role="search">
        <div class="ml-frow ml-frow-2">
          <label class="search">${icon('search')}<span class="sr-only">Buscar</span><input type="search" name="q" value="${f.q}" placeholder="Buscar projeto, projetista ou etapa" autocomplete="off"></label>
          <select name="tipo" aria-label="Tipo de projeto"><option value="">Todos os tipos</option>${d.types.map(t => html`<option value="${t.id}" ${f.tipo === t.id ? 'selected' : ''}>${t.name}</option>`)}</select>
        </div>
        <div class="chips" role="group" aria-label="Filtrar por situação">
          ${chip('', 'Todos', S.total, 'var(--navy)')}${chip('atrasado', 'Atrasados', S.atrasado, SIT.atrasado[1])}${chip('em_dia', 'Em dia', S.em_dia, SIT.em_dia[1])}
          ${chip('sem_datas', 'Sem datas', S.sem_datas, SIT.sem_datas[1])}${chip('concluido', 'Concluídos', S.concluido, SIT.concluido[1])}${chip('alterado', 'Com alteração', S.alterados, '#A86F0E')}</div>
      </form>
      <div class="ml-legend" aria-hidden="true"><span><i class="ml-step s-concluida"></i>Concluída</span><span><i class="ml-step s-prevista is-cur"></i>Etapa atual</span><span><i class="ml-step s-atrasada"></i>Atrasada</span><span><i class="ml-step s-prevista"></i>Prevista</span><span><i class="ml-step s-sem_data"></i>Sem data</span></div>
      ${items.length ? html`<section class="card ml-group"><div class="card-head"><h2>${icon('checklist')}Projetos da obra</h2>
          <span class="sub">${nOf(items.length, 'projeto', 'projetos')}${late ? html` · <b class="ml-late-n">${late} atrasado(s)</b>` : ''}</span></div>
          <div class="ml-list">${head}${items.map(itemRow)}</div></section>`
        : html`<div class="empty-state"><h2>Nenhum projeto neste filtro</h2><p>Ajuste os filtros acima.</p></div>`}` : html`<div class="empty-state"><h2>Lista Mestra vazia</h2>
        <p>Inclua os projetos desta obra (arquitetura, estrutural, complementares…) com as datas previstas de cada etapa. As etapas vêm do tipo de projeto (formato desta obra, em <b>Tipos e etapas da obra</b>).</p>
        ${P.can_edit ? html`<button type="button" class="btn btn-accent" data-new="${pid}">${icon('plus')}Incluir o primeiro projeto</button>` : ''}</div>`}`,
    mount(root) {
      const form = root.querySelector('#ml-f');
      if (form) {
        const go = patch => { setQuery({ tipo: f.tipo || '', sit: f.sit, q: f.q, ...patch }); render(); };
        form.addEventListener('change', e => { if (e.target.name === 'tipo') go({ tipo: e.target.value }); });
        form.addEventListener('submit', e => { e.preventDefault(); go({ q: form.q.value.trim() }); });
        let t;
        form.q.addEventListener('input', () => { clearTimeout(t); t = setTimeout(() => go({ q: form.q.value.trim() }), 400); });
        form.addEventListener('click', e => { const c = e.target.closest('[data-sit]'); if (c) go({ sit: c.dataset.sit === f.sit ? '' : c.dataset.sit }); });
        if (f.q) { form.q.focus(); form.q.setSelectionRange(f.q.length, f.q.length); }
      }
      bindItems(root, d, () => render());
    },
  };
}

// Abre/fecha o detalhe e liga as ações (usado na Lista Mestra e no card do projeto)
export function bindItems(root, d, reload) {
  const byId = new Map(d.items.map(i => [i.id, i]));
  root.addEventListener('click', async e => {
    const tg = e.target.closest('[data-toggle]');
    if (tg) {
      const row = tg.closest('.ml-row');
      const it = byId.get(Number(row.dataset.item));
      const box = row.querySelector('.ml-detail');
      const open = tg.getAttribute('aria-expanded') !== 'true';
      tg.setAttribute('aria-expanded', String(open));
      row.classList.toggle('is-open', open);
      box.hidden = !open;
      if (open) {
        box.innerHTML = detail(it, d, null).toString();
        try { const h = await api(`/master-list/items/${it.id}/history`); box.innerHTML = detail(h.item, d, h.changes).toString(); } catch (ex) { toast(ex.message, 'error'); }
      }
      return;
    }
    const nw = e.target.closest('[data-new]');
    if (nw) return itemSheet(d, null, Number(nw.dataset.new) || null, reload);
    const ed = e.target.closest('[data-edit]');
    if (ed) return itemSheet(d, byId.get(Number(ed.dataset.edit)), null, reload);
    const dt = e.target.closest('[data-dates]');
    if (dt) return datesSheet(d, byId.get(Number(dt.dataset.dates)), reload);
    const dl = e.target.closest('[data-del]');
    if (dl) {
      const it = byId.get(Number(dl.dataset.del));
      if (await confirmSheet('Excluir projeto da Lista Mestra', `Excluir "${it.title}" da obra ${it.project_code}? As datas e o histórico de alterações deste projeto serão apagados.`, 'Excluir', true)) {
        try { await api(`/master-list/items/${it.id}`, { method: 'DELETE' }); toast('Projeto excluído da Lista Mestra.'); reload(); } catch (ex) { toast(ex.message, 'error'); }
      }
    }
  });
}

// Campos de datas previstas iniciais (no cadastro)
const initialDates = type => (type ? html`<div class="field"><span class="label">Datas previstas das etapas <small class="muted">(opcional — a primeira data prevista vira a data base)</small></span>
  <div class="ml-init">${type.stages.map(s => html`<label><span>${s.name}</span><input type="date" data-plan="${s.id}"></label>`)}</div></div>` : '');

async function itemSheet(d, it, projectId, done) {
  const editable = d.projects.filter(p => p.can_edit);
  const fixed = d.project || (projectId ? d.projects.find(p => p.id === projectId) : null);
  const locked = it && it.stages.some(s => s.base_date || s.planned_date || s.done_date);
  const types = d.types.filter(t => t.active || t.id === it?.type_id);
  const p = sheet({
    title: it ? `Editar ${it.title}` : 'Novo projeto na Lista Mestra', wide: true,
    body: html`${it || fixed ? html`<p class="muted" style="margin:0 0 8px">Obra: <b>${it ? `${it.project_code} · ${it.project_name}` : `${fixed.code} · ${fixed.name}`}</b></p>${fixed && !it ? html`<input type="hidden" name="project_id" value="${fixed.id}">` : ''}` : html`<div class="field"><label class="req" for="ml-p">Obra</label>
        <select id="ml-p" name="project_id" required><option value="">Escolha…</option>${editable.map(p => html`<option value="${p.id}" ${projectId === p.id ? 'selected' : ''}>${p.code} · ${p.name}</option>`)}</select></div>`}
      <div class="form-row"><div class="field"><label class="req" for="ml-t">Tipo de projeto</label>
          <select id="ml-t" name="type_id" required ${locked ? 'disabled' : ''}><option value="">Escolha…</option>${types.map(t => html`<option value="${t.id}" ${it?.type_id === t.id ? 'selected' : ''}>${t.name}</option>`)}</select>
          ${locked ? html`<span class="hint">Com datas registradas, o tipo não pode ser trocado.</span>` : html`<span class="hint">As etapas vêm do tipo (Tipos e etapas da obra).</span>`}</div>
        <div class="field"><label for="ml-n">Complemento</label><input type="text" id="ml-n" name="name" maxlength="120" value="${it?.name || ''}" placeholder="Ex.: Bloco A, Fachada"></div></div>
      <div class="form-row"><div class="field"><label for="ml-d">Projetista / escritório</label><input type="text" id="ml-d" name="designer" maxlength="160" value="${it?.designer || ''}"></div>
        <div class="field"><label for="ml-r">Revisão atual</label><input type="text" id="ml-r" name="revision" maxlength="20" value="${it?.revision || ''}" placeholder="Ex.: R00"></div></div>
      <div class="field"><label for="ml-o">Observações</label><textarea id="ml-o" name="notes" rows="2" maxlength="1000">${it?.notes || ''}</textarea></div>
      ${it ? '' : html`<div data-init></div>`}`,
    submitLabel: it ? 'Salvar' : 'Incluir projeto',
    onSubmit: (x, form) => {
      const body = { ...x };
      if (locked) delete body.type_id;
      if (!it) body.stages = [...form.querySelectorAll('[data-plan]')].filter(i => i.value).map(i => ({ stage_id: Number(i.dataset.plan), planned_date: i.value }));
      return api(it ? `/master-list/items/${it.id}` : '/master-list/items', { method: it ? 'PUT' : 'POST', body });
    },
  });
  // Cadastro: ao escolher o tipo, mostra as etapas para já informar as datas previstas
  const form = document.querySelector('.sheet-backdrop:last-child form');
  const box = form?.querySelector('[data-init]');
  if (box) form.querySelector('#ml-t').addEventListener('change', e => { box.innerHTML = initialDates(types.find(x => x.id === Number(e.target.value))).toString(); });
  const r = await p;
  if (r) { toast(it ? 'Projeto salvo.' : 'Projeto incluído na Lista Mestra.'); done(); }
}

// Atualizar datas: previsto e realizado de cada etapa; mudar previsão já existente exige motivo e explicação.
// "Deslocar as seguintes" leva o mesmo número de dias para as próximas etapas ainda não concluídas.
async function datesSheet(d, it, done) {
  const t = todayISO();
  const r = await sheet({
    title: `Atualizar datas · ${it.title}`, wide: true, submitLabel: 'Salvar datas',
    body: html`<p class="muted" style="margin:0 0 6px">${it.project_code} · ${it.project_name}. A data base é a primeira previsão de cada etapa e não muda (salvo nova linha de base).</p>
      <div class="table-wrap"><table class="data ml-dt"><thead><tr><th>Etapa</th><th>Base</th><th>Previsto</th><th>Realizado</th></tr></thead><tbody>
        ${it.stages.map(s => html`<tr data-st="${s.id}" data-old="${s.planned_date || ''}"><td>${s.name}</td><td class="ml-base" data-l="Base">${d0(s.base_date)}</td>
          <td data-l="Previsto"><input type="date" data-p value="${s.planned_date || ''}" data-prev="${s.planned_date || ''}" aria-label="Previsto: ${s.name}"></td>
          <td data-l="Realizado"><span class="ml-done"><input type="date" data-d value="${s.done_date || ''}" max="${t}" aria-label="Realizado: ${s.name}">
            <button type="button" class="btn btn-ghost btn-sm" data-today title="Concluída hoje">Hoje</button></span></td></tr>`)}
      </tbody></table></div>
      <label class="ml-check"><input type="checkbox" data-cascade checked> Ao mudar uma previsão, deslocar as etapas seguintes (ainda não concluídas) pelo mesmo número de dias</label>
      ${d.can_rebase ? html`<label class="ml-check"><input type="checkbox" name="rebaseline" data-rebase> Redefinir a linha de base com estas datas (replanejamento aprovado / aditivo)</label>` : ''}
      <div class="ml-why" data-why hidden>
        <p class="ml-why-t">${icon('alert')}Previsão alterada: informe o motivo</p>
        <div class="form-row"><div class="field"><label class="req" for="ml-why-r">Motivo</label><select id="ml-why-r" name="reason"><option value="">Escolha…</option>${d.reasons.map(x => html`<option>${x}</option>`)}</select></div></div>
        <div class="field"><label class="req" for="ml-why-e">Explique o porquê</label><textarea id="ml-why-e" name="explanation" rows="2" maxlength="1000" placeholder="Ex.: cliente pediu revisão do layout do 2º pavimento em 05/11"></textarea></div>
      </div>`,
    onSubmit: (x, form) => {
      const stages = [...form.querySelectorAll('tr[data-st]')].map(tr => ({ stage_id: Number(tr.dataset.st), planned_date: tr.querySelector('[data-p]').value || null,
        done_date: tr.querySelector('[data-d]').value || null, auto: tr.dataset.auto === '1' }));
      return api(`/master-list/items/${it.id}/stages`, { method: 'PUT', body: { stages, reason: x.reason, explanation: x.explanation, rebaseline: !!x.rebaseline } });
    },
  });
  if (r) { toast('Datas atualizadas.'); done(); }
}
// Comportamento do formulário de datas (deslocamento das seguintes e motivo obrigatório)
document.addEventListener('change', e => {
  const form = e.target.closest('form');
  if (!form?.querySelector('.ml-dt')) return;
  const rows = [...form.querySelectorAll('tr[data-st]')];
  if (e.target.matches('[data-p]')) {
    const inp = e.target;
    const tr = inp.closest('tr');
    tr.dataset.auto = '';
    const prev = inp.dataset.prev;
    if (prev && inp.value && form.querySelector('[data-cascade]').checked) {
      const delta = diff(inp.value, prev);
      if (delta) {
        for (const nx of rows.slice(rows.indexOf(tr) + 1)) {
          const p = nx.querySelector('[data-p]');
          if (!p.value || nx.querySelector('[data-d]').value) continue;
          p.value = addDays(p.value, delta);
          p.dataset.prev = p.value;
          nx.dataset.auto = '1';
          nx.classList.add('is-shifted');
        }
      }
    }
    inp.dataset.prev = inp.value;
  }
  const changed = rows.some(tr => tr.dataset.old && tr.querySelector('[data-p]').value !== tr.dataset.old);
  const rebase = form.querySelector('[data-rebase]')?.checked;
  const why = form.querySelector('[data-why]');
  why.hidden = !(changed || rebase);
  why.querySelectorAll('select, textarea').forEach(el => { el.required = !why.hidden; });
  rows.forEach(tr => tr.classList.toggle('is-changed', !!tr.dataset.old && tr.querySelector('[data-p]').value !== tr.dataset.old));
});
document.addEventListener('click', e => {
  const b = e.target.closest('.ml-dt [data-today]');
  if (!b) return;
  const inp = b.parentElement.querySelector('[data-d]');
  inp.value = todayISO();
  inp.dispatchEvent(new Event('change', { bubbles: true }));
});

// Card no projeto: resumo da Lista Mestra da obra
export function projectCard(d, projectId) {
  if (!d || !d.enabled) return '';
  const list = [...d.items].sort((a, b) => ['atrasado', 'em_dia', 'sem_datas', 'concluido'].indexOf(a.status) - ['atrasado', 'em_dia', 'sem_datas', 'concluido'].indexOf(b.status));
  const can = d.project?.can_edit;
  if (!d.items.length && !can) return '';
  return html`<section class="card ml-card" id="ml-card"><div class="card-head"><h2>${icon('checklist')}Lista Mestra de projetos</h2>
      <a class="btn btn-ghost btn-sm" href="#/projetos/${projectId}/lista-mestra">Abrir</a></div>
    ${d.items.length ? html`<div class="ml-list ml-compact">${head}${list.map(itemRow)}</div>`
      : html`<div class="card-body"><p class="muted" style="margin:0 0 10px">Controle aqui a etapa de cada projeto desta obra (arquitetura, estrutural, complementares…), as datas previstas e os motivos das alterações.</p>
        <button type="button" class="btn btn-ghost btn-sm" data-new="${projectId}">${icon('plus')}Incluir projeto</button></div>`}</section>`;
}

// ---------- PDF (A4 paisagem) ----------
export async function printView({ params }) {
  const obra = Number(params.id);
  const d = await api('/master-list', { query: { ...(obra ? { project: obra } : {}), history: 1 } });
  const proj = d.project;
  setPageFooter(`Lista Mestra de projetos${proj ? ` · ${proj.code}` : ''} · ${fmtDate(d.today)}`);
  const groups = [...new Set(d.items.map(i => i.project_id))].map(pid => d.items.filter(i => i.project_id === pid));
  const byId = new Map(d.items.map(i => [i.id, i]));
  const S = d.summary;
  // Histórico: só a alteração principal; as etapas deslocadas junto viram uma nota
  const main = (d.history || []).filter(c => !c.cascade);
  const moved = c => (d.history || []).filter(x => x.cascade && x.item_id === c.item_id && x.created_at === c.created_at).length;
  return {
    title: `Lista Mestra${proj ? ` · ${proj.code}` : ''}`,
    html: html`${printToolbar({ back: `#/projetos/${obra}/lista-mestra`, title: `Lista Mestra de projetos${proj ? ` · ${proj.code}` : ''}` })}
      <div class="doc-stage ml-stage"><article class="doc ml-doc">
        <header class="ml-doc-h"><div><h1>LISTA MESTRA DE PROJETOS</h1><p>${proj ? `${proj.code} · ${proj.name}` : 'Todas as obras'} · emitida em ${fmtDate(d.today)}</p></div>
          <div class="ml-doc-k"><span><b>${S.total}</b>projetos</span><span><b>${S.em_dia}</b>em dia</span><span class="k-late"><b>${S.atrasado}</b>atrasados</span><span><b>${S.alterados}</b>com alteração</span><span><b>${S.concluido}</b>concluídos</span></div></header>
        ${groups.map(g => html`<h2 class="ml-doc-o">${g[0].project_code} · ${g[0].project_name}</h2>
          <table class="ml-doc-t"><thead><tr><th>Projeto</th><th>Projetista</th><th>Etapas</th><th>Etapa atual</th><th>Previsto</th><th>Base</th><th>Desvio</th><th>Término</th><th>Situação</th><th>Último motivo</th></tr></thead>
            <tbody>${g.map(i => html`<tr><td><b>${i.type_name}</b>${i.name ? ` · ${i.name}` : ''}${i.revision ? html`<small> ${i.revision}</small>` : ''}</td><td>${i.designer || '—'}</td>
              <td>${steps(i)}<small> ${i.done_count}/${i.stages.length}</small></td><td>${i.current ? i.current.name : 'Concluído'}</td><td>${d0(i.current?.planned_date)}</td><td>${d0(i.current?.base_date)}</td>
              <td>${i.current ? shiftBadge(i.current.shift) : '—'}</td><td>${d0(i.finish?.date)} ${i.finish?.shift ? shiftBadge(i.finish.shift) : ''}</td><td>${sitBadge(i.status)}</td>
              <td class="ml-doc-why">${i.last_change ? html`<b>${i.last_change.reason}:</b> ${i.last_change.explanation || ''}` : '—'}</td></tr>`)}</tbody></table>`)}
        ${d.items.length ? '' : html`<p class="muted">Nenhum projeto na Lista Mestra.</p>`}
        ${main.length ? html`<h2 class="ml-doc-o">Histórico de alterações das datas</h2>
          <table class="ml-doc-t"><thead><tr><th>Data</th><th>Projeto</th><th>Etapa</th><th>De</th><th>Para</th><th>Desvio</th><th>Motivo</th><th>Explicação</th><th>Por</th></tr></thead>
            <tbody>${main.map(c => { const i = byId.get(c.item_id); const n = moved(c); return html`<tr><td>${fmtDate(c.created_at)}</td><td>${i ? `${i.project_code} · ${i.title}` : ''}</td><td>${c.stage_name || ''}${c.kind === 'base' ? ' (nova base)' : ''}</td>
              <td>${d0(c.old_date)}</td><td>${d0(c.new_date)}</td><td>${c.old_date && c.new_date ? shiftBadge(diff(c.new_date, c.old_date)) : ''}</td><td>${c.reason}</td><td>${c.explanation || ''}${n ? html`<small class="ml-doc-mv"> (+ ${nOf(n, 'etapa seguinte deslocada', 'etapas seguintes deslocadas')} junto)</small>` : ''}</td><td>${c.user_name || ''}</td></tr>`; })}</tbody></table>` : ''}
        <p class="ml-doc-leg">Desvio: dias em relação à data base (primeira previsão). <b>+</b> = depois da base · <b>−</b> = antes da base.</p>
      </article></div>`,
    mount(root) { bindPrintToolbar(root); },
  };
}

// ---------- Configurações: tipos de projeto e etapas ----------
const stageLi = s => html`<li class="ml-ts" data-id="${s.id || ''}">
  <span class="stage-move"><button type="button" class="icon-btn" data-move="-1" aria-label="Mover etapa para cima">▲</button><button type="button" class="icon-btn" data-move="1" aria-label="Mover etapa para baixo">▼</button></span>
  <input type="text" maxlength="80" value="${s.name || ''}" data-sname aria-label="Nome da etapa" placeholder="Nome da etapa" required>
  <label class="reason-active" title="Etapa inativa não aparece nos projetos (a não ser que já tenha datas)"><input type="checkbox" data-sactive ${s.active !== 0 ? 'checked' : ''}><span>Ativa</span></label>
  <button type="button" class="icon-btn" data-srm aria-label="Excluir etapa" title="${s.use_count ? 'Já tem datas: inative em vez de excluir' : 'Excluir etapa'}" aria-disabled="${s.use_count ? 'true' : 'false'}">✕</button></li>`;
const chain = t => (t.stages || []).filter(s => s.active !== 0).map(s => s.name).join(' → ');
const typeLi = (t, open = false) => html`<li class="ml-type ${t.active === 0 ? 'is-inactive' : ''} ${open ? 'is-open' : ''}" data-id="${t.id || ''}">
  <div class="ml-type-h"><span class="stage-move"><button type="button" class="icon-btn" data-move="-1" aria-label="Mover tipo para cima">▲</button><button type="button" class="icon-btn" data-move="1" aria-label="Mover tipo para baixo">▼</button></span>
    <input type="text" maxlength="80" value="${t.name || ''}" data-tname aria-label="Nome do tipo de projeto" placeholder="Tipo de projeto (ex.: Paisagismo)" required>
    <label class="reason-active"><input type="checkbox" data-tactive ${t.active !== 0 ? 'checked' : ''}><span>Ativo</span></label>
    <span class="stage-count">${t.use_count ? `${t.use_count} projeto(s)` : 'nenhum projeto'}</span>
    <button type="button" class="icon-btn" data-trm aria-label="Excluir tipo" title="${t.use_count ? 'Em uso: inative em vez de excluir' : 'Excluir tipo'}" aria-disabled="${t.use_count ? 'true' : 'false'}">✕</button></div>
  <div class="ml-chain"><span data-chain>${chain(t) || 'Nenhuma etapa ativa'}</span>
    <button type="button" class="btn btn-ghost btn-sm" data-tog aria-expanded="${open}">${icon('edit')}Editar etapas (${(t.stages || []).length})</button></div>
  <div class="ml-ts-box" ${open ? '' : 'hidden'}><ol class="ml-ts-list">${(t.stages || []).map(stageLi)}</ol>
  <button type="button" class="btn btn-ghost btn-sm" data-sadd>${icon('plus')}Etapa</button></div></li>`;

export const typesSection = (types, { project = null } = {}) => html`<section class="card" id="ml-types-card" style="max-width:900px;margin-bottom:16px">
  <div class="card-head"><h2>${icon('checklist')}${project ? `Tipos de projeto e etapas · ${project.code}` : 'Lista Mestra: formato padrão de tipos e etapas'}</h2><span class="sub">${types.filter(t => t.active).length} tipo(s) ativo(s)</span></div>
  <form class="card-body form" id="ml-types-form" novalidate>
    <p class="muted" style="margin:0">${project ? html`Formato desta obra: começou como cópia do padrão (Configurações) e pode ser ajustado só aqui. Alterar o nome ou a ordem vale para todos os projetos daquele tipo nesta obra; etapa nova aparece sem datas.`
      : html`Formato padrão: cada obra que liga a Lista Mestra recebe uma cópia destes tipos e etapas e pode ajustá-la na própria obra. Mudar o padrão vale para as próximas obras (as que já têm a Lista Mestra mantêm o formato delas).`}
      Etapas e tipos já usados não podem ser excluídos — inative-os.</p>
    <ul class="ml-types" id="ml-types">${types.map(t => typeLi(t))}</ul>
    <div><button type="button" class="btn btn-ghost" id="ml-type-add">${icon('plus')}Novo tipo de projeto</button></div>
    <div class="form-error" hidden></div>
    <div class="form-actions"><button type="submit" class="btn btn-primary">${icon('check')}Salvar tipos e etapas</button></div>
  </form></section>`;

export function bindTypesSection(root, endpoint = '/settings/master-list-types') {
  const form = root.querySelector('#ml-types-form');
  if (!form) return;
  const list = form.querySelector('#ml-types');
  const err = form.querySelector('.form-error');
  form.querySelector('#ml-type-add').addEventListener('click', () => {
    list.insertAdjacentHTML('beforeend', typeLi({ name: '', active: 1, stages: [{ name: '', active: 1 }] }, true).toString());
    list.lastElementChild.querySelector('[data-tname]').focus();
  });
  list.addEventListener('click', e => {
    const tog = e.target.closest('[data-tog]');
    if (tog) {
      const li = tog.closest('.ml-type');
      const box = li.querySelector('.ml-ts-box');
      box.hidden = !box.hidden;
      li.classList.toggle('is-open', !box.hidden);
      tog.setAttribute('aria-expanded', String(!box.hidden));
      return;
    }
    const mv = e.target.closest('[data-move]');
    if (mv) {
      const li = mv.closest('.ml-ts') || mv.closest('.ml-type');
      const sib = mv.dataset.move === '-1' ? li.previousElementSibling : li.nextElementSibling;
      if (sib) (mv.dataset.move === '-1' ? sib.before(li) : sib.after(li));
      return;
    }
    if (e.target.closest('[data-sadd]')) {
      const ol = e.target.closest('.ml-type').querySelector('.ml-ts-list');
      ol.insertAdjacentHTML('beforeend', stageLi({ name: '', active: 1 }).toString());
      ol.lastElementChild.querySelector('[data-sname]').focus();
      return;
    }
    const srm = e.target.closest('[data-srm]');
    if (srm) { if (srm.getAttribute('aria-disabled') === 'true') return toast('Esta etapa já tem datas: desmarque "Ativa" em vez de excluir.', 'warn'); srm.closest('.ml-ts').remove(); return; }
    const trm = e.target.closest('[data-trm]');
    if (trm) { if (trm.getAttribute('aria-disabled') === 'true') return toast('Este tipo está em uso: desmarque "Ativo" em vez de excluir.', 'warn'); trm.closest('.ml-type').remove(); }
  });
  // Sequência resumida acompanha a edição
  list.addEventListener('input', e => { const li = e.target.closest('.ml-type'); if (li) li.querySelector('[data-chain]').textContent = [...li.querySelectorAll('.ml-ts')].filter(x => x.querySelector('[data-sactive]').checked).map(x => x.querySelector('[data-sname]').value.trim()).filter(Boolean).join(' → '); });
  list.addEventListener('change', e => { if (e.target.matches('[data-sactive]')) e.target.dispatchEvent(new Event('input', { bubbles: true })); });
  form.addEventListener('submit', async e => {
    e.preventDefault();
    err.hidden = true;
    const types = [...list.querySelectorAll('.ml-type')].map(li => ({
      id: Number(li.dataset.id) || null, name: li.querySelector('[data-tname]').value, active: li.querySelector('[data-tactive]').checked,
      stages: [...li.querySelectorAll('.ml-ts')].map(s => ({ id: Number(s.dataset.id) || null, name: s.querySelector('[data-sname]').value, active: s.querySelector('[data-sactive]').checked })),
    }));
    const btn = form.querySelector('[type=submit]');
    btn.disabled = true;
    try {
      const saved = await api(endpoint, { method: 'PUT', body: { types } });
      list.innerHTML = saved.map(t => typeLi(t).toString()).join('');
      toast('Tipos de projeto e etapas salvos.');
    } catch (ex) { err.textContent = ex.message; err.hidden = false; }
    btn.disabled = false;
  });
}

// Página da obra: tipos de projeto e etapas desta obra (cópia do padrão, editável aqui)
export async function typesPage({ params }) {
  const pid = Number(params.id);
  const d = await api(`/projects/${pid}/master-list-types`);
  return {
    title: `Tipos e etapas · ${d.project.code}`,
    html: html`${pageHead({ back: { href: `#/projetos/${pid}/lista-mestra`, label: 'Lista Mestra' }, eyebrow: `${d.project.code} · ${d.project.name}`, title: 'Tipos de projeto e etapas da obra',
        sub: 'Formato usado na Lista Mestra desta obra.' })}
      ${d.can_edit ? typesSection(d.types, { project: d.project })
        : html`<section class="card"><div class="card-body"><p class="muted" style="margin-top:0">Somente o responsável da obra e os gestores alteram o formato.</p>
          <ul class="ml-types">${d.types.map(t => html`<li class="ml-type ${t.active ? '' : 'is-inactive'}"><b>${t.name}</b><div class="ml-chain">${t.stages.filter(s => s.active).map(s => s.name).join(' → ')}</div></li>`)}</ul></div></section>`}`,
    mount(root) { if (d.can_edit) bindTypesSection(root, `/projects/${pid}/master-list-types`); },
  };
}
