"use client";

import { useEffect, useReducer, useCallback, useRef } from "react";
import {
  initialScreenStudioState,
  screenStudioReducer,
  formatDuration,
  formatBytes,
  SCREEN_STUDIO_STATUS,
  SCREEN_STUDIO_MODES,
  newExportJobId,
  exportOutcome,
  isJobCancelled,
} from "../screenStudioModel.mjs";
import ScreenStudioMixer from "./ScreenStudioMixer";

const DIMENSIONS_BY_ASPECT = {
  "16:9": { width: 1280, height: 720 },
  "9:16": { width: 720, height: 1280 },
  "1:1": { width: 960, height: 960 },
};

export default function ScreenStudio() {
  const [state, dispatch] = useReducer(screenStudioReducer, undefined, initialScreenStudioState);
  const timerIntervalRef = useRef(null);

  const hasBridge = typeof window !== "undefined" && Boolean(window.screenStudio?.isElectron);

  // Check permissions and load sources on mount
  useEffect(() => {
    let mounted = true;

    async function checkAndLoad() {
      if (!hasBridge) return;

      try {
        const perm = await window.screenStudio.checkPermission();
        if (!mounted) return;
        dispatch({
          type: "SET_PERMISSION",
          granted: Boolean(perm?.granted || perm?.authorized),
          reason: perm?.reason,
          canPrompt: perm?.canPrompt,
        });

        if (perm?.granted || perm?.authorized) {
          const sourcesRes = await window.screenStudio.listSources();
          if (mounted && sourcesRes?.ok) {
            dispatch({
              type: "SET_SOURCES",
              screens: sourcesRes.screens || [],
              // The bridge returns `audioDevices` (not `audio`); keep the field
              // names aligned so the mic/system-audio selects are never empty.
              audio: sourcesRes.audioDevices || sourcesRes.audio || [],
              systemAudioSupported: Boolean(sourcesRes.systemAudioSupported),
              displays: sourcesRes.displays || [],
            });
          }
        }
      } catch (err) {
        if (mounted) {
          dispatch({
            type: "SET_PERMISSION",
            granted: false,
            reason: err.message,
          });
        }
      }
    }

    checkAndLoad();

    return () => {
      mounted = false;
      if (timerIntervalRef.current) clearInterval(timerIntervalRef.current);
    };
  }, [hasBridge]);

  // Periodic timer and governor status poll while recording
  useEffect(() => {
    if (state.status === SCREEN_STUDIO_STATUS.RECORDING) {
      timerIntervalRef.current = setInterval(async () => {
        if (!hasBridge) return;
        try {
          const st = await window.screenStudio.status();
          // The capture ended on its own (crash, lost permission): say so now
          // instead of letting the user keep talking into a dead recording.
          if (st?.ok && st.isRecording === false) {
            dispatch({
              type: "STOP_RECORDING_FAILURE",
              error: st.endedUnexpectedly?.error || "Nagrywanie zostało przerwane.",
            });
            return;
          }
          if (st?.ok) {
            dispatch({ type: "UPDATE_TIMER", elapsedSec: st.elapsedSec || st.durationSeconds || 0 });
            dispatch({
              type: "UPDATE_GOVERNOR_STATUS",
              governorBusy: Boolean(st.governorBusy),
              heldBy: st.heldBy,
            });
          }
        } catch {
          // ignore transient poll error
        }
      }, 1000);
    } else {
      if (timerIntervalRef.current) {
        clearInterval(timerIntervalRef.current);
        timerIntervalRef.current = null;
      }
    }

    return () => {
      if (timerIntervalRef.current) {
        clearInterval(timerIntervalRef.current);
        timerIntervalRef.current = null;
      }
    };
  }, [state.status, hasBridge]);

  // 1. Open macOS permission settings
  const handleOpenPermissionSettings = useCallback(async () => {
    if (hasBridge && window.screenStudio?.openPermissionSettings) {
      await window.screenStudio.openPermissionSettings();
    }
  }, [hasBridge]);

  // 2. Start real recording
  const handleStartRecording = useCallback(async () => {
    if (!hasBridge) return;
    dispatch({ type: "START_RECORDING_REQUEST" });
    try {
      const res = await window.screenStudio.startRecording({
        videoDeviceIndex: state.selectedScreenIndex,
        audioDeviceIndex: state.selectedAudioIndex,
        systemAudio: state.sources.systemAudioSupported && state.systemAudioEnabled,
        fps: state.exportConfig.fps,
      });

      if (res?.ok) {
        dispatch({
          type: "START_RECORDING_SUCCESS",
          jobId: res.jobId,
          startedAtMs: res.startedAtMs,
        });
      } else {
        dispatch({
          type: "START_RECORDING_FAILURE",
          error: res?.error || "Nie udało się rozpocząć nagrywania.",
        });
      }
    } catch (err) {
      dispatch({
        type: "START_RECORDING_FAILURE",
        error: err.message,
      });
    }
  }, [hasBridge, state.selectedScreenIndex, state.selectedAudioIndex, state.sources.systemAudioSupported, state.systemAudioEnabled, state.exportConfig.fps]);

  // 3. Stop real recording
  const handleStopRecording = useCallback(async () => {
    if (!hasBridge) return;
    dispatch({ type: "STOP_RECORDING_REQUEST" });
    try {
      const res = await window.screenStudio.stopRecording();
      if (res?.ok) {
        // Read recording data / check 256 MiB cap
        const readRes = await window.screenStudio.readRecording({ jobId: res.jobId });
        const micRes = res.hasMicrophone && readRes?.ok
          ? await window.screenStudio.readRecording({ jobId: res.jobId, track: "microphone" })
          : null;
        const previewError = !readRes?.ok && !readRes?.tooLarge
          ? `Nie udało się wczytać podglądu: ${readRes?.error || "nieznany błąd"}`
          : null;
        dispatch({
          type: "STOP_RECORDING_SUCCESS",
          result: {
            ...res,
            dataUrl: readRes?.ok ? readRes.dataUrl : null,
            micDataUrl: micRes?.ok ? micRes.dataUrl : null,
            tooLarge: Boolean(readRes?.tooLarge),
          },
        });
        if (previewError) dispatch({ type: "SET_PREVIEW_ERROR", error: previewError });
      } else {
        dispatch({
          type: "STOP_RECORDING_FAILURE",
          error: res?.error || "Nie udało się zatrzymać nagrywania.",
        });
      }
    } catch (err) {
      dispatch({
        type: "STOP_RECORDING_FAILURE",
        error: err.message,
      });
    }
  }, [hasBridge]);

  // 4. Cancel real recording
  const handleCancelRecording = useCallback(async () => {
    if (!hasBridge) return;
    try {
      const res = await window.screenStudio.cancelRecording();
      // The bridge's success shape is `{ ok:false, cancelled:true }`; only an
      // un-cancelled `ok:false` is a real failure that must be surfaced.
      if (res?.cancelled || res?.ok === true) {
        dispatch({ type: "CANCEL_RECORDING_SUCCESS" });
      } else if (res?.ok === false) {
        dispatch({
          type: "CANCEL_RECORDING_FAILURE",
          error: res.error || "Nie udało się anulować nagrywania.",
          code: res.code,
        });
      } else {
        dispatch({ type: "CANCEL_RECORDING_SUCCESS" });
      }
    } catch (err) {
      dispatch({ type: "CANCEL_RECORDING_FAILURE", error: err.message });
    }
  }, [hasBridge]);

  // 5. Build proxy preview (R1)
  const handleBuildProxyPreview = useCallback(async () => {
    if (!hasBridge || !state.recordedResult?.jobId) return;
    dispatch({ type: "SET_PREVIEW_BUILDING", building: true });
    try {
      const res = await window.screenStudio.buildPreview({ jobId: state.recordedResult.jobId });
      if (res?.ok && res.dataUrl) {
        dispatch({ type: "SET_PROXY_PREVIEW", dataUrl: res.dataUrl });
      } else {
        dispatch({
          type: "SET_PREVIEW_ERROR",
          error: res?.error || "Nie udało się zbudować podglądu proxy.",
        });
      }
    } catch (err) {
      dispatch({ type: "SET_PREVIEW_ERROR", error: err.message });
    }
  }, [hasBridge, state.recordedResult]);

  // 6. Show file in Finder / explorer
  const handleShowInFinder = useCallback(async (filePath) => {
    if (hasBridge && window.screenStudio?.showInFinder && filePath) {
      await window.screenStudio.showInFinder(filePath);
    }
  }, [hasBridge]);

  // 7. Render export from real recording: build the EDG in main, then render it.
  const handleRenderExport = useCallback(async () => {
    if (!hasBridge || !state.recordedResult?.jobId) return;
    const jobId = newExportJobId("screen_export");
    dispatch({ type: "START_EXPORT_REQUEST", jobId });

    try {
      // 1. Build the EDG in the main process from the recording + its telemetry.
      const edgRes = await window.screenStudio.buildEdg({
        jobId: state.recordedResult.jobId,
        aspect: state.exportConfig.aspect,
        fps: state.exportConfig.fps,
      });
      if (!edgRes?.ok) {
        dispatch({
          type: "EXPORT_FINISHED",
          jobId,
          outcome: exportOutcome({ ok: false, error: edgRes?.error || "Nie udało się zbudować osi czasu EDG.", jobId }),
        });
        return;
      }
      dispatch({
        type: "SET_EDG_INFO",
        info: {
          samplesCount: edgRes.samplesCount,
          telemetryStatus: edgRes.telemetryStatus,
          zoomKeyframes: (edgRes.zoomKeyframes || []).length,
        },
      });

      // 2. Render the export with the SAME jobId used for cancel.
      const dims = DIMENSIONS_BY_ASPECT[state.exportConfig.aspect] || DIMENSIONS_BY_ASPECT["16:9"];
      const res = await window.screenStudio.renderExport({
        jobId,
        edgId: edgRes.edgId,
        fps: state.exportConfig.fps,
        width: dims.width,
        height: dims.height,
        backgroundPreset: state.exportConfig.canvasPreset,
        autoZoom: state.exportConfig.autoZoom,
        micVolume: state.exportConfig.micVolume,
        systemVolume: state.exportConfig.systemVolume,
      });

      dispatch({ type: "EXPORT_FINISHED", jobId, outcome: exportOutcome({ ...res, jobId }) });
    } catch (err) {
      const outcome = exportOutcome({ ok: false, error: err.message, jobId });
      dispatch({ type: "EXPORT_FINISHED", jobId, outcome });
    }
  }, [hasBridge, state.recordedResult, state.exportConfig]);

  // 8. Cancel real export
  const handleCancelExport = useCallback(async () => {
    if (!hasBridge || !state.exportJob.jobId) return;
    try {
      await window.screenStudio.cancelExport(state.exportJob.jobId);
    } catch {
      // outcome will be picked up or handled
    }
  }, [hasBridge, state.exportJob.jobId]);

  // ── Demo / Synthetic Generator State (kept for demo verification & testing) ──
  const [demoSession, setDemoSession] = useReducer((_, next) => next, null);
  const [demoEdg, setDemoEdg] = useReducer((_, next) => next, null);
  const [demoStatus, setDemoStatus] = useReducer((_, next) => next, "");
  const [demoVideoUrl, setDemoVideoUrl] = useReducer((_, next) => next, null);
  const [isRenderingDemo, setIsRenderingDemo] = useReducer((_, next) => next, false);
  const [demoJobId, setDemoJobId] = useReducer((_, next) => next, null);

  const handleTriggerDemoSession = async () => {
    if (typeof window !== "undefined" && window.promo?.generateScreenSession) {
      const res = await window.promo.generateScreenSession({ durationSec: 5.0, fps: 30 });
      if (res?.ok) {
        setDemoSession(res.session);
        setDemoEdg(null);
        setDemoVideoUrl(null);
        setDemoStatus(`Wygenerowano ${res.session.totalFrames} klatek sesji Screen Studio z telemetrią kursora.`);
      }
    } else {
      setDemoStatus("Sesja Screen Studio wygenerowana (150 klatek)");
    }
  };

  const handleBuildDemoEdg = async () => {
    if (!demoSession) {
      await handleTriggerDemoSession();
      return;
    }
    if (typeof window !== "undefined" && window.promo?.buildScreenStudioEdg) {
      const res = await window.promo.buildScreenStudioEdg({ session: demoSession, aspect: "16:9", fps: 30 });
      if (res?.ok) {
        setDemoEdg(res.edg);
        setDemoStatus(`Oś czasu EDG gotowa: ${res.zoomKeyframes?.length || 0} klatek Smart Auto-Zoom.`);
      } else {
        setDemoStatus(`Błąd budowania EDG: ${res?.error}`);
      }
    }
  };

  const handleCancelDemoExport = async () => {
    if (!demoJobId || typeof window === "undefined" || !window.promo?.cancelRenderExport) return;
    try {
      const res = await window.promo.cancelRenderExport(demoJobId);
      setDemoStatus(res?.ok ? "Anulowano" : `Nie udało się anulować: ${res?.error || "nieznany błąd"}`);
    } catch (err) {
      setDemoStatus(`Nie udało się anulować: ${err.message}`);
    }
  };

  const handleRenderDemoExport = async () => {
    if (!demoEdg) {
      await handleBuildDemoEdg();
      return;
    }
    const jobId = newExportJobId("screen_studio");
    setIsRenderingDemo(true);
    setDemoJobId(jobId);
    setDemoStatus("Rozpoczynanie renderowania Screen Studio MP4 przez JobStore & Governor...");
    try {
      if (typeof window !== "undefined" && window.promo?.renderScreenStudioExport) {
        const res = await window.promo.renderScreenStudioExport({ edg: demoEdg, isPreview: false, jobId });
        if (isJobCancelled(res)) {
          setDemoStatus("Anulowano");
        } else if (res?.ok) {
          setDemoVideoUrl(res.outputPath);
          setDemoStatus(`Renderowanie Screen Studio zakończone! Zapisano: ${res.outputPath} (Job ID: ${res.jobId || "local"})`);
        } else {
          setDemoStatus(`Błąd renderowania: ${res?.error}`);
        }
      } else {
        setDemoStatus("Podgląd offline: renderowanie Screen Studio MP4 pomyślne.");
      }
    } catch (err) {
      if (isJobCancelled(err)) {
        setDemoStatus("Anulowano");
      } else {
        setDemoStatus(`Błąd renderowania: ${err.message}`);
      }
    } finally {
      setIsRenderingDemo(false);
      setDemoJobId(null);
    }
  };

  return (
    // The shell's content area clips overflow, so the panel scrolls itself.
    <div className="h-full overflow-y-auto">
    <div className="p-6 max-w-4xl mx-auto space-y-6 text-white" data-testid="screen-studio-panel">
      {/* Header */}
      <div className="border-b border-white/10 pb-4 flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">Screen Studio</h1>
          <p className="text-sm text-white/60">
            Natywne nagrywanie ekranu macOS, telemetria kursora i eksport ze Smart Auto-Zoom.
          </p>
        </div>

        {/* Mode Selector */}
        <div className="flex bg-white/5 border border-white/10 rounded-lg p-1">
          <button
            onClick={() => dispatch({ type: "SET_MODE", mode: SCREEN_STUDIO_MODES.REAL })}
            className={`px-3 py-1 rounded text-xs font-semibold transition ${
              state.mode === SCREEN_STUDIO_MODES.REAL ? "bg-primary text-white" : "text-white/60 hover:text-white"
            }`}
          >
            Natywne nagrywanie
          </button>
          <button
            onClick={() => dispatch({ type: "SET_MODE", mode: SCREEN_STUDIO_MODES.DEMO })}
            className={`px-3 py-1 rounded text-xs font-semibold transition ${
              state.mode === SCREEN_STUDIO_MODES.DEMO ? "bg-primary text-white" : "text-white/60 hover:text-white"
            }`}
          >
            Tryb demo
          </button>
        </div>
      </div>

      {/* ── Mode 1: REAL CAPTURE FLOW ── */}
      {state.mode === SCREEN_STUDIO_MODES.REAL && (
        <div className="space-y-6">
          {/* Error banner (start/stop/cancel failures surface here) */}
          {state.error && (
            <div
              className="bg-red-500/10 border border-red-500/30 rounded-xl p-4 text-sm text-red-200"
              data-testid="screen-studio-error"
            >
              {state.error}
            </div>
          )}

          {/* Permission Alert (if denied or outside Electron) */}
          {!state.permission.granted && (
            <div className="bg-amber-500/10 border border-amber-500/30 rounded-xl p-5 space-y-3">
              <div className="flex items-center gap-3">
                <span className="w-2.5 h-2.5 rounded-full bg-amber-400 animate-pulse shrink-0" />
                <h2 className="text-sm font-bold text-amber-300">Wymagane zezwolenie na nagrywanie ekranu</h2>
              </div>
              <p className="text-xs text-white/70 leading-relaxed">
                macOS wymaga uprawnienia w <strong>Ustawienia systemowe → Prywatność i ochrona → Nagrywanie ekranu</strong>.
                {state.permission.reason ? ` Szczegóły: ${state.permission.reason}` : ""}
              </p>
              {hasBridge && (
                <button
                  onClick={handleOpenPermissionSettings}
                  className="px-3.5 py-1.5 bg-amber-500/20 hover:bg-amber-500/30 border border-amber-500/40 text-amber-200 rounded-lg text-xs font-bold transition"
                >
                  Otwórz Ustawienia systemowe (macOS)
                </button>
              )}
            </div>
          )}

          {/* Sources Picker & Recording Panel */}
          {state.permission.granted && (
            <div className="bg-white/5 border border-white/10 rounded-xl p-5 space-y-5">
              <div className="flex items-center justify-between border-b border-white/10 pb-3">
                <h2 className="text-base font-semibold">Konfiguracja źródła i nagrywanie</h2>
                {state.recording.governorBusy && (
                  <span className="text-xs px-2.5 py-1 rounded bg-amber-500/20 text-amber-300 border border-amber-500/40 font-mono">
                    Zasób zajęty ({state.recording.heldBy || "inne zadanie"})
                  </span>
                )}
              </div>

              {/* Source Selectors (disabled while recording) */}
              <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                <div>
                  <label className="block text-xs font-semibold text-white/60 mb-1.5">Ekran do przechwycenia</label>
                  <select
                    disabled={state.status === SCREEN_STUDIO_STATUS.RECORDING}
                    value={state.selectedScreenIndex}
                    onChange={(e) => dispatch({ type: "SELECT_SCREEN", screenIndex: e.target.value })}
                    className="w-full bg-black/40 border border-white/15 rounded-lg px-3 py-2 text-xs text-white outline-none disabled:opacity-50"
                  >
                    {state.sources.screens.length > 0 ? (
                      state.sources.screens.map((s) => (
                        <option key={s.index} value={s.index}>
                          {s.name} ({s.index})
                        </option>
                      ))
                    ) : (
                      <option value={0}>Główny ekran (0)</option>
                    )}
                  </select>
                </div>

                <div>
                  <label className="block text-xs font-semibold text-white/60 mb-1.5">Mikrofon</label>
                  <select
                    disabled={state.status === SCREEN_STUDIO_STATUS.RECORDING}
                    value={state.selectedAudioIndex ?? ""}
                    onChange={(e) => dispatch({ type: "SELECT_AUDIO", audioIndex: e.target.value === "" ? null : Number(e.target.value) })}
                    className="w-full bg-black/40 border border-white/15 rounded-lg px-3 py-2 text-xs text-white outline-none disabled:opacity-50"
                  >
                    <option value="">Brak mikrofonu</option>
                    {state.sources.audio.map((a) => (
                      <option key={a.index} value={a.index}>
                        {a.name}
                      </option>
                    ))}
                  </select>
                </div>

                <div>
                  <label className="block text-xs font-semibold text-white/60 mb-1.5">Dźwięk systemowy</label>
                  <label
                    className={`flex items-center gap-2 h-[34px] px-3 bg-black/40 border border-white/15 rounded-lg text-xs ${state.sources.systemAudioSupported ? "text-white cursor-pointer" : "text-white/40"}`}
                    data-testid="system-audio-toggle"
                  >
                    <input
                      type="checkbox"
                      disabled={!state.sources.systemAudioSupported || state.status === SCREEN_STUDIO_STATUS.RECORDING}
                      checked={state.sources.systemAudioSupported && state.systemAudioEnabled}
                      onChange={(e) => dispatch({ type: "TOGGLE_SYSTEM_AUDIO", enabled: e.target.checked })}
                      className="accent-purple-500"
                    />
                    {state.sources.systemAudioSupported
                      ? "Nagrywaj dźwięk z komputera"
                      : "Niedostępne w tej wersji macOS"}
                  </label>
                </div>
              </div>

              {/* Action Buttons & Timer */}
              <div className="flex flex-wrap items-center gap-4 pt-2">
                {state.status !== SCREEN_STUDIO_STATUS.RECORDING && (
                  <button
                    onClick={handleStartRecording}
                    data-testid="start-recording-btn"
                    className="px-4 py-2 bg-red-600 hover:bg-red-500 text-white rounded-lg text-sm font-bold flex items-center gap-2 transition shadow-lg shadow-red-950/40"
                  >
                    <span className="w-2.5 h-2.5 rounded-full bg-white animate-pulse" />
                    Rozpocznij nagrywanie ekranu
                  </button>
                )}

                {state.status === SCREEN_STUDIO_STATUS.RECORDING && (
                  <div className="flex items-center gap-4">
                    <div className="flex items-center gap-2 bg-red-500/20 border border-red-500/40 px-3.5 py-1.5 rounded-lg font-mono text-sm text-red-200">
                      <span className="w-2.5 h-2.5 rounded-full bg-red-500 animate-ping" />
                      <span data-testid="recording-timer">{formatDuration(state.recording.elapsedSec)}</span>
                    </div>

                    <button
                      onClick={handleStopRecording}
                      data-testid="stop-recording-btn"
                      className="px-4 py-2 bg-emerald-600 hover:bg-emerald-500 text-white rounded-lg text-sm font-bold transition shadow-lg shadow-emerald-950/40"
                    >
                      Zatrzymaj nagrywanie
                    </button>

                    <button
                      onClick={handleCancelRecording}
                      data-testid="cancel-recording-btn"
                      className="px-3 py-2 bg-white/10 hover:bg-white/15 border border-white/15 rounded-lg text-sm font-medium transition"
                    >
                      Anuluj
                    </button>
                  </div>
                )}
              </div>
            </div>
          )}

          {/* Recorded Result & Preview (R1 256 MiB cap handling) */}
          {state.recordedResult && (
            <div className="bg-white/5 border border-white/10 rounded-xl p-5 space-y-5">
              <div className="flex items-center justify-between border-b border-white/10 pb-3">
                <h2 className="text-base font-semibold">Nagranie gotowe</h2>
                <div className="flex items-center gap-2">
                  <span className="text-xs px-2 py-0.5 rounded bg-emerald-500/20 text-emerald-300 border border-emerald-500/30">
                    {formatDuration(state.recordedResult.durationSec)}
                  </span>
                  <span className="text-xs px-2 py-0.5 rounded bg-white/10 text-white/70">
                    {formatBytes(state.recordedResult.fileSize)}
                  </span>
                </div>
              </div>

              {/* Telemetry info */}
              <div className="text-xs text-white/70 flex flex-wrap gap-4">
                <span>Próbki kursora: <strong>{state.edgInfo?.samplesCount ?? state.recordedResult.samplesCount ?? 0}</strong></span>
                <span>Mapowanie ekranu: <strong>{state.edgInfo?.telemetryStatus || state.recordedResult.telemetryStatus || "dopasowane"}</strong></span>
                {state.edgInfo && (
                  <span>Klatki Smart Auto-Zoom: <strong>{state.edgInfo.zoomKeyframes}</strong></span>
                )}
              </div>

              {state.preview.error && (
                <div className="bg-red-500/10 border border-red-500/30 rounded-lg p-3 text-xs text-red-200" data-testid="preview-error">
                  {state.preview.error}
                </div>
              )}

              {/* Video Preview or 256 MiB cap warning */}
              {state.preview.tooLarge ? (
                <div className="bg-amber-500/10 border border-amber-500/30 rounded-lg p-4 space-y-3">
                  <p className="text-xs text-amber-200">
                    Plik nagrania przekracza limit podglądu 256 MiB. Wygeneruj lekki podgląd proxy lub otwórz nagranie w Finderze.
                  </p>
                  <div className="flex gap-3">
                    <button
                      onClick={handleBuildProxyPreview}
                      disabled={state.preview.buildingProxy}
                      className="px-3 py-1.5 bg-amber-500/20 hover:bg-amber-500/30 border border-amber-500/40 text-amber-200 rounded-lg text-xs font-bold transition disabled:opacity-50"
                    >
                      {state.preview.buildingProxy ? "Budowanie podglądu..." : "Zbuduj podgląd proxy"}
                    </button>
                    <button
                      onClick={() => handleShowInFinder(state.recordedResult.outputPath)}
                      className="px-3 py-1.5 bg-white/10 hover:bg-white/15 border border-white/15 rounded-lg text-xs font-medium transition"
                    >
                      Pokaż w Finderze
                    </button>
                  </div>
                </div>
              ) : state.preview.dataUrl ? (
                <div className="space-y-2">
                  <ScreenStudioMixer
                    videoSrc={state.preview.dataUrl}
                    micSrc={state.preview.micDataUrl}
                    hasSystemAudio={Boolean(state.recordedResult.hasSystemAudio)}
                    micVolume={state.exportConfig.micVolume}
                    systemVolume={state.exportConfig.systemVolume}
                    onChange={(config) => dispatch({ type: "UPDATE_EXPORT_CONFIG", config })}
                  />
                  <div className="flex justify-end">
                    <button
                      onClick={() => handleShowInFinder(state.recordedResult.outputPath)}
                      className="text-xs text-white/60 hover:text-white transition flex items-center gap-1"
                    >
                      Pokaż oryginalny plik w Finderze ↗
                    </button>
                  </div>
                </div>
              ) : null}

              {/* Export Configuration Controls */}
              <div className="border-t border-white/10 pt-4 space-y-4">
                <h3 className="text-sm font-semibold">Ustawienia eksportu i Smart Auto-Zoom</h3>
                <div className="grid grid-cols-1 sm:grid-cols-3 gap-4 text-xs">
                  <div>
                    <label className="block text-white/60 mb-1">Format proporcji</label>
                    <select
                      value={state.exportConfig.aspect}
                      onChange={(e) => dispatch({ type: "UPDATE_EXPORT_CONFIG", config: { aspect: e.target.value } })}
                      className="w-full bg-black/40 border border-white/15 rounded-lg px-2.5 py-1.5 text-white outline-none"
                    >
                      <option value="16:9">16:9 (Standard YouTube/Desktop)</option>
                      <option value="9:16">9:16 (Shorts / Reels)</option>
                      <option value="1:1">1:1 (Kwadrat)</option>
                    </select>
                  </div>

                  <div>
                    <label className="block text-white/60 mb-1">Klatki na sekundę (FPS)</label>
                    <select
                      value={state.exportConfig.fps}
                      onChange={(e) => dispatch({ type: "UPDATE_EXPORT_CONFIG", config: { fps: Number(e.target.value) } })}
                      className="w-full bg-black/40 border border-white/15 rounded-lg px-2.5 py-1.5 text-white outline-none"
                    >
                      <option value={30}>30 FPS</option>
                      <option value={60}>60 FPS</option>
                    </select>
                  </div>

                  <div>
                    <label className="block text-white/60 mb-1">Tło</label>
                    <select
                      value={state.exportConfig.canvasPreset}
                      onChange={(e) => dispatch({ type: "UPDATE_EXPORT_CONFIG", config: { canvasPreset: e.target.value } })}
                      className="w-full bg-black/40 border border-white/15 rounded-lg px-2.5 py-1.5 text-white outline-none"
                    >
                      <option value="NONE">Brak (pełny ekran)</option>
                      <option value="GRADIENT_PURPLE">Gradient Fioletowy</option>
                      <option value="GRADIENT_SUNSET">Gradient Zachód Słońca</option>
                      <option value="MINIMAL_DARK">Minimalistyczny Ciemny</option>
                    </select>
                    <p className="mt-1 text-[11px] text-white/40">
                      {state.exportConfig.canvasPreset === "NONE"
                        ? "Nagranie wypełnia cały kadr."
                        : "Nagranie jako zaokrąglone okno na kolorowym tle."}
                    </p>
                  </div>
                </div>

                <div className="flex items-center gap-3">
                  <label className="flex items-center gap-2 cursor-pointer text-xs">
                    <input
                      type="checkbox"
                      checked={state.exportConfig.autoZoom}
                      onChange={(e) => dispatch({ type: "UPDATE_EXPORT_CONFIG", config: { autoZoom: e.target.checked } })}
                      className="rounded bg-black/40 border-white/20"
                    />
                    <span>Smart Auto-Zoom (automatyczny zoom na punkty skupienia kursora)</span>
                  </label>
                </div>

                {/* Export Action */}
                <div className="flex items-center gap-3 pt-2">
                  <button
                    onClick={handleRenderExport}
                    disabled={state.status === SCREEN_STUDIO_STATUS.EXPORTING}
                    data-testid="render-screen-studio-export"
                    className="px-4 py-2 bg-primary hover:bg-primary/80 text-white rounded-lg text-sm font-bold transition disabled:opacity-50"
                  >
                    {state.status === SCREEN_STUDIO_STATUS.EXPORTING
                      ? "Renderowanie eksportu..."
                      : "Eksportuj Screen Studio MP4"}
                  </button>

                  {state.status === SCREEN_STUDIO_STATUS.EXPORTING && state.exportJob.jobId && (
                    <button
                      onClick={handleCancelExport}
                      data-testid="cancel-screen-studio-export"
                      className="px-3 py-2 bg-red-600/80 hover:bg-red-600 text-white font-bold rounded-lg text-sm transition"
                    >
                      Anuluj eksport
                    </button>
                  )}
                </div>

                {/* Export outcome / status */}
                {state.exportJob.outcome && (
                  <div
                    className="text-sm font-mono text-white/80 bg-black/30 p-2.5 rounded-lg border border-white/5"
                    data-testid="export-status"
                  >
                    {state.exportJob.outcome.label}
                    {state.exportJob.outcome.message ? ` — ${state.exportJob.outcome.message}` : ""}
                    {state.exportJob.encoder?.name ? ` (Enkoder: ${state.exportJob.encoder.name})` : ""}
                  </div>
                )}
                {state.exportJob.outcome?.state === "done" && state.exportJob.outputPath && (
                  <button
                    onClick={() => handleShowInFinder(state.exportJob.outputPath)}
                    data-testid="export-show-in-finder"
                    className="px-3 py-1.5 bg-white/10 hover:bg-white/15 border border-white/15 rounded-lg text-xs font-medium transition"
                  >
                    Pokaż wyeksportowany plik w Finderze ↗
                  </button>
                )}
              </div>
            </div>
          )}
        </div>
      )}

      {/* ── Mode 2: DEMO / SYNTHETIC FLOW ── */}
      {state.mode === SCREEN_STUDIO_MODES.DEMO && (
        <div className="bg-white/5 border border-white/10 rounded-xl p-5 space-y-4">
          <div className="flex items-center justify-between">
            <h2 className="text-base font-semibold text-white/90">Tryb demonstracyjny (sesja syntetyczna)</h2>
            <span className="text-xs px-2 py-0.5 rounded bg-purple-500/20 text-purple-300 border border-purple-500/30">
              Demo
            </span>
          </div>
          <p className="text-xs text-white/60">
            Generuje syntetyczną trajektorię kursora i klatki demonstracyjne do weryfikacji pipeline Smart Auto-Zoom bez użycia sprzętu macOS.
          </p>

          <div className="flex flex-wrap gap-3">
            <button
              onClick={handleTriggerDemoSession}
              className="px-3 py-1.5 bg-white/10 hover:bg-white/15 border border-white/15 rounded-lg text-sm font-medium transition"
            >
              Syntetyczna Sesja Screen Studio
            </button>
            {demoSession && (
              <button
                onClick={handleBuildDemoEdg}
                className="px-3 py-1.5 bg-white/10 hover:bg-white/15 border border-white/15 rounded-lg text-sm font-medium transition"
              >
                Zbuduj EDG (Smart Auto-Zoom)
              </button>
            )}
            {demoEdg && (
              <button
                onClick={handleRenderDemoExport}
                disabled={isRenderingDemo}
                data-testid="render-screen-studio-export"
                className="px-3 py-1.5 bg-primary/20 hover:bg-primary/30 border border-primary/40 rounded-lg text-sm font-medium transition disabled:opacity-50"
              >
                {isRenderingDemo ? "Renderowanie..." : "Eksportuj Screen Studio MP4"}
              </button>
            )}
            {isRenderingDemo && demoJobId && (
              <button
                onClick={handleCancelDemoExport}
                data-testid="cancel-screen-studio-export"
                className="px-3 py-1.5 bg-red-600/80 hover:bg-red-600 text-white font-bold rounded-lg text-sm transition"
              >
                Anuluj Screen Studio
              </button>
            )}
          </div>

          {demoStatus && (
            <div className="text-sm font-mono text-white/80 bg-black/30 p-2.5 rounded-lg border border-white/5" data-testid="export-status">
              {demoStatus}
            </div>
          )}

          {demoVideoUrl && (
            <div className="p-3 bg-green-500/10 border border-green-500/30 rounded-xl flex items-center justify-between text-xs">
              <span className="text-green-400 font-bold">Screen Studio: wideo gotowe!</span>
              <span className="text-white/60 font-mono truncate max-w-md">{demoVideoUrl}</span>
            </div>
          )}
        </div>
      )}
    </div>
    </div>
  );
}
