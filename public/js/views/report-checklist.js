// Relatório A4 do check-list (termo de vistoria): resumo, itens agrupados (grupo, responsável e data, em até 3 níveis),
// não conformidades com fotos e assinaturas.
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
const resTag = r => (r ? html`<span class="r-st" style="--c:${RES_COLOR[r]}">${RESULT[r].label}</span>` : html`<span class="r-st" style="--c:#A86F0E">Pendente</span>`);
const kpi = (label, value, sub, color) => html`<div class="r-kpi" style="--c:${color}"><div class="r-kpi-l">${label}</div><div class="r-kpi-v">${value}</div>${sub ? html`<div class="r-kpi-s">${sub}</div>` : ''}</div>`;

export async function view({ params, query }) {
  const t = await api(`/tasks/${params.id}`);
  if (!t.checklist) throw new Error('Esta tarefa não é um check-list.');
  const c = t.checklist;
  const s = c.summary;
  const withPhotos = query.get('fotos') !== '0';
  const judged = s.conforme + s.nao_conforme;
  const levels = readLevels(query);
  // Itens que tiveram não conformidade (em aberto ou já corrigidos)
  const nc = c.items.filter(i => i.nc_count > 0);
  const itemRow = i => html`<tr>
      <td class="num">${i.seq}</td><td>${i.text}${i.files.length ? html` <span class="small muted">· ${i.files.length} foto(s)</span>` : ''}
        ${i.description ? html`<div class="small muted">${i.description}</div>` : ''}
        ${i.due_date ? html`<div class="small ${i.overdue ? 'late' : 'muted'}">Prazo: ${fmtDate(i.due_date)}${i.overdue ? ' · atrasado' : ''}</div>` : ''}</td>
      <td class="small">${i.responsible_name}</td><td>${resTag(i.result)}${i.nc_count ? html`<div class="small" style="color:#C0392B;margin-top:2px">${i.result === 'conforme' ? 'corrigido · ' : ''}NC ${i.nc_count}x</div>` : ''}</td>
      <td class="small">${i.note || ''}</td>
      <td class="small">${i.result ? html`${i.answered_by_name || '—'}<div class="muted">${fmtDateTime(i.answered_at)}</div>` : '—'}</td></tr>`;
  // Linhas da tabela com cabeçalho de cada nível de agrupamento (recuado conforme o nível)
  const rows = (items, depth = 0) => {
    const list = [...items].sort((a, b) => a.seq - b.seq);
    if (depth >= levels.length) return html`${list.map(itemRow)}`;
    return html`${groupBy(list, levels[depth]).map(g => html`
      <tr class="r-grouprow r-lvl-${depth}"><td colspan="6" style="padding-left:${6 + depth * 16}px">
        <span class="r-stage">${DIMS[levels[depth]].label}: ${g.name}</span>
        <span class="small muted">${g.items.filter(i => i.resolved).length}/${g.items.length} concluído(s)${g.items.some(i => i.result === 'nao_conforme') ? ` · ${g.items.filter(i => i.result === 'nao_conforme').length} NC em aberto` : ''}</span></td></tr>
      ${rows(g.items, depth + 1)}`)}`;
  };
  const ncPhoto = f => html`<figure><img src="/api/checklist-files/${f.id}" alt=""><figcaption>${fmtDateTime(f.created_at)}</figcaption></figure>`;
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

      <section class="r-section">
        <h3 class="r-h">Itens verificados</h3>
        <table class="r-table"><thead><tr><th style="width:5%">Nº</th><th>Item</th><th style="width:16%">Responsável</th><th style="width:13%">Resultado</th><th style="width:22%">Observação</th><th style="width:15%">Respondido</th></tr></thead>
          <tbody>${rows(c.items)}</tbody></table>
      </section>

      ${nc.length ? html`<section class="r-section">
        <h3 class="r-h">Não conformidades (${nc.length} item(ns) · ${s.nc_total} registro(s))</h3>
        ${nc.map(i => html`<article class="r-evidence avoid">
          <header><span class="mono">Item ${i.seq}</span><b>${i.text}</b>${i.result === 'nao_conforme' ? html`<span class="r-st" style="--c:#C0392B">Em aberto · ${i.nc_count}x</span>` : html`<span class="r-st" style="--c:#2E8B57">Corrigido · ${i.nc_count}x NC</span>`}</header>
          <div class="small">${i.group ? html`<span class="r-stage">${i.group}</span>` : ''}Responsável: ${i.responsible_name}</div>
          <ol class="small" style="margin:4px 0 0;padding-left:16px">${i.history.map(h => html`<li><b>${RESULT[h.result].label}</b> · ${h.user_name || '—'} · ${fmtDateTime(h.created_at)}${h.reason ? ` · Justificativa: ${h.reason}` : ''}${h.note ? ` · ${h.note}` : ''}</li>`)}</ol>
          ${withPhotos && i.before && i.after ? html`<div class="r-photos" style="grid-template-columns:repeat(2,1fr)">
              <figure><img src="/api/checklist-files/${i.before.id}" alt=""><figcaption><b style="color:#C0392B">ANTES</b> · não conforme · ${fmtDateTime(i.before.created_at)}</figcaption></figure>
              <figure><img src="/api/checklist-files/${i.after.id}" alt=""><figcaption><b style="color:#2E8B57">DEPOIS</b> · conforme · ${fmtDateTime(i.after.created_at)}</figcaption></figure></div>`
            : withPhotos && i.cover ? html`<div class="r-photos" style="grid-template-columns:repeat(2,1fr)">${ncPhoto(i.cover)}</div>` : ''}
        </article>`)}
      </section>` : ''}

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
        <label class="pt-opt"><input type="checkbox" id="fotos" ${withPhotos ? 'checked' : ''}>Fotos das não conformidades</label>`,
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
