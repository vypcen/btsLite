// Лицензионное соглашение при первом запуске клиентской сборки и полоса «Пробная версия»
import { useEffect, useState } from "react";
import { api } from "../api";
import { useStore } from "../store";
import type { User } from "../types";

export function EulaScreen() {
  const { me, setMe, toast } = useStore();
  const [html, setHtml] = useState("");
  const [agree, setAgree] = useState(false);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    api<{ html: string }>("GET", "/api/eula").then((r) => setHtml(r.html), () => setHtml("<p>Не удалось загрузить текст соглашения.</p>"));
  }, []);
  const refresh = async () => setMe((await api<{ user: User }>("GET", "/api/auth/me")).user);
  const accept = async () => {
    setBusy(true);
    try {
      await api("POST", "/api/eula/accept", {});
      toast("Соглашение принято");
      await refresh();
    } catch (e: any) {
      toast(e.message);
    } finally {
      setBusy(false);
    }
  };
  const logout = () => {
    api("POST", "/api/auth/logout", {}).catch(() => {});
    setMe(null);
  };
  const admin = me?.eula === "accept";
  return (
    <div className="wrap login">
      <div className="login-card" style={{ maxWidth: 760, width: "100%" }}>
        <span className="brand"><span className="mark">BC</span>BlackCat Testing</span>
        <h1 style={{ fontSize: 22, margin: 0 }}>Лицензионное соглашение</h1>
        {admin ? (
          <>
            <p className="muted" style={{ margin: 0 }}>Перед началом работы примите условия использования BlackCat Testing от имени вашей организации.</p>
            <div className="eula-text" tabIndex={0} aria-label="Текст лицензионного соглашения" dangerouslySetInnerHTML={{ __html: html }} />
            <label style={{ display: "flex", gap: 10, alignItems: "flex-start" }}>
              <input type="checkbox" checked={agree} onChange={(e) => setAgree(e.target.checked)} style={{ marginTop: 3 }} />
              <span>Я прочитал(а) соглашение и принимаю его условия от имени организации, которую представляю</span>
            </label>
            <button className="btn primary" disabled={!agree || busy} onClick={accept} style={{ justifyContent: "center" }}>
              {busy ? "Сохраняем…" : "Принять и продолжить"}
            </button>
          </>
        ) : (
          <>
            <p style={{ margin: 0 }}>Администратор ещё не принял лицензионное соглашение. Работа станет доступна сразу после этого.</p>
            <button className="btn" onClick={refresh} style={{ justifyContent: "center" }}>Проверить ещё раз</button>
          </>
        )}
        <button type="button" className="btn ghost" onClick={logout}>Выйти</button>
      </div>
    </div>
  );
}
