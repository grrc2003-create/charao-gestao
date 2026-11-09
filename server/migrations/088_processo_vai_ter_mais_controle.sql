-- Tutorial SIS-13: "Vai ter" só deixa a despesa aberta; a baixa vem da conferência com o Mais Controle (sem comprovante).
-- Publicado com o texto antigo e sem rascunho → nova versão (a anterior fica no histórico). Editado pela empresa → não é alterado.
INSERT INTO process_versions (process_id, version, content, note, published_at)
  SELECT id, version + 1,
    replace(published, '**Pagar** (com valor e comprovante), **Vai ter** (confirma que a despesa ocorrerá) ou pular com motivo opcional', '**Vai ter**: a despesa fica aberta até a conferência com o Mais Controle, sem enviar comprovante; **Não vai ter**: motivo opcional'),
    'Atualização: Vai ter aguarda a conferência com o Mais Controle', datetime('now')
  FROM processes WHERE code = 'SIS-13' AND draft IS NULL AND instr(published, '**Pagar** (com valor e comprovante), **Vai ter**') > 0;
UPDATE processes SET version = version + 1, published_at = datetime('now'), updated_at = datetime('now'),
    published = replace(published, '**Pagar** (com valor e comprovante), **Vai ter** (confirma que a despesa ocorrerá) ou pular com motivo opcional', '**Vai ter**: a despesa fica aberta até a conferência com o Mais Controle, sem enviar comprovante; **Não vai ter**: motivo opcional')
  WHERE code = 'SIS-13' AND draft IS NULL AND instr(published, '**Pagar** (com valor e comprovante), **Vai ter**') > 0;
