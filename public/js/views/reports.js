// Configuração de relatórios: tipo → escopo → nível de detalhe → gerar documento A4.
import { html, api, icon } from '../core.js';
import { pageHead } from './shared.js';

const TYPES = [
  ['projeto', 'Projeto', 'Andamento consolidado de uma obra', 'projects'],
  ['usuario', 'Usuário', 'Desempenho e tarefas de um responsável', 'user'],
  ['equipe', 'Gestor / equipe', 'Consolidado da equipe sob um gestor', 'team'],
  ['geral', 'Geral', 'Panorama de todos os projetos acessíveis', 'dashboard'],
];
const LEVELS = [
  ['resumo', 'Resumo', 'Indicadores principais e panorama visual'],
  ['detalhado', 'Detalhado', 'Indicadores + tarefas, responsáveis, prazos e status'],
  ['completo', 'Completo com fotos', 'Tudo do detalhado + registros, imagens e comprovações'],
];

export async function view({ state, query }) {
  const users = await api('/users');
  const meta = state.meta;
  const managers = users.filter(u => u.team_size > 0);
  const init = { type: query.get('type') || 'projeto', id: query.get('id') || '', level: query.get('level') || 'detalhado' };
  const opt = (v, l) => html`<option value="${v}" ${String(init.id) === String(v) ? 'selected' : ''}>${l}</option>`;
  const scopes = {
    projeto: meta.projects.map(p => opt(p.id, `${p.code} · ${p.name}`)),
    usuario: users.filter(u => u.active).map(u => opt(u.id, `${u.name}${u.job_title ? ` · ${u.job_title}` : ''}`)),
    equipe: managers.map(u => opt(u.id, `${u.name} · ${u.team_size} integrante(s)`)),
  };

  return {
    title: 'Relatórios',
    html: html`
      ${pageHead({
        eyebrow: 'Documentos A4 para impressão e PDF',
        title: 'Relatórios',
        sub: 'Escolha o tipo, o escopo e o nível de detalhe. O documento abre pronto para imprimir ou salvar em PDF.',
      })}
      <div class="report-config">
        <form class="card card-pad form" id="rep-form" novalidate>
          <div class="field"><span class="label">1. Tipo de relatório</span>
            <div class="segmented seg-4">${TYPES.map(([k, l, d, ic]) => html`<label><input type="radio" name="type" value="${k}" ${init.type === k ? 'checked' : ''}>
              <span class="seg-ic">${icon(ic)}</span>${l}<small>${d}</small></label>`)}</div></div>

          <div class="field" id="scope-field"><label for="scope" id="scope-label">2. Escopo</label>
            <select id="scope" name="id"></select>
            <span class="hint" id="scope-hint"></span></div>

          <div class="field"><span class="label">3. Nível de detalhe</span>
            <div class="segmented seg-3">${LEVELS.map(([k, l, d]) => html`<label><input type="radio" name="level" value="${k}" ${init.level === k ? 'checked' : ''}>${l}<small>${d}</small></label>`)}</div></div>

          <fieldset class="fieldset form"><legend>Filtros opcionais</legend>
            <div class="form-row">
              <div class="field"><label for="from">Prazo a partir de</label><input id="from" name="from" type="date"></div>
              <div class="field"><label for="to">Prazo até</label><input id="to" name="to" type="date"></div>
            </div>
            <label class="switch"><input type="checkbox" name="include_done" checked>Incluir tarefas concluídas</label>
          </fieldset>
          <div class="form-error" hidden></div>
          <div class="form-actions"><button class="btn btn-primary" type="submit">${icon('reports')}Gerar relatório</button></div>
        </form>

        <aside class="card">
          <div class="card-head"><h2>Estrutura do documento</h2></div>
          <div class="card-body" style="display:grid;gap:14px">
            <div class="preview-sheet"><div class="mini-a4" id="mini">
              <div class="bar dark"></div><div class="bar or"></div><div class="bar" style="width:70%"></div>
              <div class="boxes"><span></span><span></span><span></span><span></span></div>
              <div class="bar"></div><div class="bar" style="width:85%"></div>
              <div class="bar det"></div><div class="bar det" style="width:90%"></div><div class="bar det" style="width:80%"></div>
              <div class="boxes ph-row"><span class="ph"></span><span class="ph"></span><span class="ph"></span><span class="ph"></span></div>
            </div></div>
            <ul class="behavior" style="font-size:13.5px">
              <li>Cabeçalho institucional, escopo e data de emissão</li>
              <li>Resumo executivo e indicadores principais</li>
              <li>Distribuição por status e por projeto/responsável</li>
              <li id="li-det">Detalhamento das tarefas</li>
              <li id="li-ph">Comprovações com fotos e histórico</li>
              <li>Rodapé com emissor e paginação</li>
            </ul>
            <div class="notice">${icon('info')}<span>Na janela de impressão, escolha <b>Salvar como PDF</b> e o tamanho <b>A4</b>.</span></div>
          </div>
        </aside>
      </div>`,
    mount(root, ctx) {
      const f = root.querySelector('#rep-form');
      const sel = f.querySelector('#scope');
      const labels = {
        projeto: ['2. Escopo — qual projeto?', 'Inclui todas as tarefas do projeto visíveis para você.'],
        usuario: ['2. Escopo — qual usuário?', 'Tarefas atribuídas ao usuário.'],
        equipe: ['2. Escopo — qual gestor?', 'Tarefas do gestor e de todos os integrantes da equipe.'],
      };
      const sync = () => {
        const type = f.querySelector('[name=type]:checked').value;
        const level = f.querySelector('[name=level]:checked').value;
        const field = root.querySelector('#scope-field');
        field.style.display = type === 'geral' ? 'none' : '';
        if (type !== 'geral') {
          const prev = sel.dataset.type;
          if (prev !== type) {
            const list = scopes[type];
            sel.innerHTML = list.length ? html`${list}`.toString() : '<option value="">Nenhuma opção disponível</option>';
            sel.dataset.type = type;
          }
          root.querySelector('#scope-label').textContent = labels[type][0];
          root.querySelector('#scope-hint').textContent = labels[type][1];
        }
        root.querySelectorAll('#mini .det').forEach(e => (e.style.display = level === 'resumo' ? 'none' : ''));
        root.querySelector('#mini .ph-row').style.display = level === 'completo' ? '' : 'none';
        root.querySelector('#li-det').style.opacity = level === 'resumo' ? '.35' : '1';
        root.querySelector('#li-ph').style.opacity = level === 'completo' ? '1' : '.35';
      };
      f.addEventListener('change', sync);
      sync();
      f.addEventListener('submit', e => {
        e.preventDefault();
        const fd = new FormData(f);
        const type = fd.get('type');
        const err = f.querySelector('.form-error');
        if (type !== 'geral' && !fd.get('id')) { err.textContent = 'Selecione o escopo do relatório.'; err.hidden = false; return; }
        const qs = new URLSearchParams({ type, level: fd.get('level') });
        if (type !== 'geral') qs.set('id', fd.get('id'));
        if (fd.get('from')) qs.set('from', fd.get('from'));
        if (fd.get('to')) qs.set('to', fd.get('to'));
        if (!fd.get('include_done')) qs.set('include_done', '0');
        ctx.navigate(`/imprimir/relatorio?${qs}`);
      });
    },
  };
}
