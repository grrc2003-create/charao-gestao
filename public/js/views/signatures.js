// Assinatura eletrônica nos documentos: quadro para assinar com o dedo/caneta (tablet ou celular), assinatura salva da
// pessoa cadastrada (com a senha dela), exibição sobre a linha de assinatura e aviso quando o documento muda depois.
import { html, api, icon } from '../core.js';
import { sheet, toast } from '../ui.js';

// ---------- Quadro de assinatura (canvas) ----------
export function signaturePad(canvas) {
  const ctx = canvas.getContext('2d');
  let drawn = false, last = null, mid = null;
  const fit = () => {
    const r = canvas.getBoundingClientRect(), dpr = window.devicePixelRatio || 1;
    canvas.width = Math.max(1, Math.round(r.width * dpr)); canvas.height = Math.max(1, Math.round(r.height * dpr));
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.lineCap = 'round'; ctx.lineJoin = 'round'; ctx.strokeStyle = '#14213D'; ctx.lineWidth = 2.4;
    drawn = false;
  };
  const pos = e => { const r = canvas.getBoundingClientRect(); return { x: e.clientX - r.left, y: e.clientY - r.top }; };
  canvas.addEventListener('pointerdown', e => { e.preventDefault(); canvas.setPointerCapture(e.pointerId); last = pos(e); mid = last; ctx.beginPath(); ctx.arc(last.x, last.y, 1.1, 0, Math.PI * 2); ctx.fillStyle = '#14213D'; ctx.fill(); drawn = true; });
  canvas.addEventListener('pointermove', e => {
    if (!last) return;
    e.preventDefault();
    const p = pos(e), m = { x: (last.x + p.x) / 2, y: (last.y + p.y) / 2 };
    ctx.beginPath(); ctx.moveTo(mid.x, mid.y); ctx.quadraticCurveTo(last.x, last.y, m.x, m.y); ctx.stroke();
    last = p; mid = m; drawn = true;
  });
  const end = () => { last = null; };
  canvas.addEventListener('pointerup', end); canvas.addEventListener('pointercancel', end); canvas.addEventListener('pointerleave', end);
  fit();
  return {
    isEmpty: () => !drawn,
    clear: () => { ctx.clearRect(0, 0, canvas.width, canvas.height); drawn = false; },
    // PNG com fundo transparente, recortado ao redor do traço
    toDataURL() {
      const { width: w, height: h } = canvas;
      const d = ctx.getImageData(0, 0, w, h).data;
      let x0 = w, y0 = h, x1 = -1, y1 = -1;
      for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) if (d[(y * w + x) * 4 + 3] > 8) { if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; }
      if (x1 < 0) return null;
      const pad = 8, sx = Math.max(0, x0 - pad), sy = Math.max(0, y0 - pad), sw = Math.min(w, x1 + pad) - sx, sh = Math.min(h, y1 + pad) - sy;
      const out = document.createElement('canvas');
      const k = Math.min(1, 900 / sw); // limita o tamanho do arquivo
      out.width = Math.round(sw * k); out.height = Math.round(sh * k);
      out.getContext('2d').drawImage(canvas, sx, sy, sw, sh, 0, 0, out.width, out.height);
      return out.toDataURL('image/png');
    },
  };
}
const padHtml = () => html`<div class="sig-pad-wrap"><canvas class="sig-pad" aria-label="Quadro para assinar"></canvas>
  <div class="sig-pad-foot"><span class="hint">Assine com o dedo ou a caneta dentro do quadro</span><button type="button" class="btn btn-ghost btn-sm" data-sig-clear>${icon('x')}Limpar</button></div></div>`;

// ---------- Carregar e exibir ----------
// items: [{ type, key, fp }] (fp = "impressão" do conteúdo, para avisar se o documento mudar depois de assinado)
export async function loadSignatures(items) {
  const S = { docs: {}, can_remove: false, me: {}, fp: {} };
  for (const it of items) S.fp[`${it.type}:${it.key}`] = it.fp;
  if (!items.length) return S;
  try { Object.assign(S, await api('/signatures/query', { method: 'POST', body: { items } })); } catch { /* sem assinaturas: segue o documento */ }
  return S;
}
const sigOf = (S, d) => S?.docs?.[`${d.type}:${d.key}`]?.slots?.[d.slot] || null;
const when = iso => new Date(iso).toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' });
export const signedDate = (S, d) => { const s = sigOf(S, d); return s ? new Date(s.signed_at).toLocaleDateString('pt-BR') : ''; };

// Linha de assinatura (substitui o <span></span> do documento): a imagem fica sobre a linha
export const sigLine = (S, d) => {
  const s = sigOf(S, d);
  return html`<span class="sig-line">${s ? html`<img class="sig-img" src="${s.image_url}" alt="Assinatura de ${s.signer_name}">` : ''}</span>`;
};
// Abaixo do nome: registro da assinatura e o botão Assinar (o botão não sai na impressão)
export const sigInfo = (S, d) => {
  const s = sigOf(S, d);
  const attrs = html`data-sig-type="${d.type}" data-sig-key="${d.key}" data-sig-slot="${d.slot}" data-sig-label="${d.label || ''}" data-sig-name="${d.name || ''}" data-sig-doc="${d.doc || ''}" data-sig-user="${d.userId || ''}"`;
  return html`${s ? html`<small class="sig-meta">Assinado eletronicamente por ${s.signer_name}${s.signer_doc ? ` (${s.signer_doc})` : ''} em ${when(s.signed_at)}${s.method === 'salva' ? ' · assinatura salva, senha confirmada' : ''}
      ${s.changed ? html`<b class="sig-changed">· documento alterado após a assinatura</b>` : ''}</small>` : ''}
    <div class="sig-acts no-print">${!s || s.changed ? html`<button type="button" class="btn btn-ghost btn-sm sig-btn" data-sig-btn ${attrs}>${icon('edit')}${s ? 'Assinar de novo' : 'Assinar'}</button>` : ''}
      ${s && S.can_remove ? html`<button type="button" class="btn btn-ghost btn-sm sig-btn" data-sig-rm="${s.id}">${icon('trash')}Remover</button>` : ''}</div>`;
};

// ---------- Assinar ----------
async function openSign(S, ds, reload) {
  const d = { type: ds.sigType, key: ds.sigKey, slot: ds.sigSlot, label: ds.sigLabel, name: ds.sigName, doc: ds.sigDoc, userId: Number(ds.sigUser) || null };
  const signers = await api('/signatures/signers').catch(() => []);
  const def = signers.find(u => u.id === d.userId) || signers.find(u => u.id === S.me?.id);
  let pad = null;
  setTimeout(() => {
    const box = document.querySelector('.sheet .sig-sheet');
    if (!box) return;
    pad = signaturePad(box.querySelector('.sig-pad'));
    box.querySelector('[data-sig-clear]').addEventListener('click', () => pad.clear());
    const sync = () => {
      const m = box.querySelector('[name=method]:checked')?.value || 'desenho';
      box.querySelector('.sig-draw').hidden = m !== 'desenho';
      box.querySelector('.sig-saved').hidden = m !== 'salva';
    };
    box.querySelectorAll('[name=method]').forEach(r => r.addEventListener('change', sync));
    sync();
  }, 80);
  const r = await sheet({
    title: d.label ? `Assinar · ${d.label}` : 'Assinar documento', submitLabel: 'Assinar', wide: true,
    body: html`<div class="sig-sheet">
      ${signers.length ? html`<div class="segmented"><label><input type="radio" name="method" value="desenho" ${def ? '' : 'checked'}>Desenhar a assinatura<small>no tablet ou celular</small></label>
        <label><input type="radio" name="method" value="salva" ${def ? 'checked' : ''}>Assinatura salva<small>pessoa cadastrada, com a senha dela</small></label></div>` : html`<input type="hidden" name="method" value="desenho">`}
      <div class="sig-draw">
        <div class="form-row"><div class="field"><label class="req" for="sg-name">Nome de quem assina</label><input type="text" id="sg-name" name="signer_name" maxlength="160" value="${d.name || ''}"></div>
          <div class="field"><label for="sg-doc">CPF/CNPJ (opcional)</label><input type="text" id="sg-doc" name="signer_doc" maxlength="30" inputmode="numeric" value="${d.doc || ''}"></div></div>
        ${padHtml()}
      </div>
      ${signers.length ? html`<div class="sig-saved" hidden>
        <div class="form-row"><div class="field"><label for="sg-user">Pessoa cadastrada</label><select id="sg-user" name="signer_user_id">${signers.map(u => html`<option value="${u.id}" ${def?.id === u.id ? 'selected' : ''}>${u.name}${u.job_title ? ` · ${u.job_title}` : ''}</option>`)}</select></div>
          <div class="field"><label class="req" for="sg-pw">Senha da pessoa</label><input type="password" id="sg-pw" name="password" autocomplete="current-password"></div></div>
        <span class="hint">A assinatura salva (em Minha conta) é aplicada depois que a própria pessoa confirma a senha.</span>
      </div>` : ''}
      <p class="hint sig-legal">Assinatura eletrônica: ficam registrados quem assinou, quem coletou, a data e a hora e o aparelho. Se o documento mudar depois, ele mostra o aviso e pode ser assinado de novo.</p>
    </div>`,
    onSubmit: f => {
      if ((f.method || 'desenho') === 'salva') {
        if (!f.password) throw new Error('Digite a senha da pessoa para usar a assinatura salva.');
        return f;
      }
      if (!String(f.signer_name || '').trim()) throw new Error('Informe o nome de quem assina.');
      if (!pad || pad.isEmpty()) throw new Error('Assine dentro do quadro.');
      return { ...f, data: pad.toDataURL() };
    },
  });
  if (!r) return;
  const fp = S.fp[`${d.type}:${d.key}`];
  const body = (r.method || 'desenho') === 'salva'
    ? { type: d.type, key: d.key, slot: d.slot, slot_label: d.label, method: 'salva', signer_user_id: Number(r.signer_user_id), password: r.password, fp }
    : { type: d.type, key: d.key, slot: d.slot, slot_label: d.label, method: 'desenho', signer_name: r.signer_name, signer_doc: r.signer_doc, data: r.data, fp };
  try { await api('/signatures', { method: 'POST', body }); toast('Documento assinado.'); reload(); }
  catch (e) { toast(e.message, 'error'); }
}
async function removeSig(id, reload) {
  const r = await sheet({ title: 'Remover assinatura', submitLabel: 'Remover', danger: true,
    body: html`<div class="field"><label class="req" for="sg-rm">Motivo</label><textarea id="sg-rm" name="reason" rows="2" maxlength="500" required></textarea>
      <span class="hint">A assinatura sai do documento e fica registrada como removida, com o motivo, na auditoria.</span></div>`,
    onSubmit: f => { if (!String(f.reason || '').trim()) throw new Error('Informe o motivo.'); return f; } });
  if (!r) return;
  try { await api(`/signatures/${id}/remove`, { method: 'POST', body: { reason: r.reason } }); toast('Assinatura removida.'); reload(); }
  catch (e) { toast(e.message, 'error'); }
}
export function bindSignatures(root, S, reload) {
  root.addEventListener('click', e => {
    const b = e.target.closest('[data-sig-btn]');
    if (b) { e.preventDefault(); return openSign(S, b.dataset, reload); }
    const rm = e.target.closest('[data-sig-rm]');
    if (rm) { e.preventDefault(); removeSig(rm.dataset.sigRm, reload); }
  });
}

// ---------- Minha assinatura salva (Minha conta) ----------
export async function editMySignature() {
  let pad = null;
  setTimeout(() => {
    const box = document.querySelector('.sheet .sig-sheet');
    if (!box) return;
    pad = signaturePad(box.querySelector('.sig-pad'));
    box.querySelector('[data-sig-clear]').addEventListener('click', () => pad.clear());
  }, 80);
  const r = await sheet({ title: 'Minha assinatura', submitLabel: 'Salvar assinatura', wide: true,
    body: html`<div class="sig-sheet">${padHtml()}<p class="hint">Fica guardada só para você. Para usar num documento, você confirma a sua senha.</p></div>`,
    onSubmit: () => { if (!pad || pad.isEmpty()) throw new Error('Assine dentro do quadro.'); return { data: pad.toDataURL() }; } });
  if (!r) return false;
  await api('/me/signature', { method: 'PUT', body: r });
  return true;
}
