// Relatório A4 do check-list (termo de vistoria): resumo com as não conformidades por ambiente e lista única de itens
// (agrupada por grupo, responsável e data em até 3 níveis), com histórico e fotos quando houver, assinaturas e,
// ao final, o cronograma semanal (Gantt) dos itens.
// "Separar por" gera uma parte por responsável, grupo etc., cada uma em folha nova, com resumo e assinaturas próprios.
// Por profissional: uma parte por profissional da equipe dos itens, na ordem da sequência programada (o item com mais de
// um profissional aparece na parte de cada um); valores não saem no relatório.
// Formato: Completo (fotos, histórico e Gantt) ou Lista compacta (tabela com campo para anotar, para levar à obra).
// O título do relatório vem primeiro; a faixa da parte e os agrupamentos repetem no topo de cada página (thead) e o que já
// está na faixa ou no agrupamento não se repete no item. "Informações" liga e desliga cabeçalho, resumo, histórico etc.
import { html, api, STATUS, fmtDate, fmtDateTime, fmtPct } from '../core.js';
import { printToolbar, bindPrintToolbar, setPageFooter } from './print-common.js';
import { RESULT, PHOTO_RULE, matchItem, filterOptions, optLabel } from './checklist-ui.js';
import { periodKey, periodInfo } from './periods.js';
import { ganttChart, drawGanttLinks } from './gantt.js';
import { loadSignatures, sigLine, sigInfo, bindSignatures, signedDate } from './signatures.js';

// Dimensões de agrupamento (combináveis em até 3 níveis). Data = prazo do item.
// Especialidades na ordem do modelo da obra (definida a cada relatório); fora do modelo depois e "Sem especialidade" por último
let SPEC_ORDER = [];
const specRank = k => (!k ? 1e6 : SPEC_ORDER.includes(k) ? SPEC_ORDER.indexOf(k) : 1e5);
const DIMS = {
  grupo: { label: 'Grupo', key: i => i.group || '', name: k => k || 'Sem grupo' },
  especialidade: { label: 'Especialidade', key: i => i.specialty || '', name: k => k || 'Sem especialidade', sort: (a, b) => specRank(a) - specRank(b) || a.localeCompare(b, 'pt-BR') },
  situacao: { label: 'Situação', key: i => (i.open_nc ? '1' : !i.result ? '2' : i.result === 'conforme' ? '3' : '4'),
    name: k => ({ 1: 'Não conforme em aberto', 2: 'Pendente', 3: 'Conforme', 4: 'N/A' })[k], sort: (a, b) => a.localeCompare(b) },
  responsavel: { label: 'Responsável', key: i => i.responsible_name || '', name: k => k || 'Sem responsável', sort: (a, b) => a.localeCompare(b, 'pt-BR') },
  dia: { label: 'Data (dia)', key: i => periodKey(i.due_date, 'dia'), name: k => periodInfo(k, 'dia').label, sort: (a, b) => a.localeCompare(b) },
  semana: { label: 'Data (semana)', key: i => periodKey(i.due_date, 'semana'), name: k => periodInfo(k, 'semana').label, sort: (a, b) => a.localeCompare(b) },
  mes: { label: 'Data (mês)', key: i => periodKey(i.due_date, 'mes'), name: k => periodInfo(k, 'mes').label, sort: (a, b) => a.localeCompare(b) },
};
const DATE_DIMS = ['dia', 'semana', 'mes'];
const NO_WORKER = 'sem';

// Partes por profissional: itens na ordem da sequência; por último, os que ainda têm vaga de função ou não têm equipe
function workerParts(items, onlyWorker) {
  const by = new Map();
  const add = (key, name, role, item, days, pos, gap = 0) => {
    if (!by.has(key)) by.set(key, { key, name, role, rows: [] });
    by.get(key).rows.push({ item, days, pos, gap });
  };
  for (const i of items) {
    for (const e of i.team.filter(x => x.worker_id)) add(String(e.worker_id), e.name, e.role, i, e.days, e.plan_seq ?? 1e6, e.plan_gap);
    const open = i.team.filter(x => !x.worker_id);
    if (open.length || !i.team.length) add(NO_WORKER, 'Sem profissional definido', null, i, open.length ? Math.max(...open.map(x => x.days)) : null, i.seq);
  }
  const list = [...by.values()].sort((a, b) => (a.key === NO_WORKER) - (b.key === NO_WORKER) || a.name.localeCompare(b.name, 'pt-BR'));
  const options = list.map(p => ({ key: p.key, name: p.name }));
  const shown = onlyWorker ? list.filter(p => p.key === onlyWorker) : list;
  return { options, parts: shown.map((p, index) => {
    const rows = p.rows.sort((a, b) => a.pos - b.pos || (a.item.start_date || a.item.due_date || '9999').localeCompare(b.item.start_date || b.item.due_date || '9999') || a.item.seq - b.item.seq);
    return { items: rows.map(r => r.item), label: `Profissional: ${p.name}${p.role ? ` · ${p.role}` : ''}`, name: p.key === NO_WORKER ? '' : p.name, index, total: shown.length,
      order: new Map(rows.map((r, n) => [r.item.id, n + 1])), days: new Map(rows.map(r => [r.item.id, r.days])),
      gaps: new Map(rows.map((r, n) => [r.item.id, n ? r.gap : 0])) };
  }) };
}

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

// Fotos em tamanho de impressão: a miniatura tem até 38 mm (450 px a 300 dpi), e a foto original deixaria o PDF muito pesado.
// Reduz no navegador e guarda enquanto a tela está aberta (mudar uma opção do relatório não processa tudo de novo).
const PHOTO_SIDE = 450;
const photoCache = new Map();
async function shrinkPhoto(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error('foto indisponível');
  const blob = await res.blob();
  const bmp = await createImageBitmap(blob);
  const scale = PHOTO_SIDE / Math.min(bmp.width, bmp.height);
  if (scale >= 1) { bmp.close(); return URL.createObjectURL(blob); }
  const c = document.createElement('canvas');
  c.width = Math.round(bmp.width * scale);
  c.height = Math.round(bmp.height * scale);
  const g = c.getContext('2d');
  g.imageSmoothingQuality = 'high';
  g.drawImage(bmp, 0, 0, c.width, c.height);
  bmp.close();
  const small = await new Promise(r => c.toBlob(r, 'image/jpeg', 0.85));
  if (!small) throw new Error('foto não reduzida');
  return URL.createObjectURL(small);
}
// Poucas fotos por vez, para não pesar no celular. Se não conseguir reduzir, usa a foto original.
function loadPhotos(root, onProgress) {
  const imgs = [...root.querySelectorAll('img[data-photo]')];
  let next = 0, done = 0;
  const worker = async () => {
    while (next < imgs.length) {
      const img = imgs[next++];
      const url = `/api/checklist-files/${img.dataset.photo}`;
      const key = `${img.dataset.photo}|${img.dataset.at}`;
      if (!photoCache.has(key)) photoCache.set(key, shrinkPhoto(url).catch(() => url));
      img.src = await photoCache.get(key);
      await img.decode().catch(() => {});
      onProgress(++done, imgs.length);
    }
  };
  return Promise.all(Array.from({ length: 4 }, worker));
}
let showBoxOpen = false;

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
  const statsOf = list => {
    const done = list.filter(i => i.resolved).length;
    const cnt = r => list.filter(i => i.result === r).length;
    return { total: list.length, done, pct: list.length ? Math.round((done / list.length) * 100) : 0, conforme: cnt('conforme'),
      nao_conforme: list.filter(i => i.open_nc).length, na: cnt('na'), pending: list.filter(i => !i.result).length,
      nc_total: list.reduce((n, i) => n + i.nc_count, 0) };
  };
  const withPhotos = query.get('fotos') !== '0';
  const withGantt = query.get('gantt') !== '0';
  // Assinaturas do check-list (por parte, quando o relatório é separado por responsável/profissional)
  const S = await loadSignatures([{ type: 'checklist', key: String(t.id), fp: c.items.map(i => `${i.id}:${i.result || ''}:${i.resolved ? 1 : 0}:${i.open_nc ? 1 : 0}`).join(',') }]);
  const sD = (part, slot, label, name, userId = '') => ({ type: 'checklist', key: String(t.id), slot: `${slot}:${part?.name || 'geral'}`, label: `${label}${part?.name ? ` · ${part.name}` : ''}`, name, userId });
  const respName = part => ((sep === 'responsavel' || byWorker) && part.name ? part.name : t.assignee_name || '');
  const byWorker = query.get('sep') === 'profissional';
  const sep = byWorker || DIMS[query.get('sep')] ? query.get('sep') : '';
  const compact = query.get('fmt') === 'lista';
  // Informações opcionais (?cab=0, ?resumo=0...): tudo ligado por padrão
  const show = k => query.get(k) !== '0';
  // O que já separa as partes não precisa agrupar de novo dentro de cada uma
  // Por profissional, o padrão é a ordem da sequência, sem agrupar
  const levels = (byWorker && !query.has('g1') ? [] : readLevels(query)).filter(d => d !== sep);
  // O que já aparece na faixa da parte ou no agrupamento não se repete no item
  const grouped = new Set([...levels, sep]);
  const workers = byWorker ? workerParts(items, query.get('prof') || '') : null;
  const parts = workers?.parts.length ? workers.parts : sep && !byWorker && items.length
    ? groupBy(items, sep).map((g, i, all) => ({ items: g.items, label: `${DIMS[sep].label}: ${g.name}`, name: g.name, index: i, total: all.length }))
    : [{ items, label: '', name: '', index: 0, total: 1 }];
  const partHead = part => (part.label ? html`<div class="r-part-head"><b>${part.label}</b>${part.total > 1 ? html`<span>Parte ${part.index + 1} de ${part.total}</span>` : ''}</div>` : '');
  // Cabeçalho de tabela: o navegador repete no topo de cada página impressa
  const repeatTable = (head, rows) => html`<table class="r-rep"><thead><tr><td>${head}</td></tr></thead><tbody>${rows.map(r => html`<tr><td>${r}</td></tr>`)}</tbody></table>`;
  const showHeader = part => show('cab') || part.index === 0;
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
    const thumbs = list => html`<div class="r-pb-grid">${list.slice(-3).map(f => html`<figure><img data-photo="${f.id}" data-at="${f.created_at}" alt=""><figcaption>${fmtDateTime(f.created_at).replace(/\/\d{4},/, ',')}</figcaption></figure>`)}</div>`;
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
    // Agrupado por dia: a data já está no agrupamento; fica só o aviso de urgência
    const dateShown = grouped.has('dia');
    if (!i.due_date) return dateShown ? '' : html`<span class="r-fact is-none"><small>Prazo</small><b>Sem prazo</b></span>`;
    const days = Math.round((Date.parse(i.due_date) - Date.parse(today)) / 86400e3);
    const [cls, rel] = i.resolved ? ['is-done', ''] : days < 0 ? ['is-late', `atrasado há ${-days} ${days === -1 ? 'dia' : 'dias'}`]
      : days === 0 ? ['is-today', 'vence hoje'] : days <= 7 ? ['is-week', `falta${days > 1 ? 'm' : ''} ${days} ${days === 1 ? 'dia' : 'dias'}`] : ['is-ok', `faltam ${days} dias`];
    if (dateShown && !rel) return '';
    return html`<span class="r-fact ${cls}"><small>Prazo</small>${dateShown ? '' : html`<b>${fmtDate(i.due_date)}</b>`}${rel ? html`<em>${rel}</em>` : ''}</span>`;
  };
  const itemBlock = i => {
    const st = situation(i);
    const hist = show('hist') && (i.history.length > 1 || i.history.some(h => h.reason || h.registration)) ? i.history : [];
    const sameSituation = grouped.has('situacao') && st.t === DIMS.situacao.name(DIMS.situacao.key(i));
    const gapDays = curPart?.gaps?.get(i.id);
    return html`${gapDays ? html`<div class="r-item-gap">Intervalo de ${gapDays} ${gapDays === 1 ? 'dia útil' : 'dias úteis'}</div>` : ''}<article class="r-item avoid">
      <header><span class="r-item-n">${i.seq}</span><b>${i.text}</b>${sameSituation ? '' : html`<span class="r-st" style="--c:${st.c}">${st.t}</span>`}</header>
      <div class="r-facts">
        ${curPart?.order ? html`<span class="r-fact"><small>Ordem na sequência</small><b>${curPart.order.get(i.id)}º</b></span>${curPart.days?.get(i.id) ? html`<span class="r-fact"><small>Dias de trabalho</small><b>${String(curPart.days.get(i.id)).replace('.', ',')}</b></span>` : ''}${i.start_date ? html`<span class="r-fact"><small>Início</small><b>${fmtDate(i.start_date)}</b></span>` : ''}` : ''}
        ${grouped.has('responsavel') ? '' : html`<span class="r-fact"><small>Responsável${i.assignee_id ? '' : ' (global)'}</small><b>${i.responsible_name}</b></span>`}
        ${dueFact(i)}
      </div>
      <div class="r-item-meta small">
        ${!grouped.has('grupo') && i.group ? html`<span class="r-stage">${i.group}</span>` : ''}
        ${!grouped.has('especialidade') && i.specialty ? html`<span class="r-stage r-spec">${i.specialty}</span>` : ''}
        ${i.result && show('quem') ? html`<span>Respondido por ${i.answered_by_name || '—'} em ${fmtDateTime(i.answered_at)}</span>` : ''}
      </div>
      ${i.description ? html`<div class="small">Obs.: ${i.description}</div>` : ''}
      ${i.note ? html`<div class="small"><b>${i.open_nc ? 'Problema:' : 'Anotação:'}</b> ${i.note}</div>` : ''}
      ${hist.length ? html`<ol class="r-item-hist small">${hist.map(h => html`<li><b>${h.registration ? 'Registrada no cadastro' : RESULT[h.result].label}</b> · ${h.user_name || '—'} · ${fmtDateTime(h.created_at)}${h.reason ? ` · Justificativa: ${h.reason}` : ''}${h.note ? ` · ${h.note}` : ''}</li>`)}</ol>` : ''}
      ${photosOf(i)}
    </article>`;
  };
  // Lista única, com cabeçalho de cada nível de agrupamento (por profissional, na ordem da sequência)
  let curPart = null;
  const itemRows = (items, depth = 0) => {
    const list = [...items].sort((a, b) => (curPart?.order?.get(a.id) ?? a.seq) - (curPart?.order?.get(b.id) ?? b.seq));
    if (depth >= levels.length) return list.map(itemBlock);
    return groupBy(list, levels[depth]).map(g => {
      const open = g.items.filter(i => i.open_nc).length;
      return html`<div style="margin-left:${depth * 14}px">${repeatTable(html`<div class="r-grouphead r-lvl-${depth}">
          <span class="r-stage">${DIMS[levels[depth]].label}: ${g.name}</span>
          <span class="small muted">${g.items.filter(i => i.resolved).length}/${g.items.length} concluído(s)${open ? ` · ${open} NC em aberto` : ''}</span></div>`, itemRows(g.items, depth + 1))}</div>`;
    });
  };
  // Lista compacta: uma tabela por parte, sem fotos, com campo para anotar à mão
  const listDoc = part => {
    const st = statsOf(part.items);
    const showResp = !grouped.has('responsavel') && !byWorker;
    const showDue = !grouped.has('dia');
    const showSit = !grouped.has('situacao');
    const span = 3 + showResp + showDue + showSit + (byWorker ? 2 : 0);
    const when = part.items.map(i => i.due_date).filter(Boolean).sort().at(-1);
    const totalDays = byWorker ? part.items.reduce((n, i) => n + (part.days?.get(i.id) || 0), 0) : 0;
    const row = i => {
      const sit = situation(i);
      const tags = [!grouped.has('grupo') ? i.group : '', !grouped.has('especialidade') ? i.specialty : ''].filter(Boolean).join(' · ');
      const gap = part.gaps?.get(i.id);
      return html`${gap ? html`<tr class="r-l-gap"><td colspan="${span}">Intervalo de ${gap} ${gap === 1 ? 'dia útil' : 'dias úteis'}</td></tr>` : ''}<tr><td class="num">${part.order?.get(i.id) ?? i.seq}</td>
        <td><b>${i.text}</b>${byWorker ? html` <span class="small muted" style="white-space:nowrap">(item ${i.seq})</span>` : ''}${tags ? html`<div class="small muted">${tags}</div>` : ''}${i.description ? html`<div class="small">Obs.: ${i.description}</div>` : ''}</td>
        ${showResp ? html`<td>${i.responsible_name}</td>` : ''}
        ${byWorker ? html`<td class="r-l-due">${i.start_date ? fmtDate(i.start_date) : '—'}</td>` : ''}
        ${showDue ? html`<td class="r-l-due">${i.due_date ? fmtDate(i.due_date) : '—'}</td>` : ''}
        ${byWorker ? html`<td class="num">${part.days?.get(i.id) === null ? '—' : String(part.days?.get(i.id)).replace('.', ',')}</td>` : ''}
        ${showSit ? html`<td class="r-l-sit" style="color:${sit.c}"><b>${sit.t.replace(' em aberto', '')}</b></td>` : ''}<td class="r-l-note"></td></tr>`;
    };
    const rows = (list, depth = 0) => {
      const sorted = [...list].sort((a, b) => (part.order?.get(a.id) ?? a.seq) - (part.order?.get(b.id) ?? b.seq));
      if (depth >= levels.length) return html`${sorted.map(row)}`;
      return html`${groupBy(sorted, levels[depth]).map(g => html`${groupRow(g, depth)}${rows(g.items, depth + 1)}`)}`;
    };
    const groupRow = (g, depth) => html`<tr class="r-grouprow r-lvl-${depth}"><td colspan="${span}"><b>${DIMS[levels[depth]].label}: ${g.name}</b> <span class="small muted">· ${g.items.filter(i => i.resolved).length}/${g.items.length} concluído(s)</span></td></tr>`;
    // Uma tabela por grupo do 1º nível: a parte, o grupo e as colunas repetem no topo de cada página
    const table = (list, group, from) => html`<table class="r-table r-list-table ${byWorker ? 'is-worker' : ''}"><thead>${part.label ? html`<tr class="r-list-who"><th colspan="${span}">${part.label}${part.total > 1 ? ` · Parte ${part.index + 1} de ${part.total}` : ''}</th></tr>` : ''}${group || ''}<tr><th class="num">${byWorker ? 'Ordem' : 'Nº'}</th><th>Item</th>${showResp ? html`<th>Responsável</th>` : ''}${byWorker ? html`<th>Início</th>` : ''}${showDue ? html`<th>Prazo</th>` : ''}${byWorker ? html`<th class="num">Dias</th>` : ''}${showSit ? html`<th>Situação</th>` : ''}<th>Anotações</th></tr></thead>
        <tbody>${rows(list, from)}</tbody></table>`;
    return html`<article class="doc a4 r-part r-part-list" id="${part.index ? `doc-${part.index}` : 'doc'}">
      ${showHeader(part) ? html`<header class="r-header">
        <img src="/assets/logo.webp" alt="Charão Engenharia & Construção" class="r-logo">
        <div class="r-doctype"><div class="r-kicker">Check-list · lista de itens</div><div class="r-level">${t.code}</div></div>
      </header>
      <div class="r-rule"></div>
      <h1 class="r-list-title">${t.title}</h1>
      <div class="muted small">${t.project_code} · ${t.project_name} · Emissão ${fmtDateTime(new Date().toISOString())}${filterText ? ` · ${filterText}` : ''}</div>` : ''}
      <p class="r-list-sum"><b>${st.total}</b> ${st.total === 1 ? 'item' : 'itens'} · <b>${st.done}</b> concluído(s) · <b>${st.nao_conforme}</b> não conforme(s) em aberto · <b>${st.pending}</b> sem resposta${totalDays ? html` · <b>${String(totalDays).replace('.', ',')}</b> dia(s) de trabalho` : ''}${byWorker && when ? html` · até <b>${fmtDate(when)}</b>` : ''}</p>
      ${levels.length ? groupBy([...part.items].sort((a, b) => (part.order?.get(a.id) ?? a.seq) - (part.order?.get(b.id) ?? b.seq)), levels[0]).map(g => table(g.items, groupRow(g, 0), 1)) : table(part.items, '', 0)}
      ${show('assin') ? html`<div class="r-sign r-list-sign" style="grid-template-columns:repeat(2,1fr)">
        <div>${sigLine(S, sD(part, 'responsavel', 'Responsável', respName(part), t.assignee_id))}${(sep === 'responsavel' || byWorker) && part.name ? part.name : t.assignee_name || 'Responsável pelo check-list'}<div class="muted">${byWorker && part.name ? 'Profissional' : 'Responsável'}</div>${sigInfo(S, sD(part, 'responsavel', 'Responsável', respName(part), t.assignee_id))}</div>
        <div><span class="sig-line">${signedDate(S, sD(part, 'responsavel', '', '')) ? html`<b class="sig-date">${signedDate(S, sD(part, 'responsavel', '', ''))}</b>` : ''}</span> <div class="muted">Data</div></div>
      </div>` : ''}
      <footer class="r-footer"><span>Charão Engenharia & Construção · Check-list ${t.code}</span><span>Documento gerado pelo sistema Charão Gestão de Obras</span></footer>
    </article>`;
  };
  const fullDoc = part => {
    curPart = part;
    const items = part.items;
    const s = statsOf(items);
    const judged = s.conforme + s.nao_conforme;
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
      eff_status: i.resolved ? 'concluida' : i.overdue ? 'atrasada' : 'em_andamento', progress_pct: i.progress_pct,
      dep_key: `i:${i.id}`, preds: (c.item_deps?.[i.id]?.predecessors || []).filter(p => p.key.startsWith('i:')).map(p => ({ key: p.key, lag: p.lag_days })),
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

    const rows = itemRows(items);
    const itemsTitle = html`<div class="r-section"><h3 class="r-h">Itens (${items.length})</h3></div>`;
    const content = [
      show('resumo') ? html`<section class="r-section avoid">
          <h3 class="r-h">Resumo</h3>
          <div class="r-kpis">
            ${kpi('Itens', s.total, `${s.done} concluído(s) · ${s.pct}%`, '#2A3D50')}
            ${kpi('Conforme', s.conforme, judged ? `${fmtPct(Math.round((s.conforme / judged) * 100))} dos avaliados` : '', RES_COLOR.conforme)}
            ${kpi('Não conforme em aberto', s.nao_conforme, s.nc_total ? `${s.nc_total} registrada(s) no histórico` : 'nenhuma registrada', RES_COLOR.nao_conforme)}
            ${kpi('N/A', s.na, '', RES_COLOR.na)}
          </div>
          ${s.pending ? html`<p class="r-p" style="margin-top:6px"><b>${s.pending} item(ns) ainda sem resposta.</b></p>` : ''}
        </section>` : '',
      !sep && show('ncs') ? html`<section class="r-section avoid">
          ${ncTable('Não conformidades por ambiente', 'Ambiente / grupo', ncRows('grupo'))}
          ${hasSpecs ? html`<div style="height:8px"></div>${ncTable('Não conformidades por especialidade', 'Especialidade', ncRows('especialidade'))}` : ''}
          <p class="small muted" style="margin-top:4px">Todo item cadastrado conta como não conformidade (com ou sem foto). Pendente = ainda em aberto; resolvida = corrigida (Conforme) ou encerrada (N/A).</p>
        </section>` : '',
      ...(rows.length ? [html`${itemsTitle}${rows[0]}`, ...rows.slice(1)] : [itemsTitle]),
      show('assin') ? html`<section class="r-section avoid">
          <div class="r-sign" style="grid-template-columns:repeat(3,1fr)">
            <div>${sigLine(S, sD(part, 'responsavel', 'Responsável', respName(part), t.assignee_id))}${(sep === 'responsavel' || byWorker) && part.name ? part.name : t.assignee_name || 'Responsável pelo check-list'}<div class="muted">${byWorker && part.name ? 'Profissional' : sep === 'responsavel' ? 'Responsável' : 'Responsável pelo check-list'}</div>${sigInfo(S, sD(part, 'responsavel', 'Responsável', respName(part), t.assignee_id))}</div>
            <div>${sigLine(S, sD(part, 'conferente', 'Conferente', t.reviewer_name || '', t.reviewer_id))}${t.reviewer_name || ' '}<div class="muted">Conferente</div>${sigInfo(S, sD(part, 'conferente', 'Conferente', t.reviewer_name || '', t.reviewer_id))}</div>
            <div>${sigLine(S, sD(part, 'cliente', 'Cliente / Recebedor', ''))} <div class="muted">Cliente / Recebedor</div>${sigInfo(S, sD(part, 'cliente', 'Cliente / Recebedor', ''))}</div>
          </div>
        </section>` : '',
    ].filter(Boolean);
    const doc = html`
      <article class="doc a4 r-part" id="${part.index ? `doc-${part.index}` : 'doc'}">
        ${showHeader(part) ? html`<header class="r-header">
          <img src="/assets/logo.webp" alt="Charão Engenharia & Construção" class="r-logo">
          <div class="r-doctype"><div class="r-kicker">Check-list de vistoria${filterText ? ' · filtrado' : ''}</div><div class="r-level">${t.code}</div></div>
        </header>
        <div class="r-rule"></div>
        <section class="r-scope">
          <div><div class="r-lbl">Check-list</div><h1>${t.title}</h1>
            <div class="muted">${t.project_code} · ${t.project_name}${t.project_client ? ` · Cliente: ${t.project_client}` : ''}</div>
            ${t.description ? html`<p class="r-p" style="margin-top:6px">${t.description}</p>` : ''}</div>
          ${show('quadro') ? html`<dl class="r-meta">
            <dt>Responsável</dt><dd>${t.assignee_name || '—'}</dd>
            <dt>Prazo</dt><dd>${fmtDate(t.due_date)}</dd>
            <dt>Situação</dt><dd>${STATUS[t.eff_status]?.label || t.eff_status}</dd>
            ${t.delivered_at ? html`<dt>Entregue em</dt><dd>${fmtDateTime(t.delivered_at)}</dd>` : ''}
            ${t.reviewed_at ? html`<dt>Conferido por</dt><dd>${t.reviewer_name || '—'} · ${fmtDateTime(t.reviewed_at)}</dd>` : ''}
            <dt>Fotos</dt><dd>${PHOTO_RULE[c.photo_rule]}</dd>
            ${filterText ? html`<dt>Filtro</dt><dd><b>${filterText}</b> · ${items.length} de ${c.items.length} itens</dd>` : ''}
            <dt>Agrupamento</dt><dd>${[byWorker ? 'Profissional' : sep ? DIMS[sep].label : '', ...levels.map(l => DIMS[l].label)].filter(Boolean).join(' › ') || 'Sem agrupamento'}</dd>
            <dt>Emissão</dt><dd>${fmtDateTime(new Date().toISOString())}</dd>
          </dl>` : ''}
        </section>` : ''}
        ${part.label ? repeatTable(partHead(part), content) : html`${content}`}
        ${withGantt ? html`<section class="r-section r-gantt">
          <h3 class="r-h">Cronograma semanal dos itens (Gantt) <span class="muted small">(${dated.length} de ${items.length})${part.label ? ` · ${part.label}` : ''}</span></h3>
          ${ganttChart(ganttRows, { ref: today, weekly: true, groupLabel: ganttBy, color: r => ITEM_COLOR(r.item), statusOf: r => situation(r.item).t,
            noun: ['item(ns)', 'concluído(s)'], head: 'Item', legend: ganttLegend,
            note: `Barra = data de início até a data de término do item (sem início, aparece só a semana do término).${items.length > dated.length ? ` ${items.length - dated.length} item(ns) sem datas não aparecem no cronograma.` : ''}` })}
        </section>` : ''}
        <footer class="r-footer">
          <span>Charão Engenharia & Construção · ${title} ${t.code}</span>
          <span>Documento gerado pelo sistema Charão Gestão de Obras</span>
        </footer>
      </article>`;
    return doc;
  };

  return {
    title: `Check-list ${t.code}`,
    html: html`${printToolbar({
      back: `#/tarefas/${t.id}`, title: `Check-list — ${t.code} · ${t.title}`,
      extra: html`<span class="pt-opt" data-photos hidden></span><label class="pt-opt">Separar por <select data-sep><option value="">Não separar</option><option value="profissional" ${byWorker ? 'selected' : ''}>Profissional</option>${Object.entries(DIMS).map(([k, d]) => html`<option value="${k}" ${sep === k ? 'selected' : ''}>${d.label}</option>`)}</select></label>
        ${byWorker && workers.options.length ? html`<label class="pt-opt">Profissional <select data-flt="prof"><option value="">Todos</option>${workers.options.map(o => html`<option value="${o.key}" ${query.get('prof') === o.key ? 'selected' : ''}>${o.name}</option>`)}</select></label>` : ''}
        <label class="pt-opt">Formato <select data-fmt><option value="">Completo</option><option value="lista" ${compact ? 'selected' : ''}>Lista compacta</option></select></label>
        ${sep ? html`<span class="pt-opt"><span><b>${parts.length} ${parts.length === 1 ? 'parte' : 'partes'}</b>, cada uma em folha nova</span></span>` : ''}
        ${[0, 1, 2].map(n => html`<label class="pt-opt">${n === 0 ? 'Agrupar por' : n === 1 ? 'depois' : 'e'}
          <select data-level="${n}"><option value="">${n === 0 ? 'Sem agrupamento' : '—'}</option>${Object.entries(DIMS).map(([k, d]) => html`<option value="${k}" ${levels[n] === k ? 'selected' : ''}>${d.label}</option>`)}</select></label>`)}
        ${opts.groups.length > 1 ? html`<label class="pt-opt">Grupo <select data-flt="grupo"><option value="">Todos</option>${opts.groups.map(k => html`<option value="${k}" ${k === fGroup ? 'selected' : ''}>${optLabel(k, 'group')}</option>`)}</select></label>` : ''}
        ${opts.specs.length > 1 ? html`<label class="pt-opt">Especialidade <select data-flt="esp"><option value="">Todas</option>${opts.specs.map(k => html`<option value="${k}" ${k === fSpec ? 'selected' : ''}>${optLabel(k, 'spec')}</option>`)}</select></label>` : ''}
        ${opts.resps.length > 1 ? html`<label class="pt-opt">Responsável <select data-flt="resp"><option value="">Todos</option>${opts.resps.map(k => html`<option value="${k}" ${k === fResp ? 'selected' : ''}>${optLabel(k, 'resp')}</option>`)}</select></label>` : ''}
        ${compact ? '' : html`<label class="pt-opt"><input type="checkbox" id="fotos" ${withPhotos ? 'checked' : ''}>Incluir fotos</label>
        <label class="pt-opt"><input type="checkbox" id="gnt" ${withGantt ? 'checked' : ''}>Gantt semanal</label>`}
        <details class="pt-opt pt-show" ${showBoxOpen ? 'open' : ''}><summary>Informações</summary><div class="pt-show-list">
          ${[parts.length > 1 ? ['cab', 'Cabeçalho em cada parte'] : null,
            ...(compact ? [] : [['quadro', 'Quadro de dados do check-list'], ['resumo', 'Resumo'], sep ? null : ['ncs', 'Não conformidades por ambiente'], ['hist', 'Histórico do item'], ['quem', 'Quem respondeu e quando']]),
            ['assin', 'Assinaturas']].filter(Boolean).map(([k, label]) => html`<label><input type="checkbox" data-show="${k}" ${show(k) ? 'checked' : ''}>${label}</label>`)}
        </div></details>`,
    })}<div class="doc-stage">${parts.map(compact ? listDoc : fullDoc)}</div>`,
    mount(root, ctx) {
      bindSignatures(root, S, () => ctx.render());
      drawGanttLinks(root);
      setPageFooter(`Charão · Check-list ${t.code} · ${t.project_code}`);
      const photoNote = root.querySelector('[data-photos]');
      const photos = loadPhotos(root, (done, total) => {
        photoNote.hidden = done >= total;
        photoNote.textContent = `Preparando fotos: ${done} de ${total}`;
      });
      bindPrintToolbar(root, photos);
      const q = () => Object.fromEntries(new URLSearchParams(location.hash.split('?')[1] || ''));
      root.querySelector('[data-sep]').addEventListener('change', e => { ctx.setQuery({ ...q(), sep: e.target.value, prof: '' }); ctx.render(); });
      root.querySelector('[data-fmt]').addEventListener('change', e => { ctx.setQuery({ ...q(), fmt: e.target.value }); ctx.render(); });
      root.querySelector('#fotos')?.addEventListener('change', e => { ctx.setQuery({ ...q(), fotos: e.target.checked ? '' : '0' }); ctx.render(); });
      root.querySelectorAll('[data-flt]').forEach(sel => sel.addEventListener('change', () => { ctx.setQuery({ ...q(), [sel.dataset.flt]: sel.value }); ctx.render(); }));
      root.querySelector('#gnt')?.addEventListener('change', e => { ctx.setQuery({ ...q(), gantt: e.target.checked ? '' : '0' }); ctx.render(); });
      root.querySelector('.pt-show').addEventListener('toggle', e => { showBoxOpen = e.target.open; });
      root.querySelectorAll('[data-show]').forEach(c => c.addEventListener('change', () => { ctx.setQuery({ ...q(), [c.dataset.show]: c.checked ? '' : '0' }); ctx.render(); }));
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
