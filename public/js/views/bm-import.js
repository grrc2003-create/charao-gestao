// Importar BMs: planilhas de recebimentos do financeiro (.xlsx) → contratos por obra (valor = todas as parcelas)
// e um BM (Recebida) por mês do que foi recebido; parcelas em aberto ficam como saldo a medir.
// Prévia antes de gravar; em cada obra escolhe criar contrato novo, usar um contrato já cadastrado ou não importar.
import { html, api, icon, fmtDate } from '../core.js';
import { toast } from '../ui.js';
import { pageHead } from './shared.js';

const BRL = new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' });
const money = v => BRL.format(Number(v) || 0);
const readB64 = f => new Promise((res, rej) => { const fr = new FileReader(); fr.onload = () => res(String(fr.result).split(',')[1]); fr.onerror = () => rej(new Error(`Não foi possível ler ${f.name}.`)); fr.readAsDataURL(f); });

function previewHtml(p) {
  const sum = (a, f) => a.reduce((s, g) => s + f(g), 0);
  const nBms = sum(p.groups, g => g.bms), total = sum(p.groups, g => g.total);
  const created = p.groups.filter(g => !g.match && g.pending).length;
  const pending = p.groups.filter(g => g.pending).length;
  const matched = p.groups.filter(g => g.match).length;
  const opts = g => html`<option value="new" ${!g.match ? 'selected' : ''}>Criar contrato novo</option>
    <option value="skip">Não importar esta obra</option>
    ${p.contracts.length ? html`<optgroup label="Contrato já cadastrado">${p.contracts.map(c => html`<option value="${c.id}" ${g.match?.id === c.id ? 'selected' : ''}>${c.code} · ${c.client} · ${c.title}</option>`)}</optgroup>` : ''}`;
  const bmTable = g => html`<div class="table-wrap"><table class="data ct-table bi-table"><thead><tr><th>BM (mês)</th><th>Itens medidos</th><th>Desc./acréscimos</th><th class="num">Total recebido</th><th>Recebido em</th></tr></thead>
    <tbody>${g.months.map(m => html`<tr><td class="nowrap"><b>${m.label}</b><div class="t-sub">${m.count} lanç.</div></td>
      <td>${m.lines.length ? m.lines.map(l => html`<div>${l.nature} <b>${money(l.value)}</b></div>`) : '—'}</td>
      <td>${m.adjustments.length ? m.adjustments.map(a => html`<div class="${a.amount < 0 ? 'is-neg' : ''}">${a.description} <b>${money(a.amount)}</b></div>`) : '—'}</td>
      <td class="num"><b>${money(m.total)}</b></td><td class="nowrap">${fmtDate(m.paid_date)}</td></tr>`)}</tbody></table></div>`;
  return html`
    <section class="card section">
      <div class="card-head"><h2>${icon('file')}Prévia</h2><span class="sub">${p.files.map(f => `${f.name} (${f.rows})`).join(' · ')}</span></div>
      <div class="card-body">
        <div class="ct-tiles bi-tiles">
          <div class="ct-tile"><span>Contratos (obras)</span><b>${p.groups.length}</b><small>${created} novo(s) · ${p.groups.length - created} já cadastrado(s)</small></div>
          <div class="ct-tile"><span>Valor somado aos contratos</span><b>${money(sum(p.groups, g => g.value_add))}</b><small>${money(sum(p.groups, g => g.open_add))} em aberto (saldo a medir)</small></div>
          <div class="ct-tile"><span>BMs a criar</span><b>${nBms}</b><small>um por mês, só o recebido</small></div>
          <div class="ct-tile"><span>Total dos BMs</span><b>${money(total)}</b><small>RT incluída ${money(sum(p.groups, g => g.rt))}</small></div>
          <div class="ct-tile"><span>Fora</span><b>${p.skipped.others}</b><small>outras entradas (aporte, empréstimo, reembolso, sem obra)</small></div>
        </div>
        ${p.warnings.length ? html`<div class="bi-warn">${icon('alert')}<div><b>${p.warnings.length} linha(s) ignorada(s)</b><ul>${p.warnings.slice(0, 10).map(w => html`<li>${w}</li>`)}</ul></div></div>` : ''}
        <p class="hint" style="margin:10px 0 0">Cada obra vira um contrato do cliente que mais pagou. O valor do contrato soma <b>todas as parcelas</b> (itens por natureza, unidade R$). BM só do que foi <b>recebido</b>, um por mês; as parcelas em aberto ficam como saldo a medir e ganham o BM quando você reenviar a planilha com elas recebidas. RT do fornecedor entra como acréscimo; desconto/juros do recebimento como ajuste. Aporte, empréstimo, reembolso e linhas sem obra ficam fora.</p>
      </div>
    </section>
    <section class="card section">
      <div class="card-head"><h2>${icon('contract')}Obras → contratos e BMs</h2><span class="sub">${p.groups.length} obra(s)</span></div>
      <div class="bi-groups">${p.groups.map(g => html`<div class="bi-group ${g.pending ? '' : 'is-done'}">
        <div class="bi-group-h"><div class="bi-group-t"><b>${g.obra}</b><small>${g.client}${g.payers.length > 1 ? ` · +${g.payers.length - 1} pagador(es)` : ''}${g.open_count ? ` · ${g.open_count} parcela(s) em aberto (${money(g.open_total)})` : ''}</small></div>
          <div class="bi-group-n"><span>${g.value_add ? `contrato +${money(g.value_add)}` : 'valor já lançado'}${g.open_add ? ` · a medir ${money(g.open_add)}` : ''}</span><b>${g.bms} BM(s) · ${money(g.total)}</b>${g.rt ? html`<small>RT ${money(g.rt)}</small>` : ''}${g.skipped_months ? html`<small>${g.skipped_months} mês(es) com BM lançado à mão — ignorado(s)</small>` : ''}</div></div>
        ${g.pending || g.match ? html`<div class="bi-group-f"><label class="sr-only" for="bim-${g.key}">Contrato de ${g.obra}</label><select id="bim-${g.key}" data-bimap="${g.key}">${opts(g)}</select>
          <select class="bi-co" data-bico="${g.key}" aria-label="Empresa de ${g.obra}"><option value="charao" ${g.company === 'charao' ? 'selected' : ''}>Charão</option><option value="lus" ${g.company === 'lus' ? 'selected' : ''}>LuS</option></select>
          <select class="bi-ty" data-bity="${g.key}" aria-label="Tipo de ${g.obra}"><option value="">Sem tipo</option>${p.types.map(t => html`<option value="${t.id}" ${g.type_id === t.id ? 'selected' : ''}>${t.name}</option>`)}</select>
          ${g.reclassify ? html`<span class="pill pill-sand">empresa/tipo serão atualizados</span>` : ''}</div>` : ''}
        ${g.pending ? html`
        ${g.months.length ? html`<details><summary>Ver BMs</summary>${bmTable(g)}</details>` : html`<p class="hint" style="margin:6px 0 0">Nada recebido ainda: o contrato é criado com o valor e fica todo a medir.</p>`}`
        : html`<p class="hint" style="margin:6px 0 0">${g.discarded && g.discarded === g.items.filter(i => i.state !== 'importado').length && !g.items.some(i => i.state === 'importado') ? 'Todos os pagamentos desta obra estão descartados.' : `Tudo desta obra já foi importado${g.match ? ' — você ainda pode ajustar a empresa e o tipo' : ''}.`}</p>`}
        <details class="bi-pays" data-bipays="${g.key}" ${g.discarded ? 'open' : ''}><summary>Pagamentos (${g.items.length})${g.discarded ? ` · ${g.discarded} descartado(s)` : ''}</summary>
          <p class="hint" style="margin:6px 0">Desmarque o pagamento que não deve ser considerado: ele fica fora do valor do contrato e dos BMs (e continua fora se você reenviar a planilha).</p>
          <ul class="bi-pay-list">${g.items.map(it => html`<li class="is-${it.state}"><label>
            <input type="checkbox" data-bikey="${it.key}" data-saved="${it.saved_off ? 1 : 0}" ${it.state !== 'descartado' ? 'checked' : ''} ${it.state === 'importado' ? 'disabled' : ''} aria-label="Considerar pagamento de ${fmtDate(it.due_date)}">
            <span class="bi-pay-d">${fmtDate(it.due_date)}</span>
            <span class="bi-pay-t">${it.kind === 'rt' ? html`<span class="pill pill-sand">RT</span> ` : ''}${it.payer || '—'}<small>${[it.description, it.installment].filter(Boolean).join(' · ') || '—'}</small></span>
            <span class="bi-pay-v"><b>${money(it.amount)}</b><small>${it.state === 'importado' ? 'já importado' : it.state === 'descartado' ? 'descartado' : it.received_date ? `recebido ${fmtDate(it.received_date)}` : 'em aberto'}</small></span>
          </label></li>`)}</ul>
        </details>
      </div>`)}</div>
    </section>
    <div class="bi-confirm"><button type="button" class="btn btn-accent" data-bi-apply ${pending || matched || p.groups.some(g => g.discarded) ? '' : 'disabled'}>${icon('check')}${pending ? `Importar ${pending} contrato(s) e ${nBms} BM(s)` : matched ? 'Salvar empresa e tipo dos contratos' : p.groups.some(g => g.discarded) ? 'Salvar descartes' : 'Nada novo para importar'}</button></div>`;
}

export async function importBms({ state, navigate }) {
  if (!state.meta.can.contracts) throw new Error('Acesso restrito: solicite ao administrador a liberação de Contratos (Usuários → Editar).');
  return {
    title: 'Importar BMs',
    html: html`${pageHead({ back: { href: '#/contratos', label: 'Contratos' }, eyebrow: 'Contratos', title: 'Importar BMs das planilhas',
        sub: 'Planilhas de recebimentos do financeiro (.xlsx: Data de Vencimento, Cliente, Obra, Total da Parcela, Recebido…). Você confere a prévia antes; nada é gravado sem confirmar.' })}
      <section class="card section">
        <div class="card-body bi-pick">
          <label class="bi-drop" for="bi-files">${icon('file')}<span><b>Escolher planilhas</b><small>pode selecionar várias (ex.: 2024, 2025 e 2026)</small></span></label>
          <input type="file" id="bi-files" accept=".xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" multiple hidden>
          <ul class="bi-files" data-bi-names></ul>
          <button type="button" class="btn btn-primary" data-bi-read disabled>Ler e mostrar prévia</button>
          <p class="hint" style="margin:0">Reenviar a planilha não duplica: o que já foi importado é ignorado e as parcelas que estavam em aberto e foram recebidas ganham o BM.</p>
        </div>
      </section>
      <div data-bi-preview></div>`,
    mount(root) {
      const input = root.querySelector('#bi-files'), names = root.querySelector('[data-bi-names]'), read = root.querySelector('[data-bi-read]'), out = root.querySelector('[data-bi-preview]');
      let files = [], payload = null;
      input.addEventListener('change', () => {
        files = [...input.files].filter(f => /\.xlsx$/i.test(f.name));
        names.innerHTML = files.map(f => html`<li>${icon('file')}${f.name} <small>${Math.max(1, Math.round(f.size / 1024))} KB</small></li>`).join('');
        read.disabled = !files.length;
        out.innerHTML = '';
        if (files.length < input.files.length) toast('Só arquivos .xlsx são aceitos.', 'error');
      });
      // Prévia: recalculada a cada pagamento desmarcado/remarcado, mantendo as escolhas de contrato, empresa e tipo
      const exclude = new Set(), restore = new Set();
      const show = async () => {
        const keep = { sel: Object.fromEntries([...out.querySelectorAll('select[data-bimap], select[data-bico], select[data-bity]')].map(s => [`${s.dataset.bimap ? 'm' : s.dataset.bico ? 'c' : 't'}:${s.dataset.bimap || s.dataset.bico || s.dataset.bity}`, s.value])),
          open: new Set([...out.querySelectorAll('details[open]')].map(d => d.dataset.bipays ? `p:${d.dataset.bipays}` : null).filter(Boolean)), y: window.scrollY };
        const p = await api('/contracts/import-bms/preview', { method: 'POST', body: { files: payload, exclude: [...exclude], restore: [...restore] } });
        const first = !out.innerHTML;
        out.innerHTML = previewHtml(p).toString();
        out.querySelectorAll('select[data-bimap], select[data-bico], select[data-bity]').forEach(s => {
          const k = `${s.dataset.bimap ? 'm' : s.dataset.bico ? 'c' : 't'}:${s.dataset.bimap || s.dataset.bico || s.dataset.bity}`;
          if (keep.sel[k] !== undefined && [...s.options].some(o => o.value === keep.sel[k])) s.value = keep.sel[k];
        });
        out.querySelectorAll('details[data-bipays]').forEach(d => { if (keep.open.has(`p:${d.dataset.bipays}`)) d.open = true; });
        if (first) out.scrollIntoView({ behavior: 'smooth', block: 'start' }); else window.scrollTo(0, keep.y);
        out.querySelectorAll('[data-bikey]').forEach(cb => cb.addEventListener('change', async () => {
          const k = cb.dataset.bikey, saved = cb.dataset.saved === '1';
          if (cb.checked) { exclude.delete(k); if (saved) restore.add(k); } else { restore.delete(k); if (!saved) exclude.add(k); }
          out.querySelectorAll('[data-bikey]').forEach(x => (x.disabled = true));
          try { await show(); } catch (ex) { toast(ex.message, 'error'); }
        }));
        out.querySelector('[data-bi-apply]')?.addEventListener('click', async ev => {
          const btn = ev.currentTarget;
          const mapping = Object.fromEntries([...out.querySelectorAll('[data-bimap]')].map(s => [s.dataset.bimap, /^\d+$/.test(s.value) ? Number(s.value) : s.value]));
          const classify = Object.fromEntries([...out.querySelectorAll('[data-bico]')].map(s => [s.dataset.bico, { company: s.value, type_id: out.querySelector(`[data-bity="${s.dataset.bico}"]`).value }]));
          btn.disabled = true; btn.textContent = 'Criando BMs…';
          try {
            const r = await api('/contracts/import-bms', { method: 'POST', body: { files: payload, mapping, classify, exclude: [...exclude], restore: [...restore] } });
            toast(`${r.bms} BM(s) criado(s)${r.contracts_created.length ? ` · ${r.contracts_created.length} contrato(s) novo(s)` : ''}${r.value_added ? ` · ${money(r.value_added)} somado aos contratos` : ''}${r.discarded ? ` · ${r.discarded} pagamento(s) descartado(s)` : ''}${r.reclassified ? ` · ${r.reclassified} contrato(s) reclassificado(s)` : ''}.`);
            navigate('/contratos?status=todos');
          } catch (ex) { toast(ex.message, 'error'); btn.disabled = false; btn.textContent = 'Tentar de novo'; }
        });
      };
      read.addEventListener('click', async () => {
        read.disabled = true; read.textContent = 'Lendo…';
        try {
          payload = await Promise.all(files.map(async f => ({ name: f.name, data: await readB64(f) })));
          exclude.clear(); restore.clear(); out.innerHTML = '';
          await show();
        } catch (ex) { toast(ex.message, 'error'); }
        read.disabled = false; read.textContent = 'Ler e mostrar prévia';
      });
    },
  };
}
