// Relatório A4 do check-list (termo de vistoria): resumo, itens por grupo, não conformidades, fotos e assinaturas.
import { html, api, STATUS, fmtDate, fmtDateTime, fmtPct } from '../core.js';
import { printToolbar, bindPrintToolbar, setPageFooter } from './print-common.js';
import { RESULT, PHOTO_RULE } from './checklist-ui.js';

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
  const groups = [];
  for (const it of c.items) {
    const g = groups.at(-1);
    if (g && g.name === (it.group || '')) g.items.push(it);
    else groups.push({ name: it.group || '', items: [it] });
  }
  const nc = c.items.filter(i => i.result === 'nao_conforme');
  const withFiles = c.items.filter(i => i.files.length);
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
          <dt>Emissão</dt><dd>${fmtDateTime(new Date().toISOString())}</dd>
        </dl>
      </section>

      <section class="r-section avoid">
        <h3 class="r-h">Resumo</h3>
        <div class="r-kpis">
          ${kpi('Itens', s.total, `${s.done} respondido(s) · ${s.pct}%`, '#2A3D50')}
          ${kpi('Conforme', s.conforme, judged ? `${fmtPct(Math.round((s.conforme / judged) * 100))} dos avaliados` : '', RES_COLOR.conforme)}
          ${kpi('Não conforme', s.nao_conforme, s.nao_conforme ? 'ver relação abaixo' : 'nenhuma pendência', RES_COLOR.nao_conforme)}
          ${kpi('N/A', s.na, '', RES_COLOR.na)}
        </div>
        ${s.total - s.done ? html`<p class="r-p" style="margin-top:6px"><b>${s.total - s.done} item(ns) ainda sem resposta.</b></p>` : ''}
      </section>

      <section class="r-section">
        <h3 class="r-h">Itens verificados</h3>
        <table class="r-table"><thead><tr><th style="width:5%">Nº</th><th>Item</th><th style="width:16%">Responsável</th><th style="width:13%">Resultado</th><th style="width:22%">Observação</th><th style="width:15%">Respondido</th></tr></thead>
          <tbody>${groups.map(g => html`
            ${g.name ? html`<tr class="r-grouprow"><td colspan="6"><span class="r-stage">${g.name}</span><span class="small muted">${g.items.filter(i => i.result).length}/${g.items.length}</span></td></tr>` : ''}
            ${g.items.map(i => html`<tr>
              <td class="num">${i.seq}</td><td>${i.text}${i.files.length ? html` <span class="small muted">· ${i.files.length} foto(s)</span>` : ''}</td>
              <td class="small">${i.responsible_name}</td><td>${resTag(i.result)}</td>
              <td class="small">${i.note || ''}</td>
              <td class="small">${i.result ? html`${i.answered_by_name || '—'}<div class="muted">${fmtDateTime(i.answered_at)}</div>` : '—'}</td></tr>`)}`)}</tbody></table>
      </section>

      ${nc.length ? html`<section class="r-section">
        <h3 class="r-h">Não conformidades (${nc.length})</h3>
        ${nc.map(i => html`<article class="r-evidence avoid">
          <header><span class="mono">Item ${i.seq}</span><b>${i.text}</b>${resTag(i.result)}</header>
          <div class="small">${i.group ? html`<span class="r-stage">${i.group}</span>` : ''}Responsável: ${i.responsible_name} · Registrado por ${i.answered_by_name || '—'} em ${fmtDateTime(i.answered_at)}</div>
          ${i.note ? html`<p><b>Problema:</b> ${i.note}</p>` : ''}
          ${withPhotos && i.files.length ? html`<div class="r-photos">${i.files.map(f => html`<figure><img src="/api/checklist-files/${f.id}" alt=""><figcaption>Item ${i.seq} · ${fmtDateTime(f.created_at)}</figcaption></figure>`)}</div>` : ''}
        </article>`)}
      </section>` : ''}

      ${withPhotos && withFiles.filter(i => i.result !== 'nao_conforme').length ? html`<section class="r-section">
        <h3 class="r-h">Registro fotográfico</h3>
        <div class="r-photos">${withFiles.filter(i => i.result !== 'nao_conforme').flatMap(i => i.files.map(f => html`<figure class="avoid"><img src="/api/checklist-files/${f.id}" alt="">
          <figcaption>Item ${i.seq} · ${i.text} · ${i.result ? RESULT[i.result].label : 'Pendente'}</figcaption></figure>`))}</div>
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
      extra: html`<label class="pt-opt"><input type="checkbox" id="fotos" ${withPhotos ? 'checked' : ''}>Incluir fotos</label>`,
    })}<div class="doc-stage">${doc}</div>`,
    mount(root, ctx) {
      setPageFooter(`Charão · Check-list ${t.code} · ${t.project_code}`);
      bindPrintToolbar(root);
      root.querySelector('#fotos').addEventListener('change', e => { ctx.setQuery({ fotos: e.target.checked ? '' : '0' }); ctx.render(); });
    },
  };
}
