import assert from "node:assert/strict";
import { access } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { InvalidInput, loadAds, toReplacements, type Ad } from "../src/ads.ts";

const ad: Ad = {
  id: "tour",
  order: 1,
  name: "Tour teaser",
  project: "Live ad builder: tour teaser",
  fields: [
    { id: "title", label: "Title", layer: "Title", maxLength: 16 },
    { id: "price", label: "Price", layer: "Price", maxLength: 8 },
  ],
  pictures: [
    {
      id: "venue", label: "Venue", layers: ["Venue (opening)", "Venue (ending)"], fit: "cover",
      choices: [
        { id: "stadium", label: "Stadium", path: "images/crowd.jpg" },
        { id: "opera", label: "Opera", path: "images/venues/opera.jpg", also: [{ layer: "Tickets", path: "images/venues/opera-tickets.png" }] },
      ],
    },
    { id: "artist", label: "Artist", layers: ["Artist"], fit: "contain", choices: [{ id: "rocker", label: "Rocker", path: "images/artist.png" }] },
  ],
};

const layers = new Map([
  ["Title", "/assets/5/layers/4"],
  ["Price", "/assets/6/layers/0"],
  ["Venue (opening)", "/assets/5/layers/11"],
  ["Venue (ending)", "/assets/8/layers/11"],
  ["Tickets", "/assets/7/layers/10"],
  ["Artist", "/assets/5/layers/5"],
]);

const ids = ["0f8e0d52-6bd4-4c4f-9a43-3c4b0b1f2a10", "1a2b3c4d-6bd4-4c4f-9a43-3c4b0b1f2a10"];

test("filled fields and a picture's other choice become replacements; blank fields and first choices keep the template", () => {
  assert.deepEqual(toReplacements(ad, { values: { title: "  DESERT ", price: "" }, picks: { venue: "opera", artist: "rocker" } }, layers), [
    { layer: "/assets/5/layers/4", text: "DESERT" },
    { layer: "/assets/5/layers/11", path: "images/venues/opera.jpg", fit: "cover" },
    { layer: "/assets/8/layers/11", path: "images/venues/opera.jpg", fit: "cover" },
    { layer: "/assets/7/layers/10", path: "images/venues/opera-tickets.png", fit: "contain" },
  ]);
});

test("an uploaded photo fills each of the picture's layers with its own upload", () => {
  assert.deepEqual(toReplacements(ad, { picks: { venue: "upload" }, uploads: { venue: { uploadIds: ids, extension: "jpg" } } }, layers), [
    { layer: "/assets/5/layers/11", file: { path: `images/upload-${ids[0]}.jpg`, uploadId: ids[0] }, fit: "cover" },
    { layer: "/assets/8/layers/11", file: { path: `images/upload-${ids[1]}.jpg`, uploadId: ids[1] }, fit: "cover" },
  ]);
  assert.throws(() => toReplacements(ad, { picks: { venue: "upload" }, uploads: { venue: { uploadIds: ids.slice(1), extension: "jpg" } } }, layers),
    /Upload an image for venue first/);
});

test("too-long or non-text values, unknown choices and an unchanged form are refused", () => {
  assert.throws(() => toReplacements(ad, { values: { price: "$1,000,000" } }, layers), InvalidInput);
  assert.throws(() => toReplacements(ad, { values: { title: 42 } }, layers), /Title must be text/);
  assert.throws(() => toReplacements(ad, { picks: { venue: "../secrets" } }, layers), /Choose one of the venue pictures/);
  assert.throws(() => toReplacements(ad, { values: { title: " " }, picks: { venue: "stadium" } }, layers), /Change at least one field or picture/);
});

test("every ad's choices, sample and poster are files it carries", async () => {
  const ads = await loadAds();
  assert.ok(ads.length > 0);
  for (const each of ads) {
    for (const picture of each.pictures) {
      for (const choice of picture.choices) {
        for (const path of [choice.path, ...(choice.also ?? []).map((a) => a.path)]) await access(join("ads", each.id, "template", path));
      }
    }
    for (const file of [each.sample, each.poster]) if (file) await access(join("ads", each.id, file));
  }
});
