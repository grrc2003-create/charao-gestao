// Tarefas financeiras › Planejamento anual: tarefas (pontuais ou recorrentes) x 12 meses, previsto e real.
// Clique na célula: ajusta o previsto do mês e/ou lança o real (data e comprovante opcional).
// No celular: um mês por vez, com a lista das tarefas do mês.
import { html, api, icon, fmtDate } from '../core.js';
import { toast, sheet, confirmSheet, readAttachments } from '../ui.js';
import { pageHead } from './shared.js';

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

export async function view({ state, query, setQuery, render }) {
  if (!state.meta.can.finance) throw new Error('Acesso restrito: solicite ao administrador a liberação de Tarefas financeiras (Usuários → Editar).');
  const [d, wk] = await Promise.all([api('/finance/year', { query: { ano: query.get('ano') || '' } }), api('/finance/week').catch(() => null)]);
  const wItems = wk?.items || [];
  const al = wk?.alerts || { accounts: [], categories: [] };
  const weekCard = !wk ? '' : html`<section class="card section fw-card">
      <div class="card-head"><h2>${icon('alert')}Contas da semana</h2><span class="sub">até ${fmtDate(wk.week_end)}${wk.data_until ? ` · Mais Controle até ${fmtDate(wk.data_until)}` : ''}</span></div>
      ${al.accounts.length || al.categories.length || al.reviews ? html`<a class="fw-alert" href="#/financeiro/mais-controle">${icon('alert')}<span><b>Mais Controle:</b>
        ${[...al.accounts.map(a => `custo de ${money(a.total)} na conta ${a.label} (não cadastrada: ${a.categories.map(c => c.label).join(', ')})`),
          al.categories.length ? `${al.categories.length} categoria(s) sem tarefa (${money(al.categories.reduce((s, c) => s + c.total, 0))}): cadastre para trazer` : '',
          al.reviews ? `${al.reviews} despesa(s) em categoria diferente da habitual: confira a alocação` : ''].filter(Boolean).join(' · ')}</span></a>` : ''}
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
  const qm = query.get('m');
  let mobMonth = qm !== null && qm !== '' && Number(qm) >= 0 && Number(qm) <= 11 ? Number(qm) : curIdx >= 0 ? curIdx : 0;
  const rowsById = new Map(d.groups.flatMap(g => g.rows).map(r => [r.id, r]));
  const realToDate = d.month_totals.filter(m => m.ym <= d.current).reduce((s, m) => s + m.real, 0);
  const execPct = T.planned_to_date ? Math.round((realToDate / T.planned_to_date) * 100) : 0;

  const mobileMonth = k => {
    const m = d.month_totals[k];
    return html`<div class="fy-mnav"><button type="button" class="icon-btn" data-mm="-1" aria-label="Mês anterior" ${k === 0 ? 'disabled' : ''}>‹</button>
        <b>${MESES[k]} ${d.year}</b><button type="button" class="icon-btn" data-mm="1" aria-label="Próximo mês" ${k === 11 ? 'disabled' : ''}>›</button></div>
      <div class="fy-mtot"><span>Previsto <b>${money(m.planned)}</b></span><span>Real <b>${money(m.real)}</b></span><span>${m.paid} de ${m.count} pago(s)</span></div>
      ${d.groups.map(g => {
        const rows = g.rows.filter(r => r.cells[k]);
        if (!rows.length) return '';
        return html`<div class="fy-mgrp"><h3>${g.category}</h3>${rows.map(r => { const c = r.cells[k];
          return html`<button type="button" class="fy-mrow is-${c.status}" data-o="${r.id}" data-i="${k}">
            <span class="fy-mrow-t"><b>${r.title}</b><small>vence ${fmtDate(c.due_date)} · ${r.frequency_label}</small></span>
            <span class="fy-mrow-v"><small>previsto ${money(c.planned)}</small>${c.status === 'pago' ? html`<b class="ok">✓ ${money(c.real)}</b>` : html`<em class="fy-st">${ST[c.status]}</em>`}</span></button>`; })}</div>`;
      })}`;
  };

  return {
    title: 'Tarefas financeiras',
    html: html`${pageHead({ eyebrow: 'Acesso restrito · Gestão da Empresa', title: 'Tarefas financeiras',
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
      ${weekCard}
      <section class="card fy-card">
        <div class="card-head"><h2>${icon('calendar')}Planejamento anual ${d.year}</h2><span class="sub">previsto × real, mês a mês</span></div>
        <div class="fy-legend"><span><i class="fy-k is-pago"></i>Pago (real)</span><span><i class="fy-k is-atrasada"></i>Atrasada</span><span><i class="fy-k is-pendente"></i>A pagar</span><span><i class="fy-k is-aguardando"></i>Paguei (aguardando Mais Controle)</span><span><i class="fy-k is-nao_ocorreu"></i>Não ocorreu (real 0)</span><span><i class="fy-k is-projetado"></i>Previsto (projetado)</span><span><i class="fy-k is-custom"></i>Previsto ajustado no mês</span></div>
        <div class="fy-wrap"><table class="fy">
          <thead><tr><th class="fy-name">Tarefa</th>${MES.map((m, i) => html`<th class="${i === curIdx ? 'is-cur' : ''}">${m}</th>`)}<th class="fy-tot">Ano</th></tr></thead>
          ${d.groups.map(g => html`<tbody>
            <tr class="fy-grp"><th class="fy-name">${g.category}<small>${g.rows.length}</small></th>${g.months.map((m, i) => html`<td class="${i === curIdx ? 'is-cur' : ''}"><span>${m.planned ? short(m.planned) : ''}</span>${m.real ? html`<span class="ok">✓ ${short(m.real)}</span>` : ''}</td>`)}
              <td class="fy-tot"><span>${short(g.planned)}</span>${g.real ? html`<span class="ok">✓ ${short(g.real)}</span>` : ''}</td></tr>
            ${g.rows.map(r => html`<tr class="${r.active ? '' : 'is-inactive'}"><th class="fy-name"><a href="#/financeiro/obrigacoes/${r.id}/editar" title="Editar a tarefa">${r.title}</a><small>${r.frequency_label} · dia ${r.due_day}${r.variable ? ' · variável' : ''}</small></th>
              ${r.cells.map((c, i) => cellHtml(r, c, i, i === curIdx))}
              <td class="fy-tot"><span>${short(r.planned)}</span>${r.real ? html`<span class="ok">✓ ${short(r.real)}</span>` : ''}</td></tr>`)}
          </tbody>`)}
          <tfoot>
            <tr><th class="fy-name">Previsto</th>${d.month_totals.map((m, i) => html`<td class="${i === curIdx ? 'is-cur' : ''}">${m.planned ? short(m.planned) : '—'}</td>`)}<td class="fy-tot">${short(T.planned)}</td></tr>
            <tr class="fy-real"><th class="fy-name">Real</th>${d.month_totals.map((m, i) => html`<td class="${i === curIdx ? 'is-cur' : ''}">${m.real ? short(m.real) : '—'}</td>`)}<td class="fy-tot">${short(T.real)}</td></tr>
          </tfoot>
        </table></div>
      </section>
      <section class="card fy-mob" data-fy-mob>${mobileMonth(mobMonth)}</section>
      ${d.projects?.length ? html`<section class="card section fy-proj">
        <div class="card-head"><h2>${icon('projects')}Custos destinados a Projetos</h2><span class="sub">Mais Controle · centros de custo diferentes de Empresa · ${money(d.projects.reduce((s, p) => s + p.total, 0))}</span></div>
        <div class="fy-wrap"><table class="fy fy-projt"><thead><tr><th class="fy-name">Centro de custo</th>${MES.map((m, i) => html`<th class="${i === curIdx ? 'is-cur' : ''}">${m}</th>`)}<th class="fy-tot">Ano</th></tr></thead>
          <tbody>${d.projects.map(p => html`<tr><th class="fy-name">${p.cost_center}<small>${p.count} pagamento(s)</small></th>${p.months.map((v, i) => html`<td class="${i === curIdx ? 'is-cur' : ''}"><span class="fy-dash">${v ? short(v) : '—'}</span></td>`)}<td class="fy-tot">${short(p.total)}</td></tr>`)}</tbody></table></div>
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
      root.querySelectorAll('.fy-card, [data-fy-mob]').forEach(el => el.addEventListener('click', onCell));
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
