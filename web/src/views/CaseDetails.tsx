import { useState, type FormEvent } from "react";
import { emptyStep, isRef, useSharedSteps, FieldsEditor, FieldsView, missingRequired, StepsEditor, StepsView, stepsOf, TagInput, Tags, useFields, useProjectTags } from "../casekit";
import { api, paths } from "../api";
import { checklistItems } from "../checklist";
import { BUG_STATUSES, CASE_STATUSES, find, PRIORITIES } from "../labels";
import { go, href } from "../router";
import { folderPath } from "../selectors";
import { useCan, useData, useLoad, useStore } from "../store";
import type { CaseKind, CaseVersion, Result, TestCase } from "../types";
import { CaseRequirements } from "./Requirements";
import { SaveAsTemplate, TemplatePicker } from "./Templates";
import { WatchButton } from "./Notifications";
import { ParamsEditor, paramsBody, paramsForm, paramsOf, ParamsView } from "./Params";
import { ReviewBlock, statusOptions } from "./Review";
import { Confirm, Drawer, fmt, Pill, Prio, ResultPill, TextBlock, useNames, Who } from "../ui";
import { draftFromCase, type BugDraft } from "./Bugs";
import { Comments } from "./Comments";
import { Attachments, StepFiles } from "./Attachments";
import { FolderOptions } from "./Folders";

import type { CopyResult } from "./Cases";

export function CaseDrawer({ c, onClose, onEdit, onDelete, onBug }: { c: TestCase; onClose: () => void; onEdit: () => void; onDelete: () => void; onBug: (d: BugDraft) => void }) {
  const data = useData();
  const { write } = useStore();
  const canEdit = useCan("cases.edit");
  const canDelete = useCan("cases.delete");
  const canMark = useCan("runs.execute");
  const canBug = useCan("bugs.create");
  const { reload, toast } = useStore();
  const nameOf = useNames();
  const [resetting, setResetting] = useState(false);
  const p = c.pid;
  const items = checklistItems(c);
  // флажок переключается сразу, не дожидаясь сервера; каждый пункт сохраняется своим запросом,
  // поэтому быстрые клики по нескольким пунктам не теряются. При ошибке отметка вернётся как была
  const [pending, setPending] = useState<Record<string, boolean>>({});
  const isDone = (item: string) => pending[item] ?? Boolean(c.checked?.[item]);
  const done = items.filter(isDone).length;
  const check = async (item: string, value: boolean) => {
    setPending((s) => ({ ...s, [item]: value }));
    try {
      await api("POST", `${paths.testCase(p, c.num)}/check`, { item, done: value });
      await reload();
    } catch (e: any) {
      toast(e.message || "Не удалось сохранить отметку");
    } finally {
      setPending((s) => {
        const next = { ...s };
        delete next[item];
        return next;
      });
    }
  };
  // история по прогонам грузится отдельно: в данных проекта только последний результат кейса
  const historyLoad = useLoad<{ results: Result[] }>(paths.caseHistory(p, c.num));
  const history = historyLoad.value?.results || data.results.filter((r) => r.pid === p && r.caseNum === c.num);
  const bugs = data.bugs.filter((b) => b.pid === p && b.caseNum === c.num).sort((a, b) => b.num - a.num);
  const latest = history.find((r) => r.result !== "untested");
  const comments = data.comments.filter((x) => x.pid === p && x.caseNum === c.num);
  const run = (n: number) => data.runs.find((r) => r.pid === p && r.num === n);

  // копия рядом с оригиналом, сразу открывается — обычно её тут же правят
  const copy = async () => {
    let r: CopyResult | null = null;
    if (await write(async () => { r = await api<CopyResult>("POST", `${paths.cases(p)}/copy`, { nums: [c.num] }); })) {
      toast(`Создана копия ${r!.created[0].id}`);
      go("p", p, "cases", r!.created[0].num);
    }
  };
  const files = c.attachments || [];
  const newBug = () => {
    const failed = latest && (latest.result === "failed" || latest.result === "blocked") ? latest : undefined;
    onBug(draftFromCase(c, failed && run(failed.runNum), failed));
  };

  return (
    <Drawer
      label={c.kind === "checklist" ? "Чек-лист" : "Тест-кейс"}
      idTag={c.id}
      title={c.title}
      onClose={onClose}
      footer={
        (canEdit || canBug || canDelete) && (
          <>
            {canEdit && <button className="btn primary" onClick={onEdit}>Редактировать</button>}
            {canEdit && <button className="btn" onClick={copy}>Создать копию</button>}
            {canBug && <button className="btn" onClick={newBug}>Завести баг</button>}
            <div className="spacer" />
            {canDelete && <button className="btn danger" onClick={onDelete}>Удалить</button>}
          </>
        )
      }
    >
      {c.folder !== null && <div className="view-block"><span className="label">Папка</span><span>{folderPath(data, c.folder)}</span></div>}
      <CaseRequirements pid={p} caseNum={c.num} />
      <ReviewBlock c={c} />
      <div className="row2">
        <div className="view-block"><span className="label">Приоритет</span><Prio p={c.priority} /></div>
        <div className="view-block">
          <span className="label">Статус</span>
          <select className="input" aria-label="Статус кейса" value={c.status} disabled={!canEdit} onChange={(e) => { const status = e.target.value; write(() => api("PATCH", paths.testCase(p, c.num), { status }), `Статус: ${find(CASE_STATUSES, status as TestCase["status"]).label}`); }}>
            {statusOptions(c.status)}
          </select>
        </div>
      </div>
      {c.kind === "checklist" ? (
        <div className="view-block">
          <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
            <span className="label">Пункты · выполнено {done} из {items.length}</span>
            <div className="spacer" />
            {canMark && done > 0 && <button className="btn ghost sm" onClick={() => setResetting(true)}>Снять все отметки</button>}
          </div>
          <div className="done-list">
            {items.map((item) => {
              const mark = c.checked?.[item];
              return (
                <label key={item} className={isDone(item) ? "is-done" : undefined}
                  title={mark ? `Отметил ${nameOf(mark.by)} · ${fmt(new Date(mark.at).getTime())}` : undefined}>
                  <input type="checkbox" checked={isDone(item)} disabled={!canMark} onChange={(e) => check(item, e.target.checked)} />
                  <span className="item-text">{item}</span>
                </label>
              );
            })}
          </div>
          <span className="muted small">Отметки видны всем участникам. Чтобы проверить сборку и сохранить историю результатов, добавьте чек-лист в прогон.</span>
        </div>
      ) : (
        <>
          <TextBlock label="Предусловия" text={c.pre} empty="Не указаны" />
          <div className="view-block"><span className="label">Шаги</span><StepsView steps={stepsOf(c)} render={(_, i) => <StepFiles list={files.filter((a) => a.step === i)} />} /></div>
          {paramsOf(c) && (
            <div className="view-block">
              <span className="label">Параметры{c.dataset ? ` · набор «${c.dataset.name}»` : ""} · {paramsOf(c)!.rows.length} наб.</span>
              <ParamsView table={paramsOf(c)!} />
              <span className="muted small">В прогоне кейс проверяется по разу на каждый набор</span>
            </div>
          )}
          {/* пустой итоговый результат не показываем, если ожидаемое записано у шагов */}
          {(c.expected || !stepsOf(c).some((st) => st.expected)) && <TextBlock label="Итоговый ожидаемый результат" text={c.expected} empty="Не указан" />}
        </>
      )}
      {/* вложения кейса: загрузка кнопкой, перетаскиванием или Ctrl+V; файлы к шагам показаны под шагами */}
      {(canEdit || files.some((a) => a.step == null)) && (
        <Attachments list={files.filter((a) => a.step == null)} uploadUrl={canEdit ? `${paths.testCase(p, c.num)}/attachments` : undefined} paste={canEdit} label="Вложения" />
      )}
      {c.tags?.length > 0 && <div className="view-block"><span className="label">Теги</span><Tags tags={c.tags} /></div>}
      <FieldsView entity="case" values={c.fields} />

      <div className="view-block">
        <span className="label">История прогонов</span>
        {history.length ? (
          <div className="history">
            {history.map((r) => {
              const rn = run(r.runNum);
              return (
                <div key={r.id}>
                  <a className="chip" href={href("p", p, "runs", r.runNum)}>R{r.runNum}</a>
                  <span style={{ flex: 1, minWidth: 120 }}>{rn?.title}{rn?.build ? <span className="muted"> · {rn.build}</span> : null}</span>
                  <ResultPill r={r.result} sm />
                  <span className="muted">{fmt(r.executed)}</span>
                </div>
              );
            })}
          </div>
        ) : (
          <span className="muted small">Кейс ещё не входил ни в один прогон</span>
        )}
      </div>

      <div className="view-block">
        <span className="label">Связанные баги</span>
        {bugs.length ? (
          <div className="history">
            {bugs.map((b) => {
              const st = find(BUG_STATUSES, b.status);
              return (
                <div key={b.id}>
                  <a className="chip" href={href("p", p, "bugs", b.num)}>{b.id}</a>
                  <span style={{ flex: 1, minWidth: 120 }}>{b.title}</span>
                  <Pill tone={st.tone} label={st.label} sm />
                </div>
              );
            })}
          </div>
        ) : (
          <span className="muted small">Багов нет</span>
        )}
      </div>

      <div className="row2 small">
        <div className="view-block"><span className="label">Создал</span><Who login={c.createdBy} /><span className="muted">{fmt(c.created)}</span></div>
        <div className="view-block"><span className="label">Изменил</span><Who login={c.updatedBy} /><span className="muted">{fmt(c.updated)}</span></div>
      </div>
      <Versions c={c} />
      <div><WatchButton pid={p} kind="cases" num={c.num} /></div>
      <Comments list={comments} postUrl={`${paths.testCase(p, c.num)}/comments`} />
      {resetting && (
        <Confirm title="Снять все отметки?" text={`Все ${done} отмеченных пунктов станут невыполненными — у всех участников.`} action="Снять"
          onClose={() => setResetting(false)}
          onYes={async () => {
            setResetting(false);
            await write(() => api("POST", `${paths.testCase(p, c.num)}/check`, { reset: true }), "Отметки сняты");
          }} />
      )}
    </Drawer>
  );
}

export function CaseEditor({ pid, c, kind, folder, onClose }: { pid: string; c?: TestCase; kind: CaseKind; folder: number | null; onClose: () => void }) {
  const { write, toast } = useStore();
  // Черновик и его исходная ревизия должны относиться к одному снимку, даже при живых обновлениях.
  const [base] = useState(() => ({ baseVersion: c?.version, baseEditRevision: c?.editRevision }));
  // новый кейс по умолчанию попадает в папку, открытую в дереве
  const [f, setF] = useState({
    kind, title: c?.title || "", priority: c?.priority || "medium", status: c?.status || "draft",
    pre: c?.pre || "", steps: c?.steps || "", expected: c?.expected || "", folder: String((c ? c.folder : folder) ?? ""),
    stepList: c ? c.stepSource || stepsOf(c) : [emptyStep()], tags: c?.tags || [], fields: c?.fields || {},
  });
  const [prm, setPrm] = useState(() => paramsForm(c));
  const fieldDefs = useFields("case");
  const tagSuggestions = useProjectTags("cases");
  const sharedSteps = useSharedSteps(pid);
  const [err, setErr] = useState("");
  const set = (k: keyof typeof f) => (e: { target: { value: string } }) => setF({ ...f, [k]: e.target.value });
  const list = f.kind === "checklist";
  async function submit(e: FormEvent) {
    e.preventDefault();
    const origin = window.location.hash;
    if (!f.title.trim()) return setErr(list ? "Укажите название чек-листа" : "Укажите название тест-кейса");
    if (list && !f.steps.trim()) return setErr("Добавьте хотя бы один пункт");
    const missing = missingRequired(fieldDefs, f.fields);
    if (missing) return setErr(missing);
    // у тест-кейса шаги уходят структурой, у чек-листа — пункты текстом
    const { stepList, ...rest } = f;
    if (!list && prm.mode === "dataset" && !prm.dataset) return setErr("Выберите набор данных или отключите параметры");
    if (!list && prm.mode === "own" && (!prm.table.columns.length || !prm.table.rows.length)) return setErr("Параметры: добавьте хотя бы один параметр и один набор или выберите «Без параметров»");
    const body = { ...rest, ...(list ? {} : { stepList: stepList.filter((s) => isRef(s) || s.action.trim() || s.expected.trim()).map((s) => (isRef(s) ? { shared: s.shared } : s)) }), folder: f.folder ? Number(f.folder) : null,
      ...(list ? { params: null, dataset: null } : paramsBody(prm)) };
    if (c) {
      if (await write(() => api("PATCH", paths.testCase(pid, c.num), { ...body, ...base }), "Изменения сохранены")) {
        onClose();
        if (window.location.hash === origin) go("p", pid, "cases", c.num);
      }
      return;
    }
    let num = 0;
    if (await write(async () => { num = (await api<{ num: number }>("POST", paths.cases(pid), body)).num; })) {
      toast(`${list ? "Создан чек-лист" : "Создан"} ${pid}-${num}`);
      onClose();
      if (window.location.hash === origin) go("p", pid, "cases", num);
    }
  }

  return (
    <Drawer label={c ? "Редактирование" : list ? "Новый чек-лист" : "Новый тест-кейс"} idTag={c?.id}
      title={c ? "Редактирование" : list ? "Новый чек-лист" : "Новый тест-кейс"} onClose={onClose}
      footer={<>
        <button className="btn primary" type="submit" form="caseForm">{c ? "Сохранить" : "Создать"}</button>
        <button className="btn" type="button" onClick={onClose}>Отмена</button>
        <div className="spacer" />
        <SaveAsTemplate pid={pid} kind="case" data={{ priority: f.priority, status: f.status, pre: f.pre, expected: f.expected, tags: f.tags, fields: f.fields, ...(list ? { steps: f.steps } : { stepList: f.stepList.map((st) => (isRef(st) ? { shared: st.shared } : st)) }) }} />
      </>}>
      <form id="caseForm" onSubmit={submit} noValidate>
        <div className="field"><label htmlFor="c-title">Название *</label><input className="input" id="c-title" value={f.title} onChange={set("title")}
          placeholder={list ? "Например: Смоук перед релизом" : "Например: Вход с неверным паролем"} autoFocus /></div>
        {!c && <TemplatePicker pid={pid} kind="case" form={f} setForm={setF} defaults={{ priority: "medium", status: "draft" }} />}
        <div className="row2">
          <div className="field"><label htmlFor="c-kind">Вид</label>
            <select className="input" id="c-kind" value={f.kind} onChange={set("kind")}>
              <option value="case">Тест-кейс</option>
              <option value="checklist">Чек-лист</option>
            </select></div>
          <div className="field"><label htmlFor="c-folder">Папка</label>
            <select className="input" id="c-folder" value={f.folder} onChange={set("folder")}><FolderOptions pid={pid} /></select></div>
        </div>
        <div className="row2">
          <div className="field"><label htmlFor="c-prio">Приоритет</label>
            <select className="input" id="c-prio" value={f.priority} onChange={set("priority")}>{PRIORITIES.map((x) => <option key={x.key} value={x.key}>{x.label}</option>)}</select></div>
          <div className="field"><label htmlFor="c-status">Статус</label>
            <select className="input" id="c-status" value={f.status} onChange={set("status")}>{statusOptions(f.status as TestCase["status"])}</select></div>
        </div>
        {list ? (
          <div className="field"><label htmlFor="c-steps">Пункты</label>
            <textarea className="input" id="c-steps" rows={10} placeholder={"Каждый пункт с новой строки, например:\nГлавная страница открывается\nВход и выход работают"} value={f.steps} onChange={set("steps")} />
            <span className="muted" style={{ fontSize: 12 }}>В прогоне каждый пункт отмечается отдельно, итог чек-листа считается сам</span></div>
        ) : (
          <>
            <div className="field"><label htmlFor="c-pre">Предусловия</label><textarea className="input" id="c-pre" rows={2} value={f.pre} onChange={set("pre")} /></div>
            <div className="field"><span className="label-like">Шаги</span>
              <StepsEditor value={f.stepList} onChange={(stepList) => setF({ ...f, stepList })} shared={sharedSteps} />
              <span className="muted" style={{ fontSize: 12 }}>Enter в последнем шаге добавляет следующий. В прогоне каждый шаг отмечается отдельно</span></div>
            <div className="field"><label htmlFor="c-exp">Итоговый ожидаемый результат</label><textarea className="input" id="c-exp" rows={2} value={f.expected} onChange={set("expected")} /></div>
            <ParamsEditor pid={pid} value={prm} onChange={setPrm} />
          </>
        )}
        <div className="field"><label htmlFor="c-tags">Теги</label><TagInput id="c-tags" value={f.tags} onChange={(tags) => setF({ ...f, tags })} suggestions={tagSuggestions} /></div>
        <FieldsEditor entity="case" values={f.fields} onChange={(fields) => setF({ ...f, fields })} />
        <div className="err">{err}</div>
      </form>
    </Drawer>
  );
}

// История версий: что менялось и кем; любую прежнюю версию можно вернуть (создастся новая версия)
const FIELDS: [keyof CaseVersion, string][] = [["title", "Название"], ["priority", "Приоритет"], ["status", "Статус"], ["pre", "Предусловия"], ["steps", "Шаги"], ["expected", "Ожидаемый результат"]];
function Versions({ c }: { c: TestCase }) {
  const canEdit = useCan("cases.edit");
  const { write } = useStore();
  const [open, setOpen] = useState(false);
  const [shown, setShown] = useState<number | null>(null);
  const { value } = useLoad<{ versions: CaseVersion[] }>(open ? paths.versions(c.pid, c.num) : null);
  const list = value?.versions || [];
  const label = (k: keyof CaseVersion, v: string) =>
    k === "priority" ? find(PRIORITIES, v as TestCase["priority"]).label : k === "status" ? find(CASE_STATUSES, v as TestCase["status"]).label : v;
  return (
    <div className="view-block">
      <span className="label">Версии · текущая v{c.version}</span>
      {!open ? (
        <button className="btn sm" style={{ alignSelf: "flex-start" }} onClick={() => setOpen(true)} disabled={c.version < 2}>
          {c.version < 2 ? "Кейс ещё не менялся" : "Показать историю изменений"}
        </button>
      ) : !value ? <span className="muted small">Загружаем…</span> : (
        <div className="history">
          {list.map((v, i) => {
            const prev = list[i + 1];
            const changed = prev ? FIELDS.filter(([k]) => v[k] !== prev[k]) : [];
            return (
              <div key={v.version} style={{ flexDirection: "column", alignItems: "stretch", gap: 4 }}>
                <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
                  <span className="chip">v{v.version}</span>
                  <Who login={v.changedBy} /><span className="muted small">{fmt(v.changed)}</span>
                  <span className="muted small" style={{ flex: 1 }}>{prev ? `изменено: ${changed.map(([, l]) => l.toLowerCase()).join(", ") || "—"}` : "создан"}</span>
                  {prev && <button className="btn ghost sm" onClick={() => setShown(shown === v.version ? null : v.version)}>{shown === v.version ? "Скрыть" : "Что изменилось"}</button>}
                  {canEdit && v.version !== c.version && (
                    <button className="btn sm" onClick={() => write(() => api("POST", `${paths.versions(c.pid, c.num)}/${v.version}/restore`, {}), `Восстановлена v${v.version}`)}>Вернуть</button>
                  )}
                </div>
                {shown === v.version && prev && changed.map(([k, l]) => (
                  <div key={k} className="small" style={{ display: "grid", gap: 2 }}>
                    <span className="label">{l}</span>
                    <pre className="code diff-old">{label(k, String(prev[k])) || "—"}</pre>
                    <pre className="code diff-new">{label(k, String(v[k])) || "—"}</pre>
                  </div>
                ))}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

// Массовое изменение выбранных кейсов: каждый изменённый кейс получает новую версию
