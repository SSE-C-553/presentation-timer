import { useCallback, useEffect, useRef, useState } from "react";
import { Bell, Maximize2, Pause, Play, Plus, RotateCcw, Share2, Trash2, Volume2, VolumeX } from "lucide-react";

type Status = "idle" | "running" | "paused" | "finished";
type AspectRatio = "4:3" | "16:9";
type BellEvent = { id: string; triggerRemainingSeconds: number; strikeCount: number; enabled: boolean };
type Settings = { durationSeconds: number; aspectRatio: AspectRatio; bells: BellEvent[]; volume: number; muted: boolean };
type Runtime = { status: Status; startedAt: number | null; elapsedBeforeStartMs: number; activeDurationSeconds: number; activeBells: BellEvent[]; firedBellIds: string[] };
type TimerState = { settings: Settings; runtime: Runtime; revision: number; updatedAt: number };

const STORAGE_KEY = "presentation-timer-state-v1";
const CHANNEL_NAME = "lt-timer-sync";
const BELL_AUDIO_SRC = "./audio/otologic-onoma-ding04-short.mp3";
const PUBLIC_APP_URL = "https://sse-c-553.github.io/presentation-timer/";
const X_SHARE_TEXT = "Presentation Timer - Discord配信向けの発表タイマー";

const defaultBells = (): BellEvent[] => [
  { id: crypto.randomUUID(), triggerRemainingSeconds: 300, strikeCount: 1, enabled: true },
  { id: crypto.randomUUID(), triggerRemainingSeconds: 180, strikeCount: 2, enabled: true },
  { id: crypto.randomUUID(), triggerRemainingSeconds: 0, strikeCount: 3, enabled: true },
];

const initialState = (): TimerState => ({
  settings: { durationSeconds: 600, aspectRatio: "16:9", bells: defaultBells(), volume: 0.8, muted: false },
  runtime: { status: "idle", startedAt: null, elapsedBeforeStartMs: 0, activeDurationSeconds: 600, activeBells: [], firedBellIds: [] },
  revision: 0,
  updatedAt: Date.now(),
});

function loadState(): TimerState {
  const fallback = initialState();
  try {
    const saved = localStorage.getItem(STORAGE_KEY);
    if (saved) return { ...fallback, ...JSON.parse(saved) };
    return fallback;
  } catch { return fallback; }
}

function formatTime(totalSeconds: number) {
  const value = Math.max(0, Math.floor(totalSeconds));
  const hours = Math.floor(value / 3600);
  const minutes = Math.floor((value % 3600) / 60);
  const seconds = value % 60;
  return hours ? `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}` : `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
}

function splitTime(seconds: number) { return { minutes: Math.floor(seconds / 60), seconds: seconds % 60 }; }
function elapsedMs(runtime: Runtime, now: number) {
  const runningDelta = runtime.status === "running" && runtime.startedAt
    ? Math.max(0, now - runtime.startedAt)
    : 0;
  return runtime.elapsedBeforeStartMs + runningDelta;
}

let audioContext: AudioContext | null = null;
const audioCache = new Map<string, AudioBuffer>();

async function getAudioContext() {
  const AudioContextClass = window.AudioContext || window.webkitAudioContext;
  audioContext ??= new AudioContextClass();
  await audioContext.resume();
  return audioContext;
}

async function loadAudio() {
  if (audioCache.has(BELL_AUDIO_SRC)) return audioCache.get(BELL_AUDIO_SRC)!;
  const context = await getAudioContext();
  const response = await fetch(BELL_AUDIO_SRC);
  const buffer = await context.decodeAudioData(await response.arrayBuffer());
  audioCache.set(BELL_AUDIO_SRC, buffer);
  return buffer;
}

async function strikeBell(volume: number) {
  const context = await getAudioContext();
  const buffer = await loadAudio();
  const output = context.createGain();
  output.gain.value = volume;
  output.connect(context.destination);
  const source = context.createBufferSource();
  source.buffer = buffer;
  source.connect(output);
  source.start();
}

function playBell(volume: number, count: number) {
  for (let index = 0; index < count; index += 1) window.setTimeout(() => void strikeBell(volume), index * 240);
}

declare global { interface Window { webkitAudioContext?: typeof AudioContext } }

export function App() {
  const isBroadcast = window.location.hash === "#broadcast";
  const [state, setState] = useState<TimerState>(loadState);
  const [now, setNow] = useState(Date.now());
  const [bellNotice, setBellNotice] = useState<string | null>(null);
  const [broadcastConnected, setBroadcastConnected] = useState(false);
  const [broadcastAudioReady, setBroadcastAudioReady] = useState(false);
  const channelRef = useRef<BroadcastChannel | null>(null);
  const broadcastWindowRef = useRef<Window | null>(null);
  const stateRef = useRef(state);
  stateRef.current = state;

  const commit = useCallback((updater: (previous: TimerState) => TimerState) => {
    setState((previous) => {
      const next = { ...updater(previous), revision: previous.revision + 1, updatedAt: Date.now() };
      localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
      channelRef.current?.postMessage({ type: "state", state: next });
      return next;
    });
  }, []);

  useEffect(() => {
    const channel = new BroadcastChannel(CHANNEL_NAME);
    channelRef.current = channel;
    channel.onmessage = (event) => {
      if (event.data?.type === "request" && !isBroadcast) channel.postMessage({ type: "state", state: stateRef.current });
      if (event.data?.type === "broadcast-ready" && !isBroadcast) setBroadcastConnected(true);
      if (event.data?.type === "broadcast-closed" && !isBroadcast) setBroadcastConnected(false);
      if (event.data?.type === "bell") {
        setBellNotice(event.data.label);
        if (isBroadcast) {
          const currentSettings = stateRef.current.settings;
          if (!currentSettings.muted) playBell(currentSettings.volume, Number(event.data.strikeCount) || 1);
        }
        window.setTimeout(() => setBellNotice(null), 1600);
      }
      if (event.data?.type === "state") setState((current) => event.data.state.updatedAt >= current.updatedAt ? event.data.state : current);
    };
    if (isBroadcast) {
      channel.postMessage({ type: "request" });
      channel.postMessage({ type: "broadcast-ready" });
      void getAudioContext()
        .then((context) => {
          setBroadcastAudioReady(context.state === "running");
          return loadAudio();
        })
        .catch(() => setBroadcastAudioReady(false));
    }
    const onStorage = (event: StorageEvent) => { if (event.key === STORAGE_KEY && event.newValue) setState(JSON.parse(event.newValue)); };
    window.addEventListener("storage", onStorage);
    return () => {
      if (isBroadcast) channel.postMessage({ type: "broadcast-closed" });
      channel.close();
      window.removeEventListener("storage", onStorage);
    };
  }, [isBroadcast]);

  useEffect(() => { const id = window.setInterval(() => setNow(Date.now()), 100); return () => window.clearInterval(id); }, []);

  const { settings, runtime } = state;
  const isActive = runtime.status === "running" || runtime.status === "paused";
  const displayDuration = isActive || runtime.status === "finished" ? runtime.activeDurationSeconds : settings.durationSeconds;
  const elapsedMilliseconds = elapsedMs(runtime, now);
  const remainingMilliseconds = displayDuration * 1000 - elapsedMilliseconds;
  const remainingSeconds = Math.max(0, Math.ceil(remainingMilliseconds / 1000));
  const overtimeSeconds = Math.max(0, Math.floor(-remainingMilliseconds / 1000));
  const formattedRemaining = remainingMilliseconds < 0 ? `+${formatTime(overtimeSeconds)}` : formatTime(remainingSeconds);
  const elapsedSeconds = Math.floor(elapsedMilliseconds / 1000);
  const progress = displayDuration ? Math.min(1, elapsedMilliseconds / (displayDuration * 1000)) : 0;
  const tone = remainingMilliseconds <= 0 ? "overtime" : remainingSeconds <= 60 ? "warning" : remainingSeconds <= 120 ? "caution" : "normal";
  const hasInvalidBell = settings.bells.some((bell) => bell.enabled && bell.triggerRemainingSeconds > settings.durationSeconds);
  const displayBells = isActive || runtime.status === "finished" ? runtime.activeBells : settings.bells;
  const bellMarkers = displayBells
    .filter((bell) => bell.enabled && bell.triggerRemainingSeconds <= displayDuration)
    .map((bell, index) => ({
      id: bell.id,
      label: `${displayBells.findIndex((item) => item.id === bell.id) + 1}鈴`,
      position: ((displayDuration - bell.triggerRemainingSeconds) / displayDuration) * 100,
      order: index,
    }));

  const ProgressBar = () => <div className="progress" aria-label="進行状況">
    <div className="progressFill" style={{ width: `${progress * 100}%` }} />
    {bellMarkers.map((marker) => <span
      className="bellMarker"
      key={marker.id}
      style={{ left: `${marker.position}%` }}
      title={marker.label}
      aria-label={marker.label}
    />)}
  </div>;

  useEffect(() => {
    if (isBroadcast || runtime.status !== "running") return;
    const due = runtime.activeBells.filter((bell) => bell.enabled && !runtime.firedBellIds.includes(bell.id) && remainingMilliseconds <= bell.triggerRemainingSeconds * 1000);
    if (!due.length) return;
    if (!broadcastConnected && !settings.muted) due.forEach((bell, index) => window.setTimeout(() => playBell(settings.volume, bell.strikeCount), index * 400));
    const label = `${runtime.activeBells.findIndex((bell) => bell.id === due[0].id) + 1}鈴`;
    setBellNotice(label);
    due.forEach((bell, index) => window.setTimeout(() => channelRef.current?.postMessage({ type: "bell", label: `${runtime.activeBells.findIndex((item) => item.id === bell.id) + 1}鈴`, strikeCount: bell.strikeCount }), index * 400));
    window.setTimeout(() => setBellNotice(null), 1600);
    commit((previous) => ({ ...previous, runtime: { ...previous.runtime, firedBellIds: [...previous.runtime.firedBellIds, ...due.map((bell) => bell.id)] } }));
  }, [broadcastConnected, commit, isBroadcast, remainingMilliseconds, runtime.activeBells, runtime.firedBellIds, runtime.status, settings.muted, settings.volume]);

  const updateSettings = (patch: Partial<Settings>) => commit((previous) => ({ ...previous, settings: { ...previous.settings, ...patch } }));
  const updateDuration = (minutes: number, seconds: number) => updateSettings({ durationSeconds: Math.max(1, minutes * 60 + seconds) });
  const updateBell = (id: string, patch: Partial<BellEvent>) => updateSettings({ bells: settings.bells.map((bell) => bell.id === id ? { ...bell, ...patch } : bell) });
  const durationParts = splitTime(settings.durationSeconds);
  const statusLabel = runtime.status === "running" ? "進行中" : runtime.status === "paused" ? "一時停止" : runtime.status === "finished" ? "終了" : "待機中";
  const xShareUrl = `https://x.com/intent/tweet?text=${encodeURIComponent(X_SHARE_TEXT)}&url=${encodeURIComponent(PUBLIC_APP_URL)}`;

  const resizeBroadcastWindow = useCallback((target: Window, ratio: AspectRatio) => {
    const ratioValue = ratio === "16:9" ? 16 / 9 : 4 / 3;
    const frameWidth = Math.max(0, target.outerWidth - target.innerWidth);
    const frameHeight = Math.max(0, target.outerHeight - target.innerHeight);
    let contentWidth = target.innerWidth || (ratio === "16:9" ? 1280 : 1024);
    let contentHeight = contentWidth / ratioValue;
    const maxHeight = Math.max(320, target.screen.availHeight - frameHeight);
    if (contentHeight > maxHeight) {
      contentHeight = maxHeight;
      contentWidth = contentHeight * ratioValue;
    }
    target.resizeTo(Math.round(contentWidth + frameWidth), Math.round(contentHeight + frameHeight));
  }, []);

  const openBroadcastWindow = () => {
    const size = settings.aspectRatio === "16:9" ? { width: 1280, height: 720 } : { width: 1024, height: 768 };
    const target = window.open(
      `${window.location.pathname}#broadcast`,
      "lt-timer-broadcast",
      `popup=yes,width=${size.width},height=${size.height},resizable=yes`,
    );
    if (!target) return;
    broadcastWindowRef.current = target;
    window.setTimeout(() => {
      if (!target.closed) resizeBroadcastWindow(target, settings.aspectRatio);
    }, 250);
  };

  useEffect(() => {
    const target = broadcastWindowRef.current;
    if (target && !target.closed) resizeBroadcastWindow(target, settings.aspectRatio);
  }, [resizeBroadcastWindow, settings.aspectRatio]);

  useEffect(() => {
    if (!isBroadcast) return;
    let resizeTimer: number | null = null;
    let correcting = false;
    let previousWidth = window.innerWidth;
    let previousHeight = window.innerHeight;

    const enforceBroadcastSize = () => {
      if (correcting) return;
      if (resizeTimer !== null) window.clearTimeout(resizeTimer);
      resizeTimer = window.setTimeout(() => {
        const ratioValue = settings.aspectRatio === "16:9" ? 16 / 9 : 4 / 3;
        const frameWidth = Math.max(0, window.outerWidth - window.innerWidth);
        const frameHeight = Math.max(0, window.outerHeight - window.innerHeight);
        const widthDelta = Math.abs(window.innerWidth - previousWidth);
        const heightDelta = Math.abs(window.innerHeight - previousHeight);
        let contentWidth = window.innerWidth;
        let contentHeight = window.innerHeight;
        if (widthDelta >= heightDelta) contentHeight = contentWidth / ratioValue;
        else contentWidth = contentHeight * ratioValue;
        const targetWidth = Math.round(contentWidth + frameWidth);
        const targetHeight = Math.round(contentHeight + frameHeight);
        if (Math.abs(window.outerWidth - targetWidth) <= 2 && Math.abs(window.outerHeight - targetHeight) <= 2) return;
        correcting = true;
        window.resizeTo(targetWidth, targetHeight);
        window.setTimeout(() => {
          previousWidth = window.innerWidth;
          previousHeight = window.innerHeight;
          correcting = false;
        }, 100);
      }, 120);
    };

    enforceBroadcastSize();
    window.addEventListener("resize", enforceBroadcastSize);
    return () => {
      window.removeEventListener("resize", enforceBroadcastSize);
      if (resizeTimer !== null) window.clearTimeout(resizeTimer);
    };
  }, [isBroadcast, settings.aspectRatio]);

  const enableBroadcastAudio = async () => {
    const context = await getAudioContext();
    await loadAudio();
    setBroadcastAudioReady(context.state === "running");
  };

  if (isBroadcast) return <main className="broadcastShell"><section className={`broadcastCanvas ratio-${settings.aspectRatio.replace(":", "-")} ${tone}`}>
    <div className="broadcastCenter">
      <span className="broadcastStatus">{statusLabel}</span>
      <div className="broadcastTime">{formattedRemaining}</div>
      <p className="broadcastMeta">経過 {formatTime(elapsedSeconds)} / 全体 {formatTime(displayDuration)}</p>
      <ProgressBar />
    </div>
    {!broadcastAudioReady && <button className="audioEnableButton" onClick={() => void enableBroadcastAudio()}><Volume2 />音声を有効にする</button>}
    {bellNotice && <div className="bellNotice"><Bell />{bellNotice}</div>}
  </section></main>;

  const startOrPause = () => {
    if (runtime.status === "running") {
      const at = Date.now();
      commit((previous) => ({ ...previous, runtime: { ...previous.runtime, status: "paused", elapsedBeforeStartMs: elapsedMs(previous.runtime, at), startedAt: null } }));
      return;
    }
    if (hasInvalidBell) return;
    void getAudioContext(); void loadAudio();
    const at = Date.now();
    commit((previous) => ({ ...previous, runtime: previous.runtime.status === "paused" ? { ...previous.runtime, status: "running", startedAt: at } : { status: "running", startedAt: at, elapsedBeforeStartMs: 0, activeDurationSeconds: previous.settings.durationSeconds, activeBells: previous.settings.bells.map((bell) => ({ ...bell })), firedBellIds: [] } }));
  };

  const reset = () => commit((previous) => ({ ...previous, runtime: { status: "idle", startedAt: null, elapsedBeforeStartMs: 0, activeDurationSeconds: previous.settings.durationSeconds, activeBells: [], firedBellIds: [] } }));

  return <main className="app">
    <header className="appHeader"><div><h1>Presentation Timer</h1><p>発表進行・配信用タイマー</p></div><div className="headerActions">
      <button className="iconButton" onClick={() => updateSettings({ muted: !settings.muted })} title={settings.muted ? "音を有効にする" : "ミュート"}>{settings.muted ? <VolumeX /> : <Volume2 />}</button>
      <button className="primary" onClick={openBroadcastWindow}><Maximize2 />配信用画面</button>
    </div></header>
    <section className="workspace">
      <div className="panel timerPanel"><div className={`miniBroadcast ${tone}`}><span>{statusLabel}</span><strong>{formattedRemaining}</strong><p>経過 {formatTime(elapsedSeconds)} / 全体 {formatTime(displayDuration)}</p><ProgressBar /></div>
        <div className="controls"><button onClick={startOrPause} disabled={hasInvalidBell} className={`controlButton primaryControl ${runtime.status === "running" ? "pauseControl" : ""}`}>{runtime.status === "running" ? <Pause /> : <Play />}<span>{runtime.status === "running" ? "一時停止" : "開始"}</span></button><button onClick={reset} className="controlButton secondary"><RotateCcw />リセット</button><button onClick={() => playBell(settings.volume, 1)} className="iconButton" title="鈴を試聴"><Bell /></button></div>
      </div>
      <aside className="settingsColumn">
        <section className="panel settingsPanel"><div className="panelTitle"><div><h2>タイマー設定</h2>{isActive && <p>時間設定を変更するにはリセットしてください</p>}</div></div>
          <div className="settingRow"><span>全体時間</span><div className="timeInputs"><label><input type="number" min="0" disabled={isActive} value={durationParts.minutes} onChange={(event) => updateDuration(Number(event.target.value), durationParts.seconds)} />分</label><label><input type="number" min="0" max="59" disabled={isActive} value={durationParts.seconds} onChange={(event) => updateDuration(durationParts.minutes, Number(event.target.value))} />秒</label></div></div>
          <div className="settingRow"><span>配信比率</span><div className="segments">{(["16:9", "4:3"] as AspectRatio[]).map((ratio) => <button key={ratio} className={settings.aspectRatio === ratio ? "active" : ""} onClick={() => updateSettings({ aspectRatio: ratio })}>{ratio}</button>)}</div></div>
          <div className="settingRow"><label htmlFor="volume">音量</label><input id="volume" className="volumeSlider" type="range" min="0" max="1" step="0.05" value={settings.volume} onChange={(event) => updateSettings({ volume: Number(event.target.value) })} /></div>
        </section>
        <section className="panel bellPanel"><div className="panelTitle"><div><h2>鈴スケジュール</h2><p>指定した残り時間で鳴ります</p></div><button className="iconButton" disabled={isActive} onClick={() => updateSettings({ bells: [...settings.bells, { id: crypto.randomUUID(), triggerRemainingSeconds: 0, strikeCount: 1, enabled: true }] })} title="鈴を追加"><Plus /></button></div>
          {hasInvalidBell && <p className="errorMessage">全体時間より大きい残り時間は設定できません</p>}
          <div className="bellList">{settings.bells.map((bell, index) => { const parts = splitTime(bell.triggerRemainingSeconds); const invalid = bell.enabled && bell.triggerRemainingSeconds > settings.durationSeconds; return <article className={`bellItem ${invalid ? "invalid" : ""}`} key={bell.id}>
            <label className="enableBell"><input type="checkbox" disabled={isActive} checked={bell.enabled} onChange={(event) => updateBell(bell.id, { enabled: event.target.checked })} /><strong>{index + 1}鈴</strong></label>
            <div className="timeInputs"><label><input type="number" min="0" disabled={isActive} value={parts.minutes} onChange={(event) => updateBell(bell.id, { triggerRemainingSeconds: Number(event.target.value) * 60 + parts.seconds })} />分</label><label><input type="number" min="0" max="59" disabled={isActive} value={parts.seconds} onChange={(event) => updateBell(bell.id, { triggerRemainingSeconds: parts.minutes * 60 + Number(event.target.value) })} />秒</label></div>
            <label className="strikeCount">打音<select disabled={isActive} value={bell.strikeCount} onChange={(event) => updateBell(bell.id, { strikeCount: Number(event.target.value) })}>{[1,2,3,4,5].map((count) => <option key={count} value={count}>{count}回</option>)}</select></label>
            <button className="iconButton small" onClick={() => playBell(settings.volume, bell.strikeCount)} title={`${index + 1}鈴を試聴`}><Bell /></button><button className="iconButton small danger" disabled={isActive} onClick={() => updateSettings({ bells: settings.bells.filter((item) => item.id !== bell.id) })} title="削除"><Trash2 /></button>
          </article>; })}</div>
        </section>
      </aside>
    </section>
    <section className="usageGuide" aria-labelledby="usage-title">
      <div><h2 id="usage-title">使用方法と当日の流れ</h2><p>設定から次の発表へ進むまで</p></div>
      <ol>
        <li><strong>全体時間を設定</strong><span>発表枠の長さを分・秒で入力します。</span></li>
        <li><strong>鈴を設定</strong><span>残り何分何秒で、何回鳴らすかを設定して試聴します。</span></li>
        <li><strong>配信用画面を準備</strong><span>16:9または4:3を選び、「配信用画面」をDiscordで共有します。</span></li>
        <li><strong>発表開始</strong><span>「開始」を押すと設定が固定され、カウントと鈴の判定が始まります。</span></li>
        <li><strong>進行を操作</strong><span>必要に応じて一時停止・再開し、次の発表前にリセットします。</span></li>
      </ol>
      <p className="audioCredit">
        効果音: <a href="https://otologic.jp" target="_blank" rel="noreferrer">OtoLogic</a>
        「オノマトペ チーン04-2（短）」
        (<a href="https://creativecommons.org/licenses/by/4.0/deed.ja" target="_blank" rel="noreferrer">CC BY 4.0</a>)
      </p>
      <div className="footerLinks">
        <p className="authorCredit">作者: <a href="https://x.com/SSEC553" target="_blank" rel="noreferrer">SSEC553</a></p>
        <a className="shareButton" href={xShareUrl} target="_blank" rel="noreferrer"><Share2 />Xで共有</a>
      </div>
    </section>
  </main>;
}
