-- Ревизия редактора учитывает папку и параметры, которые не входят в историю версий кейса.
ALTER TABLE test_cases ADD COLUMN edit_revision INTEGER NOT NULL DEFAULT 1;

CREATE OR REPLACE FUNCTION test_case_bump_version() RETURNS trigger AS $$
BEGIN
  IF (NEW.kind, NEW.title, NEW.priority, NEW.status, NEW.preconditions, NEW.steps, NEW.expected, NEW.step_list, NEW.tags, NEW.fields)
     IS DISTINCT FROM (OLD.kind, OLD.title, OLD.priority, OLD.status, OLD.preconditions, OLD.steps, OLD.expected, OLD.step_list, OLD.tags, OLD.fields) THEN
    NEW.version := OLD.version + 1;
  ELSE
    NEW.version := OLD.version;
  END IF;

  IF (NEW.version, NEW.folder_id, NEW.params, NEW.dataset_id)
     IS DISTINCT FROM (OLD.version, OLD.folder_id, OLD.params, OLD.dataset_id) THEN
    NEW.edit_revision := OLD.edit_revision + 1;
  ELSE
    NEW.edit_revision := OLD.edit_revision;
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;
