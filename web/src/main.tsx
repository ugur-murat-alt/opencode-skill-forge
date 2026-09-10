import { Maintenance } from "./Maintenance";
import { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import {
  Archive,
  Home,
  BookOpen,
  Briefcase,
  Settings,
  Folder,
  Database,
  FileText,
  Menu,
  LogOut,
  Building2,
  KeyRound,
  MailPlus,
  ScrollText,
  Sun,
  Moon,
} from "lucide-react";
import {
  api,
  ApiError,
  errorCode,
  setActiveTenant,
  setCsrfToken,
  type Account,
} from "./api";
import { LangProvider, useLang, type Theme } from "./i18n/lang";
import type { KeyPath } from "./i18n/lang";
import { OrgScope } from "./OrgScope";
import { Login } from "./Login";
import { Projects } from "./Projects";
import { Overview } from "./Overview";
import { Library } from "./Library";
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
const navigation: { id: string; key: KeyPath; Icon: typeof Home }[] = [
  { id: "overview", key: "nav.overview", Icon: Home },
  { id: "library", key: "nav.library", Icon: BookOpen },
  { id: "jobs", key: "nav.jobs", Icon: Briefcase },
  { id: "organizations", key: "nav.organizations", Icon: Building2 },
  { id: "roles", key: "nav.roles", Icon: KeyRound },
  { id: "invitations", key: "nav.invitations", Icon: MailPlus },
  { id: "prompts", key: "nav.prompts", Icon: ScrollText },
  { id: "maintenance", key: "nav.maintenance", Icon: Archive },
  { id: "installations", key: "nav.installs", Icon: Settings },
  { id: "projects", key: "nav.projects", Icon: Folder },
  { id: "models", key: "nav.models", Icon: Database },
  { id: "logs", key: "nav.logs", Icon: FileText },
];
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
 * tenant, or a clear membership screen when nothing is active. */
function Membership({
  onRetry,
  onRecovered,
}: {
  onRetry: () => void;
  onRecovered: () => void;
}) {
  const { t } = useLang();
  const [state, setState] = useState<"pending" | "none">("pending");
  useEffect(() => {
    void api<{
      items: { tenant_id: string; disabled: number }[];
      csrf: string | null;
    }>("/api/my-memberships")
      .then(async (value) => {
        if (value.csrf) setCsrfToken(value.csrf);
        const active = value.items.find((item) => !item.disabled);
        if (!active) {
          setState("none");
          return;
        }
        setActiveTenant(active.tenant_id);
        await api("/api/tenants/switch", {
          method: "POST",
          body: JSON.stringify({ tenant_id: active.tenant_id }),
        });
        onRecovered();
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
    [membership, setMembership] = useState(false),
    [project, setProject] = useState(""),
    [page, setPage] = useState(location.hash.slice(1) || "overview"),
    [scopeTick, setScopeTick] = useState(0),
    [menu, setMenu] = useState(false);
  function reloaded() {
    setScopeTick((t) => t + 1);
    void load();
  }
  async function load() {
    try {
      const next = await api<Account>("/api/me");
      setActiveTenant(next.identity.tenantId);
      setAccount(next);
      setProject((current) =>
        next.projects.some((item) => item.id === current)
          ? current
          : (next.projects[0]?.id ?? ""),
      );
      setError("");
    } catch (error) {
      if (error instanceof ApiError && error.status === 401) setAccount(null);
      else if (
        error instanceof ApiError &&
        errorCode(error) === "tenant_unavailable"
      )
        setMembership(true);
      else setError(errorCode(error));
    }
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
        onRecovered={() => {
          setMembership(false);
          void load();
        }}
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
      onChange={load}
    />
  );
  const pages: Record<string, React.ReactNode> = {
    overview: <Overview project={project} />,
    library: <Library project={project} />,
    jobs: <Jobs project={project} />,
    organizations: (
      <Organizations userId={account.identity.userId} onSwitch={reloaded} />
    ),
    roles: <Roles />,
    invitations: <Invitations />,
    prompts: <AgentPrompts />,
    maintenance: <Maintenance key={project} project={project} />,
    installations: <Installations project={project} />,
    projects,
    models: <Models project={project} />,
    logs: <Logs project={project} />,
  };
  const projectFree = new Set([
    "organizations",
    "roles",
    "invitations",
    "prompts",
  ]);
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
          {navigation.map(({ id, key, Icon }) => (
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
              onSwitch={reloaded}
              tick={scopeTick}
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
