// Planejamento da semana na tela do usuário: tarefas por dia (prazo), criação rápida já direcionada a um projeto,
// e definição de data para tarefas sem prazo — tudo sem sair da tela.
import { html, api, icon, todayISO, fmtDate, PRIORITY, PROOF, STATUS } from '../core.js';
import { toast, sheet } from '../ui.js';
import { STATUS_COLOR, doneToggle } from './shared.js';

const DOW = ['Dom', 'Seg', 'Ter', 'Qua', 'Qui', 'Sex', 'Sáb'];
const iso = d => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
const parse = s => { const [y, m, d] = s.split('-').map(Number); return new Date(y, m - 1, d); };
const addDays = (s, n) => { const d = parse(s); d.setDate(d.getDate() + n); return iso(d); };
// Segunda-feira da semana de uma data
export const mondayOf = s => { const d = parse(s); return addDays(s, -((d.getDay() + 6) % 7)); };

const open = t => t.status !== 'concluida' && !t.cancelled_at;

// Período da tarefa no calendário: início previsto → prazo (sem início, só o dia do prazo)
const spanOf = t => {
  const due = t.due_date;
  const begin = t.start_date && t.start_date <= due ? t.start_date : due;
  return { begin, due };
};
const dm = s => `${s.slice(8, 10)}/${s.slice(5, 7)}`;

// Parcela do dia: o período (início → prazo) é dividido igualmente entre os dias úteis (seg–sex; se só houver
// fim de semana, todos os dias). O avanço informado cobre as parcelas em ordem: parcela coberta = card verde,
// parcela coberta em parte = card preenchido proporcionalmente.
function dayShare(t, day) {
  const pct = ['concluida', 'aguardando_conferencia'].includes(t.eff_status) ? 100 : t.progress_pct;
  if (pct === null || pct === undefined || !t.due_date) return null;
  const sp = spanOf(t);
  const all = [];
  for (let x = sp.begin; x <= sp.due; x = addDays(x, 1)) all.push(x);
  const weekday = x => { const g = parse(x).getDay(); return g > 0 && g < 6; };
  const work = all.some(weekday) ? all.filter(weekday) : all;
  const n = work.length;
  const upTo = work.filter(x => x <= day).length;
  const before = work.filter(x => x < day).length;
  const from = (before / n) * 100;
  const to = (upTo / n) * 100;
  const fill = to <= from ? (pct >= to ? 1 : 0) : Math.max(0, Math.min(1, (pct - from) / (to - from)));
  return { pct, fill, share: work.includes(day) ? Math.round(100 / n) : 0, upto: Math.round(to) };
}

// day: dia da coluna — marca início, continuação e prazo das tarefas de vários dias
const chip = (t, day) => {
  const sp = day && t.due_date ? spanOf(t) : null;
  const multi = sp && sp.begin !== sp.due;
  const tag = !multi ? '' : day === sp.begin ? `início · até ${dm(sp.due)}` : day === sp.due ? `prazo · desde ${dm(sp.begin)}` : `continua · até ${dm(sp.due)}`;
  const part = !multi ? '' : day === sp.begin ? 'is-first' : day === sp.due ? 'is-last' : 'is-mid';
  const sh = day ? dayShare(t, day) : null;
  const shCls = !sh ? '' : sh.fill >= 1 ? 'is-share-done' : sh.fill > 0 ? 'is-share-part' : 'is-share-todo';
  const shTip = sh ? ` · executado ${sh.pct}%${sh.share ? ` · parcela do dia ${sh.share}% (acumulado até o dia ${sh.upto}%)` : ''}${sh.fill >= 1 ? ' · parcela feita' : ''}` : '';
  return html`<a ${t.status === 'concluida' ? 'data-done' : ''} style="--fill:${sh ? Math.round(sh.fill * 100) : 0}%" class="wp-task ${shCls} ${part} ${t.status === 'concluida' ? 'is-done' : ''} ${t.eff_status === 'atrasada' ? 'is-late' : ''}" href="#/tarefas/${t.id}" title="${t.code} · ${t.title} · ${multi ? `${fmtDate(sp.begin)} → ${fmtDate(sp.due)} · ` : ''}${STATUS[t.eff_status]?.label || ''}${shTip}">
  <span class="dot" style="--c:${STATUS_COLOR[t.eff_status] || '#9AA3AD'}"></span>
  <span class="wp-txt"><b>${t.title}</b><small><span class="mono">${t.code}</span>${tag ? html` · <em>${tag}</em>` : ''}</small>
    ${sh ? html`<small class="wp-share">${sh.fill >= 1 ? '✓ parcela feita' : sh.fill > 0 ? `parcela ${Math.round(sh.fill * 100)}% feita` : 'parcela a fazer'} · ${sh.pct}% executado</small>` : ''}</span></a>`;
};

export function weekPlanSection(d, { week, canPlan, firstName }) {
  const today = todayISO();
  const start = week || mondayOf(today);
  const days = Array.from({ length: 7 }, (_, i) => addDays(start, i));
  const end = days[6];
  const tasks = d.tasks.filter(t => !t.cancelled_at);
  // A tarefa aparece em todos os dias do período (início → prazo); prazo do dia primeiro
  const dated = tasks.filter(t => t.due_date);
  const byDay = new Map(days.map(x => [x, dated.filter(t => { const sp = spanOf(t); return sp.begin <= x && x <= sp.due; })
    .sort((a, b) => (a.due_date === x ? 0 : 1) - (b.due_date === x ? 0 : 1) || a.due_date.localeCompare(b.due_date) || a.code.localeCompare(b.code))]));
  const inWeek = new Set(days.flatMap(x => byDay.get(x).filter(open).map(t => t.id)));
  const late = tasks.filter(t => open(t) && t.eff_status === 'atrasada' && t.due_date < start);
  const undated = tasks.filter(t => open(t) && !t.due_date);
  const label = `${fmtDate(start)} a ${fmtDate(end)}`;

  const dayCol = x => {
    const dt = parse(x);
    const list = byDay.get(x);
    const weekend = dt.getDay() === 0 || dt.getDay() === 6;
    return html`<div class="wp-day ${x === today ? 'is-today' : ''} ${weekend ? 'is-weekend' : ''} ${x < today ? 'is-past' : ''}" data-day="${x}">
      <div class="wp-day-head"><span><b>${DOW[dt.getDay()]}</b> ${String(dt.getDate()).padStart(2, '0')}/${String(dt.getMonth() + 1).padStart(2, '0')}</span>
        ${list.length ? html`<span class="n">${list.length}</span>` : ''}</div>
      <div class="wp-list">${list.map(t => chip(t, x))}</div>
      ${canPlan ? html`<button type="button" class="wp-add" data-wp-add="${x}" aria-label="Nova tarefa para ${fmtDate(x)}">${icon('plus')}<span>Tarefa</span></button>` : ''}
    </div>`;
  };

  return html`<section class="card section week-plan" id="week-plan">
    <div class="card-head"><h2>${icon('calendar')}Planejamento da semana</h2>
      <span class="sub">${inWeek.size} tarefa(s) em aberto de ${firstName} nesta semana</span></div>
    <div class="card-body">
      <div class="wp-bar">
        <div class="wp-nav">
          <button type="button" class="btn btn-ghost btn-sm" data-wp-week="${addDays(start, -7)}" aria-label="Semana anterior">‹</button>
          <b class="wp-label">${label}</b>
          <button type="button" class="btn btn-ghost btn-sm" data-wp-week="${addDays(start, 7)}" aria-label="Próxima semana">›</button>
          ${start !== mondayOf(today) ? html`<button type="button" class="btn btn-ghost btn-sm" data-wp-week="">Esta semana</button>` : ''}
        </div>
        ${doneToggle(new Set(days.flatMap(x => byDay.get(x).filter(t => t.status === 'concluida').map(t => t.id))).size)}
        ${canPlan ? html`<button type="button" class="btn btn-accent btn-sm" data-wp-add="${days.includes(today) ? today : start}">${icon('plus')}Nova tarefa</button>` : ''}
      </div>
      <div class="wp-grid">${days.map(dayCol)}</div>
      ${late.length ? html`<details class="wp-extra wp-late"><summary>Atrasadas de semanas anteriores <span class="n">${late.length}</span></summary>
        <p class="muted wp-hint">Para trazer uma atrasada para esta semana, abra a tarefa e use <b>Reagendar</b> (pede a justificativa).</p>
        <div class="wp-list wp-list-row">${late.map(t => html`<div class="wp-row">${chip(t)}<span class="muted">venceu ${fmtDate(t.due_date)}</span></div>`)}</div></details>` : ''}
      ${undated.length ? html`<details class="wp-extra" ${canPlan ? 'open' : ''}><summary>Sem prazo — planeje um dia <span class="n">${undated.length}</span></summary>
        <div class="wp-list wp-list-row">${undated.map(t => html`<div class="wp-row">${chip(t)}
          ${canPlan ? html`<label class="wp-date"><span class="sr-only">Prazo de ${t.title}</span><input type="date" data-wp-due="${t.id}" min="${t.start_date || ''}" value=""></label>` : ''}</div>`)}</div></details>` : ''}
    </div></section>`;
}

// Criação rápida: título, projeto, classificação, datas, prioridade e comprovação — responsável = o usuário da tela
async function quickAdd({ day, user, projects, meta }) {
  if (!projects.length) return toast(`${user.name.split(' ')[0]} não tem projeto liberado em andamento para receber tarefas.`, 'warn');
  const last = (() => { try { return sessionStorage.getItem('charao-wp-project') || ''; } catch { return ''; } })();
  const pid = projects.some(p => String(p.id) === last) ? last : String(projects[0].id);
  const stagesOf = id => meta.projects.find(p => String(p.id) === String(id))?.stages || [];
  const stageOpts = id => stagesOf(id).map(s => html`<option value="${s.is_default ? '' : s.id}">${s.name}</option>`);
  const created = await sheet({
    title: `Nova tarefa para ${user.name.split(' ')[0]}`,
    submitLabel: 'Criar tarefa',
    body: html`<div class="form">
      <div class="field"><label class="req" for="wp-title">Título</label><input id="wp-title" name="title" type="text" maxlength="160" required placeholder="O que precisa ser feito"></div>
      <div class="form-row">
        <div class="field"><label class="req" for="wp-project">Projeto</label><select id="wp-project" name="project_id">${projects.map(p => html`<option value="${p.id}" ${String(p.id) === pid ? 'selected' : ''}>${p.code} · ${p.name}</option>`)}</select></div>
        <div class="field"><label for="wp-stage">Classificação</label><select id="wp-stage" name="stage_id">${stageOpts(pid)}</select></div>
      </div>
      <div class="form-row">
        <div class="field"><label for="wp-start">Início</label><input id="wp-start" name="start_date" type="date" value="${day}"></div>
        <div class="field"><label for="wp-due">Prazo</label><input id="wp-due" name="due_date" type="date" value="${day}"></div>
      </div>
      <div class="form-row">
        <div class="field"><label for="wp-prio">Prioridade</label><select id="wp-prio" name="priority">${Object.entries(PRIORITY).map(([k, l]) => html`<option value="${k}" ${k === 'media' ? 'selected' : ''}>${l}</option>`)}</select></div>
        <div class="field"><label for="wp-proof">Comprovação na entrega</label><select id="wp-proof" name="proof_type">${Object.entries(PROOF).map(([k, p]) => html`<option value="${k}" ${k === 'foto' ? 'selected' : ''}>${p.label || p}</option>`)}</select></div>
      </div>
      <div class="field"><label for="wp-desc">Descrição</label><textarea id="wp-desc" name="description" maxlength="5000" rows="3" placeholder="Opcional — se ficar em branco, usa o título"></textarea></div>
      <span class="hint">Responsável: <b>${user.name}</b>. Para anexos, check-list ou subtarefas, abra a tarefa depois de criada.</span>
    </div>`,
    onSubmit: async data => {
      const title = (data.title || '').trim();
      if (!title) throw new Error('Informe o título.');
      const body = { ...data, title, description: (data.description || '').trim() || title, assignee_id: user.id };
      if (!body.start_date) delete body.start_date;
      if (!body.due_date) delete body.due_date;
      const r = await api('/tasks', { method: 'POST', body });
      try { sessionStorage.setItem('charao-wp-project', String(data.project_id)); } catch { /* sem armazenamento */ }
      return r;
    },
  });
  return created;
}

export function bindWeekPlan(root, { d, user, meta, week, setWeek, render }) {
  const box = root.querySelector('#week-plan');
  if (!box) return;
  box.querySelectorAll('[data-wp-week]').forEach(b => b.addEventListener('click', () => { setWeek(b.dataset.wpWeek); render(); }));
  box.querySelectorAll('[data-wp-add]').forEach(b => b.addEventListener('click', async () => {
    // O formulário é montado na hora (sheet); a classificação acompanha o projeto escolhido
    const pending = quickAdd({ day: b.dataset.wpAdd, user, projects: d.plan_projects || [], meta });
    const ps = document.querySelector('#wp-project');
    ps?.addEventListener('change', () => {
      const st = document.querySelector('#wp-stage');
      const stages = meta.projects.find(p => String(p.id) === ps.value)?.stages || [];
      st.replaceChildren(...stages.map(s => new Option(s.name, s.is_default ? '' : s.id)));
    });
    const r = await pending;
    if (r?.id) { toast('Tarefa criada.'); render(); }
  }));
  box.querySelectorAll('[data-wp-due]').forEach(inp => inp.addEventListener('change', async () => {
    if (!inp.value) return;
    try {
      await api(`/tasks/${inp.dataset.wpDue}`, { method: 'PATCH', body: { due_date: inp.value } });
      toast(`Prazo definido para ${fmtDate(inp.value)}.`);
      setWeek(mondayOf(inp.value) === mondayOf(todayISO()) ? '' : mondayOf(inp.value));
      render();
    } catch (ex) { toast(ex.message, 'err'); inp.value = ''; }
  }));
}
