"use strict";

(() => {
  const STORAGE_KEY = "yohaku-settings-v1";
  const MINUTE_MS = 60_000;
  const UPDATE_INTERVAL_MS = 200;
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
        volume: Number.isFinite(saved.volume) ? Math.min(100, Math.max(0, saved.volume)) : defaults.volume,
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
      this.bellNodes = [];
      this.bellGain = null;
      this.version = 0;
      this.wantsAudio = false;
    }

    async play() {
      const version = ++this.version;
      this.stopAmbient();
      this.cancelBell();
      this.wantsAudio = settings.volume > 0 && (settings.sound !== "silent" || settings.bell);
      clearAudioNotice();
      if (!this.wantsAudio) return;
      try {
        if (!this.context || this.context.state === "closed") {
          const Context = window.AudioContext || window.webkitAudioContext;
          if (!Context) throw new Error("Audio unavailable");
          this.context = new Context();
          this.noiseBuffer = null;
          this.context.addEventListener("statechange", () => {
            if (!this.wantsAudio || state !== "running") return;
            if (this.context.state === "running") clearAudioNotice();
            else showAudioNotice("音が止まっています。無音のままでも休めます。", true);
          });
        }
        // resume()はクリック処理中に呼び、自動再生にはしません。
        await this.context.resume();
        if (version !== this.version || state !== "running") return;
        if (this.context.state !== "running") throw new Error("Audio paused");
        const left = Math.max(0, endTime - Date.now());
        if (left === 0) return;
        if (settings.sound !== "silent") this.startAmbient(settings.sound);
        if (settings.bell) this.scheduleBell(left);
      } catch {
        if (version === this.version && state === "running") {
          this.stopAmbient();
          this.cancelBell();
          showAudioNotice("音を再生できませんでした。無音のままでも休めます。", true);
        }
      }
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
      const source = context.createBufferSource();
      source.buffer = this.noiseBuffer;
      source.loop = true;
      const lowpass = context.createBiquadFilter();
      lowpass.type = "lowpass";
      lowpass.frequency.value = sound === "rain" ? 3200 : 650;
      lowpass.Q.value = 0.5;
      const highpass = context.createBiquadFilter();
      highpass.type = "highpass";
      highpass.frequency.value = sound === "rain" ? 180 : 60;
      highpass.Q.value = 0.5;
      const texture = context.createGain();
      texture.gain.value = sound === "rain" ? 1 : 0.62;
      const volume = context.createGain();
      volume.gain.value = settings.volume / 100 * 0.45;
      const envelope = context.createGain();
      envelope.gain.setValueAtTime(0, context.currentTime);
      envelope.gain.linearRampToValueAtTime(1, context.currentTime + 1.5);
      source.connect(lowpass).connect(highpass).connect(texture).connect(volume).connect(envelope).connect(context.destination);
      const nodes = [source, lowpass, highpass, texture, volume, envelope];
      let swell = null;
      if (sound === "waves") {
        swell = context.createOscillator();
        swell.frequency.value = 1 / 11;
        const depth = context.createGain();
        depth.gain.value = 0.28;
        swell.connect(depth).connect(texture.gain);
        nodes.push(swell, depth);
        swell.start();
      }
      source.onended = () => nodes.forEach((node) => node.disconnect());
      source.start();
      this.ambient = { source, volume, envelope, swell };
    }

    setVolume() {
      if (!this.context) return;
      const now = this.context.currentTime;
      if (this.ambient) this.ambient.volume.gain.setTargetAtTime(settings.volume / 100 * 0.45, now, 0.08);
      if (this.bellGain) this.bellGain.gain.setTargetAtTime(settings.volume / 100 * 0.1, now, 0.08);
    }

    scheduleBell(left) {
      const context = this.context;
      const at = context.currentTime + left / 1000;
      const master = context.createGain();
      master.gain.value = settings.volume / 100 * 0.1;
      master.connect(context.destination);
      this.bellGain = master;
      const partials = [[660, 0.6], [990, 0.18], [1650, 0.08]];
      this.bellNodes = partials.map(([frequency, level]) => {
        const oscillator = context.createOscillator();
        oscillator.frequency.value = frequency;
        const envelope = context.createGain();
        envelope.gain.setValueAtTime(0, context.currentTime);
        envelope.gain.setValueAtTime(0, at);
        envelope.gain.linearRampToValueAtTime(level, at + 0.03);
        envelope.gain.exponentialRampToValueAtTime(0.0001, at + 2.8);
        oscillator.connect(envelope).connect(master);
        oscillator.onended = () => { oscillator.disconnect(); envelope.disconnect(); };
        oscillator.start(at);
        oscillator.stop(at + 3);
        return oscillator;
      });
    }

    stopAmbient() {
      if (!this.ambient) return;
      const { source, envelope, swell } = this.ambient;
      const now = this.context.currentTime;
      if (typeof envelope.gain.cancelAndHoldAtTime === "function") envelope.gain.cancelAndHoldAtTime(now);
      else { envelope.gain.cancelScheduledValues(now); envelope.gain.setValueAtTime(envelope.gain.value, now); }
      envelope.gain.linearRampToValueAtTime(0, now + 0.45);
      source.stop(now + 0.5);
      if (swell) swell.stop(now + 0.5);
      this.ambient = null;
    }

    cancelBell() {
      this.bellNodes.forEach((node) => { try { node.stop(); node.disconnect(); } catch { /* 終了済みの音は無視します。 */ } });
      this.bellNodes = [];
      if (this.bellGain) this.bellGain.disconnect();
      this.bellGain = null;
    }

    stop(keepBell = false) {
      this.version++;
      this.wantsAudio = false;
      this.stopAmbient();
      if (!keepBell || this.context?.state !== "running") this.cancelBell();
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

  function getRemaining() { return state === "running" ? Math.max(0, endTime - Date.now()) : remainingMs; }

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
    } else { circle.style.transform = "scale(1)"; circle.style.opacity = "0.85"; }
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
    if (!motionPreference.matches && !document.hidden) animationFrame = window.requestAnimationFrame(animate);
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
  }));
  byId("volume").addEventListener("input", (event) => {
    const previousVolume = settings.volume;
    settings.volume = Number(event.target.value);
    byId("volume-value").value = `${settings.volume}%`;
    saveSettings();
    if (state === "running") {
      if (previousVolume === 0 || settings.volume === 0) void audio.play();
      else audio.setVolume();
    }
  });
  byId("bell-enabled").addEventListener("change", (event) => {
    settings.bell = event.target.checked;
    saveSettings();
    syncSettings();
    if (state === "running") void audio.play();
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
    else { update(); if (state === "running") beginAnimation(); }
  });
  window.addEventListener("pagehide", () => { if (state === "running") pauseOrResume(); audio.stop(); });
  motionPreference.addEventListener("change", () => { if (state === "running") beginAnimation(); });
  colorPreference.addEventListener("change", applyTheme);
  syncSettings();
})();
