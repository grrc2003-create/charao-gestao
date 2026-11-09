// Meu painel: comprovantes dos pagamentos que a própria pessoa recebeu (Folha Administrativa e Folha de Campo).
import { myPayrollReceipts } from './payroll.js';
import { myFieldReceipts } from './field.js';

export function myReceipts(ctx) {
  const items = [...myPayrollReceipts(ctx), ...myFieldReceipts(ctx)];
  return { items: items.sort((a, b) => String(b.date || '').localeCompare(String(a.date || ''))) };
}
