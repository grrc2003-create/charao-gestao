// Gestão da Equipe: Organograma (árvore por gestor/líder, arrastar para mudar o gestor) e Cadastro da Equipe
// (função e responsabilidades obrigatórias, setor, admissão; pessoas com ou sem acesso ao sistema).
import { html, raw, api, icon, fmtDate, initials, ROLE, avatarUrl } from '../core.js';
import { avatarEditor, bindAvatarEditor } from './avatar-ui.js';
import { deleteButton, bindDeleteButton } from './user-delete.js';
import { toast, sheet, confirmSheet } from '../ui.js';
import { pageHead, kpi, companyOptions, companiesIn } from './shared.js';
import { vacPill } from './vacation-ui.js';

const ROLE_COLOR = { admin: '#C9520F', gestor: '#2A3D50', coordenador: '#1F6FB2', colaborador: '#5B6B7A' };
const roleOf = p => (p.is_external ? 'Terceirizado' : ROLE[p.role] || '');
const colorOf = p => (p.is_external ? '#8E44AD' : ROLE_COLOR[p.role] || '#5B6B7A');
const dm = d => fmtDate(d).slice(0, 5);
const av = p => { const u = avatarUrl(p.id); return u ? html`<img src="${u}" alt="" loading="lazy">` : initials(p.name); };
// Jornada: dias da semana (0=domingo … 6=sábado) e turno
const WD = ['Dom', 'Seg', 'Ter', 'Qua', 'Qui', 'Sex', 'Sáb'];
const WD_ORDER = [1, 2, 3, 4, 5, 6, 0];
const daysText = days => {
  if (!days?.length) return 'calendário da empresa';
  const set = new Set(days);
  if ([1, 2, 3, 4, 5].every(d => set.has(d)) && set.size === 5) return 'Seg a Sex';
  if ([1, 2, 3, 4, 5, 6].every(d => set.has(d)) && set.size === 6) return 'Seg a Sáb';
  return WD_ORDER.filter(d => set.has(d)).map(d => WD[d]).join(', ');
};
const workText = p => [daysText(p.work_days), p.work_shift].filter(Boolean).join(' · ');
const sec = (state, k) => !state.meta.can.sections || state.meta.can.sections.includes(k);

// ---------- Árvore ----------
function buildTree(people, { externals = true } = {}) {
  const kids = new Map();
  for (const p of people) {
    const k = p.manager_id || 0;
    if (!kids.has(k)) kids.set(k, []);
    kids.get(k).push(p);
  }
  const order = (a, b) => (a.is_external - b.is_external) || (['admin', 'gestor', 'coordenador', 'colaborador'].indexOf(a.role) - ['admin', 'gestor', 'coordenador', 'colaborador'].indexOf(b.role)) || a.name.localeCompare(b.name, 'pt-BR');
  for (const l of kids.values()) l.sort(order);
  const childrenOf = id => (kids.get(id) || []).filter(p => externals || !p.is_external);
  return { roots: childrenOf(0), childrenOf };
}

// ---------- Empresa de cada pessoa no organograma ----------
// Cor fixa por empresa (ordem do cadastro); destaque só quando há pessoas de mais de uma empresa
const CO_COLORS = ['#2A3D50', '#B03A2E', '#1F7A4A', '#6C4AB6', '#B7791F', '#0E7490', '#9D174D', '#4D7C0F', '#5D6670'];
// Nome curto na etiqueta do cartão: as duas primeiras palavras (o nome completo fica na dica)
const shortName = n => String(n).split(/\s+/).filter(w => !/^[&\-–]$/.test(w)).slice(0, 2).join(' ');
export function withCompanies(people, meta) {
  const cos = meta?.companies || [];
  const color = new Map(cos.map((c, i) => [c.id, CO_COLORS[i % CO_COLORS.length]]));
  const used = new Map();
  for (const p of people) {
    const c = cos.find(x => x.id === p.company_id);
    p.co = c ? { id: c.id, name: c.name, short: shortName(c.name), color: color.get(c.id) } : { id: 0, name: 'Empresa não informada', short: 'Sem empresa', color: '#9AA5B1' };
    used.set(p.co.id, { ...p.co, n: (used.get(p.co.id)?.n || 0) + 1 });
  }
  const list = [...used.values()].sort((a, b) => (a.id === 0) - (b.id === 0) || cos.findIndex(c => c.id === a.id) - cos.findIndex(c => c.id === b.id));
  const show = list.length > 1;
  for (const p of people) p.co.show = show;
  return { list, show };
}
export const companyLegend = cos => html`<div class="org-legend org-co-legend" aria-label="Empresas">${cos.map(c => html`<span><i class="co" style="--cc:${c.color}"></i>${c.name} <b>${c.n}</b></span>`)}</div>`;

function card(p, { childCount = 0, collapsed = false, print = false } = {}) {
  const v = p.vacation;
  const l = p.load;
  const co = p.co?.show ? p.co : null;
  return html`<div class="org-card ${p.is_external ? 'is-ext' : ''} ${p.missing_function ? 'is-missing' : ''}" data-pid="${p.id}" data-co="${co ? co.id : ''}" ${print ? '' : html`draggable="true" tabindex="0" role="button" aria-label="${p.name}${co ? ` · ${co.name}` : ''}"`} style="--c:${colorOf(p)}">
    <div class="org-top"><span class="org-av">${av(p)}</span><div class="org-who"><b>${p.name}</b><small>${roleOf(p)}${p.department ? ` · ${p.department}` : ''}</small></div></div>
    <div class="org-fn ${p.missing_function ? 'warn' : ''}">${p.missing_function ? '⚠ Função não detalhada' : p.job_title}</div>

    <div class="org-tags">
      ${!p.login_enabled ? html`<span class="org-tag">Sem acesso</span>` : ''}
      ${v ? html`<span class="org-tag ${v.now ? 'is-vac' : 'is-vac-soon'}">${v.now ? `De férias até ${dm(v.end_date)}` : `Férias ${dm(v.start_date)}`}</span>` : ''}
    </div>
    <div class="org-load" title="Tarefas em aberto · atrasadas · em conferência"><span>${l.open} em aberto</span>${l.late ? html`<span class="late">${l.late} atrasada(s)</span>` : ''}${l.review ? html`<span>${l.review} conf.</span>` : ''}</div>
    ${childCount && !print ? html`<button type="button" class="org-toggle" data-toggle="${p.id}" aria-expanded="${!collapsed}">${collapsed ? '+' : '−'} ${childCount}</button>` : ''}
  </div>`;
}

// Cartão da equipe da Folha de Campo ligada ao líder: quantas pessoas por função
const fieldTotal = p => (p.field_team || []).reduce((n, r) => n + r.n, 0);
const fieldCard = p => html`<li><div class="org-card org-field" style="--c:#B7791F" title="Profissionais da Folha de Campo com ${p.name} como líder">
    <div class="org-top"><span class="org-av">${icon('team')}</span><div class="org-who"><b>Equipe de campo</b><small>${fieldTotal(p)} pessoa(s) · líder ${p.name.split(' ')[0]}</small></div></div>
    <ul class="org-fl">${p.field_team.map(r => html`<li><span>${r.role}</span><b>${r.n}</b></li>`)}</ul>
  </div></li>`;

export function treeHtml(people, { collapsed = new Set(), externals = true, field = true, print = false, rootId = null } = {}) {
  const t = buildTree(people, { externals });
  // Empresa: onde a empresa muda na hierarquia abre-se um bloco tracejado na cor dela, envolvendo a pessoa e a equipe abaixo
  const node = (p, parentCo) => {
    const ch = t.childrenOf(p.id);
    const fc = field && fieldTotal(p) > 0;
    const n = ch.length + (fc ? 1 : 0);
    const closed = collapsed.has(p.id);
    const co = p.co?.show ? p.co : null;
    const here = co ? co.id : parentCo;
    const inner = html`${card(p, { childCount: n, collapsed: closed, print })}${n && !closed ? html`<ul>${fc ? fieldCard(p) : ''}${ch.map(c => node(c, here))}</ul>` : ''}`;
    return html`<li>${co && co.id !== parentCo
      ? html`<div class="org-coblk" data-coblk="${co.id}" style="--cc:${co.color}"><span class="org-coblk-h" title="${co.name}">${co.name}</span>${inner}</div>`
      : inner}</li>`;
  };
  const roots = rootId ? people.filter(p => p.id === rootId) : t.roots;
  return html`<ul class="org-tree">${roots.map(r => node(r, undefined))}</ul>`;
}

function detailBody(p, data, state) {
  const mgr = data.people.find(x => x.id === p.manager_id);
  const direct = data.people.filter(x => x.manager_id === p.id);
  const options = data.people.filter(x => x.id !== p.id && !x.is_external);
  return html`<div class="org-detail">
    <div class="org-top"><span class="org-av" style="--c:${colorOf(p)}">${av(p)}</span><div class="org-who"><b>${p.name}</b><small>${roleOf(p)}${p.department ? ` · ${p.department}` : ''}</small></div></div>
    <dl class="kv">
      <dt>Função</dt><dd>${p.job_title || html`<span class="late">não informada</span>`}</dd>
      <dt>${p.is_external ? 'Líder' : 'Gestor'}</dt><dd>${mgr ? mgr.name : 'sem gestor (topo)'}</dd>
      ${p.admission_date ? html`<dt>Admissão</dt><dd>${fmtDate(p.admission_date)}</dd>` : ''}
      ${p.employment ? html`<dt>Vínculo</dt><dd>${{ clt: 'CLT', pj: 'PJ', estagio: 'Estagiário' }[p.employment]}</dd>` : ''}
      <dt>Jornada</dt><dd>${workText(p)}</dd>
      ${p.email ? html`<dt>E-mail</dt><dd>${p.email}</dd>` : ''}${p.phone ? html`<dt>Telefone</dt><dd>${p.phone}</dd>` : ''}
      <dt>Tarefas</dt><dd>${p.load.open} em aberto · ${p.load.late} atrasada(s) · ${p.load.review} em conferência</dd>
      ${p.vacation ? html`<dt>Férias</dt><dd>${fmtDate(p.vacation.start_date)} a ${fmtDate(p.vacation.end_date)}${p.vacation.now ? ' (agora)' : ''}</dd>` : ''}
    </dl>
    <div class="sub-label" style="margin-top:12px">Responsabilidades</div>
    <div class="text-content org-resp">${p.responsibilities || html`<span class="late">Responsabilidades não detalhadas. Complete no Cadastro da Equipe.</span>`}</div>
    ${direct.length ? html`<div class="sub-label" style="margin-top:12px">Equipe direta (${direct.length})</div><div class="org-chips">${direct.map(x => html`<span class="pill pill-sand">${x.name}</span>`)}</div>` : ''}
    ${fieldTotal(p) ? html`<div class="sub-label" style="margin-top:12px">Equipe de campo (${fieldTotal(p)})</div><div class="org-chips">${p.field_team.map(r => html`<span class="pill pill-sand">${r.n} ${r.role}</span>`)}</div>` : ''}
    <div class="field" style="margin-top:12px"><label for="od-mgr">${p.is_external ? 'Mudar líder' : 'Mudar gestor'}</label>
      <select id="od-mgr" name="manager_id">${p.is_external ? '' : html`<option value="">Sem gestor (topo)</option>`}${options.map(x => html`<option value="${x.id}" ${x.id === p.manager_id ? 'selected' : ''}>${x.name}${x.job_title ? ` · ${x.job_title}` : ''}</option>`)}</select></div>
    <div class="rg-task-acts">
      <a class="btn btn-ghost btn-sm" href="#/equipe/cadastro/${p.id}">${icon('edit')}Cadastro da equipe</a>
      ${p.login_enabled && (sec(state, 'usuarios') || sec(state, 'cadastro_usuarios')) ? html`<a class="btn btn-ghost btn-sm" href="#/usuarios/${p.id}">${icon('dashboard')}Desempenho</a>` : ''}
      ${data.can_edit_users ? html`<a class="btn btn-ghost btn-sm" href="#/usuarios/${p.id}/editar">${icon('user')}Acesso e permissões</a>` : ''}
    </div></div>`;
}

const KEY = 'charao-org-collapsed';
export async function org({ state, render }) {
  const data = await api('/team/org');
  const cos = withCompanies(data.people, state.meta);
  let coHi = '';
  try { coHi = sessionStorage.getItem(`${KEY}-co`) || ''; } catch { /* sem armazenamento */ }
  if (!cos.list.some(c => String(c.id) === coHi)) coHi = '';
  let collapsed = new Set();
  try { collapsed = new Set(JSON.parse(sessionStorage.getItem(KEY) || '[]')); } catch { /* sem armazenamento */ }
  let externals = true;
  try { externals = sessionStorage.getItem(`${KEY}-ext`) !== '0'; } catch { /* sem armazenamento */ }
  let field = true;
  try { field = sessionStorage.getItem(`${KEY}-field`) !== '0'; } catch { /* sem armazenamento */ }
  const s = data.summary;
  return {
    title: 'Organograma',
    html: html`
      ${pageHead({
        eyebrow: 'Gestão da Equipe', title: 'Organograma',
        sub: `${s.internal} pessoa(s) na equipe${s.external ? ` · ${s.external} terceirizado(s)` : ''}${s.field ? ` · ${s.field} na equipe de campo` : ''}${s.on_vacation ? ` · ${s.on_vacation} de férias` : ''}`,
        actions: html`<a class="btn btn-ghost" href="#/imprimir/organograma">${icon('print')}Imprimir / PDF</a><a class="btn btn-primary" href="#/equipe/cadastro/novo">${icon('plus')}Nova pessoa</a>`,
      })}
      ${s.missing_function ? html`<div class="notice section" style="margin-top:0">${icon('alert')}<span><b>${s.missing_function}</b> pessoa(s) sem função ou responsabilidades detalhadas (cartões com aviso). <a href="#/equipe/cadastro?f=pendentes">Completar no Cadastro da Equipe</a>.</span></div>` : ''}
      <div class="org-bar">
        <input type="search" id="org-q" placeholder="Buscar pessoa…" aria-label="Buscar pessoa no organograma">
        <label class="switch"><input type="checkbox" id="org-ext" ${externals ? 'checked' : ''}>Terceirizados</label>
        ${cos.show ? html`<select id="org-co" aria-label="Destacar empresa"><option value="">Todas as empresas</option>${cos.list.map(c => html`<option value="${c.id}" ${String(c.id) === coHi ? 'selected' : ''}>Destacar: ${c.name}</option>`)}</select>` : ''}
        ${s.field ? html`<label class="switch"><input type="checkbox" id="org-field" ${field ? 'checked' : ''}>Equipe de campo</label>` : ''}
        <div class="org-zoom only-desktop"><button type="button" class="btn btn-ghost btn-sm" data-z="-1" aria-label="Diminuir">−</button><span id="org-zl">100%</span>
          <button type="button" class="btn btn-ghost btn-sm" data-z="1" aria-label="Aumentar">+</button><button type="button" class="btn btn-ghost btn-sm" data-z="0">Ajustar</button></div>
        <button type="button" class="btn btn-ghost btn-sm" id="org-expand">Expandir tudo</button>
      </div>
      <p class="hint only-desktop" style="margin:0 0 8px">Arraste um cartão sobre outro para mudar o gestor. Clique no cartão para ver função, responsabilidades e equipe.</p>
      <div class="org-legend">${['admin', 'gestor', 'coordenador', 'colaborador'].map(r => html`<span><i style="--c:${ROLE_COLOR[r]}"></i>${ROLE[r]}</span>`)}<span><i class="is-ext" style="--c:#8E44AD"></i>Terceirizado</span>${s.field ? html`<span><i style="--c:#B7791F"></i>Equipe de campo (Folha de Campo)</span>` : ''}</div>
      ${cos.show ? companyLegend(cos.list) : ''}
      <div class="org-wrap card ${coHi ? 'co-hi' : ''}" data-co-hi="${coHi}"><div class="org-top-drop" data-drop-root>Solte aqui para deixar sem gestor (topo)</div>
        <div class="org" id="org">${treeHtml(data.people, { collapsed, externals, field })}</div></div>`,
    mount(root) {
      const orgEl = root.querySelector('#org');
      let zoom = 1;
      const setZoom = z => { zoom = Math.max(0.4, Math.min(1.4, z)); orgEl.style.setProperty('--z', zoom); root.querySelector('#org-zl').textContent = `${Math.round(zoom * 100)}%`; };
      root.querySelectorAll('[data-z]').forEach(b => b.addEventListener('click', () => {
        const d = Number(b.dataset.z);
        if (d) setZoom(zoom + d * 0.1);
        else { const w = orgEl.querySelector('.org-tree').scrollWidth; setZoom(Math.min(1, (orgEl.parentElement.clientWidth - 24) / w)); }
      }));
      const save = () => { try { sessionStorage.setItem(KEY, JSON.stringify([...collapsed])); sessionStorage.setItem(`${KEY}-ext`, externals ? '1' : '0'); sessionStorage.setItem(`${KEY}-field`, field ? '1' : '0'); } catch { /* sem armazenamento */ } };
      // Destacar uma empresa: as demais ficam apagadas (a hierarquia continua visível)
      const wrapEl = root.querySelector('.org-wrap');
      const paintCo = () => {
        wrapEl.classList.toggle('co-hi', !!coHi);
        orgEl.querySelectorAll('.org-card[data-pid]').forEach(c => c.classList.toggle('is-dim', !!coHi && c.dataset.co !== coHi));
        orgEl.querySelectorAll('.org-coblk').forEach(b => b.classList.toggle('is-hi', !!coHi && b.dataset.coblk === coHi));
        try { sessionStorage.setItem(`${KEY}-co`, coHi); } catch { /* sem armazenamento */ }
      };
      root.querySelector('#org-co')?.addEventListener('change', e => { coHi = e.target.value; paintCo(); });
      const redraw = () => { orgEl.innerHTML = treeHtml(data.people, { collapsed, externals, field }).toString(); save(); bindCards(); paintCo(); };
      root.querySelector('#org-ext').addEventListener('change', e => { externals = e.target.checked; redraw(); });
      root.querySelector('#org-field')?.addEventListener('change', e => { field = e.target.checked; redraw(); });
      root.querySelector('#org-expand').addEventListener('click', () => { collapsed.clear(); redraw(); });
      // Busca: abre o caminho até a pessoa e destaca
      root.querySelector('#org-q').addEventListener('input', e => {
        const q = e.target.value.trim().toLowerCase();
        if (q) {
          const hits = data.people.filter(p => `${p.name} ${p.job_title || ''} ${p.department || ''}`.toLowerCase().includes(q));
          for (const h of hits) { let m = h.manager_id; while (m) { collapsed.delete(m); m = data.people.find(x => x.id === m)?.manager_id; } }
          redraw();
          hits.forEach(h => orgEl.querySelector(`[data-pid="${h.id}"]`)?.classList.add('is-hit'));
          orgEl.querySelector('.is-hit')?.scrollIntoView({ block: 'center', inline: 'center', behavior: 'smooth' });
        } else redraw();
      });
      const move = async (id, managerId) => {
        const p = data.people.find(x => x.id === id);
        const m = data.people.find(x => x.id === managerId);
        if (!p || p.manager_id === (managerId || null) || id === managerId) return;
        if (!(await confirmSheet('Mudar gestor', `${p.name} passará para ${m ? `a equipe de ${m.name}` : 'o topo do organograma (sem gestor)'}. Confirmar?`, 'Confirmar'))) return;
        try { await api(`/team/${id}/manager`, { method: 'PUT', body: { manager_id: managerId || null } }); toast('Organograma atualizado.'); render(); } catch (e) { toast(e.message, 'err'); }
      };
      const open = async id => {
        const p = data.people.find(x => x.id === id);
        const r = await sheet({ title: 'Pessoa', wide: true, body: detailBody(p, data, state), submitLabel: 'Salvar gestor' });
        if (r && Number(r.manager_id || 0) !== (p.manager_id || 0)) {
          try { await api(`/team/${id}/manager`, { method: 'PUT', body: { manager_id: r.manager_id ? Number(r.manager_id) : null } }); toast('Organograma atualizado.'); render(); } catch (e) { toast(e.message, 'err'); }
        }
      };
      function bindCards() {
        orgEl.querySelectorAll('[data-toggle]').forEach(b => b.addEventListener('click', e => {
          e.stopPropagation();
          const id = Number(b.dataset.toggle);
          if (collapsed.has(id)) collapsed.delete(id); else collapsed.add(id);
          redraw();
        }));
        orgEl.querySelectorAll('.org-card[data-pid]').forEach(c => {
          const id = Number(c.dataset.pid);
          c.addEventListener('click', () => open(id));
          c.addEventListener('keydown', e => { if (e.key === 'Enter') open(id); });
          c.addEventListener('dragstart', e => { e.dataTransfer.setData('text/plain', String(id)); c.classList.add('is-drag'); root.querySelector('.org-wrap').classList.add('is-dragging'); });
          c.addEventListener('dragend', () => { c.classList.remove('is-drag'); root.querySelector('.org-wrap').classList.remove('is-dragging'); });
          c.addEventListener('dragover', e => { e.preventDefault(); c.classList.add('is-over'); });
          c.addEventListener('dragleave', () => c.classList.remove('is-over'));
          c.addEventListener('drop', e => { e.preventDefault(); c.classList.remove('is-over'); move(Number(e.dataTransfer.getData('text/plain')), id); });
        });
      }
      const top = root.querySelector('[data-drop-root]');
      top.addEventListener('dragover', e => { e.preventDefault(); top.classList.add('is-over'); });
      top.addEventListener('dragleave', () => top.classList.remove('is-over'));
      top.addEventListener('drop', e => { e.preventDefault(); top.classList.remove('is-over'); move(Number(e.dataTransfer.getData('text/plain')), null); });
      bindCards();
      paintCo();
    },
  };
}

// ---------- Cadastro da Equipe ----------
const FILTERS = [['', 'Todos'], ['pendentes', 'Função não detalhada'], ['sem_acesso', 'Sem acesso ao sistema'], ['terceirizados', 'Terceirizados'], ['sem_admissao', 'Sem data de admissão'], ['inativos', 'Inativos']];
export async function list({ query, setQuery, state }) {
  const data = await api('/team');
  const f = query.get('f') || '';
  // Filtro por empresa (só aparece quando há pessoas de mais de uma empresa)
  const cos = companiesIn(state.meta, data.people.map(p => p.company_id));
  const co = Number(query.get('empresa')) || 0;
  if (co) data.people = data.people.filter(p => p.company_id === co);
  const match = p => (f === 'inativos' ? !p.active : p.active) && (!f || f === 'inativos'
    || (f === 'pendentes' && p.missing_function) || (f === 'sem_acesso' && !p.login_enabled) || (f === 'terceirizados' && p.is_external)
    || (f === 'sem_admissao' && !p.is_external && !p.admission_date));
  const act = data.people.filter(p => p.active);
  const shown = data.people.filter(match);
  const byDep = new Map();
  for (const p of shown) { const k = p.department || 'Sem setor'; if (!byDep.has(k)) byDep.set(k, []); byDep.get(k).push(p); }
  const deps = [...byDep.keys()].sort((a, b) => (a === 'Sem setor') - (b === 'Sem setor') || a.localeCompare(b, 'pt-BR'));
  const count = k => data.people.filter(p => (k === 'inativos' ? !p.active : p.active) && (!k || k === 'inativos' || (k === 'pendentes' && p.missing_function)
    || (k === 'sem_acesso' && !p.login_enabled) || (k === 'terceirizados' && p.is_external) || (k === 'sem_admissao' && !p.is_external && !p.admission_date))).length;
  return {
    title: 'Cadastro da Equipe',
    html: html`
      ${pageHead({
        eyebrow: 'Gestão da Equipe', title: 'Cadastro da Equipe',
        sub: 'Função e responsabilidades de cada pessoa, setor e admissão. Ao abrir uma pessoa: função e responsabilidades, além do acesso e das permissões.',
        actions: html`${(state.meta.can.sections || []).includes('equipe') ? html`<a class="btn btn-ghost" href="#/equipe/organograma">${icon('team')}Organograma</a>` : ''}
          ${state.meta.can.manage_users ? html`<a class="btn btn-ghost" href="#/usuarios/novo?perfil=terceirizado">${icon('plus')}Novo terceirizado</a>
            <a class="btn btn-ghost" href="#/usuarios/novo">${icon('key')}Novo usuário (com acesso)</a>` : ''}
          <a class="btn btn-primary" href="#/equipe/cadastro/novo">${icon('plus')}Nova pessoa (sem acesso)</a>`,
      })}
      <div class="kpis kpis-4">
        ${kpi({ label: 'Pessoas ativas', value: act.length, color: '#2A3D50', foot: `${act.filter(p => p.is_external).length} terceirizado(s)` })}
        ${kpi({ label: 'Função não detalhada', value: act.filter(p => p.missing_function).length, color: '#C0392B', foot: 'obrigatório completar' })}
        ${kpi({ label: 'Sem acesso ao sistema', value: act.filter(p => !p.login_enabled).length, color: '#707E8B', foot: 'só organograma e férias' })}
        ${kpi({ label: 'Sem data de admissão', value: act.filter(p => !p.is_external && !p.admission_date).length, color: '#B7791F', foot: 'necessária para as férias' })}
      </div>
      <div class="chips section" role="group" aria-label="Filtro">${FILTERS.map(([k, l]) => html`<button type="button" class="chip" data-f="${k}" aria-pressed="${f === k}">${l}<span class="n">${count(k)}</span></button>`)}</div>
      <div class="tm-search section"><input type="search" id="tm-q" placeholder="Buscar por nome, função ou setor…" aria-label="Buscar" style="width:100%;max-width:420px">
        ${cos.length > 1 ? html`<select id="tm-co" aria-label="Empresa"><option value="">Todas as empresas</option>${cos.map(c => html`<option value="${c.id}" ${co === c.id ? 'selected' : ''}>${c.name}</option>`)}</select>` : ''}</div>
      ${deps.map(dep => html`<section class="card section" data-dep><div class="card-head"><h2>${dep}</h2><span class="sub">${byDep.get(dep).length}</span></div>
        <ul class="rows">${byDep.get(dep).map(p => html`<li data-text="${`${p.name} ${p.job_title || ''} ${p.department || ''}`.toLowerCase()}"><a class="row-link" href="#/equipe/cadastro/${p.id}">
          <span class="org-av" style="--c:${colorOf(p)}">${av(p)}</span>
          <div class="grow"><div class="row-title">${p.name}</div>
            <div class="row-meta"><span class="${p.missing_function ? 'late' : ''}">${p.missing_function ? '⚠ Função não detalhada' : p.job_title}</span><span>${roleOf(p)}</span>${p.company ? html`<span class="tm-co">${p.company}</span>` : ''}
              ${p.manager_name ? html`<span>${p.is_external ? 'Líder' : 'Gestor'}: ${p.manager_name}</span>` : ''}${p.admission_date ? html`<span>admissão ${fmtDate(p.admission_date)}</span>` : ''}${p.employment ? html`<span>${{ clt: 'CLT', pj: 'PJ', estagio: 'Estagiário' }[p.employment]}</span>` : ''}</div></div>
          <div class="tm-pills">${!p.login_enabled ? html`<span class="org-tag">Sem acesso</span>` : html`<span class="org-tag">${roleOf(p)}</span>`}${p.vacation_summary && p.vacation_summary.status !== 'concluido' && p.vacation_summary.status !== 'disponivel' ? vacPill(p.vacation_summary.status) : ''}</div>
          <span class="chev">${icon('chevron')}</span></a></li>`)}</ul></section>`)}
      ${!shown.length ? html`<p class="muted">Ninguém neste filtro.</p>` : ''}`,
    mount(root, ctx) {
      root.querySelectorAll('[data-f]').forEach(b => b.addEventListener('click', () => { setQuery({ f: b.dataset.f, empresa: co || '' }); ctx.render(); }));
      root.querySelector('#tm-co')?.addEventListener('change', e => { setQuery({ f, empresa: e.target.value }); ctx.render(); });
      root.querySelector('#tm-q').addEventListener('input', e => {
        const q = e.target.value.trim().toLowerCase();
        root.querySelectorAll('[data-dep]').forEach(s => {
          let n = 0;
          s.querySelectorAll('li[data-text]').forEach(li => { li.hidden = !!q && !li.dataset.text.includes(q); if (!li.hidden) n++; });
          s.hidden = !n;
        });
      });
    },
  };
}

export async function form({ params, state, navigate }) {
  const creating = !params.id;
  const [data, p] = await Promise.all([api('/team'), creating ? null : api(`/team/${params.id}`)]);
  const u = p || { name: '', job_title: '', responsibilities: '', department: '', admission_date: '', manager_id: null, login_enabled: 0, active: 1, is_external: 0 };
  const own = creating || !u.login_enabled;
  const managers = data.managers.filter(m => m.id !== u.id);
  return {
    title: creating ? 'Nova pessoa' : u.name,
    html: html`
      ${pageHead({
        back: { href: '#/equipe/cadastro', label: 'Cadastro da Equipe' },
        eyebrow: 'Gestão da Equipe', title: creating ? 'Nova pessoa (sem acesso ao sistema)' : u.name,
        sub: creating ? 'Para funcionários que não usam o sistema (ex.: equipe de campo). Eles aparecem no organograma e nas férias.' : `${roleOf(u)}${u.login_enabled ? ' · com acesso ao sistema' : ' · sem acesso ao sistema'}`,
      })}
      <form class="card card-pad form" id="tm-form" novalidate style="max-width:860px">
        ${!creating ? avatarEditor(u, { canEdit: u.role !== 'admin' || state.user.role === 'admin' || u.id === state.user.id }) : ''}
        ${own ? html`<div class="field"><label class="req" for="tm-name">Nome completo</label><input type="text" id="tm-name" name="name" maxlength="120" required value="${u.name}"></div>` : ''}
        <div class="field" style="max-width:420px"><label for="tm-co-sel">Empresa</label><select id="tm-co-sel" name="company_id">${companyOptions(state.meta, u.company_id ?? (u.is_external ? '' : (state.meta.my_company || (state.meta.companies || []).find(c => c.is_default)?.id)), { empty: u.is_external ? 'Não informada' : '' })}</select>
          <span class="hint">Empresa à qual a pessoa pertence (cadastro em Configurações → Empresas). Não muda o acesso.</span></div>
        <div class="form-row">
          <div class="field"><label class="req" for="tm-fn">Função</label><input type="text" id="tm-fn" name="job_title" maxlength="120" required value="${u.job_title || ''}" placeholder="Ex.: Mestre de obras, Engenheira de planejamento"></div>
          <div class="field"><label for="tm-dep">Setor</label><input type="text" id="tm-dep" name="department" maxlength="80" list="tm-deps" value="${u.department || ''}" placeholder="Ex.: Obras, Engenharia, Administrativo">
            <datalist id="tm-deps">${data.departments.map(d => html`<option value="${d}">`)}</datalist></div>
        </div>
        <div class="field"><label class="req" for="tm-resp">Responsabilidades — o que a pessoa faz na empresa</label>
          <textarea id="tm-resp" name="responsibilities" rows="6" maxlength="4000" required placeholder="Uma por linha. Ex.:&#10;Coordenar as equipes de campo e distribuir as frentes de serviço&#10;Conferir a execução e a qualidade antes das medições&#10;Controlar o recebimento de materiais no canteiro">${u.responsibilities || ''}</textarea>
          <span class="hint">Obrigatório. Descreva as atividades, entregas e decisões pelas quais a pessoa responde — aparece no organograma.</span></div>
        <div class="form-row">
          <div class="field"><label ${u.is_external ? 'class="req"' : ''} for="tm-mgr">${u.is_external ? 'Líder' : 'Gestor direto'}</label><select id="tm-mgr" name="manager_id">
            ${u.is_external ? '' : html`<option value="">Sem gestor (topo do organograma)</option>`}${managers.map(m => html`<option value="${m.id}" ${m.id === u.manager_id ? 'selected' : ''}>${m.name}${m.job_title ? ` · ${m.job_title}` : ''}</option>`)}</select></div>
          ${!u.is_external ? html`<div class="field"><label for="tm-adm">Data de admissão</label><input id="tm-adm" name="admission_date" type="date" value="${u.admission_date || ''}">
            <span class="hint">Base dos períodos de férias.</span></div>` : ''}
        </div>
        ${!u.is_external ? (() => { const cur = u.employment || u.employment_suggested || ''; return html`<div class="field" style="max-width:420px"><label for="tm-emp">Vínculo</label><select id="tm-emp" name="employment">
            <option value="" ${cur ? '' : 'selected'}>Não informado (vale a regra da CLT)</option>
            ${[['clt', 'CLT'], ['pj', 'PJ'], ['estagio', 'Estagiário']].map(([k, l]) => html`<option value="${k}" ${cur === k ? 'selected' : ''}>${l}</option>`)}</select>
          <span class="hint">${!u.employment && u.employment_suggested ? html`<b>Sugerido pela Folha</b> (${u.employment_suggested === 'estagio' ? 'estágio' : 'profissional'}): confira e salve. ` : ''}Define as férias: CLT pelas regras da CLT; PJ pelo acordo (30 dias a cada 12 meses, proporcional, em partes livres); Estagiário pelo recesso (proporcional, em partes livres, podendo antecipar até 5 dias).</span></div>`; })() : ''}
        ${!u.is_external ? html`<div class="field" style="max-width:420px"><label for="tm-vs">Férias controladas no sistema a partir de</label><input id="tm-vs" name="vacation_since" type="date" value="${u.vacation_since || ''}">
          <span class="hint">Períodos aquisitivos encerrados antes desta data são considerados quitados (férias já tiradas fora do sistema). Em branco: controla desde a admissão.</span></div>` : ''}
        <fieldset class="field tm-work"><legend class="label">Jornada de trabalho</legend>
          <label class="switch"><input type="checkbox" name="work_company" ${u.work_days?.length ? '' : 'checked'}>Segue o calendário da empresa</label>
          <div class="tm-days" ${u.work_days?.length ? '' : 'hidden'} role="group" aria-label="Dias em que trabalha">${WD_ORDER.map(d => html`<label class="tm-day"><input type="checkbox" name="wd" value="${d}" ${u.work_days?.includes(d) ? 'checked' : ''}><span>${WD[d]}</span></label>`)}</div>
          <div class="field" style="max-width:420px"><label for="tm-shift">Turno</label><input type="text" id="tm-shift" name="work_shift" maxlength="80" value="${u.work_shift || ''}" placeholder="Ex.: 08:00 às 12:00 e 13:00 às 17:00"></div>
          <span class="hint">Os dias marcados valem para os prazos das tarefas e dos check-lists, os dias úteis, os indicadores e a folha. Feriados e férias continuam valendo. Ao colocar um prazo em dia em que a pessoa não trabalha, o sistema avisa.</span>
        </fieldset>
        ${own ? html`<div class="form-row"><div class="field"><label for="tm-ph">Telefone</label><input type="tel" id="tm-ph" name="phone" maxlength="40" value="${u.phone || ''}"></div>
          ${!creating ? html`<div class="field"><span class="label">Situação</span><label class="switch"><input type="checkbox" name="active" ${u.active ? 'checked' : ''}>Ativo</label></div>` : ''}</div>`
          : html`<div class="notice">${icon('info')}<span>Nome, e-mail, perfil, acesso e permissões desta pessoa: <a href="#/usuarios/${u.id}/editar">Acesso e permissões</a>.</span></div>`}
        ${!creating && !u.login_enabled && !u.is_external && state.meta.can.manage_users ? html`<div class="notice">${icon('key')}<span>Esta pessoa não acessa o sistema. Para liberar o acesso, abra <a href="#/usuarios/${u.id}/editar">Acesso e permissões</a> e informe e-mail e senha provisória.</span></div>` : ''}
        <div class="form-error" hidden></div>
        <div class="form-actions"><a class="btn btn-ghost" href="#/equipe/cadastro">Cancelar</a><button type="submit" class="btn btn-primary">${icon('check')}Salvar</button></div>
      </form>
      ${!creating && state.user.role === 'admin' && u.id !== state.user.id ? html`<div style="max-width:860px">${deleteButton()}</div>` : ''}`,
    mount(root, ctx) {
      if (!creating) bindAvatarEditor(root, u, { self: u.id === state.user.id, after: () => ctx.render() });
      if (!creating) bindDeleteButton(root, u.id, () => navigate('/equipe/cadastro'));
      const f = root.querySelector('#tm-form');
      const company = f.querySelector('[name=work_company]');
      company.addEventListener('change', () => { f.querySelector('.tm-days').hidden = company.checked; });
      f.addEventListener('submit', async e => {
        e.preventDefault();
        const err = f.querySelector('.form-error');
        err.hidden = true;
        const d = Object.fromEntries(new FormData(f));
        d.manager_id = d.manager_id ? Number(d.manager_id) : null;
        d.work_days = company.checked ? null : [...f.querySelectorAll('[name=wd]:checked')].map(x => Number(x.value));
        delete d.wd; delete d.work_company;
        if (d.work_days && !d.work_days.length) { err.textContent = 'Marque os dias em que a pessoa trabalha, ou deixe seguindo o calendário da empresa.'; err.hidden = false; return; }
        if (own && !creating) d.active = !!f.querySelector('[name=active]')?.checked;
        if (!String(d.job_title || '').trim() || String(d.responsibilities || '').trim().length < 10) {
          err.textContent = 'Informe a função e detalhe as responsabilidades (o que a pessoa faz na empresa).';
          err.hidden = false;
          return;
        }
        try {
          if (creating) await api('/team', { method: 'POST', body: d });
          else await api(`/team/${u.id}`, { method: 'PUT', body: d });
          toast(creating ? 'Pessoa cadastrada.' : 'Cadastro atualizado.');
          navigate('/equipe/cadastro');
        } catch (ex) { err.textContent = ex.message; err.hidden = false; }
      });
    },
  };
}
