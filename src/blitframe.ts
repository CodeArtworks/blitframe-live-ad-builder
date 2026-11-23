// A small Blitframe API client: just the calls this example makes, typed, with one error type.
// API reference: https://codeartworks.com/reference/blitframe

import { readdir, readFile } from "node:fs/promises";
import { join, relative, sep } from "node:path";

export const DEFAULT_API = "https://blitframe.codeartworks.com/v1";

export type Replacement =
  | { layer: string; text: string }
  | { layer: string; path: string; fit?: "contain" | "cover" }
  | { layer: string; file: { path: string; uploadId: string }; fit?: "contain" | "cover" };

export type Version = { id: string; projectId: string; renderable: boolean; problems: string[] };

export type Layer = { layer: string; name: string; text?: string };

export type Render = {
  id: string;
  status: "queued" | "rendering" | "succeeded" | "failed" | "cancelled";
  playback: "preparing" | "streaming" | "complete" | null;
  error: { code: string; message: string } | null;
  output: { hlsUrl: string | null; mp4Url: string | null; posterUrl: string | null } | null;
};

export class BlitframeError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(status: number, code: string, message: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

export class Blitframe {
  readonly #api: string;
  readonly #key: string;

  constructor(apiKey: string, api = DEFAULT_API) {
    this.#key = apiKey;
    this.#api = api.replace(/\/$/, "");
  }

  async request<T>(method: string, path: string, body?: unknown, headers: Record<string, string> = {}): Promise<T> {
    const response = await fetch(this.#api + path, {
      method,
      headers: { Authorization: `Bearer ${this.#key}`, "Content-Type": "application/json", ...headers },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await response.text();
    const json = text ? JSON.parse(text) : {};
    if (!response.ok) {
      throw new BlitframeError(response.status, json.error?.code ?? "unknown", json.error?.message ?? text);
    }
    return json as T;
  }

  // Finds the project by name, or creates it, then makes its head match the folder. Sending the same files again makes no new
  // version, so restarting the server reuses the template it pushed the first time.
  async pushTemplate(projectName: string, folder: string): Promise<Version> {
    const { items } = await this.request<{ items: { id: string; name: string }[] }>(
      "GET", `/projects?q=${encodeURIComponent(projectName)}`);
    const project = items.find((p) => p.name === projectName)
      ?? await this.request<{ id: string }>("POST", "/projects", { name: projectName });

    const files = [];
    for (const entry of await readdir(folder, { recursive: true, withFileTypes: true })) {
      if (!entry.isFile()) continue;
      const fullPath = join(entry.parentPath, entry.name);
      const path = relative(folder, fullPath).split(sep).join("/");
      const bytes = await readFile(fullPath);
      files.push(path.endsWith(".json")
        ? { path, content: bytes.toString("utf8") }
        : { path, contentBase64: bytes.toString("base64") });
    }

    const version = await this.request<Version>("POST", `/projects/${project.id}/versions`, { files, message: "Template" });
    if (!version.renderable) {
      throw new Error(`The template cannot be rendered:\n- ${version.problems.join("\n- ")}`);
    }
    return version;
  }

  // The template's text and image layers: the ids replacements use, their names and current text.
  layers(versionId: string): Promise<{ textLayers: Layer[]; imageLayers: Layer[]; videoLayers?: Layer[] }> {
    return this.request("GET", `/versions/${versionId}/layers`);
  }

  usage(): Promise<{ plan: string }> {
    return this.request("GET", "/usage");
  }

  // Create an upload, PUT the bytes to the address it returns, then complete it so Blitframe checks the file.
  async upload(fileName: string, bytes: Uint8Array<ArrayBuffer>): Promise<string> {
    const upload = await this.request<{ id: string; url: string }>("POST", "/uploads", { fileName, sizeBytes: bytes.byteLength });
    const put = await fetch(upload.url, { method: "PUT", body: bytes });
    if (!put.ok) throw new Error(`Uploading ${fileName} failed: ${put.status}`);

    const done = await this.request<{ status: string; error: { message: string } | null }>(
      "POST", `/uploads/${upload.id}/complete`, {}, { Prefer: "wait=30" });
    if (done.status !== "ready") throw new BlitframeError(422, "upload_refused", done.error?.message ?? `The image was ${done.status}.`);
    return upload.id;
  }

  render(versionId: string, name: string, replacements: Replacement[]): Promise<Render> {
    return this.request<Render>("POST", "/renders", { versionId, format: "hls", name, replacements });
  }

  getRender(renderId: string): Promise<Render> {
    return this.request<Render>("GET", `/renders/${renderId}`);
  }
}
