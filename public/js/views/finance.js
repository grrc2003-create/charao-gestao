// Tarefas financeiras (liberação por usuário): obrigações mensais/periódicas, parcelas Pendente → Paga,
// calendário do mês, lista por vencimento e resumo por categoria.
import { html, api, icon, fmtDate } from '../core.js';
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
  const r = await sheet({
    title: `Valor previsto · ${it.title}`, submitLabel: 'Salvar',
    body: html`<div class="field"><label class="req" for="fa-v">Valor previsto desta parcela (R$)</label><input id="fa-v" name="amount_expected" required inputmode="decimal" value="${String(it.amount_expected).replace('.', ',')}"></div>`,
    onSubmit: d => api(`/finance/items/${it.id}/amount`, { method: 'PUT', body: { amount_expected: parseNum(d.amount_expected) } }),
  });
  if (r) { toast('Valor atualizado.'); done(); }
}

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
    <div class="fin-row-val"><b>${money(i.status === 'paga' ? (i.paid_amount ?? i.amount_expected) : i.amount_expected)}</b>${i.status === 'paga' ? html`<small>pago em ${fmtDate(i.paid_date)}</small>` : i.variable ? html`<small>valor variável</small>` : ''}</div>
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
          <a class="btn btn-ghost" href="#/financeiro/obrigacoes">${icon('settings')}Obrigações</a>
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
        actions: html`<a class="btn btn-accent" href="#/financeiro/obrigacoes/nova">${icon('plus')}Nova obrigação</a>` })}
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
        <div class="field"><label class="req" for="title">Descrição</label><input id="title" name="title" maxlength="160" required value="${v.title || ''}" placeholder="Ex.: DAS Simples Nacional, Aluguel do escritório, Folha de pagamento"></div>
        <div class="form-row">
          <div class="field"><label for="category">Categoria</label><input id="category" name="category" list="fo-cats" maxlength="60" value="${v.category || ''}" placeholder="Escolha ou digite">
            <datalist id="fo-cats">${meta.category_options.map(c => html`<option value="${c}"></option>`)}</datalist></div>
          <div class="field"><label for="payee">Favorecido</label><input id="payee" name="payee" maxlength="160" value="${v.payee || ''}" placeholder="Órgão, fornecedor, banco…"></div>
        </div>
        <div class="form-row form-row-3">
          <div class="field"><label class="req" for="amount">Valor previsto (R$)</label><input id="amount" name="amount" required inputmode="decimal" value="${v.amount !== undefined ? String(v.amount).replace('.', ',') : ''}" placeholder="0,00"></div>
          <div class="field"><label for="frequency">Periodicidade</label><select id="frequency" name="frequency">${Object.entries(FREQ).map(([k, l]) => opt(k, l, v.frequency))}</select></div>
          <div class="field"><label class="req" for="due_day">Dia do vencimento</label><input id="due_day" name="due_day" type="number" min="1" max="31" required value="${v.due_day}"></div>
        </div>
        <label class="switch"><input type="checkbox" name="variable" ${v.variable ? 'checked' : ''}>Valor variável (ajusto o valor de cada parcela)</label>
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
      f.addEventListener('submit', async e => {
        e.preventDefault();
        const data = Object.fromEntries(new FormData(f));
        data.variable = f.variable.checked;
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
