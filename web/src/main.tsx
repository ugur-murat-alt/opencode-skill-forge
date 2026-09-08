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
} from "lucide-react";
import { api, ApiError, type Account } from "./api";
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
const navigation = [
  { id: "overview", title: "Genel durum", Icon: Home },
  { id: "library", title: "Skill kütüphanesi", Icon: BookOpen },
  { id: "jobs", title: "İşler", Icon: Briefcase },
  { id: "organizations", title: "Organizasyonlar", Icon: Building2 },
  { id: "roles", title: "Roller", Icon: KeyRound },
  { id: "invitations", title: "Davetler", Icon: MailPlus },
  { id: "prompts", title: "Ajan promptları", Icon: ScrollText },
  { id: "maintenance", title: "Bakım", Icon: Archive },
  { id: "installations", title: "Kurulumlar", Icon: Settings },
  { id: "projects", title: "Projeler ve ayarlar", Icon: Folder },
  { id: "models", title: "Modeller ve tüketim", Icon: Database },
  { id: "logs", title: "Log ve teşhis", Icon: FileText },
];
function App() {
  const [account, setAccount] = useState<Account | null | undefined>(undefined),
    [error, setError] = useState(""),
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
      setAccount(next);
      setProject((current) =>
        next.projects.some((item) => item.id === current)
          ? current
          : (next.projects[0]?.id ?? ""),
      );
      setError("");
    } catch (error) {
      if (error instanceof ApiError && error.status === 401) setAccount(null);
      else
        setError(
          error instanceof Error ? error.message : "Servise ulaşılamadı.",
        );
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
  if (error)
    return (
      <main className="login">
        <h1>Servise ulaşılamadı</h1>
        <p role="alert">{error}</p>
        <button onClick={() => void load()}>Yeniden dene</button>
      </main>
    );
  if (account === undefined)
    return (
      <main className="login" role="status">
        Yükleniyor…
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
            <h1>Sayfa bulunamadı</h1>
            <a href="#overview">Genel duruma dön</a>
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
        İçeriğe geç
      </a>
      <aside>
        <a className="brand" href="#overview">
          Skill Forge
        </a>
        <nav aria-label="Ana gezinme">
          {navigation.map(({ id, title, Icon }) => (
            <a
              href={`#${id}`}
              key={id}
              aria-current={page === id ? "page" : undefined}
            >
              <Icon size={20} strokeWidth={1.7} />
              <span>{title}</span>
            </a>
          ))}
        </nav>
      </aside>
      <div className="workspace">
        <header>
          <button
            className="icon-button menu-toggle"
            aria-label="Menüyü aç veya kapat"
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
            <button
              className="icon-button"
              aria-label="Çıkış yap"
              title="Çıkış yap"
              onClick={() =>
                void api("/api/logout", { method: "POST" })
                  .then(() => setAccount(null))
                  .catch((error) => setError(String(error)))
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
          key={`${page}:${project}`}
        >
          {content}
        </main>
      </div>
    </div>
  );
}
createRoot(document.getElementById("root")!).render(<App />);
