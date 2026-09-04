-- 0031_send_queue_notified_at.sql
--
-- The notifier has no way to know it already fired, so a cron re-selects the
-- same row every cycle and nags the owner hourly. A column rather than a
-- status: notification is orthogonal to the lifecycle - a row can be notified
-- and still pending, and a row can be decided without ever being notified.

alter table send_queue
  add column if not exists notified_at timestamptz;

comment on column send_queue.notified_at is
  'When the owner was told this batch is waiting. Null means never told. Not a lifecycle state - a notified row is still pending until it is decided.';

-- The notifier's working set: due to be told, not yet told, still undecided.
create index if not exists send_queue_to_notify_idx
  on send_queue (notify_at)
  where notified_at is null and status = 'pending';;
