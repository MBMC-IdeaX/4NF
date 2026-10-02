-- Crashes on phones, reported somewhere a person will read them.
--
-- A door terminal that throws on a bus is otherwise invisible: nobody is at a
-- desk with the console open, and the passenger just sees a blank screen. The
-- app now posts what broke to report_client_error(), and the super admin
-- console lists it through admin_client_errors().
--
-- Anyone can report, signed in or not, because the screens that crash most are
-- the ones with no login. That makes the table something a stranger can write
-- to, so every field is cut to a fixed length, the whole table takes at most
-- 60 reports a minute, and rows older than 30 days are dropped as new ones
-- arrive. Nothing in it moves money or is trusted for anything; it is a log.

create table if not exists client_errors (
  id          bigserial primary key,
  at          timestamptz not null default now(),
  surface     text not null,
  message     text not null,
  stack       text,
  path        text,
  build       text,
  user_agent  text,
  user_id     uuid
);

create index if not exists client_errors_at on client_errors (at desc);

alter table client_errors enable row level security;
revoke all on client_errors from anon, authenticated;

create or replace function report_client_error(
  p_surface text,
  p_message text,
  p_stack text default null,
  p_path text default null,
  p_build text default null,
  p_user_agent text default null
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = public
as $$
begin
  if coalesce(trim(p_message), '') = '' then
    return jsonb_build_object('ok', false, 'reason', 'empty');
  end if;
  if (select count(*) from client_errors where at > now() - interval '1 minute') >= 60 then
    return jsonb_build_object('ok', false, 'reason', 'rate_limited');
  end if;

  delete from client_errors where at < now() - interval '30 days';

  insert into client_errors (surface, message, stack, path, build, user_agent, user_id)
  values (
    left(coalesce(nullif(trim(p_surface), ''), 'unknown'), 40),
    left(p_message, 500),
    left(p_stack, 4000),
    left(p_path, 200),
    left(p_build, 40),
    left(p_user_agent, 300),
    auth.uid()
  );
  return jsonb_build_object('ok', true);
end;
$$;

revoke all on function report_client_error(text, text, text, text, text, text) from public;
grant execute on function report_client_error(text, text, text, text, text, text) to anon, authenticated;

create or replace function admin_client_errors(p_limit int default 200)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
begin
  if not is_platform_admin() then return not_admin(); end if;
  return coalesce((
    select jsonb_agg(to_jsonb(e) order by e.at desc)
    from (
      select id, at, surface, message, stack, path, build, user_agent
      from client_errors
      order by at desc
      limit greatest(1, least(coalesce(p_limit, 200), 500))
    ) e
  ), '[]'::jsonb);
end;
$$;

revoke all on function admin_client_errors(int) from public;
grant execute on function admin_client_errors(int) to authenticated;
