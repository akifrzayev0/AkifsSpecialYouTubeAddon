// lib/netproxy.ts - the proxy for the host's own downloads (the update of the onedir yt-dlp build).
//
// Deno's fetch() follows HTTP_PROXY / HTTPS_PROXY / NO_PROXY, but not the proxy set in Windows (Settings > Network >
// Proxy, "Internet Options"), which networks with a mandatory proxy rely on. yt-dlp itself, pip and winget do use it
// (Python reads it from the registry), so without this the companion's own download of yt-dlp_win.zip failed where
// everything else worked. The rules are yt-dlp's (those of Python's urllib, and https goes through the http proxy when
// no https proxy is set), so the update goes the same way as the downloads:
//   1. HTTPS_PROXY (HTTP_PROXY for http): Deno's default client applies it, with NO_PROXY;
//   2. https with only HTTP_PROXY set: a client for that proxy (Deno's default client would connect directly), with
//      NO_PROXY; http with only HTTPS_PROXY set: a direct connection. A proxy variable means the Windows settings are
//      not used (Python ignores them then, too);
//   3. HKCU\...\Internet Settings: ProxyEnable = 1 and ProxyServer ("host:port", or "http=host:port;https=host:port";
//      https without an https= entry uses the http= one), except for hosts in ProxyOverride
//      ("<local>;*.corp.example;10.*");
//   4. otherwise a direct connection.
// Not supported: automatic configuration scripts (AutoConfigURL / PAC, WPAD), SOCKS, and proxies that need a Windows
// (NTLM / Kerberos) login. install.bat downloads through PowerShell, which handles all of them.

import { log } from "./log.ts";
import { regRead } from "./winshell.ts";

export interface WinProxySettings {
  enabled: boolean;
  server: string;
  override: string;
  autoConfigUrl: string;
}

const INTERNET_SETTINGS = "Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings";

/** The current user's Windows proxy settings (registry, read-only). */
export function windowsProxySettings(): WinProxySettings {
  const str = (name: string) => {
    const v = regRead("HKCU", INTERNET_SETTINGS, name);
    return typeof v === "string" ? v.trim() : "";
  };
  const enable = regRead("HKCU", INTERNET_SETTINGS, "ProxyEnable");
  return {
    enabled: typeof enable === "number" && enable !== 0,
    server: str("ProxyServer"),
    override: str("ProxyOverride"),
    autoConfigUrl: str("AutoConfigURL"),
  };
}

/**
 * The proxy URL for `scheme` from a ProxyServer value: "host:port" serves every protocol, "http=a:1;https=b:2" one
 * proxy per protocol. Without an https= entry, https uses the http= one, as yt-dlp does (Windows itself would connect
 * directly); http without an http= entry goes direct. null when there is none, or when it is a kind Deno cannot use
 * (socks=..., or a socks:// URL).
 */
export function proxyFromServer(server: string, scheme: "http" | "https"): string | null {
  const s = server.trim();
  if (!s) return null;
  let addr = "";
  if (!s.includes("=") && !s.includes(";")) addr = s;
  else {
    const entries = new Map<string, string>();
    for (const part of s.split(";")) {
      const i = part.indexOf("=");
      if (i > 0) entries.set(part.slice(0, i).trim().toLowerCase(), part.slice(i + 1).trim());
    }
    addr = entries.get(scheme) ?? (scheme === "https" ? entries.get("http") : undefined) ?? "";
  }
  if (!addr) return null;
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(addr)) return /^https?:\/\//i.test(addr) ? addr : null;
  return `http://${addr}`;
}

/** Is host in a ProxyOverride list ("<local>" = names without a dot; * and ? are wildcards)? */
export function bypassesProxy(host: string, override: string): boolean {
  const h = host.toLowerCase();
  for (const raw of override.split(";")) {
    const entry = raw.trim().toLowerCase();
    if (!entry) continue;
    if (entry === "<local>") {
      if (!h.includes(".")) return true;
      continue;
    }
    const re = entry.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*").replace(/\?/g, ".");
    if (new RegExp(`^${re}$`).test(h)) return true;
  }
  return false;
}

export interface NetRoute {
  /** for fetch(url, { client }); undefined: Deno's default client (direct, or the HTTP(S)_PROXY variables) */
  client?: Deno.HttpClient;
  /** how the connection is made, for logs and error messages */
  via: string;
  /** what to try when the connection fails */
  hint: string;
  close(): void;
}

const INSTALL_HINT = "running install.bat again also updates yt-dlp, through any proxy Windows can use";

/** Is host on a NO_PROXY list ("*" = every host; "corp.example" and ".corp.example" also cover its subdomains)? */
export function inNoProxy(host: string, noProxy: string): boolean {
  const h = host.toLowerCase();
  return noProxy.split(",").some((raw) => {
    const entry = raw.trim().toLowerCase().replace(/^\.+/, "");
    return entry === "*" || (entry !== "" && (h === entry || h.endsWith(`.${entry}`)));
  });
}

const direct = (via: string, hint = ""): NetRoute => ({ via, hint, close() {} });

/** A route with its own client for `proxy`; a direct connection when this Deno cannot use it. */
function proxyRoute(proxy: string, via: string, hint: string, fallbackHint: string): NetRoute {
  if (typeof Deno.createHttpClient !== "function") {
    log("warn", `this Deno ${Deno.version.deno} cannot use ${via}; connecting directly`);
    return direct(`a direct connection (this Deno cannot use ${via})`, fallbackHint);
  }
  let client: Deno.HttpClient;
  try {
    client = Deno.createHttpClient({ proxy: { url: proxy } });
  } catch (e) {
    log("warn", `${via} is not usable:`, String(e));
    return direct(`a direct connection (${via} is not usable)`, fallbackHint);
  }
  return { client, via, hint, close: () => client.close() };
}

/** How the host connects to `url` (see the header). `env` / `settings`: tests only. */
export function routeFor(
  url: string,
  env: (name: string) => string | undefined = (n) => Deno.env.get(n),
  settings: () => WinProxySettings = windowsProxySettings,
): NetRoute {
  const scheme = url.startsWith("http:") ? "http" : "https";
  const host = new URL(url).hostname;
  // (Windows environment names ignore case: this also finds https_proxy.)
  const own = scheme === "https" ? "HTTPS_PROXY" : "HTTP_PROXY";
  if (env(own)) return direct(`the proxy in the ${own} environment variable`, `check the ${own} environment variable`);
  const httpProxy = scheme === "https" ? env("HTTP_PROXY") : undefined;
  if (httpProxy) {
    // yt-dlp sends https through HTTP_PROXY when HTTPS_PROXY is not set (YoutubeDL.proxies); Deno's default client
    // uses HTTP_PROXY for http only. Deno applies NO_PROXY to this client too; it is checked here for the log.
    if (inNoProxy(host, env("NO_PROXY") ?? "")) return direct("a direct connection (NO_PROXY)");
    const proxy = /^[a-z][a-z0-9+.-]*:\/\//i.test(httpProxy) ? httpProxy : `http://${httpProxy}`;
    const hint = "check the HTTP_PROXY environment variable";
    return proxyRoute(proxy, "the proxy in the HTTP_PROXY environment variable", hint, hint);
  }
  // Only HTTPS_PROXY for an http URL: direct, as in yt-dlp. Like Python, it still means "no Windows proxy".
  if (scheme === "http" && env("HTTPS_PROXY")) return direct("a direct connection (HTTPS_PROXY is set, HTTP_PROXY is not)", "set HTTP_PROXY too");
  let s: WinProxySettings;
  try {
    s = settings();
  } catch (e) {
    log("debug", "proxy settings unreadable:", String(e));
    return direct("a direct connection");
  }
  const proxy = s.enabled ? proxyFromServer(s.server, scheme) : null;
  if (!proxy) {
    return s.autoConfigUrl
      ? direct("a direct connection", `Windows uses an automatic proxy configuration script, which the companion app cannot use; ${INSTALL_HINT}`)
      : direct("a direct connection");
  }
  if (bypassesProxy(host, s.override)) return direct("a direct connection (proxy bypass list)");
  return proxyRoute(proxy, `the Windows proxy ${proxy}`, `a proxy that needs a Windows sign-in is not supported; ${INSTALL_HINT}`, INSTALL_HINT);
}
