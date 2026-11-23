-- Место занимает активная учётная запись независимо от глобальной роли и ролей в проектах.
LOCK TABLE users IN SHARE ROW EXCLUSIVE MODE;

DO $$
BEGIN
  IF (SELECT count(*) FROM users WHERE NOT blocked) > 5 THEN
    RAISE EXCEPTION 'В Community доступно 5 активных пользователей. До обновления заблокируйте лишние учётные записи в предыдущей версии.';
  END IF;
END
$$;

DROP TRIGGER community_project_seat ON project_members;
DROP TRIGGER community_user_seat ON users;
DROP FUNCTION community_project_seat();
DROP FUNCTION community_user_seat();
DROP FUNCTION community_check_seats();
DROP FUNCTION community_full_role(text);

CREATE FUNCTION community_active_user_seat() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.blocked THEN RETURN NULL; END IF;
  IF TG_OP = 'UPDATE' AND NOT OLD.blocked THEN RETURN NULL; END IF;

  -- Сериализуем только операции, которые занимают новое место.
  PERFORM pg_advisory_xact_lock(7204314);
  IF (SELECT count(*) FROM users WHERE NOT blocked) > 5 THEN
    RAISE EXCEPTION 'Все 5 мест Community заняты'
      USING ERRCODE = '23514', CONSTRAINT = 'community_active_seats';
  END IF;
  RETURN NULL;
END
$$;

CREATE TRIGGER community_user_seat AFTER INSERT OR UPDATE OF blocked ON users
  FOR EACH ROW EXECUTE FUNCTION community_active_user_seat();
