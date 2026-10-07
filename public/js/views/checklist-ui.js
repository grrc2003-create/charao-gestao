// Check-list: cadastro rápido dos itens (Enter, colar lista, "# Grupo", "@Nome") e preenchimento item a item
// numa tela só (Conforme / Não conforme / N/A, observação e fotos), com avanço automático para o próximo item.
import { html, api, icon, fmtDateTime, progress } from '../core.js';
import { toast, confirmSheet, readAttachments, fileInput, lightbox } from '../ui.js';

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

// Campo de digitação rápida: Enter adiciona e mantém o foco; colar várias linhas cria um item por linha
export function bindComposer(input, { users, state, onAdd }) {
  const commit = lines => {
    const { items, unknown } = parseLines(lines, users(), state);
    if (unknown.length) toast(`Não encontrei na equipe do projeto: ${[...new Set(unknown)].join(', ')}. O item ficou com o responsável global.`, 'warn');
    if (items.length || lines.some(l => l.trim().startsWith('#'))) onAdd(items);
  };
  input.addEventListener('keydown', e => {
    if (e.key !== 'Enter') return;
    e.preventDefault();
    if (!input.value.trim()) return;
    commit([input.value]);
    input.value = '';
    input.focus();
  });
  input.addEventListener('paste', e => {
    const text = e.clipboardData?.getData('text') || '';
    if (!/\r?\n/.test(text.trim())) return;
    e.preventDefault();
    commit(text.split(/\r?\n/));
    input.value = '';
  });
}

export const composerHint = html`<span class="hint">Digite o item e tecle <b>Enter</b> para o próximo. Cole uma lista para criar vários de uma vez.
  <b># Cozinha</b> abre um grupo (ambiente/local) · <b>@Nome</b> no fim define o responsável do item (ou do grupo inteiro: <b># Elétrica @Bruno</b>).</span>`;

const personLabel = u => `${u.name}${u.is_external ? ' · Terceirizado' : ''}`;
const assigneeOptions = (users, cur, globalName) => html`<option value="">${globalName ? `Global (${globalName})` : 'Responsável global'}</option>${users.map(u => html`<option value="${u.id}" ${String(cur ?? '') === String(u.id) ? 'selected' : ''}>${personLabel(u)}</option>`)}`;

// Lista editável usada no formulário de criação
export function renderDraft(items, users, globalName) {
  if (!items.length) return html`<div class="cl-empty muted">Nenhum item ainda. Comece digitando acima.</div>`;
  let group;
  return html`${items.map((it, i) => {
    const head = it.group !== group ? html`<div class="cl-draft-group">${it.group || 'Sem grupo'}</div>` : '';
    group = it.group;
    return html`${head}<div class="cl-draft-item" data-i="${i}">
      <span class="cl-n">${i + 1}</span>
      <input type="text" class="cl-draft-text" value="${it.text}" maxlength="300" aria-label="Texto do item ${i + 1}">
      <select class="cl-draft-who" aria-label="Responsável do item ${i + 1}">${assigneeOptions(users, it.assignee_id, globalName)}</select>
      <button type="button" class="icon-btn cl-draft-rm" aria-label="Remover item ${i + 1}">✕</button></div>`;
  })}`;
}

// ---------- Tela da tarefa ----------
let filterByTask = {};
let scrollTo = null;

export function checklistSection(t, { reviewBox, reviewActions, can }) {
  const c = t.checklist;
  const s = c.summary;
  const f = filterByTask[t.id] || (s.mine_pending ? 'mine' : 'all');
  const groups = [];
  for (const it of c.items) {
    const g = groups.at(-1);
    if (g && g.name === (it.group || '')) g.items.push(it);
    else groups.push({ name: it.group || '', items: [it] });
  }
  const users = t._team || [];
  const itemRow = it => {
    const needPhoto = c.photo_rule === 'obrigatoria' && !it.files.length;
    const btn = r => {
      const active = it.result === r;
      const lbl = html`${RESULT[r].short} ${RESULT[r].label}`;
      // Foto obrigatória e ainda sem foto: o botão abre a câmera e a resposta é gravada com a foto
      return needPhoto && r !== 'na' && !active
        ? html`<label class="cl-btn cl-${RESULT[r].cls}" title="Abre a câmera">${fileInput({ camera: true, data: `data-answer="${r}" data-item="${it.id}"` })}${icon('camera')}${RESULT[r].label}</label>`
        : html`<button type="button" class="cl-btn cl-${RESULT[r].cls} ${active ? 'is-on' : ''}" data-answer="${r}" data-item="${it.id}" aria-pressed="${active}">${lbl}</button>`;
    };
    return html`<div class="cl-item ${it.result ? `res-${it.result}` : 'res-pending'} ${it.mine ? 'is-mine' : ''}" id="cli-${it.id}"
        data-pending="${it.result ? 0 : 1}" data-mine="${it.mine ? 1 : 0}" data-nc="${it.result === 'nao_conforme' ? 1 : 0}" data-answerable="${it.can_answer ? 1 : 0}">
      <div class="cl-head"><span class="cl-n">${it.seq}</span>
        <div class="cl-body"><div class="cl-text">${it.text}</div>
          <div class="cl-who">${icon('user')} ${it.responsible_name}${it.assignee_id ? '' : ' (global)'}${it.mine ? html` <b class="cl-mine">seu</b>` : ''}
            ${it.result ? html` · ${RESULT[it.result].label} por ${it.answered_by_name || '—'} em ${fmtDateTime(it.answered_at)}` : ''}</div></div>
        ${c.can_manage_items ? html`<div class="cl-tools">
          <select class="cl-assign" data-item="${it.id}" aria-label="Responsável do item ${it.seq}">${assigneeOptions(users, it.assignee_id, t.assignee_name)}</select>
          ${!it.result ? html`<button type="button" class="icon-btn" data-del-item="${it.id}" aria-label="Excluir item ${it.seq}">✕</button>` : ''}</div>` : ''}
      </div>
      ${it.can_answer ? html`<div class="cl-actions">${btn('conforme')}${btn('nao_conforme')}${btn('na')}</div>`
        : !it.result ? html`<div class="cl-wait muted">Aguardando ${it.responsible_name}</div>` : ''}
      ${it.files.length || (it.can_answer && it.result) ? html`<div class="thumbs cl-thumbs">
        ${it.files.map(fl => html`<figure class="thumb" data-src="/api/checklist-files/${fl.id}" data-caption="Item ${it.seq} · ${it.text}">
          <img src="/api/checklist-files/${fl.id}" alt="Foto do item ${it.seq}" loading="lazy">
          ${it.can_answer ? html`<button type="button" class="rm" data-rm-photo="${fl.id}" data-item="${it.id}" aria-label="Remover foto">✕</button>` : ''}</figure>`)}
        ${it.can_answer ? html`<label class="add-thumb">${fileInput({ camera: true, data: `data-photo-item="${it.id}"` })}${icon('camera')}Foto</label>` : ''}</div>` : ''}
      ${it.can_answer && (it.result === 'nao_conforme' || it.note) ? html`<input type="text" class="cl-note" data-note-item="${it.id}" maxlength="1000" value="${it.note || ''}"
          placeholder="${it.result === 'nao_conforme' ? 'Descreva o problema encontrado' : 'Observação'}" aria-label="Observação do item ${it.seq}">`
        : it.note ? html`<div class="cl-note-text">${it.note}</div>` : ''}
    </div>`;
  };
  const chip = (k, label, n) => html`<button type="button" class="chip" data-clf="${k}" aria-pressed="${f === k}">${label}${n !== undefined ? html`<span class="n">${n}</span>` : ''}</button>`;
  const execHere = can.submit;
  return html`<section class="card block block-exec" id="checklist" aria-labelledby="blk-cl">
    <header class="block-head"><span class="step">2</span><h2 id="blk-cl">Check-list</h2>
      <span class="right muted" style="font-size:12px">${s.done} de ${s.total} respondidos</span></header>
    <div class="block-body">
      ${reviewBox}
      <div>${progress(s.pct, 'Itens respondidos')}</div>
      <div class="cl-summary">
        <span class="cl-sum ok"><b>${s.conforme}</b> conforme</span><span class="cl-sum nc"><b>${s.nao_conforme}</b> não conforme</span>
        <span class="cl-sum na"><b>${s.na}</b> N/A</span><span class="cl-sum pend"><b>${s.total - s.done}</b> pendente(s)</span>
        <span class="pill ${c.photo_rule === 'obrigatoria' ? 'pill-orange' : 'pill-sand'}">${icon('camera')} ${PHOTO_RULE[c.photo_rule]}</span>
      </div>
      <div class="chips cl-filters" role="group" aria-label="Filtrar itens">
        ${chip('all', 'Todos', s.total)}${chip('mine', 'Meus itens', s.mine_pending ? `${s.mine_pending} pend.` : undefined)}
        ${chip('pending', 'Pendentes', s.total - s.done)}${chip('nc', 'Não conformes', s.nao_conforme)}
      </div>
      <div class="cl-list" data-filter="${f}">
        ${groups.map(g => {
          const done = g.items.filter(i => i.result).length;
          return html`<section class="cl-group">
            <header class="cl-group-head"><h3>${g.name || 'Itens'}</h3><span class="muted">${done}/${g.items.length}</span>
              ${c.can_manage_items && g.items.length > 1 ? html`<select class="cl-assign-group" data-items="${g.items.map(i => i.id).join(',')}" aria-label="Atribuir o grupo ${g.name || ''}">
                <option value="__">Atribuir grupo a…</option>${assigneeOptions(users, '__none', t.assignee_name)}</select>` : ''}</header>
            ${g.items.map(itemRow)}
            <div class="cl-none muted">Nenhum item neste filtro.</div>
          </section>`;
        })}
      </div>
      ${c.can_manage_items ? html`<div class="field cl-add"><label for="cl-new">Adicionar itens</label>
        <input id="cl-new" type="text" maxlength="400" placeholder="Novo item · Enter para adicionar · # Grupo · @Nome" autocomplete="off">${composerHint}</div>` : ''}
      ${execHere ? html`<div class="submit-bar">
        <ul class="proof-check">${c.check.ok ? html`<li class="ok">✓ Todos os itens respondidos${c.photo_rule === 'obrigatoria' ? ' e com foto' : ''}</li>`
          : c.check.missing.map(m => html`<li class="no">○ Falta: ${m}</li>`)}</ul>
        <button type="button" class="btn btn-success btn-block ${c.check.ok ? 'hide-mobile' : ''}" data-act="submit" ${c.check.ok ? '' : 'disabled'}>${icon('send')}Enviar check-list para conferência</button>
      </div>` : ''}
      ${reviewActions}
    </div>
  </section>`;
}

export function bindChecklist(root, t, ctx, refresh) {
  const c = t.checklist;
  const list = root.querySelector('.cl-list');
  if (!list) return;
  const run = async (fn, okMsg) => {
    try { const updated = await fn(); if (okMsg) toast(okMsg); if (updated) refresh(updated); }
    catch (e) { toast(e.message, 'err'); }
  };
  // Próximo item pendente que este usuário pode responder, dentro do filtro em uso
  const nextAfter = id => {
    const f = list.dataset.filter;
    const inFilter = x => f === 'mine' ? x.mine : f === 'nc' ? x.result === 'nao_conforme' : true;
    const items = c.items;
    const i = items.findIndex(x => x.id === id);
    const nxt = [...items.slice(i + 1), ...items.slice(0, i)].find(x => !x.result && x.can_answer && inFilter(x));
    return nxt ? nxt.id : id;
  };
  const answer = (itemId, body, msg) => run(async () => {
    const updated = await api(`/tasks/${t.id}/items/${itemId}/answer`, { method: 'POST', body });
    if ('result' in body) scrollTo = nextAfter(itemId);
    return updated;
  }, msg);

  root.querySelectorAll('.cl-filters [data-clf]').forEach(b => b.addEventListener('click', () => {
    filterByTask[t.id] = b.dataset.clf;
    list.dataset.filter = b.dataset.clf;
    root.querySelectorAll('.cl-filters [data-clf]').forEach(x => x.setAttribute('aria-pressed', String(x === b)));
  }));
  root.querySelectorAll('button[data-answer]').forEach(b => b.addEventListener('click', () => {
    const it = c.items.find(x => x.id === Number(b.dataset.item));
    if (it.result === b.dataset.answer) return;
    answer(it.id, { result: b.dataset.answer });
  }));
  // Resposta com foto (câmera) e foto avulsa do item
  root.querySelectorAll('input[type=file][data-answer], input[type=file][data-photo-item]').forEach(inp => inp.addEventListener('change', async () => {
    const files = [...(inp.files || [])];
    inp.value = '';
    if (!files.length) return;
    const itemId = Number(inp.dataset.item || inp.dataset.photoItem);
    try {
      toast('Enviando foto…', 'warn');
      const imgs = (await readAttachments(files)).filter(x => !x.pdf).map(x => ({ data: x.data }));
      answer(itemId, inp.dataset.answer ? { result: inp.dataset.answer, images: imgs } : { images: imgs }, inp.dataset.answer ? null : 'Foto anexada.');
    } catch (e) { toast(e.message, 'err'); }
  }));
  root.querySelectorAll('[data-note-item]').forEach(inp => inp.addEventListener('change', () => answer(Number(inp.dataset.noteItem), { note: inp.value }, 'Observação salva.')));
  root.querySelectorAll('[data-rm-photo]').forEach(b => b.addEventListener('click', async e => {
    e.stopPropagation();
    if (!(await confirmSheet('Remover foto', 'A remoção ficará registrada no histórico.', 'Remover', true))) return;
    run(() => api(`/tasks/${t.id}/items/${b.dataset.item}/files/${b.dataset.rmPhoto}`, { method: 'DELETE' }), 'Foto removida.');
  }));
  root.querySelectorAll('.cl-thumbs .thumb[data-src]').forEach(fg => fg.addEventListener('click', e => {
    if (e.target.closest('[data-rm-photo]')) return;
    lightbox(fg.dataset.src, fg.dataset.caption);
  }));
  // Manutenção dos itens
  root.querySelectorAll('.cl-assign').forEach(sel => sel.addEventListener('change', () =>
    run(() => api(`/tasks/${t.id}/items/${sel.dataset.item}`, { method: 'PATCH', body: { assignee_id: sel.value || null } }), 'Responsável do item alterado.')));
  root.querySelectorAll('.cl-assign-group').forEach(sel => sel.addEventListener('change', () => {
    if (sel.value === '__') return;
    run(() => api(`/tasks/${t.id}/items/assign`, { method: 'POST', body: { item_ids: sel.dataset.items.split(',').map(Number), assignee_id: sel.value || null } }), 'Grupo atribuído.');
  }));
  root.querySelectorAll('[data-del-item]').forEach(b => b.addEventListener('click', async () => {
    if (!(await confirmSheet('Excluir item', 'O item será removido do check-list (fica registrado no histórico).', 'Excluir', true))) return;
    run(() => api(`/tasks/${t.id}/items/${b.dataset.delItem}`, { method: 'DELETE' }), 'Item excluído.');
  }));
  const composer = root.querySelector('#cl-new');
  if (composer) {
    const lastGroup = c.items.at(-1)?.group || null;
    const state = { group: lastGroup, groupAssignee: null };
    bindComposer(composer, {
      users: () => t._team || [], state,
      onAdd: items => items.length && run(async () => {
        const updated = await api(`/tasks/${t.id}/items`, { method: 'POST', body: { items } });
        scrollTo = 'cl-new';
        return updated;
      }, `${items.length} item(ns) adicionado(s).`),
    });
  }
  // Depois de responder, leva ao próximo item pendente
  if (scrollTo) {
    const el = scrollTo === 'cl-new' ? root.querySelector('#cl-new') : root.querySelector(`#cli-${scrollTo}`);
    scrollTo = null;
    if (el) setTimeout(() => { el.scrollIntoView({ block: 'center', behavior: 'smooth' }); if (el.id === 'cl-new') el.focus({ preventScroll: true }); }, 30);
  }
}
