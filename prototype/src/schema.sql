-- Shopfloor KB Hub prototype schema. Idempotent: safe to run on every start.

-- ---------- Operations ----------
CREATE TABLE IF NOT EXISTS config (
  key         text PRIMARY KEY,
  value       jsonb NOT NULL,
  updated_at  timestamptz NOT NULL DEFAULT now(),
  updated_by  text NOT NULL DEFAULT 'system'
);
CREATE TABLE IF NOT EXISTS config_audit (
  id          bigserial PRIMARY KEY,
  key         text NOT NULL,
  old_value   jsonb,
  new_value   jsonb,
  changed_at  timestamptz NOT NULL DEFAULT now(),
  changed_by  text NOT NULL
);
CREATE TABLE IF NOT EXISTS sim_state (
  id            int PRIMARY KEY DEFAULT 1,
  seed          int NOT NULL,
  cursor        int NOT NULL DEFAULT 0,     -- next event index in the scripted timeline
  total_events  int NOT NULL DEFAULT 0,
  sim_clock     timestamptz,                -- simulated "MyPM time"
  reset_at      timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS runs (
  id          bigserial PRIMARY KEY,
  scheduler   text NOT NULL,                -- SIM | L1 | L2
  trigger     text NOT NULL,                -- schedule | manual
  status      text NOT NULL DEFAULT 'running',
  started_at  timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz,
  picked      int NOT NULL DEFAULT 0,
  done        int NOT NULL DEFAULT 0,
  failed      int NOT NULL DEFAULT 0,
  note        text
);
CREATE TABLE IF NOT EXISTS jobs (
  id          bigserial PRIMARY KEY,
  stage       text NOT NULL,                -- L1 | L2
  kind        text NOT NULL,                -- ticket | attachment | code | card
  ref         text NOT NULL,                -- task id, file path, repo
  task        text,
  status      text NOT NULL DEFAULT 'pending',  -- pending | processing | done | failed
  before      jsonb,
  after       jsonb,
  error       text,
  attempts    int NOT NULL DEFAULT 0,
  run_id      bigint,
  created_at  timestamptz NOT NULL DEFAULT now(),
  started_at  timestamptz,
  finished_at timestamptz
);
CREATE INDEX IF NOT EXISTS jobs_stage_status ON jobs (stage, status, id);
CREATE INDEX IF NOT EXISTS jobs_task ON jobs (task);
CREATE TABLE IF NOT EXISTS logs (
  id       bigserial PRIMARY KEY,
  ts       timestamptz NOT NULL DEFAULT now(),
  level    text NOT NULL,                   -- debug | info | warn | error
  stage    text NOT NULL,                   -- SIM | L1 | L2 | L3 | API | ADMIN
  run_id   bigint,
  job_id   bigint,
  task     text,
  message  text NOT NULL,
  data     jsonb
);
CREATE INDEX IF NOT EXISTS logs_ts ON logs (id DESC);
CREATE INDEX IF NOT EXISTS logs_task ON logs (task);

-- ---------- L0 raw-store registry (what the scanners have seen) ----------
CREATE TABLE IF NOT EXISTS source_files (
  path        text PRIMARY KEY,
  kind        text NOT NULL,                -- ticket | attachment | code
  task        text,
  repo        text,
  sha256      text NOT NULL,
  size        int NOT NULL,
  first_seen  timestamptz NOT NULL DEFAULT now(),
  last_change timestamptz NOT NULL DEFAULT now()
);

-- ---------- L1 normalized ----------
CREATE TABLE IF NOT EXISTS tickets (
  task        text PRIMARY KEY,             -- 121648-02
  cr          text NOT NULL,                -- 121648
  rev         int NOT NULL,
  title       text NOT NULL,
  project     text NOT NULL,
  site        text NOT NULL,
  customer    text NOT NULL,
  region      text NOT NULL,
  state       text NOT NULL,
  priority    text,
  owner       text,
  created     date,
  required    date,
  last_edit   timestamptz,
  edit_no     int NOT NULL DEFAULT 1,
  capability  text,
  body_md     text NOT NULL,
  sha256      text NOT NULL,
  search      tsvector
);
CREATE TABLE IF NOT EXISTS ticket_versions (
  task        text NOT NULL,
  edit_no     int NOT NULL,
  snapshot    jsonb NOT NULL,
  captured_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (task, edit_no)
);
CREATE TABLE IF NOT EXISTS documents (
  id          bigserial PRIMARY KEY,
  task        text NOT NULL,
  file_name   text NOT NULL,
  format      text NOT NULL,                -- md | docx | pdf
  sha256      text NOT NULL,
  markdown    text NOT NULL,
  chars       int NOT NULL,
  extracted_at timestamptz NOT NULL DEFAULT now(),
  search      tsvector,
  UNIQUE (task, file_name)
);
CREATE TABLE IF NOT EXISTS commits (
  sha          text PRIMARY KEY,
  repo         text NOT NULL,
  message      text NOT NULL,
  author       text NOT NULL,
  committed_at timestamptz NOT NULL,
  files        text[] NOT NULL DEFAULT '{}'
);
CREATE TABLE IF NOT EXISTS code_units (
  id          bigserial PRIMARY KEY,
  repo        text NOT NULL,
  path        text NOT NULL,
  name        text NOT NULL,
  kind        text NOT NULL,                -- function | class
  lang        text NOT NULL,                -- python | javascript
  start_line  int NOT NULL,
  end_line    int NOT NULL,
  commit_sha  text,
  norm_hash   text NOT NULL,
  minhash     int[] NOT NULL,
  doc         text,
  body        text NOT NULL,
  search      tsvector,
  UNIQUE (repo, path, name)
);

-- ---------- L2 / L3 knowledge ----------
CREATE TABLE IF NOT EXISTS links (
  id          bigserial PRIMARY KEY,
  task        text NOT NULL,
  repo        text NOT NULL,
  commit_sha  text,
  tier        text NOT NULL,                -- confirmed | strong | inferred
  evidence    text NOT NULL,
  score       real,
  source      text NOT NULL DEFAULT 'auto', -- auto | expert
  status      text NOT NULL DEFAULT 'active', -- active | rejected
  created_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (task, repo, commit_sha, tier)
);
CREATE TABLE IF NOT EXISTS clone_groups (
  id          bigserial PRIMARY KEY,
  origin_unit bigint NOT NULL,
  label       text NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS clone_members (
  group_id    bigint NOT NULL,
  unit_id     bigint NOT NULL,
  role        text NOT NULL,                -- origin | exact | variant
  similarity  real NOT NULL,
  PRIMARY KEY (group_id, unit_id)
);
CREATE TABLE IF NOT EXISTS cards (
  task          text PRIMARY KEY,
  version       int NOT NULL,
  template_version text NOT NULL,
  card_md       text NOT NULL,
  overview      text NOT NULL,
  link_confidence text NOT NULL,
  status        text NOT NULL DEFAULT 'generated', -- generated | reviewed
  model         text NOT NULL,
  tokens_in     int NOT NULL DEFAULT 0,
  tokens_out    int NOT NULL DEFAULT 0,
  generated_at  timestamptz NOT NULL DEFAULT now(),
  search        tsvector
);
CREATE TABLE IF NOT EXISTS card_history (
  task          text NOT NULL,
  version       int NOT NULL,
  card_md       text NOT NULL,
  model         text NOT NULL,
  generated_at  timestamptz NOT NULL,
  PRIMARY KEY (task, version)
);
CREATE TABLE IF NOT EXISTS similar_tickets (
  task_a  text NOT NULL,
  task_b  text NOT NULL,
  score   real NOT NULL,
  PRIMARY KEY (task_a, task_b)
);
CREATE TABLE IF NOT EXISTS review_items (
  id          bigserial PRIMARY KEY,
  kind        text NOT NULL,                -- inferred_link | clone | duplicate | unlinked
  ref         text NOT NULL,
  task        text,
  title       text NOT NULL,
  detail      jsonb,
  status      text NOT NULL DEFAULT 'open', -- open | approved | rejected
  created_at  timestamptz NOT NULL DEFAULT now(),
  decided_at  timestamptz,
  decided_by  text,
  UNIQUE (kind, ref)
);
CREATE INDEX IF NOT EXISTS tickets_search ON tickets USING gin (search);
CREATE INDEX IF NOT EXISTS cards_search ON cards USING gin (search);
CREATE INDEX IF NOT EXISTS documents_search ON documents USING gin (search);
CREATE INDEX IF NOT EXISTS code_units_search ON code_units USING gin (search);
