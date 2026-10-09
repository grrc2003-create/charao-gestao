// Check-list: cadastro rápido dos itens (Enter, colar lista, "# Grupo", "@Nome") e preenchimento item a item
// numa tela só (Conforme / Não conforme / N/A, observação e fotos), com avanço automático para o próximo item.
import { html, raw, esc, api, icon, fmtDateTime } from '../core.js';
import { toast, sheet, confirmSheet, readAttachments, fileInput, lightbox, galleryFrom, batchBySize } from '../ui.js';
import { periodKey, periodInfo } from './periods.js';
import { depLists } from './deps-ui.js';
import { ganttChart, drawGanttLinks } from './gantt.js';

// Máximo de fotos por registro (cadastro da não conformidade e cada resposta: não conformidade ou correção) — igual ao servidor
export const PHOTO_LIMIT = 3;

// Especialidades oferecidas no cadastro do item: modelo da obra; sem modelo, as de todos os modelos cadastrados
export function projectSpecialties(meta, projectId) {
  const own = meta?.projects?.find(p => String(p.id) === String(projectId))?.specialties || [];
  return own.length ? { list: own, own: true } : { list: meta?.specialties_all || [], own: false };
}
const limitNote = n => html`<span class="hint">${n ? `${n} de ${PHOTO_LIMIT} fotos` : `Até ${PHOTO_LIMIT} fotos`}${n >= PHOTO_LIMIT ? ' · limite atingido (remova uma para trocar)' : ''}</span>`;
// Mantém só as fotos que cabem no limite e avisa quando alguma ficou de fora
const fitPhotos = (imgs, room) => {
  if (imgs.length > room) toast(room ? `Limite de ${PHOTO_LIMIT} fotos: só ${room === 1 ? 'a 1ª foto foi incluída' : `as ${room} primeiras foram incluídas`}.` : `Limite de ${PHOTO_LIMIT} fotos atingido.`, 'warn');
  return imgs.slice(0, Math.max(room, 0));
};

export const RESULT = {
  conforme: { label: 'Conforme', short: '✓', cls: 'ok' },
  nao_conforme: { label: 'Não conforme', short: '✗', cls: 'nc' },
  na: { label: 'N/A', short: '—', cls: 'na' },
};
export const PHOTO_RULE = { obrigatoria: 'Foto obrigatória em todos os itens', livre: 'Foto opcional (livre escolha)' };

const norm = s => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().trim();

// "@Nome" no fim da linha → responsável (nome completo ou primeiro nome, sem acento/caixa)
function splitAssignee(line, users) {
  const at = line.lastIndexOf('@');
  if (at < 0) return { text: line.trim(), assignee_id: undefined };
  const tag = norm(line.slice(at + 1));
  const text = line.slice(0, at).trim();
  if (!tag) return { text, assignee_id: undefined };
  const full = users.filter(u => tag.startsWith(norm(u.name)) || norm(u.name).startsWith(tag));
  const first = users.filter(u => norm(u.name).split(' ')[0] === tag.split(' ')[0]);
  const hit = full.length === 1 ? full[0] : first.length === 1 ? first[0] : null;
  return { text, assignee_id: hit ? hit.id : null, unknown: hit ? null : line.slice(at + 1).trim() };
}

// Interpreta várias linhas: "# Grupo [@Nome]" abre um grupo (com responsável padrão); demais linhas são itens
export function parseLines(lines, users, state) {
  const items = [];
  const unknown = [];
  for (const raw of lines) {
    const line = raw.replace(/^\s*[-•*\d.)\]]+\s+/, '').trim(); // aceita listas numeradas/marcadas coladas
    if (!line) continue;
    if (line.startsWith('#')) {
      const g = splitAssignee(line.replace(/^#+/, ''), users);
      state.group = g.text || null;
      state.groupAssignee = g.assignee_id ?? null;
      if (g.unknown) unknown.push(g.unknown);
      continue;
    }
    const it = splitAssignee(line, users);
    if (!it.text) continue;
    if (it.unknown) unknown.push(it.unknown);
    items.push({ group: state.group, text: it.text.slice(0, 300), assignee_id: it.assignee_id === undefined ? state.groupAssignee : it.assignee_id });
  }
  return { items, unknown };
}

export const composerHint = html`<span class="hint">Um item por linha. <b># Cozinha</b> abre um grupo (ambiente/local) · <b>@Nome</b> no fim define o responsável do item (ou do grupo inteiro: <b># Elétrica @Bruno</b>).</span>`;

// ---------- Novo item: passo a passo ----------
// Grupo (classificações do projeto) → Foto (obrigatória ou opcional) → Descrição do item → Responsável → Início → Término → Observação.
const fmtD = d => (d ? d.split('-').reverse().join('/') : '');
const todayISO = () => new Date(Date.now() - new Date().getTimezoneOffset() * 60000).toISOString().slice(0, 10);
const plusDays = (d, n) => new Date(Date.parse(d) + n * 86400e3).toISOString().slice(0, 10);

export function itemForm() {
  return html`<div class="cl-wiz" data-cl-form>
    <div class="wiz-head"><span class="wiz-step" data-wiz-count></span><b data-wiz-title></b></div>
    <div class="wiz-bar"><span data-wiz-bar></span></div>
    <div class="wiz-body" data-wiz-body></div>
    <div class="form-error" data-err hidden></div>
    <div class="wiz-nav" data-wiz-nav></div>
  </div>`;
}

// users(), groups(), globalName(), photoRequired(), quickList() são funções (a lista pode mudar com o projeto/regra)
export function bindItemForm(el, { users, groups, specialties = () => [], specialtiesOwn = () => true, globalName = () => '', photoRequired, quickList = () => false, keep = {}, onAdd, onClose }) {
  const q = s => el.querySelector(s);
  const err = q('[data-err]');
  let item, step = 0;
  const reset = () => {
    item = { group: keep.group ?? undefined, specialty: keep.specialty ?? undefined, images: [], text: '', assignee_id: keep.assignee_id ?? undefined,
      start_date: keep.start_date || '', due_date: keep.due_date || '', description: '' };
    step = 0;
  };
  reset();
  const STEPS = () => [
    { k: 'group', title: 'Grupo', optional: false },
    // Especialidade só quando a obra tem um modelo de especialidades (Configurações → escolhido no projeto)
    ...(specialties().length ? [{ k: 'spec', title: 'Especialidade', optional: true }] : []),
    { k: 'photo', title: 'Foto da não conformidade', optional: !photoRequired() },
    { k: 'text', title: 'Descrição do item', optional: false },
    { k: 'who', title: 'Responsável', optional: true },
    { k: 'start', title: 'Data de início', optional: true },
    { k: 'end', title: 'Data de término', optional: true },
    { k: 'obs', title: 'Observação', optional: true },
  ];
  const fail = msg => { err.textContent = msg; err.hidden = !msg; };
  const pick = (attr, val, label, on, sub = '') => html`<button type="button" class="wiz-opt ${on ? 'is-on' : ''}" ${raw(`${attr}="${esc(String(val))}"`)}>${label}${sub ? html`<small>${sub}</small>` : ''}</button>`;
  const whoName = id => (id ? users().find(u => u.id === id)?.name || '—' : `Responsável global${globalName() ? ` (${globalName()})` : ''}`);

  const bodyFor = s => {
    switch (s.k) {
      case 'group': {
        const list = groups();
        return html`<p class="wiz-q">Em qual grupo (ambiente/local/etapa) fica este item?</p>
          <div class="wiz-opts">${list.map(g => pick('data-group', g, g, item.group === g))}${pick('data-group', '', 'Sem grupo', item.group === null)}</div>
          ${!list.length ? html`<span class="hint">O projeto ainda não tem classificações. Cadastre em Projetos → Editar → Classificação.</span>`
            : html`<span class="hint">As opções são as classificações cadastradas na obra.</span>`}
          ${quickList() ? html`<details class="cl-quick"><summary>${icon('checklist')} Colar vários itens de uma vez (sem foto)</summary>
            <textarea data-quick rows="5" placeholder="Um item por linha&#10;# Cozinha&#10;Tomadas funcionando @Bruno&#10;Pia sem vazamento"></textarea>
            ${composerHint}
            <button type="button" class="btn btn-ghost btn-sm" data-quick-add>${icon('plus')}Adicionar lista</button></details>` : ''}`;
      }
      case 'spec':
        return html`<p class="wiz-q">Qual a especialidade deste item?</p>
          <div class="wiz-opts">${specialties().map(s => pick('data-spec', s, s, item.specialty === s))}${pick('data-spec', '', 'Sem especialidade', item.specialty === null)}</div>
          <span class="hint">${specialtiesOwn() ? 'Lista do modelo de especialidades escolhido para a obra.'
            : html`A obra ainda não tem modelo de especialidades: a lista vem dos modelos cadastrados em Configurações. Para usar só as da obra, escolha o modelo em <b>Projetos → Editar</b>.`}</span>`;
      case 'photo':
        return html`<p class="wiz-q">${photoRequired() ? 'Tire a foto da não conformidade (obrigatória).' : 'Tire a foto da não conformidade (opcional).'}</p>
          ${item.images.length < PHOTO_LIMIT ? html`<div class="wiz-photo">
            <label class="wiz-cam">${fileInput({ camera: true, data: 'data-new-photo' })}${icon('camera')}<span>${item.images.length ? 'Tirar outra foto' : 'Tirar foto'}</span></label>
            <label class="wiz-gal">${fileInput({ multiple: true, data: 'data-new-photo' })}${icon('image')}<span>Galeria</span></label>
          </div>` : ''}
          <div class="cli-photos" data-photos>${item.images.map((p, i) => html`<figure class="cli-ph"><img src="${p.data}" alt="Foto de entrada ${i + 1}"><button type="button" class="rm" data-rm-photo="${i}" aria-label="Remover foto">✕</button></figure>`)}</div>
          ${limitNote(item.images.length)}
          <span class="hint">Todo item cadastrado já é uma <b>não conformidade em aberto</b> (com ou sem foto); a foto, quando houver, é o “antes”.</span>`;
      case 'text':
        return html`<p class="wiz-q">O que deve ser verificado?</p>
          <input type="text" class="wiz-input" data-f="text" maxlength="300" value="${item.text}" placeholder="Ex.: Tomadas e interruptores funcionando" autocomplete="off" enterkeyhint="next">`;
      case 'who':
        return html`<p class="wiz-q">Quem responde este item? (opcional)</p>
          <div class="wiz-opts is-list">${pick('data-who', '', whoName(null), !item.assignee_id, 'padrão')}${users().map(u => pick('data-who', u.id, u.name, item.assignee_id === u.id, u.is_external ? `Terceirizado${u.company ? ` · ${u.company}` : ''}` : u.job_title || ''))}</div>`;
      case 'start':
        return html`<p class="wiz-q">Quando começa? (opcional)</p>
          <input type="date" class="wiz-input" data-f="start_date" value="${item.start_date}">
          <div class="wiz-quick">${pick('data-start', todayISO(), 'Hoje', item.start_date === todayISO())}${pick('data-start', plusDays(todayISO(), 1), 'Amanhã', item.start_date === plusDays(todayISO(), 1))}</div>`;
      case 'end': {
        const base = item.start_date || todayISO();
        return html`<p class="wiz-q">Até quando deve estar pronto? (opcional)</p>
          <input type="date" class="wiz-input" data-f="due_date" value="${item.due_date}" min="${item.start_date || ''}">
          <div class="wiz-quick">${[1, 3, 7, 15].map(n => pick('data-end', plusDays(base, n), `+${n} ${n === 1 ? 'dia' : 'dias'}`, item.due_date === plusDays(base, n)))}</div>
          <span class="hint">${item.start_date ? `Início em ${fmtD(item.start_date)}.` : 'Sem data de início: os atalhos contam a partir de hoje.'}</span>`;
      }
      case 'obs':
        return html`<p class="wiz-q">Alguma observação? (opcional)</p>
          <textarea class="wiz-input" data-f="description" rows="3" maxlength="2000" placeholder="Como verificar, critério de aceite, referência de projeto…">${item.description}</textarea>
          <div class="wiz-sum">
            ${summaryRow('group', 'Grupo', item.group || 'Sem grupo')}
            ${specialties().length ? summaryRow('spec', 'Especialidade', item.specialty || 'Sem especialidade') : ''}
            ${summaryRow('photo', 'Foto', item.images.length ? `${item.images.length} foto(s)` : 'sem foto')}
            ${summaryRow('text', 'Item', item.text)}
            ${summaryRow('who', 'Responsável', whoName(item.assignee_id))}
            ${summaryRow('start', 'Início', fmtD(item.start_date) || '—')}
            ${summaryRow('end', 'Término', fmtD(item.due_date) || '—')}
          </div>`;
    }
    return '';
  };
  const summaryRow = (k, label, value) => html`<button type="button" class="wiz-sum-row" data-goto="${STEPS().findIndex(s => s.k === k)}"><span>${label}</span><b>${value}</b><em>alterar</em></button>`;

  const navFor = (s, last) => html`
    ${step > 0 ? html`<button type="button" class="btn btn-ghost" data-back>${icon('back')}Voltar</button>` : html`<span></span>`}
    ${last ? html`<div class="wiz-final">
        <button type="button" class="btn btn-primary" data-add-again>${icon('plus')}Adicionar e criar outro</button>
        <button type="button" class="btn btn-ghost" data-add-close>${icon('check')}Adicionar e fechar</button></div>`
      : html`<div class="wiz-final">${s.optional ? html`<button type="button" class="btn btn-ghost" data-skip>Pular</button>` : ''}
        <button type="button" class="btn btn-primary" data-next>Próximo${icon('chevron')}</button></div>`}`;

  // Lê o que foi digitado no passo atual antes de sair dele
  const collect = () => {
    const v = k => q(`[data-f="${k}"]`)?.value;
    const s = STEPS()[step];
    if (s.k === 'text') item.text = (v('text') || '').trim();
    if (s.k === 'start') item.start_date = v('start_date') || '';
    if (s.k === 'end') item.due_date = v('due_date') || '';
    if (s.k === 'obs') item.description = (v('description') || '').trim();
  };
  const validate = () => {
    const s = STEPS()[step];
    if (s.k === 'group' && item.group === undefined) return 'Escolha o grupo do item (ou “Sem grupo”).';
    if (s.k === 'photo' && photoRequired() && !item.images.length) return 'Foto obrigatória: tire ou escolha a foto da não conformidade para continuar.';
    if (s.k === 'text' && !item.text) return 'Descreva o item a verificar.';
    if (s.k === 'end' && item.due_date && item.start_date && item.due_date < item.start_date) return 'A data de término não pode ser anterior à data de início.';
    return '';
  };
  const render = () => {
    const steps = STEPS();
    const s = steps[step];
    q('[data-wiz-count]').textContent = `Passo ${step + 1} de ${steps.length}`;
    q('[data-wiz-title]').textContent = s.title + (s.optional ? ' (opcional)' : '');
    q('[data-wiz-bar]').style.width = `${Math.round(((step + 1) / steps.length) * 100)}%`;
    q('[data-wiz-body]').innerHTML = bodyFor(s).toString();
    q('[data-wiz-nav]').innerHTML = navFor(s, step === steps.length - 1).toString();
    fail('');
    bindStep();
    const first = q('[data-wiz-body] .wiz-input');
    if (first) setTimeout(() => first.focus({ preventScroll: true }), 30);
  };
  const go = i => { collect(); step = Math.max(0, Math.min(STEPS().length - 1, i)); render(); };
  const next = () => {
    collect();
    const e = validate();
    if (e) return fail(e);
    go(step + 1);
  };
  const submit = async again => {
    collect();
    for (let i = 0; i < STEPS().length; i++) {
      step = i;
      const e = validate();
      if (e) { render(); return fail(e); }
    }
    step = STEPS().length - 1;
    const out = { text: item.text, group: item.group || null, specialty: item.specialty || null, images: item.images.slice(), description: item.description || null,
      assignee_id: item.assignee_id || null, start_date: item.start_date || null, due_date: item.due_date || null };
    el.querySelectorAll('[data-add-again],[data-add-close]').forEach(b => (b.disabled = true));
    try {
      Object.assign(keep, { group: out.group, specialty: out.specialty, assignee_id: out.assignee_id, start_date: out.start_date, due_date: out.due_date });
      await onAdd([out], again);
      reset();
      render();
      if (!again) onClose?.();
    } catch (e) {
      fail(e.message);
      el.querySelectorAll('[data-add-again],[data-add-close]').forEach(b => (b.disabled = false));
    }
  };

  const bindStep = () => {
    el.querySelectorAll('[data-group]').forEach(b => b.addEventListener('click', () => { item.group = b.dataset.group || null; next(); }));
    el.querySelectorAll('[data-spec]').forEach(b => b.addEventListener('click', () => { item.specialty = b.dataset.spec || null; next(); }));
    el.querySelectorAll('[data-who]').forEach(b => b.addEventListener('click', () => { item.assignee_id = b.dataset.who ? Number(b.dataset.who) : null; next(); }));
    el.querySelectorAll('[data-start]').forEach(b => b.addEventListener('click', () => { q('[data-f="start_date"]').value = b.dataset.start; next(); }));
    el.querySelectorAll('[data-end]').forEach(b => b.addEventListener('click', () => { q('[data-f="due_date"]').value = b.dataset.end; next(); }));
    el.querySelectorAll('[data-goto]').forEach(b => b.addEventListener('click', () => go(Number(b.dataset.goto))));
    el.querySelectorAll('[data-rm-photo]').forEach(b => b.addEventListener('click', () => { item.images.splice(Number(b.dataset.rmPhoto), 1); render(); }));
    el.querySelectorAll('input[data-new-photo]').forEach(inp => inp.addEventListener('change', async () => {
      const files = [...(inp.files || [])];
      inp.value = '';
      if (!files.length) return;
      try {
        const first = !item.images.length;
        item.images.push(...fitPhotos((await readAttachments(files)).filter(x => !x.pdf).map(x => ({ data: x.data })), PHOTO_LIMIT - item.images.length));
        // Primeira foto tirada: segue direto para o próximo passo
        if (first && item.images.length) go(step + 1); else render();
      } catch (e) { toast(e.message, 'err'); }
    }));
    q('[data-next]')?.addEventListener('click', next);
    q('[data-skip]')?.addEventListener('click', () => {
      const s = STEPS()[step];
      if (s.k === 'who') item.assignee_id = null;
      if (s.k === 'spec') item.specialty = null;
      if (s.k === 'start') item.start_date = '';
      if (s.k === 'end') item.due_date = '';
      if (s.k === 'photo') item.images = [];
      step = Math.min(STEPS().length - 1, step + 1);
      render();
    });
    q('[data-back]')?.addEventListener('click', () => go(step - 1));
    q('[data-add-again]')?.addEventListener('click', () => submit(true));
    q('[data-add-close]')?.addEventListener('click', () => submit(false));
    q('[data-quick-add]')?.addEventListener('click', async () => {
      const state = { group: null, groupAssignee: null };
      const { items, unknown } = parseLines(q('[data-quick]').value.split(/\r?\n/), users(), state);
      if (unknown.length) toast(`Não encontrei na equipe do projeto: ${[...new Set(unknown)].join(', ')}. O item ficou com o responsável global.`, 'warn');
      if (!items.length) return fail('Cole ao menos um item (um por linha).');
      try { await onAdd(items, true); } catch (e) { fail(e.message); }
    });
  };
  // Enter avança (exceto na observação); nunca envia o formulário da página
  el.addEventListener('keydown', e => {
    if (e.key !== 'Enter' || e.target.tagName === 'TEXTAREA') return;
    if (e.target.tagName === 'INPUT') { e.preventDefault(); next(); }
  });
  render();
  return {
    focus: () => { const i = q('[data-wiz-body] .wiz-input, [data-wiz-body] .wiz-opt'); i?.focus({ preventScroll: true }); },
    refresh: render,
    // group definido (botão "+ Item" de um grupo): já começa no passo seguinte ao grupo
    startAt: group => { reset(); if (group !== undefined) { item.group = group || null; step = 1; } render(); },
  };
}

// Lista em construção (formulário de criação do check-list)
export function renderDraft(items, users, globalName) {
  if (!items.length) return html`<div class="cl-empty muted">Nenhum item ainda. Preencha acima e toque em “Adicionar e criar outro”.</div>`;
  const who = id => users.find(u => u.id === id)?.name || (globalName ? `${globalName} (global)` : 'Responsável global');
  let group;
  return html`${items.map((it, i) => {
    const head = it.group !== group ? html`<div class="cl-draft-group">${it.group || 'Sem grupo'}</div>` : '';
    group = it.group;
    const due = it.due_date || (it.duration_days !== null && it.duration_days !== undefined ? plusDays(it.start_date || todayISO(), it.duration_days) : null);
    return html`${head}<div class="cl-draft-card" data-i="${i}">
      ${it.images?.length ? html`<img class="cl-draft-ph" src="${it.images[0].data}" alt="">` : html`<span class="cl-draft-ph is-empty">${icon('camera')}</span>`}
      <div class="cl-draft-txt"><b>${i + 1}. ${it.text}</b>
        <span>${it.specialty ? `${it.specialty} · ` : ''}${icon('user')} ${who(it.assignee_id)}${due ? html` · ${icon('calendar')} ${fmtD(due)}` : ''}${it.images?.length ? ` · ${it.images.length} foto(s)` : ''}</span>
        ${it.description ? html`<em>${it.description}</em>` : ''}</div>
      <button type="button" class="icon-btn cl-draft-rm" aria-label="Remover item ${i + 1}">✕</button></div>`;
  })}`;
}

// ---------- Tela da tarefa ----------
// Estado de tela por check-list (sobrevive ao redesenho após cada resposta)
const ui = {};
const uiOf = id => (ui[id] ||= { filter: null, adding: false, fGroup: '', fResp: '', fSpec: '', levels: ['grupo'], open: new Set() });

// Urgência do prazo: atrasado (vermelho) · vence hoje (laranja) · nos próximos 7 dias (amarelo) · depois (azul)
export function dueLevel(due, resolved, today = todayISO()) {
  if (!due) return { cls: 'is-none', rel: '' };
  const days = Math.round((Date.parse(due) - Date.parse(today)) / 86400e3);
  if (resolved) return { cls: 'is-done', rel: '' };
  if (days < 0) return { cls: 'is-late', rel: `atrasado há ${-days} ${days === -1 ? 'dia' : 'dias'}` };
  if (days === 0) return { cls: 'is-today', rel: 'vence hoje' };
  if (days <= 7) return { cls: 'is-week', rel: `falta${days > 1 ? 'm' : ''} ${days} ${days === 1 ? 'dia' : 'dias'}` };
  return { cls: 'is-ok', rel: `faltam ${days} dias` };
}

// Filtro por grupo e/ou responsável (tela e relatório). '' = todos; '~' = sem grupo / sem responsável.
export const NONE = '~';
const PHOTOS_KEY = 'cl-show-photos';
// Padrão: fotos visíveis (ocultar fica guardado no aparelho)
const showPhotos = () => { try { return localStorage.getItem(PHOTOS_KEY) !== '0'; } catch { return true; } };
const saveShowPhotos = v => { try { localStorage.setItem(PHOTOS_KEY, v ? '1' : '0'); } catch { /* sem armazenamento */ } };
const keyOf = v => v || NONE;
// f = { group, spec, resp } (valores '' = todos)
export const matchItem = (it, f) => (!f.group || keyOf(it.group) === f.group) && (!f.spec || keyOf(it.specialty) === f.spec)
  && (!f.resp || keyOf(it.responsible_name) === f.resp);
// specOrder = especialidades do modelo da obra (ordem de exibição); fora do modelo depois e "sem" por último
export const filterOptions = (items, specOrder = []) => ({
  groups: [...new Set(items.map(i => keyOf(i.group)))],
  specs: [...new Set(items.map(i => keyOf(i.specialty)))].sort((a, b) => {
    const r = k => (k === NONE ? 1e6 : specOrder.includes(k) ? specOrder.indexOf(k) : 1e5);
    return r(a) - r(b) || a.localeCompare(b, 'pt-BR');
  }),
  resps: [...new Set(items.map(i => keyOf(i.responsible_name)))].sort((a, b) => a.localeCompare(b, 'pt-BR')),
});
export const optLabel = (k, kind) => (k === NONE ? ({ group: 'Sem grupo', spec: 'Sem especialidade', resp: 'Sem responsável' })[kind] : k);
const filterOf = st => ({ group: st.fGroup, spec: st.fSpec, resp: st.fResp });
// Link do relatório levando os filtros (e o agrupamento por especialidade) em uso
export const checklistReportLink = t => {
  const st = uiOf(t.id);
  const q = new URLSearchParams();
  if (st.fGroup) q.set('grupo', st.fGroup);
  if (st.fSpec) q.set('esp', st.fSpec);
  if (st.fResp) q.set('resp', st.fResp);
  // Mesmo agrupamento da tela (o relatório usa os mesmos nomes de nível)
  if (st.levels.join() !== 'grupo') st.levels.forEach((d, i) => q.set(`g${i + 1}`, d));
  if (!st.levels.length) q.set('g1', 'nenhum');
  return `#/imprimir/checklist/${t.id}${q.size ? `?${q}` : ''}`;
};
let scrollTo = null;

// "Bruno Costa" → "Bruno C." (cabe na linha recolhida)
const shortName = n => { const p = String(n || '—').trim().split(/\s+/); return p.length > 1 ? `${p[0]} ${p.at(-1)[0]}.` : p[0]; };
const initials = n => String(n || '?').trim().split(/\s+/).filter(Boolean).slice(0, 2).map(p => p[0]).join('').toUpperCase();
const shortDate = iso => fmtDateTime(iso).replace(/\/\d{4},/, ',');

// Agrupamento da lista em até 3 níveis (combináveis). Situação e prazo (semana) seguem ordem fixa/cronológica.
const SIT = it => (it.open_nc ? '1' : !it.result ? '2' : it.result === 'conforme' ? '3' : '4');
const SIT_NAME = { 1: 'Não conforme em aberto', 2: 'Pendente', 3: 'Conforme', 4: 'N/A' };
export const GROUP_DIMS = {
  grupo: { label: 'Grupo', key: it => it.group || '', name: k => k || 'Sem grupo' },
  especialidade: { label: 'Especialidade', key: it => it.specialty || '', name: k => k || 'Sem especialidade', rank: true },
  responsavel: { label: 'Responsável', key: it => it.responsible_name || '', name: k => k || 'Sem responsável', sort: (a, b) => a.localeCompare(b, 'pt-BR') },
  situacao: { label: 'Situação', key: SIT, name: k => SIT_NAME[k], sort: (a, b) => a.localeCompare(b) },
  semana: { label: 'Prazo (semana)', key: it => periodKey(it.due_date, 'semana'), name: k => { const p = periodInfo(k, 'semana'); return p.hint ? `${p.label} · ${p.hint}` : p.label; }, sort: (a, b) => a.localeCompare(b) },
};
function groupItems(items, dim, specOrder = []) {
  const d = GROUP_DIMS[dim];
  const m = new Map();
  for (const it of items) {
    const k = d.key(it);
    if (!m.has(k)) m.set(k, []);
    m.get(k).push(it);
  }
  const keys = [...m.keys()];
  if (d.rank) {
    const r = k => (!k ? 1e6 : specOrder.includes(k) ? specOrder.indexOf(k) : 1e5);
    keys.sort((a, b) => r(a) - r(b));
  } else if (d.sort) keys.sort(d.sort);
  else keys.sort((a, b) => (a ? 0 : 1) - (b ? 0 : 1)); // grupo: ordem dos itens, "Sem grupo" por último
  return keys.map(k => ({ key: k, name: d.name(k), items: m.get(k) }));
}
// Níveis válidos: sem repetir (Especialidade sempre disponível; itens sem ela ficam em "Sem especialidade")
const cleanLevels = levels => levels.filter((d, i) => GROUP_DIMS[d] && levels.indexOf(d) === i).slice(0, 3);

const photo = (f, caption, cls = '') => html`<figure class="cli-ph ${cls}" data-src="/api/checklist-files/${f.id}" data-caption="${caption}">
  <img src="/api/checklist-files/${f.id}" alt="${caption}" loading="lazy"></figure>`;

function itemCard(t, it, c) {
  // Foto obrigatória: cada resposta Conforme/Não conforme leva a sua própria foto (fotos avulsas já anexadas valem)
  const needPhoto = c.photo_rule === 'obrigatoria' && !it.loose_count;
  const ncTimes = it.nc_count > 1 ? ` · ${it.nc_count}x` : '';
  const state = it.open_nc
    ? html`<span class="cli-state st-nao_conforme">✗ Não conforme${ncTimes}</span>`
    : it.result
      ? html`<span class="cli-state st-${it.result}">${RESULT[it.result].short} ${RESULT[it.result].label}</span>${it.nc_count ? html`<span class="cli-fixed" title="Ficou não conforme ${it.nc_count} vez(es) antes de ser corrigido">corrigido · ${it.nc_count}x não conforme</span>` : ''}`
      : html`<span class="cli-state st-pending">Pendente</span>`;
  const menu = c.can_manage_items ? html`<button type="button" class="cli-menu" data-edit-item="${it.id}" aria-label="Editar item ${it.seq}">${icon('more')}</button>` : '';
  // Destaque de responsável e prazo (cor do prazo pela urgência)
  const dueBox = (() => {
    if (!it.due_date) return html`<span class="fact-due is-none">${icon('calendar')}<span><small>Prazo</small><b>Sem prazo</b></span></span>`;
    const lv = dueLevel(it.due_date, it.resolved);
    const cls = lv.cls;
    const rel = it.resolved ? (it.start_date ? `início ${fmtD(it.start_date)}` : '') : lv.rel;
    return html`<span class="fact-due ${cls}">${icon('calendar')}<span><small>Prazo</small><b>${fmtD(it.due_date)}</b>${rel ? html`<em>${rel}</em>` : ''}</span></span>`;
  })();
  const nPhotos = new Set([...it.refs, ...it.files, ...it.history.flatMap(h => h.files)].map(f => f.id)).size;
  const lv = dueLevel(it.due_date, it.resolved);
  const dep = c.item_deps?.[it.id];
  const mainState = it.open_nc ? html`<span class="cli-state st-nao_conforme">✗ Não conforme${ncTimes}</span>`
    : it.result ? html`<span class="cli-state st-${it.result}">${RESULT[it.result].short} ${RESULT[it.result].label}</span>`
      : html`<span class="cli-state st-pending">Pendente</span>`;
  const summary = html`<summary class="cli-sum">
      <span class="cli-num">${it.seq}</span>
      <span class="cli-title">${it.text}</span>
      <span class="cli-sum-r">
        ${dep?.waiting?.length ? html`<span class="dep-wait-tag" title="Aguardando ${dep.waiting.map(d => d.code).join(', ')}">${icon('clock')}Aguardando</span>` : ''}
        ${it.specialty && !uiOf(t.id).levels.includes('especialidade') ? html`<span class="cli-spec cli-spec-sm" title="Especialidade">${it.specialty}</span>` : ''}
        <span class="cli-who ${it.mine ? 'is-mine' : ''}" title="Responsável${it.assignee_id ? '' : ' (global)'}: ${it.responsible_name}"><i>${initials(it.responsible_name)}</i>${shortName(it.responsible_name)}</span>
        <span class="cli-due ${lv.cls}" title="${lv.rel || (it.due_date ? 'Prazo' : 'Sem prazo')}">${icon('calendar')}${it.due_date ? fmtD(it.due_date).slice(0, 5) : 'Sem prazo'}</span>
        ${mainState}
      </span>
      <span class="cli-chev" aria-hidden="true">${icon('chevron')}</span>
    </summary>`;
  const head = html`<div class="cli-top cli-top-open">${menu}</div>
    ${it.specialty || (it.group && !uiOf(t.id).levels.includes('grupo')) ? html`<div class="cli-tags">${it.specialty ? html`<span class="cli-spec">${it.specialty}</span>` : ''}${it.group && !uiOf(t.id).levels.includes('grupo') ? html`<span class="cli-grp">${it.group}</span>` : ''}</div>` : ''}
    <div class="cli-facts">
      <span class="fact-who ${it.mine ? 'is-mine' : ''}"><i>${initials(it.responsible_name)}</i><span><small>Responsável${it.assignee_id ? '' : ' (global)'}${it.mine ? ' · seu item' : ''}</small><b>${it.responsible_name}</b></span></span>
      ${dueBox}
    </div>
    <div class="cli-meta">
      ${it.nc_count && it.result && !it.open_nc ? html`<span class="cli-fixed" title="Ficou não conforme ${it.nc_count} vez(es) antes de ser corrigido">corrigido · ${it.nc_count}x não conforme</span>` : ''}
      ${nPhotos ? html`<button type="button" class="cli-phcount" data-gallery aria-label="Ver as ${nPhotos} foto(s) do item">${icon('image')}${nPhotos} foto${nPhotos > 1 ? 's' : ''}</button>` : ''}
      ${it.result ? html`<span class="cli-when">${icon('check')}${it.answered_by_name || '—'} · ${shortDate(it.answered_at)}</span>` : ''}
    </div>
    ${it.description ? html`<div class="cli-desc"><b>Obs.:</b> ${it.description}</div>` : ''}`;
  const ansBtn = r => {
    const on = it.result === r;
    const inner = html`<span class="ans-ic">${RESULT[r].short}</span><span class="ans-lb">${RESULT[r].label}</span>`;
    // Sem foto ainda para esta resposta: o botão abre a câmera e grava a resposta junto com a foto
    return needPhoto && r !== 'na' && !on
      ? html`<label class="ans ans-${RESULT[r].cls}">${fileInput({ camera: true, data: `data-answer="${r}" data-item="${it.id}"` })}${inner}<span class="ans-cam">${icon('camera')}</span></label>`
      : html`<button type="button" class="ans ans-${RESULT[r].cls} ${on ? 'is-on' : ''}" data-answer="${r}" data-item="${it.id}" aria-pressed="${on}">${inner}</button>`;
  };
  // Capa: antes × depois (corrigido) ou a foto mais recente da não conformidade
  const shown = new Set([it.before?.id, it.after?.id, it.cover?.id].filter(Boolean));
  const beforeLabel = it.before?.kind === 'referencia' ? 'Antes · cadastro' : 'Antes · não conforme';
  const visual = it.before && it.after
    ? html`<div class="cli-ba">
        <figure class="cli-ba-f is-before ${it.before.kind === 'referencia' ? 'is-ref' : ''}" data-src="/api/checklist-files/${it.before.id}" data-caption="${beforeLabel} · item ${it.seq}"><img src="/api/checklist-files/${it.before.id}" alt="Antes" loading="lazy"><figcaption>${beforeLabel} · ${shortDate(it.before.created_at)}</figcaption></figure>
        <span class="cli-ba-arrow" aria-hidden="true">→</span>
        <figure class="cli-ba-f is-after" data-src="/api/checklist-files/${it.after.id}" data-caption="Depois · conforme · item ${it.seq}"><img src="/api/checklist-files/${it.after.id}" alt="Depois" loading="lazy"><figcaption>Depois · ${shortDate(it.after.created_at)}</figcaption></figure>
      </div>`
    : it.cover ? (it.open_nc
      ? html`<figure class="cli-cover" data-src="/api/checklist-files/${it.cover.id}" data-caption="Não conformidade · item ${it.seq}">
        <img src="/api/checklist-files/${it.cover.id}" alt="Foto da não conformidade" loading="lazy">
        <figcaption>${icon('alert')} Não conformidade mais recente${ncTimes} · ${shortDate(it.cover.created_at)}</figcaption></figure>`
      : html`<figure class="cli-cover is-ref" data-src="/api/checklist-files/${it.cover.id}" data-caption="Foto de entrada · item ${it.seq}">
        <img src="/api/checklist-files/${it.cover.id}" alt="Foto de entrada" loading="lazy">
        <figcaption>${icon('image')} Foto do cadastro${it.refs.length > 1 ? ` (+${it.refs.length - 1})` : ''}</figcaption></figure>`) : '';
  const others = it.files.filter(f => !shown.has(f.id));
  const history = it.history.length > 1 || it.history.some(h => h.reason || h.registration) ? html`<details class="cli-hist"><summary>${icon('history')} Histórico do item (${it.history.length})</summary>
    <ol>${[...it.history].reverse().map(h => html`<li class="h-${h.result}"><b>${h.registration ? 'Não conformidade registrada (cadastro)' : RESULT[h.result].label}</b> · ${h.user_name || '—'} · ${shortDate(h.created_at)}
      ${h.reason ? html`<div class="h-why">Justificativa: ${h.reason}</div>` : ''}${h.note ? html`<div class="h-note">${h.note}</div>` : ''}
      ${h.files.length ? html`<div class="h-ph">${h.files.map(f => photo(f, `Item ${it.seq} · ${RESULT[h.result].label} · ${shortDate(h.created_at)}`, 'is-mini'))}</div>` : ''}</li>`)}</ol></details>` : '';
  const body = html`
    ${visual}
    ${it.can_answer ? html`<div class="cli-answer" role="group" aria-label="Resposta do item ${it.seq}">${ansBtn('conforme')}${ansBtn('nao_conforme')}${ansBtn('na')}</div>
      ${it.open_nc ? html`<div class="cli-hint">${icon('info')} Não conformidade em aberto: depois de corrigir, marque Conforme${c.photo_rule === 'obrigatoria' ? ' com a foto do depois' : ''}.</div>`
        : needPhoto && !it.result ? html`<div class="cli-hint">${icon('camera')} Foto obrigatória: ao tocar em Conforme ou Não conforme a câmera abre.</div>` : ''}`
      : !it.resolved ? html`<div class="cli-hint">${icon('clock')} ${c.locked ? 'Check-list fechado para alterações.' : `Aguardando ${it.responsible_name} (ou o responsável global).`}</div>` : ''}
    ${others.length || it.can_answer ? html`<div class="cli-photos">
      ${others.map(fl => html`<figure class="cli-ph" data-src="/api/checklist-files/${fl.id}" data-caption="Item ${it.seq} · ${it.text}">
        <img src="/api/checklist-files/${fl.id}" alt="Foto do item ${it.seq}" loading="lazy">
        ${it.can_answer ? html`<button type="button" class="rm" data-rm-photo="${fl.id}" data-item="${it.id}" aria-label="Remover foto">✕</button>` : ''}</figure>`)}
      ${it.can_answer && it.files.length < PHOTO_LIMIT ? html`<label class="cli-ph-add">${fileInput({ camera: true, data: `data-photo-item="${it.id}"` })}${icon('camera')}<span>${it.files.length ? 'Mais foto' : 'Foto'}</span></label>
        <label class="cli-ph-add">${fileInput({ multiple: true, data: `data-photo-item="${it.id}"` })}${icon('image')}<span>Galeria</span></label>` : ''}</div>
      ${it.can_answer && it.files.length ? limitNote(it.files.length) : ''}` : ''}
    ${it.can_answer && (it.result === 'nao_conforme' || it.note) ? html`<label class="cli-note"><span>${it.result === 'nao_conforme' ? 'O que está errado?' : 'Observação'}</span>
        <input type="text" data-note-item="${it.id}" maxlength="1000" value="${it.note || ''}" placeholder="${it.result === 'nao_conforme' ? 'Descreva o problema encontrado' : 'Observação'}"></label>`
      : it.note ? html`<div class="cli-note-text"><b>${it.result === 'nao_conforme' ? 'Problema:' : 'Obs.:'}</b> ${it.note}</div>` : ''}
    ${dep || c.can_manage_items ? html`<details class="cli-depbox" ${dep ? 'open' : ''}><summary>${icon('history')} Dependências${dep ? ` (${dep.predecessors.length + dep.successors.length})` : ''}</summary>
      <div class="cli-deps">${depLists(dep || { predecessors: [], successors: [], waiting: [] }, !!c.can_manage_items, `i:${it.id}`)}</div></details>` : ''}
    ${history}`;
  const attrs = `id="cli-${it.id}" data-item-id="${it.id}" data-pending="${it.resolved ? 0 : 1}" data-mine="${it.mine ? 1 : 0}" data-nc="${it.open_nc ? 1 : 0}"`;
  const cls = `cli ${it.open_nc ? 'res-nao_conforme' : it.result ? `res-${it.result}` : 'res-pending'} ${it.mine ? 'is-mine' : ''} cli-due-${lv.cls.slice(3)}`;
  // Recolhido: só descrição, prazo e situação. Ao tocar, abre com responsável, fotos, botões e histórico.
  const isOpen = uiOf(t.id).open.has(it.id);
  const itemNav = html`<div class="cli-nav"><button type="button" class="btn btn-ghost btn-sm" data-cli-step="-1">‹ Item anterior</button><button type="button" class="btn btn-ghost btn-sm" data-cli-step="1">Próximo item ›</button></div>`;
  return html`<details class="${cls}" ${raw(attrs)} ${isOpen ? 'open' : ''}>${summary}<div class="cli-detail">${head}<div class="cli-body">${body}${itemNav}</div></div></details>`;
}

// Cronograma semanal dos itens (início → término), com as setas das dependências entre itens
const ITEM_COLOR = i => (i.open_nc ? '#C0392B' : i.result === 'conforme' ? '#2E8B57' : i.result === 'na' ? '#6E7A86' : '#A86F0E');
function itemsGantt(c) {
  const dated = c.items.filter(i => i.start_date || i.due_date);
  if (!dated.length) return html`<p class="muted" style="margin:0">Nenhum item com data de início ou término. Defina as datas nos itens (⋯ → Editar) para vê-los no cronograma.</p>`;
  const rows = dated.map(i => ({
    id: i.id, code: String(i.seq), title: i.text, assignee_name: i.responsible_name, item: i,
    start_date: i.start_date || i.due_date, due_date: i.due_date || null, completed_at: i.resolved ? i.answered_at : null,
    eff_status: i.resolved ? 'concluida' : i.overdue ? 'atrasada' : 'em_andamento', days_late: 0,
    dep_key: `i:${i.id}`, preds: (c.item_deps?.[i.id]?.predecessors || []).filter(p => p.key.startsWith('i:')).map(p => ({ key: p.key, lag: p.lag_days })),
  }));
  const legend = html`<div class="g-legend"><span><i class="g-sw" style="--c:#A86F0E"></i>Pendente</span><span><i class="g-sw" style="--c:#C0392B"></i>Não conforme em aberto</span>
    <span><i class="g-sw is-done" style="--c:#2E8B57"></i>Conforme</span><span><i class="g-sw is-done" style="--c:#6E7A86"></i>N/A</span><span><i class="g-sw g-sw-late"></i>Atraso</span><span><i class="g-today-legend"></i>Hoje</span></div>`;
  return ganttChart(rows, { ref: todayISO(), weekly: true, groupLabel: r => r.item.group || 'Sem grupo', color: r => ITEM_COLOR(r.item), noun: ['item(ns)', 'concluído(s)'], head: 'Item', legend,
    note: `Barra = início → término do item.${c.items.length > dated.length ? ` ${c.items.length - dated.length} item(ns) sem datas não aparecem.` : ''}` });
}

export function checklistSection(t, { reviewBox, reviewActions, can }) {
  const c = t.checklist;
  const s = c.summary;
  const st = uiOf(t.id);
  const f = st.filter || (s.mine_pending && s.mine_pending < s.total - s.done ? 'mine' : 'all');
  const chip = (k, label, n) => html`<button type="button" class="chip" data-clf="${k}" aria-pressed="${f === k}">${label}${n !== undefined ? html`<span class="n">${n}</span>` : ''}</button>`;
  const opts = filterOptions(c.items, t._specs || []);
  // Filtro guardado que não existe mais (grupo renomeado, responsável trocado) volta para "todos"
  if (st.fGroup && !opts.groups.includes(st.fGroup)) st.fGroup = '';
  if (st.fSpec && !opts.specs.includes(st.fSpec)) st.fSpec = '';
  if (st.fResp && !opts.resps.includes(st.fResp)) st.fResp = '';
  st.levels = cleanLevels(st.levels);
  const LBL = { group: 'Grupo', spec: 'Especialidade', resp: 'Responsável' };
  const sel = (kind, cur, list, all) => html`<label class="cl-sel ${cur ? 'is-on' : ''}"><span>${LBL[kind]}</span>
    <select data-clsel="${kind}"><option value="">${all}</option>${list.map(k => html`<option value="${k}" ${k === cur ? 'selected' : ''}>${optLabel(k, kind)}</option>`)}</select></label>`;
  const selects = c.items.length ? html`<div class="cl-selects">
      ${sel('group', st.fGroup, opts.groups, 'Todos os grupos')}
      ${sel('spec', st.fSpec, opts.specs, 'Todas as especialidades')}
      ${sel('resp', st.fResp, opts.resps, 'Todos os responsáveis')}
      <span class="cl-sel-info" data-clsel-info></span>
      <button type="button" class="btn btn-ghost btn-sm" data-clsel-clear ${st.fGroup || st.fSpec || st.fResp ? '' : 'hidden'}>Limpar filtro</button>
    </div>` : '';
  // Agrupar em até 3 níveis (ex.: Grupo › Especialidade › Responsável)
  const photosOn = showPhotos();
  const dimOpts = Object.entries(GROUP_DIMS);
  const lvlSel = n => html`<label class="cl-lvl"><span>${n === 0 ? 'Agrupar por' : n === 1 ? 'depois por' : 'e por'}</span>
    <select data-cllvl="${n}"><option value="">${n === 0 ? 'Sem agrupamento' : '—'}</option>${dimOpts.map(([k, d]) => html`<option value="${k}" ${st.levels[n] === k ? 'selected' : ''}>${d.label}</option>`)}</select></label>`;
  const byToggle = html`<div class="cl-by">
      ${lvlSel(0)}${st.levels.length >= 1 ? lvlSel(1) : ''}${st.levels.length >= 2 ? lvlSel(2) : ''}</div>`;
  // Filtros e agrupamento ficam num menu; o botão mostra quantos filtros estão ativos e o agrupamento em uso
  const nFilters = [st.fGroup, st.fSpec, st.fResp].filter(Boolean).length;
  const filterMenu = c.items.length ? html`<details class="cl-fmenu" ${st.fmenu ? 'open' : ''}>
      <summary class="btn btn-ghost btn-sm">${icon('filter')}<span>Filtros e agrupamento</span><span class="cl-fcount" data-fcount ${nFilters ? '' : 'hidden'}>${nFilters}</span><span class="cl-fchev">${icon('chevron')}</span></summary>
      <div class="cl-fpanel">
        <div class="cl-fsec"><span class="cl-fsec-t">Agrupar</span>${byToggle}</div>
        <div class="cl-fsec"><span class="cl-fsec-t">Filtrar</span>${selects}</div>
      </div>
    </details>` : '';
  const groupInfo = st.levels.length ? st.levels.map(d => GROUP_DIMS[d].label).join(' › ') : 'sem agrupamento';
  // Seções aninhadas: cabeçalho com progresso; "+ Item" e "Grupo" quando o nível é Grupo
  const sections = (items, depth = 0) => {
    if (depth >= st.levels.length) return html`${items.map(it => itemCard(t, it, c))}`;
    const dim = st.levels[depth];
    return html`${groupItems(items, dim, t._specs || []).map(g => {
      const done = g.items.filter(i => i.resolved).length;
      const pct = Math.round((done / g.items.length) * 100);
      const isGroup = dim === 'grupo' && c.can_manage_items;
      return html`<section class="clg clg-l${depth}">
        <header class="clg-head">
          <div class="clg-name">${depth === 0 ? html`<h3>${g.name}</h3>` : html`<h4><small>${GROUP_DIMS[dim].label}:</small> ${g.name}</h4>`}<div class="clg-bar"><span style="width:${pct}%"></span></div></div>
          <span class="clg-count">${done}/${g.items.length}</span>
          ${isGroup ? html`<button type="button" class="clg-btn" data-add-group="${g.key}" title="Adicionar item neste grupo">${icon('plus')}<span>Item</span></button>
            ${g.items.length > 1 ? html`<button type="button" class="clg-btn" data-assign-group="${g.items.map(i => i.id).join(',')}" data-group-name="${g.name}" title="Definir o responsável do grupo">${icon('user')}<span>Grupo</span></button>` : ''}` : ''}
        </header>
        <div class="clg-items">${sections(g.items, depth + 1)}</div>
      </section>`;
    })}`;
  };
  return html`<section class="card block block-exec" id="checklist" aria-labelledby="blk-cl">
    <header class="block-head"><span class="step">2</span><h2 id="blk-cl">Check-list</h2>
      <span class="right muted" style="font-size:12px">${s.done} de ${s.total} concluídos${s.nc_total ? ` · ${s.nc_total} NC no histórico` : ''}</span></header>
    <div class="block-body">
      ${reviewBox}
      <div class="cl-overview">
        <div class="cl-ring" style="--p:${s.pct}"><b>${s.pct}%</b><span>concluído</span></div>
        <div class="cl-counts">
          <span class="cnt ok"><b>${s.conforme}</b>Conforme</span><span class="cnt nc"><b>${s.nao_conforme}</b>Não conforme em aberto</span>
          <span class="cnt na"><b>${s.na}</b>N/A</span><span class="cnt pend"><b>${s.pending}</b>Ainda não verificados</span>
        </div>
      </div>
      ${c.locked && !t.cancelled_at ? html`<div class="notice">${icon('info')}<span>${t.status === 'concluida' ? 'Check-list concluído' : 'Check-list enviado para conferência'}: as respostas ficam bloqueadas.${t.status === 'aguardando_conferencia' ? ' Se precisar corrigir algo, quem confere pode devolver para ajustes.' : ''}</span></div>` : ''}
      <div class="cl-rules"><span class="cl-rule ${c.photo_rule === 'obrigatoria' ? 'is-req' : ''}">${icon('camera')} ${PHOTO_RULE[c.photo_rule]}</span>
        ${s.overdue ? html`<span class="cl-rule is-late">${icon('calendar')} ${s.overdue} ${s.overdue === 1 ? 'item atrasado' : 'itens atrasados'}</span>` : ''}</div>
      <div class="cl-toolbar">
        <div class="chips cl-filters" role="group" aria-label="Filtrar itens">
          ${chip('all', 'Todos', s.total)}${s.mine_pending || c.items.some(i => i.mine) ? chip('mine', 'Meus itens', s.mine_pending ? `${s.mine_pending} pend.` : undefined) : ''}
          ${chip('pending', 'Pendentes', s.total - s.done)}${s.nao_conforme ? chip('nc', 'Não conformes', s.nao_conforme) : ''}
        </div>
        <div class="cl-tools">
          ${filterMenu}
          <button type="button" class="btn btn-ghost btn-sm cl-phtoggle" data-clphotos aria-pressed="${photosOn}">${icon('image')}<span>${photosOn ? 'Ocultar fotos' : 'Mostrar fotos'}</span></button>
          ${c.can_manage_items ? html`<button type="button" class="btn btn-ghost btn-sm" id="cl-add-toggle" aria-expanded="${st.adding}">${icon('plus')}Adicionar itens</button>` : ''}
          <span class="cl-ginfo muted">Agrupado: ${groupInfo}<span data-clsel-info2></span></span>
        </div>
      </div>
      ${c.can_manage_items ? html`<div class="cl-add-panel" id="cl-add-panel" ${st.adding ? '' : 'hidden'}>
        <div class="cl-add-head"><b>${icon('plus')} Novo item</b><button type="button" class="icon-btn" id="cl-add-close" aria-label="Fechar">✕</button></div>
        ${itemForm()}
      </div>` : ''}
      <div class="cl-list ${photosOn ? '' : 'no-photos'}" data-filter="${f}">
        ${st.levels.length ? sections(c.items) : html`<div class="clg-items">${c.items.map(it => itemCard(t, it, c))}</div>`}
        <div class="cl-none muted">Nenhum item neste filtro.</div>
      </div>
      <details class="cl-gantt" data-cl-gantt>
        <summary>${icon('calendar')} Cronograma dos itens (Gantt)</summary>
        <div class="cl-gantt-body">${itemsGantt(c)}</div>
      </details>
      ${can.submit ? html`<div class="submit-bar">
        <ul class="proof-check">${c.check.ok ? html`<li class="ok">✓ Todos os itens respondidos${c.photo_rule === 'obrigatoria' ? ' e com foto' : ''}</li>`
          : c.check.missing.map(m => html`<li class="no">○ Falta: ${m}</li>`)}</ul>
        <button type="button" class="btn btn-success btn-block ${c.check.ok ? 'hide-mobile' : ''}" data-act="submit" ${c.check.ok ? '' : 'disabled'}>${icon('send')}Enviar check-list para conferência</button>
      </div>` : ''}
      ${reviewActions}
    </div>
  </section>`;
}

const personOptions = (users, cur, globalName) => html`<option value="">Responsável global${globalName ? ` (${globalName})` : ''}</option>${users.map(u => html`<option value="${u.id}" ${String(cur ?? '') === String(u.id) ? 'selected' : ''}>${u.name}${u.is_external ? ' · Terceirizado' : ''}</option>`)}`;

// Grupos possíveis: classificações cadastradas na obra + grupos já usados no check-list
const groupOptions = t => [...new Set([...(t._groups || []), ...t.checklist.items.map(i => i.group).filter(Boolean)])];
// Especialidades: modelo escolhido na obra + as já usadas nos itens
const specOptions = t => [...new Set([...(t._specs || []), ...t.checklist.items.map(i => i.specialty).filter(Boolean)])];

export function bindChecklist(root, t, ctx, refresh) {
  const c = t.checklist;
  const list = root.querySelector('.cl-list');
  if (!list) return;
  const st = uiOf(t.id);
  // Gantt dos itens: lembra se estava aberto e desenha as setas ao abrir
  const gd = root.querySelector('[data-cl-gantt]');
  if (gd) {
    if (st.gantt) { gd.open = true; setTimeout(() => drawGanttLinks(gd), 0); }
    gd.addEventListener('toggle', () => { st.gantt = gd.open; if (gd.open) drawGanttLinks(gd); });
  }
  const team = () => t._team || [];
  const run = async (fn, okMsg) => {
    try { const updated = await fn(); if (okMsg) toast(okMsg); if (updated) refresh(updated); }
    catch (e) { toast(e.message, 'err'); }
  };
  // Próximo item pendente que este usuário pode responder, dentro do filtro em uso
  const nextAfter = id => {
    const f = list.dataset.filter;
    const inFilter = x => (f === 'mine' ? x.mine : f === 'nc' ? x.result === 'nao_conforme' : true) && matchItem(x, filterOf(st));
    const items = c.items;
    const i = items.findIndex(x => x.id === id);
    const nxt = [...items.slice(i + 1), ...items.slice(0, i)].find(x => !x.result && x.can_answer && inFilter(x));
    return nxt ? nxt.id : id;
  };
  // Alterar um item já Conforme/N/A exige justificativa
  const askReason = async (it, target) => {
    if (!it.resolved || it.result === target) return {};
    const r = await sheet({
      title: 'Justificativa da alteração',
      submitLabel: `Alterar para ${RESULT[target].label}`,
      body: html`<p class="muted" style="margin:0 0 8px">O item <b>${it.seq}. ${it.text}</b> estava <b>${RESULT[it.result].label}</b>.</p>
        <div class="field"><label class="req" for="rs">Por que a resposta está sendo alterada?</label>
          <textarea id="rs" name="reason" rows="3" maxlength="500" required placeholder="Ex.: na revisão foi encontrado vazamento no sifão"></textarea></div>`,
      onSubmit: d => {
        if (!d.reason || d.reason.trim().length < 5) throw new Error('Descreva a justificativa (mínimo de 5 caracteres).');
        return d;
      },
    });
    return r ? { reason: r.reason.trim() } : null;
  };
  const answer = (itemId, body, msg) => run(async () => {
    const updated = await api(`/tasks/${t.id}/items/${itemId}/answer`, { method: 'POST', body });
    if ('result' in body) {
      scrollTo = nextAfter(itemId);
      if (scrollTo !== itemId) { st.open.delete(itemId); st.open.add(scrollTo); }
    }
    return updated;
  }, msg);

  // Item anterior / próximo (entre os itens visíveis, respeitando filtros e agrupamento)
  list.querySelectorAll('[data-cli-step]').forEach(b => b.addEventListener('click', () => {
    const cur = b.closest('details.cli');
    const vis = [...list.querySelectorAll('details.cli')].filter(d => d.offsetParent !== null);
    const target = vis[vis.indexOf(cur) + Number(b.dataset.cliStep)];
    if (!target) return toast(Number(b.dataset.cliStep) > 0 ? 'Este é o último item da lista.' : 'Este é o primeiro item da lista.', 'warn');
    cur.open = false;
    target.open = true;
    setTimeout(() => target.scrollIntoView({ block: 'start', behavior: 'smooth' }), 30);
  }));
  list.querySelectorAll('details.cli').forEach(d => d.addEventListener('toggle', () => {
    const id = Number(d.dataset.itemId);
    if (d.open) st.open.add(id); else st.open.delete(id);
  }));
  // Grupo / responsável: esconde itens e grupos fora do filtro (os chips continuam valendo por cima)
  const byId = new Map(c.items.map(i => [i.id, i]));
  const applySel = () => {
    const f = list.dataset.filter;
    const chipOk = it => (f === 'mine' ? it.mine : f === 'pending' ? !it.resolved : f === 'nc' ? it.open_nc : true);
    let shown = 0, inSel = 0;
    // Itens (com ou sem agrupamento) e depois as seções (em qualquer nível) que ficaram sem item visível
    list.querySelectorAll('.cli').forEach(el => {
      const it = byId.get(Number(el.dataset.itemId || el.id.slice(4)));
      const ok = !!it && matchItem(it, filterOf(st));
      el.classList.toggle('is-filtered', !ok);
      el.dataset.vis = ok && chipOk(it) ? '1' : '0';
      if (ok) { inSel++; if (chipOk(it)) shown++; }
    });
    list.querySelectorAll('.clg').forEach(sec => sec.classList.toggle('is-filtered', !sec.querySelector('.cli[data-vis="1"]')));
    const none = list.querySelector('.cl-none');
    if (none) none.style.display = shown ? 'none' : 'block';
    const active = !!(st.fGroup || st.fSpec || st.fResp);
    const n = [st.fGroup, st.fSpec, st.fResp].filter(Boolean).length;
    const fc = root.querySelector('[data-fcount]');
    if (fc) { fc.textContent = n; fc.hidden = !n; }
    const i2 = root.querySelector('[data-clsel-info2]');
    if (i2) i2.textContent = active ? ` · filtro: ${inSel} de ${c.items.length} itens` : '';
    const info = root.querySelector('[data-clsel-info]');
    if (info) info.textContent = active ? `${inSel} de ${c.items.length} itens` : '';
    root.querySelector('[data-clsel-clear]')?.toggleAttribute('hidden', !active);
    root.querySelectorAll('[data-clsel]').forEach(s => s.closest('.cl-sel').classList.toggle('is-on', !!s.value));
    // O relatório sai com o mesmo filtro
    root.querySelectorAll('a[data-cl-report]').forEach(a => (a.href = checklistReportLink(t)));
  };
  root.querySelectorAll('[data-clsel]').forEach(s => s.addEventListener('change', () => {
    st[{ group: 'fGroup', spec: 'fSpec', resp: 'fResp' }[s.dataset.clsel]] = s.value;
    applySel();
  }));
  root.querySelector('[data-clsel-clear]')?.addEventListener('click', () => {
    st.fGroup = st.fSpec = st.fResp = '';
    root.querySelectorAll('[data-clsel]').forEach(s => (s.value = ''));
    applySel();
  });
  applySel();
  // Fotos ocultas (lista mais compacta): o botão "N fotos" do card abre a galeria do item
  root.querySelector('[data-clphotos]')?.addEventListener('click', e => {
    const on = list.classList.toggle('no-photos') === false;
    saveShowPhotos(on);
    e.currentTarget.setAttribute('aria-pressed', String(on));
    e.currentTarget.querySelector('span').textContent = on ? 'Ocultar fotos' : 'Mostrar fotos';
  });
  list.querySelectorAll('[data-gallery]').forEach(b => b.addEventListener('click', e => {
    e.preventDefault();
    e.stopPropagation();
    const card = b.closest('.cli');
    const g = galleryFrom(card);
    if (g.length) lightbox(g[0].src, g[0].caption, g);
  }));
  // Menu de filtros: lembra se está aberto (o agrupamento redesenha a lista) e fecha ao clicar fora
  const fmenu = root.querySelector('.cl-fmenu');
  if (fmenu) {
    fmenu.addEventListener('toggle', () => { st.fmenu = fmenu.open; });
    document.addEventListener('click', e => { if (fmenu.open && fmenu.isConnected && !fmenu.contains(e.target)) fmenu.open = false; });
  }
  // Níveis de agrupamento: um nível vazio encerra a sequência
  root.querySelectorAll('[data-cllvl]').forEach(sel => sel.addEventListener('change', () => {
    const vals = [...root.querySelectorAll('[data-cllvl]')].map(x => x.value);
    const cut = vals.indexOf('');
    st.levels = cleanLevels(cut < 0 ? vals : vals.slice(0, cut));
    refresh(t);
  }));
  root.querySelectorAll('.cl-filters [data-clf]').forEach(b => b.addEventListener('click', () => {
    st.filter = b.dataset.clf;
    list.dataset.filter = b.dataset.clf;
    root.querySelectorAll('.cl-filters [data-clf]').forEach(x => x.setAttribute('aria-pressed', String(x === b)));
    applySel();
  }));
  root.querySelectorAll('button[data-answer]').forEach(b => b.addEventListener('click', async () => {
    const it = c.items.find(x => x.id === Number(b.dataset.item));
    if (it.result === b.dataset.answer) return;
    const why = await askReason(it, b.dataset.answer);
    if (!why) return;
    answer(it.id, { result: b.dataset.answer, ...why });
  }));
  // Resposta com foto (câmera) e foto avulsa do item
  root.querySelectorAll('input[type=file][data-answer], input[type=file][data-photo-item]').forEach(inp => inp.addEventListener('change', async () => {
    const files = [...(inp.files || [])];
    inp.value = '';
    if (!files.length) return;
    const itemId = Number(inp.dataset.item || inp.dataset.photoItem);
    try {
      toast(files.length > 1 ? `Enviando ${files.length} fotos…` : 'Enviando foto…', 'warn');
      const got = (await readAttachments(files)).filter(x => !x.pdf).map(x => ({ data: x.data }));
      // Nova resposta começa do zero; foto avulsa entra na resposta atual
      const imgs = fitPhotos(got,PHOTO_LIMIT - (inp.dataset.answer ? 0 : c.items.find(x => x.id === itemId).files.length));
      if (!imgs.length) return;
      if (inp.dataset.answer) {
        const why = await askReason(c.items.find(x => x.id === itemId), inp.dataset.answer);
        if (!why) return toast('Alteração cancelada: a foto não foi enviada.', 'warn');
        return answer(itemId, { result: inp.dataset.answer, images: imgs, ...why });
      }
      run(async () => {
        let updated;
        for (const img of imgs) {
          updated = await api(`/tasks/${t.id}/items/${itemId}/answer`, { method: 'POST', body: { images: [img] } });
        }
        scrollTo = itemId;
        return updated;
      }, imgs.length > 1 ? `${imgs.length} fotos anexadas.` : 'Foto anexada.');
    } catch (e) { toast(e.message, 'err'); }
  }));
  root.querySelectorAll('[data-note-item]').forEach(inp => inp.addEventListener('change', () => answer(Number(inp.dataset.noteItem), { note: inp.value }, 'Observação salva.')));
  root.querySelectorAll('[data-rm-photo]').forEach(b => b.addEventListener('click', async e => {
    e.stopPropagation();
    if (!(await confirmSheet('Remover foto', 'A remoção ficará registrada no histórico.', 'Remover', true))) return;
    run(() => api(`/tasks/${t.id}/items/${b.dataset.item}/files/${b.dataset.rmPhoto}`, { method: 'DELETE' }), 'Foto removida.');
  }));
  root.querySelectorAll('.cli-ph[data-src], .cli-ba-f[data-src], .cli-cover[data-src]').forEach(fg => fg.addEventListener('click', e => {
    if (e.target.closest('[data-rm-photo]')) return;
    // Todas as fotos do item (antes/depois, atuais e do histórico), passando para o lado
    lightbox(fg.dataset.src, fg.dataset.caption, galleryFrom(fg.closest('.cli') || root));
  }));

  // ---------- Itens: incluir, editar, atribuir, excluir ----------
  const panel = root.querySelector('#cl-add-panel');
  let form = null;
  const openAdd = group => {
    st.adding = true;
    panel.hidden = false;
    root.querySelector('#cl-add-toggle')?.setAttribute('aria-expanded', 'true');
    form?.startAt(group);
    panel.scrollIntoView({ block: 'start', behavior: 'smooth' });
    setTimeout(() => form?.focus(), 250);
  };
  const closeAdd = () => { st.adding = false; panel.hidden = true; root.querySelector('#cl-add-toggle')?.setAttribute('aria-expanded', 'false'); };
  root.querySelector('#cl-add-toggle')?.addEventListener('click', () => (panel.hidden ? openAdd() : closeAdd()));
  root.querySelector('#cl-add-close')?.addEventListener('click', closeAdd);
  root.querySelectorAll('[data-add-group]').forEach(b => b.addEventListener('click', () => openAdd(b.dataset.addGroup)));
  if (panel) {
    if (!st.keep) st.keep = {};
    form = bindItemForm(panel.querySelector('[data-cl-form]'), {
      users: team, keep: st.keep, groups: () => groupOptions(t), specialties: () => specOptions(t), specialtiesOwn: () => !!t._specsOwn, globalName: () => t.assignee_name || '',
      photoRequired: () => c.photo_rule === 'obrigatoria', quickList: () => c.photo_rule !== 'obrigatoria',
      onAdd: async (items, again) => {
        // Envia em lotes que cabem numa requisição (fotos de entrada)
        let updated;
        for (const batch of batchBySize(items.map(i => ({ ...i, data: JSON.stringify(i) })), 8_000_000)) {
          updated = await api(`/tasks/${t.id}/items`, { method: 'POST', body: { items: batch.map(({ data, ...i }) => i) } });
        }
        toast(items.length > 1 ? `${items.length} itens adicionados.` : 'Item adicionado.');
        st.adding = again;
        scrollTo = again ? 'cl-new' : null;
        refresh(updated);
      },
      onClose: closeAdd,
    });
  }
  root.querySelectorAll('[data-edit-item]').forEach(b => b.addEventListener('click', async e => {
    e.preventDefault();
    e.stopPropagation();
    const it = c.items.find(x => x.id === Number(b.dataset.editItem));
    const pending = sheet({
      title: `Item ${it.seq}`,
      submitLabel: 'Salvar',
      body: html`<div class="field"><label for="ei-group">Grupo</label><select id="ei-group" name="group">
          ${[...new Set([...groupOptions(t), ...(it.group ? [it.group] : [])])].map(g => html`<option value="${g}" ${g === it.group ? 'selected' : ''}>${g}</option>`)}
          <option value="" ${!it.group ? 'selected' : ''}>Sem grupo</option></select></div>
        ${specOptions(t).length || it.specialty ? html`<div class="field"><label for="ei-spec">Especialidade</label><select id="ei-spec" name="specialty">
          ${[...new Set([...specOptions(t), ...(it.specialty ? [it.specialty] : [])])].map(s => html`<option value="${s}" ${s === it.specialty ? 'selected' : ''}>${s}</option>`)}
          <option value="" ${!it.specialty ? 'selected' : ''}>Sem especialidade</option></select></div>` : ''}
        <div class="field"><label class="req" for="ei-text">Descrição do item</label><input id="ei-text" name="text" type="text" maxlength="300" required value="${it.text}"></div>
        <div class="field"><label for="ei-who">Responsável</label><select id="ei-who" name="assignee_id">${personOptions(team(), it.assignee_id, t.assignee_name)}</select></div>
        <div class="form-row"><div class="field"><label for="ei-start">Data de início</label><input id="ei-start" name="start_date" type="date" value="${it.start_date || ''}"></div>
          <div class="field"><label for="ei-end">Data de término</label><input id="ei-end" name="due_date" type="date" value="${it.due_date || ''}"></div></div>
        <div class="field"><label for="ei-desc">Observação</label><textarea id="ei-desc" name="description" rows="3" maxlength="2000">${it.description || ''}</textarea></div>
        <div class="field"><span class="label">Fotos da não conformidade · cadastro (${it.refs.length} de ${PHOTO_LIMIT})</span>
          <div class="cli-photos">${it.refs.map(f => html`<figure class="cli-ph"><img src="/api/checklist-files/${f.id}" alt="Foto de entrada"><button type="button" class="rm" data-rm-ref="${f.id}" aria-label="Remover foto de entrada">✕</button></figure>`)}
            ${it.refs.length < PHOTO_LIMIT ? html`<label class="cli-ph-add">${fileInput({ camera: true, data: 'data-ref-photo' })}${icon('camera')}<span>Foto</span></label>
            <label class="cli-ph-add">${fileInput({ multiple: true, data: 'data-ref-photo' })}${icon('image')}<span>Galeria</span></label>` : ''}</div>
          ${it.refs.length >= PHOTO_LIMIT ? html`<span class="hint">Limite de ${PHOTO_LIMIT} fotos atingido: remova uma para trocar.</span>` : ''}</div>
        ${!it.result ? html`<button type="button" class="btn btn-danger-ghost btn-sm" data-del-in-sheet>${icon('trash')}Excluir este item</button>`
          : html`<span class="hint">Item já respondido: pode ser editado, mas não excluído.</span>`}`,
      onSubmit: d => api(`/tasks/${t.id}/items/${it.id}`, { method: 'PATCH', body: { text: d.text, group: d.group, ...('specialty' in d ? { specialty: d.specialty || null } : {}), assignee_id: d.assignee_id || null,
        description: d.description, start_date: d.start_date || null, due_date: d.due_date || null } }),
    });
    // Fotos de entrada: incluir/remover direto pela janela (fecha e atualiza a tela)
    document.querySelectorAll('.sheet input[data-ref-photo]').forEach(inp => inp.addEventListener('change', async () => {
      const files = [...(inp.files || [])];
      if (!files.length) return;
      document.querySelector('.sheet [data-close]')?.click();
      try {
        toast('Enviando foto de entrada…', 'warn');
        const imgs = fitPhotos((await readAttachments(files)).filter(x => !x.pdf).map(x => ({ data: x.data })), PHOTO_LIMIT - it.refs.length);
        if (imgs.length) run(() => api(`/tasks/${t.id}/items/${it.id}/reference`, { method: 'POST', body: { images: imgs } }), 'Foto de entrada incluída.');
      } catch (e) { toast(e.message, 'err'); }
    }));
    document.querySelectorAll('.sheet [data-rm-ref]').forEach(b => b.addEventListener('click', () => {
      document.querySelector('.sheet [data-close]')?.click();
      run(() => api(`/tasks/${t.id}/items/${it.id}/files/${b.dataset.rmRef}`, { method: 'DELETE' }), 'Foto de entrada removida.');
    }));
    document.querySelector('.sheet [data-del-in-sheet]')?.addEventListener('click', async () => {
      document.querySelector('.sheet [data-close]')?.click();
      if (!(await confirmSheet('Excluir item', `“${it.text}” será removido do check-list (fica registrado no histórico).`, 'Excluir', true))) return;
      run(() => api(`/tasks/${t.id}/items/${it.id}`, { method: 'DELETE' }), 'Item excluído.');
    });
    const r = await pending;
    if (r && r.id) { toast('Item atualizado.'); refresh(r); }
  }));
  root.querySelectorAll('[data-assign-group]').forEach(b => b.addEventListener('click', async () => {
    const r = await sheet({
      title: `Responsável do grupo ${b.dataset.groupName}`,
      submitLabel: 'Aplicar a todos os itens do grupo',
      body: html`<div class="field"><label for="ag-who">Responsável</label><select id="ag-who" name="assignee_id">${personOptions(team(), null, t.assignee_name)}</select>
        <span class="hint">Vale para os ${b.dataset.assignGroup.split(',').length} itens do grupo. Depois é possível ajustar item a item.</span></div>`,
      onSubmit: d => api(`/tasks/${t.id}/items/assign`, { method: 'POST', body: { item_ids: b.dataset.assignGroup.split(',').map(Number), assignee_id: d.assignee_id || null } }),
    });
    if (r && r.id) { toast('Responsável do grupo definido.'); refresh(r); }
  }));

  // Depois de responder/incluir, leva ao próximo item pendente (ou mantém o foco na digitação)
  if (scrollTo) {
    const el = scrollTo === 'cl-new' ? panel : root.querySelector(`#cli-${scrollTo}`);
    const isForm = scrollTo === 'cl-new';
    scrollTo = null;
    if (el) setTimeout(() => { el.scrollIntoView({ block: isForm ? 'start' : 'nearest', behavior: 'smooth' }); if (isForm) form?.focus(); }, 30);
  }
}
