-- =====================================================================
-- Probrero database
-- Paste this whole file into Supabase → SQL Editor → New query → Run.
-- Run it once on a fresh project.
-- =====================================================================

create extension if not exists pgcrypto;

-- ---------- Tables ----------------------------------------------------

-- One row per account. Created automatically when someone signs up.
create table public.profiles (
  id          uuid primary key references auth.users(id) on delete cascade,
  full_name   text not null default '',
  role        text not null check (role in ('customer','pro')),
  created_at  timestamptz not null default now()
);

-- A pro's public business listing.
create table public.pros (
  id                 uuid primary key references public.profiles(id) on delete cascade,
  business_name      text not null check (length(business_name) between 2 and 120),
  trade              text not null,
  city               text not null default '',
  zip                text not null default '',
  hourly_rate        numeric(10,2) not null default 0 check (hourly_rate >= 0),
  trip_fee           numeric(10,2) not null default 0 check (trip_fee >= 0),
  license            text not null default '',
  years_in_business  int not null default 0 check (years_in_business >= 0),
  about              text not null default '',
  services           jsonb not null default '[]'::jsonb check (jsonb_typeof(services) = 'array'),
  response_time      text not null default '',
  created_at         timestamptz not null default now()
);

-- Stripe connection for each pro. Only the server writes here.
create table public.pro_payments (
  pro_id             uuid primary key references public.pros(id) on delete cascade,
  stripe_account_id  text unique,
  charges_enabled    boolean not null default false,
  updated_at         timestamptz not null default now()
);

create table public.quotes (
  id             uuid primary key default gen_random_uuid(),
  customer_id    uuid not null references public.profiles(id) on delete cascade,
  customer_name  text not null default '',
  pro_id         uuid not null references public.pros(id) on delete cascade,
  description    text not null check (length(description) between 5 and 4000),
  timing         text not null default '',
  zip            text not null default '',
  status         text not null default 'pending' check (status in ('pending','quoted','accepted','declined')),
  amount         numeric(10,2) check (amount >= 0),
  note           text not null default '',
  invoiced       boolean not null default false,
  created_at     timestamptz not null default now()
);

-- items: [{ "description": "Labor", "qty": 2, "rate": 115 }, ...]
create table public.invoices (
  id                 uuid primary key default gen_random_uuid(),
  pro_id             uuid not null references public.pros(id) on delete cascade,
  number             text not null,
  customer_id        uuid references public.profiles(id) on delete set null,
  customer_name      text not null check (length(customer_name) between 1 and 120),
  customer_email     text not null default '',
  items              jsonb not null check (jsonb_typeof(items) = 'array' and jsonb_array_length(items) > 0),
  total              numeric(10,2) not null check (total > 0),
  notes              text not null default '',
  issued_on          date not null default current_date,
  due_on             date not null default current_date,
  status             text not null default 'open' check (status in ('open','paid','void')),
  paid_at            timestamptz,
  payment_method     text,
  stripe_session_id  text,
  quote_id           uuid references public.quotes(id) on delete set null,
  created_at         timestamptz not null default now(),
  unique (pro_id, number)
);

create table public.expenses (
  id            uuid primary key default gen_random_uuid(),
  pro_id        uuid not null references public.pros(id) on delete cascade,
  spent_on      date not null default current_date,
  vendor        text not null check (length(vendor) between 1 and 120),
  category      text not null,
  amount        numeric(10,2) not null check (amount >= 0),
  receipt_path  text,
  created_at    timestamptz not null default now()
);

create table public.reviews (
  id             uuid primary key default gen_random_uuid(),
  pro_id         uuid not null references public.pros(id) on delete cascade,
  customer_id    uuid not null references public.profiles(id) on delete cascade,
  reviewer_name  text not null default '',
  stars          int not null check (stars between 1 and 5),
  body           text not null check (length(body) between 3 and 2000),
  created_at     timestamptz not null default now(),
  unique (pro_id, customer_id)
);

create index on public.quotes (pro_id);
create index on public.quotes (customer_id);
create index on public.invoices (pro_id);
create index on public.invoices (customer_id);
create index on public.invoices (lower(customer_email));
create index on public.expenses (pro_id);
create index on public.reviews (pro_id);

-- ---------- Sign-up: create the profile, link invoices by email -------

create or replace function public.link_invoices_to_user(uid uuid, mail text)
returns void language plpgsql security definer set search_path = public as $$
begin
  perform set_config('probrero.linking', 'on', true);
  update public.invoices
     set customer_id = uid
   where customer_id is null
     and customer_email <> ''
     and lower(customer_email) = lower(mail);
  perform set_config('probrero.linking', 'off', true);
end $$;

create or replace function public.handle_new_user()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  insert into public.profiles (id, full_name, role)
  values (
    new.id,
    left(coalesce(new.raw_user_meta_data->>'full_name', ''), 120),
    case when new.raw_user_meta_data->>'role' = 'pro' then 'pro' else 'customer' end
  );
  if new.email_confirmed_at is not null then
    perform public.link_invoices_to_user(new.id, new.email);
  end if;
  return new;
end $$;

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- Invoices sent to an email address show up in that person's account
-- once they confirm the address.
create or replace function public.handle_user_confirmed()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if new.email_confirmed_at is not null and old.email_confirmed_at is null then
    perform public.link_invoices_to_user(new.id, new.email);
  end if;
  return new;
end $$;

create trigger on_auth_user_confirmed
  after update of email_confirmed_at on auth.users
  for each row execute function public.handle_user_confirmed();

-- ---------- Guards: keep data honest ----------------------------------

-- Quotes: customers can only accept/decline; pros can only price or pass.
create or replace function public.quotes_guard()
returns trigger language plpgsql security definer set search_path = public as $$
declare
  uid uuid := auth.uid();
  chk public.quotes;
begin
  if tg_op = 'INSERT' then
    if uid is not null then
      new.customer_id := uid;
      new.status := 'pending';
      new.amount := null;
      new.note := '';
      new.invoiced := false;
      new.created_at := now();
      select full_name into new.customer_name from public.profiles where id = uid;
      new.customer_name := coalesce(new.customer_name, '');
    end if;
    return new;
  end if;

  if uid is null then return new; end if;   -- server

  chk := new;
  if uid = old.pro_id then
    chk.status := old.status; chk.amount := old.amount; chk.note := old.note; chk.invoiced := old.invoiced;
    if chk is distinct from old then raise exception 'Only the price, note and status can change.'; end if;
    if old.status = 'pending' and new.status = 'quoted' then
      if new.amount is null or new.amount <= 0 then raise exception 'Enter a price above $0.'; end if;
      return new;
    elsif old.status = 'pending' and new.status = 'declined' then
      return new;
    elsif old.status = 'accepted' and new.status = 'accepted'
          and new.amount = old.amount and new.note = old.note then
      return new;                              -- marking it invoiced
    end if;
    raise exception 'This quote can no longer be changed.';
  elsif uid = old.customer_id then
    chk.status := old.status;
    if chk is distinct from old then raise exception 'Only the status can change.'; end if;
    if old.status = 'quoted' and new.status in ('accepted','declined') then return new; end if;
    if old.status = 'pending' and new.status = 'declined' then return new; end if;
    raise exception 'This quote can no longer be changed.';
  end if;
  raise exception 'Not allowed.';
end $$;

create trigger quotes_guard
  before insert or update on public.quotes
  for each row execute function public.quotes_guard();

-- Invoices: the database computes the total from the line items, links the
-- customer's account, and stops paid or voided invoices from being edited.
create or replace function public.invoices_guard()
returns trigger language plpgsql security definer set search_path = public as $$
declare
  uid uuid := auth.uid();
  t numeric;
  linked uuid;
begin
  select round(sum((x->>'qty')::numeric * (x->>'rate')::numeric), 2) into t
    from jsonb_array_elements(new.items) x;
  if exists (select 1 from jsonb_array_elements(new.items) x
              where (x->>'qty')::numeric < 0 or (x->>'rate')::numeric < 0
                 or coalesce(trim(x->>'description'), '') = '') then
    raise exception 'Every line needs a description, and amounts can''t be negative.';
  end if;
  new.total := coalesce(t, 0);
  new.customer_email := lower(trim(coalesce(new.customer_email, '')));

  if uid is null then return new; end if;    -- server (Stripe webhook)
  if current_setting('probrero.linking', true) = 'on' then return new; end if;  -- account linking

  if tg_op = 'INSERT' then
    new.status := 'open'; new.paid_at := null; new.payment_method := null; new.stripe_session_id := null;
    if new.customer_id is not null and not exists (
         select 1 from public.quotes q where q.pro_id = new.pro_id and q.customer_id = new.customer_id) then
      new.customer_id := null;
    end if;
    if new.customer_id is null and new.customer_email <> '' then
      select u.id into linked from auth.users u
       where lower(u.email) = new.customer_email and u.email_confirmed_at is not null limit 1;
      new.customer_id := linked;
    end if;
    return new;
  end if;

  -- UPDATE by the pro
  if old.status <> 'open' then raise exception 'Paid or voided invoices can''t be changed.'; end if;
  if new.pro_id <> old.pro_id then raise exception 'Not allowed.'; end if;
  new.stripe_session_id := old.stripe_session_id;
  if new.customer_id is distinct from old.customer_id then new.customer_id := old.customer_id; end if;
  if new.status = 'paid' then
    new.paid_at := now();
    new.payment_method := coalesce(nullif(trim(new.payment_method), ''), 'Recorded by pro');
  else
    new.paid_at := null; new.payment_method := null;
  end if;
  return new;
end $$;

create trigger invoices_guard
  before insert or update on public.invoices
  for each row execute function public.invoices_guard();

-- Reviews: name comes from the reviewer's profile ("Jordan L.").
create or replace function public.reviews_guard()
returns trigger language plpgsql security definer set search_path = public as $$
declare n text;
begin
  select full_name into n from public.profiles where id = new.customer_id;
  n := trim(coalesce(n, ''));
  new.reviewer_name := case
    when n = '' then 'Probrero customer'
    when position(' ' in n) = 0 then n
    else split_part(n, ' ', 1) || ' ' || left(split_part(n, ' ', array_length(string_to_array(n, ' '), 1)), 1) || '.'
  end;
  new.created_at := now();
  return new;
end $$;

create trigger reviews_guard
  before insert on public.reviews
  for each row execute function public.reviews_guard();

-- ---------- Public directory view -------------------------------------

create view public.pro_directory as
select p.id, p.business_name, p.trade, p.city, p.zip, p.hourly_rate, p.trip_fee, p.license,
       p.years_in_business, p.about, p.services, p.response_time, p.created_at,
       coalesce(r.avg_stars, 0)::numeric(3,2) as rating,
       coalesce(r.review_count, 0)::int        as review_count,
       coalesce(j.jobs, 0)::int                as jobs_done,
       coalesce(pp.charges_enabled, false)     as accepts_cards
  from public.pros p
  left join (select pro_id, avg(stars) avg_stars, count(*) review_count
               from public.reviews group by pro_id) r on r.pro_id = p.id
  left join (select pro_id, count(*) jobs
               from public.invoices where status = 'paid' group by pro_id) j on j.pro_id = p.id
  left join public.pro_payments pp on pp.pro_id = p.id;

grant select on public.pro_directory to anon, authenticated;

-- ---------- Row-level security ----------------------------------------

alter table public.profiles     enable row level security;
alter table public.pros         enable row level security;
alter table public.pro_payments enable row level security;
alter table public.quotes       enable row level security;
alter table public.invoices     enable row level security;
alter table public.expenses     enable row level security;
alter table public.reviews      enable row level security;

create policy "Read own profile"   on public.profiles for select to authenticated using (id = auth.uid());
create policy "Update own profile" on public.profiles for update to authenticated using (id = auth.uid()) with check (id = auth.uid());
revoke update on public.profiles from authenticated;
grant update (full_name) on public.profiles to authenticated;

create policy "Anyone can view pros" on public.pros for select to anon, authenticated using (true);
create policy "Pros create own listing" on public.pros for insert to authenticated
  with check (id = auth.uid() and exists (select 1 from public.profiles where id = auth.uid() and role = 'pro'));
create policy "Pros edit own listing" on public.pros for update to authenticated
  using (id = auth.uid()) with check (id = auth.uid());

create policy "Pros see own Stripe status" on public.pro_payments for select to authenticated using (pro_id = auth.uid());

create policy "See own quotes" on public.quotes for select to authenticated
  using (auth.uid() = customer_id or auth.uid() = pro_id);
create policy "Customers request quotes" on public.quotes for insert to authenticated
  with check (customer_id = auth.uid() and pro_id <> auth.uid());
create policy "Update own quotes" on public.quotes for update to authenticated
  using (auth.uid() = customer_id or auth.uid() = pro_id);

create policy "See own invoices" on public.invoices for select to authenticated
  using (auth.uid() = pro_id or auth.uid() = customer_id);
create policy "Pros create invoices" on public.invoices for insert to authenticated
  with check (pro_id = auth.uid());
create policy "Pros update invoices" on public.invoices for update to authenticated
  using (pro_id = auth.uid()) with check (pro_id = auth.uid());

create policy "Pros manage expenses" on public.expenses for all to authenticated
  using (pro_id = auth.uid()) with check (pro_id = auth.uid());

create policy "Anyone can read reviews" on public.reviews for select to anon, authenticated using (true);
create policy "Paying customers can review" on public.reviews for insert to authenticated
  with check (
    customer_id = auth.uid()
    and exists (select 1 from public.invoices i
                 where i.pro_id = reviews.pro_id and i.customer_id = auth.uid() and i.status = 'paid'));
create policy "Delete own review" on public.reviews for delete to authenticated using (customer_id = auth.uid());

-- ---------- Receipt photos --------------------------------------------

insert into storage.buckets (id, name, public) values ('receipts', 'receipts', false)
  on conflict (id) do nothing;

create policy "Pros manage own receipt files" on storage.objects for all to authenticated
  using      (bucket_id = 'receipts' and (storage.foldername(name))[1] = auth.uid()::text)
  with check (bucket_id = 'receipts' and (storage.foldername(name))[1] = auth.uid()::text);
