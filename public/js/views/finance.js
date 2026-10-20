// Tarefas financeiras (liberação por usuário): obrigações mensais/periódicas, parcelas Pendente → Paga,
// calendário do mês, lista por vencimento e resumo por categoria.
import { html, raw, api, icon, fmtDate } from '../core.js';
import { toast, sheet, confirmSheet, readAttachments } from '../ui.js';
import { pageHead } from './shared.js';

const BRL = new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' });
const money = v => BRL.format(Number(v) || 0);
const MONTHS = ['Janeiro', 'Fevereiro', 'Março', 'Abril', 'Maio', 'Junho', 'Julho', 'Agosto', 'Setembro', 'Outubro', 'Novembro', 'Dezembro'];
const DOW = ['Seg', 'Ter', 'Qua', 'Qui', 'Sex', 'Sáb', 'Dom'];
const addMonths = (ym, k) => { let [y, m] = ym.split('-').map(Number); m += k; while (m > 12) { m -= 12; y++; } while (m < 1) { m += 12; y--; } return `${y}-${String(m).padStart(2, '0')}`; };
const parseNum = v => { const s = String(v ?? '').trim(); if (!s) return ''; const n = Number(s.includes(',') ? s.replace(/\./g, '').replace(',', '.') : s); return Number.isFinite(n) ? n : ''; };
const FREQ = { mensal: 'Mensal', bimestral: 'Bimestral', trimestral: 'Trimestral', semestral: 'Semestral', anual: 'Anual', unica: 'Única' };

// Situação: cor de estado sempre com ícone + texto
export const SIT = {
  atrasada: { label: 'Atrasada', ic: 'alert', cls: 'fs-late' },
  hoje: { label: 'Vence hoje', ic: 'clock', cls: 'fs-today' },
  semana: { label: 'Próximos 7 dias', ic: 'calendar', cls: 'fs-week' },
  futura: { label: 'A vencer', ic: 'calendar', cls: 'fs-future' },
  paga: { label: 'Paga', ic: 'check', cls: 'fs-paid' },
};
const sitBadge = s => html`<span class="fs-badge ${SIT[s].cls}">${icon(SIT[s].ic)}${SIT[s].label}</span>`;

function denied(state) {
  if (!state.meta.can.finance) throw new Error('Acesso restrito: solicite ao administrador a liberação de Tarefas financeiras (Usuários → Editar).');
}

// ---------- Pagar / desfazer / ajustar valor ----------
async function payFlow(it, done) {
  const r = await sheet({
    title: `Pagar · ${it.title}`,
    submitLabel: 'Registrar pagamento',
    body: html`<p class="muted" style="margin:0 0 10px">${it.category}${it.payee ? ` · ${it.payee}` : ''} · vencimento ${fmtDate(it.due_date)} · previsto <b>${money(it.amount_expected)}</b></p>
      <div class="form-row"><div class="field"><label class="req" for="fp-d">Data do pagamento</label><input type="date" id="fp-d" name="paid_date" required max="${new Date().toISOString().slice(0, 10)}" value="${new Date().toISOString().slice(0, 10)}"></div>
        <div class="field"><label for="fp-v">Valor pago (R$)</label><input id="fp-v" name="paid_amount" inputmode="decimal" value="${String(it.amount_expected).replace('.', ',')}"></div></div>
      <div class="field"><label for="fp-f">Comprovante (foto ou PDF)</label><input type="file" id="fp-f" accept="image/*,application/pdf,.pdf" multiple class="fin-file"><span class="hint">Opcional. Fica anexado à tarefa da parcela.</span></div>
      <div class="field"><label for="fp-n">Observação</label><input id="fp-n" name="notes" maxlength="1000"></div>`,
    onSubmit: async (d, form) => {
      const files = await readAttachments(form.querySelector('input[type=file]')?.files || []);
      return api(`/finance/items/${it.id}/pay`, { method: 'POST', body: { paid_date: d.paid_date, paid_amount: parseNum(d.paid_amount), notes: d.notes, files: files.map(f => ({ data: f.data, name: f.name })) } });
    },
  });
  if (r) { toast('Pagamento registrado.'); done(); }
}
async function unpayFlow(it, done) {
  if (!(await confirmSheet('Desfazer pagamento', `A parcela "${it.title}" volta a pendente e a tarefa é reaberta. Os comprovantes anexados continuam na tarefa.`, 'Desfazer'))) return;
  try { await api(`/finance/items/${it.id}/unpay`, { method: 'POST' }); toast('Pagamento desfeito.'); done(); } catch (e) { toast(e.message, 'err'); }
}
async function amountFlow(it, done) {
  const prev = it.previous_amount;
  const r = await sheet({
    title: `Valor previsto · ${it.title}`, submitLabel: 'Salvar',
    body: html`<div class="field"><label class="req" for="fa-v">Valor previsto desta parcela (R$)</label><input type="text" id="fa-v" name="amount_expected" required inputmode="decimal" value="${String(it.amount_expected).replace('.', ',')}">
        ${prev != null ? html`<button type="button" class="btn btn-ghost btn-sm fin-prev" data-prev="${String(prev).replace('.', ',')}">${icon('history')}Usar o valor do mês anterior (${money(prev)})</button>` : ''}</div>
      <label class="switch"><input type="checkbox" name="estimated" ${it.estimated ? 'checked' : ''}>Valor estimado (será corrigido depois${it.category === 'Folha de pagamento' ? ' pela Folha (Administrativa)' : ''})</label>`,
    onSubmit: (d, form) => api(`/finance/items/${it.id}/amount`, { method: 'PUT', body: { amount_expected: parseNum(d.amount_expected), estimated: form.querySelector('[name=estimated]').checked } }),
  });
  if (r) { toast('Valor atualizado.'); done(); }
}
// Botão "Usar o valor do mês anterior" dentro da folha de ajuste
document.addEventListener('click', e => {
  const b = e.target.closest?.('.fin-prev');
  if (!b) return;
  const input = b.closest('.field')?.querySelector('input[name=amount_expected]');
  if (input) { input.value = b.dataset.prev; input.focus(); }
});

// ---------- Visão do mês ----------
export async function view({ state, query, setQuery, render }) {
  denied(state);
  const d = await api('/finance/month', { query: { mes: query.get('mes') || '' } });
  const T = d.totals;
  const [y, m] = d.month.split('-').map(Number);
  const items = d.items;
  const byId = new Map(items.map(i => [i.id, i]));
  const inMonth = items.filter(i => i.ref_month === d.month);

  // Calendário: semanas de segunda a domingo
  const first = new Date(Date.UTC(y, m - 1, 1));
  const lastDay = new Date(Date.UTC(y, m, 0)).getUTCDate();
  const lead = (first.getUTCDay() + 6) % 7;
  const cells = [...Array(lead).fill(null), ...Array.from({ length: lastDay }, (_, k) => k + 1)];
  while (cells.length % 7) cells.push(null);
  const dayItems = day => inMonth.filter(i => Number(i.due_date.slice(8)) === day && i.due_date.slice(0, 7) === d.month);
  const cal = html`<div class="fin-cal" role="grid" aria-label="Vencimentos de ${MONTHS[m - 1]}">
    ${DOW.map(w => html`<div class="fin-dow">${w}</div>`)}
    ${cells.map(day => {
      if (!day) return html`<div class="fin-day is-empty"></div>`;
      const iso = `${d.month}-${String(day).padStart(2, '0')}`;
      const its = dayItems(day);
      const sum = its.reduce((s, i) => s + i.amount_expected, 0);
      return html`<div class="fin-day ${iso === d.today ? 'is-today' : ''} ${its.length ? 'has-items' : ''}">
        <span class="fin-dn">${day}</span>
        ${its.slice(0, 3).map(i => html`<button type="button" class="fin-chip ${SIT[i.situation].cls}" data-item="${i.id}" title="${i.title} · ${money(i.amount_expected)} · ${SIT[i.situation].label}"><span>${i.title}</span></button>`)}
        ${its.length > 3 ? html`<small class="fin-more">+${its.length - 3}</small>` : ''}
        ${its.length ? html`<small class="fin-sum">${money(sum)}</small>` : ''}
      </div>`;
    })}
  </div>`;

  // Lista por vencimento
  const groups = [
    ['atrasada', 'Atrasadas', items.filter(i => i.situation === 'atrasada')],
    ['hoje', 'Vencem hoje', items.filter(i => i.situation === 'hoje')],
    ['semana', 'Próximos 7 dias', items.filter(i => i.situation === 'semana')],
    ['futura', 'Mais adiante no mês', inMonth.filter(i => i.situation === 'futura')],
    ['paga', 'Pagas no mês', inMonth.filter(i => i.situation === 'paga')],
  ];
  const row = i => html`<li class="fin-row ${SIT[i.situation].cls}">
    <div class="fin-row-main"><b>${i.title}</b><small>${i.category}${i.payee ? ` · ${i.payee}` : ''} · ${i.frequency_label}${i.assignee_name ? ` · ${i.assignee_name}` : ''}</small></div>
    <div class="fin-row-due"><span>${fmtDate(i.due_date)}</span>${sitBadge(i.situation)}</div>
    <div class="fin-row-val"><b>${money(i.status === 'paga' ? (i.paid_amount ?? i.amount_expected) : i.amount_expected)}</b>${i.status === 'paga' ? html`<small>pago em ${fmtDate(i.paid_date)}</small>` : i.estimated ? html`<small class="fin-est">valor estimado</small>` : i.variable ? html`<small>valor variável</small>` : ''}${i.payroll_ref ? html`<small>Folha ${i.payroll_ref.slice(5, 7)}/${i.payroll_ref.slice(0, 4)} vinculada</small>` : ''}</div>
    <div class="fin-row-act">
      ${i.status === 'pendente' ? html`<button type="button" class="btn btn-success btn-sm" data-pay="${i.id}">${icon('check')}Pagar</button>
        <button type="button" class="icon-btn" data-amount="${i.id}" title="Ajustar o valor previsto" aria-label="Ajustar valor">${icon('edit')}</button>`
        : html`<button type="button" class="btn btn-ghost btn-sm" data-unpay="${i.id}">Desfazer</button>`}
      ${i.task_id ? html`<a class="icon-btn" href="#/tarefas/${i.task_id}" title="Abrir a tarefa ${i.task_code}" aria-label="Abrir tarefa">${icon('chevron')}</a>` : ''}
    </div></li>`;

  const maxCat = Math.max(1, ...d.categories.map(c => c.expected));
  const paidPct = T.expected ? Math.round((T.paid / T.expected) * 100) : 0;
  return {
    title: 'Tarefas financeiras',
    html: html`
      ${pageHead({
        eyebrow: 'Acesso restrito · Gestão da Empresa',
        title: 'Tarefas financeiras',
        actions: html`${d.area_id ? html`<a class="btn btn-ghost" href="#/projetos/${d.area_id}">${icon('tasks')}Tarefas do financeiro</a>` : ''}
          <a class="btn btn-ghost" href="#/financeiro/analise">${icon('reports')}Análise comparativa</a>
          <a class="btn btn-ghost" href="#/financeiro/obrigacoes">${icon('settings')}Obrigações</a>
          <a class="btn btn-ghost" href="#/financeiro/importar">${icon('file')}Importar planilha</a>
          <a class="btn btn-accent" href="#/financeiro/obrigacoes/nova">${icon('plus')}Nova obrigação</a>`,
      })}
      <div class="fin">
        <div class="fin-month">
          <button type="button" class="btn btn-ghost btn-sm" data-mes="${addMonths(d.month, -1)}" aria-label="Mês anterior">‹</button>
          <h2>${MONTHS[m - 1]} de ${y}</h2>
          <button type="button" class="btn btn-ghost btn-sm" data-mes="${addMonths(d.month, 1)}" aria-label="Próximo mês">›</button>
          ${d.month !== d.today.slice(0, 7) ? html`<button type="button" class="btn btn-ghost btn-sm" data-mes="">Mês atual</button>` : ''}
        </div>

        <section class="card fin-hero">
          <div class="fin-hero-main"><span>Previsto no mês</span><b>${money(T.expected)}</b><small>${T.count} parcela(s) · ${T.paid_count} paga(s)</small></div>
          <div class="fin-hero-prog">
            <div class="fin-prog" role="img" aria-label="Pago ${paidPct}% do previsto"><i style="width:${paidPct}%"></i></div>
            <div class="fin-prog-l"><span><i class="k fs-paid-k"></i>Pago <b>${money(T.paid)}</b></span><span><i class="k fs-open-k"></i>A pagar <b>${money(T.open)}</b></span><b class="fin-pct">${paidPct}%</b></div>
          </div>
          <div class="fin-hero-alerts">
            <div class="fin-alert ${T.late_count ? 'is-late' : ''}">${icon('alert')}<span><small>Atrasadas</small><b>${money(T.late)}</b><small>${T.late_count} parcela(s)</small></span></div>
            <div class="fin-alert ${T.week_count ? 'is-week' : ''}">${icon('calendar')}<span><small>Próximos 7 dias</small><b>${money(T.week)}</b><small>${T.week_count} parcela(s)</small></span></div>
          </div>
        </section>

        <div class="fin-two">
          <section class="card"><div class="card-head"><h2>${icon('calendar')}Calendário de vencimentos</h2>
            <div class="fin-leg">${['atrasada', 'hoje', 'semana', 'futura', 'paga'].map(s => html`<span><i class="k ${SIT[s].cls}-k"></i>${SIT[s].label}</span>`)}</div></div>
            <div class="card-body">${cal}</div></section>
          <section class="card"><div class="card-head"><h2>${icon('reports')}Por categoria</h2><span class="sub">previsto x pago</span></div>
            <div class="card-body fin-cats">${d.categories.length ? d.categories.map(c => html`<div class="fin-cat">
              <div class="fin-cat-h"><b>${c.category}</b><span>${money(c.paid)} de ${money(c.expected)}</span></div>
              <div class="fin-cat-bar"><span style="width:${(c.expected / maxCat) * 100}%"><i style="width:${c.expected ? (c.paid / c.expected) * 100 : 0}%"></i></span></div>
              <small>${c.paid_count} de ${c.count} paga(s)</small></div>`) : html`<p class="muted" style="margin:0">Nenhuma obrigação neste mês.</p>`}</div></section>
        </div>

        <section class="card"><div class="card-head"><h2>${icon('tasks')}Vencimentos</h2><span class="sub">inclui atrasadas de meses anteriores</span></div>
          ${items.length ? groups.filter(([, , list]) => list.length).map(([k, label, list]) => html`<details class="fin-group" ${k === 'paga' ? '' : 'open'}>
            <summary>${sitBadge(k)}<b>${label}</b><span>${list.length} · ${money(list.reduce((s, i) => s + (i.status === 'paga' ? (i.paid_amount ?? i.amount_expected) : i.amount_expected), 0))}</span></summary>
            <ul class="fin-list">${list.map(row)}</ul></details>`)
            : html`<div class="card-body muted">Nenhuma parcela. Cadastre as obrigações em “Nova obrigação”.</div>`}
        </section>
      </div>`,
    mount(root) {
      const done = () => render();
      root.querySelectorAll('[data-mes]').forEach(b => b.addEventListener('click', () => { setQuery({ mes: b.dataset.mes }); render(); }));
      root.querySelectorAll('[data-pay]').forEach(b => b.addEventListener('click', () => payFlow(byId.get(Number(b.dataset.pay)), done)));
      root.querySelectorAll('[data-unpay]').forEach(b => b.addEventListener('click', () => unpayFlow(byId.get(Number(b.dataset.unpay)), done)));
      root.querySelectorAll('[data-amount]').forEach(b => b.addEventListener('click', () => amountFlow(byId.get(Number(b.dataset.amount)), done)));
      root.querySelectorAll('[data-item]').forEach(b => b.addEventListener('click', () => {
        const it = byId.get(Number(b.dataset.item));
        if (it.status === 'pendente') payFlow(it, done); else unpayFlow(it, done);
      }));
    },
  };
}

// ---------- Obrigações (cadastro) ----------
export async function obligations({ state }) {
  denied(state);
  const list = await api('/finance/obligations');
  return {
    title: 'Obrigações financeiras',
    html: html`
      ${pageHead({ back: { href: '#/financeiro', label: 'Tarefas financeiras' }, eyebrow: 'Gestão da Empresa', title: 'Obrigações financeiras',
        sub: 'Cada obrigação gera as parcelas do período (até 2 meses à frente) e a tarefa de cada parcela.',
        actions: html`<a class="btn btn-ghost" href="#/financeiro/importar">${icon('file')}Importar planilha</a><a class="btn btn-accent" href="#/financeiro/obrigacoes/nova">${icon('plus')}Nova obrigação</a>` })}
      ${list.length ? html`<section class="card"><div class="table-wrap"><table class="data ct-table"><thead><tr><th>Obrigação</th><th>Categoria</th><th>Periodicidade</th><th>Vencimento</th><th class="num">Valor</th><th>Responsável</th><th>Situação</th></tr></thead>
        <tbody>${list.map(o => html`<tr data-href="#/financeiro/obrigacoes/${o.id}/editar" tabindex="0" class="${o.active ? '' : 'is-inactive'}">
          <td><b>${o.title}</b>${o.payee ? html`<div class="t-sub">${o.payee}</div>` : ''}</td><td>${o.category}</td><td>${o.frequency_label}</td>
          <td>dia ${o.due_day}${o.next_due ? html`<div class="t-sub">próx. ${fmtDate(o.next_due)}</div>` : ''}</td>
          <td class="num">${money(o.amount)}${o.variable ? html`<div class="t-sub">variável</div>` : ''}</td><td>${o.assignee_name || '—'}</td>
          <td>${!o.active ? html`<span class="pill pill-sand">Inativa</span>` : o.overdue ? html`<span class="fs-badge fs-late">${icon('alert')}${o.overdue} atrasada(s)</span>` : html`<span class="fs-badge fs-paid">${icon('check')}Em dia</span>`}</td></tr>`)}</tbody></table></div></section>`
        : html`<div class="card empty-state"><p>Nenhuma obrigação cadastrada.</p></div>`}`,
    mount(root) {
      root.querySelectorAll('tr[data-href]').forEach(tr => tr.addEventListener('click', () => (location.hash = tr.dataset.href)));
    },
  };
}

export async function form({ params, state, navigate }) {
  denied(state);
  const editing = !!params.id;
  const [o, people, meta] = await Promise.all([
    editing ? api(`/finance/obligations/${params.id}`) : Promise.resolve(null),
    api('/finance/assignees'),
    api('/finance/month'),
  ]);
  const v = o || { frequency: 'mensal', due_day: 10, start_month: new Date().toISOString().slice(0, 7), active: 1, assignee_id: state.user.id };
  const opt = (val, label, cur) => html`<option value="${val}" ${String(cur ?? '') === String(val) ? 'selected' : ''}>${label}</option>`;
  return {
    title: editing ? `Editar ${o.title}` : 'Nova obrigação',
    html: html`
      ${pageHead({ back: { href: '#/financeiro/obrigacoes', label: 'Obrigações' }, eyebrow: 'Tarefas financeiras', title: editing ? 'Editar obrigação' : 'Nova obrigação financeira' })}
      <form class="card card-pad form" id="fo-form" novalidate style="max-width:760px">
        <div class="field"><label class="req" for="title">Descrição</label><input type="text" id="title" name="title" maxlength="160" required value="${v.title || ''}" placeholder="Ex.: DAS Simples Nacional, Aluguel do escritório, Folha de pagamento"></div>
        <div class="form-row">
          <div class="field"><label for="category">Categoria</label><input type="text" id="category" name="category" list="fo-cats" maxlength="60" value="${v.category || ''}" placeholder="Escolha ou digite">
            <datalist id="fo-cats">${meta.category_options.map(c => html`<option value="${c}"></option>`)}</datalist></div>
          <div class="field"><label for="payee">Favorecido</label><input type="text" id="payee" name="payee" maxlength="160" value="${v.payee || ''}" placeholder="Órgão, fornecedor, banco…"></div>
        </div>
        <div class="form-row form-row-3">
          <div class="field"><label class="req" for="amount">Valor previsto (R$)</label><input type="text" id="amount" name="amount" required inputmode="decimal" value="${v.amount !== undefined ? String(v.amount).replace('.', ',') : ''}" placeholder="0,00"></div>
          <div class="field"><label for="frequency">Periodicidade</label><select id="frequency" name="frequency">${Object.entries(FREQ).map(([k, l]) => opt(k, l, v.frequency))}</select></div>
          <div class="field"><label class="req" for="due_day">Dia do vencimento</label><input id="due_day" name="due_day" type="number" min="1" max="31" required value="${v.due_day}"></div>
        </div>
        <label class="switch"><input type="checkbox" name="variable" ${v.variable ? 'checked' : ''}>Valor variável (ajusto o valor de cada parcela)</label>
        <label class="switch fin-repeat" ${v.variable ? '' : 'hidden'}><input type="checkbox" name="repeat_last" ${v.repeat_last ? 'checked' : ''}>Estimar cada parcela com o valor do mês anterior (ex.: folha de pagamento, corrigida no fechamento da Folha)</label>
        <div class="form-row form-row-3">
          <div class="field"><label class="req" for="start_month">Início</label><input id="start_month" name="start_month" type="month" required value="${v.start_month}"></div>
          <div class="field"><label for="end_month">Término (opcional)</label><input id="end_month" name="end_month" type="month" value="${v.end_month || ''}"></div>
          <div class="field"><label for="assignee_id">Responsável</label><select id="assignee_id" name="assignee_id">${people.map(p => opt(p.id, p.name, v.assignee_id))}</select>
            <span class="hint">Só aparecem usuários com a liberação de Tarefas financeiras.</span></div>
        </div>
        <div class="field"><label for="notes">Observações</label><textarea id="notes" name="notes" rows="2" maxlength="2000">${v.notes || ''}</textarea></div>
        ${editing ? html`<label class="switch"><input type="checkbox" name="active" ${v.active ? 'checked' : ''}>Obrigação ativa (desmarque para parar de gerar parcelas)</label>` : ''}
        <span class="hint">As parcelas são geradas até 2 meses à frente, cada uma com a sua tarefa (responsável e prazo) na área “Financeiro (restrito)”. Alterações valem para as parcelas pendentes do mês atual em diante.</span>
        <div class="form-error" hidden></div>
        <div class="form-actions"><a class="btn btn-ghost" href="#/financeiro/obrigacoes">Cancelar</a><button class="btn btn-primary" type="submit">${icon('check')}${editing ? 'Salvar' : 'Cadastrar obrigação'}</button></div>
      </form>`,
    mount(root) {
      const f = root.querySelector('#fo-form');
      f.variable.addEventListener('change', () => { f.querySelector('.fin-repeat').hidden = !f.variable.checked; });
      f.addEventListener('submit', async e => {
        e.preventDefault();
        const data = Object.fromEntries(new FormData(f));
        data.variable = f.variable.checked;
        data.repeat_last = f.variable.checked && f.repeat_last.checked;
        if (editing) data.active = f.active.checked;
        data.amount = parseNum(data.amount);
        const err = f.querySelector('.form-error');
        err.hidden = true;
        try {
          if (editing) await api(`/finance/obligations/${o.id}`, { method: 'PUT', body: data });
          else await api('/finance/obligations', { method: 'POST', body: data });
          toast(editing ? 'Obrigação atualizada.' : 'Obrigação cadastrada. Parcelas e tarefas geradas.');
          navigate('/financeiro');
        } catch (ex) { err.textContent = ex.message; err.hidden = false; }
      });
    },
  };
}

// ---------- Análise comparativa (gastos x faturado) ----------
const GRAN_L = [['mes', 'Mensal'], ['tri', 'Trimestral'], ['sem', 'Semestral'], ['ano', 'Anual']];
const PREV_L = { mes: 'mês anterior', tri: 'trimestre anterior', sem: 'semestre anterior', ano: 'ano anterior' };
const short = v => {
  const a = Math.abs(v);
  if (a >= 1e6) return `R$ ${(v / 1e6).toLocaleString('pt-BR', { maximumFractionDigits: 1 })} mi`;
  if (a >= 1e3) return `R$ ${(v / 1e3).toLocaleString('pt-BR', { maximumFractionDigits: a >= 1e5 ? 0 : 1 })} mil`;
  return money(v);
};
const niceMax = v => { if (v <= 0) return 1000; const p = 10 ** Math.floor(Math.log10(v)); return [1, 2, 2.5, 5, 10].map(m => m * p).find(x => x >= v); };
// Variação: gastos subindo = ruim (vermelho); faturado subindo = bom (verde). Sempre com seta + número.
const varBadge = (v, upIsGood) => {
  if (v === null || v === undefined) return html`<span class="fa-var">—</span>`;
  const good = v === 0 ? null : (v > 0) === upIsGood;
  return html`<span class="fa-var ${good === null ? '' : good ? 'is-good' : 'is-bad'}">${v > 0 ? '▲' : v < 0 ? '▼' : '='} ${String(Math.abs(v)).replace('.', ',')}%</span>`;
};

function analysisChart(periods, showBilled) {
  const W = 760, H = 250, L = 72, R = 8, T = 16, B = 30;
  const iw = W - L - R, ih = H - T - B;
  const max = niceMax(Math.max(0, ...periods.flatMap(p => [p.spend, p.billed || 0])));
  const band = iw / periods.length;
  const nb = showBilled ? 2 : 1;
  const bw = Math.min(22, (band - 12) / nb);
  const y = v => T + ih - (v / max) * ih;
  const col = (x, v, cls) => {
    if (!v) return '';
    const h = Math.max(1.5, (v / max) * ih), r = Math.min(4, h, bw / 2), yb = T + ih, yt = yb - h;
    return `<path class="${cls}" d="M${x},${yb} V${yt + r} Q${x},${yt} ${x + r},${yt} H${x + bw - r} Q${x + bw},${yt} ${x + bw},${yt + r} V${yb} Z"/>`;
  };
  const step = periods.length > 8 ? 2 : 1;
  const ticks = [0, 0.25, 0.5, 0.75, 1].map(f => f * max);
  return `<svg viewBox="0 0 ${W} ${H}" class="ct-svg" role="img" aria-label="Gastos e faturado por período">
    ${ticks.map(t => `<line class="g-grid" x1="${L}" x2="${W - R}" y1="${y(t)}" y2="${y(t)}"/><text class="g-ytick" x="${L - 8}" y="${y(t) + 4}" text-anchor="end">${short(t)}</text>`).join('')}
    ${periods.map((p, i) => {
      const x0 = L + i * band + (band - (bw * nb + (nb - 1) * 2)) / 2;
      return `<g class="g-month" data-i="${i}"><rect class="g-hit" x="${L + i * band}" y="${T}" width="${band}" height="${ih + B}" tabindex="0"/>
        ${col(x0, p.spend, 'fa-spend')}${showBilled ? col(x0 + bw + 2, p.billed, 'fa-billed') : ''}
        ${(periods.length - 1 - i) % step === 0 ? `<text class="g-xtick" x="${L + i * band + band / 2}" y="${H - 10}" text-anchor="middle">${p.label}${p.partial ? '*' : ''}</text>` : ''}</g>`;
    }).join('')}
    <line class="g-base" x1="${L}" x2="${W - R}" y1="${T + ih}" y2="${T + ih}"/>
  </svg>`;
}

export async function analysis({ state, query, setQuery, render }) {
  denied(state);
  const por = query.get('por') || 'mes';
  const a = await api('/finance/analysis', { query: { por } });
  const P = a.periods;
  const closed = P.filter(p => !p.partial);
  const last = closed.at(-1) || P.at(-1);
  const cur = P.at(-1);
  const sb = a.show_billed;
  const yoy = por !== 'ano'; // no anual, o período anterior já é o ano anterior
  const card = (p, title) => html`<section class="card fa-card ${p.partial ? 'is-partial' : ''}">
    <div class="fa-card-h"><span>${title}</span><b>${p.label}${p.partial ? ' (parcial)' : ''}</b></div>
    <div class="fa-card-g">
      <div><small><i class="k fa-spend-k"></i>Gastos</small><b>${money(p.spend)}</b><span>${varBadge(p.spend_vs_prev, false)} vs ${PREV_L[por]}</span>${yoy ? html`<span>${varBadge(p.spend_vs_yoy, false)} vs mesmo período do ano anterior</span>` : ''}</div>
      ${sb ? html`<div><small><i class="k fa-billed-k"></i>Faturado</small><b>${money(p.billed)}</b><span>${varBadge(p.billed_vs_prev, true)} vs ${PREV_L[por]}</span>${yoy ? html`<span>${varBadge(p.billed_vs_yoy, true)} vs mesmo período do ano anterior</span>` : ''}</div>
        <div><small>Resultado (faturado − gastos)</small><b class="${p.result < 0 ? 'is-neg' : 'is-pos'}">${money(p.result)}</b><span>Gastos = <b>${p.spend_ratio === null ? '—' : `${String(p.spend_ratio).replace('.', ',')}%`}</b> do faturado</span></div>` : ''}
    </div></section>`;
  return {
    title: 'Análise financeira',
    html: html`
      ${pageHead({ back: { href: '#/financeiro', label: 'Tarefas financeiras' }, eyebrow: 'Gestão da Empresa', title: 'Análise comparativa',
        sub: `Gastos por competência (valor pago, ou previsto enquanto não pago)${sb ? ' x faturado (NFs emitidas em Contratos)' : ''}.` })}
      <div class="fin">
        <div class="chips" role="group" aria-label="Periodicidade">${GRAN_L.map(([k, l]) => html`<button class="chip" data-por="${k}" aria-pressed="${por === k}">${l}</button>`)}</div>
        <div class="fa-cards">${card(last, 'Último período fechado')}${cur !== last ? card(cur, 'Período atual') : ''}</div>
        <section class="card"><div class="card-head"><h2>${icon('reports')}${sb ? 'Gastos x faturado' : 'Gastos'} por período</h2><span class="sub">* período em andamento</span></div>
          <div class="card-body">
            ${sb ? html`<ul class="ct-legend"><li><i class="k fa-spend-k"></i>Gastos</li><li><i class="k fa-billed-k"></i>Faturado</li></ul>` : ''}
            <div class="ct-chart-box">${raw(analysisChart(P, sb))}<div class="ct-tip" hidden></div></div>
            <div class="table-wrap"><table class="data ct-table fa-table"><thead><tr><th>Período</th><th class="num">Gastos</th><th class="num">vs anterior</th>${yoy ? html`<th class="num">vs ano anterior</th>` : ''}
              ${sb ? html`<th class="num">Faturado</th><th class="num">vs anterior</th>${yoy ? html`<th class="num">vs ano anterior</th>` : ''}<th class="num">Resultado</th><th class="num">Gastos/Faturado</th>` : ''}</tr></thead>
              <tbody>${[...P].reverse().map(p => html`<tr class="${p.partial ? 'is-cur' : ''}"><td><b>${p.label}</b>${p.partial ? html` <small class="muted">(parcial)</small>` : ''}</td>
                <td class="num">${money(p.spend)}</td><td class="num">${varBadge(p.spend_vs_prev, false)}</td>${yoy ? html`<td class="num">${varBadge(p.spend_vs_yoy, false)}</td>` : ''}
                ${sb ? html`<td class="num">${money(p.billed)}</td><td class="num">${varBadge(p.billed_vs_prev, true)}</td>${yoy ? html`<td class="num">${varBadge(p.billed_vs_yoy, true)}</td>` : ''}
                  <td class="num ${p.result < 0 ? 'is-neg' : ''}">${money(p.result)}</td><td class="num">${p.spend_ratio === null ? '—' : `${String(p.spend_ratio).replace('.', ',')}%`}</td>` : ''}</tr>`)}</tbody></table></div>
            ${!sb ? html`<p class="muted" style="font-size:12.5px;margin:10px 0 0">O faturado aparece para quem também tem a liberação de Contratos.</p>` : ''}
          </div></section>
        <section class="card"><div class="card-head"><h2>${icon('tasks')}Gastos por categoria</h2><span class="sub">${a.current} x ${a.previous}${yoy ? ` x ${a.last_year}` : ''}</span></div>
          ${a.categories.length ? html`<div class="table-wrap"><table class="data ct-table fa-table"><thead><tr><th>Categoria</th><th class="num">${a.current}</th><th class="num">${a.previous}</th><th class="num">Variação</th>${yoy ? html`<th class="num">${a.last_year}</th><th class="num">Variação</th>` : ''}</tr></thead>
            <tbody>${a.categories.map(c => html`<tr><td>${c.category}</td><td class="num"><b>${money(c.current)}</b></td><td class="num">${money(c.previous)}</td><td class="num">${varBadge(c.vs_prev, false)}</td>${yoy ? html`<td class="num">${money(c.last_year)}</td><td class="num">${varBadge(c.vs_yoy, false)}</td>` : ''}</tr>`)}</tbody></table></div>`
            : html`<div class="card-body muted">Sem gastos nos períodos comparados.</div>`}
        </section>
      </div>`,
    mount(root) {
      root.querySelectorAll('[data-por]').forEach(b => b.addEventListener('click', () => { setQuery({ por: b.dataset.por }); render(); }));
      const box = root.querySelector('.ct-chart-box');
      const tip = box.querySelector('.ct-tip');
      const show = g => {
        const p = P[Number(g.dataset.i)];
        box.querySelectorAll('.g-month.is-on').forEach(x => x.classList.remove('is-on'));
        g.classList.add('is-on');
        tip.replaceChildren();
        const h = document.createElement('div'); h.className = 'ct-tip-h'; h.textContent = p.label + (p.partial ? ' (parcial)' : ''); tip.appendChild(h);
        const rows = [['Gastos', p.spend, 'fa-spend'], ...(sb ? [['Faturado', p.billed, 'fa-billed'], ['Resultado', p.result, '']] : [])];
        for (const [l, v, cls] of rows) {
          const r = document.createElement('div'); r.className = 'ct-tip-r';
          const k = document.createElement('i'); k.className = `ln ${cls}`;
          const b = document.createElement('b'); b.textContent = money(v);
          const s = document.createElement('span'); s.textContent = l;
          r.append(k, b, s); tip.appendChild(r);
        }
        tip.hidden = false;
        const br = box.getBoundingClientRect(), gr = g.querySelector('.g-hit').getBoundingClientRect();
        tip.style.left = `${Math.min(br.width - tip.offsetWidth - 4, Math.max(4, gr.left - br.left + gr.width / 2 - tip.offsetWidth / 2))}px`;
      };
      box.querySelectorAll('.g-month').forEach(g => { g.addEventListener('pointerenter', () => show(g)); g.querySelector('.g-hit').addEventListener('focus', () => show(g)); });
      box.addEventListener('pointerleave', () => { tip.hidden = true; box.querySelectorAll('.g-month.is-on').forEach(x => x.classList.remove('is-on')); });
    },
  };
}
