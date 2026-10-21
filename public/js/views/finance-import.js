// Tarefas financeiras › Importar planilha: baixar a planilha modelo, enviar preenchida, conferir a prévia
// (erros por linha, tarefas que já existem) e confirmar. Cada linha vira uma obrigação, com as parcelas geradas como hoje.
import { html, api, icon } from '../core.js';
import { toast, confirmSheet } from '../ui.js';
import { pageHead } from './shared.js';

const BRL = new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' });
const money = v => BRL.format(Number(v) || 0);
const ym = s => (s ? `${s.slice(5, 7)}/${s.slice(0, 4)}` : '—');
const readB64 = f => new Promise((res, rej) => { const fr = new FileReader(); fr.onload = () => res(String(fr.result).split(',')[1]); fr.onerror = () => rej(new Error(`Não foi possível ler ${f.name}.`)); fr.readAsDataURL(f); });
const ST = { ok: ['Pronta', 'm-paid'], erro: ['Com erro', 'fi-err'], existe: ['Já existe', 'm-draft'], repetida: ['Repetida', 'm-draft'] };

async function downloadTemplate() {
  const r = await fetch('/api/finance/import/template', { credentials: 'same-origin', headers: { 'X-Requested-With': 'charao-app' } });
  if (!r.ok) throw new Error('Não foi possível gerar a planilha modelo.');
  const url = URL.createObjectURL(await r.blob());
  const a = Object.assign(document.createElement('a'), { href: url, download: 'tarefas-financeiras-modelo.xlsx' });
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}

const PST = { ok: ['Pronto', 'm-paid'], erro: ['Com erro', 'fi-err'], pago: ['Já pago', 'm-draft'] };
function paysHtml(p) {
  const t = p.totals;
  if (!p.pays?.length) return '';
  return html`<section class="card section">
      <div class="card-head"><h2>${icon('wallet')}Pagamentos</h2><span class="sub">aba "Pagamentos" · valor pago por mês</span></div>
      <div class="card-body">
        <div class="ct-tiles fi-tiles">
          <div class="ct-tile"><span>Pagamentos a lançar</span><b>${t.pay_count}</b><small>${money(t.pay_total)}</small></div>
          <div class="ct-tile"><span>Linhas prontas</span><b>${t.pay_ok}</b><small>desmarque se não quiser alguma</small></div>
          <div class="ct-tile"><span>Com erro</span><b class="${t.pay_erro ? 'is-neg' : ''}">${t.pay_erro}</b><small>corrija na planilha e envie de novo</small></div>
          <div class="ct-tile"><span>Já pagos</span><b>${t.pay_pago}</b><small>meses já lançados são ignorados</small></div>
        </div>
      </div>
      <ul class="fi-list">${p.pays.map(r => html`<li class="is-${r.status === 'pago' ? 'existe' : r.status}"><label>
        <input type="checkbox" data-fpok="${r.line}" ${r.status === 'ok' ? 'checked' : 'disabled'} aria-label="Lançar pagamentos da linha ${r.line}">
        <span class="fi-line">linha ${r.line}</span>
        <span class="fi-main"><b>${r.title || '(sem tarefa)'}</b>
          <small>${[r.category, r.year, r.target && !r.target.id ? 'tarefa nova (aba Tarefas)' : ''].filter(Boolean).join(' · ')}</small>
          <span class="fp-months">${r.months.map(m => html`<span class="fp-m is-${m.status === 'ok' && m.amount === 0 ? 'zero' : m.status}" title="${m.error || (m.status === 'pago' ? 'já pago no sistema: ignorado' : '')}"><b>${m.month}</b>${m.amount != null ? money(m.amount) : '?'}</span>`)}</span>
          ${r.errors.length ? html`<em class="fi-errs">${r.errors.join(' · ')}</em>` : ''}</span>
        <span class="fi-val"><b>${money(r.total)}</b><span class="m-badge ${PST[r.status][1]}">${PST[r.status][0]}</span></span>
      </label></li>`)}</ul>
    </section>`;
}

function previewHtml(p) {
  const t = p.totals;
  const n = t.ok + t.pay_count;
  const tasks = !t.rows ? '' : html`<section class="card section">
      <div class="card-head"><h2>${icon('file')}Prévia</h2><span class="sub">${p.file}</span></div>
      <div class="card-body">
        <div class="ct-tiles fi-tiles">
          <div class="ct-tile"><span>Linhas preenchidas</span><b>${t.rows}</b></div>
          <div class="ct-tile"><span>Prontas para importar</span><b>${t.ok}</b><small>desmarque se não quiser alguma</small></div>
          <div class="ct-tile"><span>Com erro</span><b class="${t.erro ? 'is-neg' : ''}">${t.erro}</b><small>corrija na planilha e envie de novo</small></div>
          <div class="ct-tile"><span>Já existem / repetidas</span><b>${t.existe + t.repetida}</b><small>não são importadas</small></div>
        </div>
      </div>
      <ul class="fi-list">${p.rows.map(r => html`<li class="is-${r.status}"><label>
        <input type="checkbox" data-fiok="${r.line}" ${r.status === 'ok' ? 'checked' : 'disabled'} aria-label="Importar linha ${r.line}">
        <span class="fi-line">linha ${r.line}</span>
        <span class="fi-main"><b>${r.view.title || '(sem descrição)'}</b>
          <small>${[r.view.category + (r.view.category_new ? ' (tipo novo)' : ''), r.view.frequency_label, r.view.due_day ? `vence dia ${r.view.due_day}` : '', r.view.start_month ? `${ym(r.view.start_month)}${r.view.end_month ? ` → ${ym(r.view.end_month)}` : ' em diante'}` : '', r.view.assignee_name ? `resp. ${r.view.assignee_name}` : ''].filter(Boolean).join(' · ')}</small>
          ${r.errors.length ? html`<em class="fi-errs">${r.errors.join(' · ')}</em>` : ''}
          ${r.status === 'existe' ? html`<em class="fi-note">Já existe uma tarefa com esta descrição e tipo da despesa.</em>` : r.status === 'repetida' ? html`<em class="fi-note">Repetida na planilha (igual à linha ${r.repeated_line}).</em>` : ''}</span>
        <span class="fi-val"><b>${money(r.view.amount)}</b>${r.view.variable ? html`<small>variável${r.view.repeat_last ? ' · mês anterior' : ''}</small>` : ''}<span class="m-badge ${ST[r.status][1]}">${ST[r.status][0]}</span></span>
      </label></li>`)}</ul>
    </section>`;
  return html`${tasks}${paysHtml(p)}
    <div class="bi-confirm"><button type="button" class="btn btn-accent" data-fi-apply ${n ? '' : 'disabled'}>${icon('check')}<span>${applyLabel(t.ok, t.pay_count)}</span></button></div>`;
}
const applyLabel = (tasks, pays) => (!tasks && !pays ? 'Nada para importar'
  : `Importar ${[tasks ? `${tasks} tarefa(s)` : '', pays ? `${pays} pagamento(s)` : ''].filter(Boolean).join(' e ')}`);

const when = s => new Intl.DateTimeFormat('pt-BR', { timeZone: 'America/Sao_Paulo', day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' }).format(new Date(s));
function lastHtml(l) {
  if (!l) return '';
  const paid = l.items.filter(o => o.paid).length;
  return html`<section class="card section fi-last">
      <div class="card-head"><h2>${icon('history')}Última importação</h2><span class="sub">${l.file || 'planilha'} · ${when(l.at)}${l.actor_name ? ` · ${l.actor_name}` : ''}</span></div>
      <div class="card-body">
        <p class="muted" style="margin:0 0 10px">Importou errado? Desfazer ${l.items.length ? `exclui as ${l.items.length} tarefa(s) abaixo, com as parcelas e as tarefas do mês geradas por elas` : ''}${l.items.length && l.payments.length ? ' e ' : ''}${l.payments.length ? `volta a pendente os ${l.payments.length} pagamento(s) lançados (${money(l.payments_total)})` : ''}.${paid ? html` <b>${paid} tarefa já tem outro pagamento lançado e será mantida</b> (inative pela edição, se quiser).` : ''}</p>
        ${l.payments.length ? html`<p class="fi-last-pays"><b>Pagamentos:</b> ${l.payments.slice(0, 12).map(x => `${x.title} ${x.ref_month.slice(5)}/${x.ref_month.slice(0, 4)}`).join(' · ')}${l.payments.length > 12 ? ` · +${l.payments.length - 12}` : ''}</p>` : ''}
        <ul class="fi-list fi-list-sm">${l.items.map(o => html`<li class="${o.paid ? 'is-paid' : ''}"><span class="fi-main"><b>${o.title}</b><small>${o.category || 'Sem tipo'} · ${o.frequency_label}</small></span>
          <span class="fi-val"><b>${money(o.amount)}</b>${o.paid ? html`<span class="m-badge m-paid">Com pagamento · mantida</span>` : ''}</span></li>`)}</ul>
        <button type="button" class="btn btn-danger" data-fi-undo="${l.id}">${icon('trash')}Desfazer esta importação</button>
      </div>
    </section>`;
}

export async function importPage({ state, navigate, render }) {
  if (!state.meta.can.finance) throw new Error('Acesso restrito: solicite ao administrador a liberação das Tarefas financeiras.');
  const { last } = await api('/finance/import/last');
  return {
    title: 'Importar tarefas financeiras',
    html: html`${pageHead({ back: { href: '#/financeiro/obrigacoes', label: 'Obrigações' }, eyebrow: 'Tarefas financeiras', title: 'Importar planilha',
        sub: 'Baixe a planilha modelo, preencha uma linha por tarefa e envie. Você confere a prévia antes; nada é gravado sem confirmar.' })}
      <section class="card section">
        <div class="card-body bi-pick">
          <div class="fi-steps">
            <div class="fi-step"><span class="fi-n">1</span><div><b>Baixe a planilha modelo</b><small>já vem com as listas de tipo da despesa, periodicidade e responsáveis, e uma aba de instruções</small>
              <button type="button" class="btn btn-ghost btn-sm" data-fi-template>${icon('file')}Baixar planilha modelo</button></div></div>
            <div class="fi-step"><span class="fi-n">2</span><div><b>Preencha e envie</b><small>aba "Tarefas": uma linha por tarefa nova · aba "Pagamentos": valor pago por mês (grade do ano)</small>
              <label class="bi-drop" for="fi-file">${icon('file')}<span><b>Escolher planilha preenchida</b><small>arquivo .xlsx · abas "Tarefas" e/ou "Pagamentos"</small></span></label>
              <input type="file" id="fi-file" accept=".xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" hidden>
              <ul class="bi-files" data-fi-name></ul></div></div>
          </div>
          <button type="button" class="btn btn-primary" data-fi-read disabled>Ler e mostrar prévia</button>
        </div>
      </section>
      <div data-fi-preview></div>
      ${lastHtml(last)}`,
    mount(root) {
      const input = root.querySelector('#fi-file'), nameBox = root.querySelector('[data-fi-name]'), read = root.querySelector('[data-fi-read]'), out = root.querySelector('[data-fi-preview]');
      let file = null, payload = null;
      root.querySelector('[data-fi-undo]')?.addEventListener('click', async ev => {
        const b = ev.currentTarget, n = last.items.filter(o => !o.paid).length, k = last.payments.length;
        if (!n && !k) { toast('Todas as tarefas desta importação já têm pagamento lançado; nada a desfazer.', 'error'); return; }
        const what = [n ? `excluir ${n} tarefa(s) financeira(s) (com as parcelas e as tarefas do mês)` : '', k ? `voltar ${k} pagamento(s) a pendente` : ''].filter(Boolean).join(' e ');
        if (!(await confirmSheet('Desfazer importação', `Desfazer a importação de "${last.file || 'planilha'}": ${what}? Não dá para voltar atrás.`, 'Desfazer', true))) return;
        b.disabled = true;
        try {
          const r = await api(`/finance/import/${b.dataset.fiUndo}/undo`, { method: 'POST', body: {} });
          toast(`Importação desfeita: ${r.removed} tarefa(s) excluída(s), ${r.unpaid} pagamento(s) desfeito(s)${r.kept.length ? `, ${r.kept.length} mantida(s) por ter outro pagamento` : ''}.`);
          render();
        } catch (ex) { toast(ex.message, 'error'); b.disabled = false; }
      });
      root.querySelector('[data-fi-template]').addEventListener('click', async ev => {
        const b = ev.currentTarget; b.disabled = true;
        try { await downloadTemplate(); toast('Planilha modelo baixada.'); } catch (ex) { toast(ex.message, 'error'); }
        b.disabled = false;
      });
      input.addEventListener('change', () => {
        file = [...input.files].find(f => /\.xlsx$/i.test(f.name)) || null;
        nameBox.innerHTML = file ? html`<li>${icon('file')}${file.name} <small>${Math.max(1, Math.round(file.size / 1024))} KB</small></li>`.toString() : '';
        read.disabled = !file; out.innerHTML = '';
        if (input.files.length && !file) toast('Envie um arquivo .xlsx.', 'error');
      });
      read.addEventListener('click', async () => {
        read.disabled = true; read.textContent = 'Lendo…';
        try {
          payload = { name: file.name, data: await readB64(file) };
          const p = await api('/finance/import/preview', { method: 'POST', body: { file: payload } });
          out.innerHTML = previewHtml(p).toString();
          out.scrollIntoView({ behavior: 'smooth', block: 'start' });
          const btn = out.querySelector('[data-fi-apply]');
          // Pagamentos de uma tarefa nova só entram se a linha da tarefa também for importada
          const payCount = () => p.pays.filter(r => r.status === 'ok' && out.querySelector(`[data-fpok="${r.line}"]`)?.checked
            && (r.target.id || out.querySelector(`[data-fiok="${r.target.line}"]`)?.checked)).reduce((s, r) => s + r.months.filter(m => m.status === 'ok').length, 0);
          const count = () => { const n = out.querySelectorAll('[data-fiok]:checked').length, k = payCount(); btn.disabled = !(n + k); btn.querySelector('span').textContent = applyLabel(n, k); };
          out.querySelectorAll('[data-fiok], [data-fpok]').forEach(cb => cb.addEventListener('change', () => { cb.closest('li').classList.toggle('is-off', !cb.checked); count(); }));
          btn.addEventListener('click', async () => {
            const skip = [...out.querySelectorAll('[data-fiok]:not(:checked):not(:disabled)')].map(c => Number(c.dataset.fiok));
            const skipPay = [...out.querySelectorAll('[data-fpok]:not(:checked):not(:disabled)')].map(c => Number(c.dataset.fpok));
            btn.disabled = true; btn.querySelector('span').textContent = 'Importando…';
            try {
              const r = await api('/finance/import', { method: 'POST', body: { file: payload, skip, skip_pay: skipPay } });
              toast([r.imported ? `${r.imported} tarefa(s) importada(s)` : '', r.paid ? `${r.paid} pagamento(s) lançado(s) (${money(r.paid_total)})` : ''].filter(Boolean).join(' · ') || 'Nada importado.');
              navigate(r.paid ? '/financeiro' : '/financeiro/obrigacoes');
            } catch (ex) { toast(ex.message, 'error'); count(); }
          });
        } catch (ex) { toast(ex.message, 'error'); }
        read.disabled = false; read.textContent = 'Ler e mostrar prévia';
      });
    },
  };
}
