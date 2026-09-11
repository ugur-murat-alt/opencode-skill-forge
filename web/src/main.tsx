import { Maintenance } from "./Maintenance";
import { useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { Menu, LogOut, Sun, Moon } from "lucide-react";
import {
  activeTenantValue,
  ApiError,
  api,
  beginTenantTransition,
  currentTenantTransition,
  errorCode,
  settleTenantTransition,
  setActiveTenant,
  setCsrfToken,
  type Account,
} from "./api";
import { LangProvider, useLang, type Theme } from "./i18n/lang";
import { screens, projectFreeScreens } from "./screens";
import { OrgScope } from "./OrgScope";
import { Login } from "./Login";
import { Projects } from "./Projects";
import { Overview } from "./Overview";
import { Library } from "./Library";
import { Memory } from "./Memory";
import { Jobs } from "./Jobs";
import { Organizations } from "./Organizations";
import { Roles } from "./Roles";
import { Invitations } from "./Invitations";
import { AgentPrompts } from "./AgentPrompts";
import { Models } from "./Models";
import { Installations } from "./Installations";
import { Logs } from "./Logs";
import "@fontsource/inter/latin-400.css";
import "@fontsource/inter/latin-ext-400.css";
import "@fontsource/inter/latin-500.css";
import "@fontsource/inter/latin-ext-500.css";
import "@fontsource/inter/latin-600.css";
import "@fontsource/inter/latin-ext-600.css";
import "./style.css";

function ThemeToggle() {
  const { theme, setTheme, t } = useLang();
  const next: Theme = theme === "light" ? "dark" : "light";
  return (
    <button
      className="icon-button"
      data-testid="theme-toggle"
      aria-label={t("aria.switchTheme")}
      title={t("aria.switchTheme")}
      onClick={() => setTheme(next)}
    >
      {theme === "light" ? <Moon size={18} /> : <Sun size={18} />}
    </button>
  );
}
function LangToggle() {
  const { lang, setLang, t } = useLang();
  return (
    <button
      className="lang-toggle"
      data-testid="lang-toggle"
      aria-label={t("aria.switchLanguage")}
      title={t("aria.switchLanguage")}
      onClick={() => setLang(lang === "tr" ? "en" : "tr")}
    >
      {lang === "tr" ? "EN" : "TR"}
    </button>
  );
}
/** Issue #5 recovery: session-only membership list, auto-switch to an active
 * tenant, or a clear membership screen when nothing is active. The switch
 * goes through the single transition coordinator (issue #22). */
function Membership({
  onRetry,
  onRecover,
}: {
  onRetry: () => void;
  onRecover: (tenantId: string) => void;
}) {
  const { t } = useLang();
  const [state, setState] = useState<"pending" | "none">("pending");
  useEffect(() => {
    void api<{
      items: { tenant_id: string; disabled: number }[];
      csrf: string | null;
    }>("/api/my-memberships")
      .then((value) => {
        if (value.csrf) setCsrfToken(value.csrf);
        const active = value.items.find((item) => !item.disabled);
        if (!active) {
          setState("none");
          return;
        }
        onRecover(active.tenant_id);
      })
      .catch(() => setState("none"));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  return (
    <main className="login" role="status">
      <div className="brand">{t("shell.brand")}</div>
      <h1>{t("membership.title")}</h1>
      {state === "pending" ? (
        <p>{t("membership.recovering")}</p>
      ) : (
        <>
          <p>{t("membership.detail")}</p>
          <button onClick={onRetry}>{t("membership.retry")}</button>
        </>
      )}
    </main>
  );
}
function App() {
  const { t, err } = useLang();
  const [account, setAccount] = useState<Account | null | undefined>(undefined),
    [error, setError] = useState(""),
    [switchError, setSwitchError] = useState(""),
    [switching, setSwitching] = useState(false),
    [membership, setMembership] = useState(false),
    [project, setProject] = useState(""),
    [page, setPage] = useState(location.hash.slice(1) || "overview"),
    [scopeTick, setScopeTick] = useState(0),
    [menu, setMenu] = useState(false);
  const loadGeneration = useRef(0);
  const projectRef = useRef("");
  const switchQueue = useRef<Promise<void>>(Promise.resolve());
  projectRef.current = project;
  function reloaded() {
    setScopeTick((t) => t + 1);
    void load();
  }
  /** Commit account, tenant and project selection together. A stale /api/me
   * response (issue #22) is discarded by generation, and a selection beyond
   * the first /api/me page is verified against the authoritative project
   * scope instead of being reset (issue #29). */
  async function load(tenant?: string): Promise<boolean> {
    const request = ++loadGeneration.current;
    const options = tenant === undefined ? {} : { tenant };
    try {
      const next = await api<Account>("/api/me", {}, options);
      if (request !== loadGeneration.current) return false;
      let selected = next.projects.some(
        (item) => item.id === projectRef.current,
      )
        ? projectRef.current
        : "";
      if (!selected && projectRef.current) {
        try {
          await api(
            `/api/settings/effective?project_ref=${encodeURIComponent(projectRef.current)}`,
            {},
            options,
          );
          if (request !== loadGeneration.current) return false;
          selected = projectRef.current;
        } catch (probeError) {
          if (request !== loadGeneration.current) return false;
          selected =
            probeError instanceof ApiError &&
            (probeError.status === 403 || probeError.status === 404)
              ? ""
              : projectRef.current;
        }
      }
      setActiveTenant(next.identity.tenantId);
      setAccount(next);
      setProject(selected || next.projects[0]?.id || "");
      setMembership(false);
      setError("");
      return true;
    } catch (error) {
      if (request !== loadGeneration.current) return false;
      if (error instanceof ApiError && error.status === 401) setAccount(null);
      else if (
        error instanceof ApiError &&
        errorCode(error) === "tenant_unavailable"
      )
        setMembership(true);
      else setError(errorCode(error));
      return false;
    }
  }
  /** Issue #22: one coordinator for the top selector, the organization table
   * row and membership recovery. Switch POSTs are serialized so the cookie
   * cannot be left behind by out-of-order completions; the account read is
   * bound to the target tenant explicitly and only the newest generation may
   * commit the screen context. */
  function requestTenantSwitch(target: string) {
    if (!target) return;
    if (target === (account?.identity.tenantId ?? activeTenantValue())) return;
    const generation = beginTenantTransition();
    setSwitching(true);
    setSwitchError("");
    const task = switchQueue.current.then(async () => {
      if (generation !== currentTenantTransition()) return;
      const previous = activeTenantValue();
      try {
        await api(
          "/api/tenants/switch",
          { method: "POST", body: JSON.stringify({ tenant_id: target }) },
          { tenant: target },
        );
      } catch (error) {
        if (generation === currentTenantTransition()) {
          setSwitchError(errorCode(error));
          settleTenantTransition(generation);
          setSwitching(false);
        }
        return;
      }
      if (generation !== currentTenantTransition()) return;
      void completeTenantSwitch(generation, target, previous);
    });
    switchQueue.current = task.catch(() => {});
  }
  async function completeTenantSwitch(
    generation: number,
    target: string,
    previous: string,
  ) {
    const committed = await load(target);
    if (generation !== currentTenantTransition()) return;
    if (committed) {
      setScopeTick((t) => t + 1);
    } else if (previous) {
      // The cookie moved but the visible context could not commit; put the
      // server session back so context and cookie stay consistent.
      await api(
        "/api/tenants/switch",
        { method: "POST", body: JSON.stringify({ tenant_id: previous }) },
        { tenant: previous },
      ).catch(() => {});
    }
    settleTenantTransition(generation);
    setSwitching(false);
  }
  useEffect(() => {
    void load();
    const change = () => {
      setPage(location.hash.slice(1) || "overview");
      setMenu(false);
    };
    window.addEventListener("hashchange", change);
    return () => window.removeEventListener("hashchange", change);
  }, []);
  if (membership)
    return (
      <Membership
        onRetry={() => {
          setMembership(false);
          void load();
        }}
        onRecover={(tenantId) => requestTenantSwitch(tenantId)}
      />
    );
  if (error)
    return (
      <main className="login">
        <h1>{t("shell.unreachable")}</h1>
        <p role="alert">{err(error)}</p>
        <button onClick={() => void load()}>{t("shell.retry")}</button>
      </main>
    );
  if (account === undefined)
    return (
      <main className="login" role="status">
        {t("shell.loading")}
      </main>
    );
  if (!account) return <Login onLogin={() => void load()} />;
  const projects = (
    <Projects
      project={project}
      admin={account.role === "founder" || account.role === "admin"}
      userId={account.identity.userId}
      onChange={async () => {
        await load();
      }}
    />
  );
  const pages: Record<string, React.ReactNode> = {
    overview: <Overview project={project} />,
    library: <Library project={project} tenant={account.identity.tenantId} />,
    memory: (
      <Memory
        tenant={account.identity.tenantId}
        project={project}
        canWrite={["founder", "admin", "writer"].includes(account.role)}
      />
    ),
    jobs: <Jobs project={project} />,
    organizations: (
      <Organizations
        userId={account.identity.userId}
        onSwitch={reloaded}
        onSelectTenant={requestTenantSwitch}
      />
    ),
    roles: <Roles />,
    invitations: <Invitations />,
    prompts: <AgentPrompts tenant={account.identity.tenantId} />,
    maintenance: <Maintenance key={project} project={project} />,
    installations: <Installations project={project} />,
    projects,
    models: <Models project={project} />,
    logs: <Logs project={project} />,
  };
  const projectFree = projectFreeScreens;
  const content =
    !project && !projectFree.has(page)
      ? projects
      : (pages[page] ?? (
          <>
            <h1>{t("shell.notFound")}</h1>
            <a href="#overview">{t("shell.notFoundBack")}</a>
          </>
        ));
  return (
    <div className={`shell ${menu ? "menu-open" : ""}`}>
      <a
        className="skip-link"
        href="#main-content"
        onClick={(event) => {
          event.preventDefault();
          document.getElementById("main-content")?.focus();
        }}
      >
        {t("shell.skip")}
      </a>
      <aside>
        <a className="brand" href="#overview">
          {t("shell.brand")}
        </a>
        <nav aria-label={t("shell.mainNav")}>
          {screens.map(({ id, titleKey: key, Icon }) => (
            <a
              href={`#${id}`}
              key={id}
              aria-current={page === id ? "page" : undefined}
            >
              <Icon size={20} strokeWidth={1.7} />
              <span>{t(key)}</span>
            </a>
          ))}
        </nav>
      </aside>
      <div className="workspace">
        <header>
          <button
            className="icon-button menu-toggle"
            aria-label={t("aria.menuToggle")}
            aria-expanded={menu}
            onClick={() => setMenu(!menu)}
          >
            <Menu size={22} />
          </button>
          <div className="header-controls">
            <OrgScope
              tenantId={account.identity.tenantId}
              project={project}
              projects={account.projects}
              onProject={setProject}
              onSwitch={requestTenantSwitch}
              tick={scopeTick}
              switching={switching}
              error={switchError}
            />
            <LangToggle />
            <ThemeToggle />
            <button
              className="icon-button"
              aria-label={t("aria.logout")}
              title={t("aria.logout")}
              onClick={() =>
                void api("/api/logout", { method: "POST" })
                  .then(() => {
                    setActiveTenant("");
                    setAccount(null);
                  })
                  .catch((error) => setError(errorCode(error)))
              }
            >
              <LogOut size={18} />
            </button>
          </div>
        </header>
        <main
          id="main-content"
          tabIndex={-1}
          className="content"
          key={`${page}:${project}:${account.identity.tenantId}`}
        >
          {content}
        </main>
      </div>
    </div>
  );
}
createRoot(document.getElementById("root")!).render(
  <LangProvider>
    <App />
  </LangProvider>,
);
