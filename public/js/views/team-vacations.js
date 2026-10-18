// Gestão da Equipe › Férias: visão do ano (quem sai quando), saldos e vencimentos pela CLT, aprovações e lançamentos.
import { html, api, icon, fmtDate, todayISO } from '../core.js';
import { sheet } from '../ui.js';
import { pageHead, kpi } from './shared.js';
import { printToolbar, bindPrintToolbar, setPageFooter } from './print-common.js';
import { treeHtml } from './team.js';
import { vacPill, reqPill, vacationSheet, approvalsList, bindApprovals, periodsTable, bindCancel } from './vacation-ui.js';

const MONTHS = ['jan', 'fev', 'mar', 'abr', 'mai', 'jun', 'jul', 'ago', 'set', 'out', 'nov', 'dez'];
const doy = (d, y) => (Date.parse(d) - Date.parse(`${y}-01-01`)) / 86400e3;

export async function view({ query, setQuery, render }) {
  const year = Number(query.get('ano')) || Number(todayISO().slice(0, 4));
  const d = await api('/vacations/overview', { query: { ano: year } });
  const k = d.kpis;
  const total = doy(`${year + 1}-01-01`, year);
  const pct = v => Math.max(0, Math.min(100, (v / total) * 100));
  const todayPct = todayISO().startsWith(String(year)) ? pct(doy(todayISO(), year)) : null;
  const bar = v => {
    const a = pct(doy(v.start_date < `${year}-01-01` ? `${year}-01-01` : v.start_date, year));
    const b = pct(doy(v.end_date > `${year}-12-31` ? `${year}-12-31` : v.end_date, year) + 1);
    return html`<span class="vac-bar ${v.status === 'solicitada' ? 'is-req' : ''}" style="left:${a.toFixed(2)}%;width:${Math.max(0.8, b - a).toFixed(2)}%"
      title="${fmtDate(v.start_date)} a ${fmtDate(v.end_date)} · ${v.days} dias · ${v.status === 'solicitada' ? 'aguardando aprovação' : 'aprovada'}"></span>`;
  };
  const grid = html`${MONTHS.map((m, i) => html`<i class="vac-m" style="left:${pct(doy(`${year}-${String(i + 1).padStart(2, '0')}-01`, year)).toFixed(2)}%"></i>`)}${todayPct !== null ? html`<i class="vac-today" style="left:${todayPct.toFixed(2)}%"></i>` : ''}`;
  return {
    title: 'Férias',
    html: html`
      ${pageHead({
        eyebrow: 'Gestão da Equipe', title: 'Férias',
        sub: 'Regras da CLT: 30 dias por período aquisitivo, gozados no período concessivo, em até 3 partes.',
        actions: html`<button type="button" class="btn btn-primary" data-launch>${icon('plus')}Lançar férias</button>`,
      })}
      <div class="kpis kpis-5">
        ${kpi({ label: 'De férias hoje', value: k.on_vacation, color: '#1F6B41' })}
        ${kpi({ label: 'Aguardando aprovação', value: k.pending, color: '#B7791F' })}
        ${kpi({ label: 'Vencendo (60 dias)', value: k.expiring, color: '#C9520F', foot: 'saldo a gozar logo' })}
        ${kpi({ label: 'Vencidas', value: k.expired, color: '#C0392B', foot: 'pagamento em dobro' })}
        ${kpi({ label: 'Sem admissão', value: k.no_admission, color: '#707E8B', foot: 'complete o cadastro' })}
      </div>
      ${d.pending.length ? html`<section class="card section" id="vac-pend"><div class="card-head"><h2>${icon('clock')}Solicitações aguardando aprovação</h2><span class="sub">${d.pending.length}</span></div>${approvalsList(d.pending)}</section>` : ''}
      <section class="card section"><div class="card-head"><h2>${icon('calendar')}Mapa de férias</h2>
        <span class="sub vac-yr"><button type="button" class="btn btn-ghost btn-sm" data-y="${year - 1}" aria-label="Ano anterior">‹</button><b>${year}</b><button type="button" class="btn btn-ghost btn-sm" data-y="${year + 1}" aria-label="Próximo ano">›</button></span></div>
        <div class="vac-map"><table class="vac-t"><thead><tr><th class="vac-name">Pessoa</th><th class="vac-track vac-axis">${MONTHS.map((m, i) => html`<span style="left:${(pct(doy(`${year}-${String(i + 1).padStart(2, '0')}-01`, year)) + 100 / 24).toFixed(2)}%">${m}</span>`)}</th><th class="vac-sal">Saldo</th></tr></thead>
          <tbody>${d.people.map(p => html`<tr data-person="${p.id}" tabindex="0"><td class="vac-name"><b>${p.name}</b><small>${p.job_title || ''}${p.admission_date ? ` · adm. ${fmtDate(p.admission_date)}` : ''}</small></td>
            <td class="vac-track">${grid}${p.vacations.map(bar)}</td>
            <td class="vac-sal"><b>${p.summary?.status === 'sem_admissao' ? '—' : `${p.summary?.available ?? 0} d`}</b>${vacPill(p.summary?.status === 'concluido' ? '' : p.summary?.status)}${p.summary?.deadline && ['vencendo', 'vencida'].includes(p.summary.status) ? html`<small>até ${fmtDate(p.summary.deadline)}</small>` : ''}</td></tr>`)}</tbody></table></div>
        <div class="vac-legend"><span><i class="vac-bar"></i>Aprovadas</span><span><i class="vac-bar is-req"></i>Aguardando aprovação</span><span><i class="vac-today-l"></i>Hoje</span><span class="muted">Toque na pessoa para ver períodos, saldo e histórico.</span></div>
      </section>`,
    mount(root) {
      root.querySelectorAll('[data-y]').forEach(b => b.addEventListener('click', () => { setQuery({ ano: b.dataset.y }); render(); }));
      root.querySelector('[data-launch]').addEventListener('click', async () => {
        if (await vacationSheet({ people: d.people, title: 'Lançar férias' })) render();
      });
      bindApprovals(root.querySelector('#vac-pend') || document.createElement('div'), render);
      root.querySelectorAll('[data-person]').forEach(tr => {
        const open = async () => {
          const u = await api(`/vacations/user/${tr.dataset.person}`);
          const p = sheet({ title: `Férias · ${u.user.name}`, wide: true, submitLabel: 'Lançar férias para esta pessoa',
            body: html`<p class="muted" style="margin-top:0">${u.user.admission_date ? `Admissão em ${fmtDate(u.user.admission_date)}.` : 'Sem data de admissão — informe no Cadastro da Equipe.'} ${vacPill(u.summary?.status)}</p>${periodsTable(u)}` });
          bindCancel(document.querySelector('.sheet-backdrop:last-child'), () => { document.querySelector('.sheet-backdrop:last-child [data-close]')?.click(); render(); });
          if (await p && await vacationSheet({ people: d.people, userId: u.user.id, title: 'Lançar férias' })) render();
        };
        tr.addEventListener('click', open);
        tr.addEventListener('keydown', e => { if (e.key === 'Enter') open(); });
      });
    },
  };
}

// Organograma para impressão (A4 paisagem), inteiro ou de um ramo
export async function printOrg({ query, setQuery, render }) {
  const data = await api('/team/org');
  const rootId = Number(query.get('raiz')) || null;
  const ext = query.get('ext') !== '0';
  const rootP = rootId ? data.people.find(p => p.id === rootId) : null;
  return {
    title: 'Organograma',
    html: html`${printToolbar({
      back: '#/equipe/organograma', title: 'Organograma',
      extra: html`<label class="pt-opt">Ramo <select id="po-root"><option value="">Empresa inteira</option>${data.people.filter(p => data.people.some(x => x.manager_id === p.id)).map(p => html`<option value="${p.id}" ${p.id === rootId ? 'selected' : ''}>${p.name}</option>`)}</select></label>
        <label class="pt-opt"><input type="checkbox" id="po-ext" ${ext ? 'checked' : ''}>Terceirizados</label>`,
    })}
    <div class="doc-stage"><article class="doc org-doc" id="doc">
      <header class="r-header"><img src="/assets/logo.webp" alt="Charão Engenharia & Construção" class="r-logo"><div class="r-doctype"><div class="r-kicker">Organograma</div><div class="r-level">${rootP ? `Equipe de ${rootP.name}` : 'Empresa'} · ${fmtDate(todayISO())}</div></div></header>
      <div class="r-rule"></div>
      <div class="org-print" id="org-print">${treeHtml(data.people, { externals: ext, print: true, rootId })}</div>
      <footer class="r-footer"><span>Charão Engenharia & Construção · Organograma</span><span>${data.summary.internal} pessoa(s) na equipe · ${data.summary.external} terceirizado(s) · gerado pelo sistema Charão Gestão de Obras</span></footer>
    </article></div>`,
    mount(root) {
      setPageFooter('Charão · Organograma');
      bindPrintToolbar(root);
      // Ajusta a árvore à largura da página
      const fit = () => {
        const box = root.querySelector('#org-print');
        const tree = box.querySelector('.org-tree');
        const z = Math.min(1, (box.clientWidth - 4) / tree.scrollWidth);
        box.style.setProperty('--z', z);
        box.style.height = `${tree.scrollHeight * z + 8}px`;
      };
      fit();
      root.querySelector('#po-root').addEventListener('change', e => { setQuery({ raiz: e.target.value, ext: ext ? '' : '0' }); render(); });
      root.querySelector('#po-ext').addEventListener('change', e => { setQuery({ raiz: rootId || '', ext: e.target.checked ? '' : '0' }); render(); });
    },
  };
}
