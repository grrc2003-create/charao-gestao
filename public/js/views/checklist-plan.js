// Programação do profissional no check-list: escolhe o profissional, vê as pendências da função dele com os dias e vai
// vinculando em sequência. Com período, o tempo vai se esgotando e o que não cabe fica bloqueado; sem período, não há limite.
import { html, api, icon, fmtDate } from '../core.js';
import { toast } from '../ui.js';
import { pageHead } from './shared.js';

const BRL = new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' });
const numBR = v => String(Math.round((Number(v) || 0) * 100) / 100).replace('.', ',');
const daysLabel = d => `${numBR(d)} ${Number(d) === 1 ? 'dia' : 'dias'}`;
const needOf = d => Math.ceil(Number(d) || 0);
const dm = d => (d ? fmtDate(d).slice(0, 5) : '');
const span = i => (i.due_date ? (i.start_date && i.start_date !== i.due_date ? `${dm(i.start_date)} a ${dm(i.due_date)}` : dm(i.due_date)) : 'sem data');

export async function view({ params }) {
  const taskId = Number(params.id);
  const st = { worker: '', start: '', end: '' };
  const url = () => {
    const q = new URLSearchParams();
    if (st.worker) q.set('worker', st.worker);
    if (st.start && st.end) { q.set('de', st.start); q.set('ate', st.end); }
    return `/tasks/${taskId}/plan${q.size ? `?${q}` : ''}`;
  };
  let d = await api(url());
  return {
    title: `Programar profissional · ${d.task.code}`,
    html: html`${pageHead({ back: { href: `#/tarefas/${taskId}`, label: d.task.code }, eyebrow: `Check-list ${d.task.code} · ${d.task.title}`, title: 'Programar profissional',
        sub: 'Escolha o profissional e, se quiser limitar o tempo, o período. Depois vá vinculando as pendências da função dele.' })}
      <div class="pl-filters section">
        <label class="pl-grow">Profissional<select id="pl-w"><option value="">Escolha o profissional…</option>${d.workers.map(w => html`<option value="${w.id}">${w.name}${w.role ? ` · ${w.role}` : ' · sem função'}</option>`)}</select></label>
        <label>Início do período<input type="date" id="pl-s"></label>
        <label>Fim do período<input type="date" id="pl-e"></label>
        <button type="button" class="btn btn-ghost" id="pl-clear" hidden>Sem período</button>
      </div>
      <div id="pl-body"></div>`,
    mount(root) {
      const box = root.querySelector('#pl-body');
      const [selW, inS, inE, clear] = ['#pl-w', '#pl-s', '#pl-e', '#pl-clear'].map(x => root.querySelector(x));

      const capacity = c => {
        if (!c) return html`<div class="pl-cap"><div class="pl-cap-head"><b>Sem período escolhido</b><span>sem limite de tempo; as datas dos itens não mudam</span></div></div>`;
        const pct = n => (c.available ? (n / c.available) * 100 : 0);
        return html`<div class="pl-cap ${c.remaining ? '' : 'is-full'}">
          <div class="pl-cap-head"><b>${c.remaining ? `Restam ${daysLabel(c.remaining)}` : 'Tempo esgotado'}</b><span>${fmtDate(st.start)} a ${fmtDate(st.end)} · ${daysLabel(c.available)} úteis</span></div>
          <div class="pl-bar" role="img" aria-label="${c.here} dias nesta sequência, ${c.others} em outros check-lists, ${c.remaining} livres"><span class="is-here" style="width:${pct(c.here)}%"></span><span class="is-other" style="width:${pct(c.others)}%"></span></div>
          <div class="pl-legend"><span><i class="is-here"></i>Nesta sequência: ${c.here}</span><span><i class="is-other"></i>Outros check-lists: ${c.others}</span><span><i></i>Livres: ${c.remaining}</span></div>
        </div>`;
      };
      const tags = i => [i.group, i.specialty].filter(Boolean).join(' · ');

      const draw = () => {
        if (!d.worker) {
          box.innerHTML = html`<div class="card pl-empty">${d.workers.length ? 'Escolha um profissional para ver as pendências da função dele.' : 'Nenhum diarista disponível para esta obra. Cadastre em Folha de Campo → Profissionais.'}</div>`.toString();
          return;
        }
        const w = d.worker;
        const edit = d.can_manage;
        box.innerHTML = html`${capacity(d.capacity)}
          <div class="pl-cols">
            <section class="card pl-col"><div class="card-head"><h2>Pendências da função${w.role ? `: ${w.role}` : ''}</h2><span class="sub">${d.pending.length}</span></div>
              ${!w.role ? html`<p class="muted card-body">Este profissional está sem função no cadastro. Defina em Folha de Campo → Profissionais.</p>`
                : d.pending.length ? html`<ul class="pl-list">${d.pending.map(i => html`<li class="pl-item ${i.fits ? '' : 'is-blocked'}">
                  <div class="pl-main"><b><span class="pl-n">${i.seq}</span>${i.text}</b>${tags(i) ? html`<small>${tags(i)}</small>` : ''}
                    <span class="pl-days">${daysLabel(i.days)}${i.qty > 1 ? ` · ${i.qty} vagas` : ''}${i.value !== undefined ? ` · ${BRL.format(i.value)}` : ''}</span>
                    ${i.fits ? '' : html`<em>Não cabe: precisa de ${daysLabel(needOf(i.days))} e restam ${daysLabel(d.capacity.remaining)}</em>`}</div>
                  ${edit ? html`<button type="button" class="btn ${i.fits ? 'btn-primary' : 'btn-ghost'} btn-sm" data-link="${i.id}" ${i.fits ? '' : 'disabled'}>${icon('plus')}Vincular</button>` : ''}
                </li>`)}</ul>` : html`<p class="muted card-body">Nenhuma pendência desta função sem profissional neste check-list.</p>`}
              ${d.items_without_team ? html`<p class="hint pl-hint">${d.items_without_team} ${d.items_without_team === 1 ? 'item em aberto está' : 'itens em aberto estão'} sem equipe e não ${d.items_without_team === 1 ? 'aparece' : 'aparecem'} aqui. Informe a função e os dias na edição do item.</p>` : ''}
            </section>
            <section class="card pl-col"><div class="card-head"><h2>Sequência de ${w.name}</h2><span class="sub">${daysLabel(d.totals.days)}${d.totals.value !== undefined ? ` · ${BRL.format(d.totals.value)}` : ''}</span></div>
              ${d.sequence.length ? html`<ol class="pl-seq">${d.sequence.map((i, n) => html`<li class="pl-step ${i.resolved ? 'is-done' : ''}">
                <span class="pl-dot">${n + 1}</span>
                <div class="pl-main"><b>${i.text}</b>${tags(i) ? html`<small>${tags(i)}</small>` : ''}
                  <span class="pl-days">${daysLabel(i.days)} · ${span(i)}${i.value !== undefined ? ` · ${BRL.format(i.value)}` : ''}${i.resolved ? ' · resolvido' : ''}</span>
                  ${i.outside ? html`<em>Fora do período escolhido</em>` : ''}</div>
                ${edit && !i.resolved ? html`<button type="button" class="icon-btn" data-unlink="${i.id}" aria-label="Tirar ${i.text} da sequência">✕</button>` : ''}
              </li>`)}</ol>` : html`<p class="muted card-body">Nenhum item vinculado ainda.</p>`}
              ${d.others.length ? html`<details class="pl-others"><summary>Outros check-lists desta obra (${d.others.length})</summary>
                <ul>${d.others.map(o => html`<li>${o.link ? html`<a href="${o.link}"><b class="mono">${o.code}</b> ${o.title}</a>` : html`<b class="mono">${o.code}</b> ${o.title}`} · ${daysLabel(o.days)} · ${span(o)}</li>`)}</ul>
                <p class="hint">Só os itens com data dentro do período consomem o tempo.</p></details>` : ''}
            </section>
          </div>`.toString();
      };

      const load = async () => {
        try { d = await api(url()); draw(); } catch (e) { toast(e.message, 'err'); }
      };
      const syncFilters = () => {
        st.worker = selW.value; st.start = inS.value; st.end = inE.value;
        clear.hidden = !st.start && !st.end;
        if (st.start && st.end && st.end < st.start) return toast('O fim do período não pode ser antes do início.', 'err');
        load();
      };
      [selW, inS, inE].forEach(el => el.addEventListener('change', syncFilters));
      clear.addEventListener('click', () => { inS.value = ''; inE.value = ''; syncFilters(); });

      box.addEventListener('click', async e => {
        const a = e.target.closest('[data-link]'), b = e.target.closest('[data-unlink]');
        if (!a && !b) return;
        const btn = a || b;
        btn.disabled = true;
        const body = { worker_id: Number(st.worker), item_id: Number(btn.dataset.link || btn.dataset.unlink), start: st.start && st.end ? st.start : null, end: st.start && st.end ? st.end : null };
        try {
          d = await api(`/tasks/${taskId}/plan/${a ? 'link' : 'unlink'}`, { method: 'POST', body });
          toast(a ? 'Item vinculado.' : 'Item retirado da sequência.');
          draw();
        } catch (er) { toast(er.message, 'err'); load(); }
      });
      draw();
    },
  };
}
