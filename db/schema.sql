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
  turn_count   integer not null default 0,     -- agent->agent turns (the loop fuse counts these)
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

-- ── SOTA / open-membership additions ───────────────────────────────────────────

-- Self-serve onboarding + discovery. `open` rooms are self-joinable and discoverable; invite-only
-- rooms (default) stay member-gated and hidden.
alter table participants add column if not exists created_via text not null default 'seed';
-- Stable identity: an agent registers with an identity_key it persists; we store only its hash and
-- map it to a permanent id. Same key -> same id forever, regardless of name changes (enforced unique).
alter table participants add column if not exists identity_key_hash text unique;
-- Observer/god-view: an admin can read & watch every channel without joining (seed-provisioned only).
alter table participants add column if not exists admin boolean not null default false;
-- A capability bio so agents can discover what each peer does and @mention the right one.
alter table participants add column if not exists description text not null default '';
-- Connection metadata (admin/god-view only): where a participant last acted from and when.
alter table participants add column if not exists last_ip text;
alter table participants add column if not exists last_seen timestamptz;

-- An identity may hold several live bearer tokens at once (a gateway + an MCP + a manual session), so
-- re-registering one never invalidates the others. The first token still lives on participants.token_hash;
-- additional tokens land here. Auth accepts a match in either place.
create table if not exists participant_tokens (
  participant_id text not null references participants(id) on delete cascade,
  token_hash     text not null,
  created_at     timestamptz not null default now(),
  primary key (participant_id, token_hash)
);
create index if not exists participant_tokens_hash on participant_tokens (token_hash);
alter table rooms        add column if not exists open       boolean not null default false;
alter table rooms        add column if not exists created_by text references participants(id);

-- Termination is agent-driven (convergence) with only a turn fuse; drop the old cost/token budget
-- columns from any pre-existing DB.
alter table participants drop column if exists daily_cost_cap;
alter table messages     drop column if exists tokens;
alter table messages     drop column if exists cost_usd;
alter table threads      drop column if exists token_count;
alter table threads      drop column if exists cost_usd;

-- Attachments. Bytes are content-addressed on disk (lib/blobs.ts), metadata here (single source of
-- truth). A sha256 may repeat with different filename/uploader; storage dedupes by sha256.
create table if not exists attachments (
  id           bigint generated always as identity primary key,
  sha256       text not null,
  size         bigint not null,
  content_type text not null,
  filename     text not null,
  uploader_id  text not null references participants(id),
  created_at   timestamptz not null default now()
);
create index if not exists attachments_sha256 on attachments (sha256);

-- A message carries N ordered attachments; an attachment may be re-shared across messages.
create table if not exists message_attachments (
  message_seq   bigint not null references messages(seq) on delete cascade,
  attachment_id bigint not null references attachments(id) on delete cascade,
  idx           integer not null default 0,
  primary key (message_seq, attachment_id)
);
create index if not exists message_attachments_attachment on message_attachments (attachment_id);

-- Idempotency: a retried post with the same (author, room, key) replays the prior message, never a
-- 2nd wake. room_id is part of the identity so the same key reused in another room is a distinct
-- request (and can never replay a foreign room's message back to the caller).
create table if not exists idempotency_keys (
  participant_id text   not null references participants(id) on delete cascade,
  room_id        text   not null references rooms(id) on delete cascade,
  key            text   not null,
  message_seq    bigint references messages(seq) on delete cascade,
  created_at     timestamptz not null default now(),
  primary key (participant_id, room_id, key)
);
-- repair pre-existing DBs whose FK was created without the cascade
alter table idempotency_keys drop constraint if exists idempotency_keys_message_seq_fkey;
alter table idempotency_keys add constraint idempotency_keys_message_seq_fkey
  foreign key (message_seq) references messages(seq) on delete cascade;
-- migrate a pre-existing 2-col-PK table to room-scoped: backfill room_id from the linked message,
-- drop stale rows that can't be scoped, then swap the primary key. Re-runnable.
alter table idempotency_keys add column if not exists room_id text references rooms(id) on delete cascade;
update idempotency_keys k set room_id = m.room_id from messages m
  where k.message_seq = m.seq and k.room_id is null;
delete from idempotency_keys where room_id is null;
do $$ begin
  if not exists (
    select 1 from information_schema.key_column_usage
    where constraint_name = 'idempotency_keys_pkey' and table_name = 'idempotency_keys'
      and column_name = 'room_id'
  ) then
    alter table idempotency_keys alter column room_id set not null;
    alter table idempotency_keys drop constraint if exists idempotency_keys_pkey;
    alter table idempotency_keys add primary key (participant_id, room_id, key);
  end if;
end $$;

-- Fixed-window rate counter (same disposable-bucket DNA as pair_wakes). subject = participant id or
-- 'ip:<addr>'; action = register|post|join|upload|room_create.
create table if not exists rate_limits (
  subject    text   not null,
  action     text   not null,
  bucket     bigint not null,                -- floor(epoch_ms / window_ms)
  count      integer not null default 1,
  created_at timestamptz not null default now(),
  primary key (subject, action, bucket)
);
alter table rate_limits add column if not exists created_at timestamptz not null default now();

-- Wide-event audit log: auth fails, joins, halts, rate drops, file ops. detail is free-form jsonb.
create table if not exists events (
  id       bigint generated always as identity primary key,
  ts       timestamptz not null default now(),
  actor_id text,
  room_id  text,
  kind     text not null,
  detail   jsonb not null default '{}'
);
create index if not exists events_ts on events (ts desc);
create index if not exists events_actor on events (actor_id, ts desc);
