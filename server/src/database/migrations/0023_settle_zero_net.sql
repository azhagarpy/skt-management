-- +migrate Up
-- A payroll item whose net salary is zero (or negative) has nothing to pay, but
-- was left PENDING with no way to mark it paid. Settle the ones already
-- calculated, and bring each run's pending total back in line.

UPDATE payroll_items
   SET payment_status = 'PAID',
       pending_amount = 0
 WHERE net_salary <= 0
   AND paid_amount = 0
   AND (payment_status <> 'PAID' OR pending_amount <> 0);

UPDATE payroll_runs r
   SET total_pending = t.pending
  FROM (
    SELECT payroll_run_id, coalesce(sum(pending_amount), 0) AS pending
      FROM payroll_items
     GROUP BY payroll_run_id
  ) t
 WHERE t.payroll_run_id = r.id
   AND r.total_pending <> t.pending;

-- +migrate Down
-- Not reversible: which items were settled by this migration is not recorded.
SELECT 1;
