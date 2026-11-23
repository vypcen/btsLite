import { createContext, useCallback, useContext, useEffect, useRef, useState, type Dispatch, type ReactNode, type SetStateAction } from "react";
import { api, setMutationHandler, setPendingHandler, setUnauthorizedHandler, type ProjectChange } from "./api";
import { partsFor, type ProjectPart } from "./projectChanges";
import { useRoute } from "./router";
import type { MetaState, Permission, ProjectState, State, User } from "./types";

interface Store {
  me: User | null | undefined; // undefined — ещё не знаем, вошёл ли пользователь
  // Может ли менять данные. Внутри проекта — по роли в этом проекте, вне проекта — по глобальной роли
  canEdit: boolean; // может менять тест-кейсы (cases.edit); точнее — useCan(разрешение)
  permissions: Set<string>;
  canComment: boolean; // разработчик комментирует, наблюдатель — нет
  bootError: boolean;
  data: State | null;
  projectLoading: boolean; // данные открытого проекта ещё не пришли
  liveError: string;
  refreshTick: number;
  setMe: Dispatch<SetStateAction<User | null | undefined>>;
  reload: () => Promise<void>;
  toast: (msg: string) => void;
  // Выполняет изменение, показывает ошибку тостом и перечитывает состояние. true — если удалось
  write: (fn: () => Promise<unknown>, okMsg?: string, opts?: { queue?: boolean }) => Promise<boolean>;
}

const Ctx = createContext<Store>(null!);
export const useStore = () => useContext(Ctx);
export const useData = () => useContext(Ctx).data!;
export const useCanEdit = () => useContext(Ctx).canEdit;
// Разрешено ли текущему пользователю действие в открытом проекте (вне проекта — по глобальной роли).
// Кнопки прячутся для удобства; права проверяет сервер (server/roles.js)
export const useCan = (perm: Permission) => useContext(Ctx).permissions.has(perm);
export const useCanComment = () => useContext(Ctx).canComment;

// Перечитываем дополнительные данные после группы изменений, сохраняя их при обычном рендере.
// url null — ничего не загружать
export function useLoad<T>(url: string | null) {
  const { refreshTick } = useStore();
  const [s, setS] = useState<{ value?: T; error?: string }>({});
  useEffect(() => {
    if (!url) return setS({});
    let alive = true;
    api<T>("GET", url).then(
      (value) => alive && setS({ value }),
      (e) => alive && setS((prev) => ({ ...prev, error: e.message }))
    );
    return () => {
      alive = false;
    };
  }, [url, refreshTick]);
  return s;
}

export function StoreProvider({ children }: { children: ReactNode }) {
  const [me, setMe] = useState<User | null | undefined>(undefined);
  const [bootError, setBootError] = useState(false);
  const [meta, setMeta] = useState<MetaState | null>(null);
  const [proj, setProj] = useState<ProjectState | null>(null);
  const [liveError, setLiveError] = useState("");
  const [refreshTick, setRefreshTick] = useState(0);
  const [toastMsg, setToastMsg] = useState("");
  const toastTimer = useRef<number>();
  const busy = useRef(false);
  const lost = useRef(false);
  const projectSnapshot = useRef<ProjectState | null>(null);
  const projectRequests = useRef(new Map<string, Promise<void>>());
  const mutation = useRef({ revision: 0, untracked: 0, refresh: Promise.resolve() });
  const pending = useRef<{ changes: Map<string, ProjectChange>; timer: number; promise: Promise<void>; resolve: () => void }>();

  const toast = useCallback((msg: string) => {
    setToastMsg(msg);
    clearTimeout(toastTimer.current);
    toastTimer.current = window.setTimeout(() => setToastMsg(""), 2600);
  }, []);

  // открытый проект (#/p/KEY/...): его данные грузятся отдельно и перечитываются только по его сигналам
  const [section, key] = useRoute();
  const pid = section === "p" && key ? key : null;
  const pidRef = useRef(pid);
  pidRef.current = pid;
  const login = me?.pending ? undefined : me?.login;
  const loginRef = useRef(login);
  loginRef.current = login;

  const loadMeta = useCallback(async () => {
    try {
      setMeta(await api<MetaState>("GET", "/api/state"));
      setLiveError("");
    } catch (e: any) {
      if (e.status !== 401) setLiveError(e.message);
    }
  }, []);

  const loadProject = useCallback((k = pidRef.current, parts?: ProjectPart[], caseNums: number[] = []) => {
    const owner = loginRef.current;
    if (!k || !owner || parts?.length === 0) return Promise.resolve();
    const requests = projectRequests.current;
    const request = (requests.get(k) || Promise.resolve()).then(async () => {
      if (pidRef.current !== k || loginRef.current !== owner) return;
      const current = projectSnapshot.current?.pid === k ? projectSnapshot.current : null;
      const query = new URLSearchParams();
      if (current && parts) {
        query.set("parts", parts.join(","));
        if (caseNums.length && (parts.includes("cases") || parts.includes("results"))) query.set("caseNums", caseNums.join(","));
      }
      try {
        const next = await api<ProjectState>("GET", `/api/projects/${encodeURIComponent(k)}/state${query.size ? `?${query}` : ""}`);
        if (pidRef.current !== k || loginRef.current !== owner) return;
        const updated = { ...current, ...next };
        if (current && query.has("caseNums")) {
          const nums = new Set(caseNums);
          if (next.cases) updated.cases = [...current.cases.filter((c) => !nums.has(c.num)), ...next.cases].sort((a, b) => a.num - b.num);
          if (next.results) updated.results = [...current.results.filter((r) => !nums.has(r.caseNum)), ...next.results];
        }
        projectSnapshot.current = updated;
        setProj(updated);
        setLiveError("");
      } catch (e: any) {
        if (pidRef.current !== k || loginRef.current !== owner) return;
        if (e.status === 404) {
          projectSnapshot.current = null;
          setProj(null);
        } else if (e.status !== 401) setLiveError(e.message);
      }
    }).finally(() => {
      if (requests.get(k) === request) requests.delete(k);
    });
    requests.set(k, request);
    return request;
  }, []);

  const reload = useCallback(async () => {
    await Promise.all([loadMeta(), loadProject()]);
    setRefreshTick((n) => n + 1);
  }, [loadMeta, loadProject]);

  const scheduleChanges = useCallback((changes: ProjectChange[]) => {
    if (!pending.current) {
      let resolve!: () => void;
      const promise = new Promise<void>((done) => { resolve = done; });
      const timer = window.setTimeout(async () => {
        const batch = pending.current!;
        pending.current = undefined;
        const k = pidRef.current;
        const relevant = [...batch.changes.values()].filter((event) => !event.pid || event.pid === k);
        const needMeta = [...batch.changes.values()].some(({ type, pid }) =>
          ["projects", "users", "plans"].includes(type) || (!k && ["cases", "runs", "runResults", "bugs"].includes(type)) || (!pid && !type));
        try {
          const { parts, caseNums } = partsFor(relevant);
          await Promise.all([needMeta && loadMeta(), relevant.length > 0 && loadProject(k, parts, caseNums)]);
          if (needMeta || relevant.length) setRefreshTick((n) => n + 1);
        } finally {
          batch.resolve();
        }
      }, 150);
      pending.current = { changes: new Map(), timer, promise, resolve };
    }
    for (const event of changes) pending.current.changes.set(JSON.stringify([event.type, event.pid, event.caseNum]), event);
    return pending.current.promise;
  }, [loadMeta, loadProject]);

  const afterWrite = useCallback((before: number) => {
    const { revision, untracked, refresh } = mutation.current;
    return revision === before || untracked > before ? reload() : refresh;
  }, [reload]);

  // Пока идёт сохранение, повторный вызов игнорируется: защита от двойной отправки формы.
  // Отметки в прогоне (queue: true) не теряются, а встают в очередь: быстрые клики по шагам и пунктам сохранятся по порядку
  const queue = useRef<Promise<unknown>>(Promise.resolve());
  const write = useCallback(
    async (fn: () => Promise<unknown>, okMsg?: string, opts?: { queue?: boolean }) => {
      if (opts?.queue) {
        const before = mutation.current.revision;
        const run = queue.current.then(async () => {
          try {
            await fn();
            if (okMsg) toast(okMsg);
            return true;
          } catch (e: any) {
            toast(e.message || "Не удалось сохранить");
            return false;
          }
        });
        queue.current = run;
        const ok = await run;
        // перечитываем, когда очередь опустела: одно обновление на пачку кликов
        if (queue.current === run) await afterWrite(before);
        return ok;
      }
      if (busy.current) return false;
      busy.current = true;
      const before = mutation.current.revision;
      try {
        await fn();
        if (okMsg) toast(okMsg);
        await afterWrite(before);
        return true;
      } catch (e: any) {
        toast(e.message || "Не удалось сохранить");
        return false;
      } finally {
        busy.current = false;
      }
    },
    [afterWrite, toast]
  );

  useEffect(() => {
    setUnauthorizedHandler(() => setMe(null));
    setPendingHandler((code) => setMe((m) => (m ? { ...m, pending: code === "password_change_required" ? "password" : "2fa" } : m)));
    api<{ user: User | null }>("GET", "/api/auth/me")
      .then((r) => setMe(r.user))
      .catch(() => setBootError(true));
  }, []);

  useEffect(() => {
    setMutationHandler((changes) => {
      const current = mutation.current;
      current.revision++;
      if (changes) current.refresh = scheduleChanges(changes);
      else current.untracked = current.revision;
    });
    return () => setMutationHandler(() => {});
  }, [scheduleChanges]);

  // Пока пользователь в системе: загружаем состояние и слушаем изменения других участников
  // пока не сменён пароль или не включена 2FA, данные не загружаются: сервер их всё равно не отдаст
  useEffect(() => {
    if (!login) {
      setMeta(null);
      setProj(null);
      projectSnapshot.current = null;
      return;
    }
    loadMeta();
    const es = new EventSource("/api/events");
    es.addEventListener("change", (ev) => {
      try {
        const { type, pid, caseNum } = JSON.parse((ev as MessageEvent).data);
        scheduleChanges([{ type, pid, caseNum }]);
      } catch { reload(); }
    });
    es.onopen = () => {
      if (lost.current) {
        lost.current = false;
        reload();
      }
    };
    es.onerror = () => {
      lost.current = true;
      setLiveError("Связь с сервером прервана. Переподключаемся…");
    };
    return () => {
      es.close();
      if (pending.current) {
        clearTimeout(pending.current.timer);
        pending.current.resolve();
        pending.current = undefined;
      }
    };
  }, [login, reload, loadMeta, scheduleChanges]);

  // перешли в другой проект — грузим его данные, старые не показываем
  useEffect(() => {
    if (!login) return;
    if (!pid && projectSnapshot.current) loadMeta();
    if (projectSnapshot.current?.pid !== pid) projectSnapshot.current = null;
    setProj((cur) => (cur?.pid === pid ? cur : null));
    loadProject(pid);
  }, [login, pid, loadMeta, loadProject]);

  const data: State | null = !meta
    ? null
    : {
        roles: meta.roles,
        projects: meta.projects,
        users: meta.users,
        plans: proj ? proj.plans : meta.plans,
        cases: proj?.cases || [],
        folders: proj?.folders || [],
        runs: proj?.runs || [],
        results: proj?.results || [],
        bugs: proj?.bugs || [],
        attachments: proj?.attachments || [],
        autoruns: proj?.autoruns || [],
        comments: proj?.comments || [],
        customFields: proj?.customFields || [],
      };
  // данные проекта ещё грузятся: экраны проекта ждут, чтобы не мигнуть «пусто»
  const projectLoading = Boolean(pid && meta?.projects.some((p) => p.id === pid) && proj?.pid !== pid);

  // роль могут поменять, пока вкладка открыта: свежая приходит с каждым обновлением состояния
  const role = me && data?.users[me.login]?.role;
  const user = me && role && role !== me.role ? { ...me, role } : me;
  // роль в открытом проекте (#/p/KEY/...) может отличаться от глобальной
  const project = section === "p" ? data?.projects.find((p) => p.id === key) : undefined;
  const permissions = new Set<string>(project ? project.myPermissions || [] : meta?.myPermissions || []);
  const canEdit = permissions.has("cases.edit");
  const canComment = permissions.has("comments");

  return (
    <Ctx.Provider value={{ me: user, canEdit, canComment, permissions, bootError, data, projectLoading, liveError, refreshTick, setMe, reload, toast, write }}>
      {children}
      <div className="toast" hidden={!toastMsg} role="status">
        {toastMsg}
      </div>
    </Ctx.Provider>
  );
}
