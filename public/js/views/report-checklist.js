// Relatório A4 do check-list (termo de vistoria): resumo com as não conformidades por ambiente e lista única de itens
// (agrupada por grupo, responsável e data em até 3 níveis), com histórico e fotos quando houver, e assinaturas.
import { html, api, STATUS, fmtDate, fmtDateTime, fmtPct } from '../core.js';
import { printToolbar, bindPrintToolbar, setPageFooter } from './print-common.js';
import { RESULT, PHOTO_RULE } from './checklist-ui.js';
import { periodKey, periodInfo } from './periods.js';

// Dimensões de agrupamento (combináveis em até 3 níveis). Data = prazo do item.
const DIMS = {
  grupo: { label: 'Grupo', key: i => i.group || '', name: k => k || 'Sem grupo' },
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

export async function view({ params, query }) {
  const t = await api(`/tasks/${params.id}`);
  if (!t.checklist) throw new Error('Esta tarefa não é um check-list.');
  const c = t.checklist;
  const s = c.summary;
  const withPhotos = query.get('fotos') !== '0';
  const judged = s.conforme + s.nao_conforme;
  const levels = readLevels(query);
  // Situação do item no relatório
  const situation = i => i.open_nc ? { t: `Não conforme em aberto${i.nc_count > 1 ? ` · ${i.nc_count}x` : ''}`, c: RES_COLOR.nao_conforme }
    : i.result === 'conforme' ? { t: i.nc_count ? `Corrigido · ${i.nc_count}x NC` : 'Conforme', c: RES_COLOR.conforme }
      : i.result === 'na' ? { t: i.nc_count ? 'Encerrado (N/A)' : 'N/A', c: RES_COLOR.na } : { t: 'Pendente', c: '#A86F0E' };
  const fig = (f, label, color) => html`<figure><img src="/api/checklist-files/${f.id}" alt=""><figcaption>${label ? html`<b style="color:${color}">${label}</b> · ` : ''}${fmtDateTime(f.created_at)}</figcaption></figure>`;
  // Fotos do item, em ordem: todas as do cadastro e as de cada resposta do histórico (nada quando não há fotos)
  const photosOf = i => {
    if (!withPhotos) return '';
    const seen = new Set();
    const out = [];
    const add = (f, label, color) => { if (f && !seen.has(f.id)) { seen.add(f.id); out.push(fig(f, label, color)); } };
    i.refs.forEach(f => add(f, 'CADASTRO', '#C0392B'));
    for (const h of i.history.filter(h => !h.registration)) {
      const [label, color] = h.result === 'nao_conforme' ? ['NÃO CONFORME', '#C0392B'] : h.result === 'conforme' ? ['DEPOIS', '#2E8B57'] : ['N/A', '#6E7A86'];
      h.files.forEach(f => add(f, label, color));
    }
    i.files.forEach(f => add(f, i.open_nc ? 'NÃO CONFORME' : 'FOTO', '#46535F'));
    return out.length ? html`<div class="r-photos r-ph-2">${out}</div>` : '';
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
  // Resumo: não conformidades por ambiente (grupo)
  const byGroup = [...new Map(c.items.map(i => [i.group || '', null])).keys()].map(g => {
    const its = c.items.filter(i => (i.group || '') === g);
    const ncs = its.filter(i => i.nc_count > 0);
    const pend = ncs.filter(i => i.open_nc).length;
    return { name: g || 'Sem grupo', items: its.length, nc: ncs.length, pend, res: ncs.length - pend };
  });
  const tot = byGroup.reduce((a, g) => ({ items: a.items + g.items, nc: a.nc + g.nc, pend: a.pend + g.pend, res: a.res + g.res }), { items: 0, nc: 0, pend: 0, res: 0 });
  const pctRes = g => (g.nc ? fmtPct(Math.round((g.res / g.nc) * 100)) : '—');
  const title = 'Check-list';

  const doc = html`
    <article class="doc a4" id="doc">
      <header class="r-header">
        <img src="/assets/logo.webp" alt="Charão Engenharia & Construção" class="r-logo">
        <div class="r-doctype"><div class="r-kicker">Check-list de vistoria</div><div class="r-level">${t.code}</div></div>
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
        <h3 class="r-h">Não conformidades por ambiente</h3>
        <table class="r-table r-nc-table"><thead><tr><th>Ambiente / grupo</th><th class="num">Itens</th><th class="num">Não conformidades</th><th class="num">Pendentes</th><th class="num">Resolvidas</th><th class="num">% resolvidas</th></tr></thead>
          <tbody>${byGroup.map(g => html`<tr><td>${g.name}</td><td class="num">${g.items}</td><td class="num">${g.nc}</td>
            <td class="num ${g.pend ? 'late' : ''}">${g.pend}</td><td class="num">${g.res}</td><td class="num">${pctRes(g)}</td></tr>`)}
            <tr class="r-total"><td><b>Total</b></td><td class="num"><b>${tot.items}</b></td><td class="num"><b>${tot.nc}</b></td>
              <td class="num ${tot.pend ? 'late' : ''}"><b>${tot.pend}</b></td><td class="num"><b>${tot.res}</b></td><td class="num"><b>${pctRes(tot)}</b></td></tr></tbody></table>
        <p class="small muted" style="margin-top:4px">Item cadastrado com foto conta como não conformidade. Pendente = ainda em aberto; resolvida = corrigida (Conforme) ou encerrada (N/A).</p>
      </section>

      <section class="r-section">
        <h3 class="r-h">Itens (${c.items.length})</h3>
        ${blocks(c.items)}
      </section>

      <section class="r-section avoid">
        <div class="r-sign" style="grid-template-columns:repeat(3,1fr)">
          <div><span></span>${t.assignee_name || 'Responsável pelo check-list'}<div class="muted">Responsável pelo check-list</div></div>
          <div><span></span>${t.reviewer_name || ' '}<div class="muted">Conferente</div></div>
          <div><span></span> <div class="muted">Cliente / Recebedor</div></div>
        </div>
      </section>
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
        <label class="pt-opt"><input type="checkbox" id="fotos" ${withPhotos ? 'checked' : ''}>Incluir fotos</label>`,
    })}<div class="doc-stage">${doc}</div>`,
    mount(root, ctx) {
      setPageFooter(`Charão · Check-list ${t.code} · ${t.project_code}`);
      bindPrintToolbar(root);
      const q = () => Object.fromEntries(new URLSearchParams(location.hash.split('?')[1] || ''));
      root.querySelector('#fotos').addEventListener('change', e => { ctx.setQuery({ ...q(), fotos: e.target.checked ? '' : '0' }); ctx.render(); });
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
