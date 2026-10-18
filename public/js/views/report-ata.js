// Ata de reunião (A4) — pronta para imprimir ou salvar em PDF.
import { html, api, fmtDate, fmtDateTime } from '../core.js';
import { printToolbar, bindPrintToolbar, setPageFooter } from './print-common.js';

const KIND = { info: 'Informação', definicao: 'Definição', demanda: 'Demanda' };

export async function view({ params }) {
  const r = await api(`/records/${params.id}`);
  if (r.behavior !== 'reuniao') throw new Error('Este registro não é uma ata de reunião.');
  const items = r.items || [];
  const main = items.filter(i => !i.addendum);
  const add = items.filter(i => i.addendum);
  const itemRows = list => list.map(i => html`<tr><td class="num">${i.seq}</td><td class="nowrap"><b>${KIND[i.kind]}</b></td><td>${i.text}</td>
    <td class="small">${i.kind === 'demanda' ? i.assignee_name || r.emitted_by_name || '—' : ''}</td><td class="small nowrap">${i.kind === 'demanda' ? (i.due_date ? fmtDate(i.due_date) : 'sem prazo') : ''}</td>
    <td class="small mono nowrap">${i.task_code || i.decision_code || ''}</td></tr>`);
  const table = list => html`<table class="r-table ata-items"><thead><tr><th class="num">Nº</th><th>Tipo</th><th>Descrição</th><th>Responsável</th><th>Prazo</th><th>Gerado</th></tr></thead>
    <tbody>${itemRows(list)}</tbody></table>`;
  return {
    title: `Ata ${r.code || ''}`,
    html: html`${printToolbar({ back: `#/projetos/${r.project_id}/registros/${r.id}`, title: `Ata ${r.code || ''} — ${r.title}` })}
    <div class="doc-stage"><article class="doc a4" id="doc">
      <header class="r-header">
        <img src="/assets/logo.webp" alt="Charão Engenharia & Construção" class="r-logo">
        <div class="r-doctype"><div class="r-kicker">Ata de reunião${r.status === 'rascunho' ? ' · Rascunho' : ''}</div><div class="r-level mono">${r.code || ''}</div></div>
      </header>
      <div class="r-rule"></div>
      <section class="r-scope">
        <div><div class="r-lbl">Assunto</div><h1>${r.title}</h1><div class="muted">${r.project.code} · ${r.project.name} · Cliente: ${r.project.client}</div></div>
        <dl class="r-meta">
          <dt>Data</dt><dd>${fmtDate(r.record_date)}${r.meeting_time ? ` às ${r.meeting_time}` : ''}</dd>
          ${r.location ? html`<dt>Local</dt><dd>${r.location}</dd>` : ''}
          ${r.origin ? html`<dt>Convocação</dt><dd>${r.origin}</dd>` : ''}
          <dt>Situação</dt><dd>${r.status === 'emitida' ? 'Emitida' : r.status === 'cancelada' ? 'Cancelada' : 'Rascunho'}</dd>
          ${r.emitted_at ? html`<dt>Emitida por</dt><dd>${r.emitted_by_name} · ${fmtDateTime(r.emitted_at)}</dd>` : ''}
        </dl>
      </section>
      <section class="r-section avoid"><h3 class="r-h">Participantes</h3>
        ${r.participants.length ? html`<table class="r-table"><thead><tr><th>Nome</th><th>Empresa</th></tr></thead>
          <tbody>${r.participants.map(x => html`<tr><td>${x.name}</td><td>${x.company || '—'}</td></tr>`)}</tbody></table>` : html`<p class="muted">Não informados.</p>`}</section>
      ${r.agenda ? html`<section class="r-section avoid"><h3 class="r-h">Pauta</h3><p class="r-p pre">${r.agenda}</p></section>` : ''}
      ${r.body ? html`<section class="r-section"><h3 class="r-h">Resumo da reunião</h3><p class="r-p pre">${r.body}</p></section>` : ''}
      <section class="r-section"><h3 class="r-h">Itens, definições e demandas</h3>
        ${main.length ? table(main) : html`<p class="muted">Sem itens.</p>`}
        <p class="small muted" style="margin-top:4px">Definições passam a valer no projeto; demandas são encaminhadas como tarefas aos responsáveis (coluna “Gerado”).</p></section>
      ${add.length ? html`<section class="r-section"><h3 class="r-h">Adendos</h3>${table(add)}</section>` : ''}
      ${r.files.some(f => f.mime !== 'application/pdf') ? html`<section class="r-section"><h3 class="r-h">Anexos</h3><div class="r-photos">
        ${r.files.filter(f => f.mime !== 'application/pdf').map(f => html`<figure><img src="/api/record-files/${f.id}" alt=""><figcaption>${f.caption || ''}</figcaption></figure>`)}</div></section>` : ''}
      <footer class="r-footer">
        <span>Charão Engenharia & Construção · Ata ${r.code || ''} · ${r.project.code}</span>
        <span>Gerada em ${fmtDateTime(new Date().toISOString())} · Documento gerado pelo sistema Charão Gestão de Obras</span>
      </footer>
    </article></div>`,
    mount(root) {
      bindPrintToolbar(root);
      setPageFooter(`Ata ${r.code || ''} · ${r.project.code} · ${r.title}`);
    },
  };
}
