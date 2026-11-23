// The app's server. It keeps the API key, so the browser never sees it: the page calls these /api routes, and the server calls Blitframe.

import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { readFile, writeFile } from "node:fs/promises";
import { basename, extname, join, resolve, sep } from "node:path";
import { Blitframe, BlitframeError, DEFAULT_API } from "./blitframe.ts";
import { InvalidInput, loadAds, IMAGE_TYPES, toReplacements, type Ad } from "./ads.ts";

const port = Number(process.env.PORT || 3000);
const publicFolder = resolve("public");
const adsFolder = resolve("ads");
const maxImageBytes = 10_000_000;
const apiAddress = process.env.BLITFRAME || DEFAULT_API;

type Template = { versionId: string; layerIds: Map<string, string>; texts: Map<string, string>; seconds: number };

let blitframe: Blitframe | null = null;
let keyHint = "";
const templates = new Map<string, Promise<Template>>();

// A key in .env connects at start; without one, or with one Blitframe refuses, the page asks for a key.
const starting = process.env.BLITFRAME_API_KEY
  ? use(process.env.BLITFRAME_API_KEY).catch((error) => console.error(`The key in .env did not connect: ${error.message}`))
  : Promise.resolve();

async function use(apiKey: string) {
  const client = new Blitframe(apiKey, apiAddress);
  await client.usage();
  blitframe = client;
  keyHint = `…${apiKey.slice(-4)}`;
  templates.clear();
}

function connected(): Blitframe {
  if (!blitframe) throw new NoKey();
  return blitframe;
}

class NoKey extends Error {}

// Each ad's template is pushed the first time someone opens it, and every render after that pins that version.
function template(ad: Ad): Promise<Template> {
  if (!templates.has(ad.id)) {
    templates.set(ad.id, (async () => {
      const client = connected();
      const version = await client.pushTemplate(ad.project, join(adsFolder, ad.id, "template"));
      const { textLayers, imageLayers, videoLayers = [] } = await client.layers(version.id);
      const { fr, ip, op } = JSON.parse(await readFile(join(adsFolder, ad.id, "template", "data.json"), "utf8"));
      console.log(`${ad.name} ready: version ${version.id}`);
      return {
        seconds: Math.round((op - ip) / fr),
        versionId: version.id,
        layerIds: new Map([...textLayers, ...imageLayers, ...videoLayers].map((l) => [l.name, l.layer])),
        texts: new Map(textLayers.map((l) => [l.name, l.text ?? ""])),
      };
    })().catch((error) => {
      templates.delete(ad.id);
      throw error;
    }));
  }
  return templates.get(ad.id)!;
}

async function findAd(id: unknown): Promise<Ad> {
  const ad = (await loadAds(adsFolder)).find((a) => a.id === id);
  if (!ad) throw new InvalidInput("Unknown ad.");
  return ad;
}

const routes: Record<string, (request: IncomingMessage, url: URL) => Promise<unknown>> = {
  // Whether the server has a key Blitframe accepted. Only the key's last characters ever reach the page.
  "GET /api/connection": async () => {
    await starting;
    return blitframe ? { connected: true, keyHint } : { connected: false };
  },

  // A key from the page: checked with Blitframe, then kept by this server and saved to .env for the next start.
  "POST /api/connection": async (request) => {
    const apiKey = String(JSON.parse((await readBody(request, 10_000)).toString("utf8") || "{}").apiKey ?? "").trim();
    if (!/^[\w-]{16,200}$/.test(apiKey)) throw new InvalidInput("Paste the whole API key, as the console shows it.");
    try {
      await use(apiKey);
    } catch (error) {
      if (error instanceof BlitframeError && error.status === 401) throw new InvalidInput("Blitframe refused this key. Check it in the console and paste it again.");
      throw error;
    }
    await saveKey(apiKey);
    return { connected: true, keyHint };
  },

  "GET /api/ads": async () => {
    connected();
    const ads = await loadAds(adsFolder);
    return {
      ads: ads.map(({ id, name, poster }) => ({ id, name, poster: poster ? `/ads/${id}/${poster}` : null })),
      imageTypes: Object.keys(IMAGE_TYPES),
      maxImageBytes,
    };
  },

  // One ad's form: its fields filled with the template's own text, its pictures and its sample.
  "GET /api/ad": async (_request, url) => {
    const ad = await findAd(url.searchParams.get("id"));
    const { texts, seconds } = await template(ad);
    const file = (path: string) => `/ads/${ad.id}/template/${path}`;
    return {
      id: ad.id,
      name: ad.name,
      seconds,
      sample: ad.sample ? `/ads/${ad.id}/${ad.sample}` : null,
      fields: ad.fields.map(({ id, label, layer, maxLength }) => ({ id, label, maxLength, value: texts.get(layer) ?? "" })),
      pictures: ad.pictures.map(({ id, label, fit, uploadHint, choices }) => ({
        id, label, fit, uploadHint, choices: choices.map((c) => ({ id: c.id, label: c.label, src: file(c.path) })),
      })),
    };
  },

  // The browser sends an image's bytes here; the server uploads them to Blitframe once for each layer the picture fills.
  "POST /api/images": async (request, url) => {
    const client = connected();
    const ad = await findAd(url.searchParams.get("ad"));
    const picture = ad.pictures.find((p) => p.id === url.searchParams.get("picture"));
    if (!picture) throw new InvalidInput("Unknown picture.");
    const extension = IMAGE_TYPES[request.headers["content-type"] ?? ""];
    if (!extension) throw new InvalidInput("Choose a PNG, JPEG or WebP image.");
    const bytes = await readBody(request, maxImageBytes);
    const uploadIds = await Promise.all(picture.layers.map(() => client.upload(`image.${extension}`, bytes)));
    return { uploadIds, extension };
  },

  // An HLS render plays while it renders, so the page can show the first seconds before the rest is done.
  "POST /api/renders": async (request) => {
    const client = connected();
    const body = JSON.parse((await readBody(request, 100_000)).toString("utf8") || "{}");
    const ad = await findAd(body.ad);
    const { versionId, layerIds } = await template(ad);
    const render = await client.render(versionId, ad.name, toReplacements(ad, body, layerIds));
    return { id: render.id };
  },

  "GET /api/render": async (_request, url) => {
    const client = connected();
    const id = url.searchParams.get("id") ?? "";
    if (!/^[0-9a-f-]{36}$/i.test(id)) throw new InvalidInput("Unknown render.");
    const render = await client.getRender(id);
    return {
      status: render.status,
      playback: render.playback,
      hlsUrl: render.output?.hlsUrl ?? null,
      mp4Url: render.output?.mp4Url ?? null,
      posterUrl: render.output?.posterUrl ?? null,
      error: render.error?.message ?? null,
    };
  },
};

async function handle(request: IncomingMessage, response: ServerResponse) {
  const url = new URL(request.url ?? "/", "http://localhost");
  const route = routes[`${request.method} ${url.pathname}`];
  try {
    if (route) return send(response, 200, await route(request, url));
    if (request.method === "GET") return await serveFile(response, url.pathname);
    send(response, 404, { error: "Not found." });
  } catch (error) {
    if (error instanceof NoKey) return send(response, 401, { error: "Connect your Blitframe API key first.", code: "no_key" });
    if (error instanceof InvalidInput) return send(response, 400, { error: error.message });
    if (error instanceof BlitframeError && error.status < 500) return send(response, error.status, { error: error.message, code: error.code });
    console.error(error);
    send(response, 502, { error: "Blitframe could not be reached. Try again." });
  }
}

// Only this computer can reach the server, which holds the key. "localhost" can mean either address, so it listens on both.
createServer(handle).listen(port, "127.0.0.1", () => console.log(`Open http://localhost:${port}`));
createServer(handle).listen(port, "::1").on("error", () => {});

// The key goes to .env, which git ignores, so the next start connects on its own.
async function saveKey(apiKey: string) {
  const lines = (await readFile(".env", "utf8").catch(() => "")).split(/\r?\n/).filter((line) => line && !line.startsWith("BLITFRAME_API_KEY="));
  await writeFile(".env", [...lines, `BLITFRAME_API_KEY=${apiKey}`].join("\n") + "\n");
}

function send(response: ServerResponse, status: number, body: unknown) {
  response.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
  response.end(JSON.stringify(body));
}

async function readBody(request: IncomingMessage, limit: number): Promise<Buffer<ArrayBuffer>> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > limit) throw new InvalidInput(`The upload is larger than ${limit / 1_000_000} MB.`);
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

const contentTypes: Record<string, string> = {
  ".html": "text/html; charset=utf-8", ".css": "text/css", ".js": "text/javascript", ".mjs": "text/javascript", ".png": "image/png",
  ".jpg": "image/jpeg", ".webp": "image/webp", ".mp4": "video/mp4",
};

// The page and its script from public/, the ads' template images, samples and posters, and hls.js from node_modules.
async function serveFile(response: ServerResponse, pathname: string) {
  const path = decodeURIComponent(pathname);
  const file = path === "/vendor/hls.mjs"
    ? join("node_modules", "hls.js", "dist", "hls.mjs")
    : path.startsWith("/ads/")
      ? resolve(adsFolder, `.${path.slice("/ads".length)}`)
      : resolve(publicFolder, `.${path === "/" ? "/index.html" : path}`);
  const allowed = path === "/vendor/hls.mjs" || file.startsWith(publicFolder + sep)
    || (file.startsWith(adsFolder + sep) && (file.includes(`${sep}template${sep}images${sep}`) || ["sample.mp4", "poster.jpg"].includes(basename(file))));
  if (!allowed) return send(response, 404, { error: "Not found." });
  try {
    const body = await readFile(file);
    response.writeHead(200, { "Content-Type": contentTypes[extname(file)] ?? "application/octet-stream", "Cache-Control": "no-cache" });
    response.end(body);
  } catch {
    send(response, 404, { error: "Not found." });
  }
}
