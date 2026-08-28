-- 전체 예약 공통 시간대 제한
-- 관리자는 단일 날짜를 등록하고, start_date/end_date는 기존 기간성 코드 제한 이관에 사용한다.

create table if not exists public.global_blocked_time_ranges (
  id uuid primary key default gen_random_uuid(),
  start_date date not null,
  end_date date not null,
  start_time time without time zone not null,
  end_time time without time zone not null,
  reason text null,
  created_at timestamptz not null default now(),
  constraint global_blocked_time_ranges_date_order_chk
    check (start_date <= end_date),
  constraint global_blocked_time_ranges_time_order_chk
    check (start_time < end_time),
  constraint global_blocked_time_ranges_booking_hours_chk
    check (start_time >= time '09:00' and end_time <= time '16:00'),
  constraint global_blocked_time_ranges_half_hour_chk
    check (
      extract(second from start_time) = 0
      and extract(second from end_time) = 0
      and extract(minute from start_time) in (0, 30)
      and extract(minute from end_time) in (0, 30)
    ),
  constraint global_blocked_time_ranges_uniq
    unique (start_date, end_date, start_time, end_time)
);

comment on table public.global_blocked_time_ranges is
  '관리자가 지정한 전체 예약 공통 환입 불가 시간대';
comment on column public.global_blocked_time_ranges.start_date is
  '시간대 제한 시작일(포함)';
comment on column public.global_blocked_time_ranges.end_date is
  '시간대 제한 종료일(포함)';

create index if not exists global_blocked_time_ranges_date_idx
  on public.global_blocked_time_ranges (start_date, end_date);

alter table public.global_blocked_time_ranges enable row level security;

revoke all on table public.global_blocked_time_ranges from anon, authenticated;
grant select on table public.global_blocked_time_ranges to anon, authenticated;
grant select, insert, update, delete on table public.global_blocked_time_ranges to service_role;

drop policy if exists "global_blocked_time_ranges_select_anon"
  on public.global_blocked_time_ranges;
create policy "global_blocked_time_ranges_select_anon"
  on public.global_blocked_time_ranges for select to anon using (true);

drop policy if exists "global_blocked_time_ranges_select_authenticated"
  on public.global_blocked_time_ranges;
create policy "global_blocked_time_ranges_select_authenticated"
  on public.global_blocked_time_ranges for select to authenticated using (true);

-- Edge Function 외 경로의 INSERT/UPDATE도 최종 차단한다.
create or replace function public.enforce_reservation_not_blocked_time_range()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  booking_start timestamp without time zone;
  booking_end timestamp without time zone;
  duration_minutes integer;
begin
  if new.reservation_date is null or new.reservation_time is null then
    return new;
  end if;

  if new.reservation_time !~ '^([01][0-9]|2[0-3]):[0-5][0-9]$' then
    return new;
  end if;

  duration_minutes := case
    when coalesce(new.reservation_duration_minutes, 30) = 60 then 60
    else 30
  end;
  booking_start := new.reservation_date::date + new.reservation_time::time;
  booking_end := booking_start + make_interval(mins => duration_minutes);

  if exists (
    select 1
    from public.global_blocked_time_ranges b
    where new.reservation_date::date between b.start_date and b.end_date
      and booking_start < (new.reservation_date::date + b.end_time)
      and booking_end > (new.reservation_date::date + b.start_time)
  ) then
    raise exception '선택한 시간은 관리자가 지정한 환입 제한 시간대입니다.'
      using errcode = '23514';
  end if;

  return new;
end;
$$;

revoke all on function public.enforce_reservation_not_blocked_time_range() from public;
grant execute on function public.enforce_reservation_not_blocked_time_range() to anon, authenticated, service_role;

drop trigger if exists reservations_enforce_not_blocked_time_range
  on public.reservations;
create trigger reservations_enforce_not_blocked_time_range
  before insert or update of reservation_date, reservation_time, reservation_duration_minutes
  on public.reservations
  for each row
  execute function public.enforce_reservation_not_blocked_time_range();

-- 기존 코드 하드코딩을 DB 설정으로 이관한다.
insert into public.global_blocked_time_ranges
  (start_date, end_date, start_time, end_time, reason)
values
  (date '2026-08-03', date '2026-09-03', time '11:30', time '12:00', '기존 코드 이관: 11:30 예약 제한'),
  (date '2026-08-03', date '2026-09-03', time '15:30', time '16:00', '기존 코드 이관: 15:30 예약 제한'),
  (date '2026-08-21', date '2026-08-21', time '15:00', time '15:30', '기존 코드 이관: 15:00 예약 제한'),
  (date '2026-08-28', date '2026-08-28', time '15:00', time '15:30', '기존 코드 이관: 15:00 예약 제한'),
  (date '2026-09-04', date '2026-09-04', time '15:00', time '15:30', '기존 코드 이관: 15:00 예약 제한'),
  (date '2026-08-14', date '2026-08-14', time '14:00', time '16:00', '기존 코드 이관: 오후 예약 제한')
on conflict (start_date, end_date, start_time, end_time) do nothing;
