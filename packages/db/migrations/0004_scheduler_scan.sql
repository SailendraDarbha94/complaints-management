-- 0004_scheduler_scan.sql
--
-- The scheduler has the same chicken-and-egg problem as sign-in, and it bit harder.
--
-- The daily ticker begins by listing the councils to process: SELECT council_id, config
-- FROM council_config. That runs before any council scope exists -- choosing the scope is
-- the point of the query -- so app.council_id is NULL, the isolation policy matches
-- nothing, and the loop body never executes.
--
-- The job then reported {"status":"ok","escalated":0,"digestsSent":0} every single day.
-- Nothing escalated, no digest went out, and the "Reminders last ran 09:02 today" banner
-- stayed green throughout. A reminder engine that silently does nothing while claiming to
-- be healthy is the precise failure this product exists to prevent, so this is worth a
-- migration of its own rather than a wider policy.
--
-- The exception is deliberately the smallest one that works:
--   * council_config only. Not council, not any case table.
--   * SELECT only.
--   * Gated on a session variable the scheduler sets transaction-locally, so it cannot
--     survive into another request on a pooled connection.
--
-- council_config holds a council's id and its settings -- deadlines, calendar, notice
-- ladder. It holds no patient data, no party names and no case facts, which is why this
-- is the table the exception is cut into.

CREATE OR REPLACE FUNCTION public.scheduler_is_scanning() RETURNS boolean
LANGUAGE sql STABLE AS $$
  SELECT coalesce(current_setting('app.scheduler_scan', true), '') = 'on'
$$;

DROP POLICY IF EXISTS scheduler_scan_configs ON public.council_config;
CREATE POLICY scheduler_scan_configs ON public.council_config
  FOR SELECT
  USING (public.scheduler_is_scanning());

GRANT EXECUTE ON FUNCTION public.scheduler_is_scanning() TO app_rw;
