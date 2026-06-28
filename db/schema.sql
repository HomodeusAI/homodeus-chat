-- Homodeus Chat schema. Lives under the `chat` schema so it can share the gbrain
-- Postgres instance without colliding with anything.

create schema if not exists chat;
set search_path to chat;

create table if not exists rooms (
  id          text primary key,
  name        text not null,
  created_at  timestamptz not null default now()
);

create table if not exists participants (
  id            text primary key,
  handle        text not null unique,          -- the @handle used in messages
  kind          text not null check (kind in ('agent','human')),
  display_name  text not null,
  token_hash    text,                          -- sha256 of the bearer token (agents)
  created_at    timestamptz not null default now()
);

create table if not exists members (
  room_id         text not null references rooms(id) on delete cascade,
  participant_id  text not null references participants(id) on delete cascade,
  watching        boolean not null default true,
  primary key (room_id, participant_id)
);

create table if not exists messages (
  seq         bigint generated always as identity primary key,  -- the cursor key
  room_id     text not null references rooms(id) on delete cascade,
  author_id   text not null references participants(id),
  body        text not null,
  thread_id   bigint,                          -- seed message seq; seeds point at themselves
  parent_seq  bigint references messages(seq),
  depth       integer not null default 0,
  tokens      integer,                         -- reported by the agent's turn (optional)
  cost_usd    numeric,
  created_at  timestamptz not null default now(),
  body_tsv    tsvector generated always as (to_tsvector('english', body)) stored
);
create index if not exists messages_room_seq on messages (room_id, seq);
create index if not exists messages_thread on messages (thread_id);
create index if not exists messages_tsv on messages using gin (body_tsv);

create table if not exists mentions (
  message_seq     bigint not null references messages(seq) on delete cascade,
  participant_id  text not null references participants(id),
  primary key (message_seq, participant_id)
);
create index if not exists mentions_participant on mentions (participant_id);

create table if not exists threads (
  id           bigint primary key,             -- = seed message seq
  room_id      text not null references rooms(id) on delete cascade,
  status       text not null default 'open' check (status in ('open','halted','converged')),
  turn_count   integer not null default 0,     -- agent->agent turns consumed
  token_count  bigint not null default 0,
  cost_usd     numeric not null default 0,
  halt_reason  text,
  updated_at   timestamptz not null default now()
);

-- Durable wake queue: the Layer-2 guarantee that an offline agent loses no wake.
-- A row exists ONLY when the termination decision said to deliver (a halted thread writes none),
-- so "what should wake an agent" is recorded, never recomputed. Pending = not acked.
create table if not exists wakes (
  message_seq     bigint not null references messages(seq) on delete cascade,
  participant_id  text not null references participants(id) on delete cascade,
  acked           boolean not null default false,
  created_at      timestamptz not null default now(),
  primary key (message_seq, participant_id)
);
create index if not exists wakes_pending on wakes (participant_id, acked, message_seq);

-- Per-ordered-pair tight-loop cooldown counter (defense in depth under the thread breaker).
-- Counts A->B wakes inside a fixed one-minute window; the (K+1)-th wake in a bucket is dropped,
-- not delivered (K = CHAT_PAIR_WAKES_PER_MIN). Keyed by room + ordered pair + epoch-minute bucket;
-- the PK btree is also the upsert lookup. Buckets are disposable: rows are never read after their
-- minute passes, so `delete from pair_wakes where bucket < ...` can reap old windows out of band.
create table if not exists pair_wakes (
  room_id     text not null references rooms(id) on delete cascade,
  from_id     text not null references participants(id) on delete cascade,
  to_id       text not null references participants(id) on delete cascade,
  bucket      bigint not null,                -- floor(epoch_ms / 60000), the minute window
  wake_count  integer not null default 1,     -- A->B wakes recorded in this window (post-increment)
  primary key (room_id, from_id, to_id, bucket)
);

-- durable output of a converged thread.
create table if not exists insights (
  id             bigint generated always as identity primary key,
  thread_id      bigint not null,
  room_id        text not null references rooms(id) on delete cascade,
  body           text not null,
  gbrain_page_id text,
  created_at     timestamptz not null default now()
);
