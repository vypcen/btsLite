ALTER TABLE auto_runs
  ADD COLUMN last_activity_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  ADD COLUMN failure_reason TEXT NOT NULL DEFAULT '';

UPDATE auto_runs r
   SET last_activity_at = GREATEST(r.created_at, (
     SELECT max(ar.created_at) FROM auto_results ar WHERE ar.run_id = r.id
   ))
 WHERE r.state IN ('queued', 'running');

CREATE INDEX auto_runs_inactive_idx ON auto_runs(state, last_activity_at) WHERE state IN ('queued', 'running');
