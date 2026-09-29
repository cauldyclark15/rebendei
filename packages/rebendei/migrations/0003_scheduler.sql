CREATE TABLE scheduled_jobs (
  id text PRIMARY KEY,
  path text NOT NULL,
  args jsonb NOT NULL,
  run_at double precision NOT NULL,
  state text NOT NULL DEFAULT 'pending' CHECK (state IN ('pending','inProgress','success','failed','canceled')),
  attempts integer NOT NULL DEFAULT 0,
  error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  kind text NOT NULL CHECK (kind IN ('mutation','action')),
  claim_token text,
  lease_until double precision,
  cron_name text,
  cron_generation text,
  cron_run_at double precision,
  UNIQUE (cron_name, cron_generation, cron_run_at)
);
CREATE INDEX scheduled_jobs_state_run_at ON scheduled_jobs (state, run_at);
CREATE INDEX scheduled_jobs_recovery ON scheduled_jobs (lease_until) WHERE state = 'inProgress' AND kind = 'mutation';
CREATE TABLE crons (
  name text PRIMARY KEY,
  generation text NOT NULL,
  spec jsonb NOT NULL,
  path text NOT NULL,
  args jsonb NOT NULL,
  next_run double precision NOT NULL
);
