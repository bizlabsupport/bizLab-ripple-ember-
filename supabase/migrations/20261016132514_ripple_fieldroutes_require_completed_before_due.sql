create or replace view public.send_queue_due as
 WITH day_totals AS (
         SELECT q_1.location_id,
            date_trunc('day'::text, q_1.review_deadline) AS day,
            sum(COALESCE(q_1.approved_cards, q_1.proposed_cards)) OVER (PARTITION BY q_1.location_id, (date_trunc('day'::text, q_1.review_deadline)) ORDER BY q_1.id ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW) AS running_cards,
            q_1.id
           FROM send_queue q_1
          WHERE q_1.status = ANY (ARRAY['pending'::text, 'approved'::text])
        )
 SELECT q.id,
    q.location_id,
    q.job_id,
    q.batch_id,
    q.neighborhood,
    q.service_address,
    q.completed_at,
    q.proposed_cards,
    q.approved_cards,
    q.status,
    q.review_deadline,
    q.notify_at,
    q.decided_at,
    q.decided_by,
    q.sent_at,
    q.skip_reason,
    q.created_at,
    c.auto_approve_sends,
    c.daily_card_cap,
    d.running_cards,
    q.status = 'approved'::text AS explicitly_approved,
    q.status = 'pending'::text AND c.auto_approve_sends AND d.running_cards <= c.daily_card_cap AS auto_approved
   FROM send_queue q
     JOIN jobs j ON j.id = q.job_id
     JOIN config c ON c.location_id = q.location_id
     JOIN day_totals d ON d.id = q.id
  WHERE q.review_deadline <= now() AND (q.status = ANY (ARRAY['pending'::text, 'approved'::text])) AND COALESCE(q.approved_cards, q.proposed_cards) > 0 AND caller_can_see_location(q.location_id) AND (j.ghl_job_id NOT LIKE 'fr:appt:%' OR (j.completed_at IS NOT NULL AND q.completed_at IS NOT NULL));
