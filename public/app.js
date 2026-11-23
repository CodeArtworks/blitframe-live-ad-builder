// The page: builds the form of the chosen ad, starts a render, plays its HLS stream as soon as the first seconds exist.
import Hls from "/vendor/hls.mjs";

const UPLOADED = "upload";
const $ = (id) => document.getElementById(id);
const form = $("ad-form");
const video = $("video");

let hls = null;
let current = 0;
let ad = null;
let limits = null;
const images = new Map();
const renders = [];

const connection = await api("/api/connection");
if (connection.connected) showKey(connection.keyHint);
else await askForKey(false);
$("change-key").addEventListener("click", () => askForKey(true).then(() => location.reload()));

const { ads, ...rest } = await api("/api/ads");
limits = rest;
buildTabs(ads);
await openAd(ads.find((a) => a.id === decodeURIComponent(location.hash.slice(1)))?.id ?? ads[0].id);

form.addEventListener("submit", async (event) => {
  event.preventDefault();
  const run = ++current;
  const started = performance.now();
  $("form-error").textContent = "";
  $("render").disabled = true;
  $("download").hidden = true;
  stop();
  $("placeholder").hidden = false;
  $("sample").play().catch(() => {});
  $("sample-caption").textContent = "Starting your render: it plays here as soon as its first seconds exist";
  show("");
  const ticker = setInterval(() => { $("timer").textContent = `${((performance.now() - started) / 1000).toFixed(1)} s`; }, 100);
  $("timer").hidden = false;

  try {
    const { values, picks } = readForm();
    const uploads = {};
    for (const picture of ad.pictures.filter((p) => picks[p.id] === UPLOADED)) {
      const image = images.get(picture.id);
      if (image.size > limits.maxImageBytes) throw new Error(`The ${picture.label.toLowerCase()} image is larger than ${limits.maxImageBytes / 1_000_000} MB.`);
      chip("Uploading");
      uploads[picture.id] = await api(`/api/images?ad=${encodeURIComponent(ad.id)}&picture=${encodeURIComponent(picture.id)}`,
        { method: "POST", headers: { "Content-Type": image.type }, body: image });
    }

    chip("Queued");
    const { id } = await api("/api/renders", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ad: ad.id, values, picks, uploads }),
    });
    const render = await follow(id, run, started, ad.seconds);
    if (render) remember(render, values);
  } catch (error) {
    $("form-error").textContent = error.message;
    chip(null);
  } finally {
    clearInterval(ticker);
    $("timer").hidden = true;
    if (run === current) $("render").disabled = false;
  }
});

// Asks for the render every second. Once its playback is streaming, the HLS address already plays what is rendered so far.
async function follow(id, run, started, length) {
  const seconds = () => ((performance.now() - started) / 1000).toFixed(1);
  let firstFrames = null;
  while (run === current) {
    const render = await api(`/api/render?id=${id}`);
    if (render.hlsUrl && !hls && !video.src) {
      if (render.status === "rendering") firstFrames = seconds();
      play(render.hlsUrl);
      show(`Playing ${seconds()} s after you pressed Render, while the rest renders.`);
    }
    if (render.status === "rendering") chip(render.hlsUrl ? "Live" : "Rendering");

    if (render.status === "succeeded") {
      chip("Done");
      result(firstFrames, seconds(), length);
      $("download").href = render.mp4Url;
      $("download").hidden = false;
      return { id, ...render };
    }
    if (render.status === "failed" || render.status === "cancelled") throw new Error(render.error ?? `The render was ${render.status}.`);
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
}

// Safari plays HLS itself; other browsers play it through hls.js.
// The sample stays up until the stream's first frame plays, so the stage never shows an empty player.
function play(url) {
  video.controls = false;
  video.loop = true;
  video.addEventListener("playing", () => {
    $("placeholder").hidden = true;
    $("sample").pause();
    video.controls = true;
  }, { once: true });
  if (Hls.isSupported()) {
    hls = new Hls();
    hls.loadSource(url);
    hls.attachMedia(video);
  } else {
    video.src = url;
  }
  video.play().catch(() => {});
}

function stop() {
  hls?.destroy();
  hls = null;
  video.removeAttribute("src");
  video.load();
}

function buildTabs(list) {
  $("ads").replaceChildren(...list.map((item) => {
    const tab = Object.assign(document.createElement("button"), { type: "button" });
    tab.innerHTML = `<img alt=""><span></span>`;
    if (item.poster) tab.querySelector("img").src = item.poster;
    tab.querySelector("span").textContent = item.name;
    tab.setAttribute("role", "tab");
    tab.dataset.id = item.id;
    tab.addEventListener("click", () => openAd(item.id));
    return tab;
  }));
}

async function openAd(id) {
  if (ad?.id === id) return;
  for (const tab of $("ads").children) tab.setAttribute("aria-selected", String(tab.dataset.id === id));
  form.classList.add("loading");
  try {
    ad = await api(`/api/ad?id=${encodeURIComponent(id)}`);
  } finally {
    form.classList.remove("loading");
  }
  window.history.replaceState(null, "", `#${id}`);
  images.clear();
  $("form-error").textContent = "";
  buildPictures();
  buildFields();
  showSample();
}

// Each picture offers the template's own choices and a tile for an image of your own.
function buildPictures() {
  $("pictures").replaceChildren(...ad.pictures.map((picture) => {
    const fieldset = document.createElement("fieldset");
    fieldset.className = "group";
    fieldset.innerHTML = `<legend class="group-label"></legend><div class="choices"></div>`;
    fieldset.querySelector("legend").textContent = picture.label;
    const choices = picture.choices.map((choice) => tile(picture, choice.id, choice.label, choice.src));
    fieldset.querySelector(".choices").append(...choices, uploadTile(picture));
    choices[0].querySelector("input").checked = true;
    return fieldset;
  }));
}

function tile(picture, value, label, src) {
  const element = document.createElement("label");
  element.className = `choice ${picture.fit}`;
  element.innerHTML = `<input type="radio"><span class="choice-art"><img alt=""></span><span class="choice-label"></span>`;
  Object.assign(element.querySelector("input"), { name: `pick-${picture.id}`, value });
  if (src) element.querySelector("img").src = src;
  element.querySelector(".choice-label").textContent = label;
  element.title = label;
  return element;
}

// Clicking the tile picks an image, or picks it again once one is chosen. An image can also be dropped on it.
function uploadTile(picture) {
  const element = tile(picture, UPLOADED, "Your image");
  element.classList.add("upload");
  element.title = picture.uploadHint ?? "";
  const radio = element.querySelector("input");
  const file = Object.assign(document.createElement("input"), { type: "file", accept: limits.imageTypes.join(","), hidden: true });
  element.append(file);
  const use = (image) => {
    if (!image) return;
    images.set(picture.id, image);
    element.querySelector("img").src = URL.createObjectURL(image);
    element.classList.add("filled");
    radio.checked = true;
  };
  element.addEventListener("click", (event) => {
    if (event.target === file) return;
    if (images.has(picture.id) && !radio.checked) return;
    event.preventDefault();
    file.click();
  });
  file.addEventListener("change", () => use(file.files[0]));
  element.addEventListener("dragover", (event) => { event.preventDefault(); element.classList.add("over"); });
  element.addEventListener("dragleave", () => element.classList.remove("over"));
  element.addEventListener("drop", (event) => {
    event.preventDefault();
    element.classList.remove("over");
    use(event.dataTransfer.files[0]);
  });
  return element;
}

function buildFields() {
  $("fields").replaceChildren(...ad.fields.map((field) => {
    const label = document.createElement("label");
    const input = Object.assign(document.createElement("input"), {
      name: field.id, maxLength: field.maxLength, autocomplete: "off", spellcheck: false,
    });
    input.dataset.default = field.value.replace(/\r|\n/g, " ");
    input.value = input.dataset.default;
    label.append(field.label, input);
    return label;
  }));
}

// The stage plays a sample render of the ad as designed until you render your own. A render on its way keeps the stage.
function showSample() {
  if (!ad.sample || $("render").disabled) return;
  stop();
  chip(null);
  $("download").hidden = true;
  $("placeholder").hidden = false;
  $("sample").src = ad.sample;
  $("sample").play().catch(() => {});
  $("sample-caption").textContent = `Sample: ${ad.name} as designed, rendered by Blitframe`;
  show("Your ad plays here a few seconds after you press Render.");
}

function readForm() {
  return {
    values: Object.fromEntries(ad.fields.map((f) => [f.id, form.elements[f.id].value])),
    picks: Object.fromEntries(ad.pictures.map((p) => [p.id, form.elements[`pick-${p.id}`].value])),
  };
}

// Finished renders stay playable from the strip below the stage while their links last (an hour for the MP4, six for HLS).
function remember(render, values) {
  const words = ad.fields.slice(0, 3).map((f) => values[f.id] || form.elements[f.id].dataset.default).filter(Boolean).join(" ");
  renders.unshift({ ...render, title: words || ad.name });
  $("history-section").hidden = false;
  $("history").replaceChildren(...renders.map((item) => {
    const li = document.createElement("li");
    const button = document.createElement("button");
    button.type = "button";
    button.innerHTML = `<img alt=""><span></span>`;
    if (item.posterUrl) button.querySelector("img").src = item.posterUrl;
    button.querySelector("span").textContent = item.title;
    button.addEventListener("click", () => {
      stop();
      play(item.hlsUrl);
      chip("Done");
      $("download").href = item.mp4Url;
      $("download").hidden = false;
    });
    li.append(button);
    return li;
  }));
}

// Someone who cloned the example connects their own account here. The key goes to this app's server, which checks it with Blitframe.
function askForKey(cancellable, reason = "") {
  const dialog = $("connect");
  $("connect-cancel").hidden = !cancellable;
  $("connect-error").textContent = reason;
  $("connection").className = cancellable ? "badge ok" : "badge failed";
  $("connection").textContent = cancellable ? "Production API" : "Not connected";
  if (!dialog.open) dialog.showModal();
  return new Promise((resolve) => {
    dialog.oncancel = (event) => { if (!cancellable) event.preventDefault(); };
    $("connect-cancel").onclick = () => dialog.close();
    $("connect-form").onsubmit = async (event) => {
      event.preventDefault();
      const submit = $("connect-submit");
      submit.disabled = true;
      submit.textContent = "Connecting";
      try {
        const result = await api("/api/connection", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ apiKey: $("connect-key").value }),
        });
        $("connect-key").value = "";
        dialog.close();
        showKey(result.keyHint);
        resolve(result);
      } catch (error) {
        $("connect-error").textContent = error.message;
      } finally {
        submit.disabled = false;
        submit.textContent = "Connect";
      }
    };
  });
}

function showKey(keyHint) {
  $("connection").className = "badge ok";
  $("connection").textContent = "Production API";
  $("change-key").hidden = false;
  $("change-key").textContent = `Key ${keyHint}`;
}

function chip(text) {
  const element = $("chip");
  element.hidden = !text;
  element.textContent = text ?? "";
  element.dataset.state = (text ?? "").toLowerCase();
}

function show(text) {
  $("status").classList.remove("result");
  $("status").textContent = text;
}

function result(firstFrames, total, seconds) {
  const length = `Your ${seconds} s ad: `;
  const parts = firstFrames ? [[`${length}playing after `, firstFrames], [", finished in ", total]] : [[`${length}finished in `, total]];
  $("status").replaceChildren(...parts.flatMap(([text, value]) => [text, Object.assign(document.createElement("strong"), { textContent: `${value} s` })]));
  $("status").classList.add("result");
}

// A 401 means this server has no key Blitframe accepts any more, so the page asks for one and starts again with it.
async function api(path, options) {
  const response = await fetch(path, options);
  const body = await response.json();
  if (response.status === 401) askForKey(false, body.code === "no_key" ? "" : body.error).then(() => location.reload());
  if (!response.ok) throw new Error(body.error ?? `Request failed: ${response.status}`);
  return body;
}
