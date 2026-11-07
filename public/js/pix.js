// PIX "Copia e Cola" com valor (BR Code estático, padrão EMV do Banco Central).
// Monta o código a partir da chave do cadastro, do nome de quem recebe e do valor; a pessoa que paga cola o código
// em Pix › Pix Copia e Cola no app do banco e confere nome e valor antes de confirmar. Nada é enviado para fora.
import { html, icon } from './core.js';
import { sheet, toast } from './ui.js';

export const PIX_TYPES = ['CPF', 'CNPJ', 'Telefone', 'E-mail', 'Aleatória'];
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const digits = v => String(v || '').replace(/\D/g, '');

// Tira anotações do fim, como "(CPF)" ou "(celular)"
const bare = v => String(v || '').replace(/\s*\([^)]*\)\s*$/, '').trim() || String(v || '').trim();

// CPF válido (dígitos verificadores)
function cpfOk(d) {
  if (!/^\d{11}$/.test(d) || /^(\d)\1{10}$/.test(d)) return false;
  const dv = n => { let s = 0; for (let i = 0; i < n; i++) s += Number(d[i]) * (n + 1 - i); const r = (s * 10) % 11; return r === 10 ? 0 : r; };
  return dv(9) === Number(d[9]) && dv(10) === Number(d[10]);
}

// Tipo provável da chave (o cadastro pode dizer; senão, pela anotação e pelo formato)
export function guessType(raw, saved) {
  if (PIX_TYPES.includes(saved)) return saved;
  const s = String(raw || '').trim();
  const note = (/\(([^)]*)\)\s*$/.exec(s)?.[1] || '').toLowerCase();
  if (/cpf/.test(note)) return 'CPF';
  if (/cnpj/.test(note)) return 'CNPJ';
  if (/cel|fone|tel|whats/.test(note)) return 'Telefone';
  if (/mail/.test(note)) return 'E-mail';
  if (/aleat|evp/.test(note)) return 'Aleatória';
  const k = bare(s);
  if (k.includes('@')) return 'E-mail';
  if (UUID.test(k)) return 'Aleatória';
  if (/^\d{3}\.\d{3}\.\d{3}-\d{2}$/.test(k)) return 'CPF';
  if (/^\d{2}\.\d{3}\.\d{3}\/\d{4}-\d{2}$/.test(k)) return 'CNPJ';
  if (/^\+/.test(k) || /^\(\d{2}\)/.test(k)) return 'Telefone';
  const d = digits(k);
  if (d.length === 14) return 'CNPJ';
  if (d.length === 11) return cpfOk(d) ? 'CPF' : 'Telefone';
  if (d.length === 10 || d.length === 12 || d.length === 13) return 'Telefone';
  return '';
}

// Chave no formato exigido pelo PIX; erro quando não fecha com o tipo
export function normalizeKey(raw, type) {
  const k = bare(raw);
  const d = digits(k);
  switch (type) {
    case 'CPF': return d.length === 11 ? { key: d } : { error: 'CPF precisa ter 11 dígitos.' };
    case 'CNPJ': return d.length === 14 ? { key: d } : { error: 'CNPJ precisa ter 14 dígitos.' };
    case 'Telefone': {
      const n = (d.length === 12 || d.length === 13) && d.startsWith('55') ? d.slice(2) : d;
      return n.length === 10 || n.length === 11 ? { key: `+55${n}` } : { error: 'Telefone precisa ter DDD e número (10 ou 11 dígitos).' };
    }
    case 'E-mail': return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(k) ? { key: k.toLowerCase() } : { error: 'E-mail inválido.' };
    case 'Aleatória': return UUID.test(k) ? { key: k.toLowerCase() } : { error: 'Chave aleatória inválida (formato 8-4-4-4-12).' };
    default: return { error: 'Escolha o tipo da chave PIX.' };
  }
}

// Texto só com letras, números e espaço (sem acento), como o padrão pede
const ascii = (v, max) => String(v || '').normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^A-Za-z0-9 .\-/]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max).trim();
const tlv = (id, v) => `${id}${String(v.length).padStart(2, '0')}${v}`;

// CRC16-CCITT (polinômio 0x1021, início 0xFFFF)
export function crc16(s) {
  let c = 0xffff;
  for (let i = 0; i < s.length; i++) {
    c ^= s.charCodeAt(i) << 8;
    for (let j = 0; j < 8; j++) c = c & 0x8000 ? ((c << 1) ^ 0x1021) & 0xffff : (c << 1) & 0xffff;
  }
  return c.toString(16).toUpperCase().padStart(4, '0');
}

// BR Code estático com valor
export function brCode({ key, name, city = 'BRASIL', amount, description = '', txid = '***' }) {
  let desc = ascii(description, 60);
  const acc = () => tlv('00', 'br.gov.bcb.pix') + tlv('01', key) + (desc ? tlv('02', desc) : '');
  while (desc && acc().length > 99) desc = desc.slice(0, -1).trim();
  const body = tlv('00', '01') + tlv('26', acc()) + tlv('52', '0000') + tlv('53', '986')
    + (amount > 0 ? tlv('54', (Math.round(amount * 100) / 100).toFixed(2)) : '')
    + tlv('58', 'BR') + tlv('59', ascii(name, 25) || 'RECEBEDOR') + tlv('60', ascii(city, 15) || 'BRASIL')
    + tlv('62', tlv('05', ascii(txid, 25).replace(/ /g, '') || '***')) + '6304';
  return body + crc16(body);
}

async function copyText(text) {
  try { await navigator.clipboard.writeText(text); return true; }
  catch {
    const ta = document.createElement('textarea'); ta.value = text; ta.style.position = 'fixed'; ta.style.opacity = '0';
    document.body.appendChild(ta); ta.select(); const ok = document.execCommand('copy'); ta.remove(); return ok;
  }
}

const fmt = v => new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' }).format(Number(v) || 0);

// Botão "PIX com valor" (data-pixcode): abre a janela que gera o código
export const pixButton = ({ name, pix, pix_type, amount, description }) => (pix && amount > 0.004
  ? html`<button type="button" class="btn btn-ghost btn-sm" data-pixcode data-name="${name}" data-pix="${pix}" data-type="${pix_type || ''}" data-amt="${Math.round(amount * 100) / 100}" data-desc="${description || ''}" title="Gera o código PIX Copia e Cola já com o valor">${icon('wallet')}PIX com valor</button>` : '');

export function bindPixButtons(root, signal) {
  root.addEventListener('click', e => {
    const b = e.target.closest('[data-pixcode]');
    if (!b) return;
    pixDialog({ name: b.dataset.name, pix: b.dataset.pix, pix_type: b.dataset.type, amount: Number(b.dataset.amt) || 0, description: b.dataset.desc });
  }, signal ? { signal } : undefined);
}

// Janela: tipo da chave, valor e o código pronto para copiar
export async function pixDialog({ name, pix, pix_type, amount, description }) {
  const type0 = guessType(pix, pix_type);
  const p = sheet({
    title: 'PIX Copia e Cola com valor',
    body: html`<p class="muted" style="margin-top:0">Para <b>${name}</b> · chave <code>${pix}</code></p>
      <div class="form-row">
        <div class="field"><label class="req" for="px-t">Tipo da chave</label><select id="px-t" name="type">${type0 ? '' : html`<option value="">Escolha…</option>`}${PIX_TYPES.map(t => html`<option ${t === type0 ? 'selected' : ''}>${t}</option>`)}</select></div>
        <div class="field"><label class="req" for="px-v">Valor (R$)</label><input type="number" id="px-v" name="amount" step="0.01" min="0.01" value="${(Math.round(amount * 100) / 100).toFixed(2)}"></div>
      </div>
      <div class="field"><label for="px-c">Código PIX (Copia e Cola)</label><textarea id="px-c" rows="4" readonly class="px-code"></textarea>
        <span class="hint" id="px-h"></span></div>
      <p class="hint" style="margin:0">No app do banco: <b>Pix › Pix Copia e Cola</b>, cole o código e confira o nome e o valor antes de confirmar.</p>`,
    submitLabel: 'Copiar código',
    async onSubmit() {
      const code = document.getElementById('px-c').value;
      if (!code) throw new Error(document.getElementById('px-h').textContent || 'Confira o tipo da chave e o valor.');
      await copyText(code);
      return code;
    },
  });
  const t = document.getElementById('px-t'), v = document.getElementById('px-v'), c = document.getElementById('px-c'), h = document.getElementById('px-h');
  const upd = () => {
    const n = normalizeKey(pix, t.value);
    const val = Number(String(v.value).replace(',', '.'));
    if (n.error) { c.value = ''; h.textContent = n.error; h.classList.add('px-err'); return; }
    if (!(val > 0)) { c.value = ''; h.textContent = 'Informe o valor.'; h.classList.add('px-err'); return; }
    c.value = brCode({ key: n.key, name, amount: val, description });
    h.classList.remove('px-err');
    h.textContent = `Chave ${t.value}: ${n.key} · ${fmt(val)}`;
  };
  t.addEventListener('change', upd); v.addEventListener('input', upd); upd();
  c.addEventListener('focus', () => c.select());
  if (await p) toast(`Código PIX de ${name} copiado (${fmt(Number(v.value))}).`);
}
