// Processos da Empresa: manual de procedimentos (como cada atividade deve ser executada).
// Mapa de processos (por área) · ficha com o fluxo de etapas e pontos de controle · editor (rascunho → publicar).
// Leitura: todos os usuários (versões publicadas). Edição: seção "processos".
import { html, raw, esc, api, icon, fmtDate, fmtDateTime } from '../core.js';
import { toast, sheet, confirmSheet, readAttachments, lightbox } from '../ui.js';
import { pageHead } from './shared.js';

// Cor de cada responsável dentro do processo (mesma pessoa/área = mesma cor)
const PALETTE = ['#2A3D50', '#C9520F', '#1F6FB2', '#2E8B57', '#7A4FA3', '#A86F0E', '#0F7C83', '#B03A5B', '#5B6B7A'];
export function respColors(steps = []) {
  const m = new Map();
  for (const s of steps) if (!m.has(s.responsible)) m.set(s.responsible, PALETTE[m.size % PALETTE.length]);
  return m;
}
export const LINK_KIND = { video: ['Vídeo', '▶'], ajuda: ['Central de ajuda', '?'], link: ['Link', '↗'] };

// Texto do "como fazer": linhas com "- " viram lista; **texto** em negrito
export function richText(s) {
  if (!s) return '';
  const lines = String(s).split('\n');
  let out = '', inList = false;
  const inline = t => esc(t).replace(/\*\*(.+?)\*\*/g, '<b>$1</b>');
  for (const l of lines) {
    const m = /^\s*[-•*]\s+(.*)$/.exec(l);
    if (m) { if (!inList) { out += '<ul>'; inList = true; } out += `<li>${inline(m[1])}</li>`; continue; }
    if (inList) { out += '</ul>'; inList = false; }
    out += l.trim() ? `<p>${inline(l)}</p>` : '';
  }
  if (inList) out += '</ul>';
  return raw(out);
}

const statusTag = p => p.status === 'arquivado' ? html`<span class="pr-tag pr-tag-off">Arquivado</span>`
  : p.review_status === 'enviado' ? html`<span class="pr-tag pr-tag-wait">Aguardando aprovação</span>`
  : p.review_status === 'devolvido' ? html`<span class="pr-tag pr-tag-ret">Devolvido para ajustes</span>`
  : p.status === 'rascunho' ? html`<span class="pr-tag pr-tag-draft">Rascunho · não publicado</span>`
  : p.has_draft ? html`<span class="pr-tag pr-tag-draft">Alterações em rascunho</span>` : '';
// Área "Grupo · Subárea" (ex.: Sistema · Gestão de Obras): agrupa pelo grupo, com subtítulos por subárea
export const areaGroup = a => String(a || 'Sem área').split(' · ')[0].trim() || 'Sem área';
const areaSub = a => String(a || '').split(' · ').slice(1).join(' · ').trim();
const SUB_ORDER = ['Gestão de Obras', 'Gestão da Empresa', 'Gestão da Equipe', 'Administração'];
const subRank = s => (s ? (SUB_ORDER.includes(s) ? SUB_ORDER.indexOf(s) : 50) : -1);
const freqTag = f => (f ? html`<span class="pr-freq">${icon('clock')}${f}</span>` : '');

// ---------- Mapa de processos ----------
export async function list({ query, state, setQuery }) {
  const arq = query.get('arq') === '1';
  const data = await api('/processes', { query: { arquivados: arq ? '1' : '' } });
  const area = query.get('area') || '';
  const s = data.summary;
  const areas = [...new Set(data.items.map(i => areaGroup(i.area)))].sort((a, b) => a.localeCompare(b, 'pt-BR'));
  const card = i => html`
          <a class="pr-card ${i.status !== 'publicado' ? 'is-off' : ''}" href="#/processos/${i.id}" data-freq="${i.frequency || ''}" data-text="${[i.code, i.title, i.objective, i.area, ...(i.people || [])].join(' ').toLowerCase()}">
            <div class="pr-card-top"><span class="pr-code">${i.code}</span>${freqTag(i.frequency)}</div>
            <h3>${i.title}</h3>
            <p>${i.objective || ''}</p>
            <div class="pr-card-foot"><span>${i.steps} etapa(s)</span>${i.controls ? html`<span class="pr-ctl-mini">◆ ${i.controls} ponto(s) de controle</span>` : ''}${statusTag(i)}</div>
          </a>`;
  const groupBody = a => {
    const its = data.items.filter(i => areaGroup(i.area) === a);
    const subs = [...new Set(its.map(i => areaSub(i.area)))].sort((x, y) => subRank(x) - subRank(y) || x.localeCompare(y, 'pt-BR'));
    if (subs.length === 1 && !subs[0]) return html`<div class="pr-grid">${its.map(card)}</div>`;
    return subs.map(sb => html`<div class="pr-subsec" data-subsec>${sb ? html`<h3 class="pr-sub-h">${sb}</h3>` : ''}<div class="pr-grid">${its.filter(i => areaSub(i.area) === sb).map(card)}</div></div>`);
  };
  const freqs = [...new Set(data.items.map(i => i.frequency).filter(Boolean))];
  return {
    title: 'Processos da Empresa',
    html: html`
      ${pageHead({
        eyebrow: 'Gestão da Empresa',
        title: 'Processos da Empresa',
        sub: 'Manual de procedimentos: como cada atividade deve ser executada, quem faz e onde estão os pontos de controle.',
        actions: html`<a class="btn btn-ghost" href="#/processos/mapa">${icon('team')}Mapa mental</a>
          <a class="btn btn-ghost" href="#/imprimir/processos">${icon('print')}Imprimir manual</a>
          ${data.can_edit ? html`<a class="btn btn-primary" href="#/processos/novo">${icon('plus')}Novo processo</a>` : ''}`,
      })}
      <div class="pr-stats section">
        <div><b>${s.total}</b><span>processos documentados</span></div>
        <div><b>${s.areas}</b><span>áreas</span></div>
        <div><b>${s.controls}</b><span>pontos de controle e aprovação</span></div>
        <div><b>${s.people}</b><span>responsáveis envolvidos</span></div>
      </div>
      ${data.can_approve && s.pending ? html`<div class="notice notice-warn section">${icon('alert')}<span><b>${s.pending} processo(s) aguardando a sua aprovação:</b>
        ${data.items.filter(i => i.review_status === 'enviado').map((i, k) => html`${k ? ' · ' : ' '}<a href="#/processos/${i.id}?ver=rascunho">${i.code} ${i.draft_title || i.title}</a>`)}</span></div>` : ''}
      ${data.can_edit && !data.can_approve && (s.pending || s.returned) ? html`<div class="notice section">${icon('info')}<span>${s.pending ? html`<b>${s.pending}</b> aguardando aprovação do administrador. ` : ''}${s.returned ? html`<b>${s.returned}</b> devolvido(s) para ajustes.` : ''}</span></div>` : ''}
      ${data.can_edit && (s.drafts || s.archived) ? html`<div class="notice section">${icon('info')}<span>${s.drafts ? html`<b>${s.drafts}</b> processo(s) em rascunho (ainda não enviado(s) para aprovação). ` : ''}Rascunhos e arquivados aparecem só para quem edita processos${data.can_approve ? '' : '; a publicação é feita pelo administrador'}.
        ${s.archived ? html`<a href="#/processos${arq ? '' : '?arq=1'}">${arq ? 'Ocultar arquivados' : `Mostrar arquivados (${s.archived})`}</a>` : ''}</span></div>` : ''}
      <div class="rg-filters section">
        <div class="chips pr-chips" role="group" aria-label="Filtrar por área">
          <button type="button" class="chip" data-farea="" aria-pressed="${!area}">Todas<span class="n">${data.items.length}</span></button>
          ${areas.map(a => html`<button type="button" class="chip" data-farea="${a}" aria-pressed="${a === area}">${a}<span class="n">${data.items.filter(i => areaGroup(i.area) === a).length}</span></button>`)}
        </div>
        <div class="rg-filter-row">
          <select id="pr-freq" aria-label="Frequência"><option value="">Todas as frequências</option>${freqs.map(f => html`<option value="${f}">${f}</option>`)}</select>
          <input type="search" id="pr-q" placeholder="Buscar processo, etapa ou responsável…" aria-label="Buscar processos">
        </div>
      </div>
      ${data.items.length ? areas.map(a => html`<section class="section pr-area" data-area="${a}">
        <h2 class="pr-area-h">${a}<span class="n" data-acount></span></h2>
        ${groupBody(a)}</section>`)
        : html`<div class="empty-state"><h2>Nenhum processo cadastrado</h2><p>${data.can_edit ? 'Cadastre o primeiro processo: objetivo, etapas com responsável, pontos de controle, entradas, saídas e indicadores.' : 'Os processos publicados da empresa aparecerão aqui.'}</p></div>`}
      <p class="muted pr-none" hidden>Nenhum processo com esses filtros.</p>
      ${data.can_edit ? html`<a class="fab" href="#/processos/novo" aria-label="Novo processo">${icon('plus')}</a>` : ''}`,
    mount(root) {
      let fa = area;
      const apply = () => {
        const q = root.querySelector('#pr-q').value.trim().toLowerCase();
        const f = root.querySelector('#pr-freq').value;
        let shown = 0;
        root.querySelectorAll('[data-area]').forEach(sec => {
          let n = 0;
          sec.querySelectorAll('.pr-card').forEach(c => {
            const v = (!fa || sec.dataset.area === fa) && (!f || c.dataset.freq === f) && (!q || c.dataset.text.includes(q));
            c.hidden = !v;
            if (v) n++;
          });
          sec.querySelectorAll('[data-subsec]').forEach(ss => { ss.hidden = ![...ss.querySelectorAll('.pr-card')].some(c => !c.hidden); });
          sec.hidden = !n;
          sec.querySelector('[data-acount]').textContent = n;
          shown += n;
        });
        root.querySelector('.pr-none').hidden = !!shown || !data.items.length;
      };
      root.querySelectorAll('[data-farea]').forEach(b => b.addEventListener('click', () => {
        fa = b.dataset.farea;
        root.querySelectorAll('[data-farea]').forEach(x => x.setAttribute('aria-pressed', String(x === b)));
        setQuery({ area: fa, arq: arq ? '1' : '' });
        apply();
      }));
      root.querySelector('#pr-freq').addEventListener('change', apply);
      root.querySelector('#pr-q').addEventListener('input', apply);
      apply();
    },
  };
}

// ---------- Fluxo de etapas (tela) ----------
export function flowHtml(steps = []) {
  const colors = respColors(steps);
  return html`<div class="pr-legend">${[...colors].map(([n, c]) => html`<span class="pr-who-chip" style="--c:${c}">${n}</span>`)}
      ${steps.some(s => s.control) ? html`<span class="pr-legend-ctl">◆ Ponto de controle / aprovação</span>` : ''}</div>
    <ol class="pr-flow">${steps.map((s, i) => html`<li class="pr-step ${s.control ? 'is-ctl' : ''}" style="--c:${colors.get(s.responsible)}" id="etapa-${i + 1}">
      <span class="pr-n">${i + 1}</span>
      <div class="pr-body">
        <div class="pr-who">${s.responsible}</div>
        <div class="pr-act">${s.activity}</div>
        ${s.control ? html`<span class="pr-ctl-tag">◆ Ponto de controle</span>` : ''}
        ${s.control && (s.fail || s.back_to) ? html`<div class="pr-fail">↩ ${s.fail || 'Não conforme'}${s.back_to ? html` · <a href="#etapa-${s.back_to}" data-goto="${s.back_to}">volta à etapa ${s.back_to}</a>` : ''}</div>` : ''}
        ${s.details ? html`<details class="pr-how"><summary>Como fazer</summary><div class="pr-rich">${richText(s.details)}</div></details>` : ''}
      </div></li>`)}</ol>`;
}

const linksHtml = links => html`<ul class="pr-links">${links.map(l => html`<li><a href="${l.url}" target="_blank" rel="noopener noreferrer" class="pr-link pr-link-${l.kind}">
  <span class="pr-link-ic" aria-hidden="true">${(LINK_KIND[l.kind] || LINK_KIND.link)[1]}</span><span><small>${(LINK_KIND[l.kind] || LINK_KIND.link)[0]}</small>${l.label}</span></a></li>`)}</ul>`;

// ---------- Ficha do processo ----------
export async function view({ params, query, navigate, render }) {
  const ver = query.get('ver') || '';
  const p = await api(`/processes/${params.id}`, { query: { ver } });
  const c = p.content;
  const can = p.can;
  const imgs = p.files.filter(f => f.mime !== 'application/pdf');
  const pdfs = p.files.filter(f => f.mime === 'application/pdf');
  const old = typeof p.showing === 'number';
  const draftView = p.showing === 'rascunho';
  let banner = '';
  if (old) banner = html`<div class="notice notice-warn section">${icon('history')}<span>Você está vendo a <b>versão ${p.showing}</b> (antiga). <a href="#/processos/${p.id}">Ver a versão atual</a></span></div>`;
  else if (p.status === 'rascunho' && !p.review?.status) banner = html`<div class="notice notice-warn section">${icon('edit')}<span><b>Rascunho, ainda não publicado.</b> Só quem edita processos vê esta ficha. ${can.approver ? 'Publique para que todos possam consultar.' : 'Envie para aprovação: o administrador publica para que todos possam consultar.'}</span></div>`;
  else if (draftView && p.version) banner = html`<div class="notice notice-warn section">${icon('edit')}<span>Você está vendo o <b>rascunho</b> (salvo por ${p.draft_by_name || '—'} em ${fmtDateTime(p.draft_at)}). Os leitores ainda veem a versão ${p.version}. <a href="#/processos/${p.id}">Ver versão publicada</a></span></div>`;
  else if (p.has_draft && p.version) banner = html`<div class="notice notice-warn section">${icon('edit')}<span>Há <b>alterações em rascunho</b> (por ${p.draft_by_name || '—'} em ${fmtDateTime(p.draft_at)}). Os leitores continuam vendo esta versão até a publicação. <a href="#/processos/${p.id}?ver=rascunho">Ver rascunho</a></span></div>`;
  const rv = p.review;
  if (rv?.status === 'enviado' && !old) banner = html`${banner}<div class="notice notice-warn section pr-review">${icon('clock')}<span><b>Aguardando aprovação do administrador</b> · enviado por ${rv.submitted_by_name || '—'} em ${fmtDateTime(rv.submitted_at)}${rv.submit_note ? html`<br>O que mudou: <i>${rv.submit_note}</i>` : ''}
    ${!draftView && p.status !== 'rascunho' ? html`<br><a href="#/processos/${p.id}?ver=rascunho">Ver o que foi enviado</a>` : ''}</span></div>`;
  if (rv?.status === 'devolvido' && !old) banner = html`${banner}<div class="notice notice-err section pr-review">${icon('alert')}<span><b>Devolvido para ajustes</b> por ${rv.reviewed_by_name || '—'} em ${fmtDateTime(rv.reviewed_at)}:<br><i>${rv.note}</i>${can.edit ? html`<br>Ajuste e envie de novo para aprovação.` : ''}</span></div>`;
  if (p.status === 'arquivado') banner = html`${banner}<div class="notice section">${icon('info')}<span><b>Processo arquivado:</b> não aparece para os leitores.</span></div>`;
  const vInfo = p.version ? `Versão ${p.version}${p.published_at ? ` · publicada em ${fmtDate(p.published_at.slice(0, 10))}` : ''}` : 'Ainda não publicado';
  return {
    title: `${p.code} · ${c.title}`,
    html: html`
      ${pageHead({
        back: { href: '#/processos', label: 'Processos da Empresa' },
        eyebrow: `${p.code} · ${c.area || ''}`,
        title: c.title,
        sub: html`${c.frequency ? html`Frequência: <b>${c.frequency}</b> · ` : ''}${vInfo}`,
        actions: html`<a class="btn btn-ghost" href="#/imprimir/processo/${p.id}${draftView ? '?ver=rascunho' : old ? `?ver=${p.showing}` : ''}">${icon('print')}Imprimir</a>
          ${can.edit && !old ? html`<a class="btn btn-ghost" href="#/processos/${p.id}/editar">${icon('edit')}Editar</a>` : ''}
          ${can.return && !old ? html`<button type="button" class="btn btn-ghost" data-return>${icon('back')}Devolver</button>` : ''}
          ${can.submit && !old ? html`<button type="button" class="btn btn-primary" data-submit>${icon('send')}Enviar para aprovação</button>` : ''}
          ${can.publish && !old ? html`<button type="button" class="btn btn-primary" data-publish>${icon('check')}${rv?.status === 'enviado' ? 'Aprovar e publicar' : 'Publicar'}</button>` : ''}`,
      })}
      ${banner}
      <div class="pr-layout">
        <div class="pr-main">
          <section class="card section"><div class="card-body pr-objective">
            <div class="sub-label">Objetivo</div><p>${c.objective}</p>
            ${c.erp_module ? html`<div class="pr-erp"><span class="sub-label">Módulo no ERP</span><b>${c.erp_module}</b></div>` : ''}
            ${c.links?.length ? html`<div class="sub-label" style="margin-top:12px">Material de apoio</div>${linksHtml(c.links)}` : ''}
          </div></section>
          <section class="card section">
            <div class="card-head"><h2>${icon('tasks')}Fluxo de etapas</h2><span class="sub">${c.steps.length} etapa(s) · ${c.steps.filter(s => s.control).length} ponto(s) de controle</span></div>
            <div class="card-body">${flowHtml(c.steps)}</div>
          </section>
        </div>
        <aside class="pr-side">
          ${c.inputs ? html`<section class="card section pr-box"><div class="card-body"><div class="sub-label">Entradas</div><p class="pre">${c.inputs}</p></div></section>` : ''}
          ${c.outputs ? html`<section class="card section pr-box"><div class="card-body"><div class="sub-label">Saídas</div><p class="pre">${c.outputs}</p></div></section>` : ''}
          ${c.rules ? html`<section class="card section pr-box pr-rules"><div class="card-body"><div class="sub-label">Regras e cuidados</div><p class="pre">${c.rules}</p></div></section>` : ''}
          ${c.indicators?.length ? html`<section class="card section pr-box"><div class="card-body"><div class="sub-label">Indicadores</div><ul class="pr-ind">${c.indicators.map(x => html`<li>${x}</li>`)}</ul></div></section>` : ''}
          ${p.files.length || can.files ? html`<section class="card section"><div class="card-head"><h2>${icon('file')}Documentos e modelos</h2><span class="sub">${p.files.length}</span></div><div class="card-body">
            ${imgs.length ? html`<div class="thumbs">${imgs.map(f => html`<figure class="thumb"><button type="button" class="thumb-btn" data-src="/api/process-files/${f.id}" data-cap="${f.caption || f.original_name || ''}"><img src="/api/process-files/${f.id}" alt="${f.caption || 'Documento'}" loading="lazy"></button>
              ${can.files ? html`<button type="button" class="rm" data-rmf="${f.id}" aria-label="Remover">✕</button>` : ''}</figure>`)}</div>` : ''}
            ${pdfs.length ? html`<ul class="rg-pdfs">${pdfs.map(f => html`<li><a href="/api/process-files/${f.id}" target="_blank" rel="noopener">${icon('file')}${f.original_name || 'documento.pdf'}</a>${can.files ? html`<button type="button" class="icon-btn" data-rmf="${f.id}" aria-label="Remover">✕</button>` : ''}</li>`)}</ul>` : ''}
            ${!p.files.length ? html`<p class="muted" style="margin:0 0 10px">Nenhum documento. Inclua modelos, formulários ou exemplos em PDF ou imagem.</p>` : ''}
            ${can.files ? html`<label class="btn btn-ghost btn-sm">${icon('plus')}Anexar PDF ou imagem<input type="file" hidden accept="image/*,application/pdf,.pdf" multiple data-attach></label>` : ''}
          </div></section>` : ''}
          ${c.related_items?.length ? html`<section class="card section"><div class="card-head"><h2>${icon('projects')}Processos relacionados</h2></div>
            <ul class="rows">${c.related_items.map(r => html`<li><a class="row-link" href="#/processos/${r.id}"><div class="grow"><div class="row-title">${r.title}</div><div class="row-meta"><span class="mono">${r.code}</span></div></div><span class="chev">${icon('chevron')}</span></a></li>`)}</ul></section>` : ''}
          <section class="card section pr-box"><div class="card-body">
            <div class="sub-label">Responsável pelo processo</div><p>${p.owner_name || html`<span class="muted">Não definido</span>`}</p>
            ${p.versions.length ? html`<div class="sub-label" style="margin-top:12px">Histórico de versões</div>
              <ul class="pr-versions">${p.versions.map(v => html`<li class="${v.version === (old ? p.showing : p.version) && !draftView ? 'is-cur' : ''}">
                <a href="#/processos/${p.id}${v.version === p.version ? '' : `?ver=${v.version}`}"><b>Versão ${v.version}</b> · ${fmtDate(v.published_at.slice(0, 10))}${v.published_by_name ? ` · ${v.published_by_name}` : ''}</a>
                ${v.note ? html`<small>${v.note}</small>` : ''}</li>`)}</ul>` : ''}
          </div></section>
          ${can.edit && !old && (can.discard || can.archive || can.restore || can.remove) ? html`<div class="pr-admin-acts">
            ${can.discard ? html`<button type="button" class="btn btn-ghost btn-sm" data-act="descartar">${icon('x')}Descartar rascunho</button>` : ''}
            ${can.archive ? html`<button type="button" class="btn btn-ghost btn-sm" data-act="arquivar">${icon('history')}Arquivar processo</button>` : ''}
            ${can.restore ? html`<button type="button" class="btn btn-ghost btn-sm" data-act="restaurar">${icon('check')}Restaurar (publicar de novo)</button>` : ''}
            ${can.remove ? html`<button type="button" class="btn btn-ghost btn-sm pr-danger" data-remove>${icon('trash')}Excluir rascunho</button>` : ''}
          </div>` : ''}
        </aside>
      </div>`,
    mount(root) {
      root.querySelectorAll('[data-goto]').forEach(a => a.addEventListener('click', e => {
        e.preventDefault();
        const el = root.querySelector(`#etapa-${a.dataset.goto}`);
        el?.scrollIntoView({ behavior: 'smooth', block: 'center' });
        el?.classList.add('flash');
        setTimeout(() => el?.classList.remove('flash'), 1400);
      }));
      root.querySelectorAll('.thumb-btn').forEach(b => b.addEventListener('click', () => lightbox(b.dataset.src, b.dataset.cap)));
      root.querySelector('[data-publish]')?.addEventListener('click', () => publishSheet(p, () => navigate(`/processos/${p.id}`, { replace: true })));
      root.querySelector('[data-submit]')?.addEventListener('click', () => submitSheet(p, () => render()));
      root.querySelector('[data-return]')?.addEventListener('click', () => sheet({
        title: 'Devolver para ajustes',
        body: html`<p class="muted" style="margin-top:0">O processo continua em rascunho e quem enviou vê o motivo para ajustar e enviar de novo.</p>
          <div class="field"><label class="req" for="ret-note">Motivo / o que ajustar</label><textarea id="ret-note" name="note" rows="4" maxlength="1000" required></textarea></div>`,
        submitLabel: 'Devolver',
        async onSubmit(d) {
          if (!String(d.note || '').trim()) throw new Error('Informe o motivo da devolução.');
          await api(`/processes/${p.id}/devolver`, { method: 'POST', body: { note: d.note } });
          toast('Processo devolvido para ajustes.');
          render();
        },
      }));
      root.querySelectorAll('[data-act]').forEach(b => b.addEventListener('click', async () => {
        const a = b.dataset.act;
        const msg = { descartar: ['Descartar rascunho', 'As alterações não publicadas serão perdidas. A versão publicada continua valendo.', 'Descartar'],
          arquivar: ['Arquivar processo', 'O processo deixa de aparecer para os leitores. Ele e o histórico ficam guardados e podem ser restaurados.', 'Arquivar'],
          restaurar: ['Restaurar processo', 'O processo volta a aparecer para todos os usuários.', 'Restaurar'] }[a];
        if (!(await confirmSheet(msg[0], msg[1], msg[2], a !== 'restaurar'))) return;
        try { await api(`/processes/${p.id}/${a}`, { method: 'POST', body: {} }); toast('Feito.'); navigate(`/processos/${p.id}`, { replace: true }); } catch (e) { toast(e.message, 'error'); }
      }));
      root.querySelector('[data-remove]')?.addEventListener('click', async () => {
        if (!(await confirmSheet('Excluir rascunho', 'Este processo nunca foi publicado e será excluído.', 'Excluir', true))) return;
        try { await api(`/processes/${p.id}`, { method: 'DELETE' }); toast('Rascunho excluído.'); navigate('/processos'); } catch (e) { toast(e.message, 'error'); }
      });
      root.querySelectorAll('[data-rmf]').forEach(b => b.addEventListener('click', async () => {
        if (!(await confirmSheet('Remover documento', 'O arquivo será removido deste processo.', 'Remover', true))) return;
        try { await api(`/processes/${p.id}/files/${b.dataset.rmf}`, { method: 'DELETE' }); render(); } catch (e) { toast(e.message, 'error'); }
      }));
      root.querySelector('[data-attach]')?.addEventListener('change', async e => {
        try {
          const files = await readAttachments(e.target.files);
          if (!files.length) return;
          toast('Enviando documentos…', 'warn');
          await api(`/processes/${p.id}/files`, { method: 'POST', body: { files } });
          toast('Documentos incluídos.');
          render();
        } catch (ex) { toast(ex.message, 'error'); }
      });
    },
  };
}

// Publicar: pede o resumo do que mudou (vai para o histórico de versões)
function publishSheet(p, done, save) {
  const pending = p.review?.status === 'enviado';
  sheet({
    title: pending ? 'Aprovar e publicar' : p.version ? `Publicar versão ${p.version + 1}` : 'Publicar processo',
    body: html`<p class="muted" style="margin-top:0">${pending ? html`Enviado por <b>${p.review.submitted_by_name}</b>. ` : ''}A partir da publicação, todos os usuários passam a ver esta versão. A anterior fica no histórico.</p>
      <div class="field"><label for="pub-note">O que mudou${p.version ? '' : ' (opcional)'}</label><textarea id="pub-note" name="note" rows="3" maxlength="500" placeholder="${p.version ? 'Ex.: incluída a conferência do financeiro na etapa 3' : 'Ex.: primeira versão'}">${p.review?.submit_note || ''}</textarea></div>`,
    submitLabel: pending ? 'Aprovar e publicar' : 'Publicar',
    async onSubmit(data) {
      const note = data.note || '';
      if (save) await save(note);
      else await api(`/processes/${p.id}/publicar`, { method: 'POST', body: { note } });
      toast('Processo publicado.');
      done();
    },
  });
}

// Envio para aprovação (gestor/coordenador): o administrador publica ou devolve
function submitSheet(p, done, save) {
  sheet({
    title: 'Enviar para aprovação',
    body: html`<p class="muted" style="margin-top:0">O administrador revisa e publica (ou devolve com o motivo). Até lá, ${p?.version ? `todos continuam vendo a versão ${p.version}` : 'o processo fica visível só para quem edita processos'}.</p>
      <div class="field"><label for="sub-note">O que mudou${p?.version ? '' : ' (opcional)'}</label><textarea id="sub-note" name="note" rows="3" maxlength="500" placeholder="${p?.version ? 'Ex.: incluída a conferência do financeiro na etapa 3' : 'Ex.: primeira versão'}"></textarea></div>`,
    submitLabel: 'Enviar',
    async onSubmit(data) {
      const note = data.note || '';
      if (save) await save(note);
      else await api(`/processes/${p.id}/enviar`, { method: 'POST', body: { note } });
      toast('Enviado para aprovação do administrador.');
      done();
    },
  });
}

// ---------- Editor ----------
function stepEditor(s = {}, i = 0) {
  return html`<li class="pr-se ${s.control ? 'is-ctl' : ''}" data-se>
    <div class="pr-se-head"><span class="pr-n" data-se-n>${i + 1}</span>
      <div class="pr-se-move"><button type="button" class="icon-btn" data-se-up aria-label="Subir etapa">↑</button><button type="button" class="icon-btn" data-se-down aria-label="Descer etapa">↓</button>
      <button type="button" class="icon-btn" data-se-rm aria-label="Remover etapa">✕</button></div></div>
    <div class="form-row pr-row-step">
      <div class="field"><label class="req">Responsável</label><input type="text" data-f="responsible" list="pr-resp" maxlength="80" value="${s.responsible || ''}" placeholder="Função, área ou sistema"></div>
      <div class="field pr-se-act"><label class="req">Atividade</label><input type="text" data-f="activity" maxlength="300" value="${s.activity || ''}" placeholder="O que é feito nesta etapa"></div>
    </div>
    <label class="pr-se-check"><input type="checkbox" data-f="control" ${s.control ? 'checked' : ''}> Ponto de controle / aprovação</label>
    <div class="form-row pr-se-ctl" ${s.control ? '' : 'hidden'}>
      <div class="field"><label>Se não conforme</label><input type="text" data-f="fail" maxlength="200" value="${s.fail || ''}" placeholder="Ex.: Reprovada → retorna para nova conferência"></div>
      <div class="field"><label>Volta para a etapa</label><select data-f="back_to" data-back="${s.back_to || ''}"></select></div>
    </div>
    <details class="pr-se-how" ${s.details ? 'open' : ''}><summary>Como fazer (opcional)</summary>
      <textarea data-f="details" rows="4" maxlength="5000" placeholder="Passo a passo detalhado. Use “- ” no início da linha para listas e **texto** para negrito.">${s.details || ''}</textarea></details>
  </li>`;
}

function linkEditor(l = {}) {
  return html`<li class="pr-le" data-le>
    <select data-f="kind" aria-label="Tipo">${Object.entries(LINK_KIND).map(([k, [lab]]) => html`<option value="${k}" ${(l.kind || 'video') === k ? 'selected' : ''}>${lab}</option>`)}</select>
    <input type="text" data-f="label" maxlength="160" value="${l.label || ''}" placeholder="Descrição (ex.: Treinamento App Diário de Obra)" aria-label="Descrição">
    <input type="text" inputmode="url" data-f="url" maxlength="600" value="${l.url || ''}" placeholder="https://…" aria-label="Endereço">
    <button type="button" class="icon-btn" data-le-rm aria-label="Remover">✕</button></li>`;
}

export async function form({ params, state, navigate }) {
  if (!state.meta.can.edit_processes) throw new Error('A edição de processos não está liberada para o seu usuário.');
  const editing = !!params.id;
  const [p, all] = await Promise.all([editing ? api(`/processes/${params.id}`, { query: { ver: 'rascunho' } }) : Promise.resolve(null), api('/processes', { query: { arquivados: '1' } })]);
  const c = editing ? p.editable : { steps: [{}, {}], links: [], indicators: [], related: [] };
  const others = all.items.filter(i => !p || i.id !== p.id);
  const relSet = new Set(c.related || []);
  const resp = [...new Set([...all.items.flatMap(i => i.people || []), ...(state.meta.users || []).map(u => u.job_title).filter(Boolean)])].sort((a, b) => a.localeCompare(b, 'pt-BR'));
  const users = (state.meta.users || []).filter(u => u.active && !u.is_external);
  return {
    title: editing ? `Editar ${p.code}` : 'Novo processo',
    html: html`
      ${pageHead({
        back: editing ? { href: `#/processos/${p.id}`, label: `${p.code} · ${c.title}` } : { href: '#/processos', label: 'Processos da Empresa' },
        eyebrow: 'Processos da Empresa',
        title: editing ? `Editar ${p.code}` : 'Novo processo',
        sub: state.meta.can.approve_processes
          ? (editing && p.version ? `As alterações ficam em rascunho até você publicar. Até lá, todos continuam vendo a versão ${p.version}.` : 'O processo fica em rascunho até ser publicado.')
          : `As alterações ficam em rascunho; envie para aprovação e o administrador publica.${editing && p.version ? ` Até lá, todos continuam vendo a versão ${p.version}.` : ''}`,
      })}
      <form class="card card-pad form pr-form" id="pr-form" novalidate>
        <div class="form-row pr-row-code">
          <div class="field pr-f-code"><label for="pr-code">Código</label><input type="text" id="pr-code" name="code" maxlength="15" value="${editing ? p.pending_code || p.code : ''}" placeholder="Automático (PRC-09)"></div>
          <div class="field pr-f-title"><label class="req" for="pr-title">Nome do processo</label><input type="text" id="pr-title" name="title" maxlength="120" required value="${c.title || ''}" placeholder="Ex.: Medição de Obras"></div>
        </div>
        <div class="form-row form-row-3">
          <div class="field"><label class="req" for="pr-area">Área</label><input type="text" id="pr-area" name="area" list="pr-areas" maxlength="60" required value="${c.area || ''}" placeholder="Ex.: Obras, Engenharia, Suprimentos">
            <datalist id="pr-areas">${all.areas.map(a => html`<option value="${a}">`)}</datalist></div>
          <div class="field"><label for="pr-freq">Frequência</label><input type="text" id="pr-freq" name="frequency" list="pr-freqs" maxlength="40" value="${c.frequency || ''}" placeholder="Diária, Mensal, Sob demanda…">
            <datalist id="pr-freqs">${all.frequencies.map(f => html`<option value="${f}">`)}</datalist></div>
          <div class="field"><label for="pr-owner">Responsável pelo processo</label><select id="pr-owner" name="owner_id"><option value="">Não definido</option>
            ${users.map(u => html`<option value="${u.id}" ${(p && p.pending_owner_id !== undefined ? p.pending_owner_id : p?.owner_id) === u.id ? 'selected' : ''}>${u.name}${u.job_title ? ` · ${u.job_title}` : ''}</option>`)}</select>
            <span class="hint">Quem mantém o processo atualizado.</span></div>
        </div>
        <div class="field"><label class="req" for="pr-obj">Objetivo</label><textarea id="pr-obj" name="objective" rows="2" maxlength="1000" required placeholder="Para que serve este processo">${c.objective || ''}</textarea></div>
        <div class="field"><label for="pr-erp">Módulo no ERP / sistema</label><input type="text" id="pr-erp" name="erp_module" maxlength="200" value="${c.erp_module || ''}" placeholder="Ex.: Obras → Medição de Obras"></div>
        <fieldset class="fieldset form"><legend>Material de apoio</legend>
          <span class="hint">Vídeos de treinamento, artigos da central de ajuda e outros links.</span>
          <ul class="pr-le-list" id="pr-links">${(c.links || []).map(l => linkEditor(l))}</ul>
          <button type="button" class="btn btn-ghost btn-sm" id="pr-add-link">${icon('plus')}Adicionar material</button></fieldset>
        <fieldset class="fieldset form"><legend>Fluxo de etapas</legend>
          <span class="hint">Em ordem de execução. Marque os pontos de controle/aprovação e indique o que acontece quando não está conforme.</span>
          <datalist id="pr-resp">${resp.map(r => html`<option value="${r}">`)}</datalist>
          <ol class="pr-se-list" id="pr-steps">${(c.steps?.length ? c.steps : [{}]).map((s, i) => stepEditor(s, i))}</ol>
          <button type="button" class="btn btn-ghost btn-sm" id="pr-add-step">${icon('plus')}Adicionar etapa</button></fieldset>
        <div class="form-row">
          <div class="field"><label for="pr-in">Entradas</label><textarea id="pr-in" name="inputs" rows="3" maxlength="3000" placeholder="O que é necessário para começar">${c.inputs || ''}</textarea></div>
          <div class="field"><label for="pr-out">Saídas</label><textarea id="pr-out" name="outputs" rows="3" maxlength="3000" placeholder="O que o processo entrega">${c.outputs || ''}</textarea></div>
        </div>
        <div class="field"><label for="pr-rules">Regras e cuidados</label><textarea id="pr-rules" name="rules" rows="3" maxlength="3000" placeholder="Regras obrigatórias, cuidados e erros comuns">${c.rules || ''}</textarea></div>
        <div class="field"><label for="pr-ind">Indicadores</label><textarea id="pr-ind" name="indicators" rows="3" maxlength="4000" placeholder="Um por linha">${(c.indicators || []).join('\n')}</textarea></div>
        ${others.length ? html`<fieldset class="fieldset form"><legend>Processos relacionados</legend>
          <div class="checks pr-rel">${others.map(o => html`<label><input type="checkbox" name="related" value="${o.id}" ${relSet.has(o.id) ? 'checked' : ''}><span class="mono">${o.code}</span> ${o.title}</label>`)}</div></fieldset>` : ''}
        <div class="form-actions">
          <a class="btn btn-ghost" href="${editing ? `#/processos/${p.id}` : '#/processos'}">Cancelar</a>
          <button type="submit" class="btn btn-ghost" data-mode="draft">${icon('edit')}Salvar rascunho</button>
          ${state.meta.can.approve_processes ? html`<button type="submit" class="btn btn-primary" data-mode="publish">${icon('check')}Salvar e publicar</button>`
            : html`<button type="submit" class="btn btn-primary" data-mode="submit">${icon('send')}Salvar e enviar para aprovação</button>`}
        </div>
      </form>`,
    mount(root) {
      const f = root.querySelector('#pr-form');
      const stepsEl = root.querySelector('#pr-steps');
      const renumber = () => {
        const items = [...stepsEl.querySelectorAll('[data-se]')];
        items.forEach((li, i) => {
          li.querySelector('[data-se-n]').textContent = i + 1;
          const sel = li.querySelector('[data-f="back_to"]');
          const cur = sel.value || sel.dataset.back || '';
          sel.innerHTML = html`<option value="">Nenhuma (segue o texto)</option>${items.map((_, j) => (j === i ? '' : html`<option value="${j + 1}" ${String(j + 1) === cur ? 'selected' : ''}>Etapa ${j + 1}</option>`))}`.toString();
          sel.dataset.back = '';
        });
      };
      const bindStep = li => {
        li.querySelector('[data-f="control"]').addEventListener('change', e => { li.classList.toggle('is-ctl', e.target.checked); li.querySelector('.pr-se-ctl').hidden = !e.target.checked; });
        li.querySelector('[data-se-rm]').addEventListener('click', () => { if (stepsEl.children.length > 1) { li.remove(); renumber(); } else toast('O processo precisa de ao menos uma etapa.', 'warn'); });
        li.querySelector('[data-se-up]').addEventListener('click', () => { if (li.previousElementSibling) { stepsEl.insertBefore(li, li.previousElementSibling); renumber(); } });
        li.querySelector('[data-se-down]').addEventListener('click', () => { if (li.nextElementSibling) { stepsEl.insertBefore(li.nextElementSibling, li); renumber(); } });
      };
      stepsEl.querySelectorAll('[data-se]').forEach(bindStep);
      renumber();
      root.querySelector('#pr-add-step').addEventListener('click', () => {
        const t = document.createElement('template');
        t.innerHTML = stepEditor({}, stepsEl.children.length).toString().trim();
        const li = t.content.firstElementChild;
        stepsEl.appendChild(li);
        bindStep(li);
        renumber();
        li.querySelector('[data-f="responsible"]').focus();
      });
      const linksEl = root.querySelector('#pr-links');
      const bindLink = li => li.querySelector('[data-le-rm]').addEventListener('click', () => li.remove());
      linksEl.querySelectorAll('[data-le]').forEach(bindLink);
      root.querySelector('#pr-add-link').addEventListener('click', () => {
        const t = document.createElement('template');
        t.innerHTML = linkEditor({}).toString().trim();
        const li = t.content.firstElementChild;
        linksEl.appendChild(li);
        bindLink(li);
        li.querySelector('[data-f="label"]').focus();
      });
      const collect = () => {
        const fd = new FormData(f);
        const val = (li, k) => li.querySelector(`[data-f="${k}"]`);
        return {
          code: fd.get('code'), title: fd.get('title'), area: fd.get('area'), frequency: fd.get('frequency'), owner_id: fd.get('owner_id'),
          objective: fd.get('objective'), erp_module: fd.get('erp_module'), inputs: fd.get('inputs'), outputs: fd.get('outputs'), rules: fd.get('rules'),
          indicators: String(fd.get('indicators') || '').split('\n'),
          related: fd.getAll('related').map(Number),
          links: [...linksEl.querySelectorAll('[data-le]')].map(li => ({ kind: val(li, 'kind').value, label: val(li, 'label').value, url: val(li, 'url').value })).filter(l => l.url.trim() || l.label.trim()),
          steps: [...stepsEl.querySelectorAll('[data-se]')].map(li => ({
            responsible: val(li, 'responsible').value, activity: val(li, 'activity').value, details: val(li, 'details').value,
            control: val(li, 'control').checked, fail: val(li, 'fail').value, back_to: val(li, 'back_to').value,
          })),
        };
      };
      let mode = 'draft';
      f.querySelectorAll('[data-mode]').forEach(b => b.addEventListener('click', () => { mode = b.dataset.mode; }));
      const save = async (body, publish, note, submit = false) => {
        const res = editing ? await api(`/processes/${p.id}`, { method: 'PUT', body: { ...body, publish, submit, note } })
          : await api('/processes', { method: 'POST', body: { ...body, publish, submit, note } });
        return res;
      };
      f.addEventListener('submit', async e => {
        e.preventDefault();
        const body = collect();
        const btns = f.querySelectorAll('button[type=submit]');
        if (mode === 'publish') {
          publishSheet(p || { version: 0 }, () => {}, async note => {
            const res = await save(body, true, note);
            navigate(`/processos/${res.id}`, { replace: true });
          });
          return;
        }
        if (mode === 'submit') {
          submitSheet(p, () => {}, async note => {
            const res = await save(body, false, note, true);
            navigate(`/processos/${res.id}?ver=rascunho`, { replace: true });
          });
          return;
        }
        btns.forEach(b => (b.disabled = true));
        try {
          const res = await save(body, false);
          toast(state.meta.can.approve_processes ? 'Rascunho salvo. Publique para que todos vejam.' : 'Rascunho salvo. Envie para aprovação quando estiver pronto.');
          navigate(`/processos/${res.id}?ver=rascunho`, { replace: true });
        } catch (ex) { toast(ex.message, 'error'); btns.forEach(b => (b.disabled = false)); }
      });
    },
  };
}
