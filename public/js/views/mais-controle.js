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

export async function view({ state, render }) {
  if (!state.meta.can.finance) throw new Error('Acesso restrito: solicite ao administrador a liberação das Tarefas financeiras.');
  const [st, pv] = await Promise.all([api('/finance/maiscontrole'), api('/finance/maiscontrole/preview')]);
  const t = pv.totals;
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
      ${pv.categories.length ? html`<section class="card section">
        <div class="card-head"><h2>${icon('alert')}Categorias sem tarefa financeira</h2><span class="sub">${pv.categories.length} · ${money(t.unmapped_total)} fora do realizado</span></div>
        <div class="card-body"><p class="muted" style="margin:0">A tarefa financeira é a categoria do Mais Controle (mesmo nome). Cadastre a tarefa com o nome da categoria e, na próxima sincronização, o histórico entra sozinho.</p></div>
        <ul class="mc-cats">${pv.categories.map(c => html`<li class="is-pending">
          <span class="mc-cat"><b>${c.label}</b><small>${c.count} pagamento(s) · ${money(c.total)}${c.last ? ` · último em ${ymLabel(c.last)}` : ''}</small></span>
          <a class="btn btn-ghost btn-sm" href="#/financeiro/obrigacoes/nova?titulo=${encodeURIComponent(c.label)}">${icon('plus')}Cadastrar tarefa</a></li>`)}</ul>
      </section>` : ''}
      ${pv.reviews.length ? html`<section class="card section">
        <div class="card-head"><h2>${icon('alert')}Conferência de alocação</h2><span class="sub">despesas do mês numa categoria diferente da habitual do fornecedor</span></div>
        <div class="card-body"><p class="muted" style="margin:0"><b>Está OK</b>: o fornecedor passa a valer nesta categoria. <b>Está errado</b>: ajuste no Mais Controle; na próxima atualização o sistema confere e, se não tiver sido ajustado, avisa de novo.</p></div>
        <ul class="mc-cats mc-rev">${pv.reviews.map(r => html`<li class="${r.state === 'nao_ajustado' ? 'is-late' : 'is-pending'}">
          <span class="mc-cat"><b>${r.supplier || '(sem fornecedor)'} · ${money(r.amount)}</b>
            <small>${dmy(r.due_date)}${r.description ? ` · ${r.description}` : ''}</small>
            <small>Agora em <b>${r.category}</b> · costuma ser <b>${r.usual}</b>${r.state === 'nao_ajustado' ? ` · marcado como errado em ${when(r.marked_at)}: ainda não ajustado no Mais Controle` : ''}</small></span>
          <span class="mc-rev-acts"><button type="button" class="btn btn-ghost btn-sm" data-rv="ok" data-key="${r.key}" data-usual="${r.usual}">${icon('check')}Está OK</button>
            ${r.state === 'nao_ajustado' ? '' : html`<button type="button" class="btn btn-ghost btn-sm mc-wrong" data-rv="errado" data-key="${r.key}" data-usual="${r.usual}">${icon('x')}Está errado</button>`}</span></li>`)}</ul>
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
      root.querySelectorAll('[data-rv]').forEach(b => b.addEventListener('click', () => busy(b, async () => {
        await api('/finance/maiscontrole/review', { method: 'POST', body: { key: b.dataset.key, decision: b.dataset.rv, usual: b.dataset.usual } });
        toast(b.dataset.rv === 'ok' ? 'OK: o fornecedor passa a valer nesta categoria.' : 'Marcado como errado: ajuste no Mais Controle; o sistema confere na próxima atualização.'); render();
      })));
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
