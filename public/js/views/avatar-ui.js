// Foto de perfil: editor (trocar/remover) com recorte quadrado feito no aparelho antes do envio.
import { html, api, icon, avatar, avatarUrl, setAvatars } from '../core.js';
import { toast, confirmSheet } from '../ui.js';
import { reloadMeta } from '../app.js';

// Recorta no centro, em quadrado, e reduz para 320 px (JPEG)
function squareImage(file, size = 320) {
  return new Promise((resolve, reject) => {
    if (!/^image\//i.test(file.type) && !/\.(jpe?g|png|webp|heic|heif)$/i.test(file.name)) return reject(new Error('Escolha uma imagem (JPG, PNG ou WEBP).'));
    const img = new Image();
    const url = URL.createObjectURL(file);
    img.onload = () => {
      const s = Math.min(img.width, img.height);
      const c = document.createElement('canvas');
      c.width = c.height = size;
      c.getContext('2d').drawImage(img, (img.width - s) / 2, (img.height - s) / 2, s, s, 0, 0, size, size);
      URL.revokeObjectURL(url);
      resolve(c.toDataURL('image/jpeg', 0.86));
    };
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('Não foi possível ler a imagem.')); };
    img.src = url;
  });
}

export function avatarEditor(u, { canEdit = true } = {}) {
  const has = !!avatarUrl(u.id);
  return html`<div class="av-edit" data-av-user="${u.id}">${avatar(u.name, 'xl', u.id)}
    ${canEdit ? html`<div class="av-acts"><label class="btn btn-ghost btn-sm">${icon('camera')}${has ? 'Trocar foto' : 'Adicionar foto'}<input type="file" accept="image/*" hidden data-av-file></label>
      ${has ? html`<button type="button" class="btn btn-ghost btn-sm" data-av-rm>${icon('x')}Remover</button>` : ''}
      <small class="muted">A foto aparece no lugar das iniciais (menu, organograma, listas).</small></div>` : ''}</div>`;
}

export function bindAvatarEditor(root, u, { self = false, after } = {}) {
  const box = root.querySelector(`[data-av-user="${u.id}"]`);
  if (!box) return;
  const done = async msg => {
    toast(msg);
    setAvatars((await reloadMeta()).avatars);
    if (self) location.reload(); else after?.();
  };
  box.querySelector('[data-av-file]')?.addEventListener('change', async e => {
    const f = e.target.files?.[0];
    if (!f) return;
    try {
      const data = await squareImage(f);
      await api(`/users/${u.id}/avatar`, { method: 'POST', body: { data } });
      await done('Foto atualizada.');
    } catch (ex) { toast(ex.message, 'err'); }
  });
  box.querySelector('[data-av-rm]')?.addEventListener('click', async () => {
    if (!(await confirmSheet('Remover foto', 'Voltam a aparecer as iniciais do nome.', 'Remover', true))) return;
    try { await api(`/users/${u.id}/avatar`, { method: 'DELETE' }); await done('Foto removida.'); } catch (ex) { toast(ex.message, 'err'); }
  });
}
