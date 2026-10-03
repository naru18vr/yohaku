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
  let now = 0, nextTask = 1;
  const timers = new Map(), frames = new Map(), storage = new Map(), media = new Map();
  const audioContexts = [], audioNodes = [];
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
  const param = (value = 0) => ({ value, setValueAtTime(value) { this.value = value; }, linearRampToValueAtTime(value) { this.value = value; }, exponentialRampToValueAtTime(value) { this.value = value; }, setTargetAtTime(value) { this.value = value; }, cancelScheduledValues() {}, cancelAndHoldAtTime() {} });
  const node = (kind) => {
    const result = { kind, gain: param(), frequency: param(), Q: param(), connections: [], starts: [], stops: [], connect(target) { this.connections.push(target); return target; }, disconnect() { this.disconnected = true; }, start(at = now / 1000) { this.starts.push(at); }, stop(at = now / 1000) { this.stops.push(at); } };
    audioNodes.push(result);
    return result;
  };
  class AudioContext {
    constructor() {
      if (options.audioFailure === "construct") throw new Error("unavailable");
      this.state = "running"; this.sampleRate = 8000; this.destination = {}; this.listeners = {}; audioContexts.push(this);
    }
    get currentTime() { return now / 1000; }
    addEventListener(type, fn) { this.listeners[type] = fn; }
    resume() {
      if (options.audioFailure === "resume") return Promise.reject(new Error("blocked"));
      if (options.pendingResume) return new Promise((resolve) => { this.resolveResume = resolve; });
      this.state = "running"; return Promise.resolve();
    }
    createBuffer(channels, length) { const data = Array.from({ length: channels }, () => new Float32Array(length)); return { numberOfChannels: channels, getChannelData: (channel) => data[channel] }; }
    createBufferSource() { return node("source"); }
    createBiquadFilter() { return node("filter"); }
    createGain() { return node("gain"); }
    createOscillator() { return node("oscillator"); }
  }
  const window = {
    AudioContext, listeners: {},
    setTimeout(fn, delay) { const id = nextTask++; timers.set(id, { at: now + delay, fn }); return id; },
    clearTimeout(id) { timers.delete(id); },
    requestAnimationFrame(fn) { const id = nextTask++; frames.set(id, fn); return id; },
    cancelAnimationFrame(id) { frames.delete(id); },
    addEventListener(type, fn) { (this.listeners[type] ||= []).push(fn); },
    matchMedia(query) { if (!media.has(query)) media.set(query, { matches: query.includes("motion") ? !!options.reducedMotion : !!options.dark, addEventListener(type, fn) { this.listener = fn; } }); return media.get(query); },
  };
  class ClockDate extends Date { static now() { return now; } }
  vm.runInNewContext(script, { window, document, localStorage, Date: ClockDate, console });
  return {
    byId, storage, audioContexts, audioNodes, timers, frames, document,
    click(id) { byId(id).dispatch("click"); },
    openSettings() { const button = selectAll(".settings-trigger").find((element) => !element.closest("[hidden]")); button.dispatch("click"); return button; },
    radio(name, value) { const group = selectAll(`input[name="${name}"]`); group.forEach((element) => { element.checked = element.value === String(value); }); group.find((element) => element.checked).dispatch("change"); },
    input(id, value, type = "input") { const element = byId(id); if (type === "change") element.checked = value; else element.value = value; element.dispatch(type); },
    advance(ms) {
      const end = now + ms;
      while (timers.size) {
        const [id, task] = [...timers].sort((a, b) => a[1].at - b[1].at)[0];
        if (task.at > end) break;
        now = task.at; timers.delete(id); task.fn();
      }
      now = end;
    },
    jump(ms) { now += ms; for (const [id, task] of [...timers]) if (task.at <= now) { timers.delete(id); task.fn(); } },
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
  assert.equal(samples[0], samples.at(-1));
  assert.ok(app.audioNodes.some((node) => node.kind === "filter" && node.frequency.value === 3200));
  app.input("volume", 70);
  assert.ok(app.audioNodes.some((node) => node.kind === "gain" && Math.abs(node.gain.value - 0.315) < 0.00001));
  app.radio("sound", "waves"); await flush();
  assert.ok(source.stops.length > 0);
  assert.ok(app.audioNodes.some((node) => node.kind === "oscillator" && node.frequency.value === 1 / 11));
  assert.ok(app.audioNodes.some((node) => node.kind === "filter" && node.frequency.value === 650));
  app.radio("sound", "silent"); await flush();
  assert.equal(app.byId("volume").disabled, true);
  assert.ok(app.audioNodes.filter((node) => node.kind === "source").every((node) => node.stops.length > 0));
});

test("ベルは明示的ONの時だけ一度予約し、停止・再開で旧ベルを取り消す", async () => {
  const app = harness(); app.input("bell-enabled", true, "change"); app.click("start-button"); await flush();
  let bells = app.audioNodes.filter((node) => node.kind === "oscillator");
  assert.equal(bells.length, 3); assert.ok(bells.every((node) => node.starts[0] === 180));
  app.advance(10_000); app.click("pause-button");
  assert.ok(bells.every((node) => node.disconnected));
  app.jump(30_000); app.click("pause-button"); await flush();
  bells = app.audioNodes.filter((node) => node.kind === "oscillator");
  assert.equal(bells.length, 6); assert.ok(bells.slice(3).every((node) => node.starts[0] === 210));
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
