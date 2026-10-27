// Financeiro › Planejamento anual: tarefas (pontuais ou recorrentes) x 12 meses, previsto e real.
// Clique na célula: ajusta o previsto do mês e/ou lança o real (data e comprovante opcional).
// No celular: um mês por vez, com a lista das tarefas do mês.
import { html, api, icon, fmtDate } from '../core.js';
import { toast, sheet, confirmSheet, readAttachments } from '../ui.js';
import { pageHead } from './shared.js';
import { requestSlot, bindRequests } from './mais-controle.js';

const BRL = new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' });
const money = v => BRL.format(Number(v) || 0);
const NUM0 = new Intl.NumberFormat('pt-BR', { maximumFractionDigits: 0 });
const short = v => NUM0.format(Math.round(Number(v) || 0));
const MES = ['JAN', 'FEV', 'MAR', 'ABR', 'MAI', 'JUN', 'JUL', 'AGO', 'SET', 'OUT', 'NOV', 'DEZ'];
const MESES = ['Janeiro', 'Fevereiro', 'Março', 'Abril', 'Maio', 'Junho', 'Julho', 'Agosto', 'Setembro', 'Outubro', 'Novembro', 'Dezembro'];
const ymLabel = ym => `${MESES[Number(ym.slice(5, 7)) - 1]}/${ym.slice(0, 4)}`;
const parseNum = v => { const s = String(v ?? '').trim(); if (!s) return ''; const n = Number(s.includes(',') ? s.replace(/\./g, '').replace(',', '.') : s); return Number.isFinite(n) ? n : NaN; };
const numIn = v => (v === null || v === undefined || v === '' ? '' : Number(v).toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 }));
const today = () => new Date().toLocaleDateString('en-CA', { timeZone: 'America/Sao_Paulo' });
const ST = { pago: 'Pago', nao_ocorreu: 'Não ocorreu', sem_previsto: 'Sem previsão', aguardando: 'Paguei · aguardando Mais Controle', sem_pagamento: 'Sem pagamento no mês', nao_encontrado: 'Não encontrado no Mais Controle', atrasada: 'Atrasada', pendente: 'A pagar', projetado: 'Previsto' };
const WST = { hoje: ['pagar hoje', 'is-today'], a_pagar: ['', ''], atrasada: ['atrasada', 'is-late'], aguardando: ['paguei · aguardando confirmação', 'is-wait'], nao_encontrado: ['não encontrado no Mais Controle: pagamento não realizado ou não lançado', 'is-late'], justificar: ['sem pagamento no Mais Controle: justifique', 'is-late'] };
const DOW = ['domingo', 'segunda', 'terça', 'quarta', 'quinta', 'sexta', 'sábado'];
const dueLabel = i => (i.days < 0 ? `venceu ${fmtDate(i.due_date)}` : i.days === 0 ? 'hoje' : i.days === 1 ? 'amanhã' : `${DOW[new Date(`${i.due_date}T12:00:00`).getDay()]} ${i.due_date.slice(8, 10)}/${i.due_date.slice(5, 7)}`);
const done = c => c.status === 'pago' || c.status === 'nao_ocorreu';

function cellHtml(row, c, i, cur) {
  if (!c) return html`<td class="fy-c is-none ${cur ? 'is-cur' : ''}"><span class="fy-dash">—</span></td>`;
  return html`<td class="fy-c is-${c.status} ${cur ? 'is-cur' : ''}"><button type="button" class="fy-btn" data-o="${row.id}" data-i="${i}"
      title="${row.title} · ${ymLabel(c.ym)} · ${ST[c.status]} · previsto ${money(c.planned)}${c.real != null ? ` · real ${money(c.real)}` : ''}">
    <span class="fy-p ${c.custom ? 'is-custom' : ''}">${short(c.planned)}</span>
    <span class="fy-r">${c.status === 'pago' ? html`✓ ${short(c.real)}` : c.status === 'nao_ocorreu' ? 'não ocorreu' : c.status === 'atrasada' ? 'atrasada' : c.status === 'aguardando' ? html`paguei${c.marked_amount != null ? ` ${short(c.marked_amount)}` : ''}?` : c.status === 'nao_encontrado' ? 'não achado' : ''}</span></button></td>`;
}

// Detalhamento dos quadros de Projetos e de Clientes: fechado por padrão; aberto fica aberto enquanto a página estiver aberta
const FOLD = { pj: false, cl: false, obras: new Set() };

export async function view({ state, query, setQuery, render }) {
  if (!state.meta.can.finance) throw new Error('Acesso restrito: solicite ao administrador a liberação do Financeiro (Usuários → Editar).');
  const [d, wk, sug] = await Promise.all([api('/finance/year', { query: { ano: query.get('ano') || '' } }), api('/finance/week').catch(() => null), api('/finance/task-suggestions').catch(() => [])]);
  const wItems = wk?.items || [];
  const al = wk?.alerts || { accounts: [], categories: [] };
  // Criar tarefa? As parcelas não criam tarefa sozinhas: aqui a pessoa decide
  const sugCard = !sug.length ? '' : html`<section class="card section fs-card">
      <div class="card-head"><h2>${icon('plus')}Criar tarefas?</h2><span class="sub">${sug.length} parcela(s) do mês anterior, atual e próximo sem tarefa</span></div>
      <div class="card-body"><p class="muted" style="margin:0">As parcelas não criam mais tarefa sozinhas (nem quando o Mais Controle atualiza). Escolha quais viram tarefa no Financeiro; “Não criar” não pergunta de novo. Tarefa excluída também não volta.</p></div>
      <ul class="fs-list">${sug.map(i => html`<li data-fs="${i.id}"><span><b>${i.title} — ${i.month_label}</b><small>${i.category} · vence ${fmtDate(i.due_date)} · previsto ${money(i.amount_expected)}${i.assignee_name ? ` · ${i.assignee_name}` : ''}</small></span>
        <span class="fs-acts"><button type="button" class="btn btn-primary btn-sm" data-fs-yes="${i.id}">${icon('plus')}Criar</button><button type="button" class="btn btn-ghost btn-sm" data-fs-no="${i.id}">Não criar</button></span></li>`)}</ul>
      ${sug.length > 1 ? html`<div class="fs-all"><button type="button" class="btn btn-primary btn-sm" data-fs-all="1">Criar todas (${sug.length})</button><button type="button" class="btn btn-ghost btn-sm" data-fs-all="0">Não criar nenhuma</button></div>` : ''}
    </section>`;
  const weekCard = !wk ? '' : html`<section class="card section fw-card">
      <div class="card-head"><h2>${icon('alert')}Contas da semana</h2><span class="sub">até ${fmtDate(wk.week_end)}${wk.data_until ? ` · Mais Controle até ${fmtDate(wk.data_until)}` : ''}</span></div>
      ${al.accounts.length || al.categories.length || al.reviews || al.issues || al.client_issues ? html`<a class="fw-alert" href="#/financeiro/mais-controle">${icon('alert')}<span><b>Mais Controle:</b>
        ${[al.client_issues ? `${al.client_issues} despesa(s) do centro de custo Empresa paga(s) por conta de cliente: decida o ajuste no Mais Controle` : '',
          ...al.accounts.map(a => `custo de ${money(a.total)} na conta ${a.label} (não classificada: ${a.categories.map(c => c.label).join(', ')})`),
          al.categories.length ? `${al.categories.length} categoria(s) sem tarefa (${money(al.categories.reduce((s, c) => s + c.total, 0))}): cadastre para trazer` : '',
          al.reviews ? `${al.reviews} despesa(s) para conferir a categoria` : '',
          al.issues ? `${al.issues} lançamento(s) para ajustar no Mais Controle (cliente ou conta fora do centro de custo Empresa)` : ''].filter(Boolean).join(' · ')}</span></a>` : ''}
      ${wItems.length ? html`<ul class="fw-list">${wItems.map(i => html`<li class="${WST[i.state][1]}">
        <span class="fw-when">${dueLabel(i)}</span>
        <span class="fw-main"><b>${i.title}</b><small>${i.category} · ${money(i.amount_expected)}${WST[i.state][0] ? html` · <em>${WST[i.state][0]}</em>` : ''}${i.justify_reason && i.justify_kind === 'vai_ocorrer' ? ` · reprogramado: ${i.justify_reason}` : ''}</small></span>
        <span class="fw-acts">
          ${i.state === 'aguardando' || i.state === 'nao_encontrado' ? html`<button type="button" class="btn btn-ghost btn-sm" data-w-unmark="${i.id}">Desfazer “Paguei”</button>`
            : html`<button type="button" class="btn btn-primary btn-sm" data-w-mark="${i.id}">${icon('check')}Paguei</button>`}
          ${['justificar', 'nao_encontrado', 'atrasada'].includes(i.state) ? html`<button type="button" class="btn btn-ghost btn-sm" data-w-just="${i.id}">Justificar</button>` : ''}
        </span></li>`)}</ul>` : html`<div class="card-body muted">Nenhuma conta a pagar nesta semana. 👍</div>`}
    </section>`;
  const T = d.totals;
  const curIdx = d.months.indexOf(d.current);
  // Saldo do mês (previsto − real): estourou (real acima do previsto) ou positivo (abaixo); mês atual só marca se já estourou
  const isPast = i => d.months[i] < d.current;
  const bal = (planned, real, i) => {
    if (!isPast(i) && i !== curIdx) return null;
    if (!real && !planned) return null;
    const v = Math.round((planned || 0) - (real || 0));
    if (v < 0) return { cls: 'is-over', v, label: 'estourou' };
    if (i === curIdx) return { cls: 'is-open', v, label: 'mês em andamento' };
    return { cls: 'is-under', v, label: v ? 'positivo' : 'no previsto' };
  };
  const sgn = v => (v > 0 ? '+' : v < 0 ? '−' : '') + short(Math.abs(v));
  const qm = query.get('m');
  let mobMonth = qm !== null && qm !== '' && Number(qm) >= 0 && Number(qm) <= 11 ? Number(qm) : curIdx >= 0 ? curIdx : 0;
  const rowsById = new Map(d.groups.flatMap(g => g.rows).map(r => [r.id, r]));
  const realToDate = d.month_totals.filter(m => m.ym <= d.current).reduce((s, m) => s + m.real, 0);
  const execPct = T.planned_to_date ? Math.round((realToDate / T.planned_to_date) * 100) : 0;

  const mobileMonth = k => {
    const m = d.month_totals[k];
    return html`<div class="fy-mnav"><button type="button" class="icon-btn" data-mm="-1" aria-label="Mês anterior" ${k === 0 ? 'disabled' : ''}>‹</button>
        <b>${MESES[k]} ${d.year}</b><button type="button" class="icon-btn" data-mm="1" aria-label="Próximo mês" ${k === 11 ? 'disabled' : ''}>›</button></div>
      <div class="fy-mtot"><span>Previsto <b>${money(m.planned)}</b></span><span>Real <b>${money(m.real)}</b></span><span>${m.paid} de ${m.count} pago(s)</span>
        ${(() => { const b = bal(m.planned, m.real, k); return b ? html`<span class="fy-mbal ${b.cls}">${b.label === 'mês em andamento' ? 'Em andamento · falta do previsto' : b.cls === 'is-over' ? 'Estourou' : 'Positivo'} <b>${b.cls === 'is-over' ? money(-b.v) : money(b.v)}</b></span>` : ''; })()}</div>
      ${d.groups.map(g => {
        const rows = g.rows.filter(r => r.cells[k]);
        if (!rows.length) return '';
        return html`<div class="fy-mgrp"><h3>${g.category}</h3>${rows.map(r => { const c = r.cells[k];
          return html`<button type="button" class="fy-mrow is-${c.status}" data-o="${r.id}" data-i="${k}">
            <span class="fy-mrow-t"><b>${r.title}</b><small>vence ${fmtDate(c.due_date)} · ${r.frequency_label}</small></span>
            <span class="fy-mrow-v"><small>previsto ${money(c.planned)}</small>${c.status === 'pago' ? html`<b class="ok">✓ ${money(c.real)}</b>` : html`<em class="fy-st">${ST[c.status]}</em>`}</span></button>`; })}</div>`;
      })}
      ${(d.clients || []).some(c => c.months[k]) ? html`<div class="fy-mgrp fy-mcli"><h3>Gastos dos clientes por obra</h3>${d.clients.filter(c => c.months[k]).map(c => html`<div class="fy-mrow fy-click" data-cl="" data-cc="${c.cost_center}" data-m="${k}" role="button" tabindex="0">
          <span class="fy-mrow-t"><b>${c.cost_center}</b>${c.accounts.filter(a => a.months[k]).map(a => html`<small>${a.client} · ${money(a.months[k])}</small>`)}</span>
          <span class="fy-mrow-v"><b>${money(c.months[k])}</b></span></div>`)}</div>` : ''}`;
  };

  return {
    title: 'Financeiro',
    html: html`${pageHead({ eyebrow: 'Acesso restrito · Gestão da Empresa', title: 'Financeiro',
        sub: 'Planejamento anual: previsto de cada tarefa mês a mês e o real lançado. Clique na célula para lançar o real ou ajustar o previsto.',
        actions: html`<a class="btn btn-ghost" href="#/financeiro/mes">${icon('calendar')}Visão do mês</a>
          <a class="btn btn-ghost" href="#/financeiro/analise">${icon('reports')}Análise</a>
          <a class="btn btn-ghost" href="#/financeiro/obrigacoes">${icon('settings')}Tarefas cadastradas</a>
          <a class="btn btn-ghost" href="#/financeiro/importar">${icon('file')}Importar planilha</a>
          <a class="btn btn-ghost" href="#/financeiro/mais-controle">${icon('reschedule')}Mais Controle</a>
          <a class="btn btn-accent" href="#/financeiro/obrigacoes/nova">${icon('plus')}Nova tarefa financeira</a>` })}
      <div class="fy-top">
        <div class="fy-year"><button type="button" class="icon-btn" data-y="${Number(d.year) - 1}" aria-label="Ano anterior">‹</button><b>${d.year}</b><button type="button" class="icon-btn" data-y="${Number(d.year) + 1}" aria-label="Próximo ano">›</button></div>
        <div class="ct-tiles fy-tiles">
          <div class="ct-tile"><span>Previsto no ano</span><b>${money(T.planned)}</b><small>${d.groups.reduce((s, g) => s + g.rows.length, 0)} tarefa(s)</small></div>
          <div class="ct-tile"><span>Real lançado</span><b>${money(T.real)}</b><small>${T.planned ? Math.round((T.real / T.planned) * 100) : 0}% do previsto do ano</small></div>
          <div class="ct-tile"><span>Previsto até ${MES[Math.max(0, curIdx)] || 'hoje'}</span><b>${money(T.planned_to_date)}</b><small>real ${money(realToDate)} · ${execPct}%</small></div>
          <div class="ct-tile ${T.late ? 'is-late' : ''}"><span>Atrasadas</span><b>${T.late}</b><small>${money(T.late_amount)} previsto</small></div>
        </div>
      </div>
      ${d.groups.length ? html`
      ${sugCard}
      ${weekCard}
      <section class="card fy-card">
        <div class="card-head"><h2>${icon('calendar')}Planejamento anual ${d.year}</h2><span class="sub">previsto × real, mês a mês</span></div>
        <div class="fy-legend"><span><i class="fy-k is-pago"></i>Pago (real)</span><span><i class="fy-k is-atrasada"></i>Atrasada</span><span><i class="fy-k is-pendente"></i>A pagar</span><span><i class="fy-k is-aguardando"></i>Paguei (aguardando Mais Controle)</span><span><i class="fy-k is-nao_ocorreu"></i>Não ocorreu (real 0)</span><span><i class="fy-k is-projetado"></i>Previsto (projetado)</span><span><i class="fy-k is-custom"></i>Previsto ajustado no mês</span><span><i class="fy-k is-over"></i>Estourou (real acima do previsto)</span><span><i class="fy-k is-under"></i>Positivo (real abaixo do previsto)</span></div>
        <div class="fy-wrap"><table class="fy">
          <thead><tr><th class="fy-name">Tarefa</th>${MES.map((m, i) => html`<th class="${i === curIdx ? 'is-cur' : ''}">${m}</th>`)}<th class="fy-tot">Ano</th></tr></thead>
          ${d.groups.map(g => html`<tbody>
            <tr class="fy-grp"><th class="fy-name">${g.category}<small>${g.rows.length}</small></th>${g.months.map((m, i) => { const b = bal(m.planned, m.real, i);
              return html`<td class="${i === curIdx ? 'is-cur' : ''} ${b?.cls === 'is-over' ? 'is-over' : ''}" title="${b?.cls === 'is-over' ? `estourou ${short(-b.v)}` : ''}"><span>${m.planned ? short(m.planned) : ''}</span>${m.real ? html`<span class="ok">${b?.cls === 'is-over' ? '▲' : '✓'} ${short(m.real)}</span>` : ''}</td>`; })}
              <td class="fy-tot"><span>${short(g.planned)}</span>${g.real ? html`<span class="ok">✓ ${short(g.real)}</span>` : ''}</td></tr>
            ${g.rows.map(r => html`<tr class="${r.active ? '' : 'is-inactive'}"><th class="fy-name"><a href="#/financeiro/obrigacoes/${r.id}/editar" title="Editar a tarefa">${r.title}</a><small>${r.frequency_label} · dia ${r.due_day}${r.variable ? ' · variável' : ''}</small></th>
              ${r.cells.map((c, i) => cellHtml(r, c, i, i === curIdx))}
              <td class="fy-tot"><span>${short(r.planned)}</span>${r.real ? html`<span class="ok">✓ ${short(r.real)}</span>` : ''}</td></tr>`)}
          </tbody>`)}
          <tfoot>
            <tr><th class="fy-name">Previsto</th>${d.month_totals.map((m, i) => html`<td class="${i === curIdx ? 'is-cur' : ''}">${m.planned ? short(m.planned) : '—'}</td>`)}<td class="fy-tot">${short(T.planned)}</td></tr>
            <tr class="fy-real"><th class="fy-name">Real</th>${d.month_totals.map((m, i) => html`<td class="${i === curIdx ? 'is-cur' : ''}">${m.real ? short(m.real) : '—'}</td>`)}<td class="fy-tot">${short(T.real)}</td></tr>
            <tr class="fy-bal"><th class="fy-name">Saldo<small>previsto − real</small></th>${d.month_totals.map((m, i) => { const b = bal(m.planned, m.real, i);
              return html`<td class="${i === curIdx ? 'is-cur' : ''} ${b?.cls || ''}" title="${b ? b.label : ''}">${b ? html`<b>${sgn(b.v)}</b><small>${b.label}</small>` : '—'}</td>`; })}
              ${(() => { const past = d.month_totals.filter((m, i) => isPast(i)); if (!past.length) return html`<td class="fy-tot">—</td>`;
                const v = Math.round(past.reduce((s, m) => s + m.planned - m.real, 0));
                const last = MES[d.month_totals.reduce((m, x, i) => (isPast(i) ? i : m), 0)];
                return html`<td class="fy-tot ${v < 0 ? 'is-over' : 'is-under'}" title="soma dos meses fechados"><b>${sgn(v)}</b><small>até ${last}</small></td>`; })()}</tr>
          </tfoot>
        </table></div>
      </section>
      <section class="card fy-mob" data-fy-mob>${mobileMonth(mobMonth)}</section>
      ${d.projects?.length ? html`<section class="card section fy-proj">
        <div class="card-head"><h2>${icon('projects')}Custos de Projetos pagos pela Empresa</h2><span class="sub">Mais Controle · contas da empresa · centros de custo diferentes de Empresa · ${money(d.projects.reduce((s, p) => s + p.total, 0))}</span></div>
        <div class="fy-wrap"><table class="fy fy-projt fy-fold ${FOLD.pj ? 'is-open' : ''}" data-fold="pj"><thead><tr><th class="fy-name">Centro de custo</th>${MES.map((m, i) => html`<th class="${i === curIdx ? 'is-cur' : ''}">${m}</th>`)}<th class="fy-tot">Ano</th></tr></thead>
          <tbody>${d.projects.map(p => html`<tr><th class="fy-name">${p.cost_center}<small>${p.count} pagamento(s)</small></th>${p.months.map((v, i) => v ? html`<td class="${i === curIdx ? 'is-cur' : ''} fy-click" data-pj="${p.cost_center}" data-m="${i}" title="Ver os lançamentos"><span class="fy-dash">${short(v)}</span></td>` : html`<td class="${i === curIdx ? 'is-cur' : ''}"><span class="fy-dash">—</span></td>`)}<td class="fy-tot">${short(p.total)}</td></tr>`)}</tbody>
          <tfoot><tr><th class="fy-name"><button type="button" class="fy-tog" data-tog="pj" aria-expanded="${FOLD.pj}"><i>▸</i>Total</button><small>${d.projects.length} centro(s) de custo · <span class="fy-tog-l">${FOLD.pj ? 'ocultar' : 'ver'}</span> detalhamento</small></th>${MES.map((m, i) => { const v = d.projects.reduce((s, p) => s + (p.months[i] || 0), 0); return html`<td class="${i === curIdx ? 'is-cur' : ''}">${v ? short(v) : '—'}</td>`; })}<td class="fy-tot">${short(d.projects.reduce((s, p) => s + p.total, 0))}</td></tr></tfoot></table></div>
      </section>` : ''}
      ${d.clients?.length ? html`<section class="card section fy-proj fy-cli">
        <div class="card-head"><h2>${icon('wallet')}Gastos dos clientes por obra</h2><span class="sub">Mais Controle · contas de cliente · ${money(d.clients.reduce((s, c) => s + c.total, 0))}</span></div>
        <div class="fy-wrap"><table class="fy fy-projt fy-fold ${FOLD.cl ? 'is-open' : ''}" data-fold="cl"><thead><tr><th class="fy-name">Obra / conta</th>${MES.map((m, i) => html`<th class="${i === curIdx ? 'is-cur' : ''}">${m}</th>`)}<th class="fy-tot">Ano</th></tr></thead>
          ${d.clients.map(c => html`<tbody class="${FOLD.obras.has(c.cost_center) ? 'is-open' : ''}"><tr class="fy-cli-h"><th class="fy-name"><button type="button" class="fy-tog" data-tog-obra="${c.cost_center}" aria-expanded="${FOLD.obras.has(c.cost_center)}"><i>▸</i>${c.cost_center}</button><small>${c.accounts.length} conta(s)</small></th>${c.months.map((v, i) => v ? html`<td class="${i === curIdx ? 'is-cur' : ''} fy-click" data-cl="" data-cc="${c.cost_center}" data-m="${i}" title="Ver os lançamentos">${short(v)}</td>` : html`<td class="${i === curIdx ? 'is-cur' : ''}">—</td>`)}<td class="fy-tot">${short(c.total)}</td></tr>
            ${c.accounts.map(a => html`<tr class="fy-acc"><th class="fy-name fy-sub">${a.client}</th>${a.months.map((v, i) => v ? html`<td class="${i === curIdx ? 'is-cur' : ''} fy-click" data-cl="${a.key}" data-cln="${a.client}" data-cc="${c.cost_center}" data-m="${i}" title="Ver os lançamentos"><span class="fy-dash">${short(v)}</span></td>` : html`<td class="${i === curIdx ? 'is-cur' : ''}"><span class="fy-dash">—</span></td>`)}<td class="fy-tot">${short(a.total)}</td></tr>`)}</tbody>`)}
          <tfoot><tr><th class="fy-name"><button type="button" class="fy-tog" data-tog="cl" aria-expanded="${FOLD.cl}"><i>▸</i>Total</button><small>${d.clients.length} obra(s) · <span class="fy-tog-l">${FOLD.cl ? 'ocultar' : 'ver'}</span> detalhamento</small></th>${MES.map((m, i) => { const v = d.clients.reduce((s, c) => s + (c.months[i] || 0), 0); return html`<td class="${i === curIdx ? 'is-cur' : ''}">${v ? short(v) : '—'}</td>`; })}<td class="fy-tot">${short(d.clients.reduce((s, c) => s + c.total, 0))}</td></tr></tfoot></table></div>
      </section>` : ''}`
      : html`<section class="card"><div class="card-body muted">Nenhuma tarefa financeira em ${d.year}. Comece em “Nova tarefa financeira” ou “Importar planilha”.</div></section>`}`,
    mount(root) {
      root.querySelectorAll('[data-y]').forEach(b => b.addEventListener('click', () => { setQuery({ ano: b.dataset.y }); render(); }));
      const mob = root.querySelector('[data-fy-mob]');
      mob?.addEventListener('click', e => {
        const b = e.target.closest('[data-mm]');
        if (!b) return;
        mobMonth = Math.min(11, Math.max(0, mobMonth + Number(b.dataset.mm)));
        mob.innerHTML = mobileMonth(mobMonth).toString();
        setQuery({ ano: d.year, m: mobMonth });
      });
      // Célula (grade ou lista do celular): previsto do mês e lançamento do real.
      // Liga nos quadros desta renderização (o #view é reaproveitado: ligar nele acumulava um clique por recarga
      // e abria várias janelas empilhadas)
      const onCell = async e => {
        const b = e.target.closest('[data-o][data-i]');
        if (!b) return;
        const r = rowsById.get(Number(b.dataset.o));
        const i = Number(b.dataset.i);
        const c = r?.cells[i];
        if (!c) return;
        const reload = () => { setQuery({ ano: d.year, m: mobMonth }); render(); };
        if (done(c) && c.source === 'maiscontrole') {
          const pays = await api('/finance/maiscontrole/payments', { query: { tarefa: r.id, mes: c.ym } }).catch(() => []);
          const p = sheet({
            title: `${r.title} · ${ymLabel(c.ym)}`, submitLabel: 'Fechar',
            body: html`<p style="margin:0 0 6px"><b class="ok">✓ Pago ${money(c.real)}</b> · Mais Controle · previsto ${money(c.planned)}</p>
              <p class="muted" style="margin:0 0 8px">Pagamentos do Mais Controle que formam o realizado do mês. Se algum não deve entrar, use “Não trazer”: o realizado é recalculado na hora.</p>
              <ul class="mc-pays">${pays.map(x => html`<li class="${x.excluded || x.standby ? 'is-off' : ''}"><span><b>${x.supplier || '(sem fornecedor)'}</b><small>${fmtDate(x.paid_date)}${x.description ? ` · ${x.description}` : ''}</small>
                  ${x.fixed_from ? html`<small class="mc-note">corrigida no sistema (no Mais Controle: ${x.fixed_from})</small>` : ''}${x.standby ? html`<small class="mc-note">em stand by: fora do realizado até ser corrigida no Mais Controle (veja em Mais Controle › Conferir categorias)</small>` : ''}
                  ${requestSlot(x)}</span>
                <span class="mc-pv"><b>${money(x.amount)}</b>${x.excluded ? html`<small>não entra</small>` : html`<span class="mc-pacts">
                  <button type="button" class="btn btn-ghost btn-sm" data-ex="pagamento" data-key="${x.key}">Não trazer</button>
                  ${x.supplier ? html`<button type="button" class="btn btn-ghost btn-sm" data-ex="fornecedor" data-label="${x.supplier}">Não trazer o fornecedor</button>` : ''}</span>`}</span></li>`)}</ul>`,
          });
          bindRequests([...document.querySelectorAll('.sheet')].at(-1), pays);
          document.querySelectorAll('.sheet [data-ex]').forEach(b => b.addEventListener('click', async () => {
            const forn = b.dataset.ex === 'fornecedor';
            if (!(await confirmSheet(forn ? 'Não trazer o fornecedor' : 'Não trazer este pagamento', forn ? `Nenhum pagamento de “${b.dataset.label}” vai entrar nas tarefas financeiras. Dá para voltar em Mais Controle › Custos que não entram.` : 'Este pagamento deixa de entrar no realizado. Dá para voltar em Mais Controle › Custos que não entram.', 'Não trazer', true))) return;
            try {
              await api('/finance/maiscontrole/exclusions', { method: 'POST', body: forn ? { kind: 'fornecedor', label: b.dataset.label } : { kind: 'pagamento', key: b.dataset.key } });
              document.querySelector('.sheet [data-close]')?.click();
              toast('Feito: o realizado foi recalculado.'); reload();
            } catch (ex) { toast(ex.message, 'error'); }
          }));
          await p;
          return;
        }
        if (done(c)) {
          const ok = await sheet({
            title: `${r.title} · ${ymLabel(c.ym)}`, submitLabel: c.status === 'nao_ocorreu' ? 'Desfazer (voltar a pendente)' : 'Desfazer pagamento', danger: true,
            body: html`${c.status === 'nao_ocorreu' ? html`<p style="margin:0 0 6px"><b>Não ocorreu neste mês</b> (real lançado R$ 0,00)</p>` : html`<p style="margin:0 0 6px"><b class="ok">✓ Pago ${money(c.real)}</b> em ${fmtDate(c.paid_date)}</p>`}
              <p class="muted" style="margin:0">Previsto ${money(c.planned)}${c.real !== c.planned ? ` · diferença ${money(c.real - c.planned)}` : ''}${c.files ? ` · ${c.files} comprovante(s) na tarefa` : ''}.</p>
              <p class="hint" style="margin:10px 0 0">Para corrigir o valor real, desfaça o pagamento e lance de novo.</p>`,
            onSubmit: () => api(`/finance/items/${c.item_id}/unpay`, { method: 'POST' }),
          });
          if (ok) { toast('Pagamento desfeito.'); reload(); }
          return;
        }
        const res = await sheet({
          title: `${r.title} · ${ymLabel(c.ym)}`, submitLabel: 'Salvar',
          body: html`<p class="muted" style="margin:0 0 10px">${r.category} · vence ${fmtDate(c.due_date)} · ${ST[c.status]}${c.estimated ? ' · valor estimado' : ''}</p>
            <div class="form-row"><div class="field"><label for="fy-p">Previsto (R$)</label><input type="text" id="fy-p" name="planned" inputmode="decimal" value="${numIn(c.planned)}">
              <span class="hint">Só deste mês${c.custom ? ' (já ajustado)' : ''}. Valor da tarefa: ${money(r.amount)}.</span></div>
              <div class="field"><label for="fy-r">Valor real pago (R$)</label><input type="text" id="fy-r" name="real" inputmode="decimal" placeholder="em branco = ainda não pago">
                <span class="hint">Preencha quando pagar. <b>0</b> = não ocorreu neste mês (não fica atrasada).</span></div></div>
            <div class="form-row"><div class="field"><label for="fy-d">Data do pagamento</label><input type="date" id="fy-d" name="paid_date" max="${today()}" value="${today()}"></div>
              <div class="field"><label for="fy-f">Comprovante (opcional)</label><input type="file" id="fy-f" accept="image/*,application/pdf,.pdf" multiple class="fin-file"></div></div>`,
          onSubmit: async (f, form) => {
            const planned = parseNum(f.planned), real = parseNum(f.real);
            if (Number.isNaN(planned) || Number.isNaN(real)) throw new Error('Valor inválido.');
            if (planned !== '' && Math.abs(planned - c.planned) > 0.004) await api('/finance/plan', { method: 'PUT', body: { obligation_id: r.id, ref_month: c.ym, amount: planned } });
            if (real === '') return { saved: 'plan' };
            const item = c.item_id || (await api(`/finance/obligations/${r.id}/months/${c.ym}`, { method: 'POST' })).id;
            const files = await readAttachments(form.querySelector('input[type=file]')?.files || []);
            await api(`/finance/items/${item}/pay`, { method: 'POST', body: { paid_date: f.paid_date, paid_amount: real, files: files.map(x => ({ data: x.data, name: x.name })) } });
            return { saved: real === 0 ? 'none' : 'paid' };
          },
        });
        if (res) { toast(res.saved === 'paid' ? 'Real lançado.' : res.saved === 'none' ? 'Marcado como não ocorrido no mês.' : 'Previsto atualizado.'); reload(); }
      };
      // Criar tarefa? (uma parcela ou todas)
      const answer = async (ids, create, btn) => {
        if (btn) btn.disabled = true;
        try {
          const r = await api('/finance/task-suggestions', { method: 'POST', body: { ids, create } });
          toast(create ? `${r.count} tarefa(s) criada(s) no Financeiro.` : `${r.count} parcela(s) ficam sem tarefa.`);
          render();
        } catch (ex) { toast(ex.message, 'error'); if (btn) btn.disabled = false; }
      };
      root.querySelectorAll('[data-fs-yes]').forEach(b => b.addEventListener('click', () => answer([Number(b.dataset.fsYes)], true, b)));
      root.querySelectorAll('[data-fs-no]').forEach(b => b.addEventListener('click', () => answer([Number(b.dataset.fsNo)], false, b)));
      root.querySelectorAll('[data-fs-all]').forEach(b => b.addEventListener('click', () => answer(sug.map(i => i.id), b.dataset.fsAll === '1', b)));
      root.querySelectorAll('.fy-card, [data-fy-mob]').forEach(el => el.addEventListener('click', onCell));
      // Custos de Projetos pagos pela Empresa / Gastos dos clientes por obra: lançamentos do mês
      const onCost = async e => {
        const t = e.target.closest('[data-pj][data-m], [data-cc][data-m]');
        if (!t) return;
        const ym = d.months[Number(t.dataset.m)];
        const cli = 'cl' in t.dataset;
        const query = cli ? { tipo: 'cliente', cc: t.dataset.cc, mes: ym, ...(t.dataset.cl ? { conta: t.dataset.cl } : {}) } : { tipo: 'projeto', cc: t.dataset.pj, mes: ym };
        let pays;
        try { pays = await api('/finance/maiscontrole/cost-payments', { query }); } catch (ex) { toast(ex.message, 'error'); return; }
        const tot = pays.reduce((s, x) => s + x.amount, 0);
        const title = cli ? `${t.dataset.cc}${t.dataset.cl ? ` · ${t.dataset.cln}` : ''}` : t.dataset.pj;
        const p = sheet({
          title: `${title} · ${ymLabel(ym)}`, submitLabel: 'Fechar',
          body: html`<p style="margin:0 0 6px"><b>${pays.length} lançamento(s) · ${money(tot)}</b> · Mais Controle</p>
            <p class="muted" style="margin:0 0 8px">${cli ? (t.dataset.cl ? 'Gastos pagos por esta conta de cliente na obra.' : 'Gastos pagos pelas contas de cliente nesta obra.') : 'Custos pagos pelas contas da empresa neste centro de custo.'}</p>
            <ul class="mc-pays">${pays.map(x => html`<li><span><b>${x.supplier || '(sem fornecedor)'}</b><small>${fmtDate(x.paid_date)} · ${x.category || '(sem categoria)'}${x.description ? ` · ${x.description}` : ''}</small>
              ${!(cli && t.dataset.cl) ? html`<small>conta ${x.account || '(sem conta)'}</small>` : ''}${requestSlot(x)}</span>
              <span class="mc-pv"><b>${money(x.amount)}</b></span></li>`)}</ul>`,
        });
        bindRequests([...document.querySelectorAll('.sheet')].at(-1), pays);
        await p;
      };
      root.querySelectorAll('.fy-proj, [data-fy-mob]').forEach(el => el.addEventListener('click', onCost));
      root.querySelectorAll('[data-tog]').forEach(b => b.addEventListener('click', () => {
        const k = b.dataset.tog, t = b.closest('table');
        FOLD[k] = !FOLD[k]; t.classList.toggle('is-open', FOLD[k]); b.setAttribute('aria-expanded', FOLD[k]);
        t.querySelector('.fy-tog-l').textContent = FOLD[k] ? 'ocultar' : 'ver';
      }));
      root.querySelectorAll('[data-tog-obra]').forEach(b => b.addEventListener('click', () => {
        const k = b.dataset.togObra, open = !FOLD.obras.has(k);
        if (open) FOLD.obras.add(k); else FOLD.obras.delete(k);
        b.closest('tbody').classList.toggle('is-open', open); b.setAttribute('aria-expanded', open);
      }));
      const wReload = () => { setQuery({ ano: d.year, m: mobMonth }); render(); };
      const wItem = id => wItems.find(i => i.id === Number(id));
      root.querySelectorAll('[data-w-mark]').forEach(b => b.addEventListener('click', async () => {
        const i = wItem(b.dataset.wMark);
        const res = await sheet({ title: `Paguei · ${i.title}`, submitLabel: 'Marcar como pago',
          body: html`<p class="muted" style="margin:0 0 10px">Vence ${fmtDate(i.due_date)} · previsto ${money(i.amount_expected)}. Na próxima atualização o sistema confere no Mais Controle; se não achar o pagamento, avisa.</p>
            <div class="field"><label for="w-v">Valor pago (opcional)</label><input type="text" id="w-v" name="amount" inputmode="decimal" placeholder="em branco = o Mais Controle informa"></div>`,
          onSubmit: f => { const v = parseNum(f.amount); if (Number.isNaN(v)) throw new Error('Valor inválido.'); return api(`/finance/items/${i.id}/mark`, { method: 'POST', body: { amount: v === '' ? null : v } }); } });
        if (res) { toast('Marcado como pago: aguardando a confirmação do Mais Controle.'); wReload(); }
      }));
      root.querySelectorAll('[data-w-unmark]').forEach(b => b.addEventListener('click', async () => {
        try { await api(`/finance/items/${b.dataset.wUnmark}/unmark`, { method: 'POST' }); toast('Marcação desfeita.'); wReload(); } catch (ex) { toast(ex.message, 'error'); }
      }));
      root.querySelectorAll('[data-w-just]').forEach(b => b.addEventListener('click', async () => {
        const i = wItem(b.dataset.wJust);
        const res = await sheet({ title: `Justificar · ${i.title}`, submitLabel: 'Salvar justificativa',
          body: html`<p class="muted" style="margin:0 0 10px">Previsto ${money(i.amount_expected)} para ${fmtDate(i.due_date)}${i.state === 'nao_encontrado' ? ', marcado como pago, mas o pagamento não apareceu no Mais Controle' : ', sem pagamento'}. A despesa ainda vai ocorrer?</p>
            <div class="segmented fo-kind" role="radiogroup" aria-label="A despesa vai ocorrer?">
              <label><input type="radio" name="kind" value="vai_ocorrer" checked>Vai ocorrer<small>informe a nova data</small></label>
              <label><input type="radio" name="kind" value="nao_ocorre">Não vai ocorrer<small>fica “não ocorreu” (real 0)</small></label></div>
            <div class="field" data-w-nd><label for="w-d">Nova data prevista</label><input type="date" id="w-d" name="new_date" min="${today()}" value="${today()}"></div>
            <div class="field"><label class="req" for="w-r">Motivo</label><textarea id="w-r" name="reason" rows="2" maxlength="500" required></textarea></div>`,
          onSubmit: f => { if (!String(f.reason || '').trim()) throw new Error('Informe o motivo.'); return api(`/finance/items/${i.id}/justify`, { method: 'POST', body: f }); } });
        if (res) { toast(res.status === 'paga' ? 'Registrado: não vai ocorrer.' : 'Justificado: nova data prevista.'); wReload(); }
      }));

    },
  };
}
