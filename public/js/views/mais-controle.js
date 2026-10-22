// Tarefas financeiras › Mais Controle: busca os pagamentos do ERP (API para Relatórios) ou recebe o arquivo exportado,
// vincula cada categoria do Mais Controle a uma tarefa financeira e lança o real do mês (prévia antes; não duplica).
import { html, api, icon } from '../core.js';
import { toast, confirmSheet } from '../ui.js';
import { pageHead } from './shared.js';

const BRL = new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' });
const money = v => BRL.format(Number(v) || 0);
const MES = ['jan', 'fev', 'mar', 'abr', 'mai', 'jun', 'jul', 'ago', 'set', 'out', 'nov', 'dez'];
const ymLabel = ym => `${MES[Number(ym.slice(5, 7)) - 1]}/${ym.slice(0, 4)}`;
const when = s => (s ? new Intl.DateTimeFormat('pt-BR', { timeZone: 'America/Sao_Paulo', day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' })
  .format(new Date(/Z$|T/.test(s) ? s : `${s.replace(' ', 'T')}Z`)) : '');
const readB64 = f => new Promise((res, rej) => { const fr = new FileReader(); fr.onload = () => res(String(fr.result).split(',')[1]); fr.onerror = () => rej(new Error(`Não foi possível ler ${f.name}.`)); fr.readAsDataURL(f); });
const PLAN = { semanal: 'semanal (gratuito)', diario: 'diário', horario: 'de hora em hora' };
const GST = { ok: ['Pronto', 'm-paid'], soma: ['Soma', 'm-paid'], conflito: ['Já pago à mão', 'm-draft'], erro: ['Com erro', 'fi-err'] };

export async function view({ state, render }) {
  if (!state.meta.can.finance) throw new Error('Acesso restrito: solicite ao administrador a liberação das Tarefas financeiras.');
  const [st, pv] = await Promise.all([api('/finance/maiscontrole'), api('/finance/maiscontrole/preview')]);
  const t = pv.totals;
  const opts = sel => html`<option value="">— escolher tarefa —</option><option value="ignorar" ${sel === 'ignorar' ? 'selected' : ''}>Ignorar esta categoria</option>
    ${pv.obligations.filter(o => o.active || o.id === sel).map(o => html`<option value="${o.id}" ${o.id === sel ? 'selected' : ''}>${o.title}${o.active ? '' : ' (inativa)'}</option>`)}`;
  const pending = pv.categories.filter(c => !c.obligation_id && !c.ignored);
  const sugg = pending.filter(c => c.suggestion);
  return {
    title: 'Mais Controle',
    html: html`${pageHead({ back: { href: '#/financeiro', label: 'Planejamento anual' }, eyebrow: 'Tarefas financeiras', title: 'Mais Controle · pagamentos',
        sub: 'Toda semana os pagamentos do Mais Controle viram o real das tarefas financeiras (centro de custo Empresa) e os custos dos demais centros de custo vão para "Custos destinados a Projetos". Só entram contas bancárias cadastradas; pagamento já lançado não entra de novo.' })}
      <section class="card section">
        <div class="card-head"><h2>${icon('reschedule')}Buscar pagamentos</h2><span class="sub">API para Relatórios · plano ${PLAN[st.plan] || st.plan}</span></div>
        <div class="card-body mc-fetch">
          ${st.configured ? html`<div>
              <button type="button" class="btn btn-primary" data-mc-fetch ${st.next_allowed ? 'disabled' : ''}>${icon('reschedule')}Buscar no Mais Controle</button>
              <small class="hint">${st.next_allowed ? `Pelo plano ${PLAN[st.plan] || st.plan}, a próxima busca fica liberada em ${when(st.next_allowed)}.` : 'Usa 1 consulta da cota do plano.'}${st.auto ? ' Sincronização automática: toda segunda-feira a partir das 8h (busca e lança o que estiver vinculado).' : ''}</small></div>`
            : html`<div class="mc-cfg"><b>Integração ainda não configurada.</b> No painel do servidor (Render › Environment), cadastre <code>MAISCONTROLE_USUARIO</code> e <code>MAISCONTROLE_SENHA</code> com a credencial da API para Relatórios (Mais Controle › Configurações › Integração). Opcional: <code>MAISCONTROLE_PLANO</code> = semanal, diario ou horario. A senha fica só no servidor.</div>`}
          <div class="mc-or">ou envie o arquivo de Pagamentos exportado do Mais Controle
            <label class="btn btn-ghost btn-sm" for="mc-file">${icon('file')}Escolher arquivo (.xlsx ou .csv)</label>
            <input type="file" id="mc-file" accept=".xlsx,.csv,text/csv,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" hidden></div>
          ${pv.fetch ? html`<p class="muted mc-last">Última busca: <b>${pv.fetch.origin === 'api' ? 'API' : pv.fetch.file_name}</b> em ${when(pv.fetch.fetched_at)} · ${pv.fetch.rows} pagamento(s)${st.synced?.n ? ` · ${st.synced.n} já lançado(s) no total` : ''}</p>` : ''}
        </div>
      </section>
      ${pv.fetch || pv.accounts.length ? html`
      <section class="card section">
        <div class="card-head"><h2>${icon('wallet')}Contas bancárias</h2><span class="sub">${pv.accounts.filter(a => a.active).length} cadastrada(s)${t?.other_account ? ` · ${t.other_account} custo(s) em conta não cadastrada` : ''}</span></div>
        <div class="card-body"><p class="muted" style="margin:0">Só entram os custos das contas marcadas. Custo em outra conta aparece aqui como alerta: para trazê-lo, cadastre a conta.</p></div>
        <ul class="mc-cats">${pv.accounts.map(a => html`<li class="${!a.active && a.count ? 'is-pending' : ''}">
          <span class="mc-cat"><b>${a.label}</b><small>${a.count ? `${a.count} custo(s) novo(s) · ${money(a.total)}` : 'sem custos novos'}${!a.active && a.categories?.length ? ` · ${a.categories.map(c => `${c.label} ${money(c.total)}`).join(' · ')}` : ''}</small></span>
          <label class="switch mc-acc"><input type="checkbox" data-mc-acc="${a.label}" data-mc-acc-key="${a.key}" ${a.active ? 'checked' : ''}>${a.active ? 'Cadastrada: traz os custos' : 'Não cadastrada'}</label></li>`)}</ul>
      </section>` : ''}
      ${pv.fetch ? html`
      <section class="card section">
        <div class="card-head"><h2>${icon('settings')}Categorias do Mais Controle → tarefas</h2><span class="sub">${pending.length ? `${pending.length} sem vínculo` : 'todas vinculadas'}</span></div>
        <div class="card-body">
          <p class="muted" style="margin:0 0 10px">Centro de custo Empresa: cada categoria soma no real de uma tarefa financeira (várias categorias podem ir para a mesma tarefa). Categoria sem tarefa fica de fora e aparece aqui como alerta: cadastre a tarefa e vincule. O vínculo fica salvo para as próximas buscas.</p>
          ${sugg.length ? html`<button type="button" class="btn btn-ghost btn-sm" data-mc-sugg>${icon('check')}Usar as ${sugg.length} sugestão(ões) pelo nome</button>` : ''}
        </div>
        <ul class="mc-cats">${pv.categories.map(c => html`<li class="${!c.obligation_id && !c.ignored ? 'is-pending' : c.ignored ? 'is-ignored' : ''}">
          <span class="mc-cat"><b>${c.label}</b><small>${c.count} pagamento(s) novo(s) · ${money(c.total)}${c.suggestion && !c.obligation_id && !c.ignored ? ` · sugestão: ${c.suggestion.title}` : ''}</small></span>
          <select data-mc-map="${c.label}" data-mc-key="${c.key}" aria-label="Tarefa da categoria ${c.label}">${opts(c.ignored ? 'ignorar' : c.obligation_id)}</select></li>`)}</ul>
      </section>
      <section class="card section">
        <div class="card-head"><h2>${icon('wallet')}Prévia do lançamento</h2><span class="sub">real por tarefa e mês (mês do vencimento)</span></div>
        <div class="card-body">
          <div class="ct-tiles fi-tiles">
            <div class="ct-tile"><span>A lançar</span><b>${t.ready_payments}</b><small>${money(t.ready_total)} em ${t.ready_months} mês(es)</small></div>
            <div class="ct-tile"><span>Sem vínculo</span><b class="${t.unmapped ? 'is-neg' : ''}">${t.unmapped}</b><small>vincule a categoria acima</small></div>
            <div class="ct-tile"><span>Projetos</span><b>${t.projects}</b><small>${money(t.projects_total)} em outros centros de custo</small></div>
            <div class="ct-tile"><span>Já lançados</span><b>${t.already}</b><small>${t.ignored} ignorado(s) · ${t.unpaid} sem pagamento · ${t.other_account} em conta não cadastrada</small></div>
            <div class="ct-tile"><span>Atenção</span><b class="${t.conflicts + t.errors ? 'is-neg' : ''}">${t.conflicts + t.errors}</b><small>${t.conflicts} já pago(s) à mão · ${t.errors} com erro</small></div>
          </div>
        </div>
        ${pv.groups.length ? html`<ul class="fi-list fi-list-sm">${pv.groups.map(g => html`<li class="${g.status === 'erro' ? 'is-erro' : g.status === 'conflito' ? 'is-existe' : ''}">
          <span class="fi-main"><b>${g.title} · ${ymLabel(g.ym)}</b><small>${g.count} pagamento(s) · ${g.categories.join(', ')}${g.note ? ` · ${g.note}` : ''}</small></span>
          <span class="fi-val"><b>${money(g.amount)}</b><span class="m-badge ${GST[g.status][1]}">${GST[g.status][0]}</span></span></li>`)}</ul>` : html`<div class="card-body muted">Nada novo para lançar nas tarefas${t.unmapped ? ': vincule as categorias acima' : ''}.</div>`}
        ${pv.projects.length ? html`<div class="card-body"><b class="mc-sub">Custos destinados a Projetos</b></div><ul class="fi-list fi-list-sm">${pv.projects.map(g => html`<li>
          <span class="fi-main"><b>${g.cost_center} · ${ymLabel(g.ym)}</b><small>${g.count} pagamento(s)</small></span><span class="fi-val"><b>${money(g.amount)}</b></span></li>`)}</ul>` : ''}
      </section>
      <div class="bi-confirm"><button type="button" class="btn btn-accent" data-mc-apply ${t.ready_months || t.projects ? '' : 'disabled'}>${icon('check')}${t.ready_months || t.projects ? `Lançar ${t.ready_payments + t.projects} pagamento(s) · ${money(t.ready_total + t.projects_total)}` : 'Nada para lançar'}</button></div>` : ''}`,
    mount(root) {
      const busy = async (b, fn) => { b.disabled = true; try { await fn(); } catch (ex) { toast(ex.message, 'error'); b.disabled = false; } };
      root.querySelector('[data-mc-fetch]')?.addEventListener('click', e => busy(e.currentTarget, async () => {
        const r = await api('/finance/maiscontrole/fetch', { method: 'POST', body: {} });
        toast(`${r.rows} pagamento(s) recebido(s) do Mais Controle.`); render();
      }));
      root.querySelector('#mc-file')?.addEventListener('change', async e => {
        const f = e.currentTarget.files[0];
        if (!f) return;
        try { const r = await api('/finance/maiscontrole/upload', { method: 'POST', body: { file: { name: f.name, data: await readB64(f) } } }); toast(`${r.rows} pagamento(s) lido(s) de ${f.name}.`); render(); }
        catch (ex) { toast(ex.message, 'error'); }
      });
      root.querySelectorAll('[data-mc-acc]').forEach(c => c.addEventListener('change', async () => {
        try { await api('/finance/maiscontrole/account', { method: 'PUT', body: { key: c.dataset.mcAccKey, label: c.dataset.mcAcc, active: c.checked } }); render(); }
        catch (ex) { toast(ex.message, 'error'); c.checked = !c.checked; }
      }));
      root.querySelectorAll('[data-mc-map]').forEach(s => s.addEventListener('change', async () => {
        const v = s.value;
        try { await api('/finance/maiscontrole/map', { method: 'PUT', body: { key: s.dataset.mcKey, label: s.dataset.mcMap, obligation_id: v && v !== 'ignorar' ? Number(v) : null, ignored: v === 'ignorar' } }); render(); }
        catch (ex) { toast(ex.message, 'error'); }
      }));
      root.querySelector('[data-mc-sugg]')?.addEventListener('click', e => busy(e.currentTarget, async () => {
        for (const c of sugg) await api('/finance/maiscontrole/map', { method: 'PUT', body: { key: c.key, label: c.label, obligation_id: c.suggestion.id } });
        toast(`${sugg.length} categoria(s) vinculada(s).`); render();
      }));
      root.querySelector('[data-mc-apply]')?.addEventListener('click', e => busy(e.currentTarget, async () => {
        if (!(await confirmSheet('Lançar pagamentos', `Lançar ${t.ready_payments} pagamento(s) nas tarefas financeiras (${money(t.ready_total)})${t.projects ? ` e ${t.projects} custo(s) de projetos (${money(t.projects_total)})` : ''}? Dá para desfazer em Importar planilha › Última importação.`, 'Lançar'))) { e.currentTarget.disabled = false; return; }
        const r = await api('/finance/maiscontrole/apply', { method: 'POST', body: {} });
        toast(`${r.payments} pagamento(s) lançado(s) em ${r.months} mês(es) · ${money(r.total)}${r.projects ? ` · ${r.projects} custo(s) de projetos` : ''}.`); render();
      }));
    },
  };
}
