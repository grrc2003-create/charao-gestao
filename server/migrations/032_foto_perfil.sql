-- Foto de perfil (avatar) de cada pessoa. Migração apenas aditiva.
ALTER TABLE users ADD COLUMN avatar_file TEXT;
