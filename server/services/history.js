// História do projeto: reúne tarefas, prazos, registros (atas, definições, ocorrências…) e medições numa
// narrativa cronológica — capítulos por mês, situação atual e definições vigentes.
import { all, one } from '../db.js';
import { notFound } from '../lib/http.js';
import { canAccessProject } from '../lib/permissions.js';
import { listVisible } from './tasks.js';
import { summarize, today, localDate, daysBetween } from './metrics.js';
import { listRecords } from './records.js';

const MONTHS = ['janeiro', 'fevereiro', 'março', 'abril', 'maio', 'junho', 'julho', 'agosto', 'setembro', 'outubro', 'novembro', 'dezembro'];
const monthLabel = ym => `${MONTHS[Number(ym.slice(5, 7)) - 1]} de ${ym.slice(0, 4)}`;
const fmtD = d => (d ? d.split('-').reverse().join('/') : '—');
const dm = d => fmtD(d).slice(0, 5);
const pctTxt = v => (v === null || v === undefined ? '—' : `${String(v).replace('.', ',')}%`);
const plural = (n, s, p) => `${n} ${n === 1 ? s : p}`;
const joinPt = list => (list.length <= 1 ? list.join('') : `${list.slice(0, -1).join(', ')} e ${list.at(-1)}`);
const endDot = t => `${String(t).trim().replace(/[.!?…:;,]+$/, '')}.`;
const lowerFirst = t => t.charAt(0).toLowerCase() + t.slice(1);
const STATUS_PROJ = { planejamento: 'em planejamento', em_andamento: 'em andamento', pausado: 'pausado', concluido: 'concluído', cancelado: 'cancelado' };

export function projectHistory(ctx, id) {
  const p = one(`SELECT p.*, l.name AS lead_name, pt.name AS type_name FROM projects p LEFT JOIN users l ON l.id = p.lead_id
    LEFT JOIN project_types pt ON pt.id = p.type_id WHERE p.id = ?`, id);
  if (!p || !canAccessProject(ctx.user, p.id, ctx.projects)) throw notFound('Projeto não encontrado.');
  const ref = today();
  const tasks = listVisible(ctx, 'WHERE t.project_id = ?', id);
  const s = summarize(tasks, ref);
  const rec = listRecords(ctx, id);
  const records = rec.records.filter(r => r.in_report && !['cancelada', 'reprovada', 'rascunho'].includes(r.status))
    .sort((a, b) => a.record_date.localeCompare(b.record_date) || a.id - b.id);
  const ids = tasks.map(t => t.id);
  const resch = ids.length ? all(`SELECT r.task_id, r.old_due, r.new_due, r.reason_name, r.created_at FROM task_reschedules r
    WHERE r.task_id IN (${ids.map(() => '?').join(',')}) ORDER BY r.id`, ...ids) : [];
  const measurements = ctx.user.can_contracts ? all(`SELECT m.code, m.ref_month, m.status, m.issued_at, m.nf_date, m.paid_date, c.code AS contract_code
    FROM measurements m JOIN contracts c ON c.id = m.contract_id WHERE c.project_id = ? AND m.status != 'rascunho' ORDER BY m.issued_at`, id) : [];

  // ---------- Eventos (linha do tempo) ----------
  const events = [];
  const ev = (date, kind, title, detail = '', color = '#2A3D50', extra = {}) => { if (date) events.push({ date, kind, title, detail, color, ...extra }); };
  ev(localDate(p.created_at), 'projeto', 'Projeto cadastrado no sistema', `${p.code} · ${p.name}`);
  if (p.start_date && p.start_date <= ref) ev(p.start_date, 'projeto', 'Início previsto do projeto', '');
  if (p.actual_end_date) ev(p.actual_end_date, 'projeto', 'Término real do projeto', '', '#1F6B41');
  for (const t of tasks) {
    if (t.delivered && t.delivered_date && t.status === 'concluida') ev(t.delivered_date, 'conclusao', `${t.code} concluída`, t.title, t.on_time ? '#1F6B41' : '#C0392B', { on_time: t.on_time, task_id: t.id, main: !t.parent_id });
  }
  for (const r of resch) {
    const t = tasks.find(x => x.id === r.task_id);
    ev(localDate(r.created_at), 'reagendamento', `${t.code} reagendada`, `${fmtD(r.old_due)} → ${fmtD(r.new_due)} · ${r.reason_name}`, '#B7950B', { reason: r.reason_name });
  }
  for (const r of records) {
    ev(r.record_date, 'registro', `${r.code ? `${r.code} · ` : ''}${r.title}`, r.type_name, r.color, { record: r });
  }
  for (const m of measurements) ev(localDate(m.issued_at), 'medicao', `Medição ${m.code} emitida`, `referência ${m.ref_month.slice(5)}/${m.ref_month.slice(0, 4)}`, '#2A78D6');
  // Classificações (Grupo/Local/Etapa) concluídas
  const byStage = new Map();
  for (const t of tasks) { if (!byStage.has(t.stage_id)) byStage.set(t.stage_id, []); byStage.get(t.stage_id).push(t); }
  for (const [, list] of byStage) {
    if (list.length < 2 || list[0].stage_default || !list.every(t => t.status === 'concluida' && t.delivered_date)) continue;
    ev(list.map(t => t.delivered_date).sort().at(-1), 'etapa', `Classificação "${list[0].stage_name}" concluída`, plural(list.length, 'tarefa', 'tarefas'), '#1F6B41', { stage: list[0].stage_name });
  }
  events.sort((a, b) => a.date.localeCompare(b.date));

  // ---------- Capítulos por mês ----------
  const first = [localDate(p.created_at), p.start_date && p.start_date <= ref ? p.start_date : null, events[0]?.date, ...tasks.map(t => localDate(t.created_at))]
    .filter(Boolean).sort()[0] || ref;
  const months = [];
  for (let [y, m] = first.slice(0, 7).split('-').map(Number); `${y}-${String(m).padStart(2, '0')}` <= ref.slice(0, 7); m === 12 ? (m = 1, y++) : m++) months.push(`${y}-${String(m).padStart(2, '0')}`);
  const chapters = months.map(ym => {
    const inM = d => d && d.startsWith(ym);
    const created = tasks.filter(t => inM(localDate(t.created_at)));
    const done = tasks.filter(t => t.status === 'concluida' && inM(t.delivered_date));
    const onTime = done.filter(t => t.on_time).length;
    const rs = resch.filter(r => inM(localDate(r.created_at)));
    const recs = records.filter(r => inM(r.record_date));
    const evs = events.filter(e => inM(e.date));
    const par = [];
    const projEvents = evs.filter(e => e.kind === 'projeto');
    if (projEvents.length) par.push(endDot(projEvents.map((e, k) => `${k ? lowerFirst(e.title) : e.title} em ${fmtD(e.date)}`).join('; ')));
    if (created.length || done.length) {
      par.push(`Em ${monthLabel(ym)}, ${created.length ? `${plural(created.length, 'tarefa foi aberta', 'tarefas foram abertas')}` : 'nenhuma tarefa nova foi aberta'}`
        + `${done.length ? ` e ${plural(done.length, 'foi concluída', 'foram concluídas')}${done.length ? ` (${onTime === done.length ? 'todas no prazo' : `${onTime} no prazo, ${done.length - onTime} com atraso`})` : ''}` : ', sem conclusões no período'}.`);
      const big = done.filter(t => !t.parent_id).slice(0, 4).map(t => `“${t.title}”`);
      if (big.length) par.push(`Entre as entregas do mês: ${joinPt(big)}${done.filter(t => !t.parent_id).length > 4 ? ', entre outras' : ''}.`);
    } else if (!recs.length) {
      par.push(`Em ${monthLabel(ym)}, não houve movimentação de tarefas registrada.`);
    }
    const stages = evs.filter(e => e.kind === 'etapa');
    if (stages.length) par.push(`${stages.length === 1 ? 'Foi concluída a classificação' : 'Foram concluídas as classificações'} ${joinPt(stages.map(e => `“${e.stage}”`))}.`);
    for (const r of recs) {
      if (r.behavior === 'reuniao') {
        const names = r.participants.map(x => x.name).slice(0, 6);
        const c = r.item_counts || {};
        par.push(`Em ${dm(r.record_date)}, foi realizada a reunião ${r.code || ''} — “${r.title}”${r.location ? `, em ${r.location}` : ''}${names.length ? `, com ${joinPt(names)}${r.participants.length > 6 ? ' e outros' : ''}` : ''}.`
          + (c.definicao || c.demanda ? ` Dela saíram ${joinPt([c.definicao ? plural(c.definicao, 'definição', 'definições') : '', c.demanda ? `${plural(c.demanda, 'demanda encaminhada', 'demandas encaminhadas')} como tarefa` : ''].filter(Boolean))}.` : ''));
      } else if (r.behavior === 'decisao') {
        const pending = r.status === 'aguardando_aprovacao';
        par.push(`${dm(r.record_date)} — ${r.type_name}${r.code ? ` ${r.code}` : ''}: ${pending ? 'foi proposto' : 'ficou definido'} “${r.title}”`
          + `${r.source_code ? ` na reunião ${r.source_code}` : r.decided_by ? ` (por ${r.decided_by})` : ''}${r.replaces_code ? `, substituindo ${r.replaces_code}` : ''}`
          + `${r.status === 'substituida' ? `; depois substituída por ${r.replaced_by_code}` : ''}${pending ? ' — aguardando aprovação' : ''}.`);
      } else if (r.behavior === 'pendencia') {
        const st = { resolvida: 'já resolvida', atrasada: 'em atraso', aberta: 'em aberto', aguardando_aprovacao: 'aguardando aprovação', cancelada: 'cancelada' }[r.eff_status] || '';
        par.push(`${dm(r.record_date)} — ${r.type_name}${r.code ? ` ${r.code}` : ''}: “${r.title}”${r.decided_by ? `, solicitada por ${r.decided_by}` : ''}${r.assignee_name ? `, encaminhada a ${r.assignee_name}` : ''}${r.due_date ? ` com prazo em ${fmtD(r.due_date)}` : ''}${st ? ` — ${st}` : ''}.`);
      } else {
        const first = r.body ? r.body.split(/\r?\n/)[0] : '';
        par.push(`${dm(r.record_date)} — ${r.type_name}${r.code ? ` ${r.code}` : ''}: ${endDot(r.title)}${first ? ` ${first.length > 220 ? `${first.slice(0, 220)}…` : endDot(first)}` : ''}`);
      }
    }
    if (rs.length) {
      const reasons = {};
      for (const r of rs) reasons[r.reason_name] = (reasons[r.reason_name] || 0) + 1;
      const top = Object.entries(reasons).sort((a, b) => b[1] - a[1]);
      par.push(`Houve ${plural(rs.length, 'reagendamento de prazo', 'reagendamentos de prazo')}${top.length ? `, principalmente por “${top[0][0]}”` : ''}.`);
    }
    const ms = evs.filter(e => e.kind === 'medicao');
    if (ms.length) par.push(`${ms.length === 1 ? 'Foi emitida a medição' : 'Foram emitidas as medições'} ${joinPt(ms.map(e => e.title.replace('Medição ', '').replace(' emitida', '')))}.`);
    return { ym, label: monthLabel(ym), paragraphs: par, counts: { created: created.length, done: done.length, on_time: onTime, reschedules: rs.length, records: recs.length }, events: evs.map(({ record, ...e }) => e) };
  });

  // ---------- Abertura e situação atual ----------
  const intro = [];
  intro.push(`O projeto ${p.code} — ${p.name}${p.type_name ? ` (${p.type_name.toLowerCase()})` : ''}, do cliente ${p.client}${p.location ? `, em ${p.location}` : ''}, `
    + `${p.start_date ? `tem início previsto em ${fmtD(p.start_date)}` : 'não tem data de início informada'}${p.end_date ? ` e término previsto em ${fmtD(p.end_date)}` : ''}`
    + `${p.lead_name ? `, sob responsabilidade técnica de ${p.lead_name}` : ''}.`);
  if (p.description) intro.push(`Escopo: ${p.description.split(/\r?\n/)[0].slice(0, 400)}`);
  intro.push(`Esta história reúne, em ordem cronológica, as tarefas, os prazos, as reuniões, as definições e os demais registros do projeto até ${fmtD(ref)}.`);

  const elapsed = p.start_date && p.end_date && p.end_date > p.start_date
    ? Math.max(0, Math.min(100, Math.round((daysBetween(p.start_date, ref) / daysBetween(p.start_date, p.end_date)) * 100))) : null;
  const open = tasks.filter(t => !t.delivered);
  const late = open.filter(t => t.eff_status === 'atrasada').sort((a, b) => b.days_late - a.days_late);
  const upcoming = open.filter(t => t.eff_status !== 'atrasada' && t.due_date && t.due_date <= addDaysIso(ref, 15)).sort((a, b) => a.due_date.localeCompare(b.due_date));
  const vigentes = rec.records.filter(r => r.behavior === 'decisao' && r.status === 'vigente').sort((a, b) => a.record_date.localeCompare(b.record_date));
  const pend = rec.records.filter(r => r.behavior === 'pendencia' && ['aberta', 'atrasada', 'aguardando_aprovacao'].includes(r.eff_status));
  const current = [];
  current.push(`Situação em ${fmtD(ref)}: projeto ${STATUS_PROJ[p.status] || p.status}, com ${plural(s.total, 'tarefa', 'tarefas')}, das quais ${s.done} concluída${s.done === 1 ? '' : 's'} (${pctTxt(s.completion_pct ?? 0)})`
    + `${elapsed !== null ? `, para ${elapsed}% do prazo decorrido` : ''}.`);
  if (s.delivered) current.push(`Das ${s.delivered} entregas, ${s.on_time} ocorreram no prazo vigente (${pctTxt(s.on_time_pct)})${s.on_time_original_pct !== null ? ` e ${pctTxt(s.on_time_original_pct)} no prazo original` : ''}.`);
  current.push(late.length ? `Há ${plural(late.length, 'tarefa atrasada', 'tarefas atrasadas')}, a mais antiga com ${late[0].days_late} dia(s) de atraso.` : 'Não há tarefas atrasadas.');
  if (upcoming.length) current.push(`${plural(upcoming.length, 'tarefa vence', 'tarefas vencem')} nos próximos 15 dias.`);
  if (pend.length || rec.summary.open) current.push(`Pendências de registros em aberto: ${rec.summary.open} (${rec.summary.late} em atraso).`);
  if (vigentes.length) current.push(`${plural(vigentes.length, 'definição está vigente', 'definições estão vigentes')} no projeto.`);

  return {
    project: { id: p.id, code: p.code, name: p.name, client: p.client, location: p.location, status: p.status, type_name: p.type_name, lead_name: p.lead_name,
      start_date: p.start_date, end_date: p.end_date, actual_end_date: p.actual_end_date },
    ref, summary: s, elapsed, intro, chapters, current,
    vigentes: vigentes.map(r => ({ id: r.id, code: r.code, title: r.title, record_date: r.record_date, origin: r.origin || r.source_code || '', decided_by: r.decided_by, replaces_code: r.replaces_code, type_name: r.type_name })),
    pendencias: [
      ...pend.map(r => ({ code: r.code, title: r.title, type_name: r.type_name, assignee_name: r.assignee_name, due_date: r.due_date, status: r.eff_status, task_code: r.task_code })),
    ],
    late: late.slice(0, 10).map(t => ({ code: t.code, title: t.title, assignee_name: t.assignee_name, due_date: t.due_date, days_late: t.days_late })),
    upcoming: upcoming.slice(0, 10).map(t => ({ code: t.code, title: t.title, assignee_name: t.assignee_name, due_date: t.due_date })),
    counts: Object.entries(records.reduce((a, r) => ({ ...a, [r.type_name]: (a[r.type_name] || 0) + 1 }), {})).map(([name, n]) => ({ name, n, color: records.find(r => r.type_name === name).color })),
    timeline: events.map(({ record, ...e }) => e),
  };
}

const addDaysIso = (d, n) => new Date(Date.parse(d) + n * 86400e3).toISOString().slice(0, 10);
