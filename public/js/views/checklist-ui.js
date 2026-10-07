// Check-list: cadastro rápido dos itens (Enter, colar lista, "# Grupo", "@Nome") e preenchimento item a item
// numa tela só (Conforme / Não conforme / N/A, observação e fotos), com avanço automático para o próximo item.
import { html, raw, api, icon, fmtDateTime } from '../core.js';
import { toast, sheet, confirmSheet, readAttachments, fileInput, lightbox } from '../ui.js';

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

function itemCard(t, it, c) {
  const needPhoto = c.photo_rule === 'obrigatoria' && !it.files.length;
  const state = it.result
    ? html`<span class="cli-state st-${it.result}">${RESULT[it.result].short} ${RESULT[it.result].label}</span>`
    : html`<span class="cli-state st-pending">Pendente</span>`;
  const menu = c.can_manage_items ? html`<button type="button" class="cli-menu" data-edit-item="${it.id}" aria-label="Editar item ${it.seq}">${icon('more')}</button>` : '';
  const head = html`<div class="cli-top"><span class="cli-num">${it.seq}</span><span class="cli-title">${it.text}</span>${menu}</div>
    <div class="cli-meta">
      ${state}
      <span class="who-chip ${it.mine ? 'is-mine' : ''}"><i>${initials(it.responsible_name)}</i>${it.responsible_name}${it.assignee_id ? '' : ' · global'}</span>
      ${it.mine && !it.result ? html`<span class="mine-chip">seu item</span>` : ''}
      ${it.result ? html`<span class="cli-when">${icon('check')}${it.answered_by_name || '—'} · ${shortDate(it.answered_at)}</span>` : ''}
      ${it.files.length ? html`<span class="cli-when">${icon('camera')}${it.files.length}</span>` : ''}
    </div>`;
  const ansBtn = r => {
    const on = it.result === r;
    const inner = html`<span class="ans-ic">${RESULT[r].short}</span><span class="ans-lb">${RESULT[r].label}</span>`;
    // Foto obrigatória e o item ainda sem foto: o botão abre a câmera e grava a resposta junto com a foto
    return needPhoto && r !== 'na' && !on
      ? html`<label class="ans ans-${RESULT[r].cls}">${fileInput({ camera: true, data: `data-answer="${r}" data-item="${it.id}"` })}${inner}<span class="ans-cam">${icon('camera')}</span></label>`
      : html`<button type="button" class="ans ans-${RESULT[r].cls} ${on ? 'is-on' : ''}" data-answer="${r}" data-item="${it.id}" aria-pressed="${on}">${inner}</button>`;
  };
  const body = html`
    ${it.can_answer ? html`<div class="cli-answer" role="group" aria-label="Resposta do item ${it.seq}">${ansBtn('conforme')}${ansBtn('nao_conforme')}${ansBtn('na')}</div>
      ${needPhoto && !it.result ? html`<div class="cli-hint">${icon('camera')} Foto obrigatória: ao tocar em Conforme ou Não conforme a câmera abre.</div>` : ''}`
      : !it.result ? html`<div class="cli-hint">Aguardando ${it.responsible_name}.</div>` : ''}
    ${it.files.length || (it.can_answer && it.result) ? html`<div class="cli-photos">
      ${it.files.map(fl => html`<figure class="cli-ph" data-src="/api/checklist-files/${fl.id}" data-caption="Item ${it.seq} · ${it.text}">
        <img src="/api/checklist-files/${fl.id}" alt="Foto do item ${it.seq}" loading="lazy">
        ${it.can_answer ? html`<button type="button" class="rm" data-rm-photo="${fl.id}" data-item="${it.id}" aria-label="Remover foto">✕</button>` : ''}</figure>`)}
      ${it.can_answer ? html`<label class="cli-ph-add">${fileInput({ camera: true, data: `data-photo-item="${it.id}"` })}${icon('camera')}<span>Foto</span></label>` : ''}</div>` : ''}
    ${it.can_answer && (it.result === 'nao_conforme' || it.note) ? html`<label class="cli-note"><span>${it.result === 'nao_conforme' ? 'O que está errado?' : 'Observação'}</span>
        <input type="text" data-note-item="${it.id}" maxlength="1000" value="${it.note || ''}" placeholder="${it.result === 'nao_conforme' ? 'Descreva o problema encontrado' : 'Observação'}"></label>`
      : it.note ? html`<div class="cli-note-text"><b>${it.result === 'nao_conforme' ? 'Problema:' : 'Obs.:'}</b> ${it.note}</div>` : ''}`;
  const attrs = `id="cli-${it.id}" data-pending="${it.result ? 0 : 1}" data-mine="${it.mine ? 1 : 0}" data-nc="${it.result === 'nao_conforme' ? 1 : 0}"`;
  const cls = `cli ${it.result ? `res-${it.result}` : 'res-pending'} ${it.mine ? 'is-mine' : ''}`;
  // Respondidos (exceto não conforme) ficam recolhidos numa linha; toque para ver/alterar
  return it.result && it.result !== 'nao_conforme'
    ? html`<details class="${cls}" ${raw(attrs)}><summary>${head}<span class="cli-more">ver detalhes</span></summary><div class="cli-body">${body}</div></details>`
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
      <span class="right muted" style="font-size:12px">${s.done} de ${s.total} respondidos</span></header>
    <div class="block-body">
      ${reviewBox}
      <div class="cl-overview">
        <div class="cl-ring" style="--p:${s.pct}"><b>${s.pct}%</b><span>respondido</span></div>
        <div class="cl-counts">
          <span class="cnt ok"><b>${s.conforme}</b>Conforme</span><span class="cnt nc"><b>${s.nao_conforme}</b>Não conforme</span>
          <span class="cnt na"><b>${s.na}</b>N/A</span><span class="cnt pend"><b>${s.total - s.done}</b>Pendente</span>
        </div>
      </div>
      <div class="cl-rule ${c.photo_rule === 'obrigatoria' ? 'is-req' : ''}">${icon('camera')} ${PHOTO_RULE[c.photo_rule]}</div>
      <div class="cl-toolbar">
        <div class="chips cl-filters" role="group" aria-label="Filtrar itens">
          ${chip('all', 'Todos', s.total)}${s.mine_pending || c.items.some(i => i.mine) ? chip('mine', 'Meus itens', s.mine_pending ? `${s.mine_pending} pend.` : undefined) : ''}
          ${chip('pending', 'Pendentes', s.total - s.done)}${s.nao_conforme ? chip('nc', 'Não conformes', s.nao_conforme) : ''}
        </div>
        ${c.can_manage_items ? html`<button type="button" class="btn btn-ghost btn-sm" id="cl-add-toggle" aria-expanded="${st.adding}">${icon('plus')}Adicionar itens</button>` : ''}
      </div>
      ${c.can_manage_items ? html`<div class="cl-add-panel" id="cl-add-panel" ${st.adding ? '' : 'hidden'}>
        <label for="cl-new" class="label">Novo item <span class="muted" id="cl-add-group">${st.group ? `· grupo ${st.group}` : ''}</span></label>
        <input id="cl-new" type="text" maxlength="400" placeholder="Digite o item e tecle Enter · # Grupo · @Nome" autocomplete="off">
        ${composerHint}
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
  root.querySelectorAll('.cli-ph[data-src]').forEach(fg => fg.addEventListener('click', e => {
    if (e.target.closest('[data-rm-photo]')) return;
    lightbox(fg.dataset.src, fg.dataset.caption);
  }));

  // ---------- Itens: incluir, editar, atribuir, excluir ----------
  const panel = root.querySelector('#cl-add-panel');
  const composer = root.querySelector('#cl-new');
  const openAdd = group => {
    st.adding = true;
    if (group !== undefined) { st.group = group || null; st.groupAssignee = null; }
    panel.hidden = false;
    root.querySelector('#cl-add-toggle')?.setAttribute('aria-expanded', 'true');
    root.querySelector('#cl-add-group').textContent = st.group ? `· grupo ${st.group}` : '';
    composer.focus();
    composer.scrollIntoView({ block: 'center', behavior: 'smooth' });
  };
  root.querySelector('#cl-add-toggle')?.addEventListener('click', () => {
    if (!panel.hidden) { st.adding = false; panel.hidden = true; return; }
    openAdd(st.group === undefined ? c.items.at(-1)?.group || null : undefined);
  });
  root.querySelectorAll('[data-add-group]').forEach(b => b.addEventListener('click', () => openAdd(b.dataset.addGroup)));
  if (composer) {
    if (st.group === undefined) st.group = c.items.at(-1)?.group || null;
    const state = { get group() { return st.group; }, set group(v) { st.group = v; }, get groupAssignee() { return st.groupAssignee ?? null; }, set groupAssignee(v) { st.groupAssignee = v; } };
    bindComposer(composer, {
      users: team, state,
      onAdd: items => items.length && run(async () => {
        const updated = await api(`/tasks/${t.id}/items`, { method: 'POST', body: { items } });
        scrollTo = 'cl-new';
        return updated;
      }, `${items.length} item(ns) adicionado(s).`),
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
        ${!it.result ? html`<button type="button" class="btn btn-danger-ghost btn-sm" data-del-in-sheet>${icon('trash')}Excluir este item</button>`
          : html`<span class="hint">Item já respondido: pode ser editado, mas não excluído.</span>`}`,
      onSubmit: d => api(`/tasks/${t.id}/items/${it.id}`, { method: 'PATCH', body: { text: d.text, group: d.group, assignee_id: d.assignee_id || null } }),
    });
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
    const el = scrollTo === 'cl-new' ? composer : root.querySelector(`#cli-${scrollTo}`);
    scrollTo = null;
    if (el) setTimeout(() => { el.scrollIntoView({ block: 'center', behavior: 'smooth' }); if (el === composer) el.focus({ preventScroll: true }); }, 30);
  }
}
