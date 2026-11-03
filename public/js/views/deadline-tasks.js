// Tarefas que entram nos indicadores de prazo (clique nas barras do bloco "Prazos e repactuação"), com o motivo de cada atraso.
import { html, api, icon, fmtDate, STATUS } from '../core.js';
import { pageHead, STATUS_COLOR } from './shared.js';

const MONTHS = ['jan', 'fev', 'mar', 'abr', 'mai', 'jun', 'jul', 'ago', 'set', 'out', 'nov', 'dez'];
const monthLabel = m => `${MONTHS[Number(m.slice(5, 7)) - 1]}/${m.slice(2, 4)}`;
const VIEW = {
  atrasadas: 'Ficaram atrasadas', repactuadas: 'Repactuadas', todas: 'Todas com prazo',
  r0: 'Nenhum reagendamento', r1: 'Reagendadas 1 vez', r2: 'Reagendadas 2 vezes', r3: 'Reagendadas 3 vezes ou mais',
};
const KIND = { item: 'Item de check-list', checklist: 'Check-list', subtarefa: 'Subtarefa', tarefa: 'Tarefa' };
const days = n => `${n} ${n === 1 ? 'dia' : 'dias'}`;
const times = n => `${n} ${n === 1 ? 'vez' : 'vezes'}`;
// Causas na ordem em que ajudam a entender o atraso
const CAUSE = {
  vencida: { label: 'Em aberto e vencida', text: r => `Ainda em aberto: venceu em ${fmtDate(r.due)}, há ${days(r.days)}.` },
  entrega: { label: 'Entregue depois do prazo', text: r => `Entregue em ${fmtDate(r.date)}, ${days(r.days)} depois do prazo (${fmtDate(r.due)}).` },
  corretiva: { label: 'Reagendada depois de vencer', text: r => `Reagendada ${times(r.n)} com o prazo já vencido.` },
  cadastro: { label: 'Cadastrada depois do prazo', text: r => `Cadastrada no sistema em ${fmtDate(r.date)}, quando o prazo (${fmtDate(r.due)}) já tinha passado.` },
  preventiva: { label: 'Reagendada antes de vencer', text: r => `Reagendada ${times(r.n)} antes de vencer.` },
};

export async function view({ query }) {
  const scope = query.get('scope') || 'empresa';
  const id = query.get('id') || '';
  const month = query.get('mes') || '';
  const ver = query.get('ver') || 'atrasadas';
  const d = await api('/deadlines/tasks', { query: { scope, id, mes: month, ver } });
  const title = `${VIEW[ver] || 'Tarefas'}${month ? ` · ${monthLabel(month)}` : ''}`;
  const back = scope === 'projeto' ? { href: `#/projetos/${id}`, label: 'Projeto' } : scope === 'usuario' ? { href: `#/usuarios/${id}`, label: 'Usuário' } : { href: '#/empresa', label: 'Visão da empresa' };
  const causes = Object.keys(CAUSE).map(k => [k, d.items.filter(t => t.reasons.some(r => r.code === k)).length]).filter(([, n]) => n);
  const items = d.items.filter(t => t.kind === 'item').length;
  const base = `${d.items.length} de ${d.base} ${d.base === 1 ? 'tarefa' : 'tarefas'}${month ? ` com prazo original em ${monthLabel(month)}` : ' com prazo'}`;
  return {
    title,
    html: html`
      ${pageHead({ back, eyebrow: 'Prazos e repactuação', title, sub: `${base}. Mesma conta do gráfico.${items ? ` Inclui ${items} ${items === 1 ? 'item' : 'itens'} de check-list, que contam como tarefa.` : ''}` })}
      ${causes.length ? html`<div class="chips dt-causes" role="group" aria-label="Filtrar por motivo">
        <button type="button" class="chip" data-cause="" aria-pressed="true">Todos os motivos<span class="n">${d.items.length}</span></button>
        ${causes.map(([k, n]) => html`<button type="button" class="chip" data-cause="${k}" aria-pressed="false">${CAUSE[k].label}<span class="n">${n}</span></button>`)}
      </div>
      ${causes.length > 1 ? html`<p class="hint dt-note">A mesma tarefa pode ter mais de um motivo.</p>` : ''}` : ''}
      <section class="card section">
        ${d.items.length ? html`<ul class="rows dt-list">${d.items.map(t => html`<li data-causes="${t.reasons.map(r => r.code).join(' ')}"><a class="row-link" href="${t.href}"><div class="grow">
            <div class="row-title"><span class="mono muted" style="font-size:12px">${t.code}</span> ${t.title}</div>
            <div class="dt-meta muted">${KIND[t.kind]} · ${t.project_code} · ${t.assignee_name || 'Sem responsável'} · Prazo ${t.due ? fmtDate(t.due) : '—'}${t.original_due && t.original_due !== t.due ? ` (original ${fmtDate(t.original_due)})` : ''} · <span style="color:${STATUS_COLOR[t.status]}">${STATUS[t.status]?.label || t.status}</span></div>
            ${t.reasons.length ? html`<ul class="dt-why">${t.reasons.map(r => html`<li class="is-${r.code}">${CAUSE[r.code].text(r)}</li>`)}</ul>` : ''}
          </div><span class="chev">${icon('chevron')}</span></a></li>`)}</ul>` : html`<div class="card-body muted">Nenhuma tarefa neste recorte.</div>`}
      </section>`,
    mount(root) {
      const chips = [...root.querySelectorAll('[data-cause]')];
      chips.forEach(c => c.addEventListener('click', () => {
        chips.forEach(x => x.setAttribute('aria-pressed', String(x === c)));
        root.querySelectorAll('.dt-list > li').forEach(li => { li.hidden = !!c.dataset.cause && !li.dataset.causes.split(' ').includes(c.dataset.cause); });
      }));
    },
  };
}
