import { App } from "./app";
import { stylusSim } from "./harness/stylus-sim";

const app = new App(document.getElementById("pages") as HTMLElement);

const $ = (id: string) => document.getElementById(id) as HTMLElement;

$("btn-open").onclick = () => void app.open();
$("btn-new").onclick = () => void (app.storage === "server" ? app.newNotebook() : app.newDocument());
$("btn-save").onclick = () => void app.save();
$("btn-saveas").onclick = () => void app.saveAs();
$("btn-addpage").onclick = () => void app.addPage();
$("btn-import").onclick = () => void app.importLocal();
$("btn-export").onclick = () => void app.exportLocal();
$("tool-pen").onclick = () => app.setTool("pen");
$("tool-eraser").onclick = () => app.setTool("eraser");
$("tool-select").onclick = () => app.setTool("select");
const barrel = $("barrel-erase") as HTMLInputElement;
try {
  barrel.checked = localStorage.getItem("pdfink.barrelErase") !== "0";
} catch {
  /* storage blocked */
}
app.setBarrelHeuristic(barrel.checked);
const finger = $("finger-draws") as HTMLInputElement;
{
  let stored: string | null = null;
  try {
    stored = localStorage.getItem("pdfink.fingerDraws");
  } catch {
    /* storage blocked */
  }
  // Default on where there is nothing finer than a finger (phones, pen-less tablets).
  finger.checked = stored !== null ? stored === "1" : !matchMedia("(any-pointer: fine)").matches;
  app.fingerDrawsPinned = stored === "1";
  app.setFingerDraws(finger.checked);
}
finger.onchange = () => {
  app.setFingerDraws(finger.checked);
  app.fingerDrawsPinned = finger.checked;
  try {
    localStorage.setItem("pdfink.fingerDraws", finger.checked ? "1" : "0");
  } catch {
    /* storage blocked */
  }
};
app.onFingerDrawsChanged = (on) => {
  finger.checked = on;
};
barrel.onchange = () => {
  app.setBarrelHeuristic(barrel.checked);
  try {
    localStorage.setItem("pdfink.barrelErase", barrel.checked ? "1" : "0");
  } catch {
    /* storage blocked */
  }
};
$("btn-copy").onclick = () => app.copy();
$("btn-cut").onclick = () => app.cut();
$("btn-paste").onclick = () => void app.pasteFromButton();
$("btn-undo").onclick = () => app.undo();
$("btn-redo").onclick = () => app.redo();
$("btn-zoom-in").onclick = () => app.zoom(1.25);
$("btn-zoom-out").onclick = () => app.zoom(0.8);
$("btn-zoom-fit").onclick = () => app.fitWidth();

const color = $("pen-color") as HTMLInputElement;
color.oninput = () => (app.penColor = color.value);
const width = $("pen-width") as HTMLSelectElement;
width.onchange = () => (app.penWidth = Number(width.value));

const select = $("notebook-select") as HTMLSelectElement;

function showCurrentNotebook(): void {
  select.value = app.source.kind === "server" ? app.source.name : "";
}

async function refreshNotebooks(): Promise<void> {
  if (app.storage !== "server") return;
  try {
    const list = await app.refreshNotebooks();
    const current = app.source.kind === "server" ? app.source.name : "";
    select.replaceChildren();
    const ph = document.createElement("option");
    ph.value = "";
    ph.disabled = true;
    ph.textContent = list.length ? "Open notebook…" : "No notebooks yet";
    select.appendChild(ph);
    for (const n of list) {
      const o = document.createElement("option");
      o.value = n.name;
      const mb = n.size / (1024 * 1024);
      o.textContent = `${n.name} (${mb < 1 ? mb.toFixed(2) : mb.toFixed(0)} MB)`;
      select.appendChild(o);
    }
    select.value = current;
  } catch (err) {
    app.setStatus((err as Error).message);
  }
}
app.onNotebooksChanged = () => void refreshNotebooks();
select.onchange = () => {
  const name = select.value;
  if (!name) return;
  void app.openNotebook(name).then(showCurrentNotebook);
};

const fileInput = $("file-input") as HTMLInputElement;
fileInput.onchange = () => {
  const f = fileInput.files?.[0];
  if (f) void (app.storage === "server" ? app.importFile(f).then(showCurrentNotebook) : app.openFile(f));
  fileInput.value = "";
};

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
  if (mode === "server") void refreshNotebooks();
  if (params.has("new")) void app.newDocument();
  const openName = params.get("open");
  if (openName && mode === "server") void app.openNotebook(openName).then(showCurrentNotebook);
});
