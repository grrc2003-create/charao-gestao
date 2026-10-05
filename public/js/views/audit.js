import { html, api, fmtDateTime } from '../core.js';
import { pageHead } from './shared.js';

export async function view({ state }) {
  if (!state.meta.can.view_audit) throw new Error('Apenas administradores acessam a auditoria.');
  const rows = await api('/audit');
  const fmtDetails = d => {
    if (!d) return '';
    try {
      const o = JSON.parse(d);
      const val = v => Array.isArray(v) ? v.join(', ') || '—'
        : v && typeof v === 'object' ? Object.entries(v).filter(([, x]) => [].concat(x).length).map(([a, b]) => `${a}: ${[].concat(b).join(', ')}`).join('; ') || '—'
        : v ?? '—';
      return Object.entries(o).map(([k, v]) => `${k}: ${val(v)}`).join(' · ');
    } catch { return d; }
  };
  return {
    title: 'Auditoria',
    html: html`
      ${pageHead({ back: { href: '#/usuarios', label: 'Usuários' }, eyebrow: 'Rastreabilidade administrativa', title: 'Auditoria',
        sub: 'Logins, falhas de acesso, criação de usuários, alterações de permissões e de projetos (últimos 200 eventos). O histórico de cada tarefa fica na própria tarefa.' })}
      <div class="card"><div class="table-wrap"><table class="data"><thead><tr><th>Data/hora</th><th>Usuário</th><th>Ação</th><th>Detalhes</th><th>IP</th></tr></thead>
      <tbody>${rows.map(r => html`<tr style="cursor:default"><td class="nowrap">${fmtDateTime(r.created_at)}</td><td class="nowrap">${r.actor_name || '—'}</td>
        <td><b>${r.action}</b><div class="t-sub">${r.entity}${r.entity_id ? ` #${r.entity_id}` : ''}</div></td><td class="t-sub" style="max-width:420px">${fmtDetails(r.details)}</td><td class="mono t-sub">${r.ip || ''}</td></tr>`)}</tbody></table></div></div>`,
  };
}
