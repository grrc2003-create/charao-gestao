// Planejamento do projeto por planilha (.xlsx): modelo para preencher e importação com prévia.
// Uma linha por tarefa (ID da linha; "Tarefa principal" = ID da mãe para subtarefas), com classificação, responsável,
// datas, prioridade, comprovação e dependências (Predecessoras e/ou Sucessoras = IDs; basta preencher um dos lados:
// o outro é completado automaticamente; a folga da ligação é a da tarefa sucessora).
// Mesmas regras do cadastro: classificação precisa existir no projeto; responsável sem acesso ganha acesso ao projeto
// (quem importa precisa poder dar acesso); descrição em branco = título. Check-lists continuam sendo criados no sistema.
import { all, one, run, tx } from '../db.js';
import { badRequest, forbidden, notFound, str, intOrNull } from '../lib/http.js';
import { readXlsxSheets, serialToDate } from '../lib/xlsx.js';
import { writeXlsx } from '../lib/xlsx-write.js';
import { canCreateTaskIn, userHasProjectAccess, isAdmin, isManagerRole, restrictedProjectIds } from '../lib/permissions.js';
import { audit, taskHistory } from './audit.js';
import { today } from './metrics.js';
import { insertTask, PRIORITIES, PROOF_TYPES } from './tasks.js';
import { addDependency } from './dependencies.js';
import { defaultStageId } from './stages.js';

const HEAD = ['ID *', 'Tarefa principal (ID)', 'Título *', 'Descrição', 'Classificação', 'Responsável', 'Início previsto', 'Prazo', 'Prioridade', 'Comprovação', 'Predecessoras (IDs)', 'Sucessoras (IDs)', 'Folga (dias)', 'Observações'];
const KEYS = ['ref', 'parent', 'title', 'description', 'stage', 'assignee', 'start_date', 'due_date', 'priority', 'proof', 'deps', 'succs', 'lag', 'notes'];
// Nomes antigos de coluna ainda aceitos
const HEAD_ALIASES = { dependedeids: 'deps', dependede: 'deps', predecessoras: 'deps', sucessoras: 'succs' };
const PRIORITY_LABELS = { baixa: 'Baixa', media: 'Média', alta: 'Alta', urgente: 'Urgente' };
const PROOF_LABELS = { nenhuma: 'Nenhuma', foto: 'Foto', descricao: 'Descrição', foto_descricao: 'Foto e descrição' };
const MAX_ROWS = 2000;
const norm = s => String(s ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/\s+/g, ' ').trim();
const hkey = s => norm(s).replace(/[^a-z0-9]/g, '');
const txt = v => (v === null || v === undefined ? '' : typeof v === 'number' && Number.isInteger(v) ? String(v) : String(v).trim());

function loadProject(ctx, projectId) {
  const p = one('SELECT * FROM projects WHERE id = ?', projectId);
  if (!p) throw notFound('Projeto não encontrado.');
  if (!canCreateTaskIn(ctx, projectId)) throw forbidden('Você não pode criar tarefas neste projeto.');
  if (['concluido', 'cancelado'].includes(p.status)) throw badRequest('Projeto encerrado não recebe novas tarefas.');
  return p;
}
// Quem pode dar acesso ao projeto ao importar: administrador, gestor/coordenador ou o líder do projeto
const canGrant = (ctx, p) => isAdmin(ctx.user) || isManagerRole(ctx.user) || p.lead_id === ctx.user.id;

// ---------- Planilha modelo (com as classificações do projeto, quando houver) ----------
export function templateXlsx(ctx, projectId = null) {
  const p = projectId ? loadProject(ctx, projectId) : null;
  const stages = p ? all('SELECT name FROM project_stages WHERE project_id = ? ORDER BY is_default DESC, sort_order, id', p.id).map(s => s.name) : [];
  const people = all('SELECT name FROM users WHERE active = 1 ORDER BY name').map(u => u.name);
  const pri = Object.values(PRIORITY_LABELS), prf = Object.values(PROOF_LABELS);
  const n = Math.max(stages.length, people.length, pri.length, prf.length, 1);
  const lists = [['Classificações do projeto', 'Responsáveis', 'Prioridade', 'Comprovação']];
  for (let i = 0; i < n; i++) lists.push([stages[i] ?? null, people[i] ?? null, pri[i] ?? null, prf[i] ?? null]);
  const last = MAX_ROWS + 1;
  const ref = today().split('-').reverse().join('/');
  return writeXlsx([
    {
      name: 'Planejamento', header: true, freeze: true, rows: [HEAD],
      widths: [8, 12, 40, 44, 22, 24, 15, 15, 12, 18, 16, 16, 11, 34],
      validations: [
        ...(stages.length ? [{ col: 4, rows: [2, last], source: `Listas!$A$2:$A$${stages.length + 1}` }] : []),
        ...(people.length ? [{ col: 5, rows: [2, last], source: `Listas!$B$2:$B$${people.length + 1}` }] : []),
        { col: 8, rows: [2, last], source: `Listas!$C$2:$C$${pri.length + 1}` },
        { col: 9, rows: [2, last], source: `Listas!$D$2:$D$${prf.length + 1}` },
      ],
    },
    {
      name: 'Instruções', title: true, widths: [26, 96], styles: { 1: 2 },
      rows: [
        [`Planejamento do projeto${p ? ` ${p.code} · ${p.name}` : ''} — como preencher`],
        [],
        ['Uma linha por tarefa', 'Preencha a aba "Planejamento" a partir da linha 2 (não altere o cabeçalho). Campos com * são obrigatórios.'],
        ['ID *', 'Número da linha no planejamento (1, 2, 3…). Usado para ligar subtarefas e dependências. Não pode repetir.'],
        ['Tarefa principal (ID)', 'Para SUBTAREFA, informe o ID da tarefa principal. Em branco = tarefa principal. Subtarefa não pode ter subtarefas.'],
        ['Título *', 'Nome da tarefa (até 160 caracteres).'],
        ['Descrição', 'O que deve ser feito. Em branco = usa o título.'],
        ['Classificação', p ? `Grupo/Local/Etapa do projeto (lista). Precisa existir no projeto: ${stages.join(', ')}. Em branco = Geral.` : 'Grupo/Local/Etapa do projeto. Precisa existir no projeto (cadastre as classificações no projeto antes). Em branco = Geral.'],
        ['Responsável', 'Nome (ou e-mail) de quem executa. Se ainda não tiver acesso ao projeto, ganha acesso ao importar. Em branco = quem importar.'],
        ['Início previsto / Prazo', `Datas no formato DD/MM/AAAA (ex.: ${ref}). Início não pode ser depois do prazo. A tarefa principal acompanha o início e o prazo das subtarefas.`],
        ['Prioridade', `${pri.join(', ')}. Em branco = Média.`],
        ['Comprovação', `${prf.join(', ')}. Em branco = Nenhuma.`],
        ['Predecessoras (IDs)', 'IDs das tarefas que precisam terminar ANTES desta, separados por ponto e vírgula (ex.: 2;3).'],
        ['Sucessoras (IDs)', 'IDs das tarefas que só começam DEPOIS desta (ex.: 5;6).'],
        ['Predecessora x sucessora', 'Basta preencher um dos lados: se a linha 3 tem a 1 como predecessora, a linha 1 já fica com a 3 como sucessora (e vice-versa). Preencher os dois lados não duplica. As datas da sucessora são ajustadas pela dependência.'],
        ['Folga (dias)', 'Dias entre o fim da predecessora e o início desta tarefa (0 a 365). Vale para todas as ligações em que esta tarefa é a sucessora.'],
        ['Observações', 'Texto livre (opcional).'],
        [],
        ['Exemplo', '1 | (em branco) | Fundação | Executar fundação conforme projeto | Bloco A | Fulano | 03/11/2026 | 28/11/2026 | Alta | Foto | | 3 | | (sucessora: 3)'],
        ['', '2 | 1 | Escavação | | Bloco A | Fulano | 03/11/2026 | 10/11/2026 | | Foto | | | | (subtarefa da linha 1)'],
        ['', '3 | (em branco) | Estrutura | Pilares e vigas | Bloco A | Beltrano | | 20/12/2026 | Alta | Foto | (em branco: vem da linha 1) | | 2 | (começa 2 dias depois da Fundação)'],
        ['Importar', 'No projeto › Importar planejamento (ou no cadastro de um projeto novo): envie o arquivo, confira a prévia (erros por linha) e confirme.'],
      ],
    },
    { name: 'Listas', header: true, widths: [32, 30, 12, 18], rows: lists },
  ]);
}

// ---------- Leitura e validação ----------
function dateOf(v) {
  if (v === null || v === undefined || v === '') return null;
  if (typeof v === 'number') return v > 20000 && v < 80000 ? serialToDate(v) : undefined;
  const s = String(v).trim();
  let m = /^(\d{1,2})[/.-](\d{1,2})[/.-](\d{4})$/.exec(s);
  if (m) { const d = `${m[3]}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}`; return isNaN(Date.parse(d)) ? undefined : d; }
  m = /^(\d{4})-(\d{2})-(\d{2})/.exec(s);
  return m && !isNaN(Date.parse(`${m[1]}-${m[2]}-${m[3]}`)) ? `${m[1]}-${m[2]}-${m[3]}` : undefined;
}
const PRI_BY = Object.fromEntries(Object.entries(PRIORITY_LABELS).flatMap(([k, l]) => [[hkey(l), k], [hkey(k), k]]));
const PROOF_BY = Object.fromEntries([...Object.entries(PROOF_LABELS).flatMap(([k, l]) => [[hkey(l), k], [hkey(k), k]]), ['fotodescricao', 'foto_descricao'], ['fotoedescricao', 'foto_descricao']]);

function parse(ctx, project, file) {
  if (!file?.data) throw badRequest('Envie a planilha (.xlsx).');
  const name = str(file.name, { max: 200, label: 'Nome do arquivo' }) || 'planilha.xlsx';
  let grid;
  let sheets;
  try { sheets = readXlsxSheets(Buffer.from(String(file.data).replace(/^data:[^,]*,/, ''), 'base64')); }
  catch (e) { throw badRequest(`${name}: não foi possível ler a planilha (${e.message}).`); }
  const isHead = r => r.some(v => hkey(v).startsWith('titulo')) && r.some(v => hkey(v) === 'id');
  let hi = -1;
  for (const s of sheets) { hi = s.rows.findIndex(isHead); if (hi >= 0) { grid = s.rows; break; } }
  const other = sheets.some(s => s.rows.some(r => r.some(v => hkey(v).startsWith('descricao')) && r.some(v => hkey(v).startsWith('periodicidade'))));
  if (hi < 0 && other) throw badRequest('Esta é a planilha de tarefas financeiras (Descrição, Periodicidade…), que se importa no Financeiro. Para o planejamento do projeto, use "Baixar planilha modelo" nesta tela.');
  if (hi < 0) throw badRequest(`Não encontrei o cabeçalho da planilha modelo (colunas "ID" e "Título") em nenhuma aba (${sheets.map(s => s.name).join(', ')}). Use a planilha baixada em "Baixar planilha modelo", sem apagar a linha 1, e salve como .xlsx.`);
  const col = {};
  grid[hi].forEach((v, i) => {
    const k = HEAD.findIndex(h => hkey(h) === hkey(v));
    const key = k >= 0 ? KEYS[k] : HEAD_ALIASES[hkey(v)];
    if (key && col[key] === undefined) col[key] = i;
  });
  for (const k of ['ref', 'title']) if (col[k] === undefined) throw badRequest(`Falta a coluna "${HEAD[KEYS.indexOf(k)]}".`);
  const stages = new Map(all('SELECT id, name FROM project_stages WHERE project_id = ?', project.id).map(s => [hkey(s.name), s]));
  const users = all('SELECT id, name, email FROM users WHERE active = 1');
  const grant = canGrant(ctx, project);
  const restricted = restrictedProjectIds().has(project.id);
  const rows = [];
  for (let i = hi + 1; i < grid.length && rows.length < MAX_ROWS; i++) {
    const g = grid[i], v = k => (col[k] === undefined ? null : g[col[k]] ?? null);
    if (!KEYS.some(k => txt(v(k)))) continue;
    const errors = [], notes = [];
    const ref = txt(v('ref')), parentRef = txt(v('parent')), title = txt(v('title'));
    if (!ref) errors.push('ID em branco');
    if (!title) errors.push('Título em branco'); else if (title.length > 160) errors.push('Título com mais de 160 caracteres');
    const description = txt(v('description')) || title;
    if (description.length > 5000) errors.push('Descrição muito longa');
    let stage = null;
    const st = txt(v('stage'));
    if (st) { stage = stages.get(hkey(st)); if (!stage) errors.push(`Classificação "${st}" não existe no projeto`); }
    let assignee = null, grantAccess = false;
    const who = txt(v('assignee'));
    if (who) {
      assignee = users.find(u => hkey(u.name) === hkey(who) || norm(u.email) === norm(who));
      if (!assignee) errors.push(`Responsável "${who}" não encontrado`);
      else if (!userHasProjectAccess(assignee.id, project.id)) {
        if (grant && !restricted) { grantAccess = true; notes.push(`${assignee.name} ganha acesso ao projeto`); }
        else errors.push(`${assignee.name} não tem acesso ao projeto${restricted ? ' (área restrita)' : ''}`);
      }
    }
    const start = dateOf(v('start_date')), due = dateOf(v('due_date'));
    if (start === undefined) errors.push('Início previsto inválido (use DD/MM/AAAA)');
    if (due === undefined) errors.push('Prazo inválido (use DD/MM/AAAA)');
    if (start && due && start > due) errors.push('Início depois do prazo');
    const priTxt = txt(v('priority')), prfTxt = txt(v('proof'));
    const priority = priTxt ? PRI_BY[hkey(priTxt)] : 'media';
    const proof = prfTxt ? PROOF_BY[hkey(prfTxt)] : 'nenhuma';
    if (!priority) errors.push(`Prioridade "${priTxt}" não existe`);
    if (!proof) errors.push(`Comprovação "${prfTxt}" não existe`);
    const ids = k => [...new Set(txt(v(k)).split(/[;,\s]+/).map(s => s.trim()).filter(Boolean))];
    const deps = ids('deps'), succs = ids('succs');
    const lagTxt = txt(v('lag'));
    const lag = lagTxt ? Number(lagTxt.replace(',', '.')) : 0;
    if (!Number.isInteger(lag) || lag < 0 || lag > 365) errors.push('Folga: de 0 a 365 dias');
    const notesTxt = txt(v('notes'));
    if (notesTxt.length > 2000) errors.push('Observações muito longas');
    rows.push({
      line: i + 1, ref, parentRef, errors, notes, deps, succs, typedDeps: deps, lag: Number.isInteger(lag) ? lag : 0, grantAccess,
      data: { title, description, notes: notesTxt || null, start_date: start || null, due_date: due || null, priority: priority || 'media', proof_type: proof || 'nenhuma',
        assignee_id: assignee?.id || ctx.user.id, stage_id: stage?.id || null },
      view: { title, description: txt(v('description')) ? description : null, stage: stage?.name || (st || 'Geral'), assignee: assignee?.name || (who || null), start_date: start || null, due_date: due || null,
        priority: PRIORITY_LABELS[priority] || priTxt, proof: PROOF_LABELS[proof] || prfTxt, lag },
    });
  }
  if (!rows.length) throw badRequest('A planilha não tem linhas preenchidas na aba "Planejamento".');
  // Ligações entre linhas: IDs únicos, mãe existente (e sem mãe), dependências existentes e sem ciclo
  const byRef = new Map();
  for (const r of rows) {
    if (!r.ref) continue;
    if (byRef.has(r.ref)) r.errors.push(`ID ${r.ref} repetido (linha ${byRef.get(r.ref).line})`);
    else byRef.set(r.ref, r);
  }
  for (const r of rows) {
    if (r.parentRef) {
      const p = byRef.get(r.parentRef);
      if (!p) r.errors.push(`Tarefa principal ${r.parentRef} não está na planilha`);
      else if (p === r) r.errors.push('A tarefa não pode ser a própria tarefa principal');
      else if (p.parentRef) r.errors.push(`A linha ${r.parentRef} já é subtarefa (subtarefa não tem subtarefas)`);
    }
    for (const [list, label] of [[r.typedDeps, 'Predecessora'], [r.succs, 'Sucessora']]) for (const d of list) {
      const p = byRef.get(d);
      if (!p) r.errors.push(`${label} ${d} não está na planilha`);
      else if (p === r) r.errors.push('A tarefa não pode depender dela mesma');
      else if (p.ref === r.parentRef || p.parentRef === r.ref) r.errors.push(`Subtarefa e sua tarefa principal não se ligam por dependência (${d})`);
    }
  }
  // Predecessora x sucessora: basta um lado; junta os dois (sem repetir) e marca o que foi completado automaticamente
  for (const r of rows) {
    if (!r.ref || byRef.get(r.ref) !== r) continue;
    const fromSucc = rows.filter(x => x !== r && x.ref && byRef.get(x.ref) === x && x.succs.includes(r.ref)).map(x => x.ref);
    r.deps = [...new Set([...r.typedDeps.filter(d => byRef.has(d) && byRef.get(d) !== r), ...fromSucc])];
    r.autoDeps = fromSucc.filter(d => !r.typedDeps.includes(d));
  }
  for (const r of rows) {
    if (!r.ref || byRef.get(r.ref) !== r) { r.allSuccs = []; r.autoSuccs = []; continue; }
    r.allSuccs = rows.filter(x => x.ref && byRef.get(x.ref) === x && (x.deps || []).includes(r.ref)).map(x => x.ref);
    r.autoSuccs = r.allSuccs.filter(s => !r.succs.includes(s));
  }
  // Ciclo nas dependências: a linha alcança a si mesma seguindo as predecessoras (todas as do ciclo são marcadas)
  const reaches = (start) => {
    const seen = new Set(), stack = start.deps.map(d => byRef.get(d)).filter(Boolean);
    while (stack.length) {
      const x = stack.pop();
      if (x === start) return true;
      if (seen.has(x)) continue;
      seen.add(x);
      stack.push(...x.deps.map(d => byRef.get(d)).filter(Boolean));
    }
    return false;
  };
  for (const r of rows) if (r.ref && r.deps.length && byRef.get(r.ref) === r && reaches(r)) r.errors.push('Dependência circular');
  // Linha que depende de (ou é subtarefa de) uma linha com erro também não entra
  let changed = true;
  while (changed) {
    changed = false;
    for (const r of rows) {
      if (r.errors.length) continue;
      const bad = [r.parentRef, ...r.deps].filter(Boolean).map(x => byRef.get(x)).filter(x => x && x.errors.length);
      if (bad.length) { r.errors.push(`Depende da linha ${bad[0].line}, que tem erro`); changed = true; }
    }
  }
  for (const r of rows) r.status = r.errors.length ? 'erro' : 'ok';
  return { name, rows, byRef };
}

export function previewImport(ctx, projectId, body) {
  const project = loadProject(ctx, projectId);
  const { name, rows } = parse(ctx, project, body.file);
  const ok = rows.filter(r => r.status === 'ok');
  return {
    file: name, project: { id: project.id, code: project.code, name: project.name },
    rows: rows.map(r => ({ line: r.line, ref: r.ref, parent: r.parentRef || null, status: r.status, errors: r.errors, notes: r.notes,
      view: { ...r.view, preds: (r.deps || []).map(d => ({ ref: d, auto: (r.autoDeps || []).includes(d) })), succs: (r.allSuccs || []).map(s => ({ ref: s, auto: (r.autoSuccs || []).includes(s) })) } })),
    totals: { rows: rows.length, ok: ok.length, erro: rows.length - ok.length, subtasks: ok.filter(r => r.parentRef).length, deps: ok.reduce((s, r) => s + (r.deps || []).length, 0), auto: ok.reduce((s, r) => s + (r.autoDeps || []).length + (r.autoSuccs || []).length, 0), access: [...new Set(ok.filter(r => r.grantAccess).map(r => r.data.assignee_id))].length },
  };
}

// Só importa se não houver erro (planejamento é um conjunto: subtarefas e dependências dependem umas das outras)
export function applyImport(ctx, projectId, body, ip) {
  const project = loadProject(ctx, projectId);
  const { name, rows, byRef } = parse(ctx, project, body.file);
  const bad = rows.filter(r => r.status === 'erro');
  if (bad.length) throw badRequest(`${bad.length} linha(s) com erro. Corrija a planilha e envie de novo.`);
  return tx(() => {
    // Acesso ao projeto para os responsáveis que ainda não tinham
    const granted = [];
    for (const uid of new Set(rows.filter(r => r.grantAccess).map(r => r.data.assignee_id))) {
      run('INSERT OR IGNORE INTO user_project_access (user_id, project_id) VALUES (?,?)', uid, project.id);
      run('INSERT OR IGNORE INTO project_members (project_id, user_id) VALUES (?,?)', project.id, uid);
      granted.push(one('SELECT name FROM users WHERE id = ?', uid).name);
    }
    const idOf = new Map();
    const create = r => {
      const parent = r.parentRef ? one('SELECT * FROM tasks WHERE id = ?', idOf.get(r.parentRef)) : null;
      const data = { task_type: 'tarefa', photo_rule: null, field_summary: null, ...r.data };
      const id = insertTask({ project: one('SELECT * FROM projects WHERE id = ?', project.id), parent, data, stageInput: r.data.stage_id || defaultStageId(project.id), creatorId: ctx.user.id, ctx });
      taskHistory(id, ctx.user.id, 'Importada do planejamento (planilha)', `${name} · linha ${r.line}`);
      idOf.set(r.ref, id);
    };
    for (const r of rows.filter(x => !x.parentRef)) create(r);
    for (const r of rows.filter(x => x.parentRef)) create(r);
    let deps = 0;
    for (const r of rows) for (const d of r.deps) { addDependency(ctx, { pred: `t:${idOf.get(d)}`, succ: `t:${idOf.get(r.ref)}`, lag_days: r.lag }); deps++; }
    audit(ctx.user.id, 'project', project.id, 'Planejamento importado de planilha', { arquivo: name, tarefas: rows.filter(r => !r.parentRef).length, subtarefas: rows.filter(r => r.parentRef).length, dependencias: deps, acesso_liberado: granted }, ip);
    return { imported: rows.length, tasks: rows.filter(r => !r.parentRef).length, subtasks: rows.filter(r => r.parentRef).length, deps, granted };
  });
}

export const projectIdParam = v => { const id = intOrNull(v); if (!id) throw badRequest('Projeto inválido.'); return id; };
