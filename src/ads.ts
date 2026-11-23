// The ads people can build, read from ads/<id>/ad.json, and how a filled form becomes replacements. Pure functions apart from loading,
// so they are tested without calling the API.

import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import type { Replacement } from "./blitframe.ts";

type Fit = "contain" | "cover";

export type Field = { id: string; label: string; layer: string; maxLength: number };

// A choice fills the picture's layers with a file the template carries, and `also` sets more layers to go with it, such as a venue's
// tickets. The first choice is what the template already shows.
export type Choice = { id: string; label: string; path: string; also?: { layer: string; path: string; fit?: Fit }[] };

export type Picture = { id: string; label: string; layers: string[]; fit: Fit; uploadHint?: string; choices: Choice[] };

// The sample is a render of the ad as designed, shipped with the example, so the stage shows the ad before anyone renders; the poster is
// a frame of it for the ad's tab.
export type Ad = {
  id: string; order: number; name: string; project: string; sample?: string; poster?: string; fields: Field[]; pictures: Picture[];
};

// An image someone uploaded for a picture: one upload per layer it fills, because each upload goes into one layer of one render.
export type Upload = { uploadIds: string[]; extension: string };

export const UPLOADED = "upload";

export const IMAGE_TYPES: Record<string, string> = { "image/png": "png", "image/jpeg": "jpg", "image/webp": "webp" };

export class InvalidInput extends Error {}

export async function loadAds(folder = "ads"): Promise<Ad[]> {
  const ids = (await readdir(folder, { withFileTypes: true })).filter((e) => e.isDirectory()).map((e) => e.name);
  const ads = await Promise.all(ids.map(async (id) => {
    const config = await readFile(join(folder, id, "ad.json"), "utf8").catch(() => null);
    return config ? { id, ...JSON.parse(config) } as Ad : null;
  }));
  return ads.filter((ad) => ad !== null).sort((a, b) => a.order - b.order);
}

// A blank field keeps the template's text, and a picture left on its first choice keeps the template's file.
export function toReplacements(ad: Ad, input: unknown, layerIds: Map<string, string>): Replacement[] {
  const form = isRecord(input) ? input : {};
  const values = isRecord(form.values) ? form.values : {};
  const picks = isRecord(form.picks) ? form.picks : {};
  const uploads = isRecord(form.uploads) ? form.uploads : {};
  const layer = (name: string) => {
    const id = layerIds.get(name);
    if (!id) throw new Error(`The template has no layer named "${name}".`);
    return id;
  };
  const replacements: Replacement[] = [];

  for (const field of ad.fields) {
    const value = values[field.id];
    if (value !== undefined && typeof value !== "string") throw new InvalidInput(`${field.label} must be text.`);
    const text = value?.trim() ?? "";
    if (text.length > field.maxLength) throw new InvalidInput(`${field.label} can be at most ${field.maxLength} characters.`);
    if (text) replacements.push({ layer: layer(field.layer), text });
  }

  for (const picture of ad.pictures) {
    const pick = picks[picture.id] ?? picture.choices[0].id;
    if (pick === UPLOADED) {
      const upload = uploads[picture.id];
      if (!isUpload(upload, picture.layers.length)) throw new InvalidInput(`Upload an image for ${picture.label.toLowerCase()} first.`);
      picture.layers.forEach((name, i) => {
        const uploadId = upload.uploadIds[i];
        replacements.push({ layer: layer(name), file: { path: `images/upload-${uploadId}.${upload.extension}`, uploadId }, fit: picture.fit });
      });
      continue;
    }
    const index = picture.choices.findIndex((c) => c.id === pick);
    if (index < 0) throw new InvalidInput(`Choose one of the ${picture.label.toLowerCase()} pictures, or upload your own.`);
    if (index === 0) continue;
    const choice = picture.choices[index];
    for (const name of picture.layers) replacements.push({ layer: layer(name), path: choice.path, fit: picture.fit });
    for (const extra of choice.also ?? []) replacements.push({ layer: layer(extra.layer), path: extra.path, fit: extra.fit ?? "contain" });
  }

  if (replacements.length === 0) throw new InvalidInput("Change at least one field or picture.");
  return replacements;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isUpload(value: unknown, count: number): value is Upload {
  const upload = value as Upload | undefined;
  return Array.isArray(upload?.uploadIds) && upload.uploadIds.length === count
    && upload.uploadIds.every((id) => typeof id === "string" && /^[0-9a-f-]{36}$/i.test(id))
    && Object.values(IMAGE_TYPES).includes(upload.extension);
}
