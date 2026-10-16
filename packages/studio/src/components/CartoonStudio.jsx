"use client";

import { useState, useCallback } from "react";
import { newExportJobId, exportOutcome } from "../exportCancelModel.mjs";

/**
 * CartoonStudio — UI for Generative Cartoon scenes via IPC.
 * Wired through window.promo.generateCartoonEdg / renderCartoonExport.
 * Provides script input, character config, EDG preview, and export.
 */
export default function CartoonStudio() {
  const [scriptLines, setScriptLines] = useState("");
  const [characterName, setCharacterName] = useState("Hero");
  const [rigType, setRigType] = useState("cutout_vector");
  const [primaryColor, setPrimaryColor] = useState("#7c3aed");
  const [aspect, setAspect] = useState("16:9");
  const [fps, setFps] = useState(30);
  const [edg, setEdg] = useState(null);
  const [scenes, setScenes] = useState([]);
  const [exportResult, setExportResult] = useState(null);
  const [error, setError] = useState(null);
  const [isExporting, setIsExporting] = useState(false);
  const [exportJobId, setExportJobId] = useState(null);
  const [exportStatus, setExportStatus] = useState("");
  const [isGenerating, setIsGenerating] = useState(false);
  // Phase 3 item 4: FFmpeg stays the default; HyperFrames is opt-in.
  const [renderer, setRenderer] = useState("ffmpeg");

  const promo = typeof window !== "undefined" ? window.promo : null;

  const handleGenerateEdg = useCallback(async () => {
    if (!promo) { setError("IPC bridge not available (window.promo)"); return; }
    setError(null);
    setIsGenerating(true);
    try {
      const lines = scriptLines
        .split("\n")
        .filter((l) => l.trim())
        .map((l) => ({ text: l.trim(), speaker: characterName }));
      if (lines.length === 0) { setError("Enter at least one script line"); return; }

      const result = await promo.generateCartoonEdg({
        scriptLines: lines,
        characterConfig: {
          id: characterName.toLowerCase().replace(/\s+/g, "_"),
          name: characterName,
          rigType,
          colorPalette: { primary: primaryColor },
        },
        aspect,
        fps,
      });

      if (result.ok) {
        setEdg(result.edg);
        setScenes(result.scenes || []);
      } else {
        setError(result.error || "Failed to generate EDG");
      }
    } catch (err) {
      setError(err.message);
    } finally {
      setIsGenerating(false);
    }
  }, [promo, scriptLines, characterName, rigType, primaryColor, aspect, fps]);

  const handleImportFromStory = useCallback(async () => {
    if (!promo?.integrateCartoonStory) {
      setError("IPC bridge promo.integrateCartoonStory not available");
      return;
    }
    setError(null);
    setIsGenerating(true);
    try {
      const sampleStory = {
        title: "Vidmyo Story",
        scenes: [
          { sceneId: "intro", text: "Witaj w nowej erze automatycznego montażu wideo z Vidmyo.", durationSec: 3.5, emotion: "excited" },
          { sceneId: "climax", text: "Nagle wszystkie żmudne zadania znikają dzięki silnikowi AI!", durationSec: 4.0, emotion: "dramatic" },
          { sceneId: "outro", text: "Sprawdź sam i oszczędź godziny każdego dnia.", durationSec: 3.0, emotion: "happy" },
        ],
      };
      const result = await promo.integrateCartoonStory({
        story: sampleStory,
        characterConfig: {
          id: characterName.toLowerCase().replace(/\s+/g, "_"),
          name: characterName,
          rigType,
          colorPalette: { primary: primaryColor },
        },
        aspect,
        fps,
      });
      if (result.ok) {
        setEdg(result.edg);
        setScenes(result.scenes || []);
        setScriptLines(sampleStory.scenes.map((s) => s.text).join("\n"));
      } else {
        setError(result.error || "Failed to integrate story with cartoon");
      }
    } catch (err) {
      setError(err.message);
    } finally {
      setIsGenerating(false);
    }
  }, [promo, characterName, rigType, primaryColor, aspect, fps]);

  const handleExport = useCallback(async () => {
    if (!promo || !edg) return;
    const jobId = newExportJobId("cartoon");
    setError(null);
    setIsExporting(true);
    setExportJobId(jobId);
    setExportStatus("Eksportowanie...");
    try {
      const result = await promo.renderCartoonExport({ edg, renderer, jobId });
      const outcome = exportOutcome(result);
      if (outcome.cancelled) {
        setExportStatus("Anulowano");
        setError(null);
      } else if (outcome.ok) {
        setExportStatus("Gotowe");
        setExportResult(result);
      } else {
        const unsupportedNote = Array.isArray(result.unsupported) && result.unsupported.length
          ? ` (nieobsługiwane cechy EDG: ${result.unsupported.map((u) => u.feature).join(", ")})`
          : "";
        setExportStatus(outcome.label);
        setError((result.error || "Export failed") + unsupportedNote);
      }
    } catch (err) {
      const outcome = exportOutcome({ ok: false, error: err.message, jobId });
      if (outcome.cancelled) {
        setExportStatus("Anulowano");
        setError(null);
      } else {
        setExportStatus(outcome.label);
        setError(err.message);
      }
    } finally {
      setIsExporting(false);
      setExportJobId(null);
    }
  }, [promo, edg, renderer]);

  const handleCancelExport = useCallback(async () => {
    if (!exportJobId || !promo?.cancelRenderExport) return;
    try {
      await promo.cancelRenderExport(exportJobId);
      setExportStatus("Anulowano");
    } catch (err) {
      setExportStatus(`Nie udało się anulować: ${err.message}`);
    }
  }, [promo, exportJobId]);


  return (
    <div className="w-full max-w-4xl mx-auto p-6 text-white space-y-6">
      <h2 className="text-xl font-bold tracking-tight">
        🎬 Generative Cartoon Studio
      </h2>
      <p className="text-white/50 text-sm">
        Create cartoon scenes from script lines. Audio-amplitude mouth animation
        (non-phonemic), speedlines, and speech bubbles. Renders via FFmpeg.
      </p>

      {error && (
        <div className="bg-red-500/10 border border-red-500/30 text-red-300 text-sm p-3 rounded-lg">
          {error}
        </div>
      )}

      {/* Script Input */}
      <div className="space-y-2">
        <label className="text-xs font-bold text-white/60 uppercase tracking-wider">
          Script Lines (one per line)
        </label>
        <textarea
          value={scriptLines}
          onChange={(e) => setScriptLines(e.target.value)}
          placeholder={"Cześć! Dzisiaj pokażę wam jak szybko edytować wideo.\nNagle pojawia się problem!\nAle spokojnie — mam rozwiązanie."}
          rows={5}
          className="w-full bg-white/5 border border-white/10 rounded-lg p-3 text-sm text-white placeholder:text-white/20 focus:outline-none focus:border-purple-500/50 resize-y"
        />
      </div>

      {/* Character Config */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        <div className="space-y-1">
          <label className="text-[10px] font-bold text-white/40 uppercase">
            Character Name
          </label>
          <input
            value={characterName}
            onChange={(e) => setCharacterName(e.target.value)}
            className="w-full bg-white/5 border border-white/10 rounded px-3 py-2 text-sm text-white focus:outline-none focus:border-purple-500/50"
          />
        </div>
        <div className="space-y-1">
          <label className="text-[10px] font-bold text-white/40 uppercase">
            Rig Type
          </label>
          <select
            value={rigType}
            onChange={(e) => setRigType(e.target.value)}
            className="w-full bg-white/5 border border-white/10 rounded px-3 py-2 text-sm text-white focus:outline-none appearance-none"
          >
            <option value="cutout_vector">Cutout Vector</option>
            <option value="stickman_2d">Stickman 2D</option>
            <option value="chibi_anime">Chibi Anime</option>
            <option value="cardstock_layered">Cardstock Layered</option>
          </select>
        </div>
        <div className="space-y-1">
          <label className="text-[10px] font-bold text-white/40 uppercase">
            Primary Color
          </label>
          <input
            type="color"
            value={primaryColor}
            onChange={(e) => setPrimaryColor(e.target.value)}
            className="w-full h-[38px] bg-white/5 border border-white/10 rounded cursor-pointer"
          />
        </div>
        <div className="space-y-1">
          <label className="text-[10px] font-bold text-white/40 uppercase">
            Aspect Ratio
          </label>
          <select
            value={aspect}
            onChange={(e) => setAspect(e.target.value)}
            className="w-full bg-white/5 border border-white/10 rounded px-3 py-2 text-sm text-white focus:outline-none appearance-none"
          >
            <option value="16:9">16:9 (Landscape)</option>
            <option value="9:16">9:16 (Vertical)</option>
            <option value="1:1">1:1 (Square)</option>
          </select>
        </div>
      </div>

      {/* Generate & Export Buttons */}
      <div className="flex items-center gap-3">
        <button
          onClick={handleGenerateEdg}
          disabled={isGenerating || !scriptLines.trim()}
          className="px-6 py-2.5 bg-purple-600 hover:bg-purple-500 text-white font-bold text-sm rounded-lg transition-all disabled:opacity-40 disabled:cursor-not-allowed"
        >
          {isGenerating ? "Generating…" : "Generate Cartoon EDG"}
        </button>
        <button
          onClick={handleImportFromStory}
          disabled={isGenerating}
          className="px-6 py-2.5 bg-indigo-600 hover:bg-indigo-500 text-white font-bold text-sm rounded-lg transition-all disabled:opacity-40 disabled:cursor-not-allowed"
        >
          Import from Story / Animations
        </button>
        <label className="flex items-center gap-2 text-xs text-white/60">
          <span>Renderer:</span>
          <select
            data-testid="cartoon-renderer-select"
            value={renderer}
            onChange={(e) => setRenderer(e.target.value)}
            className="bg-white/5 border border-white/15 rounded-lg px-2 py-2 text-white/80 text-xs"
          >
            <option value="ffmpeg">FFmpeg (domyślny)</option>
            <option value="hyperframes">HyperFrames (opt-in)</option>
          </select>
        </label>
        {edg && (
          <div className="flex items-center gap-2">
            <button
              onClick={handleExport}
              disabled={isExporting}
              className="px-6 py-2.5 bg-green-600 hover:bg-green-500 text-white font-bold text-sm rounded-lg transition-all disabled:opacity-40 disabled:cursor-not-allowed"
            >
              {isExporting ? "Exporting…" : "Export MP4"}
            </button>
            {isExporting && exportJobId && (
              <button
                onClick={handleCancelExport}
                data-testid="cancel-cartoon-export"
                className="px-4 py-2.5 bg-red-600/80 hover:bg-red-600 text-white font-bold text-sm rounded-lg transition-all"
              >
                Anuluj
              </button>
            )}
          </div>
        )}
      </div>

      {exportStatus && (
        <div
          data-testid="export-status"
          className={`text-xs px-3 py-1.5 rounded-lg border ${
            exportStatus === "Anulowano"
              ? "bg-amber-500/10 border-amber-500/30 text-amber-300"
              : exportStatus === "Gotowe"
              ? "bg-green-500/10 border-green-500/30 text-green-300"
              : "bg-white/5 border-white/10 text-white/70"
          }`}
        >
          Status: {exportStatus}
        </div>
      )}


      {/* Scenes Preview */}
      {scenes.length > 0 && (
        <div className="space-y-3">
          <h3 className="text-sm font-bold text-white/70">
            Scenes ({scenes.length})
          </h3>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
            {scenes.map((scene, idx) => (
              <div
                key={scene.sceneId || idx}
                className="bg-white/5 border border-white/10 rounded-lg p-3 text-xs space-y-1"
              >
                <div className="flex items-center justify-between">
                  <span className="font-bold text-purple-400">
                    {scene.sceneId}
                  </span>
                  <span className="text-white/30">
                    {scene.durationSec?.toFixed(1)}s
                  </span>
                </div>
                <p className="text-white/60 line-clamp-2">{scene.dialogue}</p>
                {scene.visualEffects?.speedlines && (
                  <span className="inline-block text-[10px] bg-yellow-500/20 text-yellow-300 px-2 py-0.5 rounded">
                    ⚡ Speedlines
                  </span>
                )}
              </div>
            ))}
          </div>
        </div>
      )}

      {/* EDG Preview */}
      {edg && (
        <details className="bg-white/5 border border-white/10 rounded-lg p-3">
          <summary className="text-xs font-bold text-white/60 cursor-pointer">
            EDG Timeline Preview (JSON)
          </summary>
          <pre className="mt-2 text-[10px] text-white/40 overflow-x-auto max-h-60">
            {JSON.stringify(edg, null, 2)}
          </pre>
        </details>
      )}

      {/* Export Result */}
      {exportResult && (
        <div className="bg-green-500/10 border border-green-500/30 text-green-300 text-sm p-3 rounded-lg">
          ✅ Exported to: <code className="text-green-200">{exportResult.outputPath}</code>
          {Array.isArray(exportResult.unsupported) && exportResult.unsupported.length > 0 && (
            <span className="ml-2 text-amber-300">
              nieużyte cechy EDG: {exportResult.unsupported.map((u) => u.feature).join(", ")}
            </span>
          )}
          {exportResult.jobId && (
            <span className="ml-2 text-white/40">Job: {exportResult.jobId}</span>
          )}
        </div>
      )}
    </div>
  );
}
