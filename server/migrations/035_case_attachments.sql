-- Вложения к тест-кейсам и чек-листам: скриншоты, макеты, файлы данных. step_index — вложение к шагу кейса
-- (картинка из текста шага при переносе из Test IT). Файлы — в том же хранилище, что вложения багов и результатов
ALTER TABLE attachments ADD COLUMN case_id INTEGER REFERENCES test_cases(id) ON DELETE CASCADE;
ALTER TABLE attachments DROP CONSTRAINT attachments_owner_check;
ALTER TABLE attachments ADD CONSTRAINT attachments_owner_check CHECK (num_nonnulls(bug_id, run_result_id, auto_result_id, case_id) = 1);
CREATE INDEX attachments_case_idx ON attachments(case_id) WHERE case_id IS NOT NULL;
