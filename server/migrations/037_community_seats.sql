-- Один пользователь занимает одно полное место, даже если полная роль выдана в нескольких проектах.
CREATE FUNCTION community_full_role(role_key text) RETURNS boolean LANGUAGE sql STABLE AS $$
  SELECT COALESCE(role_key IN ('admin', 'tester') OR EXISTS (
    SELECT 1 FROM roles WHERE key=role_key AND EXISTS (
      SELECT 1 FROM unnest(permissions) AS p
      WHERE p NOT IN ('comments', 'bugs.status', 'ai')
    )
  ), false)
$$;

CREATE FUNCTION community_check_seats() RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  IF (SELECT count(*) FROM users u WHERE NOT u.blocked AND (
    community_full_role(u.role) OR EXISTS (
      SELECT 1 FROM project_members m WHERE m.user_id=u.id AND community_full_role(m.role)
    )
  )) > 5 THEN
    RAISE EXCEPTION 'Все полные места Community заняты (5)' USING ERRCODE='23514', CONSTRAINT='community_full_seats';
  END IF;
END
$$;

CREATE FUNCTION community_user_seat() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE project_role_is_full boolean;
BEGIN
  IF NEW.blocked THEN RETURN NULL; END IF;
  PERFORM pg_advisory_xact_lock(7204314);
  SELECT EXISTS (SELECT 1 FROM project_members m WHERE m.user_id=NEW.id AND community_full_role(m.role))
    INTO project_role_is_full;
  IF TG_OP='UPDATE' AND NOT OLD.blocked AND (community_full_role(OLD.role) OR project_role_is_full) THEN RETURN NULL; END IF;
  IF community_full_role(NEW.role) OR project_role_is_full THEN PERFORM community_check_seats(); END IF;
  RETURN NULL;
END
$$;

CREATE FUNCTION community_project_seat() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NOT community_full_role(NEW.role) THEN RETURN NULL; END IF;
  PERFORM pg_advisory_xact_lock(7204314);
  IF TG_OP='UPDATE' AND OLD.user_id=NEW.user_id AND community_full_role(OLD.role) THEN RETURN NULL; END IF;
  IF EXISTS (SELECT 1 FROM users u WHERE u.id=NEW.user_id AND NOT u.blocked AND NOT community_full_role(u.role))
     AND NOT EXISTS (SELECT 1 FROM project_members m WHERE m.user_id=NEW.user_id
       AND m.project_key<>NEW.project_key AND community_full_role(m.role)) THEN
    PERFORM community_check_seats();
  END IF;
  RETURN NULL;
END
$$;

CREATE TRIGGER community_user_seat AFTER INSERT OR UPDATE OF role, blocked ON users
  FOR EACH ROW EXECUTE FUNCTION community_user_seat();
CREATE TRIGGER community_project_seat AFTER INSERT OR UPDATE OF role, user_id ON project_members
  FOR EACH ROW EXECUTE FUNCTION community_project_seat();
