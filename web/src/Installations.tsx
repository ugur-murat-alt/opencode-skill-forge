import { useState } from "react";
import { Copy, ExternalLink } from "lucide-react";
import { useResource, ErrorNotice, Empty, Status, date } from "./ui";
export function Installations({ project }: { project: string }) {
  const resource = useResource<{
    items: {
      id: string;
      client: string;
      version: string | null;
      directory: string;
      health: string;
      last_seen: number | null;
      capabilities: { prepare_mode: string };
    }[];
  }>(`/api/installations?project_ref=${encodeURIComponent(project)}`);
  const [client, setClient] = useState("codex"),
    [directory, setDirectory] = useState(""),
    [copied, setCopied] = useState(false),
    [error, setError] = useState("");
  const quoted = (text: string) => `'${text.replace(/'/g, `'"'"'`)}'`;
  const command = `skill-forge install --client ${client} --project ${quoted(directory || "/proje/dizini")} --project-ref ${quoted(project)}`;
  return (
    <>
      <h1>Kurulumlar</h1>
      <p className="subtitle">
        Resmi MCP ve hook bağlantıları. Bağlantı durumu son gözlenen olaya
        dayanır.
      </p>
      <ErrorNotice message={resource.error || error} />
      <section className="panel">
        <h2>Claude Code veya Codex bağla</h2>
        <p>
          Skill Forge’un kurulu olduğu cihazda proje dizinini seçin. Kurulum
          mevcut ayarları korur ve özel veri dizininde yedekler.
        </p>
        <div className="form-grid">
          <label>
            İstemci
            <select value={client} onChange={(e) => setClient(e.target.value)}>
              <option value="codex">Codex</option>
              <option value="claude">Claude Code</option>
            </select>
          </label>
          <label>
            Yerel proje dizini
            <input
              value={directory}
              onChange={(e) => setDirectory(e.target.value)}
              placeholder="/home/kullanıcı/proje"
            />
          </label>
        </div>
        <pre className="code-view">{command}</pre>
        <button
          onClick={() =>
            void navigator.clipboard
              .writeText(command)
              .then(() => setCopied(true))
              .catch(() => setError("Panoya kopyalanamadı."))
          }
        >
          <Copy size={16} />
          {copied ? "Kopyalandı" : "Komutu kopyala"}
        </button>
        <p className="helper">
          {client === "codex"
            ? "Codex’te /hooks ile yeni hook tanımlarını inceleyip güvenin. Bu istemci denetimi kurulum tarafından atlanmaz."
            : "Claude Code’da proje MCP bağlantısını istemcinin güven ekranından etkinleştirin."}{" "}
          Prompt hook’u ek bağlam verir; görünür kullanıcı metnini değiştirmez.
        </p>
      </section>
      <section className="panel">
        <h2>ChatGPT App</h2>
        <p>
          HTTPS sunucu profilinin MCP adresini ChatGPT bağlantı ayarlarına
          ekleyin ve kurumsal OAuth hesabıyla oturum açın. Yerel loopback adresi
          ChatGPT tarafından uzaktan erişilebilir değildir.
        </p>
        <p>
          Prepare ve handoff araç seçimine bağlıdır; zorunlu bir istemci hook’u
          olduğu iddia edilmez.
        </p>
        <a
          className="button"
          href="https://developers.openai.com/plugins/build/auth"
          target="_blank"
          rel="noreferrer"
        >
          <ExternalLink size={16} /> Resmi bağlantı sözleşmesi
        </a>
      </section>
      <section className="panel table-panel">
        <h2>Gözlenen kurulumlar</h2>
        <table>
          <thead>
            <tr>
              <th>İstemci</th>
              <th>Proje dizini</th>
              <th>Durum</th>
              <th>Son bağlantı</th>
            </tr>
          </thead>
          <tbody>
            {resource.data?.items.map((item) => (
              <tr key={item.id}>
                <td>
                  {item.client}
                  <small className="description">
                    {item.version ?? "Sürüm bildirilmedi"}
                  </small>
                </td>
                <td className="mono">{item.directory}</td>
                <td>
                  <Status value={item.health} />
                </td>
                <td>
                  {item.last_seen ? date(item.last_seen) : "Henüz gözlenmedi"}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {resource.data?.items.length === 0 && (
          <Empty title="Henüz kayıtlı istemci yok" />
        )}
      </section>
    </>
  );
}
