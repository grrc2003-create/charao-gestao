// Relatório A4 do check-list (termo de vistoria): resumo com as não conformidades por ambiente e lista única de itens
// (agrupada por grupo, responsável e data em até 3 níveis), com histórico e fotos quando houver, assinaturas e,
// ao final, o cronograma semanal (Gantt) dos itens.
import { html, api, STATUS, fmtDate, fmtDateTime, fmtPct } from '../core.js';
import { printToolbar, bindPrintToolbar, setPageFooter } from './print-common.js';
import { RESULT, PHOTO_RULE, matchItem, filterOptions, optLabel } from './checklist-ui.js';
import { periodKey, periodInfo } from './periods.js';
import { ganttChart } from './gantt.js';

// Dimensões de agrupamento (combináveis em até 3 níveis). Data = prazo do item.
// Especialidades na ordem do modelo da obra (definida a cada relatório); fora do modelo depois e "Sem especialidade" por último
let SPEC_ORDER = [];
const specRank = k => (!k ? 1e6 : SPEC_ORDER.includes(k) ? SPEC_ORDER.indexOf(k) : 1e5);
const DIMS = {
  grupo: { label: 'Grupo', key: i => i.group || '', name: k => k || 'Sem grupo' },
  especialidade: { label: 'Especialidade', key: i => i.specialty || '', name: k => k || 'Sem especialidade', sort: (a, b) => specRank(a) - specRank(b) || a.localeCompare(b, 'pt-BR') },
  responsavel: { label: 'Responsável', key: i => i.responsible_name || '', name: k => k || 'Sem responsável', sort: (a, b) => a.localeCompare(b, 'pt-BR') },
  dia: { label: 'Data (dia)', key: i => periodKey(i.due_date, 'dia'), name: k => periodInfo(k, 'dia').label, sort: (a, b) => a.localeCompare(b) },
  semana: { label: 'Data (semana)', key: i => periodKey(i.due_date, 'semana'), name: k => periodInfo(k, 'semana').label, sort: (a, b) => a.localeCompare(b) },
  mes: { label: 'Data (mês)', key: i => periodKey(i.due_date, 'mes'), name: k => periodInfo(k, 'mes').label, sort: (a, b) => a.localeCompare(b) },
};
const DATE_DIMS = ['dia', 'semana', 'mes'];

// Níveis escolhidos (?g1=&g2=&g3=): sem repetir dimensão e com no máximo uma de data. Padrão: por grupo.
function readLevels(query) {
  const raw = query.has('g1') ? ['g1', 'g2', 'g3'].map(k => query.get(k)).filter(Boolean) : ['grupo'];
  const out = [];
  for (const d of raw) {
    if (!DIMS[d] || out.includes(d)) continue;
    if (DATE_DIMS.includes(d) && out.some(x => DATE_DIMS.includes(x))) continue;
    out.push(d);
  }
  return out;
}

// Agrupa mantendo a ordem dos itens (grupo) ou ordenando (responsável e datas; "Sem prazo" por último)
function groupBy(items, dim) {
  const m = new Map();
  for (const i of items) {
    const k = DIMS[dim].key(i);
    if (!m.has(k)) m.set(k, []);
    m.get(k).push(i);
  }
  const keys = [...m.keys()];
  if (DIMS[dim].sort) keys.sort(DIMS[dim].sort);
  return keys.map(k => ({ key: k, name: DIMS[dim].name(k), items: m.get(k) }));
}

const RES_COLOR = { conforme: '#2E8B57', nao_conforme: '#C0392B', na: '#6E7A86' };
const kpi = (label, value, sub, color) => html`<div class="r-kpi" style="--c:${color}"><div class="r-kpi-l">${label}</div><div class="r-kpi-v">${value}</div>${sub ? html`<div class="r-kpi-s">${sub}</div>` : ''}</div>`;

export async function view({ params, query, state }) {
  const t = await api(`/tasks/${params.id}`);
  if (!t.checklist) throw new Error('Esta tarefa não é um check-list.');
  const c = t.checklist;
  // Filtro por grupo e/ou responsável (?grupo=&resp=): o relatório inteiro (resumo, itens e Gantt) considera só esses itens
  SPEC_ORDER = state?.meta?.projects?.find(p => p.id === t.project_id)?.specialties || [];
  const opts = filterOptions(c.items, SPEC_ORDER);
  const fGroup = opts.groups.includes(query.get('grupo')) ? query.get('grupo') : '';
  const fSpec = opts.specs.includes(query.get('esp')) ? query.get('esp') : '';
  const fResp = opts.resps.includes(query.get('resp')) ? query.get('resp') : '';
  const items = c.items.filter(i => matchItem(i, { group: fGroup, spec: fSpec, resp: fResp }));
  const filterText = [fGroup ? `Grupo: ${optLabel(fGroup, 'group')}` : '', fSpec ? `Especialidade: ${optLabel(fSpec, 'spec')}` : '',
    fResp ? `Responsável: ${optLabel(fResp, 'resp')}` : ''].filter(Boolean).join(' · ');
  const hasSpecs = c.items.some(i => i.specialty);
  const s = (() => {
    const done = items.filter(i => i.resolved).length;
    const cnt = r => items.filter(i => i.result === r).length;
    return { total: items.length, done, pct: items.length ? Math.round((done / items.length) * 100) : 0, conforme: cnt('conforme'),
      nao_conforme: items.filter(i => i.open_nc).length, na: cnt('na'), pending: items.filter(i => !i.result && !i.registered).length,
      nc_total: items.reduce((n, i) => n + i.nc_count, 0) };
  })();
  const withPhotos = query.get('fotos') !== '0';
  const withGantt = query.get('gantt') !== '0';
  const judged = s.conforme + s.nao_conforme;
  const levels = readLevels(query);
  // Situação do item no relatório
  const situation = i => i.open_nc ? { t: `Não conforme em aberto${i.nc_count > 1 ? ` · ${i.nc_count}x` : ''}`, c: RES_COLOR.nao_conforme }
    : i.result === 'conforme' ? { t: i.nc_count ? `Corrigido · ${i.nc_count}x NC` : 'Conforme', c: RES_COLOR.conforme }
      : i.result === 'na' ? { t: i.nc_count ? 'Encerrado (N/A)' : 'N/A', c: RES_COLOR.na } : { t: 'Pendente', c: '#A86F0E' };
  const fig = (f, label, color) => html`<figure><img src="/api/checklist-files/${f.id}" alt=""><figcaption>${label ? html`<b style="color:${color}">${label}</b> · ` : ''}${fmtDateTime(f.created_at)}</figcaption></figure>`;
  // Quadro de fotos do item: "Não conformidade" (cadastro + respostas Não conforme) e "Correção" (Conforme/N/A).
  // Miniaturas pequenas com a data; nada quando o item não tem fotos.
  const photosOf = i => {
    if (!withPhotos) return '';
    const seen = new Set();
    const nc = [], fix = [];
    const add = (list, f) => { if (f && !seen.has(f.id)) { seen.add(f.id); list.push(f); } };
    i.refs.forEach(f => add(nc, f));
    for (const h of i.history.filter(h => !h.registration)) h.files.forEach(f => add(h.result === 'nao_conforme' ? nc : fix, f));
    i.files.forEach(f => add(i.resolved ? fix : nc, f));
    if (!nc.length && !fix.length) return '';
    // Até 3 fotos de cada lado: as mais recentes (a não conformidade atual e a correção final)
    const thumbs = list => html`<div class="r-pb-grid">${list.slice(-3).map(f => html`<figure><img src="/api/checklist-files/${f.id}" alt=""><figcaption>${fmtDateTime(f.created_at).replace(/\/\d{4},/, ',')}</figcaption></figure>`)}</div>`;
    // Com os dois lados, cada um ocupa espaço proporcional à quantidade de fotos (até 4 por linha no total)
    const cols = nc.length && fix.length ? `grid-template-columns:minmax(0,${Math.min(nc.length, 3)}fr) minmax(0,${Math.min(fix.length, 3)}fr)` : '';
    const more = list => (list.length > 3 ? ` · mostrando as 3 mais recentes de ${list.length}` : ` · ${list.length} foto(s)`);
    return html`<div class="r-pbox ${nc.length && fix.length ? 'is-two' : ''}" style="${cols}">
      ${nc.length ? html`<div class="r-pb-col"><div class="r-pb-h is-nc">Não conformidade${more(nc)}</div>${thumbs(nc)}</div>` : ''}
      ${fix.length ? html`<div class="r-pb-col"><div class="r-pb-h is-ok">${i.result === 'na' ? 'Encerramento (N/A)' : 'Correção'}${more(fix)}</div>${thumbs(fix)}</div>` : ''}
    </div>`;
  };
  // Prazo em destaque, com a cor pela urgência (vencido, vence em até 2 dias, no prazo, resolvido, sem prazo)
  const today = new Date(Date.now() - new Date().getTimezoneOffset() * 60000).toISOString().slice(0, 10);
  const dueFact = i => {
    if (!i.due_date) return html`<span class="r-fact is-none"><small>Prazo</small><b>Sem prazo</b></span>`;
    const days = Math.round((Date.parse(i.due_date) - Date.parse(today)) / 86400e3);
    const [cls, rel] = i.resolved ? ['is-done', ''] : days < 0 ? ['is-late', `atrasado há ${-days} ${days === -1 ? 'dia' : 'dias'}`]
      : days === 0 ? ['is-soon', 'vence hoje'] : days <= 2 ? ['is-soon', `falta${days > 1 ? 'm' : ''} ${days} ${days === 1 ? 'dia' : 'dias'}`] : ['is-ok', `faltam ${days} dias`];
    return html`<span class="r-fact ${cls}"><small>Prazo</small><b>${fmtDate(i.due_date)}</b>${rel ? html`<em>${rel}</em>` : ''}</span>`;
  };
  const itemBlock = i => {
    const st = situation(i);
    const hist = i.history.length > 1 || i.history.some(h => h.reason || h.registration) ? i.history : [];
    return html`<article class="r-item avoid">
      <header><span class="r-item-n">${i.seq}</span><b>${i.text}</b><span class="r-st" style="--c:${st.c}">${st.t}</span></header>
      <div class="r-facts">
        <span class="r-fact"><small>Responsável${i.assignee_id ? '' : ' (global)'}</small><b>${i.responsible_name}</b></span>
        ${dueFact(i)}
      </div>
      <div class="r-item-meta small">
        ${!levels.includes('grupo') && i.group ? html`<span class="r-stage">${i.group}</span>` : ''}
        ${!levels.includes('especialidade') && i.specialty ? html`<span class="r-stage r-spec">${i.specialty}</span>` : ''}
        ${i.result ? html`<span>Respondido por ${i.answered_by_name || '—'} em ${fmtDateTime(i.answered_at)}</span>` : ''}
      </div>
      ${i.description ? html`<div class="small">Obs.: ${i.description}</div>` : ''}
      ${i.note ? html`<div class="small"><b>${i.open_nc ? 'Problema:' : 'Anotação:'}</b> ${i.note}</div>` : ''}
      ${hist.length ? html`<ol class="r-item-hist small">${hist.map(h => html`<li><b>${h.registration ? 'Registrada no cadastro' : RESULT[h.result].label}</b> · ${h.user_name || '—'} · ${fmtDateTime(h.created_at)}${h.reason ? ` · Justificativa: ${h.reason}` : ''}${h.note ? ` · ${h.note}` : ''}</li>`)}</ol>` : ''}
      ${photosOf(i)}
    </article>`;
  };
  // Lista única, com cabeçalho de cada nível de agrupamento
  const blocks = (items, depth = 0) => {
    const list = [...items].sort((a, b) => a.seq - b.seq);
    if (depth >= levels.length) return html`${list.map(itemBlock)}`;
    return html`${groupBy(list, levels[depth]).map(g => {
      const open = g.items.filter(i => i.open_nc).length;
      return html`<div class="r-grouphead r-lvl-${depth}" style="margin-left:${depth * 14}px">
          <span class="r-stage">${DIMS[levels[depth]].label}: ${g.name}</span>
          <span class="small muted">${g.items.filter(i => i.resolved).length}/${g.items.length} concluído(s)${open ? ` · ${open} NC em aberto` : ''}</span></div>
        <div style="margin-left:${depth * 14}px">${blocks(g.items, depth + 1)}</div>`;
    })}`;
  };
  // Resumo: não conformidades por ambiente (grupo) e por especialidade
  const pctRes = g => (g.nc ? fmtPct(Math.round((g.res / g.nc) * 100)) : '—');
  const ncRows = dim => groupBy(items, dim).map(g => {
    const ncs = g.items.filter(i => i.nc_count > 0);
    const pend = ncs.filter(i => i.open_nc).length;
    return { name: g.name, items: g.items.length, nc: ncs.length, pend, res: ncs.length - pend };
  });
  const ncTable = (heading, first, rows) => {
    const tot = rows.reduce((a, g) => ({ items: a.items + g.items, nc: a.nc + g.nc, pend: a.pend + g.pend, res: a.res + g.res }), { items: 0, nc: 0, pend: 0, res: 0 });
    return html`<h3 class="r-h">${heading}</h3>
      <table class="r-table r-nc-table"><thead><tr><th>${first}</th><th class="num">Itens</th><th class="num">Não conformidades</th><th class="num">Pendentes</th><th class="num">Resolvidas</th><th class="num">% resolvidas</th></tr></thead>
        <tbody>${rows.map(g => html`<tr><td>${g.name}</td><td class="num">${g.items}</td><td class="num">${g.nc}</td>
          <td class="num ${g.pend ? 'late' : ''}">${g.pend}</td><td class="num">${g.res}</td><td class="num">${pctRes(g)}</td></tr>`)}
          <tr class="r-total"><td><b>Total</b></td><td class="num"><b>${tot.items}</b></td><td class="num"><b>${tot.nc}</b></td>
            <td class="num ${tot.pend ? 'late' : ''}"><b>${tot.pend}</b></td><td class="num"><b>${tot.res}</b></td><td class="num"><b>${pctRes(tot)}</b></td></tr></tbody></table>`;
  };
  const title = 'Check-list';

  // Gantt semanal dos itens: barra do início ao término (sem início, começa no término). Itens resolvidos vão até a
  // data da resposta; pendentes vencidos ganham a extensão hachurada até hoje. Itens sem nenhuma data ficam de fora.
  const ITEM_COLOR = i => (i.open_nc ? RES_COLOR.nao_conforme : i.result === 'conforme' ? RES_COLOR.conforme : i.result === 'na' ? RES_COLOR.na : '#A86F0E');
  const dated = items.filter(i => i.start_date || i.due_date);
  const ganttRows = dated.map(i => ({
    code: String(i.seq), title: i.text, assignee_name: i.responsible_name, group: i.group || 'Sem grupo', item: i,
    start_date: i.start_date || i.due_date, due_date: i.due_date || null, completed_at: i.resolved ? i.answered_at : null,
    eff_status: i.resolved ? 'concluida' : i.overdue ? 'atrasada' : 'em_andamento',
    days_late: i.overdue ? Math.round((Date.parse(today) - Date.parse(i.due_date)) / 86400e3) : 0,
  })).sort((a, b) => (levels[0] === 'especialidade' ? specRank(a.item.specialty || '') - specRank(b.item.specialty || '') : 0) || a.item.seq - b.item.seq);
  // Agrupa como a lista quando o 1º nível é grupo ou responsável; senão, por grupo
  const ganttBy = levels[0] === 'responsavel' ? r => r.assignee_name || 'Sem responsável'
    : levels[0] === 'especialidade' ? r => r.item.specialty || 'Sem especialidade' : r => r.group;
  const ganttLegend = html`<div class="g-legend">
    <span><i class="g-sw" style="--c:#A86F0E"></i>Pendente (início → término)</span>
    <span><i class="g-sw" style="--c:${RES_COLOR.nao_conforme}"></i>Não conforme em aberto</span>
    <span><i class="g-sw is-done" style="--c:${RES_COLOR.conforme}"></i>Conforme / corrigido (até a resposta)</span>
    <span><i class="g-sw is-done" style="--c:${RES_COLOR.na}"></i>N/A</span>
    <span><i class="g-sw g-sw-late"></i>Atraso (término → hoje)</span>
    <span><i class="g-due g-due-legend"></i>Término</span>
    <span><i class="g-today-legend"></i>Hoje (${fmtDate(today)})</span></div>`;

  const doc = html`
    <article class="doc a4" id="doc">
      <header class="r-header">
        <img src="/assets/logo.webp" alt="Charão Engenharia & Construção" class="r-logo">
        <div class="r-doctype"><div class="r-kicker">Check-list de vistoria${filterText ? ' · filtrado' : ''}</div><div class="r-level">${t.code}</div></div>
      </header>
      <div class="r-rule"></div>
      <section class="r-scope">
        <div><div class="r-lbl">Check-list</div><h1>${t.title}</h1>
          <div class="muted">${t.project_code} · ${t.project_name}${t.project_client ? ` · Cliente: ${t.project_client}` : ''}</div>
          ${t.description ? html`<p class="r-p" style="margin-top:6px">${t.description}</p>` : ''}</div>
        <dl class="r-meta">
          <dt>Responsável</dt><dd>${t.assignee_name || '—'}</dd>
          <dt>Prazo</dt><dd>${fmtDate(t.due_date)}</dd>
          <dt>Situação</dt><dd>${STATUS[t.eff_status]?.label || t.eff_status}</dd>
          ${t.delivered_at ? html`<dt>Entregue em</dt><dd>${fmtDateTime(t.delivered_at)}</dd>` : ''}
          ${t.reviewed_at ? html`<dt>Conferido por</dt><dd>${t.reviewer_name || '—'} · ${fmtDateTime(t.reviewed_at)}</dd>` : ''}
          <dt>Fotos</dt><dd>${PHOTO_RULE[c.photo_rule]}</dd>
          ${filterText ? html`<dt>Filtro</dt><dd><b>${filterText}</b> · ${items.length} de ${c.items.length} itens</dd>` : ''}
          <dt>Agrupamento</dt><dd>${levels.length ? levels.map(l => DIMS[l].label).join(' › ') : 'Sem agrupamento'}</dd>
          <dt>Emissão</dt><dd>${fmtDateTime(new Date().toISOString())}</dd>
        </dl>
      </section>

      <section class="r-section avoid">
        <h3 class="r-h">Resumo</h3>
        <div class="r-kpis">
          ${kpi('Itens', s.total, `${s.done} concluído(s) · ${s.pct}%`, '#2A3D50')}
          ${kpi('Conforme', s.conforme, judged ? `${fmtPct(Math.round((s.conforme / judged) * 100))} dos avaliados` : '', RES_COLOR.conforme)}
          ${kpi('Não conforme em aberto', s.nao_conforme, s.nc_total ? `${s.nc_total} registrada(s) no histórico` : 'nenhuma registrada', RES_COLOR.nao_conforme)}
          ${kpi('N/A', s.na, '', RES_COLOR.na)}
        </div>
        ${s.pending ? html`<p class="r-p" style="margin-top:6px"><b>${s.pending} item(ns) ainda sem resposta.</b></p>` : ''}
      </section>

      <section class="r-section avoid">
        ${ncTable('Não conformidades por ambiente', 'Ambiente / grupo', ncRows('grupo'))}
        ${hasSpecs ? html`<div style="height:8px"></div>${ncTable('Não conformidades por especialidade', 'Especialidade', ncRows('especialidade'))}` : ''}
        <p class="small muted" style="margin-top:4px">Item cadastrado com foto conta como não conformidade. Pendente = ainda em aberto; resolvida = corrigida (Conforme) ou encerrada (N/A).</p>
      </section>

      <section class="r-section">
        <h3 class="r-h">Itens (${items.length})</h3>
        ${blocks(items)}
      </section>

      <section class="r-section avoid">
        <div class="r-sign" style="grid-template-columns:repeat(3,1fr)">
          <div><span></span>${t.assignee_name || 'Responsável pelo check-list'}<div class="muted">Responsável pelo check-list</div></div>
          <div><span></span>${t.reviewer_name || ' '}<div class="muted">Conferente</div></div>
          <div><span></span> <div class="muted">Cliente / Recebedor</div></div>
        </div>
      </section>
      ${withGantt ? html`<section class="r-section r-gantt">
        <h3 class="r-h">Cronograma semanal dos itens (Gantt) <span class="muted small">(${dated.length} de ${items.length})</span></h3>
        ${ganttChart(ganttRows, { ref: today, weekly: true, groupLabel: ganttBy, color: r => ITEM_COLOR(r.item), statusOf: r => situation(r.item).t,
          noun: ['item(ns)', 'concluído(s)'], head: 'Item', legend: ganttLegend,
          note: `Barra = data de início até a data de término do item (sem início, aparece só a semana do término).${items.length > dated.length ? ` ${items.length - dated.length} item(ns) sem datas não aparecem no cronograma.` : ''}` })}
      </section>` : ''}
      <footer class="r-footer">
        <span>Charão Engenharia & Construção · ${title} ${t.code}</span>
        <span>Documento gerado pelo sistema Charão Gestão de Obras</span>
      </footer>
    </article>`;

  return {
    title: `Check-list ${t.code}`,
    html: html`${printToolbar({
      back: `#/tarefas/${t.id}`, title: `Check-list — ${t.code} · ${t.title}`,
      extra: html`${[0, 1, 2].map(n => html`<label class="pt-opt">${n === 0 ? 'Agrupar por' : n === 1 ? 'depois' : 'e'}
          <select data-level="${n}"><option value="">${n === 0 ? 'Sem agrupamento' : '—'}</option>${Object.entries(DIMS).map(([k, d]) => html`<option value="${k}" ${levels[n] === k ? 'selected' : ''}>${d.label}</option>`)}</select></label>`)}
        ${opts.groups.length > 1 ? html`<label class="pt-opt">Grupo <select data-flt="grupo"><option value="">Todos</option>${opts.groups.map(k => html`<option value="${k}" ${k === fGroup ? 'selected' : ''}>${optLabel(k, 'group')}</option>`)}</select></label>` : ''}
        ${opts.specs.length > 1 ? html`<label class="pt-opt">Especialidade <select data-flt="esp"><option value="">Todas</option>${opts.specs.map(k => html`<option value="${k}" ${k === fSpec ? 'selected' : ''}>${optLabel(k, 'spec')}</option>`)}</select></label>` : ''}
        ${opts.resps.length > 1 ? html`<label class="pt-opt">Responsável <select data-flt="resp"><option value="">Todos</option>${opts.resps.map(k => html`<option value="${k}" ${k === fResp ? 'selected' : ''}>${optLabel(k, 'resp')}</option>`)}</select></label>` : ''}
        <label class="pt-opt"><input type="checkbox" id="fotos" ${withPhotos ? 'checked' : ''}>Incluir fotos</label>
        <label class="pt-opt"><input type="checkbox" id="gnt" ${withGantt ? 'checked' : ''}>Gantt semanal</label>`,
    })}<div class="doc-stage">${doc}</div>`,
    mount(root, ctx) {
      setPageFooter(`Charão · Check-list ${t.code} · ${t.project_code}`);
      bindPrintToolbar(root);
      const q = () => Object.fromEntries(new URLSearchParams(location.hash.split('?')[1] || ''));
      root.querySelector('#fotos').addEventListener('change', e => { ctx.setQuery({ ...q(), fotos: e.target.checked ? '' : '0' }); ctx.render(); });
      root.querySelectorAll('[data-flt]').forEach(sel => sel.addEventListener('change', () => { ctx.setQuery({ ...q(), [sel.dataset.flt]: sel.value }); ctx.render(); }));
      root.querySelector('#gnt').addEventListener('change', e => { ctx.setQuery({ ...q(), gantt: e.target.checked ? '' : '0' }); ctx.render(); });
      // Agrupamento: até 3 níveis (o nível vazio encerra a sequência)
      root.querySelectorAll('[data-level]').forEach(sel => sel.addEventListener('change', () => {
        const vals = [...root.querySelectorAll('[data-level]')].map(x => x.value);
        const cut = vals.indexOf('');
        const chosen = cut < 0 ? vals : vals.slice(0, cut);
        ctx.setQuery({ ...q(), g1: chosen[0] || 'nenhum', g2: chosen[1] || '', g3: chosen[2] || '' });
        ctx.render();
      }));
    },
  };
}
