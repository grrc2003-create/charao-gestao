// Impressão (A4) dos Processos da Empresa: ficha de um processo ou o manual completo
// (capa, mapa de processos, uma ficha por processo e resumo).
import { html, api, fmtDate, todayISO } from '../core.js';
import { printToolbar, bindPrintToolbar, setPageFooter } from './print-common.js';
import { respColors, richText, LINK_KIND } from './processes.js';

function processDoc(p, { first = false, header = '' } = {}) {
  const c = p.content;
  const colors = respColors(c.steps);
  const box = (label, body) => (body ? html`<div class="pd-box avoid"><div class="r-lbl">${label}</div>${body}</div>` : '');
  return html`<section class="pd ${first ? '' : 'r-break pd-new'}">${header}
    <div class="pd-head">
      <div><div class="r-kicker">${p.code}${c.area ? ` · ${c.area}` : ''}</div><h1>${c.title}</h1></div>
      ${c.frequency ? html`<div class="pd-freq"><small>Frequência</small>${c.frequency}</div>` : ''}
    </div>
    <div class="pd-obj"><div class="r-lbl">Objetivo</div><p class="r-p">${c.objective}</p>
      ${c.erp_module ? html`<div class="pd-erp"><b>Módulo no ERP:</b> ${c.erp_module}</div>` : ''}
      ${c.links?.length ? html`<div class="pd-links">${c.links.map(l => html`<div><b>${(LINK_KIND[l.kind] || LINK_KIND.link)[1]} ${l.label}</b> <span class="muted">${l.url}</span></div>`)}</div>` : ''}
    </div>
    <h3 class="r-h">Fluxo de etapas</h3>
    <table class="r-table pd-flow"><thead><tr><th class="num">Nº</th><th>Responsável</th><th>Atividade</th><th>Controle</th></tr></thead>
      <tbody>${c.steps.map((s, i) => html`<tr class="${s.control ? 'is-ctl' : ''}">
        <td class="num"><span class="pd-n" style="--c:${colors.get(s.responsible)}">${i + 1}</span></td>
        <td><b style="color:${colors.get(s.responsible)}">${s.responsible}</b></td>
        <td>${s.activity}${s.details ? html`<div class="pd-how">${richText(s.details)}</div>` : ''}</td>
        <td class="small">${s.control ? html`<b class="pd-ctl">◆ Ponto de controle</b>${s.fail || s.back_to ? html`<div class="pd-fail">↩ ${s.fail || 'Não conforme'}${s.back_to ? ` (volta à etapa ${s.back_to})` : ''}</div>` : ''}` : ''}</td>
      </tr>`)}</tbody></table>
    <div class="pd-grid">
      ${box('Entradas', c.inputs ? html`<p class="r-p pre">${c.inputs}</p>` : '')}
      ${box('Saídas', c.outputs ? html`<p class="r-p pre">${c.outputs}</p>` : '')}
      ${box('Regras e cuidados', c.rules ? html`<p class="r-p pre">${c.rules}</p>` : '')}
      ${box('Indicadores', c.indicators?.length ? html`<ul class="pd-ind">${c.indicators.map(x => html`<li>${x}</li>`)}</ul>` : '')}
      ${box('Processos relacionados', c.related_items?.length ? html`<p class="r-p">${c.related_items.map((r, i) => html`${i ? ' · ' : ''}<b>${r.code}</b> ${r.title}`)}</p>` : '')}
    </div>
    <div class="pd-foot muted small">${p.version ? `Versão ${p.version}${p.published_at ? ` · publicada em ${fmtDate(p.published_at.slice(0, 10))}` : ''}` : 'Rascunho (não publicado)'}${p.owner_name ? ` · Responsável pelo processo: ${p.owner_name}` : ''}</div>
  </section>`;
}

const docHeader = kicker => html`<header class="r-header">
  <img src="/assets/logo.webp" alt="Charão Engenharia & Construção" class="r-logo">
  <div class="r-doctype"><div class="r-kicker">${kicker}</div><div class="r-level">Documento interno</div></div>
</header><div class="r-rule"></div>`;

// Ficha de um processo
export async function one({ params, query }) {
  const ver = query.get('ver') || '';
  const p = await api(`/processes/${params.id}`, { query: { ver } });
  const doc = { ...p, version: typeof p.showing === 'number' ? p.showing : p.showing === 'rascunho' ? 0 : p.version };
  setPageFooter(`${p.code} · ${p.content.title} · impresso em ${fmtDate(todayISO())}`);
  return {
    title: `${p.code} · ${p.content.title}`,
    html: html`${printToolbar({ back: `#/processos/${p.id}`, title: `${p.code} · ${p.content.title}` })}
      <div class="doc-stage"><article class="doc a4 pd-doc">${docHeader('Processo da empresa')}${processDoc(doc, { first: true })}</article></div>`,
    mount: bindPrintToolbar,
  };
}

// Manual completo
export async function manual() {
  const { processes } = await api('/processes/manual');
  const areas = [...new Set(processes.map(p => p.content.area).filter(Boolean))];
  const controls = processes.reduce((s, p) => s + p.content.steps.filter(x => x.control).length, 0);
  const people = new Set(processes.flatMap(p => p.content.steps.map(s => s.responsible)));
  setPageFooter(`Manual de Processos · Charão Engenharia & Construção · impresso em ${fmtDate(todayISO())}`);
  return {
    title: 'Manual de Processos',
    html: html`${printToolbar({ back: '#/processos', title: 'Manual de Processos da Empresa' })}
      <div class="doc-stage"><article class="doc a4 pd-doc">
        <section class="pd-cover">
          <img src="/assets/logo.webp" alt="Charão Engenharia & Construção" class="pd-cover-logo">
          <div class="r-kicker">Documento interno</div>
          <h1>Mapa de Processos</h1>
          <p class="pd-cover-sub">${processes.length} processo(s) documentado(s): responsáveis, fluxo de etapas, pontos de controle e indicadores.</p>
          <p class="muted">Versão de ${fmtDate(todayISO())}</p>
        </section>
        <section class="r-break">${docHeader('Mapa de processos')}
          <h3 class="r-h">Os ${processes.length} processos</h3>
          <table class="r-table pd-map"><thead><tr><th>Código</th><th>Processo</th><th>Área</th><th>Frequência</th><th>Objetivo</th></tr></thead>
            <tbody>${processes.map(p => html`<tr><td class="mono nowrap">${p.code}</td><td><b>${p.content.title}</b></td><td class="small">${p.content.area || ''}</td><td class="small nowrap">${p.content.frequency || ''}</td><td class="small">${p.content.objective}</td></tr>`)}</tbody></table>
        </section>
        ${processes.map(p => processDoc(p, { header: docHeader('Manual de processos') }))}
        <section class="r-break pd-summary">${docHeader('Resumo')}
          <div class="pd-kpis">
            <div><b>${processes.length}</b><span>processos documentados</span></div>
            <div><b>${areas.length}</b><span>áreas: ${areas.join(', ')}</span></div>
            <div><b>${controls}</b><span>pontos de controle e aprovação ao longo dos fluxos</span></div>
            <div><b>${people.size}</b><span>responsáveis envolvidos</span></div>
          </div>
          <p class="r-p">Cada processo segue o mesmo padrão: etapas com responsável definido, pontos formais de controle/aprovação e indicadores de acompanhamento, reduzindo retrabalho e aumentando a rastreabilidade das decisões.</p>
        </section>
      </article></div>`,
    mount: bindPrintToolbar,
  };
}
