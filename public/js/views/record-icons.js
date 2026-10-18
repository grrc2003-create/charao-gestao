// Ícones dos tipos de registro do projeto (Gantt, listas, relatórios e Configurações).
// O prazo das tarefas continua sendo o losango; os registros usam um círculo na cor do tipo com o ícone.
import { raw } from '../core.js';

export const REC_ICONS = {
  nota: ['Nota', '<path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z"/><path d="M14 3v5h5M9 13h6M9 17h6"/>'],
  check: ['Definição', '<circle cx="12" cy="12" r="9"/><path d="m8 12 3 3 5-6"/>'],
  reuniao: ['Reunião', '<circle cx="9" cy="8" r="3"/><path d="M3 20c0-3.3 2.7-6 6-6s6 2.7 6 6"/><circle cx="17" cy="9" r="2.5"/><path d="M16 14.2c2.8.4 5 2.8 5 5.8"/>'],
  balao: ['Solicitação', '<path d="M21 12a8 8 0 0 1-11.6 7.1L4 20l1.1-4.4A8 8 0 1 1 21 12z"/>'],
  troca: ['Alteração', '<path d="M7 7h12l-3-3M17 17H5l3 3"/>'],
  alerta: ['Ocorrência', '<path d="M12 3 2 20h20z"/><path d="M12 10v4M12 17.5v.5"/>'],
  olho: ['Visita', '<path d="M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7S2 12 2 12z"/><circle cx="12" cy="12" r="3"/>'],
  megafone: ['Comunicado', '<path d="M3 10v4h4l9 5V5L7 10z"/><path d="M19 9a4 4 0 0 1 0 6"/>'],
  pergunta: ['Dúvida', '<circle cx="12" cy="12" r="9"/><path d="M9.5 9.5a2.5 2.5 0 1 1 3.5 2.3c-.6.3-1 .9-1 1.6v.6M12 17v.5"/>'],
  lampada: ['Ideia / lição', '<path d="M9 18h6M10 21h4M12 3a6 6 0 0 0-3.5 10.9c.6.5 1 1.2 1 2.1h5c0-.9.4-1.6 1-2.1A6 6 0 0 0 12 3z"/>'],
  bandeira: ['Marco', '<path d="M5 21V4M5 4h11l-2 4 2 4H5"/>'],
  estrela: ['Destaque', '<path d="m12 3 2.8 5.7 6.2.9-4.5 4.4 1.1 6.2L12 17.3l-5.6 2.9 1.1-6.2L3 9.6l6.2-.9z"/>'],
  camera: ['Foto', '<path d="M4 7h3l2-3h6l2 3h3v12H4z"/><circle cx="12" cy="13" r="3.5"/>'],
  ferramenta: ['Serviço', '<path d="M14.5 6.5a4 4 0 0 0-5.3 5.3L3 18v3h3l6.2-6.2a4 4 0 0 0 5.3-5.3l-2.6 2.6-2.4-.6-.6-2.4z"/>'],
  clipe: ['Documento anexo', '<path d="m20 11-8.5 8.5a5 5 0 0 1-7-7L13 4a3.5 3.5 0 0 1 5 5l-8.5 8.5a2 2 0 0 1-3-3L14 7"/>'],
  calendario: ['Data / evento', '<rect x="3" y="5" width="18" height="16" rx="2"/><path d="M3 10h18M8 3v4M16 3v4"/>'],
};

export const recIconSvg = key => raw(`<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${(REC_ICONS[key] || REC_ICONS.nota)[1]}</svg>`);
// Selo circular na cor do tipo com o ícone branco
export const recBadge = (key, color, cls = '') => raw(`<span class="rg-ic ${cls}" style="--c:${color}">${recIconSvg(key)}</span>`);
