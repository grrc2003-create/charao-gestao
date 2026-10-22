// Tarefas financeiras › Mais Controle: o Mais Controle é a fonte do realizado. Busca os pagamentos (API ou arquivo
// exportado), mostra o que muda nas tarefas (a tarefa é a categoria, pelo nome), os alertas (conta bancária ou categoria
// não cadastrada), a conferência de alocação (fornecedor numa categoria diferente da habitual) e sincroniza.
import { html, api, icon } from '../core.js';
import { toast, confirmSheet } from '../ui.js';
import { pageHead } from './shared.js';

const BRL = new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' });
const money = v => BRL.format(Number(v) || 0);
const MES = ['jan', 'fev', 'mar', 'abr', 'mai', 'jun', 'jul', 'ago', 'set', 'out', 'nov', 'dez'];
const ymLabel = ym => (ym ? `${MES[Number(ym.slice(5, 7)) - 1]}/${ym.slice(0, 4)}` : '');
const dmy = s => (s ? s.split('-').reverse().join('/') : '');
const when = s => (s ? new Intl.DateTimeFormat('pt-BR', { timeZone: 'America/Sao_Paulo', day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' })
  .format(new Date(/Z$|T/.test(s) ? s : `${s.replace(' ', 'T')}Z`)) : '');
const readB64 = f => new Promise((res, rej) => { const fr = new FileReader(); fr.onload = () => res(String(fr.result).split(',')[1]); fr.onerror = () => rej(new Error(`Não foi possível ler ${f.name}.`)); fr.readAsDataURL(f); });
const PLAN = { semanal: 'semanal (gratuito)', diario: 'diário', horario: 'de hora em hora' };
const CH = { novo: ['Novo', 'm-paid'], alterado: ['Alterado', 'm-paid'], removido: ['Retirado', 'fi-err'], manual: ['Pago à mão: não muda', 'm-draft'] };

// Ações de uma despesa: OK, corrigir para outra tarefa (no sistema), stand by (aguardar o Mais Controle) ou desfazer
export function reviewActs(r, tasks = TASKS) {
  const others = tasks.filter(x => x.title.toLowerCase() !== String(r.category).toLowerCase());
  const def = others.find(x => r.usual && x.title.toLowerCase() === r.usual.toLowerCase())?.id;
  return html`<span class="mc-rev-acts">
    ${r.state === 'standby' ? html`<button type="button" class="btn btn-ghost btn-sm" data-rv="reabrir" data-key="${r.key}">Desfazer stand by</button>`
      : r.state === 'corrigido' ? html`<button type="button" class="btn btn-ghost btn-sm" data-rv="reabrir" data-key="${r.key}">Desfazer correção</button>`
      : html`<button type="button" class="btn btn-ghost btn-sm" data-rv="ok" data-key="${r.key}" data-usual="${r.usual || ''}">${icon('check')}Está OK</button>
        <button type="button" class="btn btn-ghost btn-sm mc-wrong" data-rv="standby" data-key="${r.key}" data-usual="${r.usual || ''}">Stand by</button>`}
    <span class="mc-fix"><select data-fix-sel="${r.key}" aria-label="Tarefa correta"><option value="" ${def ? '' : 'selected'}>— escolher tarefa —</option>${others.map(x => html`<option value="${x.id}" ${x.id === def ? 'selected' : ''}>${x.title}</option>`)}</select>
      <button type="button" class="btn btn-ghost btn-sm" data-rv="corrigido" data-key="${r.key}" data-usual="${r.usual || ''}">Corrigir</button></span>
  </span>`;
}
let TASKS = [];
export function bindReviewActs(scope, after) {
  scope.querySelectorAll('[data-rv]').forEach(b => b.addEventListener('click', async () => {
    b.disabled = true;
    const body = { key: b.dataset.key, decision: b.dataset.rv, usual: b.dataset.usual };
    if (b.dataset.rv === 'corrigido') {
      body.obligation_id = Number(scope.querySelector(`[data-fix-sel="${b.dataset.key}"]`)?.value);
      if (!body.obligation_id) { toast('Escolha a tarefa (categoria) correta.', 'error'); b.disabled = false; return; }
    }
    try {
      await api('/finance/maiscontrole/review', { method: 'POST', body });
      toast({ ok: 'OK: o fornecedor passa a valer nesta categoria.', corrigido: 'Corrigido: a despesa foi para a tarefa escolhida.', standby: 'Em stand by: fora do realizado até vir corrigido do Mais Controle.', reabrir: 'Decisão desfeita.' }[b.dataset.rv]);
      after();
    } catch (ex) { toast(ex.message, 'error'); b.disabled = false; }
  }));
}

export async function view({ state, render }) {
  if (!state.meta.can.finance) throw new Error('Acesso restrito: solicite ao administrador a liberação das Tarefas financeiras.');
  const [st, pv] = await Promise.all([api('/finance/maiscontrole'), api('/finance/maiscontrole/preview')]);
  const t = pv.totals;
  TASKS = pv.tasks || [];
  const nChanges = t.novo + t.alterado + t.removido;
  return {
    title: 'Mais Controle',
    html: html`${pageHead({ back: { href: '#/financeiro', label: 'Planejamento anual' }, eyebrow: 'Tarefas financeiras', title: 'Mais Controle · pagamentos',
        sub: 'O Mais Controle é a fonte do realizado: a cada atualização o sistema recalcula o real de cada tarefa (a tarefa é a categoria) e mês, e o previsto vem do realizado do ano anterior. Você só cadastra contas bancárias e categorias novas.' })}
      <section class="card section">
        <div class="card-head"><h2>${icon('reschedule')}Buscar pagamentos</h2><span class="sub">API para Relatórios · plano ${PLAN[st.plan] || st.plan}</span></div>
        <div class="card-body mc-fetch">
          ${st.configured ? html`<div>
              <button type="button" class="btn btn-primary" data-mc-fetch ${st.next_allowed ? 'disabled' : ''}>${icon('reschedule')}Buscar no Mais Controle</button>
              <small class="hint">${st.next_allowed ? `Pelo plano ${PLAN[st.plan] || st.plan}, a próxima busca fica liberada em ${when(st.next_allowed)}.` : 'Traz todo o histórico (2024 em diante) e usa 1 consulta da cota do plano.'}${st.auto ? ' Automático: toda segunda-feira a partir das 8h o sistema busca e sincroniza sozinho.' : ''}</small></div>`
            : html`<div class="mc-cfg"><b>Integração ainda não configurada.</b> No painel do servidor (Render › Environment), cadastre <code>MAISCONTROLE_USUARIO</code> e <code>MAISCONTROLE_SENHA</code> com a credencial da API para Relatórios (Mais Controle › Configurações › Integração). Opcional: <code>MAISCONTROLE_PLANO</code> = semanal, diario ou horario. A senha fica só no servidor.</div>`}
          ${st.pending ? html`<div class="mc-cfg">A última resposta da API (${when(st.pending.fetched_at)}) não foi lida${st.pending.error ? `: ${st.pending.error}` : ''}. <button type="button" class="btn btn-ghost btn-sm" data-mc-reprocess>${icon('reschedule')}Ler de novo a resposta guardada</button> <small>(não gasta outra consulta)</small></div>` : ''}
          <div class="mc-or">ou envie o arquivo de Pagamentos exportado do Mais Controle (substitui só os meses do arquivo)
            <label class="btn btn-ghost btn-sm" for="mc-file">${icon('file')}Escolher arquivo (.xlsx ou .csv)</label>
            <input type="file" id="mc-file" accept=".xlsx,.csv,text/csv,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" hidden></div>
          ${pv.fetch ? html`<p class="muted mc-last">Última atualização: <b>${pv.fetch.origin === 'arquivo' ? pv.fetch.file_name : 'API'}</b> em ${when(pv.fetch.fetched_at)} · dados até ${dmy(pv.fetch.data_until)}${st.snapshot?.n ? ` · ${st.snapshot.n} pagamento(s) de ${ymLabel(st.snapshot.desde)} a ${ymLabel(st.snapshot.ate)}` : ''}</p>` : ''}
        </div>
      </section>
      ${pv.accounts.length ? html`<section class="card section">
        <div class="card-head"><h2>${icon('wallet')}Contas bancárias</h2><span class="sub">${pv.accounts.filter(a => a.active).length} cadastrada(s)${t.other_account ? ` · ${t.other_account} custo(s) em conta não cadastrada (${money(t.other_account_total)})` : ''}</span></div>
        <div class="card-body"><p class="muted" style="margin:0">Só entram os custos das contas marcadas. Custo em outra conta aparece como alerta: para trazê-lo, cadastre a conta.</p></div>
        <ul class="mc-cats">${pv.accounts.map(a => html`<li class="${!a.active && a.count ? 'is-pending' : ''}">
          <span class="mc-cat"><b>${a.label}</b><small>${a.count ? `${a.count} pagamento(s) · ${money(a.total)}` : 'sem pagamentos'}${!a.active && a.categories?.length ? ` · ${a.categories.slice(0, 5).map(c => `${c.label} ${money(c.total)}`).join(' · ')}` : ''}</small></span>
          <label class="switch mc-acc"><input type="checkbox" data-mc-acc="${a.label}" data-mc-acc-key="${a.key}" ${a.active ? 'checked' : ''}>${a.active ? 'Cadastrada: traz os custos' : 'Não cadastrada'}</label></li>`)}</ul>
      </section>` : ''}
      ${pv.issues?.length ? (() => {
        const cli = pv.issues.filter(i => i.kind === 'cliente'), acc = pv.issues.filter(i => i.kind === 'conta');
        const byAcc = [...new Set(acc.map(i => i.account))].map(a => ({ account: a, items: acc.filter(i => i.account === a) }));
        const item = i => html`<li><span class="mc-cat"><b>${i.supplier || '(sem fornecedor)'} · ${money(i.amount)}</b><small>${dmy(i.paid_date)} · ${i.category || '(sem categoria)'}${i.description ? ` · ${i.description}` : ''}${i.kind === 'cliente' ? ` · conta ${i.account}` : ''}</small></span></li>`;
        return html`<section class="card section mc-issues">
          <div class="card-head"><h2>${icon('alert')}Ajustar no Mais Controle</h2><span class="sub">centro de custo Empresa · ${pv.issues.length} lançamento(s) fora do realizado · ${money(pv.issues.reduce((s, i) => s + i.amount, 0))}</span></div>
          <div class="card-body"><p class="muted" style="margin:0">Só entra o que é custo da empresa (centro de custo Empresa, pago pela empresa, em conta bancária cadastrada). Estes lançamentos estão no centro de custo Empresa mas não seguem a regra: ajuste no Mais Controle (ou cadastre a conta, se ela for da empresa). Ao ajustar, saem desta lista na próxima atualização.</p></div>
          ${cli.length ? html`<details open class="mc-iss"><summary><b>Pago pelo cliente no centro de custo Empresa</b> · ${cli.length} · ${money(cli.reduce((s, i) => s + i.amount, 0))}</summary><ul class="mc-cats">${cli.map(item)}</ul></details>` : ''}
          ${byAcc.map(g => html`<details class="mc-iss"><summary><b>Conta não cadastrada: ${g.account}</b> · ${g.items.length} · ${money(g.items.reduce((s, i) => s + i.amount, 0))}</summary><ul class="mc-cats">${g.items.map(item)}</ul></details>`)}
        </section>`;
      })() : ''}
      ${pv.categories.length ? html`<section class="card section">
        <div class="card-head"><h2>${icon('alert')}Categorias sem tarefa financeira</h2><span class="sub">${pv.categories.length} · ${money(t.unmapped_total)} fora do realizado</span></div>
        <div class="card-body"><p class="muted" style="margin:0">A tarefa financeira é a categoria do Mais Controle (mesmo nome). Cadastre a tarefa com o nome da categoria e, na próxima sincronização, o histórico entra sozinho.</p></div>
        <ul class="mc-cats">${pv.categories.map(c => html`<li class="is-pending">
          <span class="mc-cat"><b>${c.label}</b><small>${c.count} pagamento(s) · ${money(c.total)}${c.last ? ` · último em ${ymLabel(c.last)}` : ''}</small></span>
          <span class="mc-rev-acts"><a class="btn btn-ghost btn-sm" href="#/financeiro/obrigacoes/nova?mc=1&titulo=${encodeURIComponent(c.label)}">${icon('plus')}Cadastrar tarefa</a>
            <span class="mc-fix"><select data-map-sel="${c.label}" aria-label="Enviar para a tarefa"><option value="">— enviar para a tarefa… —</option>${(pv.tasks || []).map(x => html`<option value="${x.id}">${x.title}</option>`)}</select>
              <button type="button" class="btn btn-ghost btn-sm" data-cr="mapear" data-label="${c.label}">Enviar</button></span>
            <button type="button" class="btn btn-ghost btn-sm mc-wrong" data-cr="ajustar" data-label="${c.label}">Ajustar no Mais Controle</button>
            <button type="button" class="btn btn-ghost btn-sm" data-ign="${c.label}">Ignorar</button></span></li>`)}</ul>
      </section>` : ''}
      ${pv.reviews.length ? html`<section class="card section">
        <div class="card-head"><h2>${icon('alert')}Conferir categorias</h2><span class="sub">mês atual e anterior · despesas novas e categorias diferentes da habitual${t.standby ? ` · ${t.standby} em stand by (${money(t.standby_total)} fora do realizado)` : ''}</span></div>
        <div class="card-body"><p class="muted" style="margin:0"><b>Está OK</b>: a categoria do Mais Controle está certa (o fornecedor passa a valer nela). <b>Corrigir</b>: a despesa vai para a tarefa escolhida já no sistema. <b>Stand by</b>: erro de cadastro no Mais Controle; fica fora do realizado até vir corrigida e, quando vier, entra sozinha.</p></div>
        <ul class="mc-cats mc-rev">${pv.reviews.map(r => html`<li class="${r.state === 'standby' ? 'is-late' : 'is-pending'}">
          <span class="mc-cat"><b>${r.supplier || '(sem fornecedor)'} · ${money(r.amount)}</b>
            <small>${dmy(r.due_date)}${r.description ? ` · ${r.description}` : ''}</small>
            <small><span class="m-badge ${r.state === 'nova' ? 'm-draft' : r.state === 'standby' ? 'fi-err' : 'm-paid'}">${{ nova: 'Despesa nova', conferir: 'Categoria diferente da habitual', standby: 'Stand by' }[r.state]}</span>
              No Mais Controle: <b>${r.category}</b>${r.usual ? html` · costuma ser <b>${r.usual}</b>` : ''}${r.state === 'standby' ? ` · desde ${when(r.marked_at)}: aguardando ajuste no Mais Controle` : ''}</small></span>
          ${reviewActs(r)}</li>`)}</ul>
      </section>` : ''}
      ${pv.category_rules?.length ? html`<section class="card section">
        <div class="card-head"><h2>${icon('settings')}Regras por categoria</h2><span class="sub">${pv.category_rules.length}${t.adjust ? ` · ${t.adjust} pagamento(s) aguardando ajuste no Mais Controle (${money(t.adjust_total)} fora do realizado)` : ''}</span></div>
        <ul class="mc-cats">${pv.category_rules.map(r => html`<li class="${r.action === 'ajustar' && r.pending ? 'is-late' : ''}">
          <span class="mc-cat"><b>${r.label}</b><small>${r.action === 'mapear' ? `todos os pagamentos vão para a tarefa “${r.target || '(tarefa excluída)'}”` : r.pending ? `ajustar no Mais Controle: ${r.pending.count} pagamento(s) ainda nesta categoria · ${money(r.pending.total)} · último em ${ymLabel(r.pending.last)}` : 'ajustada no Mais Controle: não há mais pagamentos nesta categoria'}</small></span>
          <button type="button" class="btn btn-ghost btn-sm" data-cr="remover" data-label="${r.label}">Desfazer regra</button></li>`)}</ul>
      </section>` : ''}
      ${pv.exclusions?.length ? html`<section class="card section">
        <div class="card-head"><h2>${icon('x')}Custos que não entram</h2><span class="sub">${pv.exclusions.length} · ${t.excluded} pagamento(s) · ${money(t.excluded_total)} fora</span></div>
        <ul class="mc-cats">${pv.exclusions.map(e => html`<li class="is-ignored">
          <span class="mc-cat"><b>${{ pagamento: 'Pagamento', fornecedor: 'Fornecedor', categoria: 'Categoria' }[e.kind]}: ${e.label}</b><small>${e.detail ? `${e.detail} · ` : ''}desde ${when(e.created_at)}${e.by_name ? ` · ${e.by_name}` : ''}</small></span>
          <button type="button" class="btn btn-ghost btn-sm" data-unex="${e.kind}" data-key="${e.ext_key}">Voltar a trazer</button></li>`)}</ul>
      </section>` : ''}
      ${pv.fetch ? html`<section class="card section">
        <div class="card-head"><h2>${icon('wallet')}O que a sincronização muda</h2><span class="sub">realizado por tarefa e mês (mês do vencimento) · previsto pelo ano anterior${pv.first_year ? ` (desde ${pv.first_year})` : ''}</span></div>
        <div class="card-body">
          <div class="ct-tiles fi-tiles">
            <div class="ct-tile"><span>Meses novos</span><b>${t.novo}</b><small>${money(t.novo_total)}</small></div>
            <div class="ct-tile"><span>Alterados / retirados</span><b>${t.alterado + t.removido}</b><small>correções feitas no Mais Controle</small></div>
            <div class="ct-tile"><span>Projetos</span><b>${t.projects}</b><small>${money(t.projects_total)} em outros centros de custo</small></div>
            <div class="ct-tile"><span>Pago à mão</span><b>${t.manual}</b><small>diferente do Mais Controle: não muda</small></div>
          </div>
        </div>
        ${pv.changes.length ? html`<ul class="fi-list fi-list-sm mc-changes">${pv.changes.slice(0, 300).map(c => html`<li class="${c.kind === 'removido' ? 'is-erro' : c.kind === 'manual' ? 'is-existe' : ''}">
          <span class="fi-main"><b>${c.title} · ${ymLabel(c.ym)}</b><small>${c.count ? `${c.count} pagamento(s)` : ''}${c.before != null ? `${c.count ? ' · ' : ''}antes ${money(c.before)}` : ''}</small></span>
          <span class="fi-val"><b>${c.kind === 'removido' ? '—' : money(c.amount)}</b><span class="m-badge ${CH[c.kind][1]}">${CH[c.kind][0]}</span></span></li>`)}</ul>` : html`<div class="card-body muted">O realizado já está igual ao do Mais Controle.</div>`}
      </section>
      <div class="bi-confirm mc-sync">
        <button type="button" class="btn btn-ghost" data-mc-reset>Sincronizar e refazer todo o previsto</button>
        <button type="button" class="btn btn-accent" data-mc-sync>${icon('check')}${nChanges ? `Sincronizar (${nChanges} mês(es))` : 'Sincronizar (atualiza o previsto)'}</button></div>` : ''}`,
    mount(root) {
      const busy = async (b, fn) => { b.disabled = true; try { await fn(); } catch (ex) { toast(ex.message, 'error'); b.disabled = false; } };
      root.querySelector('[data-mc-fetch]')?.addEventListener('click', e => busy(e.currentTarget, async () => {
        const r = await api('/finance/maiscontrole/fetch', { method: 'POST', body: {} });
        toast(`${r.rows} pagamento(s) recebido(s) do Mais Controle. Confira e sincronize.`); render();
      }));
      root.querySelector('[data-mc-reprocess]')?.addEventListener('click', e => busy(e.currentTarget, async () => {
        const r = await api('/finance/maiscontrole/reprocess', { method: 'POST', body: {} });
        toast(`${r.rows} pagamento(s) lido(s) da resposta guardada. Confira e sincronize.`); render();
      }));
      root.querySelector('#mc-file')?.addEventListener('change', async e => {
        const f = e.currentTarget.files[0];
        if (!f) return;
        try { const r = await api('/finance/maiscontrole/upload', { method: 'POST', body: { file: { name: f.name, data: await readB64(f) } } }); toast(`${r.rows} pagamento(s) lido(s) de ${f.name}. Confira e sincronize.`); render(); }
        catch (ex) { toast(ex.message, 'error'); }
      });
      root.querySelectorAll('[data-mc-acc]').forEach(c => c.addEventListener('change', async () => {
        try { await api('/finance/maiscontrole/account', { method: 'PUT', body: { key: c.dataset.mcAccKey, label: c.dataset.mcAcc, active: c.checked } }); render(); }
        catch (ex) { toast(ex.message, 'error'); c.checked = !c.checked; }
      }));
      root.querySelectorAll('[data-ign]').forEach(b => b.addEventListener('click', () => busy(b, async () => {
        if (!(await confirmSheet('Ignorar categoria', `Os pagamentos da categoria “${b.dataset.ign}” não vão entrar nas tarefas financeiras nem aparecer como alerta. Dá para voltar em “Custos que não entram”.`, 'Ignorar'))) { b.disabled = false; return; }
        await api('/finance/maiscontrole/exclusions', { method: 'POST', body: { kind: 'categoria', label: b.dataset.ign } });
        toast('Categoria ignorada.'); render();
      })));
      root.querySelectorAll('[data-cr]').forEach(b => b.addEventListener('click', () => busy(b, async () => {
        const action = b.dataset.cr, label = b.dataset.label;
        const body = { label, action };
        if (action === 'mapear') {
          body.obligation_id = Number(root.querySelector(`[data-map-sel="${CSS.escape(label)}"]`)?.value);
          if (!body.obligation_id) { toast('Escolha a tarefa para onde a categoria vai.', 'error'); b.disabled = false; return; }
        }
        if (action === 'ajustar' && !(await confirmSheet('Ajustar no Mais Controle', `Os pagamentos de “${label}” ficam fora do realizado e em alerta até serem recategorizados no Mais Controle. Quando não houver mais pagamentos nesta categoria, a regra se resolve sozinha.`, 'Confirmar'))) { b.disabled = false; return; }
        await api('/finance/maiscontrole/category-rule', { method: 'POST', body });
        toast({ mapear: 'Categoria enviada para a tarefa: o realizado foi recalculado.', ajustar: 'Categoria em ajuste no Mais Controle.', remover: 'Regra desfeita.' }[action]); render();
      })));
      root.querySelectorAll('[data-unex]').forEach(b => b.addEventListener('click', () => busy(b, async () => {
        await api('/finance/maiscontrole/exclusions/remove', { method: 'POST', body: { kind: b.dataset.unex, key: b.dataset.key } });
        toast('Volta a entrar: o realizado foi recalculado.'); render();
      })));
      bindReviewActs(root, render);
      const doSync = async (b, reset) => busy(b, async () => {
        if (reset && !(await confirmSheet('Refazer todo o previsto', 'O previsto de todos os meses das tarefas do Mais Controle volta a ser o realizado do ano anterior (no primeiro ano, o próprio realizado). Ajustes manuais do previsto dessas tarefas são descartados.', 'Refazer', true))) { b.disabled = false; return; }
        const r = await api('/finance/maiscontrole/sync', { method: 'POST', body: { reset_plans: reset } });
        toast(`Sincronizado: ${r.pagos} mês(es) novo(s), ${r.alterados} alterado(s), ${r.removidos} retirado(s) · previsto de ${r.previstos} mês(es) atualizado${r.manual ? ` · ${r.manual} pago(s) à mão mantido(s)` : ''}.`); render();
      });
      root.querySelector('[data-mc-sync]')?.addEventListener('click', e => doSync(e.currentTarget, false));
      root.querySelector('[data-mc-reset]')?.addEventListener('click', e => doSync(e.currentTarget, true));
    },
  };
}
