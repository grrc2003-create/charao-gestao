// Programação do profissional no check-list: escolhe o profissional, vê as pendências da função dele com os dias e vai
// vinculando em sequência. Com o dia de início, os itens recebem datas a partir dele; com o fim também, o tempo vai se
// esgotando e o que não cabe fica bloqueado. Sem dia de início, não há limite e as datas não mudam.
import { html, api, icon, fmtDate } from '../core.js';
import { toast, sheet } from '../ui.js';
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
    if (st.start) q.set('de', st.start);
    if (st.start && st.end) q.set('ate', st.end);
    return `/tasks/${taskId}/plan${q.size ? `?${q}` : ''}`;
  };
  let d = await api(url());
  return {
    title: `Programar profissional · ${d.task.code}`,
    html: html`${pageHead({ back: { href: `#/tarefas/${taskId}`, label: d.task.code }, eyebrow: `Check-list ${d.task.code} · ${d.task.title}`, title: 'Programar profissional',
        sub: 'Escolha o profissional e o dia em que ele inicia. Depois vá vinculando as pendências da função dele. Para limitar o tempo, informe também até quando.',
        actions: html`<a class="btn btn-ghost" href="#/imprimir/checklist/${taskId}?sep=profissional&fmt=lista">${icon('print')}Relatório de todos os profissionais</a>` })}
      <div class="pl-filters section">
        <label class="pl-grow">Profissional<select id="pl-w"><option value="">Escolha o profissional…</option>${d.workers.map(w => html`<option value="${w.id}">${w.name}${w.role ? ` · ${w.role}` : ' · sem função'}</option>`)}</select></label>
        <label>Profissional inicia em<input type="date" id="pl-s"></label>
        <label>Até (opcional)<input type="date" id="pl-e"></label>
        <button type="button" class="btn btn-ghost" id="pl-clear" hidden>Limpar datas</button>
      </div>
      <div id="pl-body"></div>`,
    mount(root) {
      const box = root.querySelector('#pl-body');
      const [selW, inS, inE, clear] = ['#pl-w', '#pl-s', '#pl-e', '#pl-clear'].map(x => root.querySelector(x));

      const capacity = c => {
        const again = !d.can_manage ? ''
          : d.schedule?.undated ? html`<div class="pl-again"><span>${d.schedule.undated === 1 ? '1 atividade está sem data.' : `${d.schedule.undated} atividades estão sem data.`}</span><button type="button" class="btn btn-primary btn-sm" data-fill>${icon('calendar')}Definir as datas</button></div>`
            : d.schedule?.can_reschedule ? html`<div class="pl-again"><span>A sequência não começa em ${fmtDate(d.schedule.first_free)}.</span><button type="button" class="btn btn-ghost btn-sm" data-resched>${icon('calendar')}Reprogramar a partir de ${dm(d.schedule.first_free)}</button></div>` : '';
        if (!c && !st.start) return html`<div class="pl-cap"><div class="pl-cap-head"><b>Sem dia de início</b><span>escolha o dia em "Profissional inicia em" para as atividades receberem datas</span></div></div>`;
        if (!c) return html`<div class="pl-cap"><div class="pl-cap-head"><b>Inicia em ${fmtDate(st.start)}</b><span>${d.schedule?.ends ? `sequência termina em ${fmtDate(d.schedule.ends)} · ` : ''}sem data limite</span></div>${again}</div>`;
        const pct = n => (c.available ? (n / c.available) * 100 : 0);
        return html`<div class="pl-cap ${c.remaining ? '' : 'is-full'}">
          <div class="pl-cap-head"><b>${c.remaining ? `Restam ${daysLabel(c.remaining)}` : 'Tempo esgotado'}</b><span>${fmtDate(st.start)} a ${fmtDate(st.end)} · ${daysLabel(c.available)} úteis</span></div>
          <div class="pl-bar" role="img" aria-label="${c.here} dias nesta sequência, ${c.others} em outros check-lists, ${c.remaining} livres"><span class="is-here" style="width:${pct(c.here)}%"></span><span class="is-other" style="width:${pct(c.others)}%"></span></div>
          <div class="pl-legend"><span><i class="is-here"></i>Nesta sequência: ${c.here}${c.gaps ? ` (${c.gaps} de intervalo)` : ''}</span><span><i class="is-other"></i>Outros check-lists: ${c.others}</span><span><i></i>Livres: ${c.remaining}</span></div>
          ${again}
        </div>`;
      };
      const tags = i => [i.group, i.specialty].filter(Boolean).join(' · ');
      const editDays = i => (d.can_manage ? html`<button type="button" class="pl-edit" data-days="${i.id}" aria-label="Alterar o prazo de ${i.text}">${icon('edit')}Alterar prazo</button>` : '');
      // Entre dois itens em aberto: mostra o intervalo ou a opção de incluir
      const gapRow = (i, n) => {
        const before = d.sequence[n - 1];
        if (!before || i.resolved || before.resolved) return '';
        if (!i.gap_days && !d.can_manage) return '';
        return html`<li class="pl-gap ${i.gap_days ? 'has-gap' : ''}">${i.gap_days ? html`<b>Intervalo de ${i.gap_days} ${i.gap_days === 1 ? 'dia útil' : 'dias úteis'}</b>` : ''}
          ${d.can_manage ? html`<button type="button" class="pl-edit" data-gap="${i.id}">${i.gap_days ? 'Alterar' : '+ Intervalo'}</button>` : ''}</li>`;
      };
      const askGap = async id => {
        const it = d.sequence.find(i => i.id === id);
        await sheet({ title: 'Intervalo entre itens', submitLabel: 'Salvar',
          body: html`<p class="muted" style="margin:0 0 8px">Antes de: ${it.text}</p>
            <div class="field"><label class="req" for="pl-gp">Intervalo em dias úteis</label><input id="pl-gp" name="gap_days" type="text" inputmode="numeric" required value="${it.gap_days || ''}" placeholder="Ex.: 2"></div>
            <span class="hint">O profissional fica sem atividade nesses dias. Este item e os seguintes são empurrados, e o intervalo consome o tempo do período. Use 0 para tirar.</span>`,
          onSubmit: async f => { d = await api(`/tasks/${taskId}/plan/gap`, { method: 'POST', body: { worker_id: Number(st.worker), item_id: id, gap_days: f.gap_days, start: st.start || null, end: st.start && st.end ? st.end : null } }); return f; } });
        draw();
      };
      const askDays = async id => {
        const inSeq = d.sequence.find(i => i.id === id);
        const it = inSeq || d.pending.find(i => i.id === id);
        await sheet({ title: 'Alterar prazo', submitLabel: 'Salvar',
          body: html`<p class="muted" style="margin:0 0 8px">${it.text}</p>
            <div class="field"><label class="req" for="pl-dd">Prazo em dias</label><input id="pl-dd" name="days" type="text" inputmode="decimal" required value="${numBR(it.days)}"></div>
            <span class="hint">${inSeq ? 'Muda o tempo consumido, o valor e o término. Os itens seguintes se ajustam.' : `Muda o tempo que este item vai consumir e o valor${it.qty > 1 ? `, para cada uma das ${it.qty} vagas` : ''}.`}</span>`,
          onSubmit: async f => { d = await api(`/tasks/${taskId}/plan/days`, { method: 'POST', body: { worker_id: Number(st.worker), item_id: id, days: f.days, start: st.start || null, end: st.start && st.end ? st.end : null } }); return f; } });
        draw();
      };

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
                    <span class="pl-days">${daysLabel(i.days)}${i.qty > 1 ? ` · ${i.qty} vagas` : ''}${i.value !== undefined ? ` · ${BRL.format(i.value)}` : ''}${editDays(i)}</span>
                    ${i.fits ? '' : html`<em>Não cabe: precisa de ${daysLabel(needOf(i.days))} e restam ${daysLabel(d.capacity.remaining)}</em>`}</div>
                  ${edit ? html`<button type="button" class="btn ${i.fits ? 'btn-primary' : 'btn-ghost'} btn-sm" data-link="${i.id}" ${i.fits ? '' : 'disabled'}>${icon('plus')}Vincular</button>` : ''}
                </li>`)}</ul>` : html`<p class="muted card-body">Nenhuma pendência desta função sem profissional neste check-list.</p>`}
              ${d.items_without_team ? html`<p class="hint pl-hint">${d.items_without_team} ${d.items_without_team === 1 ? 'item em aberto está' : 'itens em aberto estão'} sem equipe e não ${d.items_without_team === 1 ? 'aparece' : 'aparecem'} aqui. Informe a função e os dias na edição do item.</p>` : ''}
            </section>
            <section class="card pl-col"><div class="card-head"><h2>Sequência de ${w.name}</h2><span class="sub">${daysLabel(d.totals.days)}${d.totals.value !== undefined ? ` · ${BRL.format(d.totals.value)}` : ''}</span></div>
              ${d.sequence.length ? html`<ol class="pl-seq">${d.sequence.map((i, n) => html`${gapRow(i, n)}<li class="pl-step ${i.resolved ? 'is-done' : ''}">
                <span class="pl-dot">${n + 1}</span>
                <div class="pl-main"><b>${i.text}</b>${tags(i) ? html`<small>${tags(i)}</small>` : ''}
                  <span class="pl-days">${daysLabel(i.days)} · ${span(i)}${i.value !== undefined ? ` · ${BRL.format(i.value)}` : ''}${i.resolved ? ' · resolvido' : editDays(i)}</span>
                  ${i.pushed_days ? html`<em>Início adiado: ${daysLabel(i.pushed_days)} ocupado${i.pushed_days === 1 ? '' : 's'} em outros check-lists</em>` : ''}
                  ${i.outside ? html`<em>Fora das datas escolhidas</em>` : ''}</div>
                ${edit && !i.resolved ? html`<button type="button" class="icon-btn" data-unlink="${i.id}" aria-label="Tirar ${i.text} da sequência">✕</button>` : ''}
              </li>`)}</ol>` : html`<p class="muted card-body">Nenhum item vinculado ainda.</p>`}
              ${d.sequence.length ? html`<div class="pl-report"><a class="btn btn-ghost btn-sm" href="#/imprimir/checklist/${taskId}?sep=profissional&prof=${w.id}&fmt=lista">${icon('print')}Emitir relatório de ${w.name}</a></div>` : ''}
              ${d.others.length ? html`<details class="pl-others"><summary>Outros check-lists desta obra (${d.others.length})</summary>
                <ul>${d.others.map(o => html`<li>${o.link ? html`<a href="${o.link}"><b class="mono">${o.code}</b> ${o.title}</a>` : html`<b class="mono">${o.code}</b> ${o.title}`} · ${daysLabel(o.days)} · ${span(o)}</li>`)}</ul>
                <p class="hint">Só os itens com data dentro do período consomem o tempo.</p></details>` : ''}
            </section>
          </div>`.toString();
      };

      const load = async () => {
        try { d = await api(url()); draw(); } catch (e) { toast(e.message, 'err'); }
      };
      // Enquanto o ano é digitado o campo passa por 0002, 0020, 0202: só vale quando a data está completa
      const typing = v => !!v && v < '2000-01-01';
      const fillUndated = async () => {
        try {
          const n = d.schedule.undated;
          d = await api(`/tasks/${taskId}/plan/reschedule`, { method: 'POST', body: { worker_id: Number(st.worker), only_undated: true, start: st.start, end: st.end || null } });
          toast(n === 1 ? 'A atividade sem data recebeu as datas.' : `${n} atividades sem data receberam as datas.`);
        } catch (er) { toast(er.message, 'err'); }
        draw();
      };
      const syncFilters = () => {
        if (typing(inS.value) || typing(inE.value)) return null;
        st.worker = selW.value; st.start = inS.value; st.end = inE.value;
        clear.hidden = !st.start && !st.end;
        inE.min = st.start;
        if (st.end && !st.start) toast('Informe também o dia em que o profissional inicia.', 'warn');
        if (st.start && st.end && st.end < st.start) { toast('A data final não pode ser antes do início.', 'err'); return null; }
        return load();
      };
      inE.addEventListener('change', syncFilters);
      // Escolheu o dia: quem ainda não tem data já recebe; quem tem data só muda pelo botão Reprogramar
      inS.addEventListener('change', async () => {
        const loaded = syncFilters();
        if (!loaded) return;
        await loaded;
        if (st.start && d.schedule?.undated && d.can_manage) fillUndated();
      });
      // Ao escolher o profissional, o dia de início vem da sequência já programada dele
      selW.addEventListener('change', async () => {
        st.worker = selW.value;
        if (st.start) return syncFilters();
        await load();
        const first = d.sequence?.filter(i => !i.resolved && i.start_date).map(i => i.start_date).sort()[0];
        if (first) { inS.value = first; syncFilters(); }
      });
      clear.addEventListener('click', () => { inS.value = ''; inE.value = ''; syncFilters(); });

      box.addEventListener('click', async e => {
        const dd = e.target.closest('[data-days]');
        if (dd) return askDays(Number(dd.dataset.days));
        const gg = e.target.closest('[data-gap]');
        if (gg) return askGap(Number(gg.dataset.gap));
        if (e.target.closest('[data-fill]')) return fillUndated();
        const a = e.target.closest('[data-link]'), b = e.target.closest('[data-unlink]'), r = e.target.closest('[data-resched]');
        if (!a && !b && !r) return;
        const btn = a || b || r;
        btn.disabled = true;
        const body = { worker_id: Number(st.worker), item_id: Number(btn.dataset.link || btn.dataset.unlink) || null, start: st.start || null, end: st.start && st.end ? st.end : null };
        try {
          d = await api(`/tasks/${taskId}/plan/${a ? 'link' : b ? 'unlink' : 'reschedule'}`, { method: 'POST', body });
          toast(a ? 'Item vinculado.' : b ? 'Item retirado da sequência.' : 'Sequência reprogramada.');
          draw();
        } catch (er) { toast(er.message, 'err'); load(); }
      });
      draw();
    },
  };
}
