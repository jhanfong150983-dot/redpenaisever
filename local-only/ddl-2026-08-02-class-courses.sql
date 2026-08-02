-- Step 11 階段 1(2026-08-02):教師端唯讀學校考卷的權限來源
-- 資料由行政端「全校名冊同步」時,從 1Campus getCourse / getClass 抓下來。
--   getCourse(不帶參數)= 全校課程 → 班級 × 課程 × 授課教師(科任)
--   getClass (不帶參數)= 全校班級 → 班導師 / 副班導師
-- ⚠ 1Campus 官方:兩支只回「當前學年學期」、不支援查歷史 →
--   課程表帶 school_year/semester 且只 upsert 不刪舊,學期切換後上學期考卷的檢視權才不會斷。

-- 1) 班級 × 課程 × 授課教師(一門課多位老師 = 多列)
create table if not exists school_class_courses (
  id                bigserial primary key,
  school_id         text not null,
  campus_class_id   text not null,
  class_no          text,
  class_name        text,
  course_name       text not null,
  subject           text,
  campus_teacher_id text not null,
  teacher_acc       text,
  teacher_name      text,
  school_year       int,
  semester          int,
  updated_at        timestamptz not null default now(),
  constraint school_class_courses_uniq
    unique (school_id, campus_class_id, course_name, campus_teacher_id, school_year, semester)
);

-- 查「這門課涵蓋哪些班」(行政建考卷選課程時用)
create index if not exists idx_scc_school_course
  on school_class_courses (school_id, course_name);
-- 查「這位老師教哪些班的哪些課」(教師端唯讀判定用)
create index if not exists idx_scc_school_teacher_acc
  on school_class_courses (school_id, teacher_acc);
-- 查「這個班有哪些課」(涵蓋提示用)
create index if not exists idx_scc_school_class
  on school_class_courses (school_id, campus_class_id);

-- 2) 班級導師/副導師:併進既有的 school_classes(不另開表)
--    既有欄位 teacher_name 來自 getClassStudent、只有姓名無帳號,無法對應到我們的老師帳號,
--    因此另存 *_acc(1Campus teacherAcc = 老師 email,可對到 profiles/教師名冊)。
alter table school_classes add column if not exists homeroom_teacher_id    text;
alter table school_classes add column if not exists homeroom_teacher_acc   text;
alter table school_classes add column if not exists homeroom_teacher_name  text;
alter table school_classes add column if not exists secondary_teacher_id   text;
alter table school_classes add column if not exists secondary_teacher_acc  text;
alter table school_classes add column if not exists secondary_teacher_name text;

create index if not exists idx_school_classes_homeroom_acc
  on school_classes (school_id, homeroom_teacher_acc);

-- ── Step 11 階段 2(2026-08-02):考卷科目 ──
-- 科目 = 教師端唯讀的判定依據(對 school_class_courses.subject)。
-- 學年學期一併記:1Campus 課程 API 只回當前學期,跨學期查權限要用考卷當時的學期。
alter table school_exams add column if not exists subject     text;
alter table school_exams add column if not exists school_year int;
alter table school_exams add column if not exists semester    int;

create index if not exists idx_school_exams_subject
  on school_exams (school_id, subject);

-- ── 手動指派任課(2026-08-02、user:讓非 1Campus/自建班級也能用)──
-- 任課關係的資料來源:1campus=同步自 getCourse;admin=行政手動指派。
-- ⚠ 同步只碰 source='1campus' 的列(手動指派的 course_name 用純科目名、與 1Campus 的
--   「三年2班_國語文」不同,unique key 不會撞),行政指派不會被下次同步沖掉。
alter table school_class_courses
  add column if not exists source text not null default '1campus';

create index if not exists idx_scc_source
  on school_class_courses (school_id, source);
