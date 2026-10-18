// História do projeto (A4): narrativa cronológica — abertura, capítulos por mês, situação atual,
// definições vigentes, cronograma com os registros e (opcional) a linha do tempo detalhada.
import { html, api, icon, fmtDate, fmtDateTime, fmtPct } from '../core.js';
import { printToolbar, bindPrintToolbar, setPageFooter } from './print-common.js';
import { ganttChart, drawGanttLinks } from './gantt.js';

const KIND_LABEL = { projeto: 'Projeto', conclusao: 'Conclusão', reagendamento: 'Reagendamento', registro: 'Registro', medicao: 'Medição', etapa: 'Classificação' };

export async function view({ params, query, setQuery, render }) {
  const withGantt = query.get('gantt') !== '0';
  const withTimeline = query.get('linha') === '1';
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
        ${h.counts.length ? html`<div class="hist-counts">${h.counts.map(c => html`<span style="--c:${c.color}"><i></i>${c.name}: <b>${c.n}</b></span>`)}</div>` : ''}
      </section>

      ${g && g.tasks.length ? html`<section class="r-section r-gantt"><h3 class="r-h">Cronograma e momentos registrados</h3>
        ${ganttChart(g.tasks, { ref: g.ref, groupLabel: t => t.stage_name || 'Geral', marks: g.marks })}</section>` : ''}

      <section class="r-section ${g && g.tasks.length ? 'r-after-gantt' : ''}"><h3 class="r-h">A história, mês a mês</h3>
        ${chapters.length ? chapters.map(c => html`<div class="hist-ch avoid">
          <h4 class="hist-month">${c.label[0].toUpperCase()}${c.label.slice(1)}
            <span class="hist-mc">${c.counts.created} aberta(s) · ${c.counts.done} concluída(s)${c.counts.records ? ` · ${c.counts.records} registro(s)` : ''}${c.counts.reschedules ? ` · ${c.counts.reschedules} reagendamento(s)` : ''}</span></h4>
          ${c.paragraphs.map(t => html`<p class="r-p">${t}</p>`)}</div>`) : html`<p class="muted">Ainda não há acontecimentos registrados.</p>`}
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
        <tbody>${h.timeline.map(e => html`<tr><td class="small nowrap">${fmtDate(e.date)}</td><td class="small nowrap"><span class="r-dot" style="--c:${e.color}"></span>${KIND_LABEL[e.kind] || e.kind}</td>
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
      root.querySelector('#h-gantt').addEventListener('change', e => { setQuery({ gantt: e.target.checked ? '' : '0', linha: withTimeline ? '1' : '' }); render(); });
      root.querySelector('#h-line').addEventListener('change', e => { setQuery({ gantt: withGantt ? '' : '0', linha: e.target.checked ? '1' : '' }); render(); });
    },
  };
}
