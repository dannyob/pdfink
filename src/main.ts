import { App } from "./app";
import { installDeepLinks } from "./deeplink";
import { stylusSim } from "./harness/stylus-sim";
import { PageLink } from "./bridge-client";
import { createPdfinkApi } from "./pdfink-api";
import { Toolbar } from "./toolbar";

const app = new App(document.getElementById("pages") as HTMLElement);

const $ = (id: string) => document.getElementById(id) as HTMLElement;

const toolbar = new Toolbar(app, $("bar"));

const fileInput = $("file-input") as HTMLInputElement;
fileInput.onchange = () => {
  const f = fileInput.files?.[0];
  if (f) void (app.storage === "server" ? app.importFile(f) : app.openFile(f));
  fileInput.value = "";
};

// A long press with a pen or finger makes the browser offer its own context
// menu anywhere, including over the pen menu and the toolbar. This is a
// stylus app: the only context menu is ours (right-click on a page still
// opens it, see App).
document.addEventListener("contextmenu", (e) => e.preventDefault());

window.addEventListener("beforeunload", (e) => {
  if (app.dirty) e.preventDefault();
});
window.addEventListener("pagehide", () => {
  if (app.dirty && app.source.kind === "server") void app.saveToServer();
});
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "hidden" && app.dirty && app.source.kind === "server") void app.saveToServer();
});

declare global {
  interface Window {
    __pdfink: App;
    __stylusSim: typeof stylusSim;
  }
}
window.__pdfink = app;
window.__stylusSim = stylusSim;
const api = createPdfinkApi(app);
window.pdfink = api;

/**
 * Storage mode: `?storage=local|server` wins, then the VITE_STORAGE build
 * setting, else ask the server. A static host (no /api) means local mode.
 */
async function detectStorage(params: URLSearchParams): Promise<"server" | "local"> {
  const forced = params.get("storage") ?? import.meta.env.VITE_STORAGE;
  if (forced === "local" || forced === "server") return forced;
  try {
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), 3000);
    const res = await fetch("/api/status", { cache: "no-store", signal: ctl.signal });
    clearTimeout(t);
    if (!res.ok) return "local";
    const j = (await res.json()) as { mode?: string };
    return j.mode === "server" ? "server" : "local";
  } catch {
    return "local";
  }
}

const params = new URLSearchParams(location.search);
if (params.has("nofs")) app.forceDownload = true;
void detectStorage(params).then((mode) => {
  app.storage = mode;
  document.body.dataset.storage = mode;
  void app.refreshCommands();
  if (mode === "server") {
    const link = new PageLink(app, api);
    app.session = link.session;
    link.connect();
    void toolbar.refreshNotebooks();
  }
  toolbar.refresh();
  if (params.has("new")) void app.newDocument();
  installDeepLinks(app);
  const openName = params.get("f") ?? params.get("open");
  if (openName && mode === "server") void app.openNotebook(openName);
});
