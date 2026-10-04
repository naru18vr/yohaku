"use strict";

(() => {
  const STORAGE_KEY = "yohaku-settings-v1";
  const MINUTE_MS = 60_000;
  const UPDATE_INTERVAL_MS = 200;
  const AUDIO = { ambientLevel: 0.45, bellLevel: 0.1, fadeIn: 1.5, fadeOut: 0.45, stopDelay: 0.5, bellDuration: 3, bellGrace: 0.25 };
  const BREATH = { inhale: 4_000, hold: 2_000, exhale: 6_000, minScale: 0.82, maxScale: 1.08 };
  const BREATH_CYCLE_MS = BREATH.inhale + BREATH.hold + BREATH.exhale;
  const SOUND_NAMES = { silent: "無音", rain: "雨", waves: "波" };
  const defaults = { minutes: 3, sound: "silent", volume: 35, bell: false, theme: "auto" };
  const byId = (id) => document.getElementById(id);
  const settings = loadSettings();
  const views = { home: byId("home-view"), session: byId("session-view"), complete: byId("complete-view") };
  const motionPreference = window.matchMedia("(prefers-reduced-motion: reduce)");
  const colorPreference = window.matchMedia("(prefers-color-scheme: dark)");
  const circle = byId("breathing-circle");
  let state = "home";
  let totalMs = settings.minutes * MINUTE_MS;
  let remainingMs = totalMs;
  let endTime = 0;
  let timerTask = 0;
  let animationFrame = 0;
  let timeHidden = false;
  let lastSecond = -1;
  let settingsOpener = null;

  function loadSettings() {
    try {
      const saved = JSON.parse(localStorage.getItem(STORAGE_KEY));
      if (!saved || typeof saved !== "object") return { ...defaults };
      return {
        minutes: [1, 3, 5, 10].includes(saved.minutes) ? saved.minutes : defaults.minutes,
        sound: Object.hasOwn(SOUND_NAMES, saved.sound) ? saved.sound : defaults.sound,
        volume: Number.isFinite(saved.volume) ? Math.round(Math.min(100, Math.max(0, saved.volume))) : defaults.volume,
        bell: typeof saved.bell === "boolean" ? saved.bell : defaults.bell,
        theme: ["auto", "light", "dark"].includes(saved.theme) ? saved.theme : defaults.theme,
      };
    } catch {
      return { ...defaults };
    }
  }

  function saveSettings() {
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(settings)); } catch { /* 保存できなくても休めます。 */ }
  }

  class SoundEngine {
    constructor() {
      this.context = null;
      this.noiseBuffer = null;
      this.ambient = null;
      this.bell = null;
      this.graphs = new Set();
      this.version = 0;
      this.wantsAudio = false;
      this.ready = false;
    }

    async play() {
      const version = ++this.version;
      this.ready = false;
      this.cancelBell();
      this.wantsAudio = settings.volume > 0 && (settings.sound !== "silent" || settings.bell);
      clearAudioNotice();
      if (!this.wantsAudio) {
        this.stopAmbient();
        this.suspendIfIdle();
        return;
      }
      try {
        if (!this.context || this.context.state === "closed") {
          this.disposeAll();
          const Context = window.AudioContext || window.webkitAudioContext;
          if (!Context) throw new Error("Audio unavailable");
          const context = new Context();
          this.context = context;
          this.noiseBuffer = null;
          context.addEventListener("statechange", () => this.onStateChange(context));
        }
        // resume()はクリック処理中に呼び、自動再生にはしません。
        await this.context.resume();
        if (version !== this.version || state !== "running") { this.suspendIfIdle(); return; }
        if (this.context.state !== "running") throw new Error("Audio paused");
        this.ready = true;
        this.syncPlayback();
      } catch {
        if (version === this.version && state === "running") this.fail();
      }
    }

    onStateChange(context) {
      if (!context || context !== this.context) return;
      if (context.state !== "running") {
        this.cancelBell();
        for (const graph of [...this.graphs]) if (graph !== this.ambient || context.state === "closed") this.disposeGraph(graph);
        if (this.wantsAudio && state === "running") showAudioNotice("音が止まっています。無音のままでも休めます。", true);
        return;
      }
      if (this.wantsAudio && state === "running" && this.ready) {
        try { this.syncPlayback(); } catch { this.fail(); }
      } else this.suspendIfIdle();
    }

    syncPlayback() {
      const left = getRemaining();
      this.cancelBell();
      if (left === 0) { update(); return; }
      if (this.ambient?.sound !== settings.sound) this.stopAmbient();
      if (settings.sound !== "silent" && !this.ambient) this.startAmbient(settings.sound);
      this.setVolume();
      if (settings.bell) this.scheduleBell(left);
      clearAudioNotice();
    }

    createGraph() {
      const graph = { nodes: [], sources: [], disposed: false };
      this.graphs.add(graph);
      return graph;
    }

    disposeGraph(graph) {
      if (!graph || graph.disposed) return;
      graph.disposed = true;
      for (const source of graph.sources) { try { source.stop(); } catch { /* 未開始・終了済みでも切断します。 */ } }
      for (const node of graph.nodes) { try { node.disconnect(); } catch { /* 切断済みのノードは無視します。 */ } }
      this.graphs.delete(graph);
      if (this.ambient === graph) this.ambient = null;
      if (this.bell === graph) this.bell = null;
      this.suspendIfIdle();
    }

    disposeAll() { for (const graph of [...this.graphs]) this.disposeGraph(graph); }

    suspendIfIdle() {
      if (this.wantsAudio || this.graphs.size || !this.context || this.context.state === "closed" || this.context.state === "suspended") return;
      try { void this.context.suspend().catch(() => {}); } catch { /* 音の後片付けでタイマーを止めません。 */ }
    }

    fail() {
      this.version++;
      this.ready = false;
      this.wantsAudio = false;
      this.disposeAll();
      this.suspendIfIdle();
      if (state === "running") showAudioNotice("音を再生できませんでした。無音のままでも休めます。", true);
    }

    createNoiseBuffer() {
      const context = this.context;
      const buffer = context.createBuffer(2, context.sampleRate * 4, context.sampleRate);
      for (let channel = 0; channel < buffer.numberOfChannels; channel++) {
        const samples = buffer.getChannelData(channel);
        let b0 = 0, b1 = 0, b2 = 0, b3 = 0, b4 = 0, b5 = 0, b6 = 0;
        for (let i = 0; i < samples.length; i++) {
          const white = Math.random() * 2 - 1;
          b0 = 0.99886 * b0 + white * 0.0555179;
          b1 = 0.99332 * b1 + white * 0.0750759;
          b2 = 0.969 * b2 + white * 0.153852;
          b3 = 0.8665 * b3 + white * 0.3104856;
          b4 = 0.55 * b4 + white * 0.5329522;
          b5 = -0.7616 * b5 - white * 0.016898;
          samples[i] = Math.max(-1, Math.min(1, (b0 + b1 + b2 + b3 + b4 + b5 + b6 + white * 0.5362) * 0.11));
          b6 = white * 0.115926;
        }
        // 短いクロスフェードでループ境界のクリック音を抑えます。
        const blendLength = Math.floor(context.sampleRate * 0.08);
        const seam = (samples[0] + samples[samples.length - 1]) / 2;
        for (let i = 0; i < blendLength; i++) {
          const weight = i / blendLength;
          samples[i] = seam * (1 - weight) + samples[i] * weight;
          const end = samples.length - 1 - i;
          samples[end] = seam * (1 - weight) + samples[end] * weight;
        }
      }
      return buffer;
    }

    startAmbient(sound) {
      const context = this.context;
      if (!this.noiseBuffer) this.noiseBuffer = this.createNoiseBuffer();
      const graph = this.createGraph();
      this.ambient = graph;
      graph.sound = sound;
      const addNode = (node) => { graph.nodes.push(node); return node; };
      const source = context.createBufferSource();
      addNode(source);
      graph.sources.push(source);
      source.buffer = this.noiseBuffer;
      source.loop = true;
      const lowpass = addNode(context.createBiquadFilter());
      lowpass.type = "lowpass";
      lowpass.frequency.value = sound === "rain" ? 3200 : 650;
      lowpass.Q.value = 0.5;
      const highpass = addNode(context.createBiquadFilter());
      highpass.type = "highpass";
      highpass.frequency.value = sound === "rain" ? 180 : 60;
      highpass.Q.value = 0.5;
      const texture = addNode(context.createGain());
      texture.gain.value = sound === "rain" ? 1 : 0.62;
      const volume = addNode(context.createGain());
      graph.volume = volume;
      volume.gain.value = settings.volume / 100 * AUDIO.ambientLevel;
      const envelope = addNode(context.createGain());
      graph.envelope = envelope;
      graph.startedAt = context.currentTime;
      envelope.gain.setValueAtTime(0, graph.startedAt);
      envelope.gain.linearRampToValueAtTime(1, graph.startedAt + AUDIO.fadeIn);
      source.connect(lowpass).connect(highpass).connect(texture).connect(volume).connect(envelope).connect(context.destination);
      if (sound === "waves") {
        const swell = addNode(context.createOscillator());
        graph.sources.push(swell);
        swell.frequency.value = 1 / 11;
        const depth = addNode(context.createGain());
        depth.gain.value = 0.28;
        swell.connect(depth).connect(texture.gain);
        swell.start();
      }
      source.onended = () => this.disposeGraph(graph);
      source.start();
    }

    setVolume() {
      if (!this.context) return;
      const now = this.context.currentTime;
      if (this.ambient) this.ambient.volume.gain.setTargetAtTime(settings.volume / 100 * AUDIO.ambientLevel, now, 0.08);
      if (this.bell) this.bell.master.gain.setTargetAtTime(settings.volume / 100 * AUDIO.bellLevel, now, 0.08);
    }

    scheduleBell(left) {
      const context = this.context;
      const at = context.currentTime + left / 1000;
      const graph = this.createGraph();
      this.bell = graph;
      graph.at = at;
      const master = context.createGain();
      graph.nodes.push(master);
      graph.master = master;
      master.gain.value = settings.volume / 100 * AUDIO.bellLevel;
      master.connect(context.destination);
      const partials = [[660, 0.6], [990, 0.18], [1650, 0.08]];
      let unfinished = partials.length;
      for (const [frequency, level] of partials) {
        const oscillator = context.createOscillator();
        graph.nodes.push(oscillator);
        graph.sources.push(oscillator);
        oscillator.frequency.value = frequency;
        const envelope = context.createGain();
        graph.nodes.push(envelope);
        envelope.gain.setValueAtTime(0, context.currentTime);
        envelope.gain.setValueAtTime(0, at);
        envelope.gain.linearRampToValueAtTime(level, at + 0.03);
        envelope.gain.exponentialRampToValueAtTime(0.0001, at + 2.8);
        oscillator.connect(envelope).connect(master);
        oscillator.onended = () => { if (!graph.disposed && --unfinished === 0) this.disposeGraph(graph); };
        oscillator.start(at);
        oscillator.stop(at + AUDIO.bellDuration);
      }
    }

    stopAmbient() {
      if (!this.ambient) return;
      const graph = this.ambient;
      this.ambient = null;
      if (this.context.state !== "running" || !graph.envelope) { this.disposeGraph(graph); return; }
      try {
        const now = this.context.currentTime;
        const gain = graph.envelope.gain;
        if (typeof gain.cancelAndHoldAtTime === "function") gain.cancelAndHoldAtTime(now);
        else {
          const heldValue = Math.min(1, Math.max(0, (now - graph.startedAt) / AUDIO.fadeIn));
          gain.cancelScheduledValues(now);
          gain.setValueAtTime(heldValue, now);
        }
        gain.linearRampToValueAtTime(0, now + AUDIO.fadeOut);
        graph.sources.forEach((source) => source.stop(now + AUDIO.stopDelay));
      } catch { this.disposeGraph(graph); }
    }

    cancelBell() {
      this.disposeGraph(this.bell);
    }

    stop(keepBell = false) {
      this.version++;
      this.ready = false;
      this.wantsAudio = false;
      this.stopAmbient();
      const bellIsDue = this.bell && this.context?.state === "running" && this.context.currentTime + AUDIO.bellGrace >= this.bell.at;
      if (!keepBell || !bellIsDue) this.cancelBell();
      this.suspendIfIdle();
    }
  }

  const audio = new SoundEngine();

  function clearAudioNotice() { byId("audio-notice").hidden = true; byId("retry-audio").hidden = true; }
  function showAudioNotice(message, retry) {
    byId("audio-notice").textContent = message;
    byId("audio-notice").hidden = false;
    byId("retry-audio").hidden = !retry;
  }

  function applyTheme() {
    if (settings.theme === "auto") delete document.documentElement.dataset.theme;
    else document.documentElement.dataset.theme = settings.theme;
    const dark = settings.theme === "dark" || (settings.theme === "auto" && colorPreference.matches);
    document.querySelector('meta[name="theme-color"]').content = dark ? "#252e29" : "#f5f3ed";
  }

  function syncSettings() {
    document.querySelectorAll('input[name="duration"]').forEach((input) => { input.checked = Number(input.value) === settings.minutes; });
    document.querySelectorAll('input[name="sound"]').forEach((input) => { input.checked = input.value === settings.sound; });
    document.querySelectorAll('input[name="theme"]').forEach((input) => { input.checked = input.value === settings.theme; });
    byId("start-label").textContent = `${settings.minutes}分休む`;
    byId("restart-button").textContent = `もう${settings.minutes}分休む`;
    document.querySelectorAll(".sound-label").forEach((label) => { label.textContent = SOUND_NAMES[settings.sound]; });
    byId("volume").value = settings.volume;
    byId("volume-value").value = `${settings.volume}%`;
    byId("volume").disabled = settings.sound === "silent" && !settings.bell;
    byId("bell-enabled").checked = settings.bell;
    applyTheme();
  }

  function showView(name, focusId) {
    Object.entries(views).forEach(([key, element]) => { element.hidden = key !== name; });
    if (focusId && !byId("settings-dialog").open) byId(focusId).focus({ preventScroll: true });
  }

  function cancelUpdates() {
    window.clearTimeout(timerTask);
    window.cancelAnimationFrame(animationFrame);
    timerTask = 0;
    animationFrame = 0;
  }

  function getRemaining() { return state === "running" ? Math.max(0, Math.min(remainingMs, endTime - Date.now())) : remainingMs; }

  function renderTime() {
    const seconds = Math.ceil(getRemaining() / 1000);
    if (seconds === lastSecond) return;
    lastSecond = seconds;
    const minutes = Math.floor(seconds / 60).toString().padStart(2, "0");
    const remainder = (seconds % 60).toString().padStart(2, "0");
    byId("timer").textContent = `${minutes}:${remainder}`;
    byId("timer").setAttribute("aria-label", `残り${Math.floor(seconds / 60)}分${seconds % 60}秒`);
  }

  function renderBreath() {
    if (motionPreference.matches) { circle.style.transform = "scale(1)"; circle.style.opacity = "0.85"; }
    if (state === "paused") { byId("breath-label").textContent = "ひと休み中"; return; }
    const cycleTime = (totalMs - getRemaining()) % BREATH_CYCLE_MS;
    let scale = BREATH.maxScale;
    let label = "そのまま";
    const ease = (progress) => (1 - Math.cos(Math.PI * progress)) / 2;
    if (cycleTime < BREATH.inhale) {
      label = "吸う";
      scale = BREATH.minScale + (BREATH.maxScale - BREATH.minScale) * ease(cycleTime / BREATH.inhale);
    } else if (cycleTime >= BREATH.inhale + BREATH.hold) {
      label = "吐く";
      const progress = (cycleTime - BREATH.inhale - BREATH.hold) / BREATH.exhale;
      scale = BREATH.maxScale - (BREATH.maxScale - BREATH.minScale) * ease(progress);
    }
    if (byId("breath-label").textContent !== label) byId("breath-label").textContent = label;
    if (!motionPreference.matches) {
      circle.style.transform = `scale(${scale})`;
      circle.style.opacity = String(0.72 + (scale - BREATH.minScale) / (BREATH.maxScale - BREATH.minScale) * 0.2);
    }
  }

  function animate() {
    animationFrame = 0;
    if (state !== "running" || document.hidden || motionPreference.matches) return;
    renderBreath();
    animationFrame = window.requestAnimationFrame(animate);
  }

  function beginAnimation() {
    window.cancelAnimationFrame(animationFrame);
    renderBreath();
    if (state === "running" && !motionPreference.matches && !document.hidden) animationFrame = window.requestAnimationFrame(animate);
  }

  function update() {
    window.clearTimeout(timerTask);
    if (state !== "running") return;
    remainingMs = getRemaining();
    renderTime();
    renderBreath();
    if (remainingMs === 0) { complete(); return; }
    timerTask = window.setTimeout(update, UPDATE_INTERVAL_MS);
  }

  function start() {
    cancelUpdates();
    audio.stop();
    state = "running";
    totalMs = settings.minutes * MINUTE_MS;
    remainingMs = totalMs;
    endTime = Date.now() + remainingMs;
    lastSecond = -1;
    byId("pause-button").textContent = "一時停止";
    byId("session-title").textContent = "いまは、ただ休む。";
    showView("session", "session-title");
    byId("announcer").textContent = `${settings.minutes}分、休みます。呼吸は、あなたのペースで。`;
    void audio.play();
    update();
    beginAnimation();
  }

  function pauseOrResume() {
    if (state === "running") {
      remainingMs = getRemaining();
      if (remainingMs === 0) { complete(); return; }
      state = "paused";
      cancelUpdates();
      audio.stop();
      clearAudioNotice();
      byId("pause-button").textContent = "再開する";
      byId("session-title").textContent = "このまま、ひと息。";
      renderTime();
      renderBreath();
      byId("announcer").textContent = "一時停止しました。再開せずに終わっても大丈夫です。";
    } else if (state === "paused") {
      state = "running";
      endTime = Date.now() + remainingMs;
      byId("pause-button").textContent = "一時停止";
      byId("session-title").textContent = "いまは、ただ休む。";
      byId("announcer").textContent = "休む時間を再開しました。";
      void audio.play();
      update();
      beginAnimation();
    }
  }

  function complete() {
    if (state !== "running") return;
    state = "complete";
    remainingMs = 0;
    cancelUpdates();
    audio.stop(true);
    clearAudioNotice();
    showView("complete", "complete-title");
    byId("announcer").textContent = "休む時間が終わりました。おつかれさま。";
  }

  function goHome() {
    state = "home";
    cancelUpdates();
    audio.stop();
    clearAudioNotice();
    showView("home", "start-button");
    byId("announcer").textContent = "今日はここまででも、大丈夫。";
  }

  byId("start-button").addEventListener("click", start);
  byId("restart-button").addEventListener("click", start);
  byId("pause-button").addEventListener("click", pauseOrResume);
  byId("stop-button").addEventListener("click", goHome);
  byId("finish-button").addEventListener("click", goHome);
  byId("retry-audio").addEventListener("click", () => { if (state === "running") void audio.play(); });
  byId("time-toggle").addEventListener("click", () => {
    timeHidden = !timeHidden;
    byId("timer").hidden = timeHidden;
    byId("time-hidden-label").hidden = !timeHidden;
    byId("time-toggle").setAttribute("aria-label", timeHidden ? "残り時間を表示する" : "残り時間を隠す");
    byId("time-toggle").setAttribute("aria-pressed", String(timeHidden));
    if (timeHidden) byId("time-toggle").removeAttribute("aria-describedby");
    else byId("time-toggle").setAttribute("aria-describedby", "timer");
  });
  document.querySelectorAll('input[name="duration"]').forEach((input) => input.addEventListener("change", () => {
    settings.minutes = Number(input.value);
    saveSettings();
    syncSettings();
  }));
  document.querySelectorAll('input[name="sound"]').forEach((input) => input.addEventListener("change", () => {
    settings.sound = input.value;
    saveSettings();
    syncSettings();
    if (state === "running") void audio.play();
    else audio.stop();
  }));
  byId("volume").addEventListener("input", (event) => {
    const previousVolume = settings.volume;
    settings.volume = Number(event.target.value);
    byId("volume-value").value = `${settings.volume}%`;
    saveSettings();
    if (state === "running") {
      if (previousVolume === 0 || settings.volume === 0 || !audio.ready || audio.context?.state !== "running") void audio.play();
      else { try { audio.setVolume(); } catch { audio.fail(); } }
    } else { try { audio.setVolume(); } catch { audio.stop(); } }
  });
  byId("bell-enabled").addEventListener("change", (event) => {
    settings.bell = event.target.checked;
    saveSettings();
    syncSettings();
    if (state === "running") void audio.play();
    else audio.stop();
  });
  document.querySelectorAll('input[name="theme"]').forEach((input) => input.addEventListener("change", () => {
    settings.theme = input.value;
    saveSettings();
    applyTheme();
  }));
  document.querySelectorAll(".settings-trigger").forEach((button) => button.addEventListener("click", () => {
    settingsOpener = button;
    byId("settings-dialog").showModal();
  }));
  byId("close-settings").addEventListener("click", () => byId("settings-dialog").close());
  byId("settings-dialog").addEventListener("click", (event) => {
    const bounds = event.currentTarget.getBoundingClientRect();
    if (event.target === event.currentTarget && (event.clientX < bounds.left || event.clientX > bounds.right || event.clientY < bounds.top || event.clientY > bounds.bottom)) event.currentTarget.close();
  });
  byId("settings-dialog").addEventListener("close", () => {
    if (settingsOpener && !settingsOpener.closest("[hidden]")) settingsOpener.focus({ preventScroll: true });
    else if (state === "complete") byId("complete-title").focus({ preventScroll: true });
  });
  document.addEventListener("visibilitychange", () => {
    if (state !== "running") return;
    if (document.hidden) { window.cancelAnimationFrame(animationFrame); animationFrame = 0; }
    else {
      update();
      if (state === "running") { beginAnimation(); audio.onStateChange(audio.context); }
    }
  });
  window.addEventListener("pagehide", () => { if (state === "running") pauseOrResume(); audio.stop(); audio.disposeAll(); });
  motionPreference.addEventListener("change", () => { if (state === "running" || state === "paused") beginAnimation(); });
  colorPreference.addEventListener("change", applyTheme);
  syncSettings();
})();
