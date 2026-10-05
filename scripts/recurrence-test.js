// Testes do motor de datas das tarefas recorrentes (sem banco). Uso: node scripts/recurrence-test.js
import { occurrenceDates, describeRule } from '../server/services/recurrence-rules.js';

let passed = 0, failed = 0;
const ok = (cond, name, extra = '') => { if (cond) { passed++; console.log(`  ✓ ${name}`); } else { failed++; console.log(`  ✗ ${name} ${extra}`); } };
const dates = (rule, opts) => [...occurrenceDates(rule, opts)];

console.log('Motor de recorrência');
// 2026-10-05 é segunda-feira
let d = dates({ freq: 'diaria', interval: 1, start_date: '2026-10-05', end_type: 'ocorrencias', end_count: 5 });
ok(d.join() === '2026-10-05,2026-10-06,2026-10-07,2026-10-08,2026-10-09', 'diária, 5 ocorrências', d.join());
d = dates({ freq: 'diaria', interval: 1, workdays_only: true, start_date: '2026-10-09', end_type: 'ocorrencias', end_count: 3 });
ok(d.join() === '2026-10-09,2026-10-12,2026-10-13', 'diária somente dias úteis pula sábado e domingo', d.join());
d = dates({ freq: 'diaria', interval: 3, start_date: '2026-10-05', end_type: 'data', end_date: '2026-10-15' });
ok(d.join() === '2026-10-05,2026-10-08,2026-10-11,2026-10-14', 'a cada 3 dias até a data final', d.join());
d = dates({ freq: 'semanal', interval: 1, weekdays: [1, 3], start_date: '2026-10-05', end_type: 'data', end_date: '2026-10-19' });
ok(d.join() === '2026-10-05,2026-10-07,2026-10-12,2026-10-14,2026-10-19', 'semanal segunda e quarta', d.join());
d = dates({ freq: 'semanal', interval: 2, weekdays: [5], start_date: '2026-10-07', end_type: 'ocorrencias', end_count: 3 });
ok(d.join() === '2026-10-09,2026-10-23,2026-11-06', 'quinzenal (a cada 2 semanas) na sexta', d.join());
d = dates({ freq: 'semanal', interval: 1, start_date: '2026-10-08', end_type: 'ocorrencias', end_count: 2 });
ok(d.join() === '2026-10-08,2026-10-15', 'semanal sem dias escolhidos usa o dia da data inicial', d.join());
d = dates({ freq: 'mensal', interval: 1, month_day: 31, start_date: '2026-10-31', end_type: 'ocorrencias', end_count: 5 });
ok(d.join() === '2026-10-31,2026-11-30,2026-12-31,2027-01-31,2027-02-28', 'mensal dia 31 usa o último dia do mês', d.join());
d = dates({ freq: 'mensal', interval: 3, month_day: 10, start_date: '2026-10-20', end_type: 'ocorrencias', end_count: 3 });
ok(d.join() === '2027-01-10,2027-04-10,2027-07-10', 'trimestral: primeira ocorrência não antecede a data inicial', d.join());
d = dates({ freq: 'mensal', interval: 1, month_day: 29, start_date: '2027-01-29', end_type: 'ocorrencias', end_count: 3 });
ok(d.join() === '2027-01-29,2027-02-28,2027-03-29', 'fevereiro sem dia 29 usa o dia 28', d.join());
d = dates({ freq: 'diaria', interval: 1, start_date: '2026-10-05', end_type: 'nunca' }, { until: '2026-10-08' });
ok(d.length === 4, 'sem término respeita o horizonte de criação', d.join());
d = dates({ freq: 'semanal', interval: 1, weekdays: [1], start_date: '2026-10-05', end_type: 'data', end_date: '2026-12-31' }, { until: '2026-10-20' });
ok(d.join() === '2026-10-05,2026-10-12,2026-10-19', 'horizonte menor que a data final', d.join());
ok(describeRule({ freq: 'semanal', interval: 1, weekdays: [3, 1], start_date: '2026-10-05', end_type: 'data', end_date: '2026-12-31' })
  === 'Toda semana: segunda e quarta · a partir de 05/10/2026 · até 31/12/2026', 'descrição legível da regra');

console.log(`\n${passed} passaram, ${failed} falharam`);
process.exitCode = failed ? 1 : 0;
