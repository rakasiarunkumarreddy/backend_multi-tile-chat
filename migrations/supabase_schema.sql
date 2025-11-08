-- user profiles
create table if not exists profiles (
  id uuid primary key default gen_random_uuid(),
  email text,
  created_at timestamp with time zone default timezone('utc', now())
);

-- sessions (each tile = separate session)
create table if not exists sessions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid,
  tile_id text,
  created_at timestamp with time zone default timezone('utc', now()),
  last_activity timestamp with time zone default timezone('utc', now()),
  expires_at timestamp with time zone
);

-- messages
create table if not exists messages (
  id uuid primary key default gen_random_uuid(),
  session_id uuid references sessions(id) on delete cascade,
  role text,
  content text,
  tokens integer default 0,
  created_at timestamp with time zone default timezone('utc', now())
);

-- track token usage per user
create table if not exists token_usage (
  id uuid primary key default gen_random_uuid(),
  user_id uuid,
  total_tokens bigint default 0,
  updated_at timestamp with time zone default timezone('utc', now())
);

-- payment transactions
create table if not exists transactions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid,
  razorpay_order_id text,
  razorpay_payment_id text,
  amount integer,
  currency text,
  status text,
  created_at timestamp with time zone default timezone('utc', now())
);
