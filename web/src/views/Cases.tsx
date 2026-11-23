import { useState, type FormEvent } from "react";
import { TagInput, Tags, useFields, useProjectTags } from "../casekit";
import { api, paths } from "../api";
import { checklistItems, doneCount, itemsWord } from "../checklist";
import { CASE_STATUSES, find, isOpenBug, PRIORITIES, RESULTS } from "../labels";
import { go, href } from "../router";
import { countBy, folderPath, lastResults } from "../selectors";
import { useCan, useData, useStore } from "../store";
import type { CaseKind, Project, ResultValue, TestCase } from "../types";
import { SharedStepsModal } from "./SharedSteps";
import { DatasetsModal } from "./Params";
import { useMyReviews } from "./Review";
import { CommentCount, Confirm, Empty, fmt, FullCase, Modal, PagedRows, Pill, Prio, ResultPill } from "../ui";
import { BugEditor, type BugDraft } from "./Bugs";
import { ImportModal } from "./CaseImport";
import { FolderOptions, FolderTree, inFolder, type FolderSel } from "./Folders";

import { CaseDrawer, CaseEditor } from "./CaseDetails";

type ResultFilter = "all" | ResultValue;

export function CasesTab({ project, openNum }: { project: Project; openNum?: number }) {
  const data = useData();
  const p = project.id;
  const [q, setQ] = useState("");
  const [fResult, setFResult] = useState<ResultFilter>("all");
  const [fPrio, setFPrio] = useState("all");
  const [fTag, setFTag] = useState("");
  // фильтры по полям-спискам: {id поля: значение}
  const [fFields, setFFields] = useState<Record<number, string>>({});
  const projectTags = useProjectTags("cases");
  const listFields = useFields("case").filter((d) => d.type === "select" || d.type === "multiselect" || d.type === "user");
  const fieldMatch = (c: TestCase) =>
    Object.entries(fFields).every(([id, want]) => {
      const v = c.fields?.[id];
      return !want || (Array.isArray(v) ? v.includes(want) : String(v ?? "") === want);
    });
  const [fStatus, setFStatus] = useState("active");
  // новый тест-кейс или чек-лист — по виду, существующий — сам кейс
  const [editing, setEditing] = useState<TestCase | CaseKind | null>(null);
  const [deleting, setDeleting] = useState<TestCase | null>(null);
  const [bugDraft, setBugDraft] = useState<BugDraft | null>(null);
  const [folderSel, setFolderSel] = useState<FolderSel>("all");
  const [picked, setPicked] = useState<Set<number>>(new Set());
  const [moveTo, setMoveTo] = useState("");
  const [bulk, setBulk] = useState<"edit" | "delete" | "copy" | null>(null);
  const [view, setView] = useCaseView();
  const [colsOpen, setColsOpen] = useState(false);
  const on = (k: ColKey) => view.cols.includes(k);
  const compactTags = view.density === "compact" && on("tags");
  const [sharedOpen, setSharedOpen] = useState(false);
  const [dataOpen, setDataOpen] = useState(false);
  const [importing, setImporting] = useState(false);
  const { write, toast } = useStore();
  const canEdit = useCan("cases.edit");
  const canDelete = useCan("cases.delete");
  const myReviews = useMyReviews(p);
  // выбранную папку могли удалить в другой вкладке или другие участники
  const sel: FolderSel = typeof folderSel === "number" && !data.folders.some((f) => f.id === folderSel) ? "all" : folderSel;

  const all = data.cases.filter((c) => c.pid === p);
  const last = lastResults(data, p);
  const resultOf = (c: TestCase): ResultValue => last.get(c.num)?.result || "untested";
  const talk = countBy(data.comments.filter((x) => x.pid === p), (x) => x.caseNum);
  // открытые баги по кейсам: один проход по багам вместо фильтра на каждую строку таблицы
  const bugsByCase = new Map<number, typeof data.bugs>();
  for (const b of data.bugs) if (b.pid === p && b.caseNum !== null && isOpenBug(b.status)) bugsByCase.set(b.caseNum, [...(bugsByCase.get(b.caseNum) || []), b]);
  const openBugs = (c: TestCase) => bugsByCase.get(c.num) || [];
  const scoped = all.filter((c) => (fStatus === "all" || (fStatus === "active" ? c.status !== "deprecated" : fStatus === "my-review" ? Boolean(myReviews?.has(c.num)) : c.status === fStatus)) && (fPrio === "all" || c.priority === fPrio)
    && (!fTag || c.tags?.includes(fTag)) && fieldMatch(c));
  const base = scoped.filter(inFolder(data, sel));
  const needle = q.trim().toLowerCase();
  const rows = base
    .filter((c) => (fResult === "all" || resultOf(c) === fResult) && (!needle || c.title.toLowerCase().includes(needle) || c.id.toLowerCase().includes(needle)))
    .sort((a, b) => a.num - b.num);
  const viewing = openNum !== undefined ? all.find((c) => c.num === openNum) : undefined;
  const close = () => go("p", p, "cases");
  // отмеченные для перемещения — только среди видимых сейчас строк
  const shown = rows.filter((c) => picked.has(c.num));
  const togglePick = (n: number) => {
    const s = new Set(picked);
    s.has(n) ? s.delete(n) : s.add(n);
    setPicked(s);
  };
  const move = async () => {
    const folder = moveTo ? Number(moveTo) : null;
    let moved = 0;
    if (await write(async () => { moved = (await api<{ moved: number }>("POST", paths.moveCases(p), { nums: shown.map((c) => c.num), folder })).moved; })) {
      toast(moved ? `Перемещено кейсов: ${moved}` : "Кейсы уже лежат в этой папке");
      setPicked(new Set());
    }
  };

  const chip = (k: ResultFilter, label: string) => (
    <button key={k} className="stat" aria-pressed={fResult === k} onClick={() => setFResult(k)}>
      {k !== "all" && <span className={`pill t-${find(RESULTS, k).tone}`} style={{ padding: "2px 4px" }}><span className="dot" /></span>}
      <span>{label}</span>
      <span className="n">{k === "all" ? base.length : base.filter((c) => resultOf(c) === k).length}</span>
    </button>
  );

  return (
    <>
      <div className="head">
        <p className="muted small" style={{ margin: 0 }}>Результат — последний из прогонов. Чтобы проверить кейсы на новой сборке, создайте прогон.</p>
        <div className="spacer" />
        {/* выгружается то, что выбрано в дереве папок: весь проект, кейсы без папки или папка с подпапками */}
        {all.length > 0 && (
          <a className="btn" href={`${paths.casesExport(p)}?folder=${sel}`} style={{ textDecoration: "none" }}
            title={sel === "all" ? "Все кейсы проекта в CSV" : "Кейсы выбранной папки в CSV"}>Экспорт</a>
        )}
        <button className="btn" onClick={() => setSharedOpen(true)} title="Блоки шагов, которые повторяются в разных кейсах">Общие шаги</button>
        <button className="btn" onClick={() => setDataOpen(true)} title="Таблицы значений для кейсов с параметрами">Наборы данных</button>
        {canEdit && <button className="btn" onClick={() => setImporting(true)}>Импорт</button>}
        {canEdit && <button className="btn primary" onClick={() => setEditing("case")}>+ Тест-кейс</button>}
      </div>
      {sharedOpen && <SharedStepsModal pid={p} onClose={() => setSharedOpen(false)} />}
      {dataOpen && <DatasetsModal pid={p} onClose={() => setDataOpen(false)} />}
      {bulk === "copy" && <CopyModal pid={p} nums={shown.map((c) => c.num)} onClose={(done) => { setBulk(null); if (done) setPicked(new Set()); }} />}
      {bulk === "edit" && <BulkEditModal pid={p} nums={shown.map((c) => c.num)} tags={projectTags} onClose={(done) => { setBulk(null); if (done) setPicked(new Set()); }} />}
      {bulk === "delete" && (
        <Confirm
          title={`Удалить кейсы (${shown.length})?`}
          text="Кейсы уйдут в корзину проекта вместе с версиями, результатами и комментариями — их можно восстановить в течение 30 дней. Кейсы из заблокированных тест-планов останутся."
          action="Удалить"
          onClose={() => setBulk(null)}
          onYes={async () => {
            setBulk(null);
            let r = { deleted: 0, locked: [] as number[] };
            if (await write(async () => { r = await api("POST", `${paths.cases(p)}/bulk-delete`, { nums: shown.map((c) => c.num) }); })) {
              toast(`Удалено в корзину: ${r.deleted}${r.locked.length ? `, в заблокированных планах (остались): ${r.locked.length}` : ""}`);
              setPicked(new Set());
            }
          }}
        />
      )}
      {importing && <ImportModal pid={p} onClose={() => setImporting(false)} />}
      <div className="cases-layout">
      {(all.length > 0 || data.folders.some((f) => f.pid === p)) && <FolderTree pid={p} cases={scoped} sel={sel} onSelect={(s) => { setFolderSel(s); setPicked(new Set()); }} />}
      <div className="cases-main">
      <div className="stats">
        {chip("all", "Все")}
        {RESULTS.map((r) => chip(r.key, r.key === "untested" ? "Не запускался" : r.label))}
      </div>
      <div className="toolbar">
        <input className="input" type="search" placeholder="Поиск по названию или ID" value={q} onChange={(e) => setQ(e.target.value)} />
        <select className="input" aria-label="Приоритет" value={fPrio} onChange={(e) => setFPrio(e.target.value)}>
          <option value="all">Любой приоритет</option>
          {PRIORITIES.map((x) => <option key={x.key} value={x.key}>{x.label}</option>)}
        </select>
        <select className="input" aria-label="Статус" value={fStatus} onChange={(e) => setFStatus(e.target.value)}>
          <option value="active">Кроме устаревших</option>
          <option value="all">Любой статус</option>
          {CASE_STATUSES.map((x) => <option key={x.key} value={x.key}>{x.label}</option>)}
          {myReviews && <option value="my-review">Мне на ревью{myReviews.size ? ` (${myReviews.size})` : ""}</option>}
        </select>
        {projectTags.length > 0 && (
          <select className="input" aria-label="Тег" value={fTag} onChange={(e) => setFTag(e.target.value)}>
            <option value="">Любой тег</option>
            {projectTags.map((t) => <option key={t} value={t}>{t}</option>)}
          </select>
        )}
        {listFields.map((d) => (
          <select key={d.id} className="input" aria-label={d.name} value={fFields[d.id] || ""} onChange={(e) => setFFields({ ...fFields, [d.id]: e.target.value })}>
            <option value="">{d.name}: любое</option>
            {(d.type === "user" ? Object.keys(data.users) : d.options).map((o) => <option key={o} value={o}>{o}</option>)}
          </select>
        ))}
      </div>
      <div className="view-bar">
        <div className="seg" role="group" aria-label="Плотность списка">
          <button aria-pressed={view.density === "compact"} onClick={() => setView({ ...view, density: "compact" })}>Компактно</button>
          <button aria-pressed={view.density === "comfortable"} onClick={() => setView({ ...view, density: "comfortable" })}>Подробно</button>
        </div>
        <div className="cols-pick">
          <button className="btn sm" aria-expanded={colsOpen} onClick={() => setColsOpen(!colsOpen)}>Колонки ▾</button>
          {colsOpen && (
            <div className="cols-menu" role="group" aria-label="Колонки списка" onMouseLeave={() => setColsOpen(false)}>
              {COLS.map(([k, label]) => (
                <label key={k}><input type="checkbox" checked={on(k)} onChange={() => setView({ ...view, cols: on(k) ? view.cols.filter((x) => x !== k) : [...view.cols, k] })} /> {label}</label>
              ))}
            </div>
          )}
        </div>
      </div>
      {canEdit && shown.length > 0 && (
        <div className="bulk">
          <b>Выбрано: {shown.length}</b>
          <span className="muted">Переместить в</span>
          <select className="input" aria-label="Папка назначения" value={moveTo} onChange={(e) => setMoveTo(e.target.value)}>
            <FolderOptions pid={p} rootLabel="— корень проекта (без папки) —" />
          </select>
          <button className="btn primary sm" onClick={move}>Переместить</button>
          <button className="btn sm" onClick={() => setBulk("copy")}>Копировать…</button>
          <button className="btn sm" onClick={() => setBulk("edit")}>Изменить…</button>
          {canDelete && <button className="btn sm danger" onClick={() => setBulk("delete")}>Удалить</button>}
          <button className="btn sm" onClick={() => setPicked(new Set())}>Снять выделение</button>
        </div>
      )}
      {all.length === 0 ? (
        <Empty title="В проекте нет тест-кейсов">
          {canEdit ? "Добавьте первый: тест-кейс с шагами и ожидаемым результатом или чек-лист — список коротких проверок." : "Здесь появятся тест-кейсы, которые заведут тестировщики."}
          {canEdit && (
            <div style={{ display: "flex", gap: 8 }}>
              <button className="btn primary" onClick={() => setEditing("case")}>+ Тест-кейс</button>
              <button className="btn" onClick={() => setEditing("checklist")}>+ Чек-лист</button>
            </div>
          )}
        </Empty>
      ) : (
        // два блока с одними и теми же папками и фильтрами: тест-кейсы, под ними — чек-листы
        (["case", "checklist"] as const).map((kind) => {
          const list = rows.filter((c) => c.kind === kind);
          const inScope = base.filter((c) => c.kind === kind).length;
          const anyInProject = all.some((c) => c.kind === kind);
          const pickedHere = list.filter((c) => picked.has(c.num)).length;
          const allHere = list.length > 0 && pickedHere === list.length;
          const pickAll = () => {
            const s = new Set(picked);
            for (const c of list) {
              if (allHere) s.delete(c.num);
              else s.add(c.num);
            }
            setPicked(s);
          };
          const isList = kind === "checklist";
          return (
            <section key={kind} className="case-block" aria-label={isList ? "Чек-листы" : "Тест-кейсы"}>
              <div className="block-head">
                <h2>{isList ? "Чек-листы" : "Тест-кейсы"}<span className="n">{list.length}</span></h2>
                {isList && <span className="muted small">короткие списки проверок: смоук, регресс, приёмка</span>}
                <div className="spacer" />
                {canEdit && isList && <button className="btn sm" onClick={() => setEditing("checklist")}>+ Чек-лист</button>}
              </div>
              {!anyInProject ? (
                <div className="nores block-empty">
                  {isList
                    ? <>Чек-листов пока нет. Это список коротких проверок без подробных шагов — в прогоне каждый пункт отмечается отдельно.</>
                    : <>Тест-кейсов пока нет.</>}
                </div>
              ) : (
                <div className="tbl-wrap">
                  <table className={view.density === "compact" ? "compact" : undefined}>
                    <thead>
                      <tr>
                        {canEdit && <th style={{ width: 36 }}><input type="checkbox" aria-label={isList ? "Отметить все чек-листы" : "Отметить все тест-кейсы"} checked={allHere}
                          ref={(el) => { if (el) el.indeterminate = pickedHere > 0 && !allHere; }} onChange={pickAll} /></th>}
                        <th style={{ width: 90 }}>ID</th><th>Название</th>
                        {compactTags && <th style={{ width: 150 }}>Теги</th>}
                        {on("folder") && <th style={{ width: 180 }}>Папка</th>}
                        {on("priority") && <th style={{ width: 120 }}>Приоритет</th>}
                        {on("status") && <th style={{ width: 110 }}>Статус</th>}
                        {on("result") && <th style={{ width: 140 }}>Результат</th>}
                        {on("bugs") && <th style={{ width: 80 }}>Баги</th>}
                        {on("updated") && <th style={{ width: 120 }}>Обновлён</th>}
                        <th style={{ width: 72 }} />
                      </tr>
                    </thead>
                    <tbody>
                      <PagedRows items={list} reset={`${kind}|${sel}|${needle}|${fResult}|${fPrio}|${fStatus}|${fTag}|${JSON.stringify(fFields)}`}>{(c) => {
                        const lr = last.get(c.num);
                        const bugs = openBugs(c);
                        const st = find(CASE_STATUSES, c.status);
                        const n = checklistItems(c).length;
                        const done = doneCount(c);
                        return (
                          <tr key={c.id} className="click" aria-selected={viewing?.num === c.num} onClick={() => go("p", p, "cases", c.num)}>
                            {canEdit && <td onClick={(e) => e.stopPropagation()}><input type="checkbox" aria-label={`Отметить ${c.id}`} checked={picked.has(c.num)} onChange={() => togglePick(c.num)} /></td>}
                            <td className="id">{c.id}</td>
                            <td className="title" title={view.density === "compact" ? c.title : undefined}>
                              {c.title}<CommentCount n={talk.get(c.num)} />{on("tags") && view.density !== "compact" && <> <Tags tags={c.tags} /></>}
                              {isList && (
                                <span className="muted small" style={{ fontWeight: 400 }}>
                                  {" · "}{done ? `выполнено ${done} из ${n}` : `${n} ${itemsWord(n)}`}
                                </span>
                              )}
                              {!on("folder") && view.density !== "compact" && sel === "all" && c.folder !== null && <div className="muted small">{folderPath(data, c.folder)}</div>}
                            </td>
                            {compactTags && <td className="path tagcell" title={c.tags?.join(", ")}><Tags tags={c.tags} /></td>}
                            {on("folder") && <td className="muted small path" title={c.folder !== null ? folderPath(data, c.folder) : undefined}>{c.folder !== null ? folderPath(data, c.folder) : "—"}</td>}
                            {on("priority") && <td><Prio p={c.priority} /></td>}
                            {on("status") && <td><Pill tone={st.tone} label={st.label} sm /></td>}
                            {on("result") && <td className="nowrap">{lr ? <><ResultPill r={lr.result} /> <span className="muted small mono">R{lr.runNum}</span></> : <span className="muted small">Не запускался</span>}</td>}
                            {on("bugs") && (
                              <td onClick={(e) => e.stopPropagation()}>
                                <div className="chips">{bugs.map((b) => <a key={b.id} className="chip" href={href("p", p, "bugs", b.num)} title={b.title}>B{b.num}</a>)}</div>
                              </td>
                            )}
                            {on("updated") && <td className="muted small nowrap">{fmt(c.updated)}</td>}
                            <td className="actions" onClick={(e) => e.stopPropagation()}>
                              {canEdit && <button className="btn ghost" onClick={() => setEditing(c)} aria-label="Редактировать">✎</button>}
                              {canDelete && <button className="btn ghost" onClick={() => setDeleting(c)} aria-label="Удалить" style={{ color: "var(--crit)" }}>✕</button>}
                            </td>
                          </tr>
                        );
                      }}</PagedRows>
                      {!list.length && (
                        <tr><td colSpan={(canEdit ? 4 : 3) + view.cols.filter((k) => k !== "tags").length + (compactTags ? 1 : 0)} className="nores">
                          {sel !== "all" && !inScope ? `В этой папке нет ${isList ? "чек-листов" : "тест-кейсов"}.` : "Ничего не найдено. Сбросьте фильтры или измените запрос."}
                        </td></tr>
                      )}
                    </tbody>
                  </table>
                </div>
              )}
            </section>
          );
        })
      )}
      </div>
      </div>

      {bugDraft ? (
        <BugEditor pid={p} draft={bugDraft} onClose={() => setBugDraft(null)} />
      ) : editing ? (
        typeof editing === "string" ? (
          <CaseEditor pid={p} kind={editing} folder={typeof sel === "number" ? sel : null} onClose={() => setEditing(null)} />
        ) : (
          // редактор открывается только с полным текстом кейса: иначе сохранение затёрло бы шаги пустыми
          <FullCase c={editing}>{(full) => <CaseEditor pid={p} c={full} kind={full.kind} folder={null} onClose={() => setEditing(null)} />}</FullCase>
        )
      ) : viewing ? (
        <FullCase c={viewing}>{(full) => <CaseDrawer c={full} onClose={close} onEdit={() => setEditing(full)} onDelete={() => setDeleting(viewing)} onBug={setBugDraft} />}</FullCase>
      ) : null}
      {deleting && (
        <Confirm
          title={`Удалить ${deleting.id}?`}
          text={`Тест-кейс «${deleting.title}» с историей результатов уйдёт в корзину проекта — оттуда его можно восстановить в течение 30 дней.`}
          onClose={() => setDeleting(null)}
          onYes={async () => {
            const c = deleting;
            setDeleting(null);
            if (await write(() => api("DELETE", paths.testCase(p, c.num), {}), "Тест-кейс удалён") && viewing?.num === c.num) close();
          }}
        />
      )}
    </>
  );
}

function BulkEditModal({ pid, nums, tags, onClose }: { pid: string; nums: number[]; tags: string[]; onClose: (done: boolean) => void }) {
  const { write, toast } = useStore();
  const [f, setF] = useState({ status: "", priority: "", add: [] as string[], remove: [] as string[] });
  const empty = !f.status && !f.priority && !f.add.length && !f.remove.length;
  async function submit(e: FormEvent) {
    e.preventDefault();
    let r = { changed: 0, skipped: 0 };
    const body = { nums, status: f.status || undefined, priority: f.priority || undefined, addTags: f.add, removeTags: f.remove };
    if (await write(async () => { r = await api("POST", `${paths.cases(pid)}/bulk`, body); })) {
      toast(`Изменено кейсов: ${r.changed}${r.skipped ? `, без изменений: ${r.skipped}` : ""}`);
      onClose(true);
    }
  }
  return (
    <Modal onClose={() => onClose(false)}>
      <form onSubmit={submit} id="bulkForm">
        <h2>Изменить выбранные кейсы ({nums.length})</h2>
        <p className="muted small" style={{ marginTop: 0 }}>Пустые поля не меняются. Каждый изменённый кейс получит новую версию.</p>
        <div className="row2">
          <div className="field"><label htmlFor="bk-status">Статус</label>
            <select id="bk-status" className="input" value={f.status} onChange={(e) => setF({ ...f, status: e.target.value })}>
              <option value="">Не менять</option>
              {CASE_STATUSES.filter((s) => s.key !== "review").map((s) => <option key={s.key} value={s.key}>{s.label}</option>)}
            </select></div>
          <div className="field"><label htmlFor="bk-prio">Приоритет</label>
            <select id="bk-prio" className="input" value={f.priority} onChange={(e) => setF({ ...f, priority: e.target.value })}>
              <option value="">Не менять</option>
              {PRIORITIES.map((s) => <option key={s.key} value={s.key}>{s.label}</option>)}
            </select></div>
        </div>
        <div className="field"><label htmlFor="bk-add">Добавить теги</label><TagInput id="bk-add" value={f.add} onChange={(v) => setF({ ...f, add: v })} suggestions={tags} /></div>
        <div className="field"><label htmlFor="bk-rm">Убрать теги</label><TagInput id="bk-rm" value={f.remove} onChange={(v) => setF({ ...f, remove: v })} suggestions={tags} /></div>
        <div className="acts">
          <button type="button" className="btn" onClick={() => onClose(false)}>Отмена</button>
          <button type="submit" className="btn primary" disabled={empty}>Применить</button>
        </div>
      </form>
    </Modal>
  );
}

export type CopyResult = { project: string; created: { from: number; num: number; id: string }[]; expanded: number; droppedFields: string[] };

// Копирование выбранных кейсов: в папку этого проекта или в другой проект (там — в корень, общие шаги раскрываются)
function CopyModal({ pid, nums, onClose }: { pid: string; nums: number[]; onClose: (done: boolean) => void }) {
  const data = useData();
  const { write, toast } = useStore();
  const targets = data.projects.filter((x) => x.id === pid || (x.myPermissions || []).includes("cases.edit") || x.myRole === "admin");
  const [project, setProject] = useState(pid);
  const [folder, setFolder] = useState("same");
  const other = project !== pid;
  async function submit(e: FormEvent) {
    e.preventDefault();
    let r: CopyResult | null = null;
    const body: Record<string, unknown> = { nums, project: other ? project : undefined };
    if (!other && folder !== "same") body.folder = folder ? Number(folder) : null;
    if (await write(async () => { r = await api<CopyResult>("POST", `${paths.cases(pid)}/copy`, body); })) {
      const notes = [r!.expanded ? `общие шаги раскрыты в ${r!.expanded} кейс.` : "", r!.droppedFields.length ? `не перенесены поля: ${r!.droppedFields.join(", ")}` : ""].filter(Boolean);
      toast(`Скопировано кейсов: ${r!.created.length}${other ? ` в проект ${project}` : ""}${notes.length ? ` (${notes.join("; ")})` : ""}`);
      onClose(true);
    }
  }
  return (
    <Modal wide onClose={() => onClose(false)}>
      <form onSubmit={submit} id="copyForm">
        <h2>Копировать выбранные кейсы ({nums.length})</h2>
        <p className="muted small" style={{ marginTop: 0 }}>Копия — новый кейс со своим номером: шаги, параметры, теги и поля переносятся, история прогонов и комментарии остаются у оригинала.</p>
        <div className="row2">
          <div className="field"><label htmlFor="cp-project">Проект</label>
            <select id="cp-project" className="input" value={project} onChange={(e) => setProject(e.target.value)}>
              {targets.map((x) => <option key={x.id} value={x.id}>{x.id} · {x.name}{x.id === pid ? " (этот)" : ""}</option>)}
            </select></div>
          <div className="field"><label htmlFor="cp-folder">Папка</label>
            {other ? <input id="cp-folder" className="input" value="Корень проекта" disabled /> : (
              <select id="cp-folder" className="input" value={folder} onChange={(e) => setFolder(e.target.value)}>
                <option value="same">Та же папка, что у оригинала</option>
                <FolderOptions pid={pid} rootLabel="— корень проекта (без папки) —" />
              </select>
            )}</div>
        </div>
        {other && <p className="muted small">В другом проекте свои общие шаги, наборы данных и поля: общие шаги станут обычными шагами, набор данных — таблицей параметров в кейсе, поля перенесутся, если там есть поле с тем же названием и типом.</p>}
        <div className="acts">
          <button type="button" className="btn" onClick={() => onClose(false)}>Отмена</button>
          <button type="submit" className="btn primary">Копировать</button>
        </div>
      </form>
    </Modal>
  );
}

// Вид списка кейсов: плотность и колонки. Хранится в браузере у каждого пользователя
type ColKey = "folder" | "tags" | "priority" | "status" | "result" | "bugs" | "updated";
const COLS: [ColKey, string][] = [["folder", "Папка"], ["tags", "Теги"], ["priority", "Приоритет"], ["status", "Статус"], ["result", "Результат"], ["bugs", "Баги"], ["updated", "Обновлён"]];
type CaseView = { density: "compact" | "comfortable"; cols: ColKey[] };
const VIEW_KEY = "tb.cases.view";
const DEFAULT_VIEW: CaseView = { density: "compact", cols: ["folder", "tags", "priority", "status", "result", "bugs"] };
function useCaseView(): [CaseView, (v: CaseView) => void] {
  const [v, setV] = useState<CaseView>(() => {
    try {
      const saved = JSON.parse(localStorage.getItem(VIEW_KEY) || "null");
      if (saved && (saved.density === "compact" || saved.density === "comfortable") && Array.isArray(saved.cols))
        return { density: saved.density, cols: saved.cols.filter((k: string) => COLS.some(([c]) => c === k)) };
    } catch { /* хранилище недоступно — вид по умолчанию */ }
    return DEFAULT_VIEW;
  });
  const save = (next: CaseView) => {
    setV(next);
    try { localStorage.setItem(VIEW_KEY, JSON.stringify(next)); } catch { /* не сохранится — не страшно */ }
  };
  return [v, save];
}
