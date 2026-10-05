// Bloco "Prazos e repactuação": indicadores de atraso e de constância das repactuações.
// Reutilizado no Dashboard, no painel do projeto e na tela do usuário.
import { html, icon, fmtPct } from '../core.js';
import { kpi, STATUS_COLOR } from './shared.js';

const MONTHS = ['jan', 'fev', 'mar', 'abr', 'mai', 'jun', 'jul', 'ago', 'set', 'out', 'nov', 'dez'];
const n1 = v => String(v ?? 0).replace('.', ',');
const ORANGE = '#C9520F';
const RESCHED_SERIES = '#7A5BB8'; // validado contra o vermelho de atraso (inclusive daltonismo)

// Semáforo com faixas fixas (rótulo + símbolo, nunca só cor)
export function level(kind, s) {
  if (!s.with_due) return null;
  if (kind === 'late') return s.late_rate <= 15 ? 'bom' : s.late_rate <= 30 ? 'atencao' : 'critico';
  if (kind === 'corrective') return !s.reschedules || s.corrective_pct <= 30 ? 'bom' : s.corrective_pct <= 50 ? 'atencao' : 'critico';
  if (kind === 'chronic') { const p = (s.chronic / s.with_due) * 100; return !s.chronic ? 'bom' : p <= 5 ? 'atencao' : 'critico'; }
  return null;
}
const LEVEL = { bom: ['●', 'Bom'], atencao: ['▲', 'Atenção'], critico: ['■', 'Crítico'] };
export const signal = l => (l ? html`<span class="signal sig-${l}"><i aria-hidden="true">${LEVEL[l][0]}</i>${LEVEL[l][1]}</span>` : '');

export function deadlineKpis(s, chronicMin = 3) {
  return html`<div class="kpis kpis-dl">
    ${kpi({ label: html`Ficaram atrasadas ${signal(level('late', s))}`, value: fmtPct(s.late_rate ?? 0), color: STATUS_COLOR.atrasada,
      foot: `${s.ever_late} de ${s.with_due} tarefas com prazo, ao menos 1 vez` })}
    ${kpi({ label: 'Episódios de atraso', value: s.late_episodes, color: STATUS_COLOR.atrasada, foot: `média ${n1(s.late_episodes_avg)} por tarefa` })}
    ${kpi({ label: 'Taxa de repactuação', value: fmtPct(s.reschedule_rate ?? 0), color: ORANGE,
      foot: `${s.rescheduled} tarefa(s) · ${s.reschedules} reagendamento(s)` })}
    ${kpi({ label: html`Repactuação corretiva ${signal(level('corrective', s))}`, value: fmtPct(s.corrective_pct ?? 0), color: ORANGE,
      foot: `${s.corrective} após vencer · ${s.preventive} antes` })}
    ${kpi({ label: html`Tarefas crônicas ${signal(level('chronic', s))}`, value: s.chronic, color: '#707E8B',
      foot: `${chronicMin}+ reagendamentos · +${s.days_added} dia(s) acrescidos` })}
    ${kpi({ label: 'Pontualidade real × repactuada', value: fmtPct(s.on_time_original_pct), color: STATUS_COLOR.concluida,
      foot: `contra o prazo original · ${fmtPct(s.on_time_pct)} contra o vigente` })}
  </div>`;
}

// Distribuição: quantas tarefas foram reagendadas 0, 1, 2, 3+ vezes
export function distBar(s) {
  const d = s.reschedule_dist || { r0: 0, r1: 0, r2: 0, r3: 0 };
  const total = d.r0 + d.r1 + d.r2 + d.r3;
  if (!total) return '';
  const seg = [['r0', 'Nenhuma', '#D6DCE2'], ['r1', '1 vez', '#F3B48A'], ['r2', '2 vezes', '#E07A3A'], ['r3', '3+ vezes', '#A8430C']];
  return html`<div class="dl-dist">
    <div class="sub-label">Reagendamentos por tarefa</div>
    <div class="stackbar dl-stack">${seg.filter(([k]) => d[k]).map(([k, l, c]) => html`<span style="--c:${c};flex:${d[k] / total}" data-tip="${l}: ${d[k]} tarefa(s)"></span>`)}</div>
    <div class="dl-legend">${seg.map(([k, l, c]) => html`<span><i style="background:${c}"></i>${l} <b>${d[k]}</b></span>`)}</div>
  </div>`;
}

// Evolução mensal (mês do prazo original): % que atrasou e % repactuada
export function trendChart(trend) {
  if (!trend?.some(m => m.total)) return html`<div class="muted" style="font-size:13px">Sem tarefas com prazo nos últimos meses.</div>`;
  const lab = m => `${MONTHS[Number(m.slice(5, 7)) - 1]}/${m.slice(2, 4)}`;
  return html`<div class="dl-trend">
    <div class="sub-label">Evolução mensal (pelo mês do prazo original)</div>
    <div class="dl-legend"><span><i style="background:${STATUS_COLOR.atrasada}"></i>Ficaram atrasadas</span><span><i style="background:${RESCHED_SERIES}"></i>Repactuadas</span></div>
    <div class="dl-months">${trend.map(m => html`<div class="dl-month" data-tip="${lab(m.month)}: ${m.total} tarefa(s) · ${m.ever_late} atrasaram · ${m.rescheduled} repactuadas">
      <div class="dl-bars">
        <span class="dl-bar" style="height:${m.late_rate || 0}%;--c:${STATUS_COLOR.atrasada}"><em>${m.total ? `${Math.round(m.late_rate || 0)}%` : ''}</em></span>
        <span class="dl-bar" style="height:${m.reschedule_rate || 0}%;--c:${RESCHED_SERIES}"><em>${m.total ? `${Math.round(m.reschedule_rate || 0)}%` : ''}</em></span>
      </div>
      <div class="dl-mlabel">${lab(m.month)}<small>${m.total}</small></div></div>`)}</div>
  </div>`;
}

export const howToRead = chronicMin => html`<details class="dl-help"><summary>${icon('info')} Como ler estes indicadores</summary>
  <ul>
    <li><b>Ficaram atrasadas:</b> % das tarefas com prazo que passaram do prazo vigente ao menos uma vez — inclusive as que depois foram repactuadas ou entregues.</li>
    <li><b>Episódio de atraso:</b> cada repactuação feita com o prazo já vencido, a entrega após o prazo e o atraso atual contam 1.</li>
    <li><b>Preventiva × corretiva:</b> preventiva = prazo reagendado antes de vencer (planejamento); corretiva = reagendado depois de vencer (cobre um atraso).</li>
    <li><b>Crônica:</b> tarefa reagendada ${chronicMin} vezes ou mais (ajustável em Configurações).</li>
    <li><b>Pontualidade real × repactuada:</b> % das entregas feitas até o prazo original × até o prazo vigente. A diferença mostra quanto a repactuação “melhora” o indicador.</li>
    <li><b>Semáforo:</b> atraso ≤15% bom, ≤30% atenção; corretivas ≤30% bom, ≤50% atenção; crônicas: nenhuma = bom, até 5% = atenção.</li>
  </ul></details>`;

export function deadlineSection(s, trend, { chronicMin = 3, title = 'Prazos e repactuação', sub = '', extra = '' } = {}) {
  return html`<section class="card section">
    <div class="card-head"><h2>${icon('reschedule')}${title}</h2><span class="sub">${sub}</span></div>
    <div class="card-body dl-body">
      ${deadlineKpis(s, chronicMin)}
      <div class="grid grid-2">${distBar(s) || html`<div></div>`}${trendChart(trend)}</div>
      ${extra}
      ${howToRead(chronicMin)}
    </div>
  </section>`;
}

// Tabela comparativa (por responsável ou por classificação)
export function deadlineTable(rows, labelHead) {
  if (!rows.length) return '';
  return html`<div class="table-wrap"><table class="data dl-table"><thead><tr><th>${labelHead}</th><th class="num">Com prazo</th>
    <th class="num">Ficaram atrasadas</th><th class="num">Repactuação</th><th class="num">Corretiva</th><th class="num">Crônicas</th><th class="num">Pont. real</th></tr></thead>
    <tbody>${rows.map(r => html`<tr style="cursor:${r.href ? 'pointer' : 'default'}" ${r.href ? html`data-href="${r.href}" tabindex="0"` : ''}>
      <td><b>${r.label}</b></td><td class="num">${r.s.with_due}</td>
      <td class="num">${fmtPct(r.s.late_rate ?? 0)} ${signal(level('late', r.s))}</td>
      <td class="num">${fmtPct(r.s.reschedule_rate ?? 0)}</td>
      <td class="num">${r.s.reschedules ? fmtPct(r.s.corrective_pct) : '—'}</td>
      <td class="num">${r.s.chronic}</td>
      <td class="num">${fmtPct(r.s.on_time_original_pct)}</td></tr>`)}</tbody></table></div>`;
}
