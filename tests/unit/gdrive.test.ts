import { describe, expect, it } from "vitest";
import { DriveAuthError, DriveRest, driveConfigFromEnv } from "../../src/gdrive";

interface Call {
  url: string;
  method: string;
  headers: Headers;
  body: unknown;
}

/** A fetch that records each call and answers from `reply`. */
function stubFetch(reply: (c: Call) => Response) {
  const calls: Call[] = [];
  const fn = (async (url: string, init: RequestInit = {}) => {
    const c = { url, method: init.method ?? "GET", headers: new Headers(init.headers), body: init.body };
    calls.push(c);
    return reply(c);
  }) as unknown as typeof fetch;
  return { calls, fn };
}

const json = (o: unknown, status = 200) => new Response(JSON.stringify(o), { status, headers: { "Content-Type": "application/json" } });

describe("driveConfigFromEnv", () => {
  it("needs all three settings", () => {
    expect(driveConfigFromEnv({})).toBeNull();
    expect(driveConfigFromEnv({ VITE_GOOGLE_CLIENT_ID: "c", VITE_GOOGLE_API_KEY: "k" })).toBeNull();
    expect(driveConfigFromEnv({ VITE_GOOGLE_CLIENT_ID: "c", VITE_GOOGLE_API_KEY: "k", VITE_GOOGLE_APP_ID: "1" })).toEqual({ clientId: "c", apiKey: "k", appId: "1" });
  });
});

describe("DriveRest", () => {
  it("sends the token and downloads bytes with the file's version", async () => {
    const { calls, fn } = stubFetch((c) =>
      c.url.includes("alt=media") ? new Response(new Uint8Array([37, 80, 68, 70])) : json({ id: "f1", name: "a.pdf", version: "7", trashed: false }),
    );
    const rest = new DriveRest(async () => "tok", fn);
    const { file, bytes } = await rest.download("f1");
    expect(file).toEqual({ id: "f1", name: "a.pdf", version: "7" });
    expect([...bytes]).toEqual([37, 80, 68, 70]);
    expect(calls.map((c) => c.headers.get("Authorization"))).toEqual(["Bearer tok", "Bearer tok"]);
  });

  it("reports a trashed or missing file as having no version", async () => {
    const trashed = new DriveRest(async () => "t", stubFetch(() => json({ id: "f", name: "a.pdf", version: "3", trashed: true })).fn);
    expect(await trashed.version("f")).toBeNull();
    const missing = new DriveRest(async () => "t", stubFetch(() => json({ error: { message: "File not found" } }, 404)).fn);
    expect(await missing.version("f")).toBeNull();
  });

  it("updates the file's content in place", async () => {
    const { calls, fn } = stubFetch(() => json({ id: "f1", name: "a.pdf", version: "8" }));
    const rest = new DriveRest(async () => "t", fn);
    expect(await rest.update("f1", new Uint8Array([1, 2]))).toEqual({ id: "f1", name: "a.pdf", version: "8" });
    expect(calls[0].method).toBe("PATCH");
    expect(calls[0].url).toContain("/upload/drive/v3/files/f1?uploadType=media");
    expect(calls[0].headers.get("Content-Type")).toBe("application/pdf");
  });

  it("creates a new PDF with a multipart upload", async () => {
    const { calls, fn } = stubFetch(() => json({ id: "new", name: "notes.pdf", version: "1" }));
    const rest = new DriveRest(async () => "t", fn);
    await rest.create("notes.pdf", new TextEncoder().encode("%PDF-x"));
    const c = calls[0];
    expect(c.method).toBe("POST");
    expect(c.url).toContain("uploadType=multipart");
    const boundary = /boundary=(\S+)/.exec(c.headers.get("Content-Type") ?? "")?.[1];
    const body = await (c.body as Blob).text();
    expect(body).toContain(`--${boundary}\r\nContent-Type: application/json`);
    expect(body).toContain(JSON.stringify({ name: "notes.pdf", mimeType: "application/pdf" }));
    expect(body).toContain("%PDF-x");
    expect(body.endsWith(`--${boundary}--`)).toBe(true);
  });

  it("turns a 401 into a sign-in error and other failures into a readable one", async () => {
    const expired = new DriveRest(async () => "t", stubFetch(() => new Response("", { status: 401 })).fn);
    await expect(expired.update("f", new Uint8Array())).rejects.toBeInstanceOf(DriveAuthError);
    const full = new DriveRest(async () => "t", stubFetch(() => json({ error: { message: "The user's Drive storage quota has been exceeded." } }, 403)).fn);
    await expect(full.update("f", new Uint8Array())).rejects.toThrow(/HTTP 403: The user's Drive storage quota/);
  });
});
