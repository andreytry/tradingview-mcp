-- Merge ONE run into gtx.bt_job.result without touching its siblings.
--
-- Written after a Python merge script treated a 404 from a non-existent RPC as "start
-- from an empty blob" and silently discarded the other strategy's entire run. A merge
-- must read and splice the live value in one statement, and must fail rather than
-- fall back to empty.
--
--   psql -v job=7 -v key=reversal -v run="$(cat run.json)" -f scripts/merge_bt_run.sql
-- or inline the same jsonb_set through any SQL client.
update gtx.bt_job
   set result = jsonb_set(
         coalesce(result, '{}'::jsonb),
         array['runs', :'key'],
         :'run'::jsonb,
         true)
 where id = :'job'
   and result ? 'runs';          -- refuse to run against a blob with no runs object
-- Verify: every run must still be present afterwards.
select r.key,
       r.value->>'timeframe' as tf,
       jsonb_array_length(coalesce(r.value->'trades','[]'::jsonb)) as trades,
       r.value->'kpi'->>'totalR' as total_r
from gtx.bt_job j, jsonb_each(j.result->'runs') r
where j.id = :'job';
