
grant usage on schema ember to service_role;

grant select on table
  ember.location,
  ember.settings,
  ember.person,
  ember.queue,
  ember.template,
  ember.suppression,
  ember.send_ledger,
  ember.platform_user,
  ember.location_user
to service_role;

grant update on table
  ember.settings,
  ember.person,
  ember.queue
to service_role;

grant insert, update on table ember.template to service_role;
grant insert on table ember.suppression to service_role;

grant usage, select on sequence ember.template_id_seq to service_role;
grant usage, select on sequence ember.suppression_id_seq to service_role;
;
