import { Maintenance } from "./Maintenance";
import { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import {
  Archive,
  Home,
  BookOpen,
  Briefcase,
  Pencil,
  Settings,
  Folder,
  Database,
  FileText,
  Menu,
  LogOut,
} from "lucide-react";
import { api, ApiError, type Account } from "./api";
import { Login } from "./Login";
import { Projects } from "./Projects";
import { Overview } from "./Overview";
import { Library } from "./Library";
import { Jobs } from "./Jobs";
import { PromptEditor } from "./PromptEditor";
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
  { id: "prompt", title: "Prompt Editor", Icon: Pencil },
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
    [menu, setMenu] = useState(false);
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
      admin={account.role === "owner" || account.role === "admin"}
      userId={account.identity.userId}
      onChange={load}
    />
  );
  const pages: Record<string, React.ReactNode> = {
    overview: <Overview project={project} />,
    library: <Library project={project} />,
    jobs: <Jobs project={project} />,
    prompt: <PromptEditor project={project} />,
    maintenance: <Maintenance key={project} project={project} />,
    installations: <Installations project={project} />,
    projects,
    models: <Models project={project} />,
    logs: <Logs project={project} />,
  };
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
            <label className="project-switcher">
              <span className="sr-only">Etkin proje</span>
              <select
                value={project}
                onChange={(e) => setProject(e.target.value)}
              >
                {!account.projects.length && (
                  <option value="">Proje seçin</option>
                )}
                {account.projects.map((item) => (
                  <option value={item.id} key={item.id}>
                    {item.name}
                  </option>
                ))}
              </select>
            </label>
            <span className="workspace-name">
              <Briefcase size={17} />
              {account.identity.tenantId === "local"
                ? "Kişisel çalışma alanı"
                : account.identity.tenantId}
            </span>
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
          {!project
            ? projects
            : (pages[page] ?? (
                <>
                  <h1>Sayfa bulunamadı</h1>
                  <a href="#overview">Genel duruma dön</a>
                </>
              ))}
        </main>
      </div>
    </div>
  );
}
createRoot(document.getElementById("root")!).render(<App />);
