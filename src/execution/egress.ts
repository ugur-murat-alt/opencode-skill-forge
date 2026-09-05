import { writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { command, SANDBOX_IMAGES } from "./docker.js";
import { ForgeError } from "../domain/errors.js";
/** Trusted CONNECT proxy; scripts only attach to its separate internal Docker network. */
export const PROXY_SOURCE = String.raw`
const http=require('node:http'),net=require('node:net'),dns=require('node:dns').promises;
const allowed=new Set(JSON.parse(process.env.FORGE_EGRESS_ORIGINS));
function public4(ip){const p=ip.split('.').map(Number);if(p.length!==4||p.some(n=>!Number.isInteger(n)||n<0||n>255))return false;const[a,b]=p;return !(a===0||a===10||a===127||a>=224||(a===100&&b>=64&&b<=127)||(a===169&&b===254)||(a===172&&b>=16&&b<=31)||(a===192&&(b===168||b===0))||(a===198&&(b===18||b===19||b===51))||(a===203&&b===0));}
let active=0;
const server=http.createServer((_req,res)=>{res.writeHead(403);res.end('CONNECT to an authorized HTTPS origin required');});
server.on('connect',async(req,client,head)=>{
 let upstream; let registered=false;
 const end=()=>{upstream?.destroy();client.destroy();};client.on('error',end);
 try{
  if(active>=16||head.length)throw Error('limit');
  const target=new URL('https://'+req.url);if(target.username||target.password||target.pathname!=='/'||target.search||target.hash||target.port&&target.port!=='443'||!allowed.has(target.origin))throw Error('denied');
  const resolved=await dns.lookup(target.hostname,{family:4,all:true});if(!resolved.length||resolved.some(row=>!public4(row.address)))throw Error('address');
  active++;registered=true;client.once('close',()=>{active--;upstream?.destroy();});
  upstream=net.connect({host:resolved[0].address,port:443});upstream.setTimeout(10000,end);client.setTimeout(10000,end);
  upstream.on('error',end);upstream.once('connect',()=>{client.write('HTTP/1.1 200 Connection Established\r\n\r\n');client.pipe(upstream);upstream.pipe(client);});
 }catch{client.end('HTTP/1.1 403 Forbidden\r\nContent-Length: 0\r\n\r\n');}
});server.headersTimeout=3000;server.requestTimeout=10000;server.maxConnections=32;server.listen(3128,'0.0.0.0');
`;
export class EgressNetwork {
  readonly network: string;
  readonly proxy: string;
  constructor(
    readonly id: string,
    readonly root: string,
  ) {
    this.network = `forge-net-${id}`;
    this.proxy = `forge-proxy-${id}`;
  }
  async start(
    requested: string[],
    permitted: readonly string[],
    signal?: AbortSignal,
  ) {
    const origins = requested.map((value) => {
      let url;
      try {
        url = new URL(value);
      } catch {
        throw new ForgeError(
          "network_policy_denied",
          "Ağ hedefi HTTPS origin olmalı.",
          403,
        );
      }
      if (
        url.protocol !== "https:" ||
        url.origin !== value ||
        url.username ||
        url.password ||
        (url.port && url.port !== "443") ||
        !permitted.includes(value)
      )
        throw new ForgeError(
          "network_policy_denied",
          "Script hedefi yönetici/proje ağ izin listesinde değil.",
          403,
        );
      return value;
    });
    const dir = join(this.root, "proxy");
    await mkdir(dir, { recursive: true, mode: 0o755 });
    await writeFile(join(dir, "proxy.cjs"), PROXY_SOURCE, { mode: 0o644 });
    try {
      const network = await command(
        "docker",
        ["network", "create", "--internal", this.network],
        { timeoutMs: 5000, signal },
      );
      if (network.code !== 0)
        throw new ForgeError(
          "sandbox_network_unavailable",
          "İzole script ağı kurulamadı.",
          503,
        );
      const proxy = await command(
        "docker",
        [
          "run",
          "--detach",
          "--rm",
          "--name",
          this.proxy,
          "--network",
          "bridge",
          "--read-only",
          "--user",
          "65534:65534",
          "--cap-drop",
          "ALL",
          "--security-opt",
          "no-new-privileges",
          "--memory",
          "96m",
          "--pids-limit",
          "32",
          "--cpus",
          "0.5",
          "--mount",
          `type=bind,src=${dir},dst=/proxy,readonly`,
          "--env",
          `FORGE_EGRESS_ORIGINS=${JSON.stringify(origins)}`,
          SANDBOX_IMAGES.node,
          "node",
          "/proxy/proxy.cjs",
        ],
        { timeoutMs: 10000, signal },
      );
      if (proxy.code !== 0)
        throw new ForgeError(
          "sandbox_network_unavailable",
          "Kısıtlı egress proxy başlatılamadı.",
          503,
        );
      const connect = await command(
        "docker",
        [
          "network",
          "connect",
          "--alias",
          "forge-egress",
          this.network,
          this.proxy,
        ],
        { timeoutMs: 5000, signal },
      );
      if (connect.code !== 0)
        throw new ForgeError(
          "sandbox_network_unavailable",
          "Proxy izole ağa bağlanamadı.",
          503,
        );
      return [
        "--network",
        this.network,
        "--env",
        "HTTPS_PROXY=http://forge-egress:3128",
        "--env",
        "HTTP_PROXY=http://forge-egress:3128",
        "--env",
        "NODE_USE_ENV_PROXY=1",
      ];
    } catch (error) {
      await this.close();
      throw error;
    }
  }
  async close() {
    await command("docker", ["rm", "--force", this.proxy], {
      timeoutMs: 5000,
      maxBytes: 4096,
    });
    await command("docker", ["network", "rm", this.network], {
      timeoutMs: 5000,
      maxBytes: 4096,
    });
  }
}
