/**
 * Google Drive storage, entirely in the browser. The user picks a PDF with the
 * Google Picker; the app reads it and writes it back through the Drive REST
 * API with an OAuth token from Google Identity Services. Files never pass
 * through a pdfink server.
 *
 * The scope is drive.file: the app can only see files the user picked or the
 * app created, which keeps it out of Google's restricted-scope review.
 */

export const DRIVE_SCOPE = "https://www.googleapis.com/auth/drive.file";

export interface DriveFile {
  id: string;
  name: string;
  /** Drive's file version, bumped on every change; used to spot edits made elsewhere. */
  version: string;
}

/** What the app needs from Drive. GoogleDrive is the real one; tests pass a fake. */
export interface DriveBackend {
  /** Ask the user for a PDF. Null when they cancel. */
  pick(): Promise<DriveFile | null>;
  download(id: string): Promise<{ file: DriveFile; bytes: Uint8Array }>;
  /** Current version, or null when the file is gone or in the trash. */
  version(id: string): Promise<string | null>;
  update(id: string, bytes: Uint8Array): Promise<DriveFile>;
  create(name: string, bytes: Uint8Array): Promise<DriveFile>;
}

export interface DriveConfig {
  /** OAuth client ID (Web application) from the Google Cloud console. */
  clientId: string;
  /** API key, restricted to the Picker API and this site. */
  apiKey: string;
  /** Google Cloud project number; the Picker grants drive.file access to this app. */
  appId: string;
}

/** Drive settings baked in at build time, or null when Drive is not set up. */
export function driveConfigFromEnv(env: Record<string, string | undefined>): DriveConfig | null {
  const clientId = env.VITE_GOOGLE_CLIENT_ID;
  const apiKey = env.VITE_GOOGLE_API_KEY;
  const appId = env.VITE_GOOGLE_APP_ID;
  if (!clientId || !apiKey || !appId) return null;
  return { clientId, apiKey, appId };
}

export class DriveAuthError extends Error {}

const FIELDS = "id,name,version";
const API = "https://www.googleapis.com/drive/v3/files";
const UPLOAD = "https://www.googleapis.com/upload/drive/v3/files";

/**
 * The REST half, separate from sign-in and the Picker so it can be tested
 * with a stub fetch. `token()` returns a current access token.
 */
export class DriveRest {
  constructor(
    private token: () => Promise<string>,
    private fetchFn: typeof fetch = (...a) => fetch(...a),
  ) {}

  private async call(url: string, init: RequestInit = {}): Promise<Response> {
    const headers = new Headers(init.headers);
    headers.set("Authorization", `Bearer ${await this.token()}`);
    const res = await this.fetchFn(url, { ...init, headers });
    if (res.status === 401) throw new DriveAuthError("Google sign-in expired. Save again to sign in.");
    return res;
  }

  private static async fail(res: Response, what: string): Promise<never> {
    let detail = "";
    try {
      detail = ((await res.json()) as { error?: { message?: string } }).error?.message ?? "";
    } catch {
      /* not JSON */
    }
    throw new Error(`Google Drive could not ${what} (HTTP ${res.status}${detail ? `: ${detail}` : ""})`);
  }

  async metadata(id: string): Promise<(DriveFile & { trashed: boolean }) | null> {
    const res = await this.call(`${API}/${encodeURIComponent(id)}?fields=${FIELDS},trashed&supportsAllDrives=true`);
    if (res.status === 404) return null;
    if (!res.ok) return DriveRest.fail(res, "read the file's details");
    return (await res.json()) as DriveFile & { trashed: boolean };
  }

  async version(id: string): Promise<string | null> {
    const m = await this.metadata(id);
    return m && !m.trashed ? m.version : null;
  }

  async download(id: string): Promise<{ file: DriveFile; bytes: Uint8Array }> {
    const meta = await this.metadata(id);
    if (!meta) throw new Error("That file is no longer in Google Drive.");
    const res = await this.call(`${API}/${encodeURIComponent(id)}?alt=media&supportsAllDrives=true`);
    if (!res.ok) return DriveRest.fail(res, "download the file");
    const { id: fid, name, version } = meta;
    return { file: { id: fid, name, version }, bytes: new Uint8Array(await res.arrayBuffer()) };
  }

  async update(id: string, bytes: Uint8Array): Promise<DriveFile> {
    const res = await this.call(`${UPLOAD}/${encodeURIComponent(id)}?uploadType=media&fields=${FIELDS}&supportsAllDrives=true`, {
      method: "PATCH",
      headers: { "Content-Type": "application/pdf" },
      body: bytes as BodyInit,
    });
    if (!res.ok) return DriveRest.fail(res, "save the file");
    return (await res.json()) as DriveFile;
  }

  async create(name: string, bytes: Uint8Array): Promise<DriveFile> {
    const boundary = `pdfink${Math.random().toString(36).slice(2)}`;
    const head = `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify({ name, mimeType: "application/pdf" })}\r\n--${boundary}\r\nContent-Type: application/pdf\r\n\r\n`;
    const body = new Blob([head, bytes as BlobPart, `\r\n--${boundary}--`]);
    const res = await this.call(`${UPLOAD}?uploadType=multipart&fields=${FIELDS}&supportsAllDrives=true`, {
      method: "POST",
      headers: { "Content-Type": `multipart/related; boundary=${boundary}` },
      body,
    });
    if (!res.ok) return DriveRest.fail(res, "create the file");
    return (await res.json()) as DriveFile;
  }
}

// ------------------------------------------------------------------ Google's browser libraries

/* Just the parts of Google Identity Services and the Picker used here. */
interface TokenResponse {
  access_token?: string;
  expires_in?: number;
  error?: string;
  error_description?: string;
}
interface TokenClient {
  callback: (r: TokenResponse) => void;
  error_callback?: (e: { type?: string; message?: string }) => void;
  requestAccessToken(o?: { prompt?: string }): void;
}
interface PickerDoc {
  id: string;
  name: string;
}
interface PickerResult {
  action: string;
  docs?: PickerDoc[];
}
interface GoogleGlobal {
  accounts: { oauth2: { initTokenClient(o: { client_id: string; scope: string; callback: (r: TokenResponse) => void }): TokenClient } };
  picker: {
    Action: { PICKED: string; CANCEL: string };
    ViewId: { DOCS: string };
    DocsView: new (id: string) => { setMimeTypes(m: string): unknown; setIncludeFolders(b: boolean): unknown };
    PickerBuilder: new () => PickerBuilder;
  };
}
interface PickerBuilder {
  addView(v: unknown): PickerBuilder;
  setOAuthToken(t: string): PickerBuilder;
  setDeveloperKey(k: string): PickerBuilder;
  setAppId(id: string): PickerBuilder;
  setCallback(cb: (r: PickerResult) => void): PickerBuilder;
  build(): { setVisible(v: boolean): void };
}
declare global {
  interface Window {
    google?: GoogleGlobal;
    gapi?: { load(name: string, cb: () => void): void };
  }
}

const scripts = new Map<string, Promise<void>>();
function loadScript(src: string): Promise<void> {
  let p = scripts.get(src);
  if (!p) {
    p = new Promise<void>((resolve, reject) => {
      const s = document.createElement("script");
      s.src = src;
      s.async = true;
      s.onload = () => resolve();
      s.onerror = () => {
        scripts.delete(src);
        reject(new Error(`Could not load ${src}`));
      };
      document.head.appendChild(s);
    });
    scripts.set(src, p);
  }
  return p;
}

/** Drive through Google's own sign-in popup and Picker. */
export class GoogleDrive implements DriveBackend {
  private client: TokenClient | null = null;
  private accessToken: string | null = null;
  private expires = 0;
  private picker: Promise<void> | null = null;
  readonly rest = new DriveRest(() => this.token());

  constructor(private config: DriveConfig) {}

  private async google(): Promise<GoogleGlobal> {
    await loadScript("https://accounts.google.com/gsi/client");
    return window.google!;
  }

  /**
   * A current access token. Asking for a new one may open Google's popup,
   * which browsers only allow during a click, so call this early in a
   * click handler (Open from Drive, Save) before any other awaits.
   */
  async token(): Promise<string> {
    if (this.accessToken && Date.now() < this.expires) return this.accessToken;
    const g = await this.google();
    if (!this.client) {
      this.client = g.accounts.oauth2.initTokenClient({ client_id: this.config.clientId, scope: DRIVE_SCOPE, callback: () => {} });
    }
    const client = this.client;
    return new Promise<string>((resolve, reject) => {
      client.callback = (r) => {
        if (r.error || !r.access_token) {
          reject(new DriveAuthError(r.error_description ?? r.error ?? "Google sign-in failed"));
          return;
        }
        this.accessToken = r.access_token;
        // Renew a minute early so a save never starts with a token about to lapse.
        this.expires = Date.now() + ((r.expires_in ?? 3600) - 60) * 1000;
        resolve(r.access_token);
      };
      client.error_callback = (e) =>
        reject(
          new DriveAuthError(
            e.type === "popup_failed_to_open" ? "Google sign-in has to start from a click. Press Save to sign in again." : e.type === "popup_closed" ? "Google sign-in was closed." : (e.message ?? "Google sign-in failed."),
          ),
        );
      client.requestAccessToken({ prompt: this.accessToken ? "" : undefined });
    });
  }

  async pick(): Promise<DriveFile | null> {
    const token = await this.token();
    this.picker ??= loadScript("https://apis.google.com/js/api.js").then(() => new Promise<void>((r) => window.gapi!.load("picker", r)));
    await this.picker;
    const g = window.google!;
    const view = new g.picker.DocsView(g.picker.ViewId.DOCS);
    view.setMimeTypes("application/pdf");
    view.setIncludeFolders(true);
    const picked = await new Promise<PickerDoc | null>((resolve) => {
      new g.picker.PickerBuilder()
        .addView(view)
        .setOAuthToken(token)
        .setDeveloperKey(this.config.apiKey)
        .setAppId(this.config.appId)
        .setCallback((r) => {
          if (r.action === g.picker.Action.PICKED) resolve(r.docs?.[0] ?? null);
          else if (r.action === g.picker.Action.CANCEL) resolve(null);
        })
        .build()
        .setVisible(true);
    });
    if (!picked) return null;
    // The Picker doesn't report the version; download() fetches it with the bytes.
    return { id: picked.id, name: picked.name, version: "" };
  }

  download(id: string) {
    return this.rest.download(id);
  }
  version(id: string) {
    return this.rest.version(id);
  }
  update(id: string, bytes: Uint8Array) {
    return this.rest.update(id, bytes);
  }
  create(name: string, bytes: Uint8Array) {
    return this.rest.create(name, bytes);
  }
}
