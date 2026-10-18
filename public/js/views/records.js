// Registros do projeto: observações, definições, atas de reunião, pendências e demais tipos cadastrados.
// Card no projeto · lista (linha do tempo) · detalhe · formulário. Pendências e demandas de ata geram tarefas.
import { html, api, icon, fmtDate, fmtDateTime, todayISO, STATUS } from '../core.js';
import { toast, sheet, confirmSheet, readAttachments, lightbox } from '../ui.js';
import { pageHead } from './shared.js';
import { recBadge } from './record-icons.js';

export const REC_ST = {
  ativo: ['Registrado', '#5B6B7A'], rascunho: ['Rascunho', '#8A96A3'], emitida: ['Emitida', '#2A3D50'], aguardando_aprovacao: ['Aguardando aprovação', '#B7791F'],
  vigente: ['Vigente', '#1F6B41'], substituida: ['Substituída', '#8A96A3'], reprovada: ['Reprovada', '#9E2B20'], aberta: ['Em aberto', '#1F6FB2'],
  resolvida: ['Resolvida', '#1F6B41'], atrasada: ['Atrasada', '#C0392B'], cancelada: ['Cancelada', '#8A96A3'],
};
const BEH = { nota: 'Nota', decisao: 'Decisão', reuniao: 'Reunião (ata)', pendencia: 'Pendência (gera tarefa)' };
const KIND = { info: ['Informação', '#5B6B7A'], definicao: ['Definição', '#1F6FB2'], demanda: ['Demanda', '#C9520F'] };
const ORIGINS = ['Reunião', 'E-mail', 'Obra', 'Cliente', 'Telefone', 'WhatsApp', 'Projetista', 'Fiscalização'];
const MONTHS = ['janeiro', 'fevereiro', 'março', 'abril', 'maio', 'junho', 'julho', 'agosto', 'setembro', 'outubro', 'novembro', 'dezembro'];

export const recStatus = s => html`<span class="rg-st" style="--c:${(REC_ST[s] || REC_ST.ativo)[1]}">${(REC_ST[s] || [s])[0]}</span>`;
export const recType = r => html`<span class="rg-type" style="--c:${r.color}">${recBadge(r.type_icon, r.color, 'rg-ic-sm')}${r.type_name}</span>`;
const taskStatus = s => (s ? html`<span class="rg-st" style="--c:${s === 'concluida' ? '#1F6B41' : s === 'atrasada' ? '#C0392B' : s === 'cancelada' ? '#8A96A3' : '#1F6FB2'}">${s === 'cancelada' ? 'Cancelada' : STATUS[s]?.label || s}</span>` : '');
const recHref = (pid, id) => `#/projetos/${pid}/registros/${id}`;

function recordRow(r, pid) {
  const meta = [];
  if (r.behavior === 'pendencia') {
    if (r.assignee_name) meta.push(html`<span>${icon('user')}${r.assignee_name}</span>`);
    if (r.due_date) meta.push(html`<span>${icon('calendar')}prazo ${fmtDate(r.due_date)}</span>`);
    if (r.task_code) meta.push(html`<span class="mono">${r.task_code}</span>`);
  }
  if (r.behavior === 'reuniao' && r.item_counts) {
    const c = r.item_counts;
    meta.push(html`<span>${c.definicao} definição(ões) · ${c.demanda} demanda(s)${r.open_demands ? html` · <b>${r.open_demands} em aberto</b>` : ''}</span>`);
  }
  if (r.behavior === 'decisao' && r.replaces_code) meta.push(html`<span>substitui ${r.replaces_code}</span>`);
  if (r.source_code) meta.push(html`<span>da ${r.source_code}</span>`);
  if (r.file_count) meta.push(html`<span>${icon('image')}${r.file_count}</span>`);
  return html`<li class="rg-item" data-type="${r.type_id}" data-st="${r.eff_status}" data-text="${`${r.code || ''} ${r.title} ${r.body || ''} ${r.type_name}`.toLowerCase()}">
    <a class="row-link rg-row" href="${recHref(pid, r.id)}" style="--c:${r.color}">
      <div class="rg-date"><b>${r.record_date.slice(8, 10)}</b><small>${MONTHS[Number(r.record_date.slice(5, 7)) - 1].slice(0, 3)}</small></div>
      <div class="grow">
        <div class="rg-tags">${recType(r)}${r.code ? html`<span class="mono muted rg-code">${r.code}</span>` : ''}${r.pinned ? html`<span class="rg-pin" title="Fixado">📌</span>` : ''}</div>
        <div class="row-title rg-title ${['substituida', 'cancelada', 'reprovada'].includes(r.status) ? 'is-off' : ''}">${r.title}</div>
        ${meta.length ? html`<div class="row-meta">${meta}</div>` : ''}
      </div>
      ${recStatus(r.eff_status)}
      <span class="chev">${icon('chevron')}</span></a></li>`;
}

// Escolha do tipo ao criar um registro
export function chooseType(data, navigate, extra = '') {
  const types = data.types.filter(t => data.creatable.includes(t.id));
  const wrap = document.createElement('div');
  wrap.className = 'sheet-backdrop';
  wrap.innerHTML = html`<div class="sheet" role="dialog" aria-modal="true" aria-label="Novo registro">
    <div class="sheet-grip" aria-hidden="true"></div>
    <header class="sheet-head"><h2>Novo registro</h2><button type="button" class="icon-btn" data-close aria-label="Fechar">✕</button></header>
    <nav class="more-list rg-choose">${types.map(t => html`<a href="#/projetos/${data.project.id}/registros/novo?tipo=${t.id}${extra}">${recBadge(t.icon, t.color)}
      <span><b>${t.name}</b><small>${BEH[t.behavior]}${t.requires_approval ? ' · exige aprovação' : ''}${t.internal ? ' · interno' : ''}</small></span>${icon('chevron')}</a>`)}</nav></div>`.toString();
  document.body.appendChild(wrap);
  document.body.classList.add('no-scroll');
  const close = () => { wrap.classList.add('closing'); document.body.classList.remove('no-scroll'); setTimeout(() => wrap.remove(), 180); };
  wrap.addEventListener('click', e => { if (e.target === wrap || e.target.closest('[data-close]') || e.target.closest('a')) close(); });
}

// Seleção com busca (tarefa ou registro a vincular)
export function pickSheet({ title, empty, items }) {
  return new Promise(resolve => {
    const wrap = document.createElement('div');
    wrap.className = 'sheet-backdrop';
    wrap.innerHTML = html`<div class="sheet" role="dialog" aria-modal="true" aria-label="${title}">
      <div class="sheet-grip" aria-hidden="true"></div>
      <header class="sheet-head"><h2>${title}</h2><button type="button" class="icon-btn" data-close aria-label="Fechar">✕</button></header>
      <div class="sheet-body"><input type="search" class="pick-q" placeholder="Buscar por código ou título…" aria-label="Buscar">
        ${items.length ? html`<ul class="pick-list">${items.map(it => html`<li data-text="${it.text.toLowerCase()}"><button type="button" class="pick-it" data-pick="${it.id}">${it.html}</button></li>`)}</ul>`
          : html`<p class="muted">${empty}</p>`}</div></div>`.toString();
    document.body.appendChild(wrap);
    document.body.classList.add('no-scroll');
    let done = false;
    const close = v => { if (done) return; done = true; wrap.classList.add('closing'); document.body.classList.remove('no-scroll'); setTimeout(() => wrap.remove(), 180); resolve(v); };
    wrap.addEventListener('click', e => {
      if (e.target === wrap || e.target.closest('[data-close]')) close(null);
      const b = e.target.closest('[data-pick]');
      if (b) close(Number(b.dataset.pick));
    });
    const q = wrap.querySelector('.pick-q');
    q.addEventListener('input', () => { const v = q.value.trim().toLowerCase(); wrap.querySelectorAll('.pick-list li').forEach(li => { li.hidden = !!v && !li.dataset.text.includes(v); }); });
    setTimeout(() => q.focus(), 60);
  });
}
const taskPickItem = t => ({ id: t.id, text: `${t.code} ${t.title} ${t.assignee_name || ''}`,
  html: html`<span class="mono muted">${t.code}</span><span class="grow"><b>${t.parent_code ? '↳ ' : ''}${t.title}</b><small>${t.assignee_name || 'Sem responsável'}${t.due_date ? ` · prazo ${fmtDate(t.due_date)}` : ''}</small></span>${taskStatus(t.eff_status)}` });
export const recordPickItem = r => ({ id: r.id, text: `${r.code || ''} ${r.title} ${r.type_name}`,
  html: html`${recBadge(r.type_icon, r.color)}<span class="grow"><b>${r.title}</b><small>${r.code ? `${r.code} · ` : ''}${r.type_name} · ${fmtDate(r.record_date)}</small></span>${recStatus(r.eff_status)}` });

// ---------- Card na tela do projeto ----------
export function recordsCard(data) {
  const pid = data.project.id;
  const live = data.records.filter(r => !['cancelada', 'reprovada'].includes(r.status));
  const pinned = live.filter(r => r.pinned && r.status !== 'substituida');
  const recent = live.filter(r => !pinned.includes(r)).slice(0, 5);
  const s = data.summary;
  return html`<section class="card section" id="proj-records">
    <div class="card-head"><h2>${icon('note')}Registros do projeto</h2>
      <span class="sub">${s.total} registro(s) · ${s.vigentes} definição(ões) vigente(s)${s.open ? ` · ${s.open} pendência(s) em aberto` : ''}${s.late ? ` · ${s.late} atrasada(s)` : ''}</span></div>
    <div class="card-body rg-card-actions">
      ${data.creatable.length ? html`<button type="button" class="btn btn-primary btn-sm" data-new-record>${icon('plus')}Novo registro</button>` : ''}
      <a class="btn btn-ghost btn-sm" href="#/projetos/${pid}/registros">${icon('history')}Linha do tempo</a>
      <a class="btn btn-ghost btn-sm" href="#/imprimir/historia/${pid}">${icon('reports')}História do projeto</a>
      ${s.awaiting && data.can_manage ? html`<a class="rg-alert" href="#/projetos/${pid}/registros?sit=aguardando_aprovacao">${icon('alert')}${s.awaiting} aguardando aprovação</a>` : ''}
    </div>
    ${pinned.length ? html`<div class="sub-label rg-sublabel">Fixados</div><ul class="rows rg-pinned">${pinned.map(r => recordRow(r, pid))}</ul>` : ''}
    ${recent.length ? html`<div class="sub-label rg-sublabel">Últimos registros</div><ul class="rows">${recent.map(r => recordRow(r, pid))}</ul>`
      : !pinned.length ? html`<div class="card-body muted" style="font-size:13.5px">Nenhum registro ainda. Use <b>Novo registro</b> para anotar observações, definições, atas de reunião, solicitações do cliente e ocorrências do projeto.</div>` : ''}
  </section>`;
}
export function bindRecordsCard(root, data, navigate) {
  root.querySelector('[data-new-record]')?.addEventListener('click', () => chooseType(data, navigate));
}

// ---------- Lista (linha do tempo) ----------
export async function list({ params, query, navigate }) {
  const data = await api(`/projects/${params.id}/records`);
  const p = data.project;
  const pid = p.id;
  const sit = query.get('sit') || '';
  const tipo = query.get('tipo') || '';
  const byMonth = new Map();
  for (const r of data.records) {
    const k = r.record_date.slice(0, 7);
    if (!byMonth.has(k)) byMonth.set(k, []);
    byMonth.get(k).push(r);
  }
  const used = data.types.filter(t => data.records.some(r => r.type_id === t.id));
  const vig = data.records.filter(r => r.behavior === 'decisao' && r.status === 'vigente');
  const SITS = [['', 'Todas as situações'], ['vigente', 'Definições vigentes'], ['pend', 'Pendências em aberto/atrasadas'], ['aguardando_aprovacao', 'Aguardando aprovação'],
    ['rascunho', 'Rascunhos'], ['emitida', 'Atas emitidas'], ['off', 'Substituídas, reprovadas e canceladas']];
  return {
    title: `Registros · ${p.code}`,
    html: html`
      ${pageHead({
        back: { href: `#/projetos/${pid}`, label: `${p.code} · ${p.name}` },
        eyebrow: `${p.code} · Registros do projeto`,
        title: 'Linha do tempo do projeto',
        sub: `${data.summary.total} registro(s) · ${data.summary.vigentes} definição(ões) vigente(s) · ${data.summary.open} pendência(s) em aberto`,
        actions: html`<a class="btn btn-ghost" href="#/imprimir/historia/${pid}">${icon('reports')}História do projeto</a>
          ${data.creatable.length ? html`<button type="button" class="btn btn-primary" data-new-record>${icon('plus')}Novo registro</button>` : ''}`,
      })}
      ${vig.length ? html`<details class="card section rg-vig" ${vig.length <= 6 ? 'open' : ''}><summary class="card-head"><h2>${icon('check')}Definições vigentes</h2><span class="sub">${vig.length} · o que vale hoje no projeto</span></summary>
        <ul class="rows">${vig.map(r => html`<li><a class="row-link" href="${recHref(pid, r.id)}"><div class="grow"><div class="row-title">${r.title}</div>
          <div class="row-meta"><span class="mono">${r.code || ''}</span><span>${fmtDate(r.record_date)}</span>${r.decided_by ? html`<span>por ${r.decided_by}</span>` : ''}${r.source_code ? html`<span>da ${r.source_code}</span>` : ''}</div></div><span class="chev">${icon('chevron')}</span></a></li>`)}</ul></details>` : ''}
      <div class="rg-filters section">
        <div class="chips" role="group" aria-label="Filtrar por tipo">
          <button type="button" class="chip" data-ftype="" aria-pressed="${!tipo}">Todos<span class="n">${data.records.length}</span></button>
          ${used.map(t => html`<button type="button" class="chip" data-ftype="${t.id}" aria-pressed="${String(t.id) === tipo}" style="--c:${t.color}"><span class="dot"></span>${t.name}<span class="n">${data.records.filter(r => r.type_id === t.id).length}</span></button>`)}
        </div>
        <div class="rg-filter-row">
          <select id="rg-sit" aria-label="Situação">${SITS.map(([k, l]) => html`<option value="${k}" ${sit === k ? 'selected' : ''}>${l}</option>`)}</select>
          <input type="search" id="rg-q" placeholder="Buscar nos registros…" aria-label="Buscar nos registros">
        </div>
      </div>
      ${data.records.length ? [...byMonth].map(([ym, rs]) => html`<section class="card section rg-month" data-month>
        <div class="card-head"><h2>${MONTHS[Number(ym.slice(5, 7)) - 1]} de ${ym.slice(0, 4)}</h2><span class="sub" data-mcount>${rs.length}</span></div>
        <ul class="rows">${rs.map(r => recordRow(r, pid))}</ul></section>`)
        : html`<div class="empty-state"><h2>Nenhum registro</h2><p>Registre observações, definições, atas de reunião, solicitações do cliente e ocorrências. Tudo aparece aqui em ordem cronológica, no Gantt e na História do projeto.</p></div>`}
      <p class="muted rg-none" hidden>Nenhum registro com esses filtros.</p>
      ${data.creatable.length ? html`<button type="button" class="fab" data-new-record aria-label="Novo registro">${icon('plus')}</button>` : ''}`,
    mount(root, ctx) {
      root.querySelectorAll('[data-new-record]').forEach(b => b.addEventListener('click', () => chooseType(data, navigate)));
      let ft = tipo;
      const apply = () => {
        const q = root.querySelector('#rg-q').value.trim().toLowerCase();
        const s = root.querySelector('#rg-sit').value;
        const stOk = st => !s || (s === 'pend' ? ['aberta', 'atrasada'].includes(st) : s === 'off' ? ['substituida', 'reprovada', 'cancelada'].includes(st) : st === s);
        let shown = 0;
        root.querySelectorAll('[data-month]').forEach(sec => {
          let n = 0;
          sec.querySelectorAll('.rg-item').forEach(li => {
            const v = (!ft || li.dataset.type === ft) && stOk(li.dataset.st) && (!q || li.dataset.text.includes(q));
            li.hidden = !v;
            if (v) n++;
          });
          sec.hidden = !n;
          sec.querySelector('[data-mcount]').textContent = n;
          shown += n;
        });
        root.querySelector('.rg-none').hidden = !!shown || !data.records.length;
      };
      root.querySelectorAll('[data-ftype]').forEach(b => b.addEventListener('click', () => {
        ft = b.dataset.ftype;
        root.querySelectorAll('[data-ftype]').forEach(x => x.setAttribute('aria-pressed', String(x === b)));
        ctx.setQuery({ tipo: ft, sit: root.querySelector('#rg-sit').value });
        apply();
      }));
      root.querySelector('#rg-sit').addEventListener('change', e => { ctx.setQuery({ tipo: ft, sit: e.target.value }); apply(); });
      root.querySelector('#rg-q').addEventListener('input', apply);
      apply();
    },
  };
}

// ---------- Detalhe ----------
export async function detail({ params, navigate, render }) {
  const r = await api(`/records/${params.rid}`);
  const pid = r.project_id;
  const isAta = r.behavior === 'reuniao';
  const kv = [];
  const add = (k, v) => { if (v) kv.push(html`<dt>${k}</dt><dd>${v}</dd>`); };
  add('Data', html`${fmtDate(r.record_date)}${r.meeting_time ? ` às ${r.meeting_time}` : ''}`);
  add('Tipo', recType(r));
  add('Situação', recStatus(r.eff_status));
  if (isAta) add('Local', r.location);
  add('Origem', r.origin);
  add(r.behavior === 'pendencia' ? 'Solicitante' : 'Quem definiu', r.decided_by);
  if (r.behavior === 'pendencia') {
    add('Responsável', r.assignee_name || (r.task_code ? '' : 'quem registrou'));
    add('Prazo', r.due_date ? fmtDate(r.due_date) : 'sem prazo');
    add('Tarefa gerada', r.task_code ? html`<a href="#/tarefas/${r.task_id}" class="mono">${r.task_code}</a> ${taskStatus(r.task_eff)}` : r.status === 'aguardando_aprovacao' ? 'será criada na aprovação' : '');
  }
  if (r.source_code) add('Gerada pela', html`<a href="${recHref(pid, r.source_record_id)}">${r.source_code} · ${r.source_title}</a>`);
  if (r.replaces_code) add('Substitui', html`<a href="${recHref(pid, r.replaces_id)}">${r.replaces_code} · ${r.replaces_title}</a>`);
  if (r.replaced_by_code) add('Substituída por', html`<a href="${recHref(pid, r.replaced_by_id)}">${r.replaced_by_code} · ${r.replaced_by_title}</a>`);
  add('Registrado por', `${r.created_by_name} em ${fmtDateTime(r.created_at)}`);
  if (r.emitted_at) add('Emitida por', `${r.emitted_by_name} em ${fmtDateTime(r.emitted_at)}`);
  if (r.approved_at) add(r.status === 'reprovada' ? 'Reprovada por' : 'Aprovada por', `${r.approved_by_name} em ${fmtDateTime(r.approved_at)}${r.approval_note ? ` — “${r.approval_note}”` : ''}`);
  if (r.cancelled_at) add('Cancelado por', `${r.cancelled_by_name} em ${fmtDateTime(r.cancelled_at)} — “${r.cancel_reason}”`);
  const c = r.can;
  const items = r.items || [];
  const imgs = r.files.filter(f => f.mime !== 'application/pdf');
  const pdfs = r.files.filter(f => f.mime === 'application/pdf');
  return {
    title: `${r.code || r.type_name} · ${r.title}`,
    html: html`
      ${pageHead({
        back: { href: `#/projetos/${pid}/registros`, label: 'Registros do projeto' },
        eyebrow: `${r.project.code} · ${r.type_name}${r.code ? ` · ${r.code}` : ''}`,
        title: r.title,
        sub: `${r.project.name}`,
        actions: html`
          ${isAta ? html`<a class="btn btn-ghost" href="#/imprimir/ata/${r.id}">${icon('print')}${r.status === 'rascunho' ? 'Prévia da ata' : 'PDF da ata'}</a>` : ''}
          ${c.edit ? html`<a class="btn btn-ghost" href="#/projetos/${pid}/registros/${r.id}/editar">${icon('edit')}Editar</a>` : ''}
          ${c.replace ? html`<a class="btn btn-ghost" href="#/projetos/${pid}/registros/novo?tipo=${r.type_id}&substitui=${r.id}">${icon('reschedule')}Substituir definição</a>` : ''}
          ${c.emit ? html`<button type="button" class="btn btn-primary" data-act="emit">${icon('send')}Emitir ata</button>` : ''}
          ${c.approve ? html`<button type="button" class="btn btn-primary" data-act="approve">${icon('check')}Aprovar</button><button type="button" class="btn btn-ghost" data-act="reject">Reprovar</button>` : ''}`,
      })}
      ${r.status === 'aguardando_aprovacao' ? html`<div class="notice section" style="margin-top:0">${icon('info')}<span>Aguardando aprovação de um gestor ou administrador${r.behavior === 'pendencia' ? '. A tarefa é criada quando o registro for aprovado' : ''}.</span></div>` : ''}
      ${r.status === 'rascunho' ? html`<div class="notice section" style="margin-top:0">${icon('info')}<span>Ata em rascunho. Ao <b>emitir</b>, ela fica travada: as definições viram registros vigentes e cada demanda vira uma tarefa no projeto.</span></div>` : ''}
      <div class="grid grid-dash">
        <section class="card">
          <div class="card-head"><h2>Detalhes</h2>
            <span class="sub rg-head-acts">${c.pin ? html`<button type="button" class="btn btn-ghost btn-sm" data-act="${r.pinned ? 'unpin' : 'pin'}">📌 ${r.pinned ? 'Desafixar' : 'Fixar no topo'}</button>` : ''}
              ${c.cancel ? html`<button type="button" class="btn btn-ghost btn-sm" data-act="cancel">${icon('x')}Cancelar</button>` : ''}</span></div>
          <div class="card-body"><dl class="kv">${kv}</dl>
            ${r.body ? html`<div class="sub-label" style="margin-top:14px">${isAta ? 'Resumo da reunião' : 'Descrição'}</div><div class="text-content rg-body">${r.body}</div>` : ''}</div>
        </section>
        <section class="card">
          <div class="card-head"><h2>${icon('image')}Anexos</h2><span class="sub">${r.files.length}</span></div>
          <div class="card-body">
            ${imgs.length ? html`<div class="thumbs">${imgs.map(f => html`<figure class="thumb"><button type="button" class="thumb-btn" data-src="/api/record-files/${f.id}" data-cap="${f.caption || ''}"><img src="/api/record-files/${f.id}" alt="${f.caption || 'Anexo'}" loading="lazy"></button>
              ${c.files ? html`<button type="button" class="rm" data-rmf="${f.id}" aria-label="Remover">✕</button>` : ''}${f.caption ? html`<figcaption>${f.caption}</figcaption>` : ''}</figure>`)}</div>` : ''}
            ${pdfs.length ? html`<ul class="rg-pdfs">${pdfs.map(f => html`<li><a href="/api/record-files/${f.id}" target="_blank" rel="noopener">${icon('file')}${f.original_name || 'documento.pdf'}</a>${c.files ? html`<button type="button" class="icon-btn" data-rmf="${f.id}" aria-label="Remover">✕</button>` : ''}</li>`)}</ul>` : ''}
            ${!r.files.length ? html`<p class="muted" style="margin:0 0 10px">Nenhum anexo.</p>` : ''}
            ${c.files ? html`<label class="btn btn-ghost btn-sm rg-attach">${icon('plus')}Anexar fotos ou PDF<input type="file" hidden accept="image/*,application/pdf,.pdf" multiple data-attach></label>` : ''}
          </div>
        </section>
      </div>
      ${isAta ? html`
        <div class="grid grid-dash section">
          <section class="card"><div class="card-head"><h2>${icon('team')}Participantes</h2><span class="sub">${r.participants.length}</span></div>
            ${r.participants.length ? html`<ul class="rows">${r.participants.map(x => html`<li><div class="row-link"><div class="grow"><div class="row-title">${x.name}</div>${x.company ? html`<div class="row-meta"><span>${x.company}</span></div>` : ''}</div></div></li>`)}</ul>` : html`<div class="card-body muted">Sem participantes listados.</div>`}</section>
          <section class="card"><div class="card-head"><h2>Pauta</h2></div><div class="card-body text-content">${r.agenda || html`<span class="muted">Sem pauta informada.</span>`}</div></section>
        </div>
        <section class="card section"><div class="card-head"><h2>Itens da ata</h2><span class="sub">${r.item_counts.info} informação(ões) · ${r.item_counts.definicao} definição(ões) · ${r.item_counts.demanda} demanda(s)</span></div>
          ${items.length ? html`<ul class="rows rg-items">${items.map(i => html`<li class="rg-it"><div class="rg-it-n">${i.seq}</div><div class="grow">
            <div class="rg-tags"><span class="rg-type" style="--c:${KIND[i.kind][1]}"><i></i>${KIND[i.kind][0]}</span>${i.addendum ? html`<span class="pill pill-sand">Adendo</span>` : ''}</div>
            <div class="rg-it-text">${i.text}</div>
            <div class="row-meta">${i.kind === 'demanda' ? html`<span>${icon('user')}${i.assignee_name || 'quem emitir'}</span><span>${icon('calendar')}${i.due_date ? fmtDate(i.due_date) : 'sem prazo'}</span>` : ''}
              ${i.task_id ? html`<a href="#/tarefas/${i.task_id}" class="mono">${i.task_code}</a>${taskStatus(i.task_eff)}` : ''}
              ${i.decision_id ? html`<a href="${recHref(pid, i.decision_id)}" class="mono">${i.decision_code || 'definição'}</a>${recStatus(i.decision_status)}` : ''}</div></div></li>`)}</ul>`
            : html`<div class="card-body muted">Sem itens.</div>`}
          ${c.addendum ? html`<div class="card-body"><button type="button" class="btn btn-ghost btn-sm" data-act="addendum">${icon('plus')}Incluir adendo</button>
            <span class="muted" style="font-size:12.5px;margin-left:8px">A ata emitida não é alterada: novos itens entram como adendo e geram as definições e tarefas.</span></div>` : ''}
        </section>` : ''}
      <section class="card section" id="rg-links"><div class="card-head"><h2>${icon('tasks')}Tarefas vinculadas</h2><span class="sub">${r.linked_tasks.length}</span></div>
        ${r.linked_tasks.length ? html`<ul class="rows">${r.linked_tasks.map(t => html`<li class="rg-link-row"><a class="row-link" href="#/tarefas/${t.id}"><div class="grow">
            <div class="row-title"><span class="mono muted" style="font-size:12px">${t.code}</span> ${t.parent_code ? '↳ ' : ''}${t.title}</div>
            <div class="row-meta"><span>${t.assignee_name || 'Sem responsável'}</span>${t.due_date ? html`<span>prazo ${fmtDate(t.due_date)}</span>` : ''}</div></div>${taskStatus(t.eff_status)}</a>
            ${c.link ? html`<button type="button" class="icon-btn" data-unlink="${t.id}" aria-label="Desvincular ${t.code}" title="Desvincular">✕</button>` : ''}</li>`)}</ul>`
          : html`<div class="card-body muted" style="font-size:13.5px">Nenhuma tarefa vinculada. Vincule as tarefas do projeto relacionadas a este registro — o vínculo aparece também na tarefa.</div>`}
        ${c.link ? html`<div class="card-body" style="padding-top:${r.linked_tasks.length ? '12px' : '0'}"><button type="button" class="btn btn-ghost btn-sm" data-link-task>${icon('plus')}Vincular tarefa</button></div>` : ''}
      </section>
      ${r.history_chain?.length ? html`<section class="card section"><div class="card-head"><h2>${icon('history')}Histórico desta definição</h2><span class="sub">versões anteriores</span></div>
        <ul class="rows">${r.history_chain.map(x => html`<li><a class="row-link" href="${recHref(pid, x.id)}"><div class="grow"><div class="row-title is-off">${x.title}</div>
          <div class="row-meta"><span class="mono">${x.code || ''}</span><span>${fmtDate(x.record_date)}</span></div></div>${recStatus(x.status)}</a></li>`)}</ul></section>` : ''}
`,
    mount(root) {
      root.querySelectorAll('.thumb-btn').forEach(b => b.addEventListener('click', () => lightbox(b.dataset.src, b.dataset.cap)));
      const act = async (action, body = {}) => {
        await api(`/records/${r.id}/actions/${action}`, { method: 'POST', body });
        render();
      };
      root.querySelectorAll('[data-act]').forEach(b => b.addEventListener('click', async () => {
        const a = b.dataset.act;
        try {
          if (a === 'emit') {
            const nd = items.filter(i => i.kind === 'demanda').length;
            const nf = items.filter(i => i.kind === 'definicao').length;
            if (await confirmSheet('Emitir ata', `A ata ficará travada${nd ? `, ${nd} tarefa(s) serão criadas` : ''}${nf ? ` e ${nf} definição(ões) passarão a valer` : ''}. Confirmar?`, 'Emitir')) {
              await act('emit');
              toast('Ata emitida.');
            }
          } else if (a === 'approve') {
            const res = await sheet({ title: 'Aprovar registro', body: html`<div class="field"><label for="ap-note">Observação (opcional)</label><textarea id="ap-note" name="note" rows="3"></textarea></div>`,
              submitLabel: 'Aprovar', onSubmit: d => api(`/records/${r.id}/actions/approve`, { method: 'POST', body: d }) });
            if (res) { toast('Registro aprovado.'); render(); }
          } else if (a === 'reject') {
            const res = await sheet({ title: 'Reprovar registro', body: html`<div class="field"><label class="req" for="rj-note">Motivo</label><textarea id="rj-note" name="note" rows="3" required></textarea></div>`,
              submitLabel: 'Reprovar', danger: true, onSubmit: d => api(`/records/${r.id}/actions/reject`, { method: 'POST', body: d }) });
            if (res) { toast('Registro reprovado.'); render(); }
          } else if (a === 'cancel') {
            const res = await sheet({ title: 'Cancelar registro', body: html`<p class="muted">${r.behavior === 'decisao' && r.replaces_code ? `A definição anterior (${r.replaces_code}) volta a valer. ` : ''}${isAta && r.status === 'emitida' ? 'As tarefas e definições geradas pela ata continuam; cancele-as individualmente se necessário. ' : ''}O registro continua no histórico como cancelado.</p>
              <div class="field"><label class="req" for="cc-r">Motivo</label><textarea id="cc-r" name="reason" rows="3" required></textarea></div>`,
              submitLabel: 'Cancelar registro', danger: true, onSubmit: d => api(`/records/${r.id}/actions/cancel`, { method: 'POST', body: d }) });
            if (res) { toast('Registro cancelado.'); render(); }
          } else if (a === 'pin' || a === 'unpin') {
            await act(a);
          } else if (a === 'addendum') {
            const users = await api(`/projects/${pid}/assignees`);
            adUsers = users;
            const res = await sheet({ title: 'Adendo à ata', wide: true, body: html`<p class="muted">Os itens entram na ata como adendo (com a data de hoje). Definições passam a valer e demandas viram tarefas.</p>
              <ul class="rg-items-edit" id="ad-items">${itemEditor({ kind: 'demanda' }, users)}</ul>
              <button type="button" class="btn btn-ghost btn-sm" id="ad-add">${icon('plus')}Outro item</button>`,
              submitLabel: 'Incluir adendo',
              onSubmit: () => api(`/records/${r.id}/actions/addendum`, { method: 'POST', body: { items: readItemEditors(document.querySelector('#ad-items')) } }) });
            if (res) { toast('Adendo incluído.'); render(); }
          }
        } catch (e) { toast(e.message, 'error'); }
      }));
      root.querySelector('[data-link-task]')?.addEventListener('click', async () => {
        try {
          const linked = new Set(r.linked_tasks.map(t => t.id));
          const tasks = (await api(`/projects/${pid}/record-tasks`)).filter(t => !linked.has(t.id));
          const id = await pickSheet({ title: 'Vincular tarefa', empty: 'Não há outras tarefas neste projeto.', items: tasks.map(taskPickItem) });
          if (!id) return;
          await api(`/records/${r.id}/links`, { method: 'POST', body: { task_id: id } });
          toast('Tarefa vinculada.');
          render();
        } catch (e) { toast(e.message, 'error'); }
      });
      root.querySelectorAll('[data-unlink]').forEach(b => b.addEventListener('click', async () => {
        try { await api(`/records/${r.id}/links/${b.dataset.unlink}`, { method: 'DELETE' }); toast('Vínculo removido.'); render(); } catch (e) { toast(e.message, 'error'); }
      }));
      root.querySelectorAll('[data-rmf]').forEach(b => b.addEventListener('click', async () => {
        if (!(await confirmSheet('Remover anexo', 'O arquivo será removido deste registro.', 'Remover', true))) return;
        try { await api(`/records/${r.id}/files/${b.dataset.rmf}`, { method: 'DELETE' }); render(); } catch (e) { toast(e.message, 'error'); }
      }));
      root.querySelector('[data-attach]')?.addEventListener('change', async e => {
        try {
          const files = await readAttachments(e.target.files);
          if (!files.length) return;
          toast('Enviando anexos…', 'warn');
          await api(`/records/${r.id}/files`, { method: 'POST', body: { files } });
          toast('Anexos incluídos.');
          render();
        } catch (ex) { toast(ex.message, 'error'); }
      });
    },
  };
}

// Editor de um item da ata
function itemEditor(i, users) {
  const k = i.kind || 'info';
  return html`<li class="rg-ie" data-ie>
    <div class="rg-ie-top"><select data-ie-kind aria-label="Tipo do item">${Object.entries(KIND).map(([v, [l]]) => html`<option value="${v}" ${k === v ? 'selected' : ''}>${l}</option>`)}</select>
      <button type="button" class="icon-btn" data-ie-rm aria-label="Remover item">✕</button></div>
    <textarea data-ie-text rows="2" maxlength="2000" placeholder="Descreva o item…" aria-label="Texto do item">${i.text || ''}</textarea>
    <div class="rg-ie-dem" ${k === 'demanda' ? '' : 'hidden'}>
      <select data-ie-user aria-label="Responsável pela demanda"><option value="">Responsável: quem emitir a ata</option>${users.map(u => html`<option value="${u.id}" ${i.assignee_id === u.id ? 'selected' : ''}>${u.name}</option>`)}</select>
      <input type="date" data-ie-due value="${i.due_date || ''}" aria-label="Prazo da demanda">
    </div>
  </li>`;
}
function readItemEditors(ul) {
  return [...ul.querySelectorAll('[data-ie]')].map(li => ({
    kind: li.querySelector('[data-ie-kind]').value,
    text: li.querySelector('[data-ie-text]').value,
    assignee_id: li.querySelector('[data-ie-user]').value ? Number(li.querySelector('[data-ie-user]').value) : null,
    due_date: li.querySelector('[data-ie-due]').value || null,
  })).filter(x => x.text.trim());
}
function bindItemEditors(ul) {
  ul.addEventListener('change', e => {
    if (e.target.matches('[data-ie-kind]')) e.target.closest('[data-ie]').querySelector('.rg-ie-dem').hidden = e.target.value !== 'demanda';
  });
  ul.addEventListener('click', e => { if (e.target.closest('[data-ie-rm]')) e.target.closest('[data-ie]').remove(); });
}
document.addEventListener('change', e => {
  if (e.target.matches?.('#ad-items [data-ie-kind]')) e.target.closest('[data-ie]').querySelector('.rg-ie-dem').hidden = e.target.value !== 'demanda';
});
// Sheet do adendo: os itens são criados depois da tela, por isso a delegação no documento
let adUsers = [];
document.addEventListener('click', e => {
  if (e.target.closest?.('#ad-items [data-ie-rm]')) e.target.closest('[data-ie]').remove();
  if (e.target.closest?.('#ad-add')) document.querySelector('#ad-items')?.insertAdjacentHTML('beforeend', itemEditor({ kind: 'demanda' }, adUsers).toString());
});

// ---------- Formulário ----------
export async function form({ params, query, state, navigate }) {
  const pid = Number(params.id);
  const editing = !!params.rid;
  const [data, users, rec, ptasks] = await Promise.all([api(`/projects/${pid}/records`), api(`/projects/${pid}/assignees`), editing ? api(`/records/${params.rid}`) : null,
    api(`/projects/${pid}/record-tasks`).catch(() => [])]);
  const type = data.types.find(t => t.id === (rec ? rec.type_id : Number(query.get('tipo'))));
  if (!type) throw new Error('Escolha o tipo de registro.');
  if (!editing && !data.creatable.includes(type.id)) throw new Error('Você não pode criar registros deste tipo.');
  const r = rec || { title: '', body: '', record_date: todayISO(), origin: '', decided_by: '', pinned: 0, replaces_id: Number(query.get('substitui')) || null, participants: [], items: [] };
  const b = type.behavior;
  const linkedSet = new Set(rec ? rec.linked_tasks.map(t => t.id) : [Number(query.get('tarefa'))].filter(Boolean));
  const vig = data.records.filter(x => x.behavior === 'decisao' && x.status === 'vigente' && x.id !== r.id);
  const approvalNote = type.requires_approval && state.user.role !== 'admin';
  const p = data.project;
  return {
    title: editing ? 'Editar registro' : `Novo registro · ${type.name}`,
    html: html`
      ${pageHead({
        back: { href: editing ? recHref(pid, r.id) : query.get('tarefa') ? `#/tarefas/${query.get('tarefa')}` : `#/projetos/${pid}/registros`, label: editing ? (r.code || r.title) : query.get('tarefa') ? 'Tarefa' : 'Registros do projeto' },
        eyebrow: `${p.code} · ${type.name}`,
        title: editing ? 'Editar registro' : `Novo registro: ${type.name}`,
        sub: `${p.name} · ${BEH[b]}`,
      })}
      ${approvalNote && !editing ? html`<div class="notice" style="max-width:860px;margin-bottom:14px">${icon('info')}<span>Este tipo exige aprovação: o registro fica <b>Aguardando aprovação</b> até um gestor ou administrador aprovar${b === 'pendencia' ? ' (a tarefa é criada na aprovação)' : ''}.</span></div>` : ''}
      <form class="card card-pad form" id="rg-form" novalidate style="max-width:860px">
        <div class="field"><label class="req" for="rg-title">${b === 'reuniao' ? 'Assunto da reunião' : 'Título'}</label>
          <input type="text" id="rg-title" name="title" maxlength="160" required value="${r.title}" placeholder="${b === 'decisao' ? 'Ex.: Piso do térreo — porcelanato 90×90 cinza' : b === 'reuniao' ? 'Ex.: Reunião de alinhamento de acabamentos' : b === 'pendencia' ? 'Ex.: Instalar ponto extra de tomada na sala' : 'Ex.: Acesso de caminhões só após as 8h'}"></div>
        <div class="form-row">
          <div class="field"><label class="req" for="rg-date">${b === 'reuniao' ? 'Data da reunião' : 'Data do registro'}</label><input id="rg-date" name="record_date" type="date" max="${todayISO()}" required value="${r.record_date}">
            <span class="hint">Quando aconteceu. É a data que aparece no Gantt e na história.</span></div>
          ${b === 'reuniao' ? html`<div class="field"><label for="rg-time">Horário</label><input id="rg-time" name="meeting_time" type="time" value="${r.meeting_time || ''}"></div>`
            : html`<div class="field"><label for="rg-origin">Origem</label><input type="text" id="rg-origin" name="origin" list="rg-origins" maxlength="160" value="${r.origin || ''}" placeholder="Reunião, e-mail, obra, cliente…">
              <datalist id="rg-origins">${ORIGINS.map(o => html`<option value="${o}">`)}</datalist></div>`}
        </div>
        ${b === 'reuniao' ? html`<div class="form-row">
            <div class="field"><label for="rg-loc">Local</label><input type="text" id="rg-loc" name="location" maxlength="160" value="${r.location || ''}" placeholder="Canteiro, escritório, online…"></div>
            <div class="field"><label for="rg-origin2">Origem / convocação</label><input type="text" id="rg-origin2" name="origin" maxlength="160" value="${r.origin || ''}" placeholder="Ex.: reunião mensal, pedido do cliente"></div></div>
          <div class="field"><label for="rg-part">Participantes</label>
            <textarea id="rg-part" name="participants" rows="4" placeholder="Um por linha: Nome - Empresa&#10;Ricardo Menezes - Charão&#10;Carlos Souza - Incorporadora Horizonte">${r.participants.map(x => `${x.name}${x.company ? ` - ${x.company}` : ''}`).join('\n')}</textarea>
            <span class="hint">Lista de nomes (um por linha). Use “Nome - Empresa” para indicar a empresa.</span></div>
          <div class="field"><label for="rg-agenda">Pauta</label><textarea id="rg-agenda" name="agenda" rows="3" maxlength="5000">${r.agenda || ''}</textarea></div>` : ''}
        <div class="field"><label for="rg-body">${b === 'reuniao' ? 'Resumo da reunião' : 'Descrição'}</label><textarea id="rg-body" name="body" rows="${b === 'reuniao' ? 4 : 5}" maxlength="20000">${r.body || ''}</textarea></div>
        ${b !== 'reuniao' ? html`<div class="field"><label for="rg-by">${b === 'pendencia' ? 'Solicitante' : b === 'decisao' ? 'Quem definiu' : 'Informado por'}</label>
          <input type="text" id="rg-by" name="decided_by" maxlength="160" value="${r.decided_by || ''}" placeholder="${b === 'pendencia' ? 'Ex.: Cliente — Sr. Carlos' : 'Ex.: Cliente, projetista, fiscalização…'}"></div>` : ''}
        ${b === 'pendencia' && !(editing && r.task_id) ? html`<fieldset class="fieldset form"><legend>Tarefa gerada automaticamente</legend>
          <div class="form-row">
            <div class="field"><label for="rg-ass">Responsável</label><select id="rg-ass" name="assignee_id"><option value="">Quem registrar (${state.user.name})</option>
              ${users.map(u => html`<option value="${u.id}" ${r.assignee_id === u.id ? 'selected' : ''}>${u.name}</option>`)}</select></div>
            <div class="field"><label for="rg-due">Prazo</label><input id="rg-due" name="due_date" type="date" value="${r.due_date || ''}"></div>
          </div>
          <span class="hint">${approvalNote ? 'Após a aprovação' : 'Ao salvar'}, uma tarefa é criada no projeto para o responsável, com a origem neste registro. Quando a tarefa for concluída, a pendência fica resolvida.</span></fieldset>` : ''}
        ${b === 'pendencia' && editing && r.task_id ? html`<div class="notice">${icon('info')}<span>Responsável e prazo são ajustados na tarefa gerada <a href="#/tarefas/${r.task_id}">${r.task_code}</a>.</span></div>` : ''}
        ${b === 'decisao' && !editing ? html`<div class="field"><label for="rg-rep">Substitui a definição</label><select id="rg-rep" name="replaces_id"><option value="">Nenhuma (nova definição)</option>
            ${vig.map(x => html`<option value="${x.id}" ${r.replaces_id === x.id ? 'selected' : ''}>${x.code ? `${x.code} · ` : ''}${x.title}</option>`)}</select>
          <span class="hint">A definição substituída deixa de valer e fica no histórico.</span></div>` : ''}
        ${b === 'reuniao' ? html`<fieldset class="fieldset form"><legend>Itens da ata</legend>
          <span class="hint">Informação: apenas registro · Definição: passa a valer no projeto · Demanda: vira uma tarefa com responsável e prazo. Definições e tarefas são criadas quando a ata é emitida.</span>
          <ul class="rg-items-edit" id="rg-items">${(r.items?.length ? r.items : [{ kind: 'info' }]).map(i => itemEditor(i, users))}</ul>
          <button type="button" class="btn btn-ghost btn-sm" id="rg-add-item">${icon('plus')}Adicionar item</button></fieldset>` : ''}
        <fieldset class="fieldset form"><legend>Tarefas vinculadas (opcional)</legend>
          <span class="hint">Ligue este registro a tarefas já existentes do projeto. O vínculo aparece na tela da tarefa.</span>
          ${linkedSet.size ? html`<div class="rg-linked-sel">${ptasks.filter(t => linkedSet.has(t.id)).map(t => html`<span class="pill pill-sand">${t.code} · ${t.title}</span>`)}</div>` : ''}
          <input type="search" id="rg-tq" placeholder="Buscar tarefa por código ou título…" aria-label="Buscar tarefa">
          <ul class="rg-tlist">${ptasks.map(t => html`<li data-text="${`${t.code} ${t.title}`.toLowerCase()}"><label><input type="checkbox" name="task_link" value="${t.id}" ${linkedSet.has(t.id) ? 'checked' : ''}>
            <span class="mono muted">${t.code}</span><span class="grow">${t.parent_code ? '↳ ' : ''}${t.title}</span>${taskStatus(t.eff_status)}</label></li>`)}</ul>
        </fieldset>
        <div class="field"><label for="rg-files">Anexos (fotos ou PDF)</label><input id="rg-files" type="file" accept="image/*,application/pdf,.pdf" multiple>
          <span class="hint">Até 10 por vez · PDF até 8 MB. ${b === 'reuniao' ? 'Ex.: lista de presença, apresentação.' : ''}</span></div>
        <label class="switch"><input type="checkbox" name="pinned" ${r.pinned ? 'checked' : ''}>Fixar no topo dos registros do projeto</label>
        <div class="form-error" hidden></div>
        <div class="form-actions">
          <a class="btn btn-ghost" href="${editing ? recHref(pid, r.id) : query.get('tarefa') ? `#/tarefas/${query.get('tarefa')}` : `#/projetos/${pid}/registros`}">Cancelar</a>
          ${b === 'reuniao' ? html`<button type="submit" class="btn btn-ghost" data-mode="draft">${icon('check')}Salvar rascunho</button><button type="submit" class="btn btn-primary" data-mode="emit">${icon('send')}Salvar e emitir</button>`
            : html`<button type="submit" class="btn btn-primary">${icon('check')}${editing ? 'Salvar' : 'Registrar'}</button>`}
        </div>
      </form>`,
    mount(root) {
      const f = root.querySelector('#rg-form');
      const ul = root.querySelector('#rg-items');
      if (ul) {
        bindItemEditors(ul);
        root.querySelector('#rg-add-item').addEventListener('click', () => {
          ul.insertAdjacentHTML('beforeend', itemEditor({ kind: 'info' }, users).toString());
          ul.lastElementChild.querySelector('textarea').focus();
        });
      }
      const tq = root.querySelector('#rg-tq');
      tq?.addEventListener('input', () => { const v = tq.value.trim().toLowerCase(); root.querySelectorAll('.rg-tlist li').forEach(li => { li.hidden = !!v && !li.dataset.text.includes(v) && !li.querySelector('input').checked; }); });
      let mode = 'draft';
      f.querySelectorAll('[data-mode]').forEach(btn => btn.addEventListener('click', () => { mode = btn.dataset.mode; }));
      f.addEventListener('submit', async e => {
        e.preventDefault();
        const err = f.querySelector('.form-error');
        err.hidden = true;
        const d = Object.fromEntries(new FormData(f));
        d.pinned = f.pinned.checked;
        d.task_ids = [...f.querySelectorAll('[name=task_link]:checked')].map(c => Number(c.value));
        delete d.task_link;
        d.type_id = type.id;
        if (d.assignee_id === '') d.assignee_id = null;
        if (ul) d.items = readItemEditors(ul);
        const btns = f.querySelectorAll('button[type=submit]');
        try {
          if (b === 'reuniao' && mode === 'emit') {
            const nd = d.items.filter(i => i.kind === 'demanda').length;
            const nf = d.items.filter(i => i.kind === 'definicao').length;
            if (!(await confirmSheet('Salvar e emitir ata', `A ata ficará travada${nd ? `, ${nd} tarefa(s) serão criadas` : ''}${nf ? ` e ${nf} definição(ões) passarão a valer` : ''}. Confirmar?`, 'Emitir'))) return;
            d.emit = true;
          }
          btns.forEach(x => (x.disabled = true));
          d.files = await readAttachments(f.querySelector('#rg-files').files || []);
          let id = r.id;
          if (editing) await api(`/records/${id}`, { method: 'PUT', body: d });
          else id = (await api(`/projects/${pid}/records`, { method: 'POST', body: d })).id;
          toast(d.emit ? 'Ata emitida.' : editing ? 'Registro atualizado.' : 'Registro criado.');
          navigate(`/projetos/${pid}/registros/${id}`);
        } catch (ex) {
          err.textContent = ex.message;
          err.hidden = false;
          btns.forEach(x => (x.disabled = false));
        }
      });
    },
  };
}
