// Релизы и майлстоуны (E-01): список релизов со спринтами, страница готовности релиза, привязка прогонов, планов и багов
import { useState, type FormEvent } from "react";
import { api } from "../api";
import { go, href } from "../router";
import { useCan, useLoad, useStore } from "../store";
import type { Project, Release, ReleaseStatus } from "../types";
import type { Tone } from "../labels";
import { Confirm, Empty, Modal, Pill } from "../ui";

const url = (pid: string) => `/api/projects/${encodeURIComponent(pid)}/releases`;
export const RELEASE_STATUSES: { key: ReleaseStatus; label: string; tone: Tone }[] = [
  { key: "planned", label: "Запланирован", tone: "neutral" },
  { key: "active", label: "Идёт", tone: "info" },
  { key: "released", label: "Выпущен", tone: "ok" },
  { key: "cancelled", label: "Отменён", tone: "neutral" },
];
const statusOf = (s: ReleaseStatus) => RELEASE_STATUSES.find((x) => x.key === s)!;
const dmy = (d: string | null) => (d ? d.split("-").reverse().join(".") : "");

export function useReleases(pid: string): Release[] {
  return useLoad<{ items: Release[] }>(url(pid)).value?.items || [];
}

// Выбор релиза в формах прогона, плана и бага: спринты показаны внутри релизов
export function ReleaseSelect({ pid, value, onChange, id = "f-release" }: { pid: string; value: string; onChange: (v: string) => void; id?: string }) {
  const list = useReleases(pid).filter((r) => r.status !== "cancelled" || String(r.num) === value);
  if (!list.length && !value) return null;
  const tops = list.filter((r) => !r.parent);
  return (
    <div className="field">
      <label htmlFor={id}>Релиз</label>
      <select className="input" id={id} value={value} onChange={(e) => onChange(e.target.value)}>
        <option value="">Без релиза</option>
        {tops.map((r) => [
          <option key={r.num} value={r.num}>{r.name}{r.due ? ` · до ${dmy(r.due)}` : ""}</option>,
          ...list.filter((s) => s.parent === r.num).map((s) => <option key={s.num} value={s.num}>   └ {s.name}</option>),
        ])}
      </select>
    </div>
  );
}

// Метка релиза в списках
export function ReleaseTag({ pid, num, list }: { pid: string; num?: number | null; list: Release[] }) {
  if (!num) return null;
  const r = list.find((x) => x.num === num);
  return <a className="chip" href={href("p", pid, "releases", num)} title="Релиз">{r ? r.name : `V${num}`}</a>;
}

export function ReleasesTab({ project, openNum }: { project: Project; openNum?: number }) {
  const pid = project.id;
  const canEdit = useCan("plans.edit");
  const { write } = useStore();
  const list = useReleases(pid);
  const [editing, setEditing] = useState<Release | "new" | null>(null);
  const [removing, setRemoving] = useState<Release | null>(null);
  const shown = openNum === undefined ? list : list.filter((release) => release.num === openNum);
  return (
    <>
      <div className="toolbar">
        {openNum !== undefined && <a className="btn" href={href("p", pid, "releases")}>← Все релизы</a>}
        <div className="spacer" />
        {canEdit && <button className="btn primary" onClick={() => setEditing("new")}>+ Релиз</button>}
      </div>
      {!shown.length ? <Empty title={openNum === undefined ? "Релизов пока нет" : "Релиз не найден"} /> : (
        <div className="tbl-wrap">
          <table>
            <thead><tr><th>ID</th><th>Релиз</th><th>Статус</th><th>Срок</th>{canEdit && <th>Действия</th>}</tr></thead>
            <tbody>{shown.map((release) => {
              const status = statusOf(release.status);
              return <tr key={release.num}>
                <td className="mono"><a href={href("p", pid, "releases", release.num)}>{release.ref}</a></td>
                <td>{release.name}{release.parent && <div className="muted small">Спринт в релизе V{release.parent}</div>}{release.description && <div className="muted small">{release.description}</div>}</td>
                <td><Pill tone={status.tone} label={status.label} sm /></td>
                <td>{dmy(release.due)}</td>
                {canEdit && <td><button className="btn sm" onClick={() => setEditing(release)}>Редактировать</button>{" "}
                  <button className="btn sm" onClick={() => setRemoving(release)}>Удалить</button></td>}
              </tr>;
            })}</tbody>
          </table>
        </div>
      )}
      {editing && <ReleaseModal pid={pid} release={editing === "new" ? null : editing} onClose={() => setEditing(null)} />}
      {removing && <Confirm title={`Удалить ${removing.ref}?`} text="Связанные тест-планы, прогоны и баги сохранятся."
        onClose={() => setRemoving(null)} onYes={async () => {
          if (await write(() => api("DELETE", `${url(pid)}/${removing.num}`), "Релиз удалён")) {
            setRemoving(null);
            if (openNum !== undefined) go("p", pid, "releases");
          }
        }} />}
    </>
  );
}

function ReleaseModal({ pid, release, onClose }: { pid: string; release: Release | null; onClose: () => void }) {
  const { write } = useStore();
  const [f, setF] = useState({
    name: release?.name || "", description: release?.description || "", status: release?.status || ("planned" as ReleaseStatus),
    starts: release?.starts || "", due: release?.due || "",
  });
  const [err, setErr] = useState("");
  const set = (k: keyof typeof f) => (e: { target: { value: string } }) => setF({ ...f, [k]: e.target.value });
  const sprint = Boolean(release?.parent);
  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!f.name.trim()) return setErr(sprint ? "Укажите название спринта" : "Укажите название релиза");
    const body = { ...f, name: f.name.trim(), starts: f.starts || null, due: f.due || null };
    let num = release?.num || 0;
    const ok = await write(async () => {
      if (release) await api("PATCH", `${url(pid)}/${release.num}`, body);
      else num = (await api<{ num: number }>("POST", url(pid), body)).num;
    }, release ? "Сохранено" : sprint ? "Спринт создан" : "Релиз создан");
    if (ok) {
      onClose();
      if (!release) go("p", pid, "releases", num);
    }
  }
  return (
    <Modal onClose={onClose}>
      <form onSubmit={submit} noValidate>
        <h2>{release ? (sprint ? "Спринт" : "Релиз") : sprint ? "Новый спринт" : "Новый релиз"}</h2>
        <div className="field"><label htmlFor="rl-name">Название *</label>
          <input className="input" id="rl-name" value={f.name} onChange={set("name")} placeholder={sprint ? "Например: Спринт 14" : "Например: 2.5 — новая корзина"} autoFocus /></div>
        <div className="row2">
          <div className="field"><label htmlFor="rl-starts">Начало</label><input className="input" id="rl-starts" type="date" value={f.starts} onChange={set("starts")} /></div>
          <div className="field"><label htmlFor="rl-due">Срок</label><input className="input" id="rl-due" type="date" value={f.due} onChange={set("due")} /></div>
        </div>
        <div className="field"><label htmlFor="rl-status">Статус</label>
          <select className="input" id="rl-status" value={f.status} onChange={set("status")}>{RELEASE_STATUSES.map((s) => <option key={s.key} value={s.key}>{s.label}</option>)}</select></div>
        <div className="field"><label htmlFor="rl-desc">Описание</label><textarea className="input" id="rl-desc" rows={3} value={f.description} onChange={set("description")} /></div>
        <div className="err">{err}</div>
        <div className="acts">
          <button type="button" className="btn" onClick={onClose}>Отмена</button>
          <button type="submit" className="btn primary">{release ? "Сохранить" : "Создать"}</button>
        </div>
      </form>
    </Modal>
  );
}
