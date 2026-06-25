-- ============================================
-- TASKFORGE DATABASE SCHEMA (Supabase/PostgreSQL)
-- Safe to re-run multiple times — drops everything first
-- Run this in Supabase SQL Editor
-- ============================================

-- ============================================
-- STEP 1: DROP EVERYTHING (safe re-run)
-- ============================================

drop policy if exists "users_own_data" on users;
drop policy if exists "one_submission_per_task" on submissions;

drop view if exists task_vote_counts;
drop view if exists project_stats;

drop function if exists increment_completed_tasks(uuid);
drop function if exists increment_xp(uuid, integer);

drop table if exists project_outputs cascade;
drop table if exists votes cascade;
drop table if exists submissions cascade;
drop table if exists learner_progress cascade;
drop table if exists tasks cascade;
drop table if exists projects cascade;
drop table if exists users cascade;

-- ============================================
-- STEP 2: CREATE TABLES
-- ============================================

create table users (
  id uuid primary key default gen_random_uuid(),
  email text unique not null,
  name text,
  role text check (role in ('learner','client','admin')) default 'learner',
  xp integer default 0,
  level integer default 1,
  streak integer default 0,
  last_active date,
  track text check (track in ('frontend','backend','api','security','fullstack')),
  created_at timestamptz default now()
);

create table projects (
  id uuid primary key default gen_random_uuid(),
  client_id uuid references users(id),
  name text not null,
  description text,
  tech_stack text[],
  status text check (status in ('pending','active','review','complete')) default 'pending',
  total_tasks integer default 0,
  completed_tasks integer default 0,
  timeline_weeks integer default 8,
  repo_url text,
  created_at timestamptz default now()
);

create table tasks (
  id uuid primary key default gen_random_uuid(),
  project_id uuid references projects(id) on delete cascade,
  track text check (track in ('frontend','backend','api','security')) not null,
  title text not null,
  description text,
  quiz_title text not null,
  quiz_context text,
  quiz_type text check (quiz_type in ('mcq','code','review','debug')) default 'mcq',
  options jsonb,
  correct_option integer,
  starter_code text,
  expected_output text,
  test_cases jsonb,
  status text check (status in ('open','in_progress','voting','verified','committed')) default 'open',
  verified_output text,
  xp_reward integer default 25,
  min_votes integer default 3,
  created_at timestamptz default now()
);

create table submissions (
  id uuid primary key default gen_random_uuid(),
  task_id uuid references tasks(id) on delete cascade,
  user_id uuid references users(id),
  selected_option integer,
  submitted_code text,
  execution_result jsonb,
  is_correct boolean,
  xp_earned integer default 0,
  time_taken_seconds integer,
  created_at timestamptz default now(),
  unique(task_id, user_id)
);

create table votes (
  id uuid primary key default gen_random_uuid(),
  task_id uuid references tasks(id) on delete cascade,
  submission_id uuid references submissions(id),
  voter_id uuid references users(id),
  created_at timestamptz default now(),
  unique(task_id, voter_id)
);

create table project_outputs (
  id uuid primary key default gen_random_uuid(),
  project_id uuid references projects(id) on delete cascade,
  task_id uuid references tasks(id),
  file_path text,
  content text,
  committed_at timestamptz,
  commit_sha text
);

create table learner_progress (
  id uuid primary key default gen_random_uuid(),
  user_id uuid references users(id),
  track text,
  tasks_completed integer default 0,
  tasks_correct integer default 0,
  xp_earned integer default 0,
  updated_at timestamptz default now(),
  unique(user_id, track)
);

-- ============================================
-- STEP 3: CREATE VIEWS
-- ============================================

create view project_stats as
select
  p.id,
  p.name,
  p.status,
  p.total_tasks,
  p.completed_tasks,
  case when p.total_tasks > 0
    then round((p.completed_tasks::numeric / p.total_tasks) * 100, 1)
    else 0
  end as completion_pct,
  count(distinct s.user_id) as active_learners
from projects p
left join tasks t on t.project_id = p.id
left join submissions s on s.task_id = t.id
group by p.id;

create view task_vote_counts as
select
  t.id as task_id,
  t.quiz_title,
  t.status,
  t.min_votes,
  count(v.id) as total_votes,
  mode() within group (order by v.submission_id) as leading_submission_id
from tasks t
left join votes v on v.task_id = t.id
group by t.id;

-- ============================================
-- STEP 4: CREATE FUNCTIONS
-- ============================================

create or replace function increment_completed_tasks(project_id uuid)
returns void as $$
  update projects
  set completed_tasks = completed_tasks + 1
  where id = project_id;
$$ language sql security definer;

create or replace function increment_xp(user_id uuid, amount integer)
returns void as $$
  update users
  set xp = xp + amount,
      level = greatest(1, floor((xp + amount) / 500)::integer)
  where id = user_id;
$$ language sql security definer;

-- ============================================
-- STEP 5: ROW LEVEL SECURITY
-- ============================================

alter table users enable row level security;
alter table submissions enable row level security;
alter table votes enable row level security;

create policy "users_own_data" on users
  for select using (auth.uid() = id);

create policy "one_submission_per_task" on submissions
  for insert with check (
    not exists (
      select 1 from submissions s
      where s.task_id = task_id and s.user_id = auth.uid()
    )
  );

-- ============================================
-- DONE — all tables, views, functions created
-- ============================================
