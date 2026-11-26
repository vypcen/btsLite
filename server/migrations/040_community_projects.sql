-- Существующие проекты сохраняются, в том числе на установках, уже превысивших лимит.
LOCK TABLE projects IN SHARE ROW EXCLUSIVE MODE;

CREATE TABLE community_project_usage (
  singleton BOOLEAN PRIMARY KEY DEFAULT true CHECK (singleton),
  active INTEGER NOT NULL CHECK (active >= 0)
);

INSERT INTO community_project_usage(active)
SELECT count(*) FROM projects WHERE deleted_at IS NULL;

CREATE FUNCTION community_count_projects() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  delta INTEGER := 0;
BEGIN
  IF TG_OP <> 'INSERT' AND OLD.deleted_at IS NULL THEN delta := delta - 1; END IF;
  IF TG_OP <> 'DELETE' AND NEW.deleted_at IS NULL THEN delta := delta + 1; END IF;
  IF delta = 1 THEN
    -- Атомарное обновление одной строки сериализует создание и восстановление.
    UPDATE community_project_usage SET active=active+1 WHERE singleton AND active<2;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'В Community доступно до двух активных проектов'
        USING ERRCODE = '23514', CONSTRAINT = 'community_active_projects';
    END IF;
  ELSIF delta = -1 THEN
    UPDATE community_project_usage SET active=active-1 WHERE singleton;
  END IF;
  RETURN NULL;
END
$$;

CREATE TRIGGER community_project_count AFTER INSERT OR UPDATE OF deleted_at OR DELETE ON projects
  FOR EACH ROW EXECUTE FUNCTION community_count_projects();
