-- A equipe do projeto passa a ser a mesma liberação de acesso de Usuários → Permissões.
-- Ajuste de dados apenas aditivo: quem já estava na equipe recebe acesso ao projeto, e quem já tinha acesso aparece na equipe.
INSERT OR IGNORE INTO user_project_access (user_id, project_id)
  SELECT m.user_id, m.project_id FROM project_members m JOIN users u ON u.id = m.user_id
  WHERE u.role <> 'admin' AND u.access_scope <> 'total';
INSERT OR IGNORE INTO project_members (project_id, user_id)
  SELECT a.project_id, a.user_id FROM user_project_access a;
