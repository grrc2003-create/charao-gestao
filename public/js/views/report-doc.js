// Documento de relatório (A4) — pronto para impressão / salvar em PDF.
import { html, raw, api, esc, icon, STATUS, STATUS_ORDER, PROOF, PRIORITY, fmtDate, fmtDateTime, fmtPct } from '../core.js';
import { STATUS_COLOR } from './shared.js';
import { printToolbar, bindPrintToolbar, setPageFooter } from './print-common.js';
import { ganttChart, drawGanttLinks } from './gantt.js';
import { periodKey, periodInfo } from './periods.js';

const TYPE_TITLE = { projeto: 'Relatório de Projeto', usuario: 'Relatório Individual', equipe: 'Relatório de Gestor e Equipe', geral: 'Relatório Geral da Operação', tarefas: 'Relatório de Tarefas' };
const LEVEL_TITLE = { resumo: 'Resumo', detalhado: 'Detalhado', completo: 'Completo com fotos' };

function executiveSummary(r) {
  const s = r.summary;
  const parts = [];
  if (!s.total) return ['Não há tarefas no escopo e período selecionados.'];
  parts.push(`O escopo analisado reúne ${s.total} tarefa(s), das quais ${s.done} estão concluídas (${fmtPct(s.completion_pct ?? 0)}), ${s.in_progress + s.open} seguem em execução ou abertas e ${s.review} aguardam conferência.`);
  if (s.late) parts.push(`Há ${s.late} tarefa(s) com prazo vencido sem entrega, com atraso médio de ${String(s.avg_delay_days).replace('.', ',')} dia(s) considerando entregas tardias e atrasos ativos.`);
  else parts.push('Não há tarefas com prazo vencido sem entrega na data de referência.');
  if (s.delivered) parts.push(`Das ${s.delivered} entrega(s) registradas, ${s.on_time} ocorreram dentro do prazo (${fmtPct(s.on_time_pct)} de pontualidade).`);
  if (s.due_soon) parts.push(`${s.due_soon} tarefa(s) vencem nos próximos 7 dias e merecem acompanhamento.`);
  const worst = r.by_project.filter(p => p.summary.late).sort((a, b) => b.summary.late - a.summary.late)[0];
  if (worst && r.type !== 'projeto') parts.push(`Maior concentração de atrasos: ${worst.label} (${worst.summary.late}).`);
  return parts;
}

const kpiBox = (label, value, sub, color) => html`<div class="r-kpi" style="--c:${color || '#2A3D50'}"><div class="r-kpi-l">${label}</div><div class="r-kpi-v">${value}</div>${sub ? html`<div class="r-kpi-s">${sub}</div>` : ''}</div>`;

function statusBars(by, total) {
  return html`<table class="r-table r-status"><tbody>${STATUS_ORDER.map(s => {
    const n = by[s] || 0;
    const pct = total ? Math.round((n / total) * 100) : 0;
    return html`<tr><td class="nowrap"><span class="r-dot" style="--c:${STATUS_COLOR[s]}"></span>${STATUS[s].label}</td>
      <td class="r-barcell"><div class="r-bar"><span style="width:${pct}%;background:${STATUS_COLOR[s]}"></span></div></td>
      <td class="num">${n}</td><td class="num muted">${pct}%</td></tr>`;
  })}</tbody></table>`;
}

const groupTable = (title, rows, labelHead) => rows.length ? html`<section class="r-section avoid">
  <h3 class="r-h">${title}</h3>
  <table class="r-table"><thead><tr><th>${labelHead}</th><th class="num">Tarefas</th><th class="num">Concluídas</th><th class="num">Em andamento</th><th class="num">Atrasadas</th><th class="num">Conclusão</th><th class="num">No prazo</th></tr></thead>
  <tbody>${rows.map(g => html`<tr><td>${g.label}${g.job_title ? html`<div class="muted small">${g.job_title}</div>` : ''}</td><td class="num">${g.summary.total}</td><td class="num">${g.summary.done}</td>
    <td class="num">${g.summary.in_progress}</td><td class="num ${g.summary.late ? 'late' : ''}">${g.summary.late}</td>
    <td class="num"><b>${fmtPct(g.summary.completion_pct ?? 0)}</b></td><td class="num">${fmtPct(g.summary.on_time_pct)}</td></tr>`)}</tbody></table></section>` : '';

// Prazos e repactuação: constância de atrasos e de reagendamentos, motivos, evolução e (detalhado) histórico por tarefa
const MONTHS = ['jan', 'fev', 'mar', 'abr', 'mai', 'jun', 'jul', 'ago', 'set', 'out', 'nov', 'dez'];
const n1 = v => String(v ?? 0).replace('.', ',');
const lvl = (kind, s) => {
  if (!s.with_due) return '';
  const l = kind === 'late' ? (s.late_rate <= 15 ? 'bom' : s.late_rate <= 30 ? 'atencao' : 'critico')
    : kind === 'corrective' ? (!s.reschedules || s.corrective_pct <= 30 ? 'bom' : s.corrective_pct <= 50 ? 'atencao' : 'critico')
    : (!s.chronic ? 'bom' : (s.chronic / s.with_due) * 100 <= 5 ? 'atencao' : 'critico');
  return html`<span class="r-sig r-sig-${l}">${{ bom: '● Bom', atencao: '▲ Atenção', critico: '■ Crítico' }[l]}</span>`;
};
const dlRow = (label, s) => html`<tr><td>${label}</td><td class="num">${s.with_due}</td><td class="num">${fmtPct(s.late_rate ?? 0)}</td>
  <td class="num">${s.late_episodes}</td><td class="num">${fmtPct(s.reschedule_rate ?? 0)}</td><td class="num">${s.reschedules ? fmtPct(s.corrective_pct) : '—'}</td>
  <td class="num">${s.chronic}</td><td class="num">${fmtPct(s.on_time_original_pct)}</td><td class="num">${fmtPct(s.on_time_pct)}</td></tr>`;
const dlTable = (title, rows, head) => rows.length ? html`<h4 class="r-sub">${title}</h4>
  <table class="r-table avoid"><thead><tr><th>${head}</th><th class="num">Com prazo</th><th class="num">Ficaram atrasadas</th><th class="num">Episódios</th>
    <th class="num">Repactuação</th><th class="num">Corretiva</th><th class="num">Crônicas</th><th class="num">Pont. real</th><th class="num">Pont. vigente</th></tr></thead>
  <tbody>${rows.map(g => dlRow(g.label, g.summary))}</tbody></table>` : '';

function reschedSection(r) {
  const s = r.summary;
  const rs = r.reschedules;
  if (!s.with_due) return '';
  const d = s.reschedule_dist;
  const trend = r.trend.filter(m => m.total);
  return html`<section class="r-section">
    <h3 class="r-h">Prazos e repactuação</h3>
    <div class="r-kpis avoid" style="grid-template-columns:repeat(3,1fr)">
      ${kpiBox(html`Ficaram atrasadas ${lvl('late', s)}`, fmtPct(s.late_rate ?? 0), `${s.ever_late} de ${s.with_due} tarefas, ao menos 1 vez`, '#C0392B')}
      ${kpiBox('Episódios de atraso', s.late_episodes, `média ${n1(s.late_episodes_avg)} por tarefa`, '#C0392B')}
      ${kpiBox('Taxa de repactuação', fmtPct(s.reschedule_rate ?? 0), `${s.rescheduled} tarefa(s) · ${s.reschedules} reagendamento(s)`, '#C9520F')}
      ${kpiBox(html`Repactuação corretiva ${lvl('corrective', s)}`, fmtPct(s.corrective_pct ?? 0), `${s.corrective} após vencer · ${s.preventive} antes`, '#C9520F')}
      ${kpiBox(html`Tarefas crônicas ${lvl('chronic', s)}`, s.chronic, `${r.chronic_min}+ reagendamentos · +${s.days_added} dia(s) acrescidos`, '#707E8B')}
      ${kpiBox('Pontualidade real × repactuada', `${fmtPct(s.on_time_original_pct)} × ${fmtPct(s.on_time_pct)}`, 'prazo original × prazo vigente', '#2E8B57')}
    </div>
    <p class="r-p small muted" style="margin-top:6px">Preventiva = reagendada antes de vencer (planejamento). Corretiva = reagendada com o prazo já vencido (cobre um atraso).
      Episódio de atraso = repactuação corretiva, entrega após o prazo ou atraso atual. Semáforo: atraso ≤15% bom, ≤30% atenção; corretivas ≤30% bom, ≤50% atenção; crônicas nenhuma bom, até 5% atenção.</p>
    <table class="r-table avoid" style="margin-top:6px"><thead><tr><th>Reagendamentos por tarefa</th><th class="num">Nenhum</th><th class="num">1 vez</th><th class="num">2 vezes</th><th class="num">3+ vezes</th></tr></thead>
      <tbody><tr><td>Tarefas com prazo (${s.with_due})</td><td class="num">${d.r0}</td><td class="num">${d.r1}</td><td class="num">${d.r2}</td><td class="num"><b>${d.r3}</b></td></tr></tbody></table>
    ${trend.length ? html`<h4 class="r-sub">Evolução mensal (mês do prazo original)</h4>
      <table class="r-table avoid"><thead><tr><th>Mês</th><th class="num">Tarefas</th><th>Ficaram atrasadas</th><th>Repactuadas</th></tr></thead>
      <tbody>${trend.map(m => html`<tr><td>${MONTHS[Number(m.month.slice(5, 7)) - 1]}/${m.month.slice(0, 4)}</td><td class="num">${m.total}</td>
        <td><span class="r-mini" style="--w:${m.late_rate || 0}%;--c:#C0392B"></span> ${m.ever_late} (${fmtPct(m.late_rate ?? 0)})</td>
        <td><span class="r-mini" style="--w:${m.reschedule_rate || 0}%;--c:#7A5BB8"></span> ${m.rescheduled} (${fmtPct(m.reschedule_rate ?? 0)})</td></tr>`)}</tbody></table>` : ''}
    ${r.type !== 'usuario' ? dlTable('Por responsável', r.by_person.filter(g => g.summary.with_due), 'Responsável') : ''}
    ${r.by_stage.length > 1 ? dlTable('Por classificação', r.by_stage.filter(g => g.summary.with_due), 'Classificação') : ''}
    ${rs.reasons.length ? html`<h4 class="r-sub">Justificativas usadas</h4>
      <table class="r-table avoid"><thead><tr><th>Justificativa</th><th class="num">Reagendamentos</th><th class="num">%</th></tr></thead>
      <tbody>${rs.reasons.map(x => html`<tr><td>${x.name}</td><td class="num">${x.count}</td><td class="num">${Math.round((x.count / s.reschedules) * 100)}%</td></tr>`)}</tbody></table>` : ''}
    ${r.level !== 'resumo' && rs.tasks.length ? html`<h4 class="r-sub">Tarefas repactuadas</h4>
      <table class="r-table"><thead><tr><th>Tarefa</th><th>Prazo original → atual</th><th class="num">Vezes</th><th>Reagendamentos (tipo · justificativa · por · em)</th></tr></thead>
      <tbody>${rs.tasks.map(t => html`<tr><td><span class="mono">${t.code}</span><div><b>${t.title}</b></div><div class="muted small">${t.assignee_name || '—'}</div></td>
        <td class="nowrap small">${fmtDate(t.original_due)} → <b>${fmtDate(t.due_date)}</b><div>${stBadge(t.eff_status)}</div>
          ${t.late_episodes ? html`<div class="r-resched">atrasou ${t.late_episodes}x</div>` : ''}</td>
        <td class="num"><b>${t.reschedule_count}</b>${t.chronic ? html`<div class="r-resched">crônica</div>` : ''}</td>
        <td class="small">${t.entries.map((e, i) => html`<div>${i + 1}º ${fmtDate(e.old_due)} → ${fmtDate(e.new_due)} · <span class="r-kind r-kind-${e.kind}">${e.kind === 'corretiva' ? 'Corretiva' : 'Preventiva'}</span> · <b>${e.reason_name}</b>${e.note ? ` — ${e.note}` : ''} <span class="muted">· ${e.user_name || '—'} · ${fmtDateTime(e.created_at)}</span></div>`)}</td></tr>`)}</tbody></table>` : ''}
  </section>`;
}

const stBadge = s => html`<span class="r-st" style="--c:${STATUS_COLOR[s]}">${STATUS[s].label}</span>`;

const stageLabel = (t, multi) => (multi ? `${t.project_code} · ${t.stage_name || 'Geral'}` : (t.stage_name || 'Geral'));

const PERIOD_GROUPS = ['dia', 'semana', 'mes'];
const ORG_LABEL = { classificacao: 'Por classificação', nenhum: 'Por status e prazo', dia: 'Por dia (prazo)', semana: 'Por semana (prazo)', mes: 'Por mês (prazo)' };
// Rótulo do grupo conforme a organização escolhida (classificação ou período do prazo)
const groupLabelFor = (group, multi) => PERIOD_GROUPS.includes(group)
  ? t => periodInfo(periodKey(t.due_date, group), group).label
  : group === 'classificacao' ? t => stageLabel(t, multi) : null;

// labelOf: rótulo do grupo (ou null = lista única); hideStage: a classificação já é o próprio grupo
function taskTable(tasks, showProject, labelOf, hideStage = false) {
  const cols = showProject ? 7 : 6;
  const grouped = !!labelOf;
  let last = null;
  const groupRow = t => {
    const label = grouped ? labelOf(t) : null;
    if (!grouped || label === last) return '';
    last = label;
    const items = tasks.filter(x => labelOf(x) === label);
    const done = items.filter(x => x.eff_status === 'concluida').length;
    return html`<tr class="r-grouprow"><td colspan="${cols}"><span class="r-stage">${label}</span>
      <span class="muted small">${items.length} tarefa(s) · ${done} concluída(s) · ${Math.round((done / items.length) * 100)}%</span></td></tr>`;
  };
  return html`<table class="r-table r-tasks"><thead><tr><th>Código</th><th>Tarefa</th>${showProject ? html`<th>Projeto</th>` : ''}<th>Responsável</th><th>Prazo</th><th>Prior.</th><th>Status</th></tr></thead>
    <tbody>${tasks.map(t => html`${groupRow(t)}<tr><td class="mono nowrap">${t.code}</td>
      <td>${t.parent_code ? html`<div class="muted small">↳ Subtarefa de ${t.parent_code}</div>` : ''}<b>${t.title}</b>${!hideStage && t.stage_name && !t.stage_default ? html` <span class="r-stage r-stage-sm">${t.stage_name}</span>` : ''}${t.field_summary ? html`<div class="muted small">${t.field_summary}</div>` : ''}</td>
      ${showProject ? html`<td class="small">${t.project_code}</td>` : ''}
      <td class="small">${t.assignee_name || '—'}</td>
      <td class="nowrap small ${t.eff_status === 'atrasada' ? 'late' : ''}">${fmtDate(t.due_date)}${t.days_late ? html`<div class="small">${t.days_late}d atraso</div>` : ''}${t.reschedule_count ? html`<div class="r-resched">↻ ${t.reschedule_count}x · orig. ${fmtDate(t.original_due)}</div>` : ''}</td>
      <td class="small">${PRIORITY[t.priority]}</td><td>${stBadge(t.eff_status)}</td></tr>`)}</tbody></table>`;
}

function evidence(t) {
  const isPdf = f => f.mime === 'application/pdf';
  const photos = t.files.filter(f => f.kind === 'execucao' && !isPdf(f));
  const refs = t.files.filter(f => f.kind === 'referencia' && !isPdf(f));
  const pdfs = t.files.filter(isPdf);
  const keyHist = t.history.filter(h => /criada|Respons|Prazo|Enviada|Conferência|Devolvida|Concluída|reaberta/i.test(h.action));
  return html`<article class="r-evidence avoid">
    <header><span class="mono">${t.code}</span><b>${t.title}${t.parent_code ? html` <span class="muted small">(subtarefa de ${t.parent_code})</span>` : ''}</b>${stBadge(t.eff_status)}</header>
    <div class="r-ev-grid">
      <div><div class="r-lbl">Solicitação</div><p>${t.description}</p>
        <div class="small muted">Responsável: ${t.assignee_name || '—'} · Prazo: ${fmtDate(t.due_date)} · Comprovação: ${PROOF[t.proof_type].label}</div></div>
      <div><div class="r-lbl">Execução</div>
        ${t.task_type === 'checklist' ? html`<p><b>Check-list:</b> ${t.cl_done} de ${t.cl_total} itens respondidos${t.cl_nc ? ` · ${t.cl_nc} não conforme(s)` : ''}. Detalhes no relatório do check-list.</p>` : ''}
        ${t.exec_description ? html`<p>${t.exec_description}</p>` : t.task_type === 'checklist' ? '' : html`<p class="muted">Sem descrição de execução registrada.</p>`}
        ${t.exec_notes ? html`<p class="small"><b>Obs.:</b> ${t.exec_notes}</p>` : ''}
        ${t.delivered_date ? html`<div class="small">Entregue em ${fmtDate(t.delivered_date)} ${t.on_time ? '· no prazo' : `· ${t.days_late}d de atraso`}</div>` : ''}
        ${t.review_status ? html`<div class="small">Conferência: <b>${{ pendente: 'pendente', aprovada: 'aprovada', devolvida: 'devolvida' }[t.review_status]}</b>${t.reviewer_name ? ` por ${t.reviewer_name}` : ''}${t.review_comment ? ` — “${t.review_comment}”` : ''}</div>` : ''}</div>
    </div>
    ${photos.length || refs.length ? html`<div class="r-photos">
      ${refs.map(f => html`<figure><img src="/api/files/${f.id}" alt=""><figcaption>Referência${f.caption ? ` · ${f.caption}` : ''}</figcaption></figure>`)}
      ${photos.map(f => html`<figure><img src="/api/files/${f.id}" alt=""><figcaption>Execução · ${fmtDate(f.created_at.slice(0, 10))}${f.caption ? ` · ${f.caption}` : ''}</figcaption></figure>`)}
    </div>` : html`<div class="small muted">Sem imagens anexadas.</div>`}
    ${pdfs.length ? html`<div class="small r-pdfs">${icon('file')} Anexos PDF: ${pdfs.map((f, i) => html`${i ? ' · ' : ''}<a href="/api/files/${f.id}" target="_blank" rel="noopener">${f.original_name || 'documento.pdf'}</a> (${f.kind === 'execucao' ? 'execução' : 'referência'})`)}</div>` : ''}
    ${keyHist.length ? html`<div class="r-hist">${keyHist.map(h => html`<span>${fmtDateTime(h.created_at)} · ${h.user_name || 'Sistema'} · ${h.action}</span>`)}</div>` : ''}
  </article>`;
}

export async function view({ query }) {
  const q = Object.fromEntries(query);
  const r = await api('/reports', { query: q });
  const s = r.summary;
  const title = TYPE_TITLE[r.type];
  const multiProject = r.type !== 'projeto';
  const p = r.scope.project;

  const statsUser = r.user_stats || r.manager_stats;
  const doc = html`
    <article class="doc a4" id="doc">
      <header class="r-header">
        <img src="/assets/logo.webp" alt="Charão Engenharia & Construção" class="r-logo">
        <div class="r-doctype"><div class="r-kicker">${title}</div><div class="r-level">${LEVEL_TITLE[r.level]}</div></div>
      </header>
      <div class="r-rule"></div>
      <section class="r-scope">
        <div><div class="r-lbl">Escopo</div><h1>${r.scope.label}</h1><div class="muted">${r.scope.subtitle}</div></div>
        <dl class="r-meta">
          <dt>Emissão</dt><dd>${fmtDateTime(r.issued_at)}</dd>
          <dt>Emitido por</dt><dd>${r.issued_by}</dd>
          <dt>Data de referência</dt><dd>${fmtDate(r.reference_date)}</dd>
          <dt>Período (prazo)</dt><dd>${r.from || r.to ? `${fmtDate(r.from)} a ${fmtDate(r.to)}` : 'Todos'}</dd>
          <dt>Organização</dt><dd>${ORG_LABEL[r.group] || 'Por status e prazo'}</dd>
          ${r.scope.filters ? html`<dt>Filtros</dt><dd>Os mesmos da tela Tarefas (canceladas não entram)</dd>` : ''}
          ${r.stage_filter.length ? html`<dt>Classificações</dt><dd>${r.stage_filter.join(', ')}</dd>` : ''}
          ${r.kind ? html`<dt>Abrangência</dt><dd>${r.kind === 'interno' ? 'Somente áreas internas' : 'Somente obras'}</dd>` : ''}
          ${!r.include_done ? html`<dt>Filtro</dt><dd>Sem concluídas</dd>` : ''}
        </dl>
      </section>
      ${p ? html`<section class="r-section r-projinfo"><dl class="r-meta r-meta-row">
          <dt>Responsável técnico</dt><dd>${p.lead_name || '—'}</dd><dt>Início</dt><dd>${fmtDate(p.start_date)}</dd>
          <dt>Previsão de término</dt><dd>${fmtDate(p.end_date)}</dd><dt>Status</dt><dd>${{ planejamento: 'Planejamento', em_andamento: 'Em andamento', pausado: 'Pausado', concluido: 'Concluído', cancelado: 'Cancelado' }[p.status]}</dd></dl></section>` : ''}

      <section class="r-section avoid">
        <h3 class="r-h">Resumo executivo</h3>
        ${executiveSummary(r).map(t => html`<p class="r-p">${t}</p>`)}
      </section>

      <section class="r-section avoid">
        <h3 class="r-h">Indicadores principais</h3>
        <div class="r-kpis">
          ${kpiBox('Conclusão', fmtPct(s.completion_pct ?? 0), `${s.done} de ${s.total}`, '#F26B21')}
          ${kpiBox('Total de tarefas', s.total, `${s.due_soon} vencem em 7 dias`)}
          ${kpiBox('Em andamento', s.in_progress, `${s.open} abertas`, STATUS_COLOR.em_andamento)}
          ${kpiBox('Em conferência', s.review, null, STATUS_COLOR.aguardando_conferencia)}
          ${kpiBox('Atrasadas', s.late, s.avg_delay_days ? `média ${String(s.avg_delay_days).replace('.', ',')} d` : null, STATUS_COLOR.atrasada)}
          ${kpiBox('Concluídas', s.done, null, STATUS_COLOR.concluida)}
          ${kpiBox('Entregas no prazo', fmtPct(s.on_time_pct), `${s.on_time} de ${s.delivered}`, STATUS_COLOR.concluida)}
          ${kpiBox('Entregas tardias', s.late_deliveries, null, '#707E8B')}
        </div>
      </section>

      ${statsUser ? html`<section class="r-section avoid"><h3 class="r-h">${r.type === 'equipe' ? 'Indicadores próprios do gestor' : 'Comportamento operacional'}</h3>
        <div class="r-two"><table class="r-table"><tbody>
          <tr><td>Tarefas atribuídas</td><td class="num">${statsUser.assigned}</td></tr>
          <tr><td>Concluídas no prazo</td><td class="num">${statsUser.on_time}</td></tr>
          <tr><td>Pontualidade</td><td class="num"><b>${fmtPct(statsUser.on_time_pct)}</b></td></tr>
          <tr><td>Atrasadas (ativas)</td><td class="num">${statsUser.late}</td></tr>
          <tr><td>Média de atraso</td><td class="num">${String(statsUser.avg_delay_days).replace('.', ',')} dia(s)</td></tr>
          <tr><td>Criadas pelo próprio usuário</td><td class="num">${statsUser.self_created}</td></tr>
          <tr><td>Atribuídas por gestor</td><td class="num">${statsUser.assigned_by_manager}</td></tr></tbody></table>
          <ul class="r-list">${statsUser.behavior.map(b => html`<li>${b}</li>`)}</ul></div></section>` : ''}

      <section class="r-section avoid">
        <h3 class="r-h">Distribuição por status</h3>
        ${statusBars(s.by_status, s.total)}
      </section>

      ${r.by_period.length ? groupTable(`Andamento por ${{ dia: 'dia', semana: 'semana', mes: 'mês' }[r.group]} (pelo prazo)`, r.by_period, { dia: 'Dia', semana: 'Semana', mes: 'Mês' }[r.group]) : ''}
      ${r.group === 'classificacao' || r.by_stage.length > 1 ? groupTable('Andamento por classificação (Grupo/Local/Etapa)', r.by_stage, 'Classificação') : ''}
      ${multiProject ? groupTable('Andamento por projeto', r.by_project, 'Projeto') : ''}
      ${r.type !== 'usuario' ? groupTable('Desempenho por responsável', r.by_person, 'Responsável') : ''}

      ${reschedSection(r)}

      ${r.impact_rank?.length ? html`<section class="r-section avoid"><h3 class="r-h">Atrasos com maior impacto (dependências)</h3>
        <table class="r-table"><thead><tr><th>Código</th><th>Tarefa que causou</th><th>Responsável</th><th class="num">Tarefas impactadas</th><th class="num">Dias-tarefa</th><th class="num">Fim do projeto</th></tr></thead>
        <tbody>${r.impact_rank.map(x => html`<tr><td class="mono nowrap">${x.code}</td><td>${x.title}</td><td class="small">${x.assignee_name || '—'}</td>
          <td class="num">${x.tasks}</td><td class="num"><b>${x.days}</b></td><td class="num">${x.project_end_days ? `+${x.project_end_days} d` : '—'}</td></tr>`)}</tbody></table>
        <p class="small muted" style="margin-top:4px">Quando uma tarefa atrasa, as que dependem dela são empurradas sem penalização: o atraso e o impacto contam só para a causa. Dias-tarefa = soma dos dias empurrados.</p></section>` : ''}

      ${r.critical.length ? html`<section class="r-section avoid"><h3 class="r-h">Pontos de atenção — tarefas atrasadas</h3>
        <table class="r-table"><thead><tr><th>Código</th><th>Tarefa</th><th>Responsável</th><th>Prazo</th><th class="num">Atraso</th></tr></thead>
        <tbody>${r.critical.map(t => html`<tr><td class="mono nowrap">${t.code}</td><td>${t.title}</td><td class="small">${t.assignee_name || '—'}</td><td class="nowrap small">${fmtDate(t.due_date)}</td><td class="num late">${t.days_late} d</td></tr>`)}</tbody></table></section>` : ''}

      ${r.gantt && r.gantt_tasks.length ? html`<section class="r-section r-gantt">
        <h3 class="r-h">Cronograma das tarefas (Gantt) <span class="muted small">(${r.gantt_tasks.length})</span></h3>
        ${ganttChart(r.gantt_tasks, { ref: r.reference_date, groupLabel: groupLabelFor(r.group, multiProject) || (t => stageLabel(t, multiProject)), showProject: multiProject })}
      </section>` : ''}

      ${r.level !== 'resumo' ? html`<section class="r-section ${r.gantt ? 'r-after-gantt' : ''}">
        <h3 class="r-h">Detalhamento das tarefas <span class="muted small">(${r.tasks.length})</span>${groupLabelFor(r.group, multiProject) ? html` <span class="muted small">· ${ORG_LABEL[r.group].toLowerCase()}</span>` : ''}</h3>
        ${r.tasks.length ? taskTable(r.tasks, multiProject, groupLabelFor(r.group, multiProject), r.group === 'classificacao') : html`<p class="muted">Sem tarefas no escopo.</p>`}
      </section>` : ''}

      ${r.level === 'completo' ? html`<section class="r-section r-break">
        <h3 class="r-h">Registros e comprovações</h3>
        ${r.tasks.filter(t => t.files.length || t.exec_description || t.review_status).map(evidence)}
        ${!r.tasks.some(t => t.files.length || t.exec_description) ? html`<p class="muted">Nenhuma comprovação registrada.</p>` : ''}
      </section>` : ''}

      <section class="r-section r-sign avoid">
        <div><span></span>Responsável pela emissão</div>
        <div><span></span>Responsável técnico / Gestor</div>
      </section>
      <footer class="r-footer">
        <span>Charão Engenharia & Construção · ${title} · ${r.scope.label}</span>
        <span>Emitido em ${fmtDateTime(r.issued_at)} por ${r.issued_by} · Documento gerado pelo sistema Charão Gestão de Obras</span>
      </footer>
    </article>`;

  // Relatório de tarefas: volta para a lista com os mesmos filtros
  const TASK_KEYS = ['q', 'status', 'project', 'assignee', 'priority', 'due', 'kind', 'stage', 'nivel', 'tipo'];
  const taskQs = () => {
    const u = new URLSearchParams();
    for (const k of TASK_KEYS) for (const v of String(q[k] || '').split(',').filter(Boolean)) u.append(k, v);
    if (['dia', 'semana', 'mes'].includes(r.group)) u.set('org', r.group);
    return u.toString();
  };
  const back = r.type === 'projeto' ? `#/projetos/${q.id}` : r.type === 'usuario' || r.type === 'equipe' ? `#/usuarios/${q.id}`
    : r.type === 'tarefas' ? `#/tarefas?${taskQs()}` : '#/relatorios';
  return {
    title: `${title} · ${r.scope.label}`,
    html: html`${printToolbar({
      back, title: `${title} — ${r.scope.label}`,
      extra: html`<label class="pt-opt">Nível <select id="lvl">${Object.entries(LEVEL_TITLE).map(([k, l]) => html`<option value="${k}" ${r.level === k ? 'selected' : ''}>${l}</option>`)}</select></label>
        <label class="pt-opt">Organizar <select id="grp">${Object.entries(ORG_LABEL).map(([k, l]) => html`<option value="${k}" ${r.group === k ? 'selected' : ''}>${l}</option>`)}</select></label>
        <label class="pt-opt"><input type="checkbox" id="gnt" ${r.gantt ? 'checked' : ''}>Gantt</label>
        ${r.type === 'tarefas' ? html`<a class="btn btn-ghost btn-sm" href="${back}">${icon('filter')}Alterar filtros</a>`
          : html`<a class="btn btn-ghost btn-sm" href="#/relatorios?type=${r.type}&id=${q.id || ''}&level=${r.level}&group=${r.group}${r.gantt ? '' : '&gantt=0'}">${icon('edit')}Configurar</a>`}`,
    })}<div class="doc-stage">${doc}</div>`,
    mount(root, ctx) {
      setPageFooter(`Charão · ${title} · ${r.scope.label}`);
      drawGanttLinks(root);
      bindPrintToolbar(root);
      root.querySelector('#lvl').addEventListener('change', e => {
        ctx.setQuery({ ...q, level: e.target.value });
        ctx.render();
      });
      root.querySelector('#grp').addEventListener('change', e => { ctx.setQuery({ ...q, group: e.target.value }); ctx.render(); });
      root.querySelector('#gnt').addEventListener('change', e => { ctx.setQuery({ ...q, gantt: e.target.checked ? '' : '0' }); ctx.render(); });
    },
  };
}
