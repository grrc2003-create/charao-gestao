// História do projeto (A4): narrativa cronológica — abertura, capítulos por mês, situação atual,
// definições vigentes, cronograma com os registros e (opcional) a linha do tempo detalhada.
import { html, api, fmtDate, fmtDateTime, fmtPct, STATUS } from '../core.js';
import { recBadge } from './record-icons.js';
import { printToolbar, bindPrintToolbar, setPageFooter } from './print-common.js';
import { ganttChart, drawGanttLinks } from './gantt.js';

const KIND_LABEL = { projeto: 'Projeto', conclusao: 'Conclusão', reagendamento: 'Reagendamento', registro: 'Registro', medicao: 'Medição', etapa: 'Classificação' };

export async function view({ params, query, setQuery, render }) {
  const withGantt = query.get('gantt') !== '0';
  const gSubs = query.get('gsub') !== '0';
  const withTimeline = query.get('linha') === '1';
  const withDetail = query.get('detalhe') !== '0';
  const q = over => ({ gantt: withGantt ? '' : '0', gsub: gSubs ? '' : '0', linha: withTimeline ? '1' : '', detalhe: withDetail ? '' : '0', ...over });
  const dd = d => (d ? fmtDate(d).slice(0, 5) : '—');
  // Detalhe do mês: tarefas abertas, concluídas, reagendamentos e registros
  const monthDetail = c => {
    const d = c.detail;
    if (!d) return '';
    return html`<div class="hist-det">
      ${d.records.length ? html`<h5 class="hist-dh">Registros do mês (${d.records.length})</h5>
        <table class="r-table hist-t"><thead><tr><th>Data</th><th>Tipo</th><th>Código</th><th>Registro</th></tr></thead>
        <tbody>${d.records.map(r => html`<tr><td class="small nowrap">${dd(r.date)}</td><td class="small nowrap">${recBadge(r.icon, r.color, 'rg-ic-xs')} ${r.type_name}</td>
          <td class="mono small nowrap">${r.code || '—'}</td><td>${r.title}</td></tr>`)}</tbody></table>` : ''}
      ${d.opened.length ? html`<h5 class="hist-dh">Tarefas abertas (${d.opened.length})</h5>
        <table class="r-table hist-t"><thead><tr><th>Aberta</th><th>Código</th><th>Tarefa</th><th>Classificação</th><th>Responsável</th><th>Prazo</th><th>Situação hoje</th></tr></thead>
        <tbody>${d.opened.map(t => html`<tr><td class="small nowrap">${dd(t.opened)}</td><td class="mono small nowrap">${t.code}</td><td>${t.sub ? '↳ ' : ''}${t.title}${t.origin ? html` <span class="small muted">(de registro)</span>` : ''}</td>
          <td class="small">${t.stage_name || '—'}</td><td class="small">${t.assignee_name || '—'}</td><td class="small nowrap">${t.due_date ? fmtDate(t.due_date) : 'sem prazo'}</td>
          <td class="small nowrap ${t.status === 'atrasada' ? 'late' : ''}">${STATUS[t.status]?.label || t.status}</td></tr>`)}</tbody></table>` : ''}
      ${d.done.length ? html`<h5 class="hist-dh">Tarefas concluídas (${d.done.length})</h5>
        <table class="r-table hist-t"><thead><tr><th>Conclusão</th><th>Código</th><th>Tarefa</th><th>Responsável</th><th>Prazo</th><th>Resultado</th></tr></thead>
        <tbody>${d.done.map(t => html`<tr><td class="small nowrap">${dd(t.date)}</td><td class="mono small nowrap">${t.code}</td><td>${t.sub ? '↳ ' : ''}${t.title}</td>
          <td class="small">${t.assignee_name || '—'}</td><td class="small nowrap">${t.due_date ? fmtDate(t.due_date) : 'sem prazo'}</td>
          <td class="small nowrap ${t.on_time ? '' : 'late'}">${!t.due_date ? 'concluída' : t.on_time ? (t.early ? `${t.early} d antes do prazo` : 'no prazo') : `${t.days_late} d de atraso`}</td></tr>`)}</tbody></table>` : ''}
      ${d.reschedules.length ? html`<h5 class="hist-dh">Reagendamentos de prazo (${d.reschedules.length})</h5>
        <table class="r-table hist-t"><thead><tr><th>Data</th><th>Código</th><th>Tarefa</th><th>Prazo</th><th class="num">Dias</th><th>Justificativa</th></tr></thead>
        <tbody>${d.reschedules.map(r => html`<tr><td class="small nowrap">${dd(r.date)}</td><td class="mono small nowrap">${r.code}</td><td>${r.title}</td>
          <td class="small nowrap">${dd(r.old_due)} → ${dd(r.new_due)}</td><td class="num small">${r.days === null ? '—' : `${r.days > 0 ? '+' : ''}${r.days}`}</td><td class="small">${r.reason}</td></tr>`)}</tbody></table>` : ''}
    </div>`;
  };
  const [h, g] = await Promise.all([api(`/projects/${params.id}/history`), withGantt ? api('/gantt', { query: { project: params.id } }) : null]);
  const p = h.project;
  const s = h.summary;
  const kpi = (l, v, sub, c = '#2A3D50') => html`<div class="r-kpi" style="--c:${c}"><div class="r-kpi-l">${l}</div><div class="r-kpi-v">${v}</div>${sub ? html`<div class="r-kpi-s">${sub}</div>` : ''}</div>`;
  const chapters = h.chapters.filter(c => c.paragraphs.length);
  return {
    title: `História do projeto · ${p.code}`,
    html: html`${printToolbar({
      back: `#/projetos/${p.id}`, title: `História do projeto — ${p.code} · ${p.name}`,
      extra: html`<label class="pt-opt"><input type="checkbox" id="h-gantt" ${withGantt ? 'checked' : ''}>Cronograma</label>
        ${withGantt ? html`<label class="pt-opt"><input type="checkbox" id="h-gsub" ${gSubs ? 'checked' : ''}>Subtarefas no Gantt</label>` : ''}
        <label class="pt-opt"><input type="checkbox" id="h-det" ${withDetail ? 'checked' : ''}>Detalhar tarefas por mês</label>
        <label class="pt-opt"><input type="checkbox" id="h-line" ${withTimeline ? 'checked' : ''}>Linha do tempo detalhada</label>`,
    })}
    <div class="doc-stage"><article class="doc a4 hist-doc" id="doc">
      <header class="r-header">
        <img src="/assets/logo.webp" alt="Charão Engenharia & Construção" class="r-logo">
        <div class="r-doctype"><div class="r-kicker">História do projeto</div><div class="r-level">até ${fmtDate(h.ref)}</div></div>
      </header>
      <div class="r-rule"></div>
      <section class="r-scope">
        <div><div class="r-lbl">Projeto</div><h1>${p.code} · ${p.name}</h1><div class="muted">Cliente: ${p.client}${p.location ? ` · ${p.location}` : ''}${p.type_name ? ` · ${p.type_name}` : ''}</div></div>
        <dl class="r-meta">
          <dt>Responsável técnico</dt><dd>${p.lead_name || '—'}</dd>
          <dt>Início previsto</dt><dd>${fmtDate(p.start_date)}</dd>
          <dt>Término previsto</dt><dd>${fmtDate(p.end_date)}</dd>
          ${p.actual_end_date ? html`<dt>Término real</dt><dd>${fmtDate(p.actual_end_date)}</dd>` : ''}
          <dt>Emissão</dt><dd>${fmtDateTime(new Date().toISOString())}</dd>
        </dl>
      </section>

      <section class="r-section avoid"><h3 class="r-h">Como tudo começou</h3>${h.intro.map(t => html`<p class="r-p">${t}</p>`)}</section>

      <section class="r-section avoid"><h3 class="r-h">O projeto em números</h3>
        <div class="r-kpis">
          ${kpi('Conclusão', fmtPct(s.completion_pct ?? 0), `${s.done} de ${s.total} tarefas`, '#F26B21')}
          ${kpi('Prazo decorrido', h.elapsed === null ? '—' : `${h.elapsed}%`, p.end_date ? `término ${fmtDate(p.end_date)}` : '')}
          ${kpi('Entregas no prazo', fmtPct(s.on_time_pct), `${s.on_time} de ${s.delivered}`, '#1F6B41')}
          ${kpi('Atrasadas', s.late, s.late ? 'em aberto' : 'nenhuma', '#C0392B')}
        </div>
        ${h.counts.length ? html`<div class="hist-counts">${h.counts.map(c => html`<span>${recBadge(c.icon, c.color, 'rg-ic-xs')}${c.name}: <b>${c.n}</b></span>`)}</div>` : ''}
      </section>

      ${g && g.tasks.length ? html`<section class="r-section r-gantt"><h3 class="r-h">Cronograma e momentos registrados</h3>
        ${ganttChart(gSubs ? g.tasks : g.tasks.filter(t => !t.parent_code), { ref: g.ref, groupLabel: t => t.stage_name || 'Geral', marks: g.marks })}</section>` : ''}

      <section class="r-section ${g && g.tasks.length ? 'r-after-gantt' : ''}"><h3 class="r-h">A história, mês a mês</h3>
        ${chapters.length ? chapters.map(c => html`<div class="hist-ch">
          <h4 class="hist-month">${c.label[0].toUpperCase()}${c.label.slice(1)}
            <span class="hist-mc">${c.counts.created} aberta(s) · ${c.counts.done} concluída(s)${c.counts.records ? ` · ${c.counts.records} registro(s)` : ''}${c.counts.reschedules ? ` · ${c.counts.reschedules} reagendamento(s)` : ''}</span></h4>
          ${c.paragraphs.map(t => html`<p class="r-p">${t}</p>`)}${withDetail ? monthDetail(c) : ''}</div>`) : html`<p class="muted">Ainda não há acontecimentos registrados.</p>`}
      </section>

      <section class="r-section avoid"><h3 class="r-h">Onde estamos</h3>${h.current.map(t => html`<p class="r-p">${t}</p>`)}
        ${h.late.length ? html`<h4 class="r-sub">Tarefas atrasadas</h4><table class="r-table"><thead><tr><th>Código</th><th>Tarefa</th><th>Responsável</th><th>Prazo</th><th class="num">Atraso</th></tr></thead>
          <tbody>${h.late.map(t => html`<tr><td class="mono nowrap">${t.code}</td><td>${t.title}</td><td class="small">${t.assignee_name || '—'}</td><td class="small nowrap">${fmtDate(t.due_date)}</td><td class="num late">${t.days_late} d</td></tr>`)}</tbody></table>` : ''}
        ${h.upcoming.length ? html`<h4 class="r-sub">Próximos 15 dias</h4><table class="r-table"><thead><tr><th>Código</th><th>Tarefa</th><th>Responsável</th><th>Prazo</th></tr></thead>
          <tbody>${h.upcoming.map(t => html`<tr><td class="mono nowrap">${t.code}</td><td>${t.title}</td><td class="small">${t.assignee_name || '—'}</td><td class="small nowrap">${fmtDate(t.due_date)}</td></tr>`)}</tbody></table>` : ''}
        ${h.pendencias.length ? html`<h4 class="r-sub">Pendências registradas em aberto</h4><table class="r-table"><thead><tr><th>Código</th><th>Pendência</th><th>Tipo</th><th>Responsável</th><th>Prazo</th></tr></thead>
          <tbody>${h.pendencias.map(x => html`<tr><td class="mono nowrap">${x.code || '—'}</td><td>${x.title}</td><td class="small">${x.type_name}</td><td class="small">${x.assignee_name || '—'}</td><td class="small nowrap ${x.status === 'atrasada' ? 'late' : ''}">${x.due_date ? fmtDate(x.due_date) : '—'}</td></tr>`)}</tbody></table>` : ''}
      </section>

      ${h.vigentes.length ? html`<section class="r-section avoid"><h3 class="r-h">O que está definido (definições vigentes)</h3>
        <table class="r-table"><thead><tr><th>Código</th><th>Definição</th><th>Data</th><th>Origem</th></tr></thead>
        <tbody>${h.vigentes.map(v => html`<tr><td class="mono nowrap">${v.code || '—'}</td><td>${v.title}${v.replaces_code ? html`<div class="small muted">substitui ${v.replaces_code}</div>` : ''}</td>
          <td class="small nowrap">${fmtDate(v.record_date)}</td><td class="small">${[v.origin, v.decided_by].filter(Boolean).join(' · ') || '—'}</td></tr>`)}</tbody></table></section>` : ''}

      ${withTimeline ? html`<section class="r-section"><h3 class="r-h">Linha do tempo detalhada <span class="muted small">(${h.timeline.length})</span></h3>
        <table class="r-table"><thead><tr><th>Data</th><th>Tipo</th><th>Acontecimento</th><th>Detalhe</th></tr></thead>
        <tbody>${h.timeline.map(e => html`<tr><td class="small nowrap">${fmtDate(e.date)}</td><td class="small nowrap">${e.kind === 'registro' ? recBadge(e.icon, e.color, 'rg-ic-xs') : html`<span class="r-dot" style="--c:${e.color}"></span>`} ${e.kind === 'registro' ? e.detail : KIND_LABEL[e.kind] || e.kind}</td>
          <td>${e.title}</td><td class="small">${e.detail}</td></tr>`)}</tbody></table></section>` : ''}

      <section class="r-section r-sign avoid">
        <div><span></span>Responsável pela emissão</div>
        <div><span></span>Responsável técnico / Gestor</div>
      </section>
      <footer class="r-footer">
        <span>Charão Engenharia & Construção · História do projeto · ${p.code}</span>
        <span>Documento gerado pelo sistema Charão Gestão de Obras a partir das tarefas e dos registros do projeto</span>
      </footer>
    </article></div>`,
    mount(root) {
      setPageFooter(`Charão · História do projeto · ${p.code} · ${p.name}`);
      drawGanttLinks(root);
      bindPrintToolbar(root);
      root.querySelector('#h-gantt').addEventListener('change', e => { setQuery(q({ gantt: e.target.checked ? '' : '0' })); render(); });
      root.querySelector('#h-gsub')?.addEventListener('change', e => { setQuery(q({ gsub: e.target.checked ? '' : '0' })); render(); });
      root.querySelector('#h-det').addEventListener('change', e => { setQuery(q({ detalhe: e.target.checked ? '' : '0' })); render(); });
      root.querySelector('#h-line').addEventListener('change', e => { setQuery(q({ linha: e.target.checked ? '1' : '' })); render(); });
    },
  };
}
