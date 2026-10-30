// Relatório detalhado da Folha de Campo (A4): obra, período, profissional e função como filtros; partes escolhidas
// na barra (presença por dia de cada pessoa, equipe por dia, por pessoa, por serviço/função, empreitadas, medição do
// terceiro, atividades e pagamentos). Valores só para quem tem a seção Folha de Campo.
import { html, api, fmtDate, fmtDateTime } from '../core.js';
import { printToolbar, bindPrintToolbar, setPageFooter } from './print-common.js';

const BRL = new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' });
const money = v => BRL.format(Number(v) || 0);
const n2 = v => String(Math.round((Number(v) || 0) * 100) / 100).replace('.', ',');
const dm = d => (d ? fmtDate(d).slice(0, 5) : '—');
const WD = ['D', 'S', 'T', 'Q', 'Q', 'S', 'S'];
const wd = d => new Date(`${d}T12:00:00Z`).getUTCDay();
const qLabel = q => (q === 1 ? '1' : q === 0.5 ? '½' : q ? n2(q) : '');
// Aproveitamento da página: bloco pequeno fica inteiro; bloco grande continua na mesma página (linhas não se partem
// e o cabeçalho da tabela se repete), em vez de pular inteiro e deixar espaço em branco
const KEEP_ROWS = 12;
const keep = rows => (rows <= KEEP_ROWS ? 'avoid' : 'fr-flow');

// Partes do relatório: [chave, rótulo, só com valores]
const PARTS = [
  ['pres', 'Presença por dia'], ['dia', 'Equipe por dia'], ['pes', 'Por pessoa'], ['serv', 'Por serviço e função'],
  ['emp', 'Empreitadas'], ['med', 'Medição do terceiro', true], ['bm', 'BM anexado', true], ['pag', 'Pagamentos', true], ['ativ', 'Atividades'],
];

// BM em PDF: cada página vira imagem no próprio navegador (pdf.js servido pelo site) para sair na impressão.
// Alta resolução (~300 dpi numa folha A4, limitada a 14 megapixels por página) para o texto do BM ficar nítido.
const PDFJS = '/vendor/pdfjs/pdf.min.js';
const MAX_PAGES = 30;
const DPI_SCALE = 300 / 72, MAX_PIXELS = 14e6;
const canvasUrl = canvas => new Promise(res => canvas.toBlob(b => res(b ? URL.createObjectURL(b) : canvas.toDataURL('image/jpeg', 0.93)), 'image/jpeg', 0.93));
async function renderPdfs(root) {
  const boxes = [...root.querySelectorAll('[data-pdf]')];
  if (!boxes.length) return;
  const lib = await import(PDFJS);
  lib.GlobalWorkerOptions.workerSrc = '/vendor/pdfjs/pdf.worker.min.js';
  for (const box of boxes) {
    try {
      const doc = await lib.getDocument({ url: box.dataset.pdf, isEvalSupported: false, withCredentials: true }).promise;
      const n = Math.min(doc.numPages, MAX_PAGES);
      const out = [];
      for (let i = 1; i <= n; i++) {
        const page = await doc.getPage(i);
        const base = page.getViewport({ scale: 1 });
        const vp = page.getViewport({ scale: Math.min(DPI_SCALE, Math.sqrt(MAX_PIXELS / (base.width * base.height))) });
        const canvas = document.createElement('canvas');
        canvas.width = Math.ceil(vp.width); canvas.height = Math.ceil(vp.height);
        const ctx = canvas.getContext('2d');
        ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, canvas.width, canvas.height);
        await page.render({ canvasContext: ctx, viewport: vp }).promise;
        const src = await canvasUrl(canvas);
        canvas.width = canvas.height = 0;
        out.push({ land: vp.width > vp.height, fig: html`<figure class="fr-bmp"><img src="${src}" alt="Página ${i} do BM"><figcaption>${box.dataset.name} · página ${i} de ${doc.numPages}</figcaption></figure>` });
      }
      // Folha deitada bem aproveitada: página deitada ocupa a folha; duas páginas em pé seguidas ficam lado a lado
      const sheets = [];
      for (let k = 0; k < out.length; k++) {
        if (!out[k].land && out[k + 1] && !out[k + 1].land) { sheets.push(html`<div class="fr-bmsheet is-pair">${out[k].fig}${out[k + 1].fig}</div>`); k++; }
        else sheets.push(html`<div class="fr-bmsheet">${out[k].fig}</div>`);
      }
      box.innerHTML = html`${sheets}${doc.numPages > n ? html`<p class="small muted">Mostradas ${n} de ${doc.numPages} páginas. O PDF completo está no sistema.</p>` : ''}`.toString();
    } catch {
      box.innerHTML = html`<p class="small late">Não foi possível mostrar o PDF "${box.dataset.name}". Abra pelo sistema.</p>`.toString();
    }
  }
}

export async function view({ query, setQuery, render }) {
  const sh = await api('/field/sheets');
  const mny = sh.can_money;
  const obra = Number(query.get('obra')) || sh.projects[0]?.id || 0;
  const p = sh.projects.find(x => x.id === obra);
  if (!p) throw new Error('Nenhuma obra liberada para a Folha de Campo.');
  const de = query.get('de') || '', ate = query.get('ate') || '';
  const pessoa = Number(query.get('pessoa')) || 0, funcao = query.get('funcao') || '';
  const off = new Set((query.get('sem') || '').split(',').filter(Boolean));
  const on = k => !off.has(k) && (mny || !PARTS.find(x => x[0] === k)?.[2]);

  // Folhas da obra no período (pelo cruzamento das datas) e o detalhe de cada uma
  const list = sh.sheets.filter(s => s.project_id === obra && (!de || s.end_date >= de) && (!ate || s.start_date <= ate))
    .sort((a, b) => a.start_date.localeCompare(b.start_date) || a.id - b.id);
  const [sheets, meas] = await Promise.all([Promise.all(list.map(s => api(`/field/sheets/${s.id}`))), mny ? api('/field/measurements', { query: { obra } }) : null]);
  // BM das medições que cobrem alguma folha do relatório (ou todas, sem filtro de período)
  const inReport = new Set(sheets.map(s => s.id));
  // Em ordem cronológica das medições
  const bms = meas && on('bm') ? meas.measurements.filter(m => m.files.length && (!(de || ate) || m.sheets.some(s => inReport.has(s.id)))).reverse() : [];

  // Filtros de pessoa e função valem para as partes de mão de obra
  const allPeople = new Map();
  for (const s of sheets) for (const e of s.people) allPeople.set(e.worker_id, { id: e.worker_id, name: e.name, role: e.role || '' });
  const roles = [...new Set([...allPeople.values()].map(x => x.role).filter(Boolean))].sort((a, b) => a.localeCompare(b, 'pt-BR'));
  const keep = e => (!pessoa || e.worker_id === pessoa) && (!funcao || (e.role || '') === funcao);
  const blocks = sheets.map(s => ({ ...s, people: s.people.filter(keep) }));

  // Agregados
  const byPerson = new Map(), bySvc = new Map(), byRole = new Map(), byDay = new Map();
  for (const s of blocks) {
    for (const e of s.people) {
      const present = Object.values(e.days).filter(v => Number(v) > 0).length;
      const a = byPerson.get(e.worker_id) || { name: e.name, role: e.role, sheets: 0, days: 0, diarias: 0, total: 0, client: 0, company: 0 };
      a.sheets++; a.days += present; a.diarias += e.diarias; a.total += e.total || 0; a.client += e.client_paid || 0; a.company += e.company || 0;
      byPerson.set(e.worker_id, a);
      const sv = e.service || 'Sem apropriação';
      const b = bySvc.get(sv) || { name: sv, diarias: 0, value: 0, people: new Set() };
      b.diarias += e.diarias; b.value += e.total || 0; b.people.add(e.worker_id); bySvc.set(sv, b);
      const rl = e.role || 'Sem função';
      const c = byRole.get(rl) || { name: rl, diarias: 0, value: 0, people: new Set() };
      c.diarias += e.diarias; c.value += e.total || 0; c.people.add(e.worker_id); byRole.set(rl, c);
      for (const [d, v] of Object.entries(e.days)) {
        if (!(Number(v) > 0)) continue;
        const x = byDay.get(d) || { n: 0, q: 0 };
        x.n++; x.q += Number(v); byDay.set(d, x);
      }
    }
  }
  const people = [...byPerson.values()].sort((a, b) => b.diarias - a.diarias || a.name.localeCompare(b.name, 'pt-BR'));
  const svcs = [...bySvc.values()].sort((a, b) => (mny ? b.value - a.value : b.diarias - a.diarias));
  const fns = [...byRole.values()].sort((a, b) => b.diarias - a.diarias);
  const tot = {
    diarias: people.reduce((a, x) => a + x.diarias, 0), mo: people.reduce((a, x) => a + x.total, 0),
    emp: blocks.reduce((a, s) => a + s.contracts.reduce((t, c) => t + (c.amount || 0), 0), 0),
    client: people.reduce((a, x) => a + x.client, 0) + blocks.reduce((a, s) => a + s.contracts.reduce((t, c) => t + (c.client_paid || 0), 0), 0),
  };
  const filtered = !!(pessoa || funcao);
  const allDays = blocks.flatMap(s => s.days);
  const maxQ = Math.max(1, ...[...byDay.values()].map(x => x.q));
  const periodo = sheets.length ? `${fmtDate(sheets[0].start_date)} a ${fmtDate(sheets.at(-1).end_date)}` : '—';

  // Filtros e partes (barra, fora da impressão)
  const go = over => { const q = { obra, de, ate, pessoa: pessoa || '', funcao, sem: [...off].join(','), ...over }; setQuery(q); render(); };
  const wide = window.matchMedia('(min-width: 721px)').matches;
  const extra = html`<details class="fr-opts" ${wide ? 'open' : ''}><summary>Filtros e partes do relatório</summary><div class="fr-optl"><label class="pt-opt">Obra <select id="fr-obra">${sh.projects.map(x => html`<option value="${x.id}" ${x.id === obra ? 'selected' : ''}>${x.code}</option>`)}</select></label>
    <label class="pt-opt">De <input type="date" id="fr-de" value="${de}"></label><label class="pt-opt">Até <input type="date" id="fr-ate" value="${ate}"></label>
    <label class="pt-opt">Pessoa <select id="fr-pes"><option value="">Todas</option>${[...allPeople.values()].sort((a, b) => a.name.localeCompare(b.name, 'pt-BR')).map(x => html`<option value="${x.id}" ${x.id === pessoa ? 'selected' : ''}>${x.name}</option>`)}</select></label>
    <label class="pt-opt">Função <select id="fr-fun"><option value="">Todas</option>${roles.map(r => html`<option ${r === funcao ? 'selected' : ''}>${r}</option>`)}</select></label>
    ${PARTS.filter(([, , m]) => mny || !m).map(([k, l]) => html`<label class="pt-opt"><input type="checkbox" data-part="${k}" ${on(k) ? 'checked' : ''}>${l}</label>`)}</div></details>`;

  const kpi = (l, v, sub, c = '#2A3D50') => html`<div class="r-kpi" style="--c:${c}"><div class="r-kpi-l">${l}</div><div class="r-kpi-v">${v}</div>${sub ? html`<div class="r-kpi-s">${sub}</div>` : ''}</div>`;
  // Presença: uma grade por folha (pessoa × dia), com o total de diárias e de dias presentes
  const presence = s => html`<div class="frp ${keep(s.people.length)}"><div class="frp-h"><b>${s.code}</b> · ${fmtDate(s.start_date)} a ${fmtDate(s.end_date)} <span class="muted">· ${s.people.length} pessoa(s) · ${n2(s.people.reduce((a, e) => a + e.diarias, 0))} diária(s)</span></div>
    <table class="frp-t"><thead><tr><th class="frp-n">Pessoa</th>${s.days.map(d => html`<th class="${[0, 6].includes(wd(d)) ? 'we' : ''}"><small>${WD[wd(d)]}</small>${d.slice(8, 10)}</th>`)}<th class="frp-s">Dias</th><th class="frp-s">Diárias</th></tr></thead>
    <tbody>${s.people.map(e => html`<tr><td class="frp-n"><b>${e.name}</b><small>${e.role || ''}${e.service ? ` · ${e.service}` : ''}</small></td>
      ${s.days.map(d => { const q = Number(e.days[d]) || 0; return html`<td class="${q === 1 ? 'q1' : q ? 'qh' : ''} ${[0, 6].includes(wd(d)) ? 'we' : ''}">${qLabel(q)}</td>`; })}
      <td class="frp-s">${Object.values(e.days).filter(v => Number(v) > 0).length}</td><td class="frp-s"><b>${n2(e.diarias)}</b></td></tr>`)}
      <tr class="frp-tot"><td class="frp-n">Pessoas no dia</td>${s.days.map(d => html`<td>${s.people.filter(e => Number(e.days[d]) > 0).length || ''}</td>`)}<td></td><td class="frp-s">${n2(s.people.reduce((a, e) => a + e.diarias, 0))}</td></tr></tbody></table></div>`;
  const bar = (v, max) => html`<div class="frb"><span style="width:${max ? Math.min(100, (v / max) * 100) : 0}%"></span></div>`;

  return {
    title: `Relatório da Folha de Campo · ${p.code}`,
    html: html`${printToolbar({ back: `#/campo?obra=${obra}`, title: `Relatório da Folha de Campo — ${p.code} · ${p.name}`, extra })}
    <div class="doc-stage"><article class="doc a4 fr-doc">
      <header class="r-header"><img src="/assets/logo.webp" alt="Charão Engenharia & Construção" class="r-logo">
        <div class="r-doctype"><div class="r-kicker">Folha de Campo</div><div class="r-level">Relatório detalhado</div></div></header>
      <div class="r-rule"></div>
      <section class="r-scope">
        <div><div class="r-lbl">Obra</div><h1>${p.code} · ${p.name}</h1><div class="muted">${p.client || ''}</div></div>
        <dl class="r-meta"><dt>Período</dt><dd>${de || ate ? `${de ? fmtDate(de) : 'início'} a ${ate ? fmtDate(ate) : 'hoje'}` : 'todas as folhas'}</dd>
          <dt>Folhas</dt><dd>${sheets.length ? `${sheets.length} (${periodo})` : 'nenhuma'}</dd>
          ${filtered ? html`<dt>Filtro</dt><dd>${[pessoa ? allPeople.get(pessoa)?.name : '', funcao].filter(Boolean).join(' · ')}</dd>` : ''}
          <dt>Emissão</dt><dd>${fmtDateTime(new Date().toISOString())}</dd></dl>
      </section>

      ${!sheets.length ? html`<p class="muted r-section">Nenhuma folha da obra no período escolhido.</p>` : html`
      <section class="r-section avoid"><h3 class="r-h">Resumo</h3><div class="r-kpis">
        ${kpi('Folhas', sheets.length, `${sheets.filter(s => s.status === 'aberta').length} aberta(s)`)}
        ${kpi('Pessoas', people.length, filtered ? 'no filtro' : 'na mão de obra própria', '#1F6FB2')}
        ${kpi('Diárias', n2(tot.diarias), `${byDay.size} dia(s) com equipe`, '#F26B21')}
        ${mny ? kpi('Total', money(tot.mo + (filtered ? 0 : tot.emp)), filtered ? 'mão de obra do filtro' : `mão de obra ${money(tot.mo)} · empreitadas ${money(tot.emp)}`, '#1F6B41')
          : kpi('Média por dia', byDay.size ? n2(tot.diarias / byDay.size) : '0', 'diárias por dia trabalhado', '#1F6B41')}
      </div>${mny && tot.client ? html`<p class="small muted" style="margin:6px 0 0">Pago pelo cliente: ${money(tot.client)} · empresa paga ${money(tot.mo + (filtered ? 0 : tot.emp) - tot.client)}</p>` : ''}
      ${meas?.measurements.length ? html`<h4 class="fr-h4" style="margin-top:10px">Saldo das folhas perante a medição do terceiro (obra até hoje)</h4><div class="r-kpis">
        ${kpi('Medido (BM)', money(meas.totals.measured), `${meas.measurements.length} medição(ões)`)}
        ${kpi('Folhas cobertas', money(meas.totals.covered), meas.totals.uncovered_sheets ? `${meas.totals.uncovered_sheets} folha(s) sem medição · ${money(meas.totals.uncovered_total)}` : 'todas as folhas com medição', '#1F6FB2')}
        ${kpi('Pago a mais', money(meas.totals.paid_more), 'folhas acima do medido', '#C0392B')}
        ${kpi('Sobrando', money(meas.totals.left_over), `saldo ${money(meas.totals.diff)}`, '#1F6B41')}
      </div>` : ''}</section>

      ${on('pres') ? html`<section class="r-section"><h3 class="r-h">Presença por dia</h3>
        <p class="small muted fr-leg"><span class="frl q1">1</span> diária <span class="frl qh">½</span> meia diária <span class="frl we"></span> fim de semana</p>
        ${blocks.filter(s => s.people.length).map(presence)}</section>` : ''}

      ${on('dia') && byDay.size ? html`<section class="r-section avoid"><h3 class="r-h">Equipe por dia</h3>
        <div class="frd">${[...new Set(allDays)].sort().map(d => { const x = byDay.get(d) || { n: 0, q: 0 }; return html`<div class="frd-c ${[0, 6].includes(wd(d)) ? 'we' : ''}" title="${dm(d)}: ${x.n} pessoa(s)">
          <em>${x.n || ''}</em><div class="frd-col"><span style="height:${(x.q / maxQ) * 100}%"></span></div><small>${WD[wd(d)]}<br>${d.slice(8, 10)}</small></div>`; })}</div>
        <p class="small muted" style="margin:4px 0 0">Número sobre a coluna: pessoas no dia · altura: diárias do dia.</p></section>` : ''}

      ${on('pes') && people.length ? html`<section class="r-section ${keep(people.length)}"><h3 class="r-h">Por pessoa</h3>
        <table class="r-table"><thead><tr><th>Pessoa</th><th>Função</th><th class="num">Folhas</th><th class="num">Dias</th><th class="num">Diárias</th>${mny ? html`<th class="num">Valor</th><th class="num">Cliente</th><th class="num">Empresa paga</th>` : ''}</tr></thead>
        <tbody>${people.map(x => html`<tr><td>${x.name}</td><td class="small">${x.role || '—'}</td><td class="num">${x.sheets}</td><td class="num">${x.days}</td><td class="num"><b>${n2(x.diarias)}</b></td>
          ${mny ? html`<td class="num">${money(x.total)}</td><td class="num">${x.client ? money(x.client) : '—'}</td><td class="num">${money(x.company)}</td>` : ''}</tr>`)}
          <tr class="fr-sum"><td colspan="4">Total</td><td class="num">${n2(tot.diarias)}</td>${mny ? html`<td class="num">${money(tot.mo)}</td><td class="num">${money(people.reduce((a, x) => a + x.client, 0))}</td><td class="num">${money(people.reduce((a, x) => a + x.company, 0))}</td>` : ''}</tr></tbody></table></section>` : ''}

      ${on('serv') && people.length ? html`<section class="r-section ${keep(Math.max(svcs.length, fns.length) * 2)}"><h3 class="r-h">Por serviço e por função</h3><div class="fr-2">
        <div><h4 class="fr-h4">Serviço (apropriação)</h4><ul class="fr-bars">${svcs.map(x => html`<li><div><span>${x.name}</span><b>${mny ? money(x.value) : `${n2(x.diarias)} diária(s)`}</b></div>${bar(mny ? x.value : x.diarias, mny ? svcs[0].value : svcs[0].diarias)}<small>${n2(x.diarias)} diária(s) · ${x.people.size} pessoa(s)</small></li>`)}</ul></div>
        <div><h4 class="fr-h4">Função</h4><ul class="fr-bars">${fns.map(x => html`<li><div><span>${x.name}</span><b>${n2(x.diarias)} diária(s)</b></div>${bar(x.diarias, fns[0].diarias)}<small>${x.people.size} pessoa(s)${mny ? ` · ${money(x.value)}` : ''}</small></li>`)}</ul></div>
      </div></section>` : ''}

      ${on('emp') && !filtered && blocks.some(s => s.contracts.length) ? html`<section class="r-section ${keep(blocks.reduce((a, s) => a + s.contracts.length, 0))}"><h3 class="r-h">Empreitadas</h3>
        <table class="r-table"><thead><tr><th>Folha</th><th>Serviço</th><th>Empreiteiro</th><th class="num">Nesta folha</th><th class="num">Acumulado</th>${mny ? html`<th class="num">Medido</th>` : ''}</tr></thead>
        <tbody>${blocks.flatMap(s => s.contracts.map(c => html`<tr><td class="small nowrap">${s.code}</td><td>${c.service}</td><td class="small">${c.worker_name}</td><td class="num">${n2(c.pct)}%</td><td class="num">${n2(c.after_pct)}%</td>${mny ? html`<td class="num">${money(c.amount)}</td>` : ''}</tr>`))}</tbody></table></section>` : ''}

      ${meas && on('med') && meas.measurements.length ? html`<section class="r-section ${keep(meas.measurements.length + 4)}"><h3 class="r-h">Medição do terceiro x folhas</h3>
        <table class="r-table"><thead><tr><th>Data</th><th>Terceiro</th><th>Folhas</th><th class="num">Medido</th><th class="num">Folhas</th><th class="num">Diferença</th><th>Resultado</th></tr></thead>
        <tbody>${meas.measurements.map(m => html`<tr><td class="small nowrap">${fmtDate(m.ref_date)}</td><td>${m.supplier || '—'}</td><td class="small">${m.sheets.map(s => s.code).join(', ') || '—'}</td>
          <td class="num">${money(m.amount)}</td><td class="num">${money(m.sheets_total)}</td><td class="num ${m.diff < -0.004 ? 'late' : ''}">${money(m.diff)}</td>
          <td class="small"><b>${{ pago_mais: 'Pago a mais', pago_menos: 'Pago a menos', igual: 'Igual', sem_folhas: 'Sem folhas' }[m.result]}</b></td></tr>`)}
          <tr class="fr-sum"><td colspan="3">Total da obra</td><td class="num">${money(meas.totals.measured)}</td><td class="num">${money(meas.totals.covered)}</td><td class="num">${money(meas.totals.diff)}</td><td class="small">${meas.totals.uncovered_sheets ? `${meas.totals.uncovered_sheets} folha(s) sem medição` : ''}</td></tr></tbody></table></section>` : ''}

      ${on('pag') && mny ? html`<section class="r-section ${keep(sheets.length)}"><h3 class="r-h">Pagamentos por folha</h3>
        <table class="r-table"><thead><tr><th>Folha</th><th>Período</th><th>Situação</th><th class="num">Total</th><th class="num">Cliente</th><th class="num">Empresa paga</th><th>Pagamento</th></tr></thead>
        <tbody>${sheets.map(s => html`<tr><td class="nowrap"><b>${s.code}</b></td><td class="small nowrap">${dm(s.start_date)} a ${dm(s.end_date)}</td><td class="small">${s.status === 'fechada' ? 'Fechada' : 'Aberta'}</td>
          <td class="num">${money(s.totals.total)}</td><td class="num">${s.totals.client ? money(s.totals.client) : '—'}</td><td class="num">${money(s.totals.company)}</td>
          <td class="small">${s.payment ? (s.payment.status === 'paga' ? `Pago${s.payment.paid_date ? ` ${dm(s.payment.paid_date)}` : ''}` : `A pagar ${dm(s.payment.due_date)}`) : s.status === 'aberta' ? 'folha aberta' : '—'}</td></tr>`)}</tbody></table></section>` : ''}

      ${on('ativ') && sheets.some(s => s.activities) ? html`<section class="r-section"><h3 class="r-h">Atividades desenvolvidas</h3>
        ${sheets.filter(s => s.activities).map(s => html`<div class="fr-act avoid"><b>${s.code} · ${dm(s.start_date)} a ${dm(s.end_date)}</b><p class="r-p pre">${s.activities}</p></div>`)}</section>` : ''}

      ${bms.length ? html`<section class="r-section fr-bms"><h3 class="r-h">Anexo · BM da medição do terceiro</h3>
        ${bms.map(m => html`<div class="fr-bm"><div class="fr-bm-h"><b>${m.supplier || 'Terceiro'}</b> · medição de ${fmtDate(m.ref_date)} · ${money(m.amount)}${m.sheets.length ? ` · folhas ${m.sheets.map(s => s.code).join(', ')}` : ''}</div>
          ${m.files.map(f => (f.mime === 'application/pdf'
            ? html`<div class="fr-bmpdf" data-pdf="/api/field-measurement-files/${f.id}" data-name="${f.original_name || 'BM.pdf'}"><p class="small muted">Carregando o PDF "${f.original_name || 'BM.pdf'}"…</p></div>`
            : html`<figure class="fr-bmp"><img src="/api/field-measurement-files/${f.id}" alt="BM"><figcaption>${f.original_name || 'BM (imagem)'}</figcaption></figure>`))}
        </div>`)}</section>` : ''}
      `}

      <footer class="r-footer"><span>Charão Engenharia & Construção · Folha de Campo · ${p.code}</span><span>Documento gerado pelo sistema Charão Gestão de Obras</span></footer>
    </article></div>`,
    mount(root) {
      bindPrintToolbar(root);
      setPageFooter(`Charão · Folha de Campo · ${p.code} · ${p.name}`);
      // Enquanto as páginas do BM em PDF são preparadas, o botão de imprimir espera
      if (root.querySelector('[data-pdf]')) {
        const pb = root.querySelector('#do-print');
        const label = pb.innerHTML;
        pb.disabled = true; pb.textContent = 'Preparando o BM…';
        renderPdfs(root).finally(() => { pb.disabled = false; pb.innerHTML = label; });
      }
      root.querySelector('#fr-obra').addEventListener('change', e => go({ obra: e.target.value, pessoa: '', funcao: '' }));
      root.querySelector('#fr-de').addEventListener('change', e => go({ de: e.target.value }));
      root.querySelector('#fr-ate').addEventListener('change', e => go({ ate: e.target.value }));
      root.querySelector('#fr-pes').addEventListener('change', e => go({ pessoa: e.target.value }));
      root.querySelector('#fr-fun').addEventListener('change', e => go({ funcao: e.target.value }));
      root.querySelectorAll('[data-part]').forEach(c => c.addEventListener('change', () => {
        if (c.checked) off.delete(c.dataset.part); else off.add(c.dataset.part);
        go({ sem: [...off].join(',') });
      }));
    },
  };
}
