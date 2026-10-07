// Check-list: cadastro rápido dos itens (Enter, colar lista, "# Grupo", "@Nome") e preenchimento item a item
// numa tela só (Conforme / Não conforme / N/A, observação e fotos), com avanço automático para o próximo item.
import { html, raw, api, icon, fmtDateTime } from '../core.js';
import { toast, sheet, confirmSheet, readAttachments, fileInput, lightbox, batchBySize } from '../ui.js';

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

// ---------- Formulário de item (criação do check-list e "Adicionar itens" na tarefa) ----------
// Campos: item, grupo, responsável, descrição detalhada, início + prazo em dias (calcula a data) e fotos de entrada.
const fmtD = d => (d ? d.split('-').reverse().join('/') : '');
const todayISO = () => new Date(Date.now() - new Date().getTimezoneOffset() * 60000).toISOString().slice(0, 10);
const plusDays = (d, n) => new Date(Date.parse(d) + n * 86400e3).toISOString().slice(0, 10);

export function itemForm({ users, globalName, groups, keep = {}, photoRequired, quickList }) {
  const opt = (v, l, cur) => html`<option value="${v}" ${String(cur ?? '') === String(v) ? 'selected' : ''}>${l}</option>`;
  return html`<div class="cl-form" data-cl-form>
    <div class="field"><label class="req">Item a verificar</label>
      <input type="text" data-f="text" maxlength="300" placeholder="Ex.: Tomadas e interruptores funcionando" autocomplete="off" enterkeyhint="next"></div>
    <div class="form-row">
      <div class="field"><label>Grupo (ambiente/local)</label>
        <input type="text" data-f="group" maxlength="80" value="${keep.group || ''}" list="cl-groups-dl" placeholder="Ex.: Cozinha" autocomplete="off">
        <datalist id="cl-groups-dl">${groups.map(g => html`<option value="${g}"></option>`)}</datalist></div>
      <div class="field"><label>Responsável</label>
        <select data-f="assignee_id">${opt('', globalName ? `Responsável global (${globalName})` : 'Responsável global', keep.assignee_id)}${users.map(u => opt(u.id, `${u.name}${u.is_external ? ' · Terceirizado' : ''}`, keep.assignee_id))}</select></div>
    </div>
    <div class="field"><label>Descrição detalhada</label>
      <textarea data-f="description" rows="2" maxlength="2000" placeholder="Como verificar, critério de aceite, referência de projeto…"></textarea></div>
    <div class="cl-deadline">
      <div class="field"><label>Início</label><input type="date" data-f="start_date" value="${keep.start_date || ''}"></div>
      <div class="field"><label>Prazo (dias)</label><input type="number" data-f="duration_days" min="0" max="3650" inputmode="numeric" value="${keep.duration_days ?? ''}" placeholder="Ex.: 3"></div>
      <div class="cl-due" data-due></div>
    </div>
    <div class="field"><span class="label ${photoRequired ? 'req' : ''}" data-photo-label>Foto de entrada ${photoRequired ? '(obrigatória)' : '(opcional)'}</span>
      <div class="cli-photos" data-photos>
        <label class="cli-ph-add">${fileInput({ camera: true, data: 'data-new-photo' })}${icon('camera')}<span>Foto</span></label>
        <label class="cli-ph-add">${fileInput({ multiple: true, data: 'data-new-photo' })}${icon('image')}<span>Galeria</span></label>
      </div>
      <span class="hint" data-photo-hint ${photoRequired ? '' : 'hidden'}>Com a foto obrigatória, cada item precisa da foto de entrada (ela vira o “antes”).</span></div>
    <div class="form-error" data-err hidden></div>
    <div class="cl-form-actions">
      <button type="button" class="btn btn-primary" data-add-again>${icon('plus')}Adicionar e criar outro</button>
      <button type="button" class="btn btn-ghost" data-add-close>${icon('check')}Adicionar e fechar</button>
    </div>
    ${quickList !== false ? html`<details class="cl-quick" ${quickList ? '' : 'hidden'}><summary>${icon('checklist')} Colar vários itens de uma vez (sem foto)</summary>
      <textarea data-quick rows="5" placeholder="Um item por linha&#10;# Cozinha&#10;Tomadas funcionando @Bruno&#10;Pia sem vazamento"></textarea>
      ${composerHint}
      <button type="button" class="btn btn-ghost btn-sm" data-quick-add>${icon('plus')}Adicionar lista</button></details>` : ''}
  </div>`;
}

// Liga o formulário: fotos, prazo calculado, validação e envio (onAdd recebe [{...item}] e devolve uma Promise)
export function bindItemForm(el, { users, photoRequired, onAdd, onClose, keep }) {
  const q = s => el.querySelector(s);
  const f = k => el.querySelector(`[data-f="${k}"]`);
  const err = q('[data-err]');
  let photos = [];
  const drawPhotos = () => {
    const box = q('[data-photos]');
    box.querySelectorAll('.cli-ph').forEach(n => n.remove());
    photos.forEach((p, i) => {
      const fig = document.createElement('figure');
      fig.className = 'cli-ph';
      fig.innerHTML = '<img alt="Foto de entrada"><button type="button" class="rm" aria-label="Remover foto">✕</button>';
      fig.querySelector('img').src = p.data;
      fig.querySelector('.rm').onclick = () => { photos.splice(i, 1); drawPhotos(); };
      box.insertBefore(fig, box.firstChild);
    });
  };
  const showDue = () => {
    const days = f('duration_days').value;
    const start = f('start_date').value || todayISO();
    q('[data-due]').innerHTML = days !== '' && Number(days) >= 0
      ? `${icon('calendar')}<span>Prazo<b>${fmtD(plusDays(start, Number(days)))}</b></span>` : '<span class="muted">Sem prazo</span>';
  };
  el.querySelectorAll('input[data-new-photo]').forEach(inp => inp.addEventListener('change', async () => {
    const files = [...(inp.files || [])];
    inp.value = '';
    if (!files.length) return;
    try { photos.push(...(await readAttachments(files)).filter(x => !x.pdf).map(x => ({ data: x.data }))); drawPhotos(); }
    catch (e) { toast(e.message, 'err'); }
  }));
  f('start_date').addEventListener('input', showDue);
  f('duration_days').addEventListener('input', showDue);
  showDue();
  const read = () => ({
    text: f('text').value.trim(), group: f('group').value.trim() || null, description: f('description').value.trim() || null,
    assignee_id: f('assignee_id').value ? Number(f('assignee_id').value) : null,
    start_date: f('start_date').value || null, duration_days: f('duration_days').value === '' ? null : Number(f('duration_days').value),
    images: photos.slice(),
  });
  const fail = msg => { err.textContent = msg; err.hidden = false; };
  const submit = async again => {
    err.hidden = true;
    const it = read();
    if (!it.text) { fail('Informe o item a verificar.'); return f('text').focus(); }
    if (photoRequired() && !it.images.length) return fail('Foto obrigatória: tire ou escolha a foto de entrada do item.');
    const btns = el.querySelectorAll('[data-add-again],[data-add-close]');
    btns.forEach(b => (b.disabled = true));
    try {
      if (keep) Object.assign(keep, { group: it.group, assignee_id: it.assignee_id, start_date: it.start_date, duration_days: it.duration_days });
      await onAdd([it], again);
      // Mantém grupo, responsável e prazo para o próximo item; limpa texto, descrição e fotos
      f('text').value = '';
      f('description').value = '';
      photos = [];
      drawPhotos();
      if (again) f('text').focus(); else onClose?.();
    } catch (e) { fail(e.message); }
    finally { btns.forEach(b => (b.disabled = false)); }
  };
  q('[data-add-again]').addEventListener('click', () => submit(true));
  q('[data-add-close]').addEventListener('click', () => submit(false));
  // Enter no campo do item adiciona e já abre o próximo; nos demais campos não envia o formulário da página
  el.addEventListener('keydown', e => {
    if (e.key !== 'Enter' || e.target.tagName === 'TEXTAREA') return;
    e.preventDefault();
    if (e.target === f('text')) submit(true);
  });
  const quick = q('[data-quick-add]');
  if (quick) quick.addEventListener('click', async () => {
    const state = { group: f('group').value.trim() || null, groupAssignee: f('assignee_id').value ? Number(f('assignee_id').value) : null };
    const { items, unknown } = parseLines(q('[data-quick]').value.split(/\r?\n/), users(), state);
    if (unknown.length) toast(`Não encontrei na equipe do projeto: ${[...new Set(unknown)].join(', ')}. O item ficou com o responsável global.`, 'warn');
    if (!items.length) return fail('Cole ao menos um item (um por linha).');
    try { await onAdd(items, true); q('[data-quick]').value = ''; } catch (e) { fail(e.message); }
  });
  return { focus: () => f('text').focus() };
}

// Lista em construção (formulário de criação do check-list)
export function renderDraft(items, users, globalName) {
  if (!items.length) return html`<div class="cl-empty muted">Nenhum item ainda. Preencha acima e toque em “Adicionar e criar outro”.</div>`;
  const who = id => users.find(u => u.id === id)?.name || (globalName ? `${globalName} (global)` : 'Responsável global');
  let group;
  return html`${items.map((it, i) => {
    const head = it.group !== group ? html`<div class="cl-draft-group">${it.group || 'Sem grupo'}</div>` : '';
    group = it.group;
    const due = it.duration_days !== null && it.duration_days !== undefined ? plusDays(it.start_date || todayISO(), it.duration_days) : null;
    return html`${head}<div class="cl-draft-card" data-i="${i}">
      ${it.images?.length ? html`<img class="cl-draft-ph" src="${it.images[0].data}" alt="">` : html`<span class="cl-draft-ph is-empty">${icon('camera')}</span>`}
      <div class="cl-draft-txt"><b>${i + 1}. ${it.text}</b>
        <span>${icon('user')} ${who(it.assignee_id)}${due ? html` · ${icon('calendar')} ${fmtD(due)}` : ''}${it.images?.length ? ` · ${it.images.length} foto(s)` : ''}</span>
        ${it.description ? html`<em>${it.description}</em>` : ''}</div>
      <button type="button" class="icon-btn cl-draft-rm" aria-label="Remover item ${i + 1}">✕</button></div>`;
  })}`;
}

// ---------- Tela da tarefa ----------
// Estado de tela por check-list (sobrevive ao redesenho após cada resposta)
const ui = {};
const uiOf = id => (ui[id] ||= { filter: null, adding: false });
let scrollTo = null;

const initials = n => String(n || '?').trim().split(/\s+/).filter(Boolean).slice(0, 2).map(p => p[0]).join('').toUpperCase();
const shortDate = iso => fmtDateTime(iso).replace(/\/\d{4},/, ',');

function groupsOf(items) {
  const groups = [];
  for (const it of items) {
    const g = groups.at(-1);
    if (g && g.name === (it.group || '')) g.items.push(it);
    else groups.push({ name: it.group || '', items: [it] });
  }
  return groups;
}

const photo = (f, caption, cls = '') => html`<figure class="cli-ph ${cls}" data-src="/api/checklist-files/${f.id}" data-caption="${caption}">
  <img src="/api/checklist-files/${f.id}" alt="${caption}" loading="lazy"></figure>`;

function itemCard(t, it, c) {
  // Foto obrigatória: cada resposta Conforme/Não conforme leva a sua própria foto (fotos avulsas já anexadas valem)
  const needPhoto = c.photo_rule === 'obrigatoria' && !it.loose_count;
  const ncTimes = it.nc_count > 1 ? ` · ${it.nc_count}x` : '';
  const state = it.result === 'nao_conforme'
    ? html`<span class="cli-state st-nao_conforme">✗ Não conforme${ncTimes}</span>`
    : it.result
      ? html`<span class="cli-state st-${it.result}">${RESULT[it.result].short} ${RESULT[it.result].label}</span>${it.nc_count ? html`<span class="cli-fixed" title="Ficou não conforme ${it.nc_count} vez(es) antes de ser corrigido">corrigido · ${it.nc_count}x não conforme</span>` : ''}`
      : html`<span class="cli-state st-pending">Pendente</span>`;
  const menu = c.can_manage_items ? html`<button type="button" class="cli-menu" data-edit-item="${it.id}" aria-label="Editar item ${it.seq}">${icon('more')}</button>` : '';
  const due = it.due_date ? html`<span class="cli-due ${it.overdue ? 'is-late' : ''}">${icon('calendar')}${it.overdue ? 'Atrasado · ' : 'Até '}${fmtD(it.due_date)}</span>` : '';
  const head = html`<div class="cli-top"><span class="cli-num">${it.seq}</span><span class="cli-title">${it.text}</span>${menu}</div>
    <div class="cli-meta">
      ${state}
      <span class="who-chip ${it.mine ? 'is-mine' : ''}"><i>${initials(it.responsible_name)}</i>${it.responsible_name}${it.assignee_id ? '' : ' · global'}</span>
      ${it.mine && !it.resolved ? html`<span class="mine-chip">seu item</span>` : ''}
      ${due}
      ${it.result ? html`<span class="cli-when">${icon('check')}${it.answered_by_name || '—'} · ${shortDate(it.answered_at)}</span>` : ''}
    </div>
    ${it.description ? html`<div class="cli-desc">${it.description}</div>` : ''}`;
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
  const beforeLabel = it.before?.kind === 'referencia' ? 'Antes · entrada' : 'Antes · não conforme';
  const visual = it.before && it.after
    ? html`<div class="cli-ba">
        <figure class="cli-ba-f is-before ${it.before.kind === 'referencia' ? 'is-ref' : ''}" data-src="/api/checklist-files/${it.before.id}" data-caption="${beforeLabel} · item ${it.seq}"><img src="/api/checklist-files/${it.before.id}" alt="Antes" loading="lazy"><figcaption>${beforeLabel} · ${shortDate(it.before.created_at)}</figcaption></figure>
        <span class="cli-ba-arrow" aria-hidden="true">→</span>
        <figure class="cli-ba-f is-after" data-src="/api/checklist-files/${it.after.id}" data-caption="Depois · conforme · item ${it.seq}"><img src="/api/checklist-files/${it.after.id}" alt="Depois" loading="lazy"><figcaption>Depois · ${shortDate(it.after.created_at)}</figcaption></figure>
      </div>`
    : it.cover ? (it.result === 'nao_conforme'
      ? html`<figure class="cli-cover" data-src="/api/checklist-files/${it.cover.id}" data-caption="Não conformidade · item ${it.seq}">
        <img src="/api/checklist-files/${it.cover.id}" alt="Foto da não conformidade" loading="lazy">
        <figcaption>${icon('alert')} Não conformidade mais recente${ncTimes} · ${shortDate(it.cover.created_at)}</figcaption></figure>`
      : html`<figure class="cli-cover is-ref" data-src="/api/checklist-files/${it.cover.id}" data-caption="Foto de entrada · item ${it.seq}">
        <img src="/api/checklist-files/${it.cover.id}" alt="Foto de entrada" loading="lazy">
        <figcaption>${icon('image')} Foto de entrada${it.refs.length > 1 ? ` (+${it.refs.length - 1})` : ''}</figcaption></figure>`) : '';
  const others = it.files.filter(f => !shown.has(f.id));
  const history = it.history.length > 1 || it.history.some(h => h.reason) ? html`<details class="cli-hist"><summary>${icon('history')} Histórico do item (${it.history.length})</summary>
    <ol>${[...it.history].reverse().map(h => html`<li class="h-${h.result}"><b>${RESULT[h.result].label}</b> · ${h.user_name || '—'} · ${shortDate(h.created_at)}
      ${h.reason ? html`<div class="h-why">Justificativa: ${h.reason}</div>` : ''}${h.note ? html`<div class="h-note">${h.note}</div>` : ''}
      ${h.files.length ? html`<div class="h-ph">${h.files.map(f => photo(f, `Item ${it.seq} · ${RESULT[h.result].label} · ${shortDate(h.created_at)}`, 'is-mini'))}</div>` : ''}</li>`)}</ol></details>` : '';
  const body = html`
    ${visual}
    ${it.can_answer ? html`<div class="cli-answer" role="group" aria-label="Resposta do item ${it.seq}">${ansBtn('conforme')}${ansBtn('nao_conforme')}${ansBtn('na')}</div>
      ${it.result === 'nao_conforme' ? html`<div class="cli-hint">${icon('info')} Continua pendente: depois de corrigir, marque Conforme${c.photo_rule === 'obrigatoria' ? ' com a foto do depois' : ''}.</div>`
        : needPhoto && !it.result ? html`<div class="cli-hint">${icon('camera')} Foto obrigatória: ao tocar em Conforme ou Não conforme a câmera abre.</div>` : ''}`
      : !it.resolved ? html`<div class="cli-hint">${icon('clock')} ${c.locked ? 'Check-list fechado para alterações.' : `Aguardando ${it.responsible_name} (ou o responsável global).`}</div>` : ''}
    ${others.length || it.can_answer ? html`<div class="cli-photos">
      ${others.map(fl => html`<figure class="cli-ph" data-src="/api/checklist-files/${fl.id}" data-caption="Item ${it.seq} · ${it.text}">
        <img src="/api/checklist-files/${fl.id}" alt="Foto do item ${it.seq}" loading="lazy">
        ${it.can_answer ? html`<button type="button" class="rm" data-rm-photo="${fl.id}" data-item="${it.id}" aria-label="Remover foto">✕</button>` : ''}</figure>`)}
      ${it.can_answer ? html`<label class="cli-ph-add">${fileInput({ camera: true, data: `data-photo-item="${it.id}"` })}${icon('camera')}<span>${it.files.length ? 'Mais foto' : 'Foto'}</span></label>
        <label class="cli-ph-add">${fileInput({ multiple: true, data: `data-photo-item="${it.id}"` })}${icon('image')}<span>Galeria</span></label>` : ''}</div>` : ''}
    ${it.can_answer && (it.result === 'nao_conforme' || it.note) ? html`<label class="cli-note"><span>${it.result === 'nao_conforme' ? 'O que está errado?' : 'Observação'}</span>
        <input type="text" data-note-item="${it.id}" maxlength="1000" value="${it.note || ''}" placeholder="${it.result === 'nao_conforme' ? 'Descreva o problema encontrado' : 'Observação'}"></label>`
      : it.note ? html`<div class="cli-note-text"><b>${it.result === 'nao_conforme' ? 'Problema:' : 'Obs.:'}</b> ${it.note}</div>` : ''}
    ${history}`;
  const nothing = !it.can_answer && !it.files.length && !it.note && !it.history.length;
  const attrs = `id="cli-${it.id}" data-pending="${it.resolved ? 0 : 1}" data-mine="${it.mine ? 1 : 0}" data-nc="${it.result === 'nao_conforme' ? 1 : 0}"`;
  const cls = `cli ${it.result ? `res-${it.result}` : 'res-pending'} ${it.mine ? 'is-mine' : ''}`;
  // Resolvidos (Conforme/N/A) ficam recolhidos numa linha — com a miniatura do antes × depois quando houve correção
  const mini = it.before && it.after ? html`<span class="cli-mini-ba ${it.before.kind === 'referencia' ? 'is-ref' : ''}"><img src="/api/checklist-files/${it.before.id}" alt="Antes" loading="lazy"><img src="/api/checklist-files/${it.after.id}" alt="Depois" loading="lazy"></span>` : '';
  return it.resolved
    ? (nothing ? html`<article class="${cls}" ${raw(attrs)}>${head}<div class="cli-body"></div></article>`
      : html`<details class="${cls}" ${raw(attrs)}><summary>${head}${mini}<span class="cli-more">${it.can_answer ? 'tocar para ver, alterar ou incluir fotos' : 'ver fotos e histórico'}</span></summary><div class="cli-body">${body}</div></details>`)
    : html`<article class="${cls}" ${raw(attrs)}>${head}<div class="cli-body">${body}</div></article>`;
}

export function checklistSection(t, { reviewBox, reviewActions, can }) {
  const c = t.checklist;
  const s = c.summary;
  const st = uiOf(t.id);
  const f = st.filter || (s.mine_pending && s.mine_pending < s.total - s.done ? 'mine' : 'all');
  const groups = groupsOf(c.items);
  const chip = (k, label, n) => html`<button type="button" class="chip" data-clf="${k}" aria-pressed="${f === k}">${label}${n !== undefined ? html`<span class="n">${n}</span>` : ''}</button>`;
  return html`<section class="card block block-exec" id="checklist" aria-labelledby="blk-cl">
    <header class="block-head"><span class="step">2</span><h2 id="blk-cl">Check-list</h2>
      <span class="right muted" style="font-size:12px">${s.done} de ${s.total} concluídos${s.nc_total ? ` · ${s.nc_total} NC no histórico` : ''}</span></header>
    <div class="block-body">
      ${reviewBox}
      <div class="cl-overview">
        <div class="cl-ring" style="--p:${s.pct}"><b>${s.pct}%</b><span>concluído</span></div>
        <div class="cl-counts">
          <span class="cnt ok"><b>${s.conforme}</b>Conforme</span><span class="cnt nc"><b>${s.nao_conforme}</b>Não conforme em aberto</span>
          <span class="cnt na"><b>${s.na}</b>N/A</span><span class="cnt pend"><b>${s.pending}</b>Sem resposta</span>
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
        ${c.can_manage_items ? html`<button type="button" class="btn btn-ghost btn-sm" id="cl-add-toggle" aria-expanded="${st.adding}">${icon('plus')}Adicionar itens</button>` : ''}
      </div>
      ${c.can_manage_items ? html`<div class="cl-add-panel" id="cl-add-panel" ${st.adding ? '' : 'hidden'}>
        <div class="cl-add-head"><b>${icon('plus')} Novo item</b><button type="button" class="icon-btn" id="cl-add-close" aria-label="Fechar">✕</button></div>
        ${itemForm({ users: t._team || [], globalName: t.assignee_name, groups: [...new Set(c.items.map(i => i.group).filter(Boolean))],
          keep: st.keep || {}, photoRequired: c.photo_rule === 'obrigatoria', quickList: c.photo_rule !== 'obrigatoria' })}
      </div>` : ''}
      <div class="cl-list" data-filter="${f}">
        ${groups.map(g => {
          const done = g.items.filter(i => i.result).length;
          const pct = Math.round((done / g.items.length) * 100);
          return html`<section class="clg">
            <header class="clg-head">
              <div class="clg-name"><h3>${g.name || 'Itens'}</h3><div class="clg-bar"><span style="width:${pct}%"></span></div></div>
              <span class="clg-count">${done}/${g.items.length}</span>
              ${c.can_manage_items ? html`<button type="button" class="clg-btn" data-add-group="${g.name}" title="Adicionar item neste grupo">${icon('plus')}<span>Item</span></button>
                ${g.items.length > 1 ? html`<button type="button" class="clg-btn" data-assign-group="${g.items.map(i => i.id).join(',')}" data-group-name="${g.name || 'Itens'}" title="Definir o responsável do grupo">${icon('user')}<span>Grupo</span></button>` : ''}` : ''}
            </header>
            <div class="clg-items">${g.items.map(it => itemCard(t, it, c))}</div>
          </section>`;
        })}
        <div class="cl-none muted">Nenhum item neste filtro.</div>
      </div>
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

export function bindChecklist(root, t, ctx, refresh) {
  const c = t.checklist;
  const list = root.querySelector('.cl-list');
  if (!list) return;
  const st = uiOf(t.id);
  const team = () => t._team || [];
  const run = async (fn, okMsg) => {
    try { const updated = await fn(); if (okMsg) toast(okMsg); if (updated) refresh(updated); }
    catch (e) { toast(e.message, 'err'); }
  };
  // Próximo item pendente que este usuário pode responder, dentro do filtro em uso
  const nextAfter = id => {
    const f = list.dataset.filter;
    const inFilter = x => (f === 'mine' ? x.mine : f === 'nc' ? x.result === 'nao_conforme' : true);
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
    if ('result' in body) scrollTo = nextAfter(itemId);
    return updated;
  }, msg);

  root.querySelectorAll('.cl-filters [data-clf]').forEach(b => b.addEventListener('click', () => {
    st.filter = b.dataset.clf;
    list.dataset.filter = b.dataset.clf;
    root.querySelectorAll('.cl-filters [data-clf]').forEach(x => x.setAttribute('aria-pressed', String(x === b)));
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
      const imgs = (await readAttachments(files)).filter(x => !x.pdf).map(x => ({ data: x.data }));
      if (inp.dataset.answer) {
        const why = await askReason(c.items.find(x => x.id === itemId), inp.dataset.answer);
        if (!why) return toast('Alteração cancelada: a foto não foi enviada.', 'warn');
        return answer(itemId, { result: inp.dataset.answer, images: imgs, ...why });
      }
      run(async () => {
        let updated;
        for (let i = 0; i < imgs.length; i += 5) {
          updated = await api(`/tasks/${t.id}/items/${itemId}/answer`, { method: 'POST', body: { images: imgs.slice(i, i + 5) } });
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
    lightbox(fg.dataset.src, fg.dataset.caption);
  }));

  // ---------- Itens: incluir, editar, atribuir, excluir ----------
  const panel = root.querySelector('#cl-add-panel');
  let form = null;
  const openAdd = group => {
    st.adding = true;
    panel.hidden = false;
    root.querySelector('#cl-add-toggle')?.setAttribute('aria-expanded', 'true');
    if (group !== undefined) panel.querySelector('[data-f="group"]').value = group || '';
    panel.scrollIntoView({ block: 'start', behavior: 'smooth' });
    setTimeout(() => form?.focus(), 250);
  };
  const closeAdd = () => { st.adding = false; panel.hidden = true; root.querySelector('#cl-add-toggle')?.setAttribute('aria-expanded', 'false'); };
  root.querySelector('#cl-add-toggle')?.addEventListener('click', () => (panel.hidden ? openAdd() : closeAdd()));
  root.querySelector('#cl-add-close')?.addEventListener('click', closeAdd);
  root.querySelectorAll('[data-add-group]').forEach(b => b.addEventListener('click', () => openAdd(b.dataset.addGroup)));
  if (panel) {
    if (!st.keep) st.keep = { group: c.items.at(-1)?.group || null };
    if (!panel.querySelector('[data-f="group"]').value && st.keep.group) panel.querySelector('[data-f="group"]').value = st.keep.group;
    form = bindItemForm(panel.querySelector('[data-cl-form]'), {
      users: team, keep: st.keep,
      photoRequired: () => c.photo_rule === 'obrigatoria',
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
    const groups = [...new Set(c.items.map(i => i.group).filter(Boolean))];
    const pending = sheet({
      title: `Item ${it.seq}`,
      submitLabel: 'Salvar',
      body: html`<div class="field"><label class="req" for="ei-text">Texto do item</label><input id="ei-text" name="text" type="text" maxlength="300" required value="${it.text}"></div>
        <div class="field"><label for="ei-group">Grupo (ambiente/local)</label><input id="ei-group" name="group" type="text" maxlength="80" value="${it.group || ''}" list="ei-groups" placeholder="Sem grupo">
          <datalist id="ei-groups">${groups.map(g => html`<option value="${g}"></option>`)}</datalist></div>
        <div class="field"><label for="ei-who">Responsável</label><select id="ei-who" name="assignee_id">${personOptions(team(), it.assignee_id, t.assignee_name)}</select></div>
        <div class="field"><label for="ei-desc">Descrição detalhada</label><textarea id="ei-desc" name="description" rows="3" maxlength="2000">${it.description || ''}</textarea></div>
        <div class="form-row"><div class="field"><label for="ei-start">Início</label><input id="ei-start" name="start_date" type="date" value="${it.start_date || ''}"></div>
          <div class="field"><label for="ei-days">Prazo (dias)</label><input id="ei-days" name="duration_days" type="number" min="0" max="3650" inputmode="numeric" value="${it.duration_days ?? ''}"></div></div>
        <div class="field"><span class="label">Fotos de entrada (${it.refs.length})</span>
          <div class="cli-photos">${it.refs.map(f => html`<figure class="cli-ph"><img src="/api/checklist-files/${f.id}" alt="Foto de entrada"><button type="button" class="rm" data-rm-ref="${f.id}" aria-label="Remover foto de entrada">✕</button></figure>`)}
            <label class="cli-ph-add">${fileInput({ camera: true, data: 'data-ref-photo' })}${icon('camera')}<span>Foto</span></label>
            <label class="cli-ph-add">${fileInput({ multiple: true, data: 'data-ref-photo' })}${icon('image')}<span>Galeria</span></label></div></div>
        ${!it.result ? html`<button type="button" class="btn btn-danger-ghost btn-sm" data-del-in-sheet>${icon('trash')}Excluir este item</button>`
          : html`<span class="hint">Item já respondido: pode ser editado, mas não excluído.</span>`}`,
      onSubmit: d => api(`/tasks/${t.id}/items/${it.id}`, { method: 'PATCH', body: { text: d.text, group: d.group, assignee_id: d.assignee_id || null,
        description: d.description, start_date: d.start_date || null, duration_days: d.duration_days === '' ? null : Number(d.duration_days) } }),
    });
    // Fotos de entrada: incluir/remover direto pela janela (fecha e atualiza a tela)
    document.querySelectorAll('.sheet input[data-ref-photo]').forEach(inp => inp.addEventListener('change', async () => {
      const files = [...(inp.files || [])];
      if (!files.length) return;
      document.querySelector('.sheet [data-close]')?.click();
      try {
        toast('Enviando foto de entrada…', 'warn');
        const imgs = (await readAttachments(files)).filter(x => !x.pdf).map(x => ({ data: x.data }));
        run(() => api(`/tasks/${t.id}/items/${it.id}/reference`, { method: 'POST', body: { images: imgs.slice(0, 5) } }), 'Foto de entrada incluída.');
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
    if (el) setTimeout(() => { el.scrollIntoView({ block: isForm ? 'start' : 'center', behavior: 'smooth' }); if (isForm) form?.focus(); }, 30);
  }
}
