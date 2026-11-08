// Alertas dos indicadores do projeto: cada projeto define limites de atenção e crítico por indicador.
import { html, api, icon } from '../core.js';
import { toast, sheet } from '../ui.js';

const pct = (n, t) => (t ? Math.round((n / t) * 1000) / 10 : 0);
const fmt = (v, unit) => (v === null || v === undefined ? '—' : `${String(Math.round(v * 10) / 10).replace('.', ',')}${unit === '%' ? '%' : unit ? ` ${unit}` : ''}`);
// dir: 'max' = alerta quando chega ao limite ou passa; 'min' = quando cai até o limite ou abaixo
export const INDICATORS = [
  { key: 'atrasadas', label: 'Tarefas atrasadas', unit: '', dir: 'max', get: p => p.summary.late },
  { key: 'atraso_medio', label: 'Atraso médio', unit: 'dias', dir: 'max', get: p => p.summary.avg_delay_days ?? 0 },
  { key: 'vencem_7d', label: 'Tarefas vencendo em 7 dias', unit: '', dir: 'max', get: p => p.summary.due_soon },
  { key: 'em_conferencia', label: 'Aguardando conferência', unit: '', dir: 'max', get: p => p.summary.review },
  { key: 'no_prazo', label: 'Entregas no prazo', unit: '%', dir: 'min', get: p => (p.summary.delivered ? p.summary.on_time_pct : null) },
  { key: 'conclusao', label: 'Conclusão do projeto', unit: '%', dir: 'min', get: p => p.summary.completion_pct ?? 0 },
  { key: 'exec_media', label: 'Média de execução', unit: 'dias úteis', dir: 'max', get: p => p.summary.exec_work_days_avg ?? null },
  { key: 'atraso_preenchimento', label: 'Atraso de preenchimento', unit: '', dir: 'max', get: p => p.summary.filling_delays ?? 0 },
  { key: 'cot_tres_pct', label: 'Itens de cotação com 3+ propostas', unit: '%', dir: 'min', quotes: true, get: (p, q) => (q?.items ? pct(q.buckets.tres, q.items) : null) },
  { key: 'cot_sem', label: 'Itens de cotação sem proposta', unit: '', dir: 'max', quotes: true, get: (p, q) => (q?.items ? q.buckets.nenhuma : null) },
  { key: 'cot_vencidas', label: 'Solicitações de cotação vencidas', unit: '', dir: 'max', quotes: true, get: (p, q) => (q?.items ? q.requests.vencida : null) },
];
const hit = (dir, v, lim) => lim !== null && lim !== undefined && v !== null && v !== undefined && (dir === 'max' ? v >= lim : v <= lim);

// Avalia os limites: [{ key, label, value, level: 'crit'|'warn', limit, text }]
export function evaluateAlerts(p, quotes, conf) {
  const by = new Map((conf?.alerts || []).map(a => [a.indicator, a]));
  const out = [];
  for (const ind of INDICATORS) {
    const a = by.get(ind.key);
    if (!a || (ind.quotes && !quotes?.enabled)) continue;
    const v = ind.get(p, quotes);
    const level = hit(ind.dir, v, a.crit) ? 'crit' : hit(ind.dir, v, a.warn) ? 'warn' : null;
    if (!level) continue;
    const limit = level === 'crit' ? a.crit : a.warn;
    out.push({ key: ind.key, label: ind.label, value: v, level, limit, text: `${fmt(v, ind.unit)} (${level === 'crit' ? 'crítico' : 'atenção'}: ${ind.dir === 'max' ? '≥' : '≤'} ${fmt(limit, ind.unit)})` });
  }
  return out.sort((x, y) => (x.level === y.level ? 0 : x.level === 'crit' ? -1 : 1));
}
export const alertMap = list => Object.fromEntries(list.map(a => [a.key, a]));

export function alertsBanner(list, conf, canEdit) {
  const n = (conf?.alerts || []).length;
  if (!list.length) return n ? html`<div class="pa-ok section">${icon('check')}<span>${n} alerta(s) configurado(s) · todos os indicadores dentro dos limites.</span>${canEdit ? html`<button type="button" class="btn btn-ghost btn-sm" data-pa-edit>Alertas</button>` : ''}</div>` : '';
  return html`<section class="pa-banner section ${list.some(a => a.level === 'crit') ? 'is-crit' : 'is-warn'}" aria-label="Alertas do projeto">
    <div class="pa-head">${icon('alert')}<b>${list.length} alerta(s) nos indicadores do projeto</b>${canEdit ? html`<button type="button" class="btn btn-ghost btn-sm" data-pa-edit>Configurar alertas</button>` : ''}</div>
    <ul>${list.map(a => html`<li class="pa-${a.level}"><span class="pa-lv">${a.level === 'crit' ? 'Crítico' : 'Atenção'}</span><b>${a.label}</b> ${a.text}</li>`)}</ul></section>`;
}

export async function alertsSheet(p, quotes, conf, done) {
  const by = new Map((conf?.alerts || []).map(a => [a.indicator, a]));
  const list = INDICATORS.filter(i => !i.quotes || quotes?.enabled);
  const r = await sheet({
    title: `Alertas dos indicadores · ${p.code}`, wide: true,
    body: html`<p class="muted" style="margin-top:0">Defina, para este projeto, quando cada indicador deve chamar atenção. Em branco, o indicador fica sem alerta. Os cards do projeto ficam amarelos (atenção) ou vermelhos (crítico) e os alertas aparecem no topo da página.</p>
      <div class="table-wrap"><table class="data pa-table"><thead><tr><th>Indicador</th><th>Alerta quando</th><th class="num">Atenção</th><th class="num">Crítico</th><th class="num">Hoje</th></tr></thead>
        <tbody>${list.map(i => { const a = by.get(i.key) || {}; return html`<tr><td>${i.label}</td><td class="muted">${i.dir === 'max' ? 'chegar a / passar de' : 'cair para / abaixo de'}${i.unit ? ` (${i.unit})` : ''}</td>
          <td class="num"><input type="text" inputmode="decimal" data-pa-w="${i.key}" value="${a.warn ?? ''}" aria-label="${i.label}: atenção"></td>
          <td class="num"><input type="text" inputmode="decimal" data-pa-c="${i.key}" value="${a.crit ?? ''}" aria-label="${i.label}: crítico"></td>
          <td class="num">${fmt(i.get(p, quotes), i.unit)}</td></tr>`; })}</tbody></table></div>`,
    submitLabel: 'Salvar alertas',
    onSubmit: (_d, form) => api(`/projects/${p.id}/alerts`, { method: 'PUT', body: { alerts: list.map(i => ({ indicator: i.key, warn: form.querySelector(`[data-pa-w="${i.key}"]`).value.trim(), crit: form.querySelector(`[data-pa-c="${i.key}"]`).value.trim() })) } }),
  });
  if (r) { toast('Alertas salvos.'); done(); }
}
