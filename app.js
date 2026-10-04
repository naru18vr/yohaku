"use strict";

(() => {
  const STORAGE_KEY = "yohaku-settings-v1";
  const MINUTE_MS = 60_000;
  const UPDATE_INTERVAL_MS = 200;
  const AUDIO = { ambientLevel: 0.45, guideLevel: 0.08, bellLevel: 0.1, noiseDuration: 20, noiseBlend: 1, fadeIn: 1.5, guideFadeIn: 0.08, fadeOut: 0.45, stopDelay: 0.5, bellDuration: 3, bellGrace: 0.25, guideTolerance: 0.3 };
  const BREATH = { inhale: 4_000, hold: 2_000, exhale: 6_000, minScale: 0.82, maxScale: 1.08 };
  const BREATH_CYCLE_MS = BREATH.inhale + BREATH.hold + BREATH.exhale;
  const GUIDE = { inhaleFrequency: 523.25, exhaleFrequency: 392, cueDuration: 1.1, attack: 0.12 };
  const SOUND_NAMES = { silent: "無音", rain: "雨", rain2: "雨 fugisako ver", waves: "波" };
  const defaults = { minutes: 3, sound: "silent", volume: 35, guide: false, bell: false, theme: "auto" };
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
        guide: typeof saved.guide === "boolean" ? saved.guide : defaults.guide,
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
      this.guideBuffer = null;
      this.ambient = null;
      this.guide = null;
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
      this.wantsAudio = settings.volume > 0 && (settings.sound !== "silent" || settings.guide || settings.bell);
      clearAudioNotice();
      if (!this.wantsAudio) {
        this.stopAmbient();
        this.stopGuide();
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
          this.guideBuffer = null;
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
      this.syncGuide();
      const remaining = getRemaining();
      if (state !== "running" || remaining === 0) { if (state === "running") update(); return; }
      this.setVolume();
      if (settings.bell) this.scheduleBell(remaining);
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
      if (graph.media) {
        window.clearTimeout(graph.mediaStopTask);
        graph.media.onended = null;
        graph.media.onerror = null;
        graph.media.pause();
        graph.media.removeAttribute("src");
        graph.media.load();
      }
      for (const source of graph.sources) { try { source.stop(); } catch { /* 未開始・終了済みでも切断します。 */ } }
      for (const node of graph.nodes) { try { node.disconnect(); } catch { /* 切断済みのノードは無視します。 */ } }
      this.graphs.delete(graph);
      if (this.ambient === graph) this.ambient = null;
      if (this.guide === graph) this.guide = null;
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
      const length = Math.round(context.sampleRate * AUDIO.noiseDuration);
      const blendLength = Math.round(context.sampleRate * AUDIO.noiseBlend);
      const buffer = context.createBuffer(2, length, context.sampleRate);
      for (let channel = 0; channel < buffer.numberOfChannels; channel++) {
        const samples = buffer.getChannelData(channel);
        const noise = new Float32Array(length + blendLength);
        let b0 = 0, b1 = 0, b2 = 0, b3 = 0, b4 = 0, b5 = 0, b6 = 0;
        for (let i = -context.sampleRate; i < noise.length; i++) {
          const white = Math.random() * 2 - 1;
          b0 = 0.99886 * b0 + white * 0.0555179;
          b1 = 0.99332 * b1 + white * 0.0750759;
          b2 = 0.969 * b2 + white * 0.153852;
          b3 = 0.8665 * b3 + white * 0.3104856;
          b4 = 0.55 * b4 + white * 0.5329522;
          b5 = -0.7616 * b5 - white * 0.016898;
          if (i >= 0) noise[i] = Math.max(-1, Math.min(1, (b0 + b1 + b2 + b3 + b4 + b5 + b6 + white * 0.5362) * 0.11));
          b6 = white * 0.115926;
        }
        samples.set(noise.subarray(0, length));
        // 末尾に続くノイズを先頭へ重ね、つなぎ目でも音の密度を保ちます。
        for (let i = 0; i < blendLength; i++) {
          const angle = i / (blendLength - 1) * Math.PI / 2;
          samples[i] = Math.max(-1, Math.min(1, noise[length + i] * Math.cos(angle) + noise[i] * Math.sin(angle)));
        }
      }
      return buffer;
    }

    startAmbient(sound) {
      if (sound === "rain2") { this.startRecordedRain(); return; }
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
      texture.gain.value = sound === "rain" ? 1 : 0.7;
      const volume = addNode(context.createGain());
      graph.volume = volume;
      volume.gain.value = settings.volume / 100 * AUDIO.ambientLevel;
      const envelope = addNode(context.createGain());
      graph.envelope = envelope;
      graph.startedAt = context.currentTime;
      graph.fadeIn = AUDIO.fadeIn;
      envelope.gain.setValueAtTime(0, graph.startedAt);
      envelope.gain.linearRampToValueAtTime(1, graph.startedAt + AUDIO.fadeIn);
      source.connect(lowpass).connect(highpass).connect(texture).connect(volume).connect(envelope).connect(context.destination);
      if (sound === "waves") {
        const swell = addNode(context.createOscillator());
        graph.sources.push(swell);
        swell.frequency.value = 1 / 11;
        const depth = addNode(context.createGain());
        depth.gain.value = 0.2;
        swell.connect(depth).connect(texture.gain);
        swell.start();
      }
      source.onended = () => this.disposeGraph(graph);
      source.start();
    }

    startRecordedRain() {
      const context = this.context;
      const graph = this.createGraph();
      this.ambient = graph;
      graph.sound = "rain2";
      graph.volumeScale = 2;
      // 録音はストリーミングし、長い音源全体をAudioBufferへ展開しません。
      const media = new window.Audio("assets/audio/rain2.mp3");
      graph.media = media;
      media.loop = true;
      media.preload = "none";
      const source = context.createMediaElementSource(media);
      graph.nodes.push(source);
      const volume = context.createGain();
      graph.nodes.push(volume);
      const envelope = context.createGain();
      graph.nodes.push(envelope);
      graph.volume = volume;
      graph.envelope = envelope;
      graph.startedAt = context.currentTime;
      graph.fadeIn = AUDIO.fadeIn;
      volume.gain.value = settings.volume / 100 * AUDIO.ambientLevel * graph.volumeScale;
      envelope.gain.setValueAtTime(0, graph.startedAt);
      envelope.gain.linearRampToValueAtTime(1, graph.startedAt + graph.fadeIn);
      source.connect(volume).connect(envelope).connect(context.destination);
      graph.sources.push({ stop: (at = context.currentTime) => {
        if (graph.disposed) return;
        window.clearTimeout(graph.mediaStopTask);
        graph.mediaStopTask = window.setTimeout(() => this.disposeGraph(graph), Math.max(0, at - context.currentTime) * 1000);
      } });
      media.onerror = () => { if (this.ambient === graph && state === "running") this.fail(); };
      void media.play().then(() => {
        if (graph.disposed || this.ambient !== graph || state !== "running") {
          media.pause();
          this.disposeGraph(graph);
        }
      }).catch(() => { if (!graph.disposed && this.ambient === graph && state === "running") this.fail(); });
    }

    createGuideBuffer() {
      const sampleRate = this.context.sampleRate;
      const buffer = this.context.createBuffer(1, sampleRate * BREATH_CYCLE_MS / 1000, sampleRate);
      const samples = buffer.getChannelData(0);
      const exhaleAt = (BREATH.inhale + BREATH.hold) / 1000;
      // 音程をうねらせず、吸う・吐くの始まりだけを短い柔らかな音で知らせます。
      // なだらかな立ち上がりと余韻の後は無音。倍音は先に減衰させます。
      for (const [at, frequency] of [[0, GUIDE.inhaleFrequency], [exhaleAt, GUIDE.exhaleFrequency]]) {
        const start = Math.round(at * sampleRate);
        const length = Math.round(GUIDE.cueDuration * sampleRate);
        for (let i = 0; i < length; i++) {
          const elapsed = i / sampleRate;
          const attack = (1 - Math.cos(Math.PI * Math.min(1, elapsed / GUIDE.attack))) / 2;
          const release = (1 + Math.cos(Math.PI * elapsed / GUIDE.cueDuration)) / 2;
          const envelope = attack * release * Math.exp(-2.2 * elapsed);
          const phase = 2 * Math.PI * frequency * elapsed;
          const warmth = Math.sin(phase) + 0.12 * Math.exp(-4 * elapsed) * Math.sin(2 * phase);
          samples[start + i] = warmth * envelope * 0.85;
        }
      }
      return buffer;
    }

    syncGuide() {
      if (!settings.guide) { this.stopGuide(); return; }
      const cycle = BREATH_CYCLE_MS / 1000;
      const elapsed = (totalMs - getRemaining()) / 1000;
      if (this.guide) {
        const playingPhase = (this.context.currentTime - this.guide.startedAt + this.guide.offset) % cycle;
        const difference = Math.abs(playingPhase - elapsed % cycle);
        if (Math.min(difference, cycle - difference) <= AUDIO.guideTolerance) return;
        this.stopGuide();
      }
      if (!this.guideBuffer) this.guideBuffer = this.createGuideBuffer();
      const left = getRemaining();
      if (left === 0) { update(); return; }
      const context = this.context;
      const graph = this.createGraph();
      this.guide = graph;
      const addNode = (node) => { graph.nodes.push(node); return node; };
      const source = addNode(context.createBufferSource());
      graph.sources.push(source);
      source.buffer = this.guideBuffer;
      source.loop = true;
      const volume = addNode(context.createGain());
      graph.volume = volume;
      volume.gain.value = settings.volume / 100 * AUDIO.guideLevel;
      const envelope = addNode(context.createGain());
      graph.envelope = envelope;
      graph.startedAt = context.currentTime;
      graph.fadeIn = AUDIO.guideFadeIn;
      graph.offset = (totalMs - left) / 1000 % cycle;
      envelope.gain.setValueAtTime(0, graph.startedAt);
      envelope.gain.linearRampToValueAtTime(1, graph.startedAt + graph.fadeIn);
      source.connect(volume).connect(envelope).connect(context.destination);
      source.onended = () => this.disposeGraph(graph);
      source.start(graph.startedAt, graph.offset);
      // ページの更新処理が遅れても、音声時計で終了時刻に止めます。
      graph.stopAt = graph.startedAt + left / 1000;
      source.stop(graph.stopAt);
    }

    setVolume() {
      if (!this.context) return;
      const now = this.context.currentTime;
      if (this.ambient) this.ambient.volume.gain.setTargetAtTime(settings.volume / 100 * AUDIO.ambientLevel * (this.ambient.volumeScale ?? 1), now, 0.08);
      if (this.guide) this.guide.volume.gain.setTargetAtTime(settings.volume / 100 * AUDIO.guideLevel, now, 0.08);
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
      const graph = this.ambient;
      this.ambient = null;
      this.stopLoop(graph);
    }

    stopGuide() {
      const graph = this.guide;
      this.guide = null;
      this.stopLoop(graph);
    }

    stopLoop(graph) {
      if (!graph) return;
      if (this.context.state !== "running" || !graph.envelope) { this.disposeGraph(graph); return; }
      try {
        const now = this.context.currentTime;
        const gain = graph.envelope.gain;
        if (typeof gain.cancelAndHoldAtTime === "function") gain.cancelAndHoldAtTime(now);
        else {
          const heldValue = Math.min(1, Math.max(0, (now - graph.startedAt) / graph.fadeIn));
          gain.cancelScheduledValues(now);
          gain.setValueAtTime(heldValue, now);
        }
        gain.linearRampToValueAtTime(0, now + AUDIO.fadeOut);
        graph.sources.forEach((source) => source.stop(Math.min(graph.stopAt ?? Infinity, now + AUDIO.stopDelay)));
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
      this.stopGuide();
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
    const soundLabel = settings.guide ? (settings.sound === "silent" ? "呼吸ガイド" : `${SOUND_NAMES[settings.sound]}・ガイド`) : SOUND_NAMES[settings.sound];
    document.querySelectorAll(".sound-label").forEach((label) => { label.textContent = soundLabel; });
    byId("volume").value = settings.volume;
    byId("volume-value").value = `${settings.volume}%`;
    byId("volume").disabled = settings.sound === "silent" && !settings.guide && !settings.bell;
    byId("guide-enabled").checked = settings.guide;
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
  ["guide", "bell"].forEach((option) => byId(`${option}-enabled`).addEventListener("change", (event) => {
    settings[option] = event.target.checked;
    saveSettings();
    syncSettings();
    if (state === "running") void audio.play();
    else audio.stop();
  }));
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
