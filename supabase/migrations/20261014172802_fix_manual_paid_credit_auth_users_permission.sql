
create or replace function public.record_ripple_manual_paid_credit(
 p_location_id text, p_amount_cents integer, p_payment_reference text, p_notes text, p_actor uuid
) returns table(ledger_id bigint, balance_cents integer)
language plpgsql security invoker set search_path = public
as $$
declare v_ledger_id bigint;
declare v_ref text;
begin
 v_ref := btrim(coalesce(p_payment_reference,''));
 if p_amount_cents is null or p_amount_cents < 100 or p_amount_cents > 500000 then
   raise exception 'Invalid credit amount' using errcode='22023';
 end if;
 if length(v_ref) < 6 or length(v_ref) > 200 then
   raise exception 'Valid payment transaction reference required' using errcode='22023';
 end if;
 -- Caller identity is independently authenticated and Super Admin-authorized
 -- by admin-operations before RPC invocation. The FK on recorded_by validates
 -- the user without requiring service_role to SELECT private auth.users.
 if p_actor is null then
   raise exception 'Authenticated admin required' using errcode='22023';
 end if;
 if not exists(select 1 from public.config where location_id=p_location_id) then
   raise exception 'Unknown Ripple location' using errcode='22023';
 end if;
 if exists(select 1 from public.ripple_manual_paid_credits where payment_reference_key=lower(v_ref)) then
   raise exception 'This payment has already been recorded' using errcode='23505';
 end if;
 insert into public.billing_ledger(location_id,kind,amount_cents,description,external_ref)
 values(p_location_id,'topup',p_amount_cents,
   left(coalesce(nullif(btrim(p_notes),''),'Manually reconciled card payment credit'),300),
   'manual-card:'||lower(v_ref))
 returning id into v_ledger_id;
 insert into public.ripple_manual_paid_credits(location_id,ledger_id,amount_cents,payment_reference,notes,recorded_by)
 values(p_location_id,v_ledger_id,p_amount_cents,v_ref,left(coalesce(p_notes,''),1000),p_actor);
 return query select v_ledger_id, public.location_balance_cents(p_location_id);
end $$;
revoke all on function public.record_ripple_manual_paid_credit(text,integer,text,text,uuid) from public,anon,authenticated;
grant execute on function public.record_ripple_manual_paid_credit(text,integer,text,text,uuid) to service_role;
