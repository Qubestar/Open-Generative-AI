"use client";

import { useCallback, useEffect, useRef } from "react";

// Preview + audio mixer for a Screen Studio recording. System audio lives in the
// video file and the microphone in a separate track; both play in sync through
// WebAudio gain nodes so the sliders are audible live (including above 100%).
// The same gains are sent to the export.

function VolumeSlider({ label, value, onChange, testId }) {
  const pct = Math.round(value * 100);
  return (
    <label className="block" data-testid={testId}>
      <div className="flex items-center justify-between text-xs mb-1">
        <span className="text-white/70">{label}</span>
        <span className="font-mono text-white/60">{pct === 0 ? "wyciszony" : `${pct}%`}</span>
      </div>
      <input
        type="range"
        min={0}
        max={200}
        step={5}
        value={pct}
        onChange={(e) => onChange(Number(e.target.value) / 100)}
        className="w-full accent-purple-500"
      />
    </label>
  );
}

export default function ScreenStudioMixer({
  videoSrc,
  micSrc = null,
  hasSystemAudio = false,
  micVolume = 1,
  systemVolume = 1,
  onChange,
}) {
  const videoRef = useRef(null);
  const micRef = useRef(null);
  const graphRef = useRef(null);

  const applyGains = useCallback(() => {
    const g = graphRef.current;
    if (g) {
      g.system.gain.value = systemVolume;
      if (g.mic) g.mic.gain.value = micVolume;
      return;
    }
    // Before the first play (no AudioContext yet) fall back to element volume.
    if (videoRef.current) videoRef.current.volume = Math.min(1, systemVolume);
    if (micRef.current) micRef.current.volume = Math.min(1, micVolume);
  }, [micVolume, systemVolume]);

  useEffect(() => { applyGains(); }, [applyGains]);

  // Build the WebAudio graph on first play (autoplay policy needs a gesture).
  const ensureGraph = useCallback(() => {
    if (graphRef.current || typeof window === "undefined") return;
    const Ctx = window.AudioContext || window.webkitAudioContext;
    if (!Ctx || !videoRef.current) return;
    const ctx = new Ctx();
    const system = ctx.createGain();
    ctx.createMediaElementSource(videoRef.current).connect(system).connect(ctx.destination);
    let mic = null;
    if (micRef.current) {
      mic = ctx.createGain();
      ctx.createMediaElementSource(micRef.current).connect(mic).connect(ctx.destination);
    }
    videoRef.current.volume = 1;
    if (micRef.current) micRef.current.volume = 1;
    graphRef.current = { ctx, system, mic };
    applyGains();
  }, [applyGains]);

  useEffect(() => () => {
    graphRef.current?.ctx.close().catch(() => {});
    graphRef.current = null;
  }, []);

  // Keep the microphone element locked to the video's transport.
  useEffect(() => {
    const video = videoRef.current;
    const mic = micRef.current;
    if (!video || !mic) return undefined;
    const sync = () => { if (Math.abs(mic.currentTime - video.currentTime) > 0.12) mic.currentTime = video.currentTime; };
    const onPlay = () => { ensureGraph(); graphRef.current?.ctx.resume(); sync(); mic.play().catch(() => {}); };
    const onPause = () => mic.pause();
    const onSeek = () => { mic.currentTime = video.currentTime; };
    const onRate = () => { mic.playbackRate = video.playbackRate; };
    video.addEventListener("play", onPlay);
    video.addEventListener("pause", onPause);
    video.addEventListener("ended", onPause);
    video.addEventListener("seeked", onSeek);
    video.addEventListener("timeupdate", sync);
    video.addEventListener("ratechange", onRate);
    return () => {
      video.removeEventListener("play", onPlay);
      video.removeEventListener("pause", onPause);
      video.removeEventListener("ended", onPause);
      video.removeEventListener("seeked", onSeek);
      video.removeEventListener("timeupdate", sync);
      video.removeEventListener("ratechange", onRate);
    };
  }, [micSrc, ensureGraph]);

  const showMixer = hasSystemAudio || Boolean(micSrc);

  return (
    <div className="space-y-3">
      <div className="rounded-lg overflow-hidden border border-white/10 bg-black aspect-video max-h-80 flex items-center justify-center">
        <video
          ref={videoRef}
          src={videoSrc}
          controls
          onPlay={micSrc ? undefined : () => { ensureGraph(); graphRef.current?.ctx.resume(); }}
          className="max-h-full max-w-full"
        />
        {micSrc && <audio ref={micRef} src={micSrc} preload="auto" className="hidden" />}
      </div>

      {showMixer && (
        <div className="bg-black/30 border border-white/10 rounded-lg p-3 space-y-3" data-testid="audio-mixer">
          <div className="flex items-center justify-between">
            <h3 className="text-xs font-semibold text-white/80">Mikser dźwięku</h3>
            <span className="text-[11px] text-white/40">Słychać w podglądzie, trafia do eksportu</span>
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            {micSrc && (
              <VolumeSlider
                label="Mikrofon"
                value={micVolume}
                onChange={(v) => onChange({ micVolume: v })}
                testId="mixer-mic"
              />
            )}
            {hasSystemAudio && (
              <VolumeSlider
                label="Dźwięk z komputera"
                value={systemVolume}
                onChange={(v) => onChange({ systemVolume: v })}
                testId="mixer-system"
              />
            )}
          </div>
        </div>
      )}
    </div>
  );
}
