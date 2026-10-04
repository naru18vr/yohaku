"use strict";

(() => {
  const STORAGE_KEY = "yohaku-settings-v1";
  const MINUTE_MS = 60_000;
  const UPDATE_INTERVAL_MS = 200;
  const MAX_MINUTES = 360;
  const RECORDED_BLEND_SECONDS = 4;
  const AUDIO = { ambientLevel: 0.45, guideLevel: 0.08, bellLevel: 0.1, noiseDuration: 20, noiseBlend: 1, fadeIn: 1.5, guideFadeIn: 0.08, fadeOut: 0.45, stopDelay: 0.5, bellDuration: 3, bellGrace: 0.25, guideTolerance: 0.3 };
  const BREATH = { minScale: 0.82, maxScale: 1.08 };
  const BREATH_PATTERNS = {
    original: { inhale: 4000, hold: 2000, exhale: 6000, description: "4秒吸う → 2秒そのまま → 6秒吐く" },
    gentle: { inhale: 4000, hold: 0, exhale: 6000, description: "4秒吸う → 6秒吐く（息を止めない）" },
    equal: { inhale: 4000, hold: 0, exhale: 4000, description: "4秒吸う → 4秒吐く（息を止めない）" },
    slow: { inhale: 5000, hold: 0, exhale: 5000, description: "5秒吸う → 5秒吐く（息を止めない）" },
  };
  const breathPattern = () => BREATH_PATTERNS[settings.breathPattern];
  const breathCycleMs = () => { const pattern = breathPattern(); return pattern.inhale + pattern.hold + pattern.exhale; };
  const GUIDE = { inhaleFrequency: 523.25, exhaleFrequency: 392, cueDuration: 1.1, attack: 0.12 };
  const GUIDE_TONES = {
    soft: "やわらかな電子音。吸い始めに少し高く、吐き始めに少し低く鳴ります。",
    low: "温かな低めの音。吸い始めと吐き始めで高さを変えます。",
    bell: "鈴を模した澄んだ音。吸い始めと吐き始めで高さを変えます。",
    breath: "息を模した短いノイズ。吸う時は明るく、吐く時は柔らかく。声は含みません。",
  };
  const SOUND_NAMES = { silent: "無音", rain: "雨", rain2: "雨 fugisako ver", waves: "波", fire: "焚き火", white: "ホワイトノイズ", pink: "ピンクノイズ", tone40: "40Hz変調" };
  const SOUND_DESCRIPTIONS = {
    rain: "雨を模した合成音です。",
    rain2: "提供された雨音の録音です。",
    waves: "寄せて砕け、泡を残して引いていく波を模した合成音です。",
    fire: "焚き火を模した合成音です。",
    white: "周波数ごとの強さがほぼ均一なノイズです。",
    pink: "低い周波数ほど強くなるノイズです。",
    tone40: "聞こえる高さの音に、毎秒40回の強弱をつけた音です。純粋な40Hzの低音とは異なります。",
  };
  const defaults = { minutes: 3, sound: "silent", volume: 35, guide: false, guideTone: "soft", breathPattern: "original", bell: false, screenOn: false, theme: "auto" };
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
  let hiddenAt = null;
  let hiddenRemaining = 0;
  const clockNow = () => window.performance?.now() ?? Date.now();
  const PAGE_TITLE = "yohaku — 何もしないための3分間";

  function loadSettings() {
    try {
      const saved = JSON.parse(localStorage.getItem(STORAGE_KEY));
      if (!saved || typeof saved !== "object") return { ...defaults };
      return {
        minutes: Number.isInteger(saved.minutes) && saved.minutes >= 1 && saved.minutes <= MAX_MINUTES ? saved.minutes : defaults.minutes,
        sound: Object.hasOwn(SOUND_NAMES, saved.sound) ? saved.sound : defaults.sound,
        volume: Number.isFinite(saved.volume) ? Math.round(Math.min(100, Math.max(0, saved.volume))) : defaults.volume,
        guide: typeof saved.guide === "boolean" ? saved.guide : defaults.guide,
        guideTone: Object.hasOwn(GUIDE_TONES, saved.guideTone) ? saved.guideTone : defaults.guideTone,
        breathPattern: Object.hasOwn(BREATH_PATTERNS, saved.breathPattern) ? saved.breathPattern : defaults.breathPattern,
        bell: typeof saved.bell === "boolean" ? saved.bell : defaults.bell,
        screenOn: typeof saved.screenOn === "boolean" ? saved.screenOn : defaults.screenOn,
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
      this.extraBuffers = new Map();
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
          this.extraBuffers.clear();
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
        if (this.ambient?.crossfading) this.ambient.finishCrossfade();
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
      if (this.ambient) {
        this.scheduleAmbientEnd(this.ambient, remaining);
        this.resumeRecordedMedia(this.ambient);
      }
      if (settings.bell) this.scheduleBell(remaining);
      if (this.ambient?.mediaStarting) showAudioNotice("雨の音を読み込んでいます。", false);
      else clearAudioNotice();
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
        window.clearTimeout(graph.recordedBlendTask);
        for (const slot of graph.mediaSlots || [{ media: graph.media }]) {
          const media = slot.media;
          media.onended = media.onerror = media.ontimeupdate = media.onloadedmetadata = media.oncanplay = null;
          try { media.pause(); } catch { /* 他の再生元とノードも必ず解放します。 */ }
          try { media.removeAttribute("src"); } catch { /* 解放を続けます。 */ }
          try { media.load(); } catch { /* 解放を続けます。 */ }
        }
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

    createNoiseBuffer(kind = "pink") {
      const context = this.context;
      const duration = kind === "waves" ? 60 : AUDIO.noiseDuration;
      const length = Math.round(context.sampleRate * duration);
      const blendLength = Math.round(context.sampleRate * AUDIO.noiseBlend);
      const buffer = context.createBuffer(2, length, context.sampleRate);
      let waveSurge, waveFoam, waveFilter;
      if (kind === "waves") {
        waveSurge = new Float32Array(length + blendLength);
        waveFoam = new Float32Array(length + blendLength);
        waveFilter = new Float32Array(length + blendLength);
        const periods = [8.4, 10.8, 9.4, 11.2, 9.8, 10.4];
        let wave = 0, start = 0;
        for (let i = 0; i < waveSurge.length; i++) {
          const time = i / context.sampleRate;
          while (time >= start + periods[wave]) { start += periods[wave]; wave = (wave + 1) % periods.length; }
          const phase = time - start;
          const attack = 2.1 + wave % 3 * 0.25;
          const end = Math.min(1, (periods[wave] - phase) / 1.4) ** 2;
          waveSurge[i] = (phase < attack ? Math.sin(phase / attack * Math.PI / 2) ** 2 : Math.exp(-(phase - attack) / 2.5)) * end;
          const retreat = Math.max(0, phase - attack);
          waveFoam[i] = (1 - Math.exp(-retreat / 0.35)) * Math.exp(-retreat / 2.8) * end;
          waveFilter[i] = 1 - Math.exp(-2 * Math.PI * (900 + 4200 * waveSurge[i] + 1800 * waveFoam[i]) / context.sampleRate);
        }
      }
      for (let channel = 0; channel < buffer.numberOfChannels; channel++) {
        const samples = buffer.getChannelData(channel);
        const noise = new Float32Array(length + blendLength);
        let b0 = 0, b1 = 0, b2 = 0, b3 = 0, b4 = 0, b5 = 0, b6 = 0;
        let deep = 0, spray = 0;
        for (let i = -context.sampleRate; i < noise.length; i++) {
          const white = Math.random() * 2 - 1;
          b0 = 0.99886 * b0 + white * 0.0555179;
          b1 = 0.99332 * b1 + white * 0.0750759;
          b2 = 0.969 * b2 + white * 0.153852;
          b3 = 0.8665 * b3 + white * 0.3104856;
          b4 = 0.55 * b4 + white * 0.5329522;
          b5 = -0.7616 * b5 - white * 0.016898;
          const pink = (b0 + b1 + b2 + b3 + b4 + b5 + b6 + white * 0.5362) * 0.11;
          if (kind === "waves") {
            // 波頭では広い帯域の水しぶき、引き際には遅れて泡の音を残します。
            const at = Math.max(0, i);
            deep += 0.02 * (pink - deep);
            spray += waveFilter[at] * (white * 0.42 - spray);
            if (i >= 0) noise[i] = Math.max(-1, Math.min(1, deep * (0.24 + waveSurge[i] * 0.9) + spray * (0.05 + waveSurge[i] * 0.65 + waveFoam[i] * 0.4)));
          } else if (i >= 0) noise[i] = kind === "white" ? white * 0.24 : Math.max(-1, Math.min(1, pink));
          b6 = white * 0.115926;
        }
        if (kind === "fire") {
          let rumble = 0;
          for (let i = 0; i < noise.length; i++) {
            rumble = rumble * 0.985 + noise[i] * 0.015;
            noise[i] = rumble * 1.4 + noise[i] * 0.18;
          }
          // 不規則な短い破裂音を、低い燃焼音へ重ねます。
          for (let i = 0; i < noise.length; i++) {
            if (Math.random() >= 5 / context.sampleRate) continue;
            const duration = 0.008 + Math.random() * 0.045;
            const count = Math.round(duration * context.sampleRate);
            const strength = 0.15 + Math.random() * 0.45;
            const frequency = 300 + Math.random() * 1500;
            for (let j = 0; j < count && i + j < noise.length; j++) {
              const t = j / context.sampleRate;
              const envelope = Math.min(1, t / 0.001) * Math.exp(-6 * t / duration);
              noise[i + j] += strength * envelope * ((Math.random() * 2 - 1) * 0.75 + Math.sin(2 * Math.PI * frequency * t) * 0.25);
            }
          }
          for (let i = 0; i < noise.length; i++) noise[i] = Math.max(-1, Math.min(1, noise[i]));
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
      if (["fire", "white", "pink", "tone40"].includes(sound)) { this.startExtraAmbient(sound); return; }
      const context = this.context;
      if (sound === "rain" && !this.noiseBuffer) this.noiseBuffer = this.createNoiseBuffer();
      if (sound === "waves" && !this.extraBuffers.has(sound)) this.extraBuffers.set(sound, this.createNoiseBuffer(sound));
      const graph = this.createGraph();
      this.ambient = graph;
      graph.sound = sound;
      const addNode = (node) => { graph.nodes.push(node); return node; };
      const source = context.createBufferSource();
      addNode(source);
      graph.sources.push(source);
      source.buffer = sound === "waves" ? this.extraBuffers.get(sound) : this.noiseBuffer;
      source.loop = true;
      const lowpass = addNode(context.createBiquadFilter());
      lowpass.type = "lowpass";
      lowpass.frequency.value = sound === "rain" ? 3200 : 9000;
      lowpass.Q.value = 0.5;
      const highpass = addNode(context.createBiquadFilter());
      highpass.type = "highpass";
      highpass.frequency.value = sound === "rain" ? 180 : 60;
      highpass.Q.value = 0.5;
      const texture = addNode(context.createGain());
      texture.gain.value = sound === "rain" ? 1 : 0.9;
      const volume = addNode(context.createGain());
      graph.volume = volume;
      volume.gain.value = settings.volume / 100 * AUDIO.ambientLevel;
      const envelope = addNode(context.createGain());
      graph.envelope = envelope;
      graph.startedAt = context.currentTime;
      graph.fadeIn = AUDIO.fadeIn;
      envelope.gain.setValueAtTime(0, graph.startedAt);
      envelope.gain.linearRampToValueAtTime(1, graph.startedAt + AUDIO.fadeIn);
      source.connect(lowpass).connect(highpass).connect(texture).connect(volume).connect(envelope).connect(this.createEndGate(graph));
      if (sound === "waves") {
        const swell = addNode(context.createOscillator());
        graph.sources.push(swell);
        swell.frequency.value = 1 / 11;
        const depth = addNode(context.createGain());
        depth.gain.value = 0.05;
        swell.connect(depth).connect(texture.gain);
        swell.start();
      }
      source.onended = () => this.disposeGraph(graph);
      source.start();
    }

    createTone40Buffer() {
      const rate = this.context.sampleRate;
      const buffer = this.context.createBuffer(2, rate, rate);
      for (let channel = 0; channel < buffer.numberOfChannels; channel++) {
        const samples = buffer.getChannelData(channel);
        for (let i = 0; i < rate; i++) {
          const time = i / rate;
          // 240Hzの搬送音に40Hzの振幅変調。1秒に整数周期を収めて滑らかにループします。
          samples[i] = 0.7 * Math.sin(2 * Math.PI * 240 * time) * (0.55 + 0.45 * Math.cos(2 * Math.PI * 40 * time));
        }
      }
      return buffer;
    }

    startExtraAmbient(sound) {
      const context = this.context;
      const graph = this.createGraph();
      this.ambient = graph;
      graph.sound = sound;
      const addNode = (node) => { graph.nodes.push(node); return node; };
      const source = addNode(context.createBufferSource());
      graph.sources.push(source);
      if (!this.extraBuffers.has(sound)) this.extraBuffers.set(sound, sound === "tone40" ? this.createTone40Buffer() : this.createNoiseBuffer(sound));
      source.buffer = this.extraBuffers.get(sound);
      source.loop = true;
      const texture = addNode(context.createGain());
      texture.gain.value = sound === "fire" ? 0.7 : 1;
      const volume = addNode(context.createGain());
      graph.volume = volume;
      volume.gain.value = settings.volume / 100 * AUDIO.ambientLevel;
      const envelope = addNode(context.createGain());
      graph.envelope = envelope;
      graph.startedAt = context.currentTime;
      graph.fadeIn = AUDIO.fadeIn;
      envelope.gain.setValueAtTime(0, graph.startedAt);
      envelope.gain.linearRampToValueAtTime(1, graph.startedAt + graph.fadeIn);
      source.connect(texture).connect(volume).connect(envelope).connect(this.createEndGate(graph));
      source.onended = () => this.disposeGraph(graph);
      source.start();
    }

    startRecordedRain() {
      const context = this.context;
      const graph = this.createGraph();
      this.ambient = graph;
      graph.sound = "rain2";
      graph.volumeScale = 4;
      // 録音はストリーミングし、長い音源全体をAudioBufferへ展開しません。
      const media = new window.Audio("assets/audio/rain2.mp3");
      graph.media = media;
      const slot = { media };
      graph.mediaSlots = [slot];
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
      // 再生準備が済むまで無音にし、実際に鳴り始めてからフェードインします。
      const limiter = context.createDynamicsCompressor();
      graph.nodes.push(limiter);
      limiter.threshold.value = -6;
      limiter.knee.value = 6;
      limiter.ratio.value = 8;
      limiter.attack.value = 0.003;
      limiter.release.value = 0.2;
      volume.connect(limiter).connect(envelope).connect(this.createEndGate(graph));
      graph.activeSlot = slot;
      this.attachRecordedSlot(graph, slot, true);
      graph.sources.push({ stop: (at = context.currentTime) => {
        if (graph.disposed) return;
        window.clearTimeout(graph.mediaStopTask);
        graph.mediaStopTask = window.setTimeout(() => this.disposeGraph(graph), Math.max(0, at - context.currentTime) * 1000);
      } });
      this.resumeRecordedMedia(graph);
    }

    createEndGate(graph) {
      const gate = this.context.createGain();
      graph.nodes.push(gate);
      graph.endGate = gate;
      gate.gain.value = 1;
      gate.connect(this.context.destination);
      return gate;
    }

    scheduleAmbientEnd(graph, left) {
      const now = this.context.currentTime;
      const stopAt = now + left / 1000;
      if (graph.stopAt !== undefined && Math.abs(graph.stopAt - stopAt) < 0.05) return;
      graph.stopAt = stopAt;
      const gain = graph.endGate.gain;
      gain.cancelScheduledValues(now);
      gain.setValueAtTime(1, now);
      gain.setValueAtTime(1, Math.max(now, stopAt - AUDIO.fadeOut));
      gain.linearRampToValueAtTime(0, stopAt);
      graph.sources.forEach(source => source.stop(stopAt));
    }

    resumeRecordedMedia(graph) {
      if (!graph.media || graph.mediaStarting || !graph.media.paused) return;
      graph.mediaStarting = true;
      const media = graph.media;
      void media.play().then(() => {
        graph.mediaStarting = false;
        if (graph.disposed || this.ambient !== graph || state !== "running") {
          try { media.pause(); } catch { /* 終了後に音を残しません。 */ }
          this.disposeGraph(graph); return;
        }
        if (this.context.state !== "running") {
          try { media.pause(); } catch { /* 復帰時に再開します。 */ }
          return;
        }
        const now = this.context.currentTime;
        graph.startedAt = now;
        graph.envelope.gain.cancelScheduledValues(now);
        graph.envelope.gain.setValueAtTime(0, now);
        graph.envelope.gain.linearRampToValueAtTime(1, now + graph.fadeIn);
        clearAudioNotice();
      }).catch(() => {
        graph.mediaStarting = false;
        if (!graph.disposed && this.ambient === graph && state === "running") this.fail();
      });
    }

    attachRecordedSlot(graph, slot, active = false) {
      const media = slot.media;
      media.loop = true; // 次の音の準備が遅れた場合も現在の録音は止めません。
      media.preload = active ? "none" : "auto";
      const source = this.context.createMediaElementSource(media);
      graph.nodes.push(source);
      const gain = this.context.createGain();
      graph.nodes.push(gain);
      slot.gain = gain;
      gain.gain.value = active ? 1 : 0;
      source.connect(gain).connect(graph.volume);
      media.ontimeupdate = media.onloadedmetadata = media.oncanplay = () => {
        try { this.syncRecordedLoop(graph); } catch { if (!graph.disposed && this.ambient === graph) this.fail(); }
      };
      media.onerror = () => {
        if (graph.disposed || this.ambient !== graph || state !== "running") return;
        if (slot === graph.activeSlot) this.fail();
        else slot.failed = true;
      };
      if (!active) media.load();
    }

    syncRecordedLoop(graph) {
      if (graph.disposed || this.ambient !== graph || state !== "running" || this.context.state !== "running") return;
      if (graph.crossfading && this.context.currentTime >= graph.crossfadeEnd) graph.finishCrossfade();
      const current = graph.activeSlot;
      const media = current.media;
      if (!Number.isFinite(media.duration) || media.duration < RECORDED_BLEND_SECONDS * 3) return;
      const left = media.duration - media.currentTime;
      if (left > 30) return;
      if (graph.mediaSlots.length < 2) {
        const next = { media: new window.Audio("assets/audio/rain2.mp3") };
        graph.mediaSlots.push(next);
        this.attachRecordedSlot(graph, next);
      }
      const next = graph.mediaSlots.find(slot => slot !== current);
      if (left > RECORDED_BLEND_SECONDS || graph.crossfading || graph.pendingCrossfade || next.failed || next.media.readyState < 2) return;
      graph.pendingCrossfade = true;
      next.media.currentTime = 0;
      void next.media.play().then(() => {
        graph.pendingCrossfade = false;
        if (graph.disposed || this.ambient !== graph || graph.activeSlot !== current || state !== "running" || this.context.state !== "running") {
          next.media.pause(); return;
        }
        try {
          const now = this.context.currentTime;
          const seconds = Math.min(RECORDED_BLEND_SECONDS, Math.max(0.25, media.duration - media.currentTime));
          const incoming = new Float32Array(65), outgoing = new Float32Array(65);
          for (let i = 0; i < incoming.length; i++) {
            const angle = i / (incoming.length - 1) * Math.PI / 2;
            incoming[i] = Math.sin(angle); outgoing[i] = Math.cos(angle);
          }
          current.gain.gain.cancelScheduledValues(now);
          next.gain.gain.cancelScheduledValues(now);
          current.gain.gain.setValueCurveAtTime(outgoing, now, seconds);
          next.gain.gain.setValueCurveAtTime(incoming, now, seconds);
          graph.activeSlot = next;
          graph.media = next.media;
          graph.crossfading = true;
          graph.crossfadeEnd = now + seconds;
          graph.finishCrossfade = () => {
            window.clearTimeout(graph.recordedBlendTask);
            for (const slot of graph.mediaSlots) {
              slot.gain.gain.cancelScheduledValues(this.context.currentTime);
              slot.gain.gain.setValueAtTime(slot === graph.activeSlot ? 1 : 0, this.context.currentTime);
            }
            media.pause();
            try { media.currentTime = 0; } catch { /* 再準備できなくても現在の録音を続けます。 */ }
            graph.crossfading = false;
          };
          graph.recordedBlendTask = window.setTimeout(() => {
            if (!graph.disposed && this.context.state === "running" && this.context.currentTime >= graph.crossfadeEnd - 0.02) graph.finishCrossfade();
          }, seconds * 1000);
        } catch { if (!graph.disposed && this.ambient === graph) this.fail(); }
      }).catch(() => { graph.pendingCrossfade = false; next.failed = true; });
    }

    createGuideBuffer() {
      const sampleRate = this.context.sampleRate;
      const pattern = breathPattern();
      const buffer = this.context.createBuffer(1, sampleRate * breathCycleMs() / 1000, sampleRate);
      const samples = buffer.getChannelData(0);
      const exhaleAt = (pattern.inhale + pattern.hold) / 1000;
      // 音程をうねらせず、吸う・吐くの始まりだけを短い柔らかな音で知らせます。
      // なだらかな立ち上がりと余韻の後は無音。倍音は先に減衰させます。
      for (const [at, frequency, inhaling] of [[0, GUIDE.inhaleFrequency, true], [exhaleAt, GUIDE.exhaleFrequency, false]]) {
        const start = Math.round(at * sampleRate);
        const length = Math.round(GUIDE.cueDuration * sampleRate);
        let filtered = 0, low = 0;
        const noiseAlpha = 1 - Math.exp(-2 * Math.PI * (inhaling ? 1600 : 550) / sampleRate);
        const lowAlpha = 1 - Math.exp(-2 * Math.PI * 120 / sampleRate);
        for (let i = 0; i < length; i++) {
          const elapsed = i / sampleRate;
          const attack = (1 - Math.cos(Math.PI * Math.min(1, elapsed / GUIDE.attack))) / 2;
          const release = (1 + Math.cos(Math.PI * elapsed / GUIDE.cueDuration)) / 2;
          const envelope = attack * release * Math.exp(-2.2 * elapsed);
          const phase = 2 * Math.PI * frequency * (settings.guideTone === "low" ? 0.5 : 1) * elapsed;
          let warmth = Math.sin(phase) + 0.12 * Math.exp(-4 * elapsed) * Math.sin(2 * phase);
          if (settings.guideTone === "bell") {
            warmth = 0.7 * Math.sin(phase) + 0.2 * Math.exp(-4 * elapsed) * Math.sin(2.76 * phase) + 0.1 * Math.exp(-6 * elapsed) * Math.sin(4.07 * phase);
          } else if (settings.guideTone === "breath") {
            const noise = Math.random() * 2 - 1;
            filtered += noiseAlpha * (noise - filtered);
            low += lowAlpha * (noise - low);
            warmth = inhaling ? (filtered - low) * 0.8 : filtered;
          }
          samples[start + i] = warmth * envelope * 0.85;
        }
        if (settings.guideTone === "breath") {
          // フィルターで小さくなるノイズを補正し、低い吐く音も聞き取りやすくします。
          let sum = 0;
          for (let i = 0; i < length; i++) {
            const value = samples[start + i]; sum += value * value;
          }
          if (sum > 0) {
            const scale = 0.2 / Math.sqrt(sum / length);
            // 単一の大きな瞬間値で全体を小さくせず、滑らかにピークを抑えます。
            for (let i = 0; i < length; i++) samples[start + i] = 0.8 * Math.tanh(samples[start + i] * scale / 0.8);
          }
        }
      }
      return buffer;
    }

    syncGuide() {
      if (!settings.guide) { this.stopGuide(); return; }
      const cycle = breathCycleMs() / 1000;
      const elapsed = (totalMs - getRemaining()) / 1000;
      if (this.guide) {
        const playingPhase = (this.context.currentTime - this.guide.startedAt + this.guide.offset) % cycle;
        const difference = Math.abs(playingPhase - elapsed % cycle);
        if (this.guide.pattern === settings.breathPattern && this.guide.tone === settings.guideTone && Math.min(difference, cycle - difference) <= AUDIO.guideTolerance) return;
        this.stopGuide();
      }
      const bufferKey = `${settings.breathPattern}:${settings.guideTone}`;
      if (!this.guideBuffer || this.guideBufferKey !== bufferKey) {
        this.guideBuffer = this.createGuideBuffer();
        this.guideBufferKey = bufferKey;
      }
      const left = getRemaining();
      if (left === 0) { update(); return; }
      const context = this.context;
      const graph = this.createGraph();
      this.guide = graph;
      graph.pattern = settings.breathPattern;
      graph.tone = settings.guideTone;
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
    byId("custom-duration").value = settings.minutes;
    byId("duration-range").value = settings.minutes;
    byId("duration-range").setAttribute("aria-valuetext", `${settings.minutes}分`);
    document.querySelectorAll('input[name="sound"]').forEach((input) => { input.checked = input.value === settings.sound; });
    document.querySelectorAll('input[name="theme"]').forEach((input) => { input.checked = input.value === settings.theme; });
    byId("start-label").textContent = `${settings.minutes}分休む`;
    byId("restart-button").textContent = `もう${settings.minutes}分休む`;
    const soundLabel = settings.guide ? (settings.sound === "silent" ? "呼吸ガイド" : `${SOUND_NAMES[settings.sound]}・ガイド`) : SOUND_NAMES[settings.sound];
    document.querySelectorAll(".sound-label").forEach((label) => { label.textContent = soundLabel; });
    byId("sound-description").textContent = SOUND_DESCRIPTIONS[settings.sound] || "";
    byId("sound-description").hidden = !SOUND_DESCRIPTIONS[settings.sound];
    byId("volume").value = settings.volume;
    byId("volume-value").value = `${settings.volume}%`;
    byId("volume").setAttribute("aria-valuetext", `${settings.volume}%`);
    byId("volume").disabled = settings.sound === "silent" && !settings.guide && !settings.bell;
    byId("guide-enabled").checked = settings.guide;
    document.querySelectorAll('input[name="guide-tone"]').forEach(input => { input.checked = input.value === settings.guideTone; });
    byId("guide-tone-note").textContent = GUIDE_TONES[settings.guideTone];
    byId("guide-note").textContent = `${GUIDE_TONES[settings.guideTone]} 間は静かに。あなたのペースで。`;
    document.querySelectorAll('input[name="breath-pattern"]').forEach(input => { input.checked = input.value === settings.breathPattern; });
    byId("breath-pattern-note").textContent = breathPattern().description;
    byId("breath-description").textContent = `円は${breathPattern().description}の目安を示します。合わせずに、自然な呼吸で休んでも大丈夫です。`;
    byId("bell-enabled").checked = settings.bell;
    byId("screen-on").checked = settings.screenOn;
    byId("screen-on").disabled = !window.navigator?.wakeLock;
    if (!window.navigator?.wakeLock) byId("screen-note").textContent = "このブラウザでは利用できません。";
    applyTheme();
  }

  const screenLock = { sentinel: null, pending: false, version: 0 };
  async function syncScreenLock() {
    const wanted = settings.screenOn && state === "running" && !document.hidden;
    if (!wanted) {
      screenLock.version++;
      const held = screenLock.sentinel;
      screenLock.sentinel = null;
      if (window.navigator?.wakeLock) byId("screen-note").textContent = "画面ロックによる音の中断を減らします。";
      if (held) { try { await held.release(); } catch { /* タイマーは継続します。 */ } }
      return;
    }
    if (!window.navigator?.wakeLock || screenLock.sentinel || screenLock.pending) return;
    const version = screenLock.version;
    screenLock.pending = true;
    try {
      const held = await window.navigator.wakeLock.request("screen");
      if (version !== screenLock.version || !settings.screenOn || state !== "running" || document.hidden) {
        await held.release(); return;
      }
      screenLock.sentinel = held;
      byId("screen-note").textContent = "休息中は画面をつけたままにします。";
      held.addEventListener("release", () => {
        if (screenLock.sentinel === held) {
          screenLock.sentinel = null;
          byId("screen-note").textContent = "画面の点灯が解除されました。端末の設定をご確認ください。";
        }
      });
    } catch {
      if (version === screenLock.version) byId("screen-note").textContent = "画面を保持できませんでした。端末の設定をご確認ください。";
    } finally {
      screenLock.pending = false;
      if (version !== screenLock.version && settings.screenOn && state === "running" && !document.hidden) void syncScreenLock();
    }
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

  function setRunningDeadline() {
    endTime = clockNow() + remainingMs;
    hiddenAt = document.hidden ? Date.now() : null;
    hiddenRemaining = remainingMs;
  }

  function getRemaining() {
    if (state !== "running") return remainingMs;
    const activeClock = endTime - clockNow();
    // 一部のOSで単調時計がスリープ中に進まない場合を、非表示中の実時刻で補います。
    const hiddenClock = hiddenAt === null ? Infinity : hiddenRemaining - Math.max(0, Date.now() - hiddenAt);
    return Math.max(0, Math.min(remainingMs, activeClock, hiddenClock));
  }

  function renderTitle() {
    const status = state === "paused" ? "一時停止中" : state === "complete" ? "おつかれさま。" : state === "running" ? (timeHidden ? "休息中" : byId("timer").textContent) : "";
    document.title = status ? `${status} — yohaku` : PAGE_TITLE;
  }

  function renderTime() {
    const seconds = Math.ceil(getRemaining() / 1000);
    if (seconds === lastSecond) return;
    lastSecond = seconds;
    const minutes = Math.floor(seconds / 60).toString().padStart(2, "0");
    const remainder = (seconds % 60).toString().padStart(2, "0");
    byId("timer").textContent = `${minutes}:${remainder}`;
    byId("timer").setAttribute("aria-label", `残り${Math.floor(seconds / 60)}分${seconds % 60}秒`);
    renderTitle();
  }

  function renderBreath() {
    if (motionPreference.matches) { circle.style.transform = "scale(1)"; circle.style.opacity = "0.85"; }
    if (state === "paused") { byId("breath-label").textContent = "ひと休み中"; return; }
    const pattern = breathPattern();
    const cycleTime = (totalMs - getRemaining()) % breathCycleMs();
    let scale = BREATH.maxScale;
    let label = "そのまま";
    const ease = (progress) => (1 - Math.cos(Math.PI * progress)) / 2;
    if (cycleTime < pattern.inhale) {
      label = "吸う";
      scale = BREATH.minScale + (BREATH.maxScale - BREATH.minScale) * ease(cycleTime / pattern.inhale);
    } else if (cycleTime >= pattern.inhale + pattern.hold) {
      label = "吐く";
      const progress = (cycleTime - pattern.inhale - pattern.hold) / pattern.exhale;
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
    setRunningDeadline();
    lastSecond = -1;
    byId("pause-button").textContent = "一時停止";
    byId("session-title").textContent = "いまは、ただ休む。";
    showView("session", "session-title");
    byId("announcer").textContent = `${settings.minutes}分、休みます。呼吸は、あなたのペースで。`;
    void audio.play();
    void syncScreenLock();
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
      void syncScreenLock();
      clearAudioNotice();
      byId("pause-button").textContent = "再開する";
      byId("session-title").textContent = "このまま、ひと息。";
      renderTime();
      renderBreath();
      renderTitle();
      byId("announcer").textContent = "一時停止しました。再開せずに終わっても大丈夫です。";
    } else if (state === "paused") {
      state = "running";
      setRunningDeadline();
      byId("pause-button").textContent = "一時停止";
      byId("session-title").textContent = "いまは、ただ休む。";
      byId("announcer").textContent = "休む時間を再開しました。";
      void audio.play();
      void syncScreenLock();
      renderTitle();
      update();
      beginAnimation();
    }
  }

  function complete() {
    if (state !== "running") return;
    state = "complete";
    void syncScreenLock();
    renderTitle();
    remainingMs = 0;
    cancelUpdates();
    audio.stop(true);
    clearAudioNotice();
    showView("complete", "complete-title");
    byId("announcer").textContent = "休む時間が終わりました。おつかれさま。";
  }

  function goHome() {
    state = "home";
    void syncScreenLock();
    renderTitle();
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
    renderTitle();
  });
  function setMinutes(minutes) {
    if (!Number.isInteger(minutes) || minutes < 1 || minutes > MAX_MINUTES) return;
    settings.minutes = minutes;
    saveSettings();
    syncSettings();
  }
  document.querySelectorAll('input[name="duration"]').forEach((input) => input.addEventListener("change", () => setMinutes(Number(input.value))));
  byId("duration-range").addEventListener("input", (event) => setMinutes(Number(event.target.value)));
  byId("custom-duration").addEventListener("input", (event) => {
    if (String(event.target.value).trim()) setMinutes(Number(event.target.value));
  });
  byId("custom-duration").addEventListener("change", (event) => {
    const value = String(event.target.value).trim();
    const minutes = Number(value);
    if (value && Number.isFinite(minutes)) setMinutes(Math.min(MAX_MINUTES, Math.max(1, Math.round(minutes))));
    else syncSettings();
  });
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
    byId("volume").setAttribute("aria-valuetext", `${settings.volume}%`);
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
  document.querySelectorAll('input[name="breath-pattern"]').forEach(input => input.addEventListener("change", () => {
    if (!Object.hasOwn(BREATH_PATTERNS, input.value)) return;
    settings.breathPattern = input.value;
    saveSettings();
    syncSettings();
    if (state === "running") { beginAnimation(); void audio.play(); }
    else if (state === "paused") renderBreath();
  }));
  document.querySelectorAll('input[name="guide-tone"]').forEach(input => input.addEventListener("change", () => {
    if (!Object.hasOwn(GUIDE_TONES, input.value)) return;
    settings.guideTone = input.value;
    saveSettings();
    syncSettings();
    if (state === "running" && settings.guide) void audio.play();
  }));
  document.querySelectorAll('input[name="theme"]').forEach((input) => input.addEventListener("change", () => {
    settings.theme = input.value;
    saveSettings();
    applyTheme();
  }));
  byId("screen-on").addEventListener("change", (event) => {
    settings.screenOn = event.target.checked;
    saveSettings();
    void syncScreenLock();
  });
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
    if (document.hidden) {
      hiddenRemaining = getRemaining();
      hiddenAt = Date.now();
      window.cancelAnimationFrame(animationFrame); animationFrame = 0;
      void syncScreenLock();
    }
    else {
      remainingMs = getRemaining();
      setRunningDeadline();
      update();
      if (state === "running") { beginAnimation(); audio.onStateChange(audio.context); void syncScreenLock(); }
    }
  });
  window.addEventListener("pagehide", () => { if (state === "running") pauseOrResume(); audio.stop(); audio.disposeAll(); });
  motionPreference.addEventListener("change", () => { if (state === "running" || state === "paused") beginAnimation(); });
  colorPreference.addEventListener("change", applyTheme);
  syncSettings();
})();
