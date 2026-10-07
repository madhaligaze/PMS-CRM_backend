-- btree_gist: EXCLUDE-ограничение «номер + пересечение дат» (двойная бронь).
-- pg_trgm: нечёткий поиск гостей по ФИО.
CREATE EXTENSION IF NOT EXISTS btree_gist;
--> statement-breakpoint
CREATE EXTENSION IF NOT EXISTS pg_trgm;
