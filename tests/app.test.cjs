"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const root = path.resolve(__dirname, "..");
const html = fs.readFileSync(path.join(root, "index.html"), "utf8");
const script = fs.readFileSync(path.join(root, "app.js"), "utf8");
const flush = () => new Promise((resolve) => setImmediate(resolve));

// ブラウザを置き換えるUIテストではなく、実際のイベント処理を動かすロジックテストです。
function harness(options = {}) {
  let now = 0, wallClockOffset = 0, nextTask = 1;
  const timers = new Map(), frames = new Map(), storage = new Map(), media = new Map();
  const audioContexts = [], audioNodes = [], mediaElements = [];
  const faults = { ...options.audioFaults };
  const elements = [], stack = [];
  let activeElement = null;
  class Element {
    constructor(tag, attrs, parent) {
      this.tagName = tag;
      this.attrs = attrs;
      this.parent = parent;
      this.id = attrs.id;
      this.value = attrs.value || "";
      this.checked = "checked" in attrs;
      this.hidden = "hidden" in attrs;
      this.disabled = "disabled" in attrs;
      this.open = false;
      this.textContent = "";
      this.style = {};
      this.dataset = {};
      this.listeners = {};
    }
    addEventListener(type, listener) { (this.listeners[type] ||= []).push(listener); }
    dispatch(type, fields = {}) { (this.listeners[type] || []).forEach((listener) => listener({ target: this, currentTarget: this, ...fields })); }
    setAttribute(name, value) { this.attrs[name] = String(value); }
    removeAttribute(name) { delete this.attrs[name]; }
    getAttribute(name) { return this.attrs[name] ?? null; }
    focus() { activeElement = this; }
    showModal() { this.open = true; activeElement = byId("close-settings"); }
    close() { this.open = false; this.dispatch("close"); }
    closest() { for (let node = this; node; node = node.parent) if (node.hidden) return node; return null; }
    getBoundingClientRect() { return { left: 0, top: 0, right: 440, bottom: 600 }; }
  }
  for (const token of html.matchAll(/<\/?([a-z][a-z0-9-]*)\b([^>]*?)>|([^<]+)/gi)) {
    if (token[3]) { for (const element of stack) element.textContent += token[3]; continue; }
    if (token[0].startsWith("</")) { while (stack.length) if (stack.pop().tagName === token[1]) break; continue; }
    const attrs = {};
    for (const attr of token[2].matchAll(/([\w-]+)(?:\s*=\s*"([^"]*)")?/g)) attrs[attr[1]] = attr[2] || "";
    const element = new Element(token[1], attrs, stack.at(-1));
    elements.push(element);
    if (!["meta", "link", "input", "br", "path", "circle"].includes(token[1])) stack.push(element);
  }
  const byId = (id) => elements.find((element) => element.id === id);
  const selectAll = (selector) => elements.filter((element) => {
    if (selector.startsWith(".")) return (element.attrs.class || "").split(" ").includes(selector.slice(1));
    const match = selector.match(/^(\w+)\[name="([^"]+)"\]$/);
    return match && element.tagName === match[1] && element.attrs.name === match[2];
  });
  const document = {
    documentElement: elements.find((element) => element.tagName === "html"), hidden: false, listeners: {},
    getElementById: byId, querySelectorAll: selectAll, querySelector: (selector) => selectAll(selector)[0],
    addEventListener(type, fn) { (this.listeners[type] ||= []).push(fn); },
    dispatch(type) { (this.listeners[type] || []).forEach((fn) => fn()); },
  };
  if (options.saved !== undefined) storage.set("yohaku-settings-v1", options.saved);
  const localStorage = {
    getItem(key) { if (options.storageBlocked) throw new Error("blocked"); return storage.get(key) ?? null; },
    setItem(key, value) { if (options.storageBlocked) throw new Error("blocked"); storage.set(key, value); },
  };
  const param = (value = 0) => {
    const result = { value, values: [], setValueAtTime(value, at) { this.value = value; this.values.push({ value, at }); }, linearRampToValueAtTime(value) { this.value = value; }, exponentialRampToValueAtTime(value) { this.value = value; }, setTargetAtTime(value) { if (faults.volume) throw new Error("volume failed"); this.value = value; }, cancelScheduledValues() {}, cancelAndHoldAtTime() {} };
    if (options.legacyCancelHold) delete result.cancelAndHoldAtTime;
    return result;
  };
  const node = (kind, context) => {
    if (audioNodes.length === faults.createAt) throw new Error("node failed");
    const result = { kind, context, gain: param(), frequency: param(), Q: param(), connections: [], starts: [], offsets: [], stops: [], connect(target) { if (faults.connect) throw new Error("connect failed"); this.connections.push(target); return target; }, disconnect() { this.disconnected = true; }, start(at = context.currentTime, offset = 0) { if (faults.startKind === kind) throw new Error("start failed"); this.starts.push(at); this.offsets.push(offset); }, stop(at = context.currentTime) { if (faults.stop) throw new Error("stop failed"); this.stops.push(at); } };
    audioNodes.push(result);
    return result;
  };
  class AudioContext {
    constructor() {
      if (options.audioFailure === "construct") throw new Error("unavailable");
      this._state = options.pendingResume ? "suspended" : "running";
      this._elapsed = 0; this._changedAt = now;
      this.sampleRate = options.sampleRate || 8000; this.destination = {}; this.listeners = {}; this.suspendCalls = 0; audioContexts.push(this);
    }
    get state() { return this._state; }
    set state(value) { this._elapsed = this.currentTime; this._changedAt = now; this._state = value; }
    get currentTime() { return this._elapsed + (this.state === "running" && !this._clockPaused ? (now - this._changedAt) / 1000 : 0); }
    pauseAudioClock() { this._elapsed = this.currentTime; this._changedAt = now; this._clockPaused = true; }
    resumeAudioClock() { this._changedAt = now; this._clockPaused = false; }
    changeState(value) { this.state = value; this.listeners.statechange?.(); }
    addEventListener(type, fn) { this.listeners[type] = fn; }
    resume() {
      if (options.audioFailure === "resume") return Promise.reject(new Error("blocked"));
      if (options.pendingResume) return new Promise((resolve) => {
        (this.pendingResolves ||= []).push(resolve);
        this.resolveResume = () => { this.changeState("running"); this.pendingResolves.splice(0).forEach((finish) => finish()); };
      });
      this.changeState("running"); return Promise.resolve();
    }
    suspend() { this.suspendCalls++; if (options.audioFailure === "suspend") return Promise.reject(new Error("suspend failed")); this.changeState("suspended"); return Promise.resolve(); }
    createBuffer(channels, length, sampleRate) { const data = Array.from({ length: channels }, () => new Float32Array(length)); return { numberOfChannels: channels, sampleRate, duration: length / sampleRate, length, getChannelData: (channel) => data[channel] }; }
    createBufferSource() { return node("source", this); }
    createMediaElementSource(media) { const result = node("media-source", this); result.media = media; return result; }
    createBiquadFilter() { return node("filter", this); }
    createGain() { return node("gain", this); }
    createOscillator() { return node("oscillator", this); }
  }
  const window = {
    Audio: class {
      constructor(src) { this.src = src; this.paused = true; mediaElements.push(this); }
      play() {
        if (options.mediaFailure) return Promise.reject(new Error("media failed"));
        if (options.pendingMedia) return new Promise((resolve) => { this.resolvePlay = () => { this.paused = false; resolve(); }; });
        this.paused = false; return Promise.resolve();
      }
      pause() { this.paused = true; }
      removeAttribute(name) { if (name === "src") this.src = ""; }
      load() { this.loaded = true; }
    },
    AudioContext: options.webkitOnly || options.audioUnavailable ? undefined : AudioContext,
    webkitAudioContext: options.webkitOnly ? AudioContext : undefined,
    listeners: {},
    setTimeout(fn, delay) { const id = nextTask++; timers.set(id, { at: now + delay, fn }); return id; },
    clearTimeout(id) { timers.delete(id); },
    requestAnimationFrame(fn) { const id = nextTask++; frames.set(id, fn); return id; },
    cancelAnimationFrame(id) { frames.delete(id); },
    addEventListener(type, fn) { (this.listeners[type] ||= []).push(fn); },
    matchMedia(query) { if (!media.has(query)) media.set(query, { matches: query.includes("motion") ? !!options.reducedMotion : !!options.dark, addEventListener(type, fn) { this.listener = fn; } }); return media.get(query); },
  };
  const endAudio = () => {
    for (const source of audioNodes) {
      if (source.ended || source.context.state !== "running" || !source.stops.length || source.stops.at(-1) > source.context.currentTime) continue;
      source.ended = true; source.onended?.();
    }
  };
  class ClockDate extends Date { static now() { return now + wallClockOffset; } }
  const math = options.random ? Object.assign(Object.create(Math), { random: options.random }) : Math;
  vm.runInNewContext(script, { window, document, localStorage, Date: ClockDate, Math: math, console });
  return {
    byId, storage, audioContexts, audioNodes, mediaElements, timers, frames, document, faults, endAudio,
    click(id) { byId(id).dispatch("click"); },
    openSettings() { const button = selectAll(".settings-trigger").find((element) => !element.closest("[hidden]")); button.dispatch("click"); return button; },
    radio(name, value) { const group = selectAll(`input[name="${name}"]`); group.forEach((element) => { element.checked = element.value === String(value); }); group.find((element) => element.checked).dispatch("change"); },
    input(id, value, type = "input") { const element = byId(id); if (type === "change") element.checked = value; else element.value = value; element.dispatch(type); },
    advance(ms) {
      const end = now + ms;
      while (timers.size) {
        const [id, task] = [...timers].sort((a, b) => a[1].at - b[1].at)[0];
        if (task.at > end) break;
        now = task.at; timers.delete(id); task.fn(); endAudio();
      }
      now = end; endAudio();
    },
    jump(ms) { now += ms; for (const [id, task] of [...timers]) if (task.at <= now) { timers.delete(id); task.fn(); } endAudio(); },
    shiftWallClock(ms) { wallClockOffset += ms; },
    elapseWithoutCallbacks(ms) { now += ms; },
    visibility(hidden) { document.hidden = hidden; document.dispatch("visibilitychange"); },
    media(query, matches) { const preference = media.get(query); preference.matches = matches; preference.listener(); },
    pagehide() { window.listeners.pagehide.forEach((fn) => fn()); },
    get activeElement() { return activeElement; },
  };
}

test("初回は3分・無音・ベルOFF。音を自動再生しない", () => {
  const app = harness();
  assert.equal(app.byId("start-label").textContent, "3分休む");
  assert.equal(app.byId("bell-enabled").checked, false);
  assert.equal(app.byId("guide-enabled").checked, false);
  assert.equal(app.audioContexts.length, 0);
  app.click("start-button");
  assert.equal(app.byId("session-view").hidden, false);
  assert.equal(app.byId("timer").textContent, "03:00");
  assert.equal(app.activeElement.id, "session-title");
  assert.equal(app.audioContexts.length, 0);
});

for (const minutes of [1, 3, 5, 10]) test(`${minutes}分が正確に終了し、再スタートできる`, () => {
  const app = harness(); app.radio("duration", minutes); app.click("start-button");
  app.advance(minutes * 60_000 - 1000);
  assert.equal(app.byId("timer").textContent, "00:01");
  assert.equal(app.byId("complete-view").hidden, true);
  app.advance(1000);
  assert.equal(app.byId("complete-view").hidden, false);
  assert.equal(app.timers.size, 0);
  assert.equal(app.frames.size, 0);
  assert.equal(app.activeElement.id, "complete-title");
  app.click("restart-button");
  assert.equal(app.byId("session-view").hidden, false);
  assert.equal(app.byId("timer").textContent, `${String(minutes).padStart(2, "0")}:00`);
  app.click("stop-button");
  assert.equal(app.byId("home-view").hidden, false);
  assert.equal(app.timers.size, 0);
});

test("バックグラウンドでコールバックが遅れても終了予定時刻に同期する", () => {
  const app = harness(); app.click("start-button"); app.visibility(true);
  assert.equal(app.frames.size, 0);
  app.jump(130_000);
  assert.equal(app.byId("timer").textContent, "00:50");
  app.jump(100_000); app.visibility(false);
  assert.equal(app.byId("complete-view").hidden, false);
  assert.equal(app.timers.size, 0);
});

test("一時停止中は減らず、再開後は残り時間から数える", () => {
  const app = harness(); app.click("start-button"); app.advance(12_345); app.click("pause-button");
  assert.equal(app.byId("timer").textContent, "02:48");
  assert.equal(app.byId("pause-button").textContent, "再開する");
  assert.equal(app.frames.size, 0);
  app.jump(360_000);
  assert.equal(app.byId("timer").textContent, "02:48");
  app.click("pause-button"); app.advance(167_600);
  assert.equal(app.byId("complete-view").hidden, true);
  app.advance(200);
  assert.equal(app.byId("complete-view").hidden, false);
});

test("呼吸の4秒・2秒・6秒を同期し、reduced motionでは円が静止する", () => {
  const app = harness(); app.click("start-button");
  assert.equal(app.byId("breath-label").textContent, "吸う");
  app.advance(4000); assert.equal(app.byId("breath-label").textContent, "そのまま");
  app.advance(2000); assert.equal(app.byId("breath-label").textContent, "吐く");
  app.advance(6000); assert.equal(app.byId("breath-label").textContent, "吸う");
  app.media("(prefers-reduced-motion: reduce)", true);
  assert.equal(app.frames.size, 0);
  assert.equal(app.byId("breathing-circle").style.transform, "scale(1)");
  app.advance(4000); assert.equal(app.byId("breathing-circle").style.transform, "scale(1)");
});

test("残り時間の非表示と再表示、モーダルのフォーカス復帰", () => {
  const app = harness(); app.click("start-button"); app.click("time-toggle");
  assert.equal(app.byId("timer").hidden, true);
  assert.equal(app.byId("time-toggle").getAttribute("aria-pressed"), "true");
  app.advance(5000); app.click("time-toggle");
  assert.equal(app.byId("timer").textContent, "02:55");
  assert.equal(app.byId("timer").getAttribute("aria-label"), "残り2分55秒");
  const opener = app.openSettings();
  assert.equal(app.byId("settings-dialog").open, true);
  assert.equal(app.activeElement.id, "close-settings");
  app.click("close-settings");
  assert.equal(app.activeElement, opener);
  app.click("stop-button"); app.click("start-button"); app.advance(180_000); app.click("finish-button");
  assert.equal(app.activeElement.id, "start-button");
});

test("設定を開いたまま終了しても、閉じた後のフォーカスが終了画面へ移る", () => {
  const app = harness(); app.click("start-button"); app.openSettings(); app.jump(180_000);
  assert.equal(app.byId("complete-view").hidden, false);
  app.click("close-settings"); assert.equal(app.activeElement.id, "complete-title");
});

test("中断したAudioContextの終了ベルは取り消し、遅れて鳴らさない", async () => {
  const app = harness(); app.input("bell-enabled", true, "change"); app.click("start-button"); await flush();
  app.audioContexts[0].state = "interrupted"; app.jump(180_000);
  assert.ok(app.audioNodes.filter((node) => node.kind === "oscillator").every((node) => node.disconnected));
});

test("設定を検証して保存し、保存不可や壊れたJSONでも開始できる", () => {
  for (const options of [{ storageBlocked: true }, { saved: "{broken" }, { saved: JSON.stringify({ minutes: 2, sound: "toString", volume: 500, bell: "yes", theme: "bad" }) }]) {
    const app = harness(options); app.click("start-button");
    assert.equal(app.byId("timer").textContent, "03:00");
  }
  const app = harness(); app.radio("duration", 5); app.radio("sound", "waves"); app.radio("theme", "dark"); app.input("volume", 22);
  const saved = JSON.parse(app.storage.get("yohaku-settings-v1"));
  assert.equal(saved.minutes, 5); assert.equal(saved.sound, "waves"); assert.equal(saved.volume, 22); assert.equal(saved.theme, "dark");
  const reloaded = harness({ saved: JSON.stringify(saved) });
  assert.equal(reloaded.byId("start-label").textContent, "5分休む");
  assert.equal(reloaded.document.documentElement.dataset.theme, "dark");
});

test("雨・波は開始後だけ合成し、音量変更と無音への切り替えができる", async () => {
  const app = harness(); app.radio("sound", "rain"); assert.equal(app.audioContexts.length, 0);
  app.click("start-button"); await flush();
  const source = app.audioNodes.find((node) => node.kind === "source");
  assert.equal(source.loop, true);
  assert.equal(source.starts.length, 1);
  const samples = source.buffer.getChannelData(0);
  assert.ok(samples.every((sample) => Number.isFinite(sample) && Math.abs(sample) <= 1));
  assert.ok(samples.length >= source.buffer.sampleRate * 10);
  assert.ok(app.audioNodes.some((node) => node.kind === "filter" && node.frequency.value === 3200));
  app.input("volume", 70);
  assert.ok(app.audioNodes.some((node) => node.kind === "gain" && Math.abs(node.gain.value - 0.315) < 0.00001));
  app.radio("sound", "waves"); await flush();
  assert.ok(source.stops.length > 0);
  assert.ok(app.audioNodes.some((node) => node.kind === "oscillator" && node.frequency.value === 1 / 11));
  assert.ok(app.audioNodes.some((node) => node.kind === "filter" && node.frequency.value === 9000));
  app.radio("sound", "silent"); await flush();
  assert.equal(app.byId("volume").disabled, true);
  assert.ok(app.audioNodes.filter((node) => node.kind === "source").every((node) => node.stops.length > 0));
});

test("雨 fugisako verは開始後だけ録音を読み込み、音量変更・停止・再開に対応する", async () => {
  const app = harness(); app.radio("sound", "rain2");
  assert.equal(app.mediaElements.length, 0);
  assert.equal(JSON.parse(app.storage.get("yohaku-settings-v1")).sound, "rain2");
  app.click("start-button"); await flush();
  const media = app.mediaElements[0];
  assert.equal(media.src, "assets/audio/rain2.mp3");
  assert.equal(media.loop, true); assert.equal(media.paused, false);
  assert.ok(app.audioNodes.some((node) => node.kind === "gain" && Math.abs(node.gain.value - 0.63) < 0.00001));
  assert.equal(app.audioNodes.filter((node) => node.kind === "source").length, 0);
  app.input("volume", 70); await flush();
  assert.equal(app.mediaElements.length, 1);
  assert.ok(app.audioNodes.some((node) => node.kind === "gain" && Math.abs(node.gain.value - 1.26) < 0.00001));
  app.click("pause-button"); app.advance(500); await flush();
  assert.equal(media.paused, true); assert.equal(media.src, "");
  assert.ok(app.audioNodes.every((node) => node.disconnected));
  app.click("pause-button"); await flush();
  assert.equal(app.mediaElements[1].paused, false);
  app.radio("sound", "rain"); await flush(); app.advance(500);
  assert.equal(app.mediaElements[1].paused, true);
  assert.ok(app.audioNodes.some((node) => node.kind === "filter" && node.frequency.value === 3200));
});

test("雨 fugisako verの読み込み待ち中に終了しても、遅れて再生しない", async () => {
  const app = harness({ pendingMedia: true }); app.radio("sound", "rain2");
  app.click("start-button"); await flush();
  const media = app.mediaElements[0];
  app.click("stop-button"); app.advance(500);
  media.resolvePlay(); await flush();
  assert.equal(media.paused, true); assert.equal(media.src, "");
  assert.ok(app.audioNodes.every((node) => node.disconnected));
});

test("雨 fugisako verの読込・再生エラーでもタイマーを継続し音を解放する", async () => {
  for (const options of [{ mediaFailure: true }, { audioFaults: { createAt: 1 } }, {}]) {
    const app = harness(options); app.radio("duration", 1); app.radio("sound", "rain2");
    app.click("start-button"); await flush();
    if (!options.mediaFailure && !options.audioFaults) app.mediaElements[0].onerror();
    assert.equal(app.byId("audio-notice").hidden, false);
    assert.equal(app.mediaElements[0].paused, true);
    assert.ok(app.audioNodes.every((node) => node.disconnected));
    app.advance(60_000); assert.equal(app.byId("complete-view").hidden, false);
  }
});

test("雨 fugisako verを音量0で開始しても読込まず、終了時に録音を解放する", async () => {
  const app = harness(); app.radio("duration", 1); app.radio("sound", "rain2"); app.input("volume", 0);
  app.click("start-button"); await flush(); assert.equal(app.mediaElements.length, 0);
  app.input("volume", 35); await flush();
  app.advance(60_000); app.advance(500); await flush();
  assert.equal(app.byId("complete-view").hidden, false);
  assert.equal(app.mediaElements[0].paused, true);
  assert.ok(app.audioNodes.every((node) => node.disconnected));
  const saved = harness({ saved: JSON.stringify({ sound: "rain2" }) });
  assert.equal(saved.byId("volume").disabled, false);
  assert.equal(saved.mediaElements.length, 0);
});

for (const sound of ["fire", "white", "pink", "tone40"]) test(`${sound}は開始後だけ鳴り、設定保存・音量・停止・再開・終了に対応する`, async () => {
  const app = harness({ random: seededRandom(21) }); app.radio("duration", 1); app.radio("sound", sound);
  assert.equal(app.audioContexts.length, 0);
  const saved = app.storage.get("yohaku-settings-v1");
  assert.equal(JSON.parse(saved).sound, sound);
  const restored = harness({ saved }); assert.equal(restored.byId("volume").disabled, false);
  app.click("start-button"); await flush();
  const source = app.audioNodes.find((node) => node.kind === "source");
  assert.equal(source.starts.length, 1);
  assert.equal(source.loop, true); assert.equal(source.buffer.numberOfChannels, 2);
  app.input("volume", 70); await flush();
  assert.ok(app.audioNodes.some((node) => node.kind === "gain" && Math.abs(node.gain.value - 0.315) < 0.00001));
  assert.equal(source.starts.length, 1);
  app.click("pause-button"); app.advance(500); await flush();
  assert.ok(app.audioNodes.every((node) => node.disconnected));
  app.click("pause-button"); await flush();
  const replacement = app.audioNodes.filter((node) => node.kind === source.kind).at(-1);
  assert.equal(replacement.buffer, source.buffer);
  app.advance(60_000); app.advance(500); await flush();
  assert.equal(app.byId("complete-view").hidden, false);
  assert.ok(app.audioNodes.every((node) => node.disconnected));
});

test("白・ピンクの音色を分け、焚き火には不規則な破裂音を含める", async () => {
  const data = {};
  for (const sound of ["white", "pink", "fire"]) {
    const app = harness({ random: seededRandom(42) }); app.radio("sound", sound); app.click("start-button"); await flush();
    const buffer = app.audioNodes.find((node) => node.kind === "source").buffer;
    const samples = buffer.getChannelData(0);
    assert.ok(samples.every(sample => Number.isFinite(sample) && Math.abs(sample) <= 1));
    let energy = 0, adjacent = 0;
    for (let i = buffer.sampleRate; i < samples.length - 1; i++) { energy += samples[i] ** 2; adjacent += samples[i] * samples[i + 1]; }
    data[sound] = { correlation: adjacent / energy, samples, rate: buffer.sampleRate };
  }
  assert.ok(Math.abs(data.white.correlation) < 0.03);
  assert.ok(data.pink.correlation > 0.5);
  const energies = [];
  for (let start = data.fire.rate; start < data.fire.samples.length - data.fire.rate / 10; start += data.fire.rate / 10) {
    let energy = 0;
    for (let i = start; i < start + data.fire.rate / 10; i++) energy += data.fire.samples[i] ** 2;
    energies.push(energy);
  }
  assert.ok(Math.max(...energies) > Math.min(...energies) * 3);
});

test("波は60秒に6回寄せて引き、泡の音と静かな間を持つ", async () => {
  const app = harness({ random: seededRandom(19) }); app.radio("sound", "waves"); app.click("start-button"); await flush();
  const source = app.audioNodes.find(node => node.kind === "source");
  const buffer = source.buffer, rate = buffer.sampleRate;
  assert.equal(buffer.duration, 60); assert.equal(source.loop, true);
  for (let channel = 0; channel < buffer.numberOfChannels; channel++) {
    const samples = buffer.getChannelData(channel);
    const rmsAt = (time) => {
      let energy = 0;
      for (let i = Math.round(time * rate); i < Math.round((time + 0.3) * rate); i++) energy += samples[i] ** 2;
      return Math.sqrt(energy / (rate * 0.3));
    };
    for (const [crest, quiet] of [[2, 7.8], [10.7, 18.6], [21.6, 28], [30.7, 39.2], [42, 49], [52, 59.4]]) {
      assert.ok(rmsAt(crest) > 3 * rmsAt(quiet));
    }
    assert.ok(samples.every(sample => Number.isFinite(sample) && Math.abs(sample) <= 1));
    assert.ok(Math.abs(samples[0] - samples.at(-1)) < 0.15);
  }
  app.click("pause-button"); app.advance(500); app.click("pause-button"); await flush();
  assert.equal(app.audioNodes.filter(node => node.kind === "source").at(-1).buffer, buffer);
});

test("40Hz変調は聞こえる240Hz搬送音を毎秒40回変調し、停止と説明に対応する", async () => {
  const app = harness(); app.radio("sound", "tone40"); app.click("start-button"); await flush();
  const sources = app.audioNodes.filter(node => node.kind === "source");
  assert.equal(sources.length, 1); assert.equal(sources[0].buffer.duration, 1);
  const samples = sources[0].buffer.getChannelData(0), rate = sources[0].buffer.sampleRate;
  const amplitudeAt = (frequency) => {
    let real = 0, imaginary = 0;
    for (let i = 0; i < samples.length; i++) {
      real += samples[i] * Math.cos(2 * Math.PI * frequency * i / rate);
      imaginary += samples[i] * Math.sin(2 * Math.PI * frequency * i / rate);
    }
    return 2 * Math.hypot(real, imaginary) / samples.length;
  };
  assert.ok(Math.abs(amplitudeAt(240) - 0.385) < 0.0001);
  assert.ok(Math.abs(amplitudeAt(200) - 0.1575) < 0.0001);
  assert.ok(Math.abs(amplitudeAt(280) - 0.1575) < 0.0001);
  assert.ok(amplitudeAt(40) < 0.0001);
  assert.ok(samples.every(sample => Number.isFinite(sample) && Math.abs(sample) <= 0.7));
  const texture = sources[0].connections[0];
  const volume = texture.connections[0];
  assert.ok(Math.abs(texture.gain.value * volume.gain.value - 0.1575) < 0.00001);
  app.input("volume", 100); await flush();
  assert.ok(Math.abs(texture.gain.value * volume.gain.value - 0.45) < 0.00001);
  assert.match(app.byId("sound-description").textContent, /毎秒40回/);
  for (const sound of ["rain", "waves", "fire"]) {
    app.radio("sound", sound); await flush();
    assert.match(app.byId("sound-description").textContent, /合成音/);
  }
  app.radio("sound", "rain2"); await flush();
  assert.match(app.byId("sound-description").textContent, /録音/);
  app.radio("sound", "silent"); await flush();
  assert.equal(app.byId("sound-description").hidden, true);
});

test("追加音の切り替えと生成失敗でも、音を残さずタイマーを継続する", async () => {
  const app = harness(); app.click("start-button");
  for (const sound of ["fire", "white", "pink", "tone40", "rain", "rain2", "silent"]) {
    app.radio("sound", sound); await flush(); app.advance(500);
  }
  assert.ok(app.audioNodes.every((node) => node.disconnected));
  for (const sound of ["fire", "white", "pink", "tone40"]) {
    const failed = harness({ audioFaults: { createAt: 1 } }); failed.radio("duration", 1); failed.radio("sound", sound);
    failed.click("start-button"); await flush();
    assert.equal(failed.byId("audio-notice").hidden, false);
    assert.ok(failed.audioNodes.every(node => node.disconnected));
    failed.advance(60_000); assert.equal(failed.byId("complete-view").hidden, false);
  }
});

test("ベルは明示的ONの時だけ一度予約し、停止・再開で旧ベルを取り消す", async () => {
  const app = harness(); app.input("bell-enabled", true, "change"); app.click("start-button"); await flush();
  let bells = app.audioNodes.filter((node) => node.kind === "oscillator");
  assert.equal(bells.length, 3); assert.ok(bells.every((node) => node.starts[0] === 180));
  app.advance(10_000); app.click("pause-button");
  assert.ok(bells.every((node) => node.disconnected));
  app.jump(30_000); app.click("pause-button"); await flush();
  bells = app.audioNodes.filter((node) => node.kind === "oscillator");
  assert.equal(bells.length, 6); assert.ok(bells.slice(3).every((node) => node.starts[0] - app.audioContexts[0].currentTime === 170));
  app.advance(170_000);
  assert.equal(app.byId("complete-view").hidden, false);
  assert.equal(app.audioNodes.filter((node) => node.kind === "oscillator").length, 6);
  assert.ok(bells.slice(3).every((node) => !node.disconnected));
  app.click("finish-button"); assert.ok(bells.every((node) => node.disconnected));
});

test("音量0で音を作らず、音のエラー時にもタイマーは終了する", async () => {
  const muted = harness(); muted.radio("sound", "rain"); muted.input("volume", 0); muted.click("start-button"); await flush();
  assert.equal(muted.audioContexts.length, 0);
  muted.input("volume", 35); await flush(); assert.equal(muted.audioNodes.filter((node) => node.kind === "source").length, 1);
  for (const audioFailure of ["construct", "resume"]) {
    const app = harness({ audioFailure }); app.radio("sound", "rain"); app.click("start-button"); await flush();
    assert.equal(app.byId("audio-notice").hidden, false);
    app.jump(180_000); assert.equal(app.byId("complete-view").hidden, false);
  }
});

test("音の準備中に終了しても遅れて音が鳴らない", async () => {
  const app = harness({ pendingResume: true }); app.radio("sound", "rain"); app.click("start-button");
  app.click("stop-button"); app.audioContexts[0].resolveResume(); await flush();
  assert.equal(app.audioNodes.length, 0); assert.equal(app.byId("home-view").hidden, false);
});

test("音が中断した場合は再開でき、ページ離脱時は停止する", async () => {
  const app = harness(); app.radio("sound", "waves"); app.click("start-button"); await flush();
  const context = app.audioContexts[0]; context.state = "interrupted"; context.listeners.statechange();
  assert.equal(app.byId("retry-audio").hidden, false);
  app.click("retry-audio"); await flush(); assert.equal(app.byId("retry-audio").hidden, true);
  app.pagehide(); assert.equal(app.byId("pause-button").textContent, "再開する");
  assert.ok(app.audioNodes.filter((node) => node.kind === "source").every((node) => node.stops.length > 0));
});

test("中断で音声の時計が止まっても、復帰時のベルを残り時間に合わせる", async () => {
  const app = harness(); app.radio("sound", "rain"); app.input("bell-enabled", true, "change"); app.click("start-button"); await flush();
  const context = app.audioContexts[0];
  const originalBells = app.audioNodes.filter((node) => node.kind === "oscillator");
  app.advance(10_000); context.changeState("interrupted");
  assert.ok(originalBells.every((node) => node.disconnected));
  app.advance(30_000); assert.equal(context.currentTime, 10);
  context.changeState("running");
  const replacementBells = app.audioNodes.filter((node) => node.kind === "oscillator").slice(3);
  assert.equal(replacementBells.length, 3);
  assert.ok(replacementBells.every((node) => node.starts[0] - context.currentTime === 140));
  assert.equal(app.audioNodes.filter((node) => node.kind === "source").length, 1);
  app.advance(140_000); assert.equal(app.byId("complete-view").hidden, false);
  app.advance(3000);
  assert.ok(app.audioNodes.every((node) => node.disconnected));
  assert.equal(context.state, "suspended");
});

test("更新が凍結したまま期限を過ぎて音が復帰しても、遅いベルを作らない", async () => {
  const app = harness(); app.radio("sound", "waves"); app.input("bell-enabled", true, "change"); app.click("start-button"); await flush();
  const context = app.audioContexts[0]; context.changeState("interrupted");
  const nodeCount = app.audioNodes.length;
  app.elapseWithoutCallbacks(240_000); context.changeState("running");
  assert.equal(app.byId("complete-view").hidden, false);
  assert.equal(app.audioNodes.length, nodeCount);
  app.advance(500);
  assert.ok(app.audioNodes.every((node) => node.disconnected));
  assert.equal(context.state, "suspended");
});

test("環境音を滑らかに停止した後はノードを解放し、AudioContextを休止する", async () => {
  const app = harness(); app.radio("sound", "waves"); app.click("start-button"); await flush();
  const context = app.audioContexts[0]; app.click("pause-button");
  assert.equal(context.state, "running");
  app.advance(500);
  assert.ok(app.audioNodes.every((node) => node.disconnected));
  assert.equal(context.state, "suspended");
  app.click("pause-button"); await flush();
  assert.equal(context.state, "running");
  assert.equal(app.audioContexts.length, 1);
  app.pagehide();
  assert.ok(app.audioNodes.every((node) => node.disconnected));
  assert.equal(context.state, "suspended");
});

test("ベルのON/OFFと音量変更で環境音を不要に再生成しない", async () => {
  const app = harness(); app.radio("sound", "rain"); app.click("start-button"); await flush();
  const source = app.audioNodes.find((node) => node.kind === "source");
  app.input("bell-enabled", true, "change"); await flush();
  app.input("volume", 60); app.input("bell-enabled", false, "change"); await flush();
  assert.equal(app.audioNodes.filter((node) => node.kind === "source").length, 1);
  assert.equal(source.stops.length, 0);
  assert.ok(app.audioNodes.filter((node) => node.kind === "oscillator").every((node) => node.disconnected));
  app.radio("sound", "silent"); await flush(); app.advance(500);
  assert.equal(app.audioContexts[0].state, "suspended");
});

test("ベルの余韻が終わるとマスター音量を含む全ノードを解放する", async () => {
  const app = harness(); app.radio("duration", 1); app.input("bell-enabled", true, "change"); app.click("start-button"); await flush();
  const firstNodes = [...app.audioNodes]; app.advance(60_000);
  assert.ok(firstNodes.every((node) => !node.disconnected));
  app.advance(3000);
  assert.ok(firstNodes.every((node) => node.disconnected));
  assert.equal(app.audioContexts[0].state, "suspended");
  app.click("restart-button"); await flush();
  assert.equal(app.audioNodes.filter((node) => node.kind === "oscillator" && !node.disconnected).length, 3);
  app.click("stop-button"); assert.ok(app.audioNodes.every((node) => node.disconnected));
});

test("音声グラフの生成・接続・開始の途中で失敗しても、作ったノードを残さない", async () => {
  for (const audioFaults of [{ createAt: 0 }, { createAt: 2 }, { createAt: 7 }, { connect: true }, { startKind: "source" }]) {
    const app = harness({ audioFaults }); app.radio("sound", "waves"); app.click("start-button"); await flush();
    assert.equal(app.byId("audio-notice").hidden, false);
    assert.ok(app.audioNodes.every((node) => node.disconnected));
    assert.equal(app.audioContexts[0].state, "suspended");
    app.jump(180_000); assert.equal(app.byId("complete-view").hidden, false);
  }
  const app = harness({ audioFaults: { createAt: 4 } }); app.input("bell-enabled", true, "change"); app.click("start-button"); await flush();
  assert.equal(app.byId("audio-notice").hidden, false);
  assert.ok(app.audioNodes.every((node) => node.disconnected));
});

test("停止処理の例外でも切断を実行し、音量処理の失敗後は再試行できる", async () => {
  const app = harness(); app.radio("sound", "waves"); app.click("start-button"); await flush();
  app.faults.volume = true; app.input("volume", 40);
  assert.equal(app.byId("audio-notice").hidden, false);
  assert.ok(app.audioNodes.every((node) => node.disconnected));
  delete app.faults.volume; app.click("retry-audio"); await flush();
  assert.equal(app.byId("audio-notice").hidden, true);
  app.faults.stop = true; app.click("stop-button");
  assert.equal(app.byId("home-view").hidden, false);
  assert.ok(app.audioNodes.every((node) => node.disconnected));
});

test("休止の拒否や、取り消した音声準備が後から完了しても休息を妨げない", async () => {
  const rejected = harness({ audioFailure: "suspend" }); rejected.input("bell-enabled", true, "change"); rejected.click("start-button"); await flush();
  rejected.click("stop-button"); await flush();
  assert.equal(rejected.byId("home-view").hidden, false);
  assert.ok(rejected.audioNodes.every((node) => node.disconnected));
  const pending = harness({ pendingResume: true }); pending.radio("sound", "rain"); pending.click("start-button"); pending.click("stop-button");
  pending.audioContexts[0].resolveResume(); await flush();
  assert.equal(pending.audioContexts[0].state, "suspended");
  assert.equal(pending.audioNodes.length, 0);
});

test("音声準備中に設定を連続変更しても最後の選択だけを再生する", async () => {
  const app = harness({ pendingResume: true }); app.radio("sound", "rain"); app.click("start-button");
  app.radio("sound", "waves"); app.input("bell-enabled", true, "change");
  app.audioContexts[0].resolveResume(); await flush();
  assert.equal(app.audioNodes.filter((node) => node.kind === "source").length, 1);
  assert.ok(app.audioNodes.some((node) => node.kind === "filter" && node.frequency.value === 9000));
  assert.equal(app.audioNodes.filter((node) => node.kind === "oscillator").length, 4);
});

test("時計が巻き戻っても残り時間や呼吸の位相が逆行しない", () => {
  const app = harness(); app.click("start-button"); app.advance(8000);
  assert.equal(app.byId("timer").textContent, "02:52");
  const scale = app.byId("breathing-circle").style.transform;
  app.shiftWallClock(-3_600_000); app.advance(200);
  assert.equal(app.byId("timer").textContent, "02:52");
  assert.equal(app.byId("breathing-circle").style.transform, scale);
  app.shiftWallClock(3_600_000); app.advance(200);
  assert.equal(app.byId("timer").textContent, "02:52");
  app.shiftWallClock(180_000); app.advance(200);
  assert.equal(app.byId("complete-view").hidden, false);
});

test("停止中に動きを減らす設定へ切り替えた場合も、円を静止状態にする", () => {
  const app = harness(); app.click("start-button"); app.advance(4000); app.click("pause-button");
  app.media("(prefers-reduced-motion: reduce)", true);
  assert.equal(app.byId("breathing-circle").style.transform, "scale(1)");
  assert.equal(app.frames.size, 0);
});

test("保存された端数の音量をレンジと同じ整数に揃え、テーマを反映する", () => {
  const app = harness({ saved: JSON.stringify({ volume: 35.7 }), dark: true });
  assert.equal(app.byId("volume").value, 36);
  assert.equal(app.byId("volume-value").value, "36%");
  app.radio("theme", "light");
  assert.equal(app.document.documentElement.dataset.theme, "light");
  app.radio("theme", "auto");
  assert.equal(app.document.documentElement.dataset.theme, undefined);
});

test("statechangeがなくても、画面復帰時に音声時計とベルを同期する", async () => {
  const app = harness(); app.input("bell-enabled", true, "change"); app.click("start-button"); await flush();
  const context = app.audioContexts[0]; app.advance(10_000); app.visibility(true); context.pauseAudioClock();
  app.elapseWithoutCallbacks(30_000); context.resumeAudioClock(); app.visibility(false);
  const bells = app.audioNodes.filter((node) => node.kind === "oscillator");
  assert.ok(bells.slice(0, 3).every((node) => node.disconnected));
  assert.ok(bells.slice(3).every((node) => node.starts[0] - context.currentTime === 140));
  assert.equal(app.byId("timer").textContent, "02:20");
});

test("音声時計だけが停止して期限を過ぎた場合にも、遅いベルを取り消す", async () => {
  const app = harness(); app.input("bell-enabled", true, "change"); app.click("start-button"); await flush();
  const context = app.audioContexts[0]; app.advance(10_000); app.visibility(true); context.pauseAudioClock();
  app.elapseWithoutCallbacks(240_000); context.resumeAudioClock(); app.visibility(false);
  assert.equal(app.byId("complete-view").hidden, false);
  assert.ok(app.audioNodes.every((node) => node.disconnected));
  assert.equal(context.state, "suspended");
});

test("cancelAndHoldAtTimeがない環境でも、途中の音量から滑らかに停止する", async () => {
  const app = harness({ legacyCancelHold: true }); app.radio("sound", "rain"); app.click("start-button"); await flush();
  app.advance(300); app.click("pause-button");
  const held = app.audioNodes.filter((node) => node.kind === "gain").flatMap((node) => node.gain.values).find((event) => event.at === 0.3);
  assert.ok(held && Math.abs(held.value - 0.2) < 0.000001);
  app.advance(500);
  assert.ok(app.audioNodes.every((node) => node.disconnected));
});

test("webkitAudioContextにも対応し、音声APIがなくても無音で終了まで休める", async () => {
  const legacy = harness({ webkitOnly: true }); legacy.radio("sound", "rain"); legacy.click("start-button"); await flush();
  assert.equal(legacy.audioNodes.filter((node) => node.kind === "source").length, 1);
  const unavailable = harness({ audioUnavailable: true }); unavailable.radio("sound", "rain"); unavailable.click("start-button"); await flush();
  assert.equal(unavailable.byId("audio-notice").hidden, false);
  assert.equal(unavailable.audioContexts.length, 0);
  unavailable.advance(180_000); assert.equal(unavailable.byId("complete-view").hidden, false);
});

function seededRandom(seed) {
  let value = seed;
  return () => { value = (Math.imul(value, 1664525) + 1013904223) >>> 0; return value / 4294967296; };
}

const guideSources = (app) => app.audioNodes.filter((node) => node.kind === "source" && node.buffer?.numberOfChannels === 1);

function differenceEnergy(samples, start, count) {
  let sum = 0;
  for (let i = 0; i < count; i++) {
    const at = (start + i + samples.length) % samples.length;
    const difference = samples[at] - samples[(at + samples.length - 1) % samples.length];
    sum += difference * difference;
  }
  return sum / count;
}

test("環境音のループ境界でノイズの密度が落ちず、画面更新なしでも同じ音源が続く", async () => {
  const app = harness({ random: seededRandom(18) }); app.radio("sound", "rain"); app.click("start-button"); await flush();
  const source = app.audioNodes.find((node) => node.kind === "source");
  const buffer = source.buffer;
  for (let channel = 0; channel < buffer.numberOfChannels; channel++) {
    const samples = buffer.getChannelData(channel);
    const count = Math.round(buffer.sampleRate * 0.04);
    const reference = differenceEnergy(samples, buffer.sampleRate * 2, buffer.sampleRate * 16);
    const seam = differenceEnergy(samples, -count / 2, count);
    assert.ok(seam / reference > 0.65 && seam / reference < 1.5, `channel ${channel}: ${seam / reference}`);
    assert.ok(samples.every((sample) => Number.isFinite(sample) && Math.abs(sample) <= 1));
  }
  app.visibility(true); app.elapseWithoutCallbacks(75_000);
  assert.equal(source.starts.length, 1); assert.equal(source.stops.length, 0);
  app.visibility(false);
  assert.equal(app.audioNodes.filter((node) => node.kind === "source").length, 1);
  assert.equal(app.byId("timer").textContent, "01:45");
});

test("呼吸ガイドは任意で保存し、古い設定・不正な設定ではOFF。開始前には鳴らない", async () => {
  for (const guide of [undefined, "yes", 1]) {
    const app = harness({ saved: JSON.stringify({ guide }) });
    assert.equal(app.byId("guide-enabled").checked, false);
  }
  const app = harness(); app.input("guide-enabled", true, "change");
  assert.equal(app.byId("volume").disabled, false);
  assert.equal(app.audioContexts.length, 0);
  const saved = app.storage.get("yohaku-settings-v1");
  assert.equal(JSON.parse(saved).guide, true);
  const restored = harness({ saved });
  assert.equal(restored.byId("guide-enabled").checked, true);
  assert.equal(restored.audioContexts.length, 0);
  restored.click("start-button"); await flush();
  assert.equal(guideSources(restored).length, 1);
});

test("音ガイドは吸う・吐くの始まりだけに短く鳴り、間は無音。急な音量変化がなく円と同じ周期", async () => {
  const app = harness(); app.input("guide-enabled", true, "change"); app.click("start-button"); await flush();
  const source = guideSources(app)[0], buffer = source.buffer, samples = buffer.getChannelData(0), rate = buffer.sampleRate;
  assert.equal(buffer.duration, 12); assert.equal(source.loop, true); assert.equal(source.offsets[0], 0);
  assert.ok(samples.every((sample) => Number.isFinite(sample) && Math.abs(sample) <= 1));
  assert.ok(samples.subarray(rate * 1.2, rate * 6).every((sample) => sample === 0));
  assert.ok(samples.subarray(rate * 7.2).every((sample) => sample === 0));
  assert.ok(samples.subarray(rate * 4, rate * 6).every((sample) => sample === 0));
  assert.equal(samples[0], 0); assert.ok(Math.abs(samples.at(-1)) < 0.000001);
  for (const at of [0, 1.1, 6, 7.1, 12]) {
    const boundary = Math.round(at * rate);
    for (let i = Math.max(1, boundary - 2); i < Math.min(samples.length, boundary + 3); i++) {
      assert.ok(Math.abs(samples[i] - samples[i - 1]) < 0.001, `smooth boundary at ${at}s`);
    }
  }
  const frequencyAt = (time) => {
    const start = Math.round(time * rate), end = start + Math.round(rate * 0.1);
    let crossings = 0;
    for (let i = start + 1; i < end; i++) if (samples[i - 1] <= 0 && samples[i] > 0) crossings++;
    return crossings * 10;
  };
  assert.ok(frequencyAt(0.2) > frequencyAt(6.2));
  assert.ok(Math.abs(frequencyAt(0.2) - frequencyAt(0.7)) <= 10);
  assert.ok(Math.abs(frequencyAt(6.2) - frequencyAt(6.7)) <= 10);
  app.advance(4000); assert.equal(app.byId("breath-label").textContent, "そのまま");
  app.advance(2000); assert.equal(app.byId("breath-label").textContent, "吐く");
});

test("10分の雨と音ガイドは途中で作り直さず、終了後に両方の音を解放する", async () => {
  const app = harness(); app.radio("duration", 10); app.radio("sound", "rain");
  app.input("guide-enabled", true, "change"); app.click("start-button"); await flush();
  const sources = app.audioNodes.filter((node) => node.kind === "source");
  assert.equal(sources.length, 2);
  assert.equal(app.byId("timer").textContent, "10:00");
  app.advance(599_000);
  assert.equal(app.byId("timer").textContent, "00:01");
  assert.ok(sources.every((source) => !source.disconnected && source.starts.length === 1));
  assert.equal(app.audioNodes.filter((node) => node.kind === "source").length, 2);
  app.advance(1000);
  assert.equal(app.byId("complete-view").hidden, false);
  app.advance(500);
  assert.ok(app.audioNodes.every((node) => node.disconnected));
  assert.equal(app.audioContexts[0].state, "suspended");
});

test("一時停止後の音ガイドは、停止した呼吸の途中から再開して全ノードを解放する", async () => {
  const app = harness(); app.input("guide-enabled", true, "change"); app.click("start-button"); await flush();
  app.advance(7000); app.click("pause-button"); app.advance(500);
  assert.ok(app.audioNodes.every((node) => node.disconnected));
  assert.equal(app.audioContexts[0].state, "suspended");
  app.elapseWithoutCallbacks(40_000); app.click("pause-button"); await flush();
  const source = guideSources(app).at(-1);
  assert.equal(source.offsets[0], 7);
  assert.equal(source.stops[0] - source.starts[0], 173);
  assert.equal(app.byId("breath-label").textContent, "吐く");
  app.pagehide(); assert.ok(app.audioNodes.every((node) => node.disconnected));
});

test("呼吸ガイドの切り替え・音量・ベル変更で環境音とガイドを不要に再開始しない", async () => {
  const app = harness(); app.radio("sound", "rain"); app.click("start-button"); await flush();
  const rain = app.audioNodes.find((node) => node.kind === "source");
  app.advance(8500); app.input("guide-enabled", true, "change"); await flush();
  const guide = guideSources(app)[0]; assert.equal(guide.offsets[0], 8.5);
  app.input("volume", 60); app.input("bell-enabled", true, "change"); await flush();
  app.input("bell-enabled", false, "change"); await flush();
  assert.equal(guideSources(app).length, 1); assert.equal(rain.stops.length, 0);
  assert.ok(!guide.disconnected);
  app.input("guide-enabled", false, "change"); await flush(); app.advance(500);
  assert.ok(guide.disconnected); assert.ok(!rain.disconnected); assert.equal(rain.stops.length, 0);
});

test("音量0ではガイドも無音になり、音量を戻すと現在の呼吸の位相から再開する", async () => {
  const app = harness(); app.input("guide-enabled", true, "change"); app.input("volume", 0); app.click("start-button"); await flush();
  assert.equal(app.audioContexts.length, 0);
  app.advance(6500); app.input("volume", 35); await flush();
  assert.equal(guideSources(app)[0].offsets[0], 6.5);
  app.input("volume", 0); await flush(); app.advance(500);
  assert.ok(app.audioNodes.every((node) => node.disconnected)); assert.equal(app.audioContexts[0].state, "suspended");
  app.advance(2000); app.input("volume", 35); await flush();
  assert.equal(guideSources(app).at(-1).offsets[0], 9);
});

test("音声中断とイベントのない音声時計停止から復帰した際も、ガイドの位相を補正する", async () => {
  const app = harness(); app.input("guide-enabled", true, "change"); app.click("start-button"); await flush();
  const context = app.audioContexts[0]; app.advance(2000); context.changeState("interrupted");
  assert.ok(guideSources(app)[0].disconnected);
  app.advance(30_000); context.changeState("running");
  assert.equal(guideSources(app).at(-1).offsets[0], 8);
  context.pauseAudioClock(); app.elapseWithoutCallbacks(5000); app.visibility(true); app.visibility(false);
  const replacement = guideSources(app).at(-1);
  assert.equal(replacement.offsets[0], 1);
  assert.equal(guideSources(app).length, 3);
  context.resumeAudioClock(); app.advance(500);
  assert.ok(guideSources(app).slice(0, -1).every((node) => node.disconnected));
});

test("画面の更新が止まっても音声時計でガイドを終了し、終了処理が予約を延長しない", async () => {
  const app = harness(); app.radio("duration", 1); app.input("guide-enabled", true, "change"); app.click("start-button"); await flush();
  const source = guideSources(app)[0]; assert.equal(source.stops[0], 60);
  app.visibility(true); app.elapseWithoutCallbacks(60_000); app.endAudio();
  assert.ok(source.disconnected); assert.equal(app.byId("complete-view").hidden, true);
  app.visibility(false); assert.equal(app.byId("complete-view").hidden, false);
  assert.equal(app.audioContexts[0].state, "suspended");
  const immediate = harness(); immediate.radio("duration", 1); immediate.input("guide-enabled", true, "change"); immediate.click("start-button"); await flush();
  immediate.advance(60_000);
  assert.ok(guideSources(immediate)[0].stops.at(-1) <= 60);
  assert.ok(immediate.audioNodes.every((node) => node.disconnected));
});

test("ガイドの生成失敗・開始待ちの取り消しでも、音を残さずタイマーを継続する", async () => {
  for (const audioFaults of [{ createAt: 2 }, { connect: true }, { startKind: "source" }]) {
    const app = harness({ audioFaults }); app.input("guide-enabled", true, "change"); app.click("start-button"); await flush();
    assert.equal(app.byId("audio-notice").hidden, false); assert.ok(app.audioNodes.every((node) => node.disconnected));
    app.jump(180_000); assert.equal(app.byId("complete-view").hidden, false);
  }
  const pending = harness({ pendingResume: true }); pending.input("guide-enabled", true, "change"); pending.click("start-button");
  pending.input("guide-enabled", false, "change"); pending.audioContexts[0].resolveResume(); await flush();
  assert.equal(guideSources(pending).length, 0); assert.equal(pending.audioContexts[0].state, "suspended");
});

test("ガイドと終了ベルを併用しても一度だけ終了し、余韻の後は全ての音を解放する", async () => {
  const app = harness(); app.radio("duration", 1); app.radio("sound", "waves");
  app.input("guide-enabled", true, "change"); app.input("bell-enabled", true, "change"); app.click("start-button"); await flush();
  const guide = guideSources(app)[0];
  const bellSources = app.audioNodes.filter((node) => node.kind === "oscillator" && node.frequency.value >= 660);
  assert.equal(bellSources.length, 3); assert.ok(bellSources.every((node) => node.starts[0] === 60));
  app.advance(60_000);
  assert.equal(app.byId("complete-view").hidden, false); assert.ok(guide.disconnected);
  assert.ok(bellSources.every((node) => !node.disconnected));
  app.advance(3000);
  assert.ok(app.audioNodes.every((node) => node.disconnected)); assert.equal(app.audioContexts[0].state, "suspended");
  app.click("restart-button"); await flush();
  assert.equal(guideSources(app).at(-1).offsets[0], 0);
  app.click("stop-button"); app.advance(500); assert.ok(app.audioNodes.every((node) => node.disconnected));
});
