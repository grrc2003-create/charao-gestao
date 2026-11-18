// Aviso de conclusão: campo "Avisar alguém" nas janelas de concluir/entregar a tarefa
import { html, api, icon } from '../core.js';

// Pessoas que podem ser avisadas (as ligadas à tarefa primeiro); falha de rede não impede concluir
export const loadNotifyOptions = taskId => api(`/tasks/${taskId}/notify-options`).catch(() => []);

export function notifyField(options = []) {
  if (!options.length) return '';
  const sorted = [...options].sort((a, b) => (b.involved - a.involved) || a.name.localeCompare(b.name, 'pt-BR'));
  const person = u => html`<label class="nt-person" data-nt-name="${u.name.toLowerCase()}"><input type="checkbox" name="nt_person" value="${u.id}"><span>${u.name}${u.job_title ? html`<small>${u.job_title}</small>` : ''}</span></label>`;
  return html`<fieldset class="fieldset form nt-fs" data-notify>
    <legend>${icon('bell')}Avisar alguém <span class="muted">(opcional)</span></legend>
    <span class="hint" style="margin-top:0">O aviso fica fixo no topo da tela da pessoa até ela marcar <b>Ciente</b>.</span>
    ${sorted.length > 8 ? html`<input type="search" class="nt-search" placeholder="Buscar pessoa…" aria-label="Buscar pessoa para avisar">` : ''}
    <div class="nt-list">${sorted.map(person)}</div>
    <div class="nt-opts" hidden>
      <div class="segmented seg-2 nt-kind" role="radiogroup" aria-label="Tipo do aviso">
        <label><input type="radio" name="nt_kind" value="concluida" checked>Concluí a tarefa<small>Tudo certo</small></label>
        <label><input type="radio" name="nt_kind" value="ressalvas">Concluí com ressalvas<small>Com pontos de atenção</small></label>
      </div>
      <div class="field nt-note" hidden><label class="req" for="nt-note">Ressalvas</label>
        <textarea id="nt-note" name="nt_note" rows="3" maxlength="1000" placeholder="O que ficou pendente ou precisa de atenção"></textarea></div>
    </div>
  </fieldset>`;
}

// Liga busca, tipo e ressalvas (chamar logo depois de abrir a janela)
export function bindNotifyField() {
  setTimeout(() => {
    const fs = document.querySelector('[data-notify]');
    if (!fs) return;
    const opts = fs.querySelector('.nt-opts');
    const note = fs.querySelector('.nt-note');
    const sync = () => {
      opts.hidden = !fs.querySelector('[name=nt_person]:checked');
      const res = fs.querySelector('[name=nt_kind]:checked')?.value === 'ressalvas';
      note.hidden = !res;
      note.querySelector('textarea').required = res && !opts.hidden;
    };
    fs.addEventListener('change', sync);
    fs.querySelector('.nt-search')?.addEventListener('input', e => {
      const q = e.target.value.trim().toLowerCase();
      fs.querySelectorAll('.nt-person').forEach(l => { l.hidden = !!q && !l.dataset.ntName.includes(q) && !l.querySelector('input').checked; });
    });
    sync();
  }, 0);
}

// Junta o aviso aos dados enviados (e tira os campos internos)
export function withNotify(data, form) {
  delete data.nt_person; delete data.nt_kind; delete data.nt_note;
  const fs = form?.querySelector('[data-notify]');
  if (!fs) return data;
  const ids = [...fs.querySelectorAll('[name=nt_person]:checked')].map(c => Number(c.value));
  if (!ids.length) return data;
  const kind = fs.querySelector('[name=nt_kind]:checked')?.value || 'concluida';
  return { ...data, notify_ids: ids, notify_kind: kind, notify_note: kind === 'ressalvas' ? fs.querySelector('[name=nt_note]').value : '' };
}

// ---------- Alertas configurados na tarefa (nenhum marcado por padrão) ----------
const WATCH_EVENTS = [
  ['status', 'Mudanças de status', 'Iniciou, enviou para conferência, concluída, devolvida, reaberta ou cancelada'],
  ['prazo', 'Prazo', 'Dias antes do prazo e quando a tarefa atrasar'],
  ['avanco', 'Avanço e execução', 'Avanço (%), descrição e fotos da execução'],
  ['alteracao', 'Alterações na tarefa', 'Reagendamento, troca de responsável, prazo e prioridade'],
];

// options: [{ id, name, job_title, involved, self }] · current: { events, due_days, users: [{ id }] }
export function watchField(options = [], current = null, { legend = true } = {}) {
  const ev = new Set(current?.events || []);
  const sel = new Set((current?.users || []).map(u => u.id));
  const sorted = [...options].sort((a, b) => (b.self - a.self) || (b.involved - a.involved) || a.name.localeCompare(b.name, 'pt-BR'));
  return html`<fieldset class="fieldset form wt-fs" data-watch>
    ${legend ? html`<legend>${icon('bell')}Alertas desta tarefa <span class="muted">(opcional)</span></legend>` : ''}
    <span class="hint" style="margin-top:0">Nenhum alerta vem marcado. Escolha os eventos e quem recebe: o <b>Charão</b> avisa no canto da tela.</span>
    <div class="wt-events">${WATCH_EVENTS.map(([k, label, desc]) => html`<label class="nt-person"><input type="checkbox" name="wt_event" value="${k}" ${ev.has(k) ? 'checked' : ''}><span>${label}<small>${desc}</small></span></label>
      ${k === 'prazo' ? html`<div class="wt-days" ${ev.has('prazo') ? '' : 'hidden'}><label for="wt-days">Avisar</label><input id="wt-days" type="number" name="wt_days" min="0" max="60" step="1" inputmode="numeric" value="${current?.due_days ?? 2}"><span>dia(s) antes do prazo (0 = no dia)</span></div>` : ''}`)}</div>
    <div class="wt-who" ${ev.size ? '' : 'hidden'}>
      <b class="wt-sub">Quem recebe</b>
      ${sorted.length > 8 ? html`<input type="search" class="nt-search" placeholder="Buscar pessoa…" aria-label="Buscar pessoa para receber os alertas">` : ''}
      <div class="nt-list">${sorted.map(u => html`<label class="nt-person" data-nt-name="${u.name.toLowerCase()}"><input type="checkbox" name="wt_user" value="${u.id}" ${sel.has(u.id) ? 'checked' : ''}><span>${u.self ? html`Eu <small>${u.name}</small>` : html`${u.name}${u.job_title ? html`<small>${u.job_title}</small>` : ''}`}</span></label>`)}</div>
    </div>
  </fieldset>`;
}

export function bindWatchField(root = document) {
  const fs = root.querySelector('[data-watch]');
  if (!fs) return;
  const sync = () => {
    const any = !!fs.querySelector('[name=wt_event]:checked');
    fs.querySelector('.wt-who').hidden = !any;
    fs.querySelector('.wt-days').hidden = !fs.querySelector('[name=wt_event][value=prazo]').checked;
  };
  fs.addEventListener('change', sync);
  fs.querySelector('.nt-search')?.addEventListener('input', e => {
    const q = e.target.value.trim().toLowerCase();
    fs.querySelectorAll('.wt-who .nt-person').forEach(l => { l.hidden = !!q && !l.dataset.ntName.includes(q) && !l.querySelector('input').checked; });
  });
  sync();
}

// Lê a configuração do bloco (e tira os campos internos dos dados do formulário, se passados)
export function readWatchField(root, data = null) {
  if (data) { delete data.wt_event; delete data.wt_user; delete data.wt_days; }
  const fs = root?.querySelector('[data-watch]');
  if (!fs) return null;
  const events = [...fs.querySelectorAll('[name=wt_event]:checked')].map(c => c.value);
  const user_ids = events.length ? [...fs.querySelectorAll('[name=wt_user]:checked')].map(c => Number(c.value)) : [];
  if (events.length && !user_ids.length) throw new Error('Alertas da tarefa: escolha quem recebe.');
  return { events: user_ids.length ? events : [], due_days: events.includes('prazo') ? Number(fs.querySelector('[name=wt_days]').value || 0) : null, user_ids };
}
