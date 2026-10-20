// Tarefas financeiras › Importar planilha: baixar a planilha modelo, enviar preenchida, conferir a prévia
// (erros por linha, tarefas que já existem) e confirmar. Cada linha vira uma obrigação, com as parcelas geradas como hoje.
import { html, api, icon } from '../core.js';
import { toast } from '../ui.js';
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

function previewHtml(p) {
  const t = p.totals;
  return html`<section class="card section">
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
          <small>${[r.view.category + (r.view.category_new ? ' (categoria nova)' : ''), r.view.payee, r.view.frequency_label, r.view.due_day ? `vence dia ${r.view.due_day}` : '', r.view.start_month ? `${ym(r.view.start_month)}${r.view.end_month ? ` → ${ym(r.view.end_month)}` : ' em diante'}` : '', r.view.assignee_name ? `resp. ${r.view.assignee_name}` : ''].filter(Boolean).join(' · ')}</small>
          ${r.errors.length ? html`<em class="fi-errs">${r.errors.join(' · ')}</em>` : ''}
          ${r.status === 'existe' ? html`<em class="fi-note">Já existe uma tarefa com esta descrição e favorecido.</em>` : r.status === 'repetida' ? html`<em class="fi-note">Repetida na planilha (igual à linha ${r.repeated_line}).</em>` : ''}</span>
        <span class="fi-val"><b>${money(r.view.amount)}</b>${r.view.variable ? html`<small>variável${r.view.repeat_last ? ' · mês anterior' : ''}</small>` : ''}<span class="m-badge ${ST[r.status][1]}">${ST[r.status][0]}</span></span>
      </label></li>`)}</ul>
    </section>
    <div class="bi-confirm"><button type="button" class="btn btn-accent" data-fi-apply ${t.ok ? '' : 'disabled'}>${icon('check')}${t.ok ? `Importar ${t.ok} tarefa(s)` : 'Nada para importar'}</button></div>`;
}

export async function importPage({ state, navigate }) {
  if (!state.meta.can.finance) throw new Error('Acesso restrito: solicite ao administrador a liberação das Tarefas financeiras.');
  return {
    title: 'Importar tarefas financeiras',
    html: html`${pageHead({ back: { href: '#/financeiro/obrigacoes', label: 'Obrigações' }, eyebrow: 'Tarefas financeiras', title: 'Importar planilha',
        sub: 'Baixe a planilha modelo, preencha uma linha por tarefa e envie. Você confere a prévia antes; nada é gravado sem confirmar.' })}
      <section class="card section">
        <div class="card-body bi-pick">
          <div class="fi-steps">
            <div class="fi-step"><span class="fi-n">1</span><div><b>Baixe a planilha modelo</b><small>já vem com as listas de categoria, periodicidade e responsáveis, e uma aba de instruções</small>
              <button type="button" class="btn btn-ghost btn-sm" data-fi-template>${icon('file')}Baixar planilha modelo</button></div></div>
            <div class="fi-step"><span class="fi-n">2</span><div><b>Preencha e envie</b><small>uma linha por tarefa, a partir da linha 2 da aba "Tarefas"</small>
              <label class="bi-drop" for="fi-file">${icon('file')}<span><b>Escolher planilha preenchida</b><small>arquivo .xlsx</small></span></label>
              <input type="file" id="fi-file" accept=".xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" hidden>
              <ul class="bi-files" data-fi-name></ul></div></div>
          </div>
          <button type="button" class="btn btn-primary" data-fi-read disabled>Ler e mostrar prévia</button>
        </div>
      </section>
      <div data-fi-preview></div>`,
    mount(root) {
      const input = root.querySelector('#fi-file'), nameBox = root.querySelector('[data-fi-name]'), read = root.querySelector('[data-fi-read]'), out = root.querySelector('[data-fi-preview]');
      let file = null, payload = null;
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
          const count = () => { const n = out.querySelectorAll('[data-fiok]:checked').length; btn.disabled = !n; btn.lastChild.textContent = n ? `Importar ${n} tarefa(s)` : 'Nada para importar'; };
          out.querySelectorAll('[data-fiok]').forEach(cb => cb.addEventListener('change', () => { cb.closest('li').classList.toggle('is-off', !cb.checked); count(); }));
          btn.addEventListener('click', async () => {
            const skip = [...out.querySelectorAll('[data-fiok]:not(:checked):not(:disabled)')].map(c => Number(c.dataset.fiok));
            btn.disabled = true; btn.lastChild.textContent = 'Importando…';
            try {
              const r = await api('/finance/import', { method: 'POST', body: { file: payload, skip } });
              toast(`${r.imported} tarefa(s) financeira(s) importada(s).`);
              navigate('/financeiro/obrigacoes');
            } catch (ex) { toast(ex.message, 'error'); count(); }
          });
        } catch (ex) { toast(ex.message, 'error'); }
        read.disabled = false; read.textContent = 'Ler e mostrar prévia';
      });
    },
  };
}
