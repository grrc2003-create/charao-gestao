// Cotações do projeto: itens por disciplina, propostas por item (meta: 3), solicitações com evidência do envio,
// cobranças, propostas recebidas (preço por item, revisões e arquivo) e cadastro único de fornecedores.
import { html, api, icon, fmtDate, todayISO } from '../core.js';
import { toast, sheet, confirmSheet, readAttachments } from '../ui.js';
import { pageHead } from './shared.js';

const BRL = new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' });
const money = v => (v === null || v === undefined ? '—' : BRL.format(Number(v) || 0));
const parseNum = v => { const s = String(v ?? '').trim(); if (!s) return ''; const n = Number(/,\d{1,2}$/.test(s) || /^\d{1,3}(\.\d{3})+(,\d+)?$/.test(s) ? s.replace(/\./g, '').replace(',', '.') : s.replace(',', '.')); return Number.isFinite(n) ? n : s; };
const dm = d => (d ? fmtDate(d).slice(0, 5) : '—');
const BUCKETS = [['tres', '3 ou mais', 'qt-b3'], ['dois', '2 propostas', 'qt-b2'], ['um', '1 proposta', 'qt-b1'], ['nenhuma', 'Nenhuma', 'qt-b0']];
const pct = (n, t) => (t ? Math.round((n / t) * 100) : 0);
const bar = (o, total) => html`<div class="qt-bar" role="img" aria-label="${BUCKETS.map(([k, l]) => `${l}: ${o[k]}`).join(', ')}">${BUCKETS.map(([k, , c]) => (o[k] ? html`<span class="${c}" style="width:${pct(o[k], total)}%"></span>` : ''))}</div>`;
const legend = html`<div class="qt-leg">${BUCKETS.map(([, l, c]) => html`<span><i class="${c}"></i>${l === '3 ou mais' ? '3+' : l === 'Nenhuma' ? 'nenhuma' : l.split(' ')[0]}</span>`)}</div>`;

// Indicador de cotações (fileira de indicadores do projeto): situação, faixas de propostas e solicitações
export function quotesKpi(s) {
  if (!s?.items) return { value: 'Não iniciada', foot: html`<div class="qk-st qk-none">Nenhum item cadastrado</div><div class="qk-l">Toque para cadastrar os itens ou importar a planilha</div>` };
  const b = s.buckets, rq = s.requests;
  const falta = s.items - b.tres;
  const st = !falta ? ['qk-ok', 'Meta atingida em todos os itens'] : !rq.total ? ['qk-none', 'Sem solicitações enviadas'] : rq.vencida || s.no_request ? ['qk-warn', `Em andamento · faltam ${falta} ${falta === 1 ? 'item' : 'itens'}`] : ['qk-run', `Em andamento · faltam ${falta} ${falta === 1 ? 'item' : 'itens'}`];
  return {
    value: html`${b.tres}<small> de ${s.items} ${s.items === 1 ? 'item' : 'itens'} com 3+</small>`,
    foot: html`<div class="qk-st ${st[0]}">${st[1]}</div>${bar(b, s.items)}
      <div class="qk-l qk-leg">${BUCKETS.map(([k, l, c]) => html`<span><i class="${c}"></i>${l === '3 ou mais' ? '3+' : l === 'Nenhuma' ? 'sem' : l.split(' ')[0]} <b>${b[k]}</b></span>`)}</div>
      <div class="qk-l">${rq.total} solicitaç${rq.total === 1 ? 'ão' : 'ões'} · ${rq.recebida} recebida(s) · ${rq.enviada} aguardando${rq.vencida ? html` · <b class="qk-late">${rq.vencida} vencida(s)</b>` : ''}${s.no_request ? html` · <b class="qk-late">${s.no_request} item(ns) sem solicitação</b>` : ''}</div>`,
  };
}

// Card de status (tela do projeto e topo do mapa)
export function quotesCard(s, projectId, { link = true } = {}) {
  if (!s) return '';
  if (!s.items) return link ? html`<section class="card section qt-card"><div class="card-head"><h2>${icon('file')}Cotações</h2></div><div class="card-body qt-empty"><p class="muted" style="margin:0">Nenhum item para cotar ainda. Cadastre os itens ou importe o mapa de cotações da planilha.</p><a class="btn btn-primary btn-sm" href="#/projetos/${projectId}/cotacoes">${icon('plus')}Começar as cotações</a></div></section>` : '';
  const go = q => (link ? `#/projetos/${projectId}/cotacoes${q ? `?${q}` : ''}` : null);
  const rq = s.requests;
  return html`<section class="card section qt-card"><div class="card-head"><h2>${icon('file')}Cotações</h2><span class="sub">meta: ${s.target} propostas por item · ${s.items} item(ns)</span>
      ${link ? html`<a class="btn btn-ghost btn-sm" href="#/projetos/${projectId}/cotacoes">Abrir mapa de cotações</a>` : ''}</div>
    <div class="card-body">
      <div class="qt-kpis">${BUCKETS.map(([k, l, c]) => (go() ? html`<a class="qt-kpi ${c}" href="${go(`faixa=${k}`)}" title="Ver os itens: ${l}"><span>${l}</span><b>${s.buckets[k]}</b><small>${pct(s.buckets[k], s.items)}%</small></a>`
        : html`<div class="qt-kpi ${c}"><span>${l}</span><b>${s.buckets[k]}</b><small>${pct(s.buckets[k], s.items)}%</small></div>`))}</div>
      ${bar(s.buckets, s.items)}
      <div class="qt-rq"><span>${icon('send')}${rq.total} solicitação(ões) enviada(s)</span><span>${icon('check')}${rq.recebida} recebida(s)</span><span>${icon('clock')}${rq.enviada} aguardando</span>
        ${rq.vencida ? (go() ? html`<a class="qt-late" href="${go('faixa=vencidas')}">${icon('alert')}${rq.vencida} com prazo vencido</a>` : html`<span class="qt-late">${icon('alert')}${rq.vencida} com prazo vencido</span>`) : ''}${rq.declinou ? html`<span>${icon('x')}${rq.declinou} declinaram</span>` : ''}
        ${s.no_request ? (go() ? html`<a class="qt-late" href="${go('faixa=sem_solicitacao')}">${s.no_request} item(ns) sem nenhuma solicitação</a>` : html`<span class="qt-late">${s.no_request} item(ns) sem nenhuma solicitação</span>`) : ''}</div>
      ${s.disciplines.length > 1 ? html`<div class="table-wrap"><table class="data qt-disc"><thead><tr><th>Disciplina</th><th class="num">Itens</th><th>Propostas por item</th><th class="num">Sem proposta</th></tr></thead>
        <tbody>${s.disciplines.map(d => html`<tr><td>${link ? html`<a href="#/projetos/${projectId}/cotacoes?disc=${encodeURIComponent(d.discipline)}">${d.discipline}</a>` : d.discipline}</td><td class="num">${d.items}</td><td>${bar(d, d.items)}</td><td class="num">${d.nenhuma}</td></tr>`)}</tbody></table></div>` : ''}
      ${legend}
    </div></section>`;
}

const ST = { enviada: ['Aguardando', 'qt-s-wait'], recebida: ['Recebida', 'qt-s-ok'], declinou: ['Declinou', 'qt-s-no'] };
const stPill = o => (o.status === 'recebida' && o.price === null ? html`<span class="qt-pill qt-s-no">Sem preço neste item</span>` : o.overdue ? html`<span class="qt-pill qt-s-late">Vencida ${dm(o.due_date)}</span>` : html`<span class="qt-pill ${ST[o.status][1]}">${ST[o.status][0]}${o.status === 'recebida' && o.received_date ? ` ${dm(o.received_date)}` : o.status === 'enviada' && o.due_date ? ` até ${dm(o.due_date)}` : ''}</span>`);
const files = (r, kind) => r.files.filter(f => f.kind === kind).map((f, i, a) => html`<a href="/api/quote-files/${f.id}" target="_blank" rel="noopener" title="${f.original_name || ''}">${icon(f.mime === 'application/pdf' ? 'file' : 'image')}${kind === 'envio' ? 'envio' : kind === 'cobranca' ? 'cobrança' : `proposta${f.revision ? ` R${String(f.revision).padStart(2, '0')}` : ''}`}${a.length > 1 ? ` ${i + 1}` : ''}</a>`);

export async function view({ params, query, setQuery, render }) {
  const d = await api(`/projects/${params.id}/quotes`);
  const disc = query.get('disc') || '';
  const open = Number(query.get('item')) || 0;
  const discs = [...new Set(d.items.map(i => i.discipline))];
  const FAIXAS = { tres: ['3 ou mais propostas', i => i.received >= d.target], dois: ['2 propostas', i => i.received === 2], um: ['1 proposta', i => i.received === 1], nenhuma: ['sem proposta', i => i.received === 0],
    vencidas: ['com solicitação vencida', i => i.overdue > 0], sem_solicitacao: ['sem nenhuma solicitação', i => !i.requested] };
  const faixa = FAIXAS[query.get('faixa')] ? query.get('faixa') : '';
  const items = (disc ? d.items.filter(i => i.discipline === disc) : d.items).filter(i => !faixa || FAIXAS[faixa][1](i));
  const reqById = new Map(d.requests.map(r => [r.id, r]));
  const groups = (disc ? [disc] : discs).map(k => [k, items.filter(i => i.discipline === k)]).filter(([, l]) => l.length);
  const reqActs = r => !d.can_edit ? '' : html`<span class="qt-acts">
    ${r.status !== 'declinou' ? html`<button type="button" class="btn btn-ghost btn-sm" data-q-recv="${r.id}">${icon('check')}${r.status === 'recebida' ? 'Revisão' : 'Lançar proposta'}</button>` : ''}
    ${r.status === 'enviada' ? html`<button type="button" class="btn btn-ghost btn-sm" data-q-fup="${r.id}">${icon('send')}Cobrar</button><button type="button" class="btn btn-ghost btn-sm" data-q-dec="${r.id}">Declinou</button>` : ''}
    ${r.status !== 'enviada' ? html`<button type="button" class="btn btn-ghost btn-sm" data-q-reopen="${r.id}">Reabrir</button>` : ''}
    <button type="button" class="icon-btn" data-q-delreq="${r.id}" title="Excluir solicitação" aria-label="Excluir solicitação">${icon('trash')}</button></span>`;
  const itemRow = it => html`<tr class="qt-item ${open === it.id ? 'is-open' : ''}" data-q-item="${it.id}" tabindex="0">
      <td><b>${it.description}</b><small>${[it.code, it.location, it.qty != null ? `${String(it.qty).replace('.', ',')} ${it.unit || ''}` : it.unit, it.abc ? `curva ${it.abc}` : ''].filter(Boolean).join(' · ')}</small></td>
      <td><span class="qt-pill ${it.received >= d.target ? 'qt-b3' : it.received === 2 ? 'qt-b2' : it.received === 1 ? 'qt-b1' : 'qt-b0'}">${it.received} de ${d.target}</span></td>
      <td class="num">${money(it.median)}<small>${it.received > 1 ? `menor ${money(it.min)}` : ''}</small></td>
      <td><small class="${it.overdue ? 'qt-late' : ''}">${it.requested ? `${it.requested} enviada(s)${it.pending ? ` · ${it.pending} aguardando` : ''}${it.overdue ? ` · ${it.overdue} vencida(s)` : ''}` : html`<span class="qt-late">nenhuma enviada</span>`}</small></td></tr>
    ${open === it.id ? html`<tr class="qt-det"><td colspan="4">
      ${it.offers.length ? html`<ul class="qt-offers">${it.offers.map(o => { const r = reqById.get(o.request_id); return html`<li>
        <div class="qt-of-main"><b>${o.supplier_name}</b><small>enviada ${dm(o.sent_date)}${r.channel ? ` · ${r.channel}` : ''}${r.imported ? ' · importada da planilha' : ''}${r.followups.length ? ` · ${r.followups.length} cobrança(s)` : ''}${r.conditions ? ` · ${r.conditions}` : ''}</small>
          <span class="qt-files">${files(r, 'envio')}${files(r, 'cobranca')}${files(r, 'proposta')}</span></div>
        <div class="qt-of-st">${stPill(o)}<b class="qt-price">${money(o.price)}${o.revision ? html`<small> R${String(o.revision).padStart(2, '0')}</small>` : ''}</b></div>
        ${reqActs(r)}</li>`; })}</ul>` : html`<p class="muted" style="margin:0">Nenhuma solicitação enviada para este item.</p>`}
      ${d.can_edit ? html`<div class="qt-it-acts"><button type="button" class="btn btn-primary btn-sm" data-q-req-item="${it.id}">${icon('send')}Solicitar proposta</button>
        <button type="button" class="btn btn-ghost btn-sm" data-q-edit="${it.id}">${icon('edit')}Editar item</button><button type="button" class="btn btn-ghost btn-sm qt-danger" data-q-del="${it.id}">${icon('trash')}Excluir item</button></div>` : ''}
    </td></tr>` : ''}`;
  return {
    title: `Cotações · ${d.project.code}`,
    html: html`${pageHead({
        back: { href: `#/projetos/${d.project.id}`, label: `${d.project.code} · ${d.project.name}` },
        eyebrow: 'Cotações', title: 'Mapa de cotações', sub: `Meta: ${d.target} propostas por item. A evidência do envio é obrigatória em cada solicitação.`,
        actions: html`${d.items.length ? html`<a class="btn btn-ghost" href="/api/projects/${d.project.id}/quotes/export.xlsx" download>${icon('file')}Exportar Excel</a><a class="btn btn-ghost" href="#/imprimir/cotacoes/${d.project.id}">${icon('print')}PDF</a>` : ''}${d.can_edit ? html`<button type="button" class="btn btn-ghost" data-q-suppliers>${icon('users')}Fornecedores</button>
          <button type="button" class="btn btn-ghost" data-q-import>${icon('file')}Importar planilha</button>
          <button type="button" class="btn btn-ghost" data-q-newitem>${icon('plus')}Novo item</button>
          <button type="button" class="btn btn-primary" data-q-req>${icon('send')}Solicitar proposta</button>` : ''}` })}
      ${d.items.length ? quotesCard(d.summary, d.project.id, { link: false }) : ''}
      ${faixa ? html`<div class="notice section qt-filter">${icon('info')}<span>Mostrando só os itens <b>${FAIXAS[faixa][0]}</b> (${items.length}).</span><button type="button" class="btn btn-ghost btn-sm" data-q-faixa-off>Ver todos</button></div>` : ''}
      ${discs.length > 1 ? html`<div class="chips section" role="group" aria-label="Disciplina"><button class="chip" data-q-disc="" aria-pressed="${!disc}">Todas</button>${discs.map(k => html`<button class="chip" data-q-disc="${k}" aria-pressed="${disc === k}">${k}</button>`)}</div>` : ''}
      ${groups.length ? groups.map(([k, list]) => html`<section class="card section"><div class="card-head"><h2>${k}</h2><span class="sub">${list.length} item(ns) · ${list.filter(i => i.received >= d.target).length} com ${d.target}+ propostas</span></div>
        <div class="table-wrap"><table class="data qt-items"><thead><tr><th>Item</th><th>Propostas</th><th class="num">Mediano</th><th>Solicitações</th></tr></thead><tbody>${list.map(itemRow)}</tbody></table></div></section>`)
        : html`<div class="empty-state"><h2>Nenhum item para cotar</h2><p>Cadastre os itens (por disciplina) ou importe o mapa de cotações no modelo atual da planilha.</p></div>`}`,
    mount(root) {
      const reload = () => render();
      root.querySelectorAll('[data-q-disc]').forEach(b => b.addEventListener('click', () => { setQuery({ disc: b.dataset.qDisc, item: '', faixa }); render(); }));
      root.querySelector('[data-q-faixa-off]')?.addEventListener('click', () => { setQuery({ disc, item: '', faixa: '' }); render(); });
      root.querySelectorAll('[data-q-item]').forEach(tr => tr.addEventListener('click', e => { if (e.target.closest('button,a')) return; const id = Number(tr.dataset.qItem); setQuery({ disc, item: open === id ? '' : id, faixa }); render(); }));
      root.querySelector('[data-q-newitem]')?.addEventListener('click', () => itemSheet(d, null, disc, reload));
      root.querySelectorAll('[data-q-edit]').forEach(b => b.addEventListener('click', () => itemSheet(d, d.items.find(i => i.id === Number(b.dataset.qEdit)), disc, reload)));
      root.querySelectorAll('[data-q-del]').forEach(b => b.addEventListener('click', async () => {
        const it = d.items.find(i => i.id === Number(b.dataset.qDel));
        if (!(await confirmSheet('Excluir item', `"${it.description}" e os preços lançados para ele serão excluídos.`, 'Excluir', true))) return;
        try { await api(`/projects/${d.project.id}/quotes/items/${it.id}`, { method: 'DELETE' }); toast('Item excluído.'); setQuery({ disc, item: '' }); reload(); } catch (ex) { toast(ex.message, 'err'); }
      }));
      root.querySelector('[data-q-req]')?.addEventListener('click', () => requestSheet(d, { disc }, reload));
      root.querySelectorAll('[data-q-req-item]').forEach(b => b.addEventListener('click', () => requestSheet(d, { disc, itemId: Number(b.dataset.qReqItem) }, reload)));
      root.querySelectorAll('[data-q-recv]').forEach(b => b.addEventListener('click', () => receiveSheet(d, reqById.get(Number(b.dataset.qRecv)), reload)));
      root.querySelectorAll('[data-q-fup]').forEach(b => b.addEventListener('click', () => followupSheet(d, reqById.get(Number(b.dataset.qFup)), reload)));
      root.querySelectorAll('[data-q-dec]').forEach(b => b.addEventListener('click', async () => {
        const r = await sheet({ title: 'Fornecedor declinou', submitLabel: 'Confirmar', body: html`<div class="field"><label for="q-dn">Motivo (opcional)</label><input type="text" id="q-dn" name="notes" maxlength="1000" placeholder="Ex.: não atende a região"></div>`,
          onSubmit: x => api(`/quote-requests/${b.dataset.qDec}/decline`, { method: 'POST', body: x }) });
        if (r) { toast('Registrado: o fornecedor declinou.'); reload(); }
      }));
      root.querySelectorAll('[data-q-reopen]').forEach(b => b.addEventListener('click', async () => {
        if (!(await confirmSheet('Reabrir solicitação', 'Volta a aguardar resposta. Preços e arquivos de proposta desta solicitação são retirados.', 'Reabrir', true))) return;
        try { await api(`/quote-requests/${b.dataset.qReopen}/reopen`, { method: 'POST', body: {} }); toast('Solicitação reaberta.'); reload(); } catch (ex) { toast(ex.message, 'err'); }
      }));
      root.querySelectorAll('[data-q-delreq]').forEach(b => b.addEventListener('click', async () => {
        if (!(await confirmSheet('Excluir solicitação', 'A solicitação, os preços e as evidências anexadas serão excluídos.', 'Excluir', true))) return;
        try { await api(`/quote-requests/${b.dataset.qDelreq}`, { method: 'DELETE' }); toast('Solicitação excluída.'); reload(); } catch (ex) { toast(ex.message, 'err'); }
      }));
      root.querySelector('[data-q-import]')?.addEventListener('click', () => importSheet(d, reload));
      root.querySelector('[data-q-suppliers]')?.addEventListener('click', () => suppliersSheet(reload));
    },
  };
}

async function itemSheet(d, it, disc, done) {
  const discs = [...new Set(d.items.map(i => i.discipline))];
  const v = it || { discipline: disc || '' };
  const r = await sheet({
    title: it ? 'Editar item' : 'Novo item para cotar',
    body: html`<div class="form-row"><div class="field"><label class="req" for="qi-d">Disciplina</label><input type="text" id="qi-d" name="discipline" required maxlength="80" list="qi-dl" value="${v.discipline || ''}" placeholder="Ex.: Climatização (HVAC)"><datalist id="qi-dl">${discs.map(x => html`<option value="${x}">`)}</datalist></div>
        <div class="field"><label for="qi-c">Código do orçamento</label><input type="text" id="qi-c" name="code" maxlength="60" value="${v.code || ''}"></div></div>
      <div class="field"><label class="req" for="qi-desc">Descrição</label><input type="text" id="qi-desc" name="description" required maxlength="500" value="${v.description || ''}"></div>
      <div class="form-row"><div class="field"><label for="qi-l">Local</label><input type="text" id="qi-l" name="location" maxlength="160" value="${v.location || ''}"></div>
        <div class="field"><label for="qi-q">Quantidade</label><input type="text" id="qi-q" name="qty" inputmode="decimal" value="${v.qty != null ? String(v.qty).replace('.', ',') : ''}"></div>
        <div class="field"><label for="qi-u">Unidade</label><input type="text" id="qi-u" name="unit" maxlength="20" value="${v.unit || ''}"></div>
        <div class="field"><label for="qi-a">Curva ABC</label><select id="qi-a" name="abc"><option value="">—</option>${['A', 'B', 'C'].map(x => html`<option ${v.abc === x ? 'selected' : ''}>${x}</option>`)}</select></div></div>
      <div class="field"><label for="qi-n">Observação</label><input type="text" id="qi-n" name="notes" maxlength="1000" value="${v.notes || ''}"></div>`,
    submitLabel: it ? 'Salvar' : 'Incluir item',
    onSubmit: x => api(it ? `/projects/${d.project.id}/quotes/items/${it.id}` : `/projects/${d.project.id}/quotes/items`, { method: it ? 'PUT' : 'POST', body: { ...x, qty: parseNum(x.qty) } }),
  });
  if (r) { toast(it ? 'Item salvo.' : 'Item incluído.'); done(); }
}

async function newSupplier(prefill = {}) {
  return sheet({
    title: 'Novo fornecedor',
    body: html`<div class="field"><label class="req" for="qs-n">Nome</label><input type="text" id="qs-n" name="name" required maxlength="160" value="${prefill.name || ''}"></div>
      <div class="form-row"><div class="field"><label for="qs-c">CNPJ</label><input type="text" id="qs-c" name="cnpj" maxlength="30"></div><div class="field"><label for="qs-p">Telefone</label><input type="text" id="qs-p" name="phone" maxlength="80"></div></div>
      <div class="form-row"><div class="field"><label for="qs-e">E-mail</label><input type="email" id="qs-e" name="email" maxlength="160"></div><div class="field"><label for="qs-ct">Contato</label><input type="text" id="qs-ct" name="contact" maxlength="120"></div></div>
      <div class="field"><label for="qs-a">Endereço</label><input type="text" id="qs-a" name="address" maxlength="300"></div>
      <div class="field"><label for="qs-d">Disciplinas que atende</label><input type="text" id="qs-d" name="disciplines" maxlength="400" value="${prefill.disciplines || ''}" placeholder="Separe por vírgula. Ex.: HVAC, Elétrica"></div>`,
    submitLabel: 'Cadastrar',
    onSubmit: x => api('/suppliers', { method: 'POST', body: x }),
  });
}

// Solicitar proposta: fornecedor, itens, envio, meio, prazo e evidência (obrigatória)
async function requestSheet(d, { disc = '', itemId = null } = {}, done) {
  const byDisc = [...new Set(d.items.map(i => i.discipline))].map(k => [k, d.items.filter(i => i.discipline === k)]);
  const pre = itemId ? d.items.find(i => i.id === itemId)?.discipline : disc;
  const supOpts = list => html`<option value="">Escolha…</option>${list.map(s => html`<option value="${s.id}">${s.name}${s.disciplines.length ? ` · ${s.disciplines.join(', ')}` : ''}</option>`)}<option value="__new">+ Novo fornecedor…</option>`;
  const p = sheet({
    title: 'Solicitar proposta', wide: true,
    body: html`<div class="field"><label class="req" for="qr-s">Fornecedor</label><select id="qr-s" name="supplier_id" required>${supOpts(d.suppliers)}</select><span class="hint">Cadastro único de fornecedores (vale para todos os projetos).</span></div>
      <div class="field"><span class="label req">Itens desta solicitação</span>
        <div class="qr-items">${byDisc.map(([k, list]) => html`<details ${!pre || k === pre ? 'open' : ''}><summary><label><input type="checkbox" data-qr-all="${k}"> ${k}</label> <small>${list.length} item(ns)</small></summary>
          ${list.map(i => html`<label class="qr-it"><input type="checkbox" name="it_${i.id}" data-qr-it="${i.id}" data-qr-disc="${k}" ${itemId === i.id ? 'checked' : ''}>${i.description}<small>${i.received} de ${d.target}</small></label>`)}</details>`)}</div></div>
      <div class="form-row"><div class="field"><label class="req" for="qr-d">Enviada em</label><input type="date" id="qr-d" name="sent_date" required max="${todayISO()}" value="${todayISO()}"></div>
        <div class="field"><label for="qr-c">Meio</label><select id="qr-c" name="channel">${d.channels.map(c => html`<option>${c}</option>`)}</select></div>
        <div class="field"><label for="qr-due">Responder até</label><input type="date" id="qr-due" name="due_date"></div></div>
      <div class="field"><label class="req" for="qr-f">Evidência do envio</label><input type="file" id="qr-f" accept="image/*,application/pdf,.pdf" multiple required><span class="hint">Print do e-mail ou do WhatsApp, ou o PDF enviado. Obrigatório.</span></div>
      <div class="field"><label for="qr-n">Observação</label><input type="text" id="qr-n" name="notes" maxlength="1000"></div>`,
    submitLabel: 'Registrar envio',
    onSubmit: async (x, form) => {
      if (!x.supplier_id || x.supplier_id === '__new') throw new Error('Escolha o fornecedor.');
      const ids = [...form.querySelectorAll('[data-qr-it]:checked')].map(i => Number(i.dataset.qrIt));
      if (!ids.length) throw new Error('Escolha os itens desta solicitação.');
      const fs = form.querySelector('#qr-f').files;
      if (!fs?.length) throw new Error('Anexe a evidência do envio.');
      const files = await readAttachments(fs);
      return api(`/projects/${d.project.id}/quotes/requests`, { method: 'POST', body: { supplier_id: Number(x.supplier_id), item_ids: ids, sent_date: x.sent_date, channel: x.channel, due_date: x.due_date, notes: x.notes, files: files.map(f => ({ data: f.data, name: f.name })) } });
    },
  });
  const form = document.querySelector('.sheet-backdrop:last-child form');
  form.addEventListener('change', async e => {
    if (e.target.dataset.qrAll) form.querySelectorAll(`[data-qr-disc="${CSS.escape(e.target.dataset.qrAll)}"]`).forEach(i => { i.checked = e.target.checked; });
    if (e.target.id === 'qr-s' && e.target.value === '__new') {
      const s = await newSupplier({ disciplines: pre || '' });
      const sel = form.querySelector('#qr-s');
      if (s) { d.suppliers.push(s); sel.innerHTML = supOpts(d.suppliers).toString(); sel.value = s.id; toast('Fornecedor cadastrado.'); } else sel.value = '';
    }
  });
  const r = await p;
  if (r) { toast('Envio registrado com a evidência.'); done(); }
}

// Proposta recebida (ou revisão): preço por item, datas, condições e arquivo
async function receiveSheet(d, rq, done) {
  const its = rq.item_ids.map(id => d.items.find(i => i.id === id)).filter(Boolean);
  const cur = id => d.items.find(i => i.id === id)?.offers.find(o => o.request_id === rq.id)?.price;
  const r = await sheet({
    title: `${rq.status === 'recebida' ? 'Revisão da proposta' : 'Proposta recebida'} · ${rq.supplier_name}`, wide: true,
    body: html`<div class="form-row"><div class="field"><label class="req" for="qv-d">Recebida em</label><input type="date" id="qv-d" name="received_date" required max="${todayISO()}" min="${rq.sent_date}" value="${todayISO()}"></div>
        <div class="field"><label for="qv-v">Validade</label><input type="date" id="qv-v" name="valid_until" value="${rq.valid_until || ''}"></div></div>
      <div class="table-wrap"><table class="data"><thead><tr><th>Item</th><th class="num" style="width:180px">Preço (R$)</th></tr></thead>
        <tbody>${its.map(i => html`<tr><td>${i.description}<small class="muted" style="display:block">${i.discipline}</small></td><td class="num"><input type="text" inputmode="decimal" data-qv-it="${i.id}" value="${cur(i.id) != null ? String(cur(i.id)).replace('.', ',') : ''}" style="text-align:right" placeholder="Sem preço"></td></tr>`)}</tbody></table></div>
      <div class="field"><label for="qv-f">Arquivo da proposta</label><input type="file" id="qv-f" accept="image/*,application/pdf,.pdf" multiple></div>
      <div class="field"><label for="qv-c">Condições e observações</label><input type="text" id="qv-c" name="conditions" maxlength="1000" value="${rq.conditions || ''}" placeholder="Ex.: pagamento 30/60/90, frete incluso"></div>
      ${rq.status === 'recebida' ? html`<p class="hint" style="margin:0">Salvar cria uma nova revisão (R${String((rq.revision ?? 0) + 1).padStart(2, '0')}); vale o preço mais recente.</p>` : ''}`,
    submitLabel: 'Salvar proposta',
    onSubmit: async (x, form) => {
      const prices = [...form.querySelectorAll('[data-qv-it]')].map(i => ({ item_id: Number(i.dataset.qvIt), price: parseNum(i.value) })).filter(p => p.price !== '');
      if (!prices.length) throw new Error('Informe o preço de ao menos um item.');
      const files = await readAttachments(form.querySelector('#qv-f').files || []);
      return api(`/quote-requests/${rq.id}/receive`, { method: 'POST', body: { ...x, prices, files: files.map(f => ({ data: f.data, name: f.name })) } });
    },
  });
  if (r) { toast('Proposta registrada.'); done(); }
}

async function followupSheet(d, rq, done) {
  const r = await sheet({
    title: `Cobrar · ${rq.supplier_name}`,
    body: html`<div class="form-row"><div class="field"><label class="req" for="qf-d">Cobrado em</label><input type="date" id="qf-d" name="date" required max="${todayISO()}" value="${todayISO()}"></div>
        <div class="field"><label for="qf-c">Meio</label><select id="qf-c" name="channel">${d.channels.map(c => html`<option>${c}</option>`)}</select></div>
        <div class="field"><label for="qf-nd">Novo prazo de resposta</label><input type="date" id="qf-nd" name="new_due_date"></div></div>
      <div class="field"><label for="qf-f">Evidência da cobrança</label><input type="file" id="qf-f" accept="image/*,application/pdf,.pdf" multiple><span class="hint">Opcional: print do e-mail ou WhatsApp.</span></div>
      <div class="field"><label for="qf-n">Observação</label><input type="text" id="qf-n" name="notes" maxlength="1000"></div>`,
    submitLabel: 'Registrar cobrança',
    onSubmit: async (x, form) => {
      const files = await readAttachments(form.querySelector('#qf-f').files || []);
      return api(`/quote-requests/${rq.id}/followup`, { method: 'POST', body: { ...x, files: files.map(f => ({ data: f.data, name: f.name })) } });
    },
  });
  if (r) { toast('Cobrança registrada.'); done(); }
}

// Importar o mapa de cotações (modelo atual): escolher as abas (nenhuma marcada de início)
async function importSheet(d, done) {
  let file = null, prev = null;
  const p = sheet({
    title: 'Importar mapa de cotações', wide: true,
    body: html`<div class="field"><label class="req" for="qm-f">Planilha (.xlsx) no modelo atual</label><input type="file" id="qm-f" accept=".xlsx"><span class="hint">Cada aba vira uma disciplina; cada bloco "PREÇO / NOME / CNPJ…" vira um item com as propostas por empresa.</span></div>
      <div id="qm-prev"></div>
      <p class="hint" style="margin:0">As solicitações importadas ficam marcadas como "importadas da planilha" (sem evidência do envio).</p>`,
    submitLabel: 'Importar abas escolhidas',
    onSubmit: async (x, form) => {
      if (!file) throw new Error('Escolha a planilha.');
      const sheets = [...form.querySelectorAll('[data-qm-sheet]:checked')].map(i => i.dataset.qmSheet);
      if (!sheets.length) throw new Error('Marque as abas que pertencem a este projeto.');
      return api(`/projects/${d.project.id}/quotes/import`, { method: 'POST', body: { file, sheets } });
    },
  });
  const form = document.querySelector('.sheet-backdrop:last-child form');
  form.querySelector('#qm-f').addEventListener('change', async e => {
    const f = e.target.files[0];
    const box = form.querySelector('#qm-prev');
    if (!f) return;
    box.innerHTML = '<p class="muted">Lendo a planilha…</p>';
    const data = await new Promise((res, rej) => { const rd = new FileReader(); rd.onload = () => res(rd.result); rd.onerror = rej; rd.readAsDataURL(f); });
    file = { name: f.name, data };
    try {
      prev = await api(`/projects/${d.project.id}/quotes/import/preview`, { method: 'POST', body: { file } });
      box.innerHTML = (prev.sheets.length ? html`<p style="margin:6px 0">Marque as abas deste projeto:</p><ul class="qm-list">${prev.sheets.map(s => html`<li><label><input type="checkbox" data-qm-sheet="${s.sheet}"><b>${s.sheet}</b> → disciplina “${s.discipline}”</label>
          <small>${s.items} item(ns) · ${s.suppliers} fornecedor(es) · ${s.prices} preço(s)${s.sample.length ? ` · ex.: ${s.sample.join('; ')}` : ''}</small></li>`)}</ul>`
        : html`<p class="muted">Nenhuma aba no modelo do mapa de cotações.</p>`).toString();
    } catch (ex) { box.innerHTML = ''; toast(ex.message, 'err'); }
  });
  const r = await p;
  if (r) { toast(`Importado: ${r.items} item(ns), ${r.requests} solicitação(ões), ${r.prices} preço(s), ${r.suppliers} fornecedor(es) novo(s).`); done(); }
}

async function suppliersSheet(done) {
  const list = await api('/suppliers');
  const r = await sheet({
    title: 'Fornecedores', wide: true,
    body: html`${list.length ? html`<div class="table-wrap"><table class="data"><thead><tr><th>Fornecedor</th><th>CNPJ</th><th>Contato</th><th>Disciplinas</th></tr></thead>
      <tbody>${list.map(s => html`<tr><td><b>${s.name}</b></td><td class="nowrap">${s.cnpj || '—'}</td><td>${[s.contact, s.phone, s.email].filter(Boolean).join(' · ') || '—'}</td><td>${s.disciplines.join(', ') || '—'}</td></tr>`)}</tbody></table></div>`
      : html`<p class="muted">Nenhum fornecedor cadastrado.</p>`}
      <button type="button" class="btn btn-ghost btn-sm" data-qs-new>${icon('plus')}Novo fornecedor</button>`,
    submitLabel: 'Fechar',
  });
  void r;
  done();
}
document.addEventListener('click', async e => {
  const b = e.target.closest('[data-qs-new]');
  if (!b) return;
  const s = await newSupplier();
  if (s) { toast('Fornecedor cadastrado.'); document.querySelector('.sheet-backdrop:last-child [data-close]')?.click(); }
});
