-- 2026-08-04 退回誤扣:國語測試(非學校考卷)第二批 10 份 × 15 點誤扣關埔國小錢包
-- 根因:舊 resolveBillingTarget 看「人」(exam_owner)不看「考卷」→ 已修(243a4e0)
-- 驗證:school_ink_ledger reason='grading_action' 且 metadata 含 1785806270475-1uflwr4gg 共 10 筆 × -15

update schools set ink_balance = ink_balance + 150 where id = 'sch_253f7fbae9724866';

insert into school_ink_ledger (school_id, delta, balance_after, reason, actor_profile_id, metadata)
values (
  'sch_253f7fbae9724866', 150,
  (select ink_balance from schools where id = 'sch_253f7fbae9724866'),
  'billing_correction', null,
  '{"note":"退回誤扣:國語測試非學校考卷(計費對象修正 243a4e0)","assignmentIds":["1785806270475-1uflwr4gg"]}'
);

-- 跑完驗證:應回到 29,379
-- select ink_balance from schools where id = 'sch_253f7fbae9724866';
