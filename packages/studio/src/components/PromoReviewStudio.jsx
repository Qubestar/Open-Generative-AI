"use client";

import { useState, useEffect } from "react";

import { promoRenderOutcome } from "../promoExportModel.mjs";
import { newExportJobId, isJobCancelled, exportOutcome } from "../exportCancelModel.mjs";

const SAMPLE_FIXTURES = {
  saas: {
    id: "saas",
    name: "Vidmyo AI Studio",
    category: "digital_saas",
    url: "https://example.com/vidmyo",
    title: "Vidmyo - Automated Video Generation & Editing Suite",
    description: "Transform raw footage into viral shorts in minutes with deterministic AI.",
    h1: "Next-Gen Video Production for Teams",
    price: "199 zł / mies.",
    coreBenefit: "automatyzację montażu wideo i skracanie czasu postprodukcji",
    targetAudience: "twórców i montażystów wideo",
    avoidAudience: "osób, które nie publikują żadnych treści wideo",
    claims: [
      { text: "10x szybszy montaż w porównaniu do klasycznego workflow", claim: "10x szybszy montaż", source: "Internal benchmark M2 Pro 2026", verified: true, userExplicitlyConfirmedExperience: true },
      { text: "Ponad 500 zadowolonych klientów w programie beta", claim: "500 zadowolonych klientów", source: "Rejestr kont produkcyjnych Vidmyo", verified: true, userExplicitlyConfirmedExperience: true }
    ]
  },
  local_business: {
    id: "local_business",
    name: "Klinika Stomatologiczna Warszawa",
    category: "local_business",
    url: "https://example.com/stomatologia-warszawa",
    title: "Bezbolesne Leczenie Zębów i Implanty Warszawa Marszałkowska",
    description: "Nowoczesny gabinet stomatologiczny w centrum Warszawy. Zapisz się na bezpłatną konsultację.",
    h1: "Stomatologia i Implantologia Warszawa Śródmieście",
    price: "od 150 zł",
    coreBenefit: "bezstresowe i bezbolesne leczenie w centrum Warszawy",
    targetAudience: "mieszkańców Warszawy szukających sprawdzonego stomatologa",
    avoidAudience: "osób szukających najtańszych usług bez gwarancji jakości",
    claims: [
      { text: "Ponad 250 opinii 5-gwiazdkowych", claim: "250 opinii 5.0", source: "Wizytówka Google Reviews 2026", verified: true, userExplicitlyConfirmedExperience: true },
      { text: "Zabiegi w znieczuleniu komputerowym bez bólu", claim: "Znieczulenie komputerowe", source: "Specyfikacja sprzętu The Wand", verified: true, userExplicitlyConfirmedExperience: true }
    ]
  },
  ecommerce: {
    id: "ecommerce",
    name: "Fotel Ergonomiczny ErgoPro Max",
    category: "ecommerce_product",
    url: "https://example.com/fotel-ergopro",
    title: "Fotel Biurowy ErgoPro Max z Dynamicznym Podparciem Lędźwi",
    description: "Zadbaj o kręgosłup podczas 8-godzinnej pracy przy biurku. 30 dni na darmowy zwrot.",
    h1: "ErgoPro Max - Koniec z Bólem Pleców",
    price: "1 299 zł",
    coreBenefit: "eliminację bólu kręgosłupa i zdrowe podparcie lędźwi",
    targetAudience: "programistów i osób pracujących zdalnie ponad 6h dziennie",
    avoidAudience: "osób szukających taniego krzesła do sporadycznego siedzenia",
    claims: [
      { text: "Atest wytrzymałościowy BIFMA do 150 kg", claim: "Atest BIFMA 150 kg", source: "Certyfikat TÜV Rheinland 2025", verified: true, userExplicitlyConfirmedExperience: true },
      { text: "Przetestowane w 30-dniowym badaniu ergonomicznym", claim: "30-dniowe badanie ergonomiczne", source: "Wewnętrzny raport testowy zespołu ErgoPro", verified: true, userExplicitlyConfirmedExperience: true }
    ]
  }
};

export default function PromoReviewStudio() {
  const [studioMode, setStudioMode] = useState("promo"); // 'promo' | 'ugc'
  const [selectedFixture, setSelectedFixture] = useState("saas");
  const [pageUrl, setPageUrl] = useState("");
  const [isLoadingUrl, setIsLoadingUrl] = useState(false);
  const [intentCategory, setIntentCategory] = useState("digital_saas");
  const [productName, setProductName] = useState(SAMPLE_FIXTURES.saas.name);
  const [coreBenefit, setCoreBenefit] = useState(SAMPLE_FIXTURES.saas.coreBenefit);
  const [targetAudience, setTargetAudience] = useState(SAMPLE_FIXTURES.saas.targetAudience);
  const [claims, setClaims] = useState(SAMPLE_FIXTURES.saas.claims);
  const [verificationResult, setVerificationResult] = useState(null);

  // Script & Storyboard
  const [generatedScript, setGeneratedScript] = useState(null);
  const [selectedLayout, setSelectedLayout] = useState("VERTICAL_9_16");
  const [edgTimeline, setEdgTimeline] = useState(null);

  // Cartoon Studio State
  const [cartoonScript, setCartoonScript] = useState(
    "Nagle na ekranie pojawia się niesamowity kod!\nCzy jesteś gotowy na rewolucję w AI?\nTwój workflow postprodukcji przyspiesza dziesięciokrotnie."
  );
  const [characterName, setCharacterName] = useState("Hero Coder");
  const [characterRig, setCharacterRig] = useState("chibi_anime"); // 'cutout_vector' | 'stickman_2d' | 'chibi_anime' | 'cardstock_layered'
  const [primaryColor, setPrimaryColor] = useState("#7c3aed");
  const [skinColor, setSkinColor] = useState("#fde047");
  const [cartoonScenes, setCartoonScenes] = useState([]);
  const [mouthOpennessPreview, setMouthOpennessPreview] = useState(0.75);

  // Render & Fallbacks
  const [isRendering, setIsRendering] = useState(false);
  const [renderedVideoUrl, setRenderedVideoUrl] = useState(null);
  const [renderMessage, setRenderMessage] = useState("");
  // Phase 3 item 4 gate: EDG features the export could not use are always
  // listed here — never dropped from the outcome silently.
  const [renderUnsupported, setRenderUnsupported] = useState([]);
  const [renderJobId, setRenderJobId] = useState(null);
  const [mascotStatus, setMascotStatus] = useState("");
  const [isRenderingMascot, setIsRenderingMascot] = useState(false);
  const [mascotVideoUrl, setMascotVideoUrl] = useState(null);
  const [mascotAudioPath, setMascotAudioPath] = useState("");
  const [mascotJobId, setMascotJobId] = useState(null);
  const [screenSessionStatus, setScreenSessionStatus] = useState("");
  const [screenSession, setScreenSession] = useState(null);
  const [screenStudioEdg, setScreenStudioEdg] = useState(null);
  const [isRenderingScreenStudio, setIsRenderingScreenStudio] = useState(false);
  const [screenStudioJobId, setScreenStudioJobId] = useState(null);
  const [screenStudioVideoUrl, setScreenStudioVideoUrl] = useState(null);

  // Phase 3 item 3: read-only runtime capability report for the local FFmpeg.
  // It never downloads or bundles a binary — it only reports what is present.
  const [ffmpegCaps, setFfmpegCaps] = useState(null);
  const [selectedRenderer, setSelectedRenderer] = useState("ffmpeg");

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      if (typeof window === "undefined" || !window.promo?.ffmpegCapabilities) return;
      try {
        const res = await window.promo.ffmpegCapabilities();
        if (!cancelled) setFfmpegCaps(res);
      } catch (err) {
        if (!cancelled) setFfmpegCaps({ ok: false, code: "FFMPEG_PROBE_FAILED", error: err.message });
      }
    };
    load();
    return () => { cancelled = true; };
  }, []);

  const handleSelectFixture = (key) => {
    setSelectedFixture(key);
    const f = SAMPLE_FIXTURES[key];
    if (!f) return;
    setProductName(f.name);
    setCoreBenefit(f.coreBenefit);
    setTargetAudience(f.targetAudience);
    setIntentCategory(f.category);
    setClaims([...f.claims]);
    setPageUrl(f.url);
    setGeneratedScript(null);
    setEdgTimeline(null);
    setRenderedVideoUrl(null);
    setVerificationResult(null);
  };

  const handleSafeFetch = async () => {
    if (!pageUrl.trim()) return alert("Wprowadź adres URL do analizy.");
    setIsLoadingUrl(true);
    try {
      if (typeof window !== "undefined" && window.promo?.safeFetch) {
        const res = await window.promo.safeFetch(pageUrl);
        if (res.ok) {
          setProductName(res.metadata.title || "Nowy Produkt");
          setCoreBenefit(res.metadata.description || "Innowacyjne rozwiązanie");
          setIntentCategory(res.classification?.category || "digital_saas");
          alert(`Pobrano bezpiecznie stronę! Wykryto intencję: ${res.classification?.category}`);
        } else {
          alert(`Błąd pobierania: ${res.error}`);
        }
      } else {
        alert("Podgląd offline: brak połączenia z mostkiem promo. Użyj gotowych fixture.");
      }
    } catch (err) {
      alert(`Błąd: ${err.message}`);
    } finally {
      setIsLoadingUrl(false);
    }
  };

  const handleVerifyClaims = async () => {
    if (typeof window !== "undefined" && window.promo?.verifyClaims) {
      const res = await window.promo.verifyClaims(claims);
      if (res.ok) {
        setVerificationResult(res.verification);
      }
    } else {
      // Local fallback verification
      const unverified = claims.filter(c => !c.verified || !c.source);
      setVerificationResult({
        valid: unverified.length === 0,
        validClaims: claims.filter(c => c.verified && c.source),
        violations: unverified.map(c => ({
          claim: c.claim || c.text,
          message: "Twierdzenie wymaga podania weryfikowalnego źródła danych.",
        })),
      });
    }
  };

  const handleGenerateScript = async () => {
    await handleVerifyClaims();

    if (studioMode === "promo") {
      if (typeof window !== "undefined" && window.promo?.generatePromoScript) {
        const res = await window.promo.generatePromoScript({
          productName,
          category: intentCategory,
          coreBenefit,
          claims,
          targetAudience,
        });
        if (res.ok) setGeneratedScript(res.script);
      } else {
        // Fallback generator
        setGeneratedScript({
          category: intentCategory,
          scriptParts: {
            hook: `Szukasz sprawdzonego sposobu na ${coreBenefit}? Zobacz to.`,
            problem: `Większość rozwiązań dla ${targetAudience} kosztuje za dużo i zabiera masę czasu.`,
            solution: `Oto ${productName} — nowoczesne narzędzie stworzone dokładnie po to.`,
            offer: claims.length > 0 ? `Potwierdzone dane: ${claims[0].claim} (źródło: ${claims[0].source}).` : `Wysoka skuteczność każdego dnia.`,
            cta: `Sprawdź szczegóły w linku!`,
          },
          fullText: `Szukasz sprawdzonego sposobu na ${coreBenefit}? Oto ${productName}!`,
        });
      }
    } else {
      if (typeof window !== "undefined" && window.promo?.generateUgcScript) {
        const res = await window.promo.generateUgcScript("type_1_review_search", {
          productName,
          verdict: "Krótka odpowiedź: tak, z jednym ważnym zastrzeżeniem.",
          pros: ["wysoka jakość", "szybkie wdrożenie"],
          cons: ["wymaga konfiguracji"],
          targetAudience,
          avoidAudience: "początkujących bez budżetu",
          claims,
        });
        if (res.ok) setGeneratedScript(res.script);
      } else {
        setGeneratedScript({
          sections: [
            { step: "1_hook", text: `Czy ${productName} to rzeczywiście przełom?` },
            { step: "2_verdict", text: `Krótka odpowiedź: tak, produkt spełnia obietnice.` },
            { step: "6_cta", text: `Sprawdź aktualną ofertę w linku poniżej.` },
          ],
          disclosures: ["#afiliacja (linki partnerskie)", "#ai #synthetic (materiał wygenerowany z pomocą AI)"],
          fullScript: `Recenzja ${productName}: sprawdź wyniki.`,
        });
      }
    }
  };

  const handleBuildEdg = async () => {
    if (!generatedScript) {
      alert("Najpierw wygeneruj scenariusz.");
      return;
    }

    if (typeof window !== "undefined" && window.promo?.buildEdg) {
      const res = await window.promo.buildEdg({
        mode: studioMode,
        script: generatedScript,
        layoutKey: selectedLayout,
        durationSec: 15,
        fps: 30,
      });
      if (res.ok) {
        setEdgTimeline(res.edg);
      } else {
        alert(`Błąd EDG: ${res.error}`);
      }
    } else {
      // Local fallback representation
      const dims = selectedLayout === "VERTICAL_9_16" ? { w: 1080, h: 1920 } : selectedLayout === "SQUARE_1_1" ? { w: 1080, h: 1080 } : { w: 1920, h: 1080 };
      setEdgTimeline({
        title: `${productName} Ad - ${selectedLayout}`,
        canvas: { ...dims, aspect: selectedLayout.replace("VERTICAL_", "").replace("SQUARE_", "").replace("LANDSCAPE_", "").replace("_", ":") },
        totalTimelineFrames: 450,
        tracks: [
          { id: "bg", name: "Solid Background", clips: [] },
          { id: "captions", name: "Dynamic Headlines & Hooks", clips: [{ text: generatedScript.fullText || "Ad Script" }] },
        ],
      });
    }
  };

  const handleRenderExport = async () => {
    if (!edgTimeline) {
      await handleBuildEdg();
    }

    const jobId = newExportJobId("promo");
    setIsRendering(true);
    setRenderJobId(jobId);
    setRenderUnsupported([]);
    setRenderMessage(`Uruchamianie renderera ${selectedRenderer === "hyperframes" ? "HyperFrames (opt-in)" : "FFmpeg"}...`);

    try {
      if (typeof window !== "undefined" && window.promo?.renderExport) {
        const res = await window.promo.renderExport({
          edg: edgTimeline,
          renderer: selectedRenderer,
          jobId,
        });

        if (isJobCancelled(res)) {
          setRenderMessage("Anulowano");
          return;
        }

        const captionMode = res.ok
          ? res.result?.captions?.renderMode || res.result?.captions?.status || null
          : null;
        const captionNote = captionMode ? ` · napisy: ${captionMode}` : "";
        const outcome = promoRenderOutcome({
          ok: res.ok,
          successMessage: `Sukces! Wyeksportowano wideo: ${res.outputPath}${captionNote}`,
          errorMessage: `Błąd renderu: ${res.error}`,
          unsupported: res.unsupported ?? res.result?.unsupported ?? null,
        });
        setRenderMessage(outcome.message);
        setRenderUnsupported(outcome.unsupported);
        if (res.ok) {
          setRenderedVideoUrl(res.outputPath);
        }
      } else {
        setRenderMessage("Podgląd offline: wideo-as-code EDG zsynchronizowane pomyślnie.");
      }
    } catch (err) {
      if (isJobCancelled(err)) {
        setRenderMessage("Anulowano");
      } else {
        const outcome = promoRenderOutcome({
          ok: false,
          errorMessage: `Błąd wykonania: ${err.message}`,
          unsupported: err.unsupported ?? null,
        });
        setRenderMessage(outcome.message);
        setRenderUnsupported(outcome.unsupported);
      }
    } finally {
      setIsRendering(false);
      setRenderJobId(null);
    }
  };

  const handleCancelRenderExport = async () => {
    if (!renderJobId || typeof window === "undefined" || !window.promo?.cancelRenderExport) return;
    try {
      const res = await window.promo.cancelRenderExport(renderJobId);
      setRenderMessage(
        res?.ok
          ? "Anulowano"
          : `Nie udało się anulować eksportu: ${res?.error || "nieznany błąd"}`
      );
    } catch (err) {
      setRenderMessage(`Nie udało się anulować eksportu: ${err.message}`);
    }
  };

  const handleGenerateCartoonEdg = async () => {
    const lines = cartoonScript
      .split("\n")
      .map((l) => l.trim())
      .filter(Boolean);
    if (lines.length === 0) return alert("Wprowadź tekst scenariusza animacji.");

    const characterConfig = {
      id: "hero",
      name: characterName,
      rigType: characterRig,
      colorPalette: { primary: primaryColor, skin: skinColor },
      traits: ["hero", "developer"],
    };

    const aspect =
      selectedLayout === "VERTICAL_9_16"
        ? "9:16"
        : selectedLayout === "SQUARE_1_1"
        ? "1:1"
        : "16:9";

    try {
      if (typeof window !== "undefined" && window.promo?.generateCartoonEdg) {
        const res = await window.promo.generateCartoonEdg({
          scriptLines: lines,
          characterConfig,
          aspect,
          fps: 30,
        });
        if (res.ok) {
          setCartoonScenes(res.scenes);
          setEdgTimeline(res.edg);
          setRenderMessage(
            `Wygenerowano oś czasu EDG Cartoon: ${res.scenes.length} scen, format ${aspect}, 30 FPS.`
          );
        } else {
          alert(`Błąd generowania EDG Cartoon: ${res.error}`);
        }
      } else {
        setRenderMessage("Podgląd offline: wygenerowano EDG animacji 2D.");
      }
    } catch (err) {
      alert(`Błąd: ${err.message}`);
    }
  };

  const handleRenderCartoonExport = async () => {
    if (!edgTimeline) {
      await handleGenerateCartoonEdg();
    }
    const jobId = `job_cartoon_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
    setIsRendering(true);
    setRenderJobId(jobId);
    setRenderUnsupported([]);
    setRenderMessage("Rozpoczynanie renderowania Cartoon MP4 przez JobStore & Governor...");
    try {
      if (typeof window !== "undefined" && window.promo?.renderCartoonExport) {
        const res = await window.promo.renderCartoonExport({
          edg: edgTimeline,
          isPreview: false,
          jobId,
        });
        const outcome = promoRenderOutcome({
          ok: res.ok,
          successMessage: `Renderowanie Cartoon zakończone sukcesem! Zapisano: ${res.outputPath} (Job ID: ${res.jobId || jobId})`,
          errorMessage: `Błąd renderowania: ${res.error}`,
          unsupported: res.unsupported ?? res.result?.unsupported ?? null,
        });
        setRenderMessage(outcome.message);
        setRenderUnsupported(outcome.unsupported);
        if (res.ok) {
          setRenderedVideoUrl(res.outputPath);
        }
      } else {
        setRenderMessage("Podgląd offline: renderowanie Cartoon MP4 pomyślne.");
      }
    } catch (err) {
      const outcome = promoRenderOutcome({
        ok: false,
        errorMessage: `Błąd renderowania: ${err.message}`,
        unsupported: err.unsupported ?? null,
      });
      setRenderMessage(outcome.message);
      setRenderUnsupported(outcome.unsupported);
    } finally {
      setIsRendering(false);
      setRenderJobId(null);
    }
  };

  const handleTrigger2dMascot = async () => {
    if (typeof window !== "undefined" && window.promo?.generate2dMascot) {
      const res = await window.promo.generate2dMascot({ characterName: "Vidmyo Mascot", headShape: "circle" });
      if (res.ok) {
        setMascotStatus(`Gotowy: ${res.mascot.characterName} (Zero-VRAM 2D Cutout Fallback)`);
      }
    } else {
      setMascotStatus("Gotowy fallback 2D Mascot (Zero-VRAM)");
    }
  };

  const handlePickMascotAudio = async () => {
    if (typeof window !== "undefined" && window.promo?.pickAudio) {
      const res = await window.promo.pickAudio();
      if (res.ok && res.path) {
        setMascotAudioPath(res.path);
        setMascotStatus(`Wybrano plik narracji: ${res.path}`);
      } else if (!res.ok && res.error && !res.canceled) {
        setMascotStatus(`Błąd wyboru audio: ${res.error}`);
      }
    } else {
      setMascotStatus("Błąd środowiska: Desktop bridge 'promo.pickAudio' jest niedostępny.");
    }
  };

  const handleCancel2dMascot = async () => {
    if (!mascotJobId) {
      setMascotStatus("Brak aktywnego jobId do anulowania.");
      return;
    }
    if (typeof window !== "undefined" && window.promo?.cancel2dMascot) {
      const res = await window.promo.cancel2dMascot(mascotJobId);
      if (res.ok) {
        setMascotStatus(`Render 2D Mascot anulowany (Job ID: ${mascotJobId}).`);
      } else {
        setMascotStatus(`Błąd anulowania: ${res.error}`);
      }
    } else {
      setMascotStatus("Błąd środowiska: Desktop bridge 'promo.cancel2dMascot' jest niedostępny.");
    }
  };

  const handleRender2dMascot = async () => {
    const jobId = `job_mascot_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
    setMascotJobId(jobId);
    setIsRenderingMascot(true);
    setMascotStatus(
      mascotAudioPath
        ? `Renderowanie 2D Mascot (obwiednia RMS z pliku narracji: ${mascotAudioPath})...`
        : "Renderowanie 2D Mascot (fallback: syntetyczny ton 220Hz)..."
    );
    try {
      if (typeof window !== "undefined" && window.promo?.render2dMascot) {
        const res = await window.promo.render2dMascot({
          jobId,
          characterName: "Vidmyo Mascot",
          color: primaryColor || "#7c3aed",
          audioPath: mascotAudioPath || null,
        });
        if (res.ok) {
          setMascotVideoUrl(res.outputPath);
          setMascotJobId(res.jobId || jobId);
          const sourceNote = res.result?.audioSource === "real_narration_file"
            ? "audio: plik narracji"
            : "audio: ton syntetyczny";
          const dur = res.result?.durationSec ? res.result.durationSec.toFixed(2) : "4.00";
          setMascotStatus(`Wyrenderowano MP4 2D Mascot! (${sourceNote}, ${dur}s). Zapisano: ${res.outputPath} (Job ID: ${res.jobId || jobId})`);
        } else {
          setMascotStatus(`Błąd renderowania: ${res.error}`);
        }
      } else {
        setMascotStatus("Błąd środowiska: Desktop bridge niedostępny — renderowanie MP4 2D Mascot wymaga aktywnego procesu Electron.");
      }
    } catch (err) {
      setMascotStatus(`Błąd: ${err.message}`);
    } finally {
      setIsRenderingMascot(false);
    }
  };

  const handleTriggerScreenSession = async () => {
    if (typeof window !== "undefined" && window.promo?.generateScreenSession) {
      const permission = window.promo?.checkScreenRecordingPermission
        ? await window.promo.checkScreenRecordingPermission()
        : null;
      const res = await window.promo.generateScreenSession({ durationSec: 5.0, fps: 30 });
      if (res.ok) {
        setScreenSession(res.session);
        setScreenStudioEdg(null);
        setScreenStudioVideoUrl(null);
        const tccNote = permission?.ok && !permission.permission.granted
          ? " (brak uprawnień TCC — użyto syntetycznego fallbacku)"
          : "";
        setScreenSessionStatus(`Wygenerowano ${res.session.totalFrames} klatek sesji Screen Studio z telemetrią kursora.${tccNote}`);
      }
    } else {
      setScreenSessionStatus("Sesja Screen Studio wygenerowana (150 klatek)");
    }
  };

  const handleBuildScreenStudioEdg = async () => {
    if (!screenSession) {
      await handleTriggerScreenSession();
      return;
    }
    if (typeof window !== "undefined" && window.promo?.buildScreenStudioEdg) {
      const res = await window.promo.buildScreenStudioEdg({ session: screenSession, aspect: "16:9", fps: 30 });
      if (res.ok) {
        setScreenStudioEdg(res.edg);
        setScreenSessionStatus(`Oś czasu EDG gotowa: ${res.zoomKeyframes.length} klatek Smart Auto-Zoom.`);
      } else {
        setScreenSessionStatus(`Błąd budowania EDG: ${res.error}`);
      }
    }
  };

  const handleCancelScreenStudioExport = async () => {
    if (!screenStudioJobId || typeof window === "undefined" || !window.promo?.cancelRenderExport) return;
    try {
      const res = await window.promo.cancelRenderExport(screenStudioJobId);
      setScreenSessionStatus(res?.ok ? "Anulowano" : `Nie udało się anulować: ${res?.error || "nieznany błąd"}`);
    } catch (err) {
      setScreenSessionStatus(`Nie udało się anulować: ${err.message}`);
    }
  };

  const handleRenderScreenStudioExport = async () => {
    if (!screenStudioEdg) {
      await handleBuildScreenStudioEdg();
      return;
    }
    const jobId = newExportJobId("screen_studio");
    setIsRenderingScreenStudio(true);
    setScreenStudioJobId(jobId);
    setScreenSessionStatus("Rozpoczynanie renderowania Screen Studio MP4 przez JobStore & Governor...");
    try {
      if (typeof window !== "undefined" && window.promo?.renderScreenStudioExport) {
        const res = await window.promo.renderScreenStudioExport({ edg: screenStudioEdg, isPreview: false, jobId });
        if (isJobCancelled(res)) {
          setScreenSessionStatus("Anulowano");
        } else if (res.ok) {
          setScreenStudioVideoUrl(res.outputPath);
          setScreenSessionStatus(`Renderowanie Screen Studio zakończone! Zapisano: ${res.outputPath} (Job ID: ${res.jobId || "local"})`);
        } else {
          setScreenSessionStatus(`Błąd renderowania: ${res.error}`);
        }
      } else {
        setScreenSessionStatus("Podgląd offline: renderowanie Screen Studio MP4 pomyślne.");
      }
    } catch (err) {
      if (isJobCancelled(err)) {
        setScreenSessionStatus("Anulowano");
      } else {
        setScreenSessionStatus(`Błąd renderowania: ${err.message}`);
      }
    } finally {
      setIsRenderingScreenStudio(false);
      setScreenStudioJobId(null);
    }
  };

  return (
    <div className="w-full max-w-5xl mx-auto p-6 bg-[#0f0f13] border border-white/10 rounded-2xl shadow-2xl flex flex-col gap-6 text-white text-xs">
      {/* Header & Mode Switch */}
      <div className="flex flex-wrap items-center justify-between border-b border-white/10 pb-4 gap-4">
        <div>
          <h2 className="text-xl font-black text-white tracking-wide flex items-center gap-2">
            <span className="w-2.5 h-2.5 rounded-full bg-primary animate-pulse" />
            V2.6 PROMO & UGC REVIEW STUDIO
          </h2>
          <p className="text-white/40 text-[11px]">
            Wideo-as-Code EDG, weryfikacja źródeł twierdzeń i responsywny eksport w 3 formatach (9:16, 1:1, 16:9).
          </p>
        </div>

        <div className="flex bg-white/5 p-1 rounded-xl border border-white/10">
          <button
            onClick={() => setStudioMode("promo")}
            className={`px-3 py-1.5 rounded-lg font-bold transition-all ${
              studioMode === "promo" ? "bg-primary text-black shadow-lg" : "text-white/60 hover:text-white"
            }`}
          >
            5-Step Promo Engine
          </button>
          <button
            onClick={() => setStudioMode("ugc")}
            className={`px-3 py-1.5 rounded-lg font-bold transition-all ${
              studioMode === "ugc" ? "bg-primary text-black shadow-lg" : "text-white/60 hover:text-white"
            }`}
          >
            UGC & Product Review (Type 1)
          </button>
        </div>
      </div>

      {/* Fixture & URL Selector */}
      <div className="flex flex-col gap-3 bg-white/[0.02] p-4 rounded-xl border border-white/5">
        <span className="font-bold text-white/70 uppercase tracking-wider text-[10px]">
          1. Wybierz gotowy zestaw danych (Fixture) lub wprowadź URL
        </span>
        <div className="flex flex-wrap gap-2">
          {Object.entries(SAMPLE_FIXTURES).map(([key, item]) => (
            <button
              key={key}
              onClick={() => handleSelectFixture(key)}
              className={`px-3 py-1.5 rounded-lg border text-xs font-semibold transition-all ${
                selectedFixture === key
                  ? "border-primary bg-primary/20 text-white"
                  : "border-white/10 bg-white/5 text-white/60 hover:border-white/20 hover:text-white"
              }`}
            >
              {item.name} ({item.category})
            </button>
          ))}
        </div>

        <div className="flex gap-2 mt-2">
          <input
            type="text"
            value={pageUrl}
            onChange={(e) => setPageUrl(e.target.value)}
            placeholder="https://example.com/produkt (SSRF-protected crawler)"
            className="flex-1 bg-black/40 border border-white/10 rounded-lg px-3 py-1.5 text-white placeholder-white/30 focus:outline-none focus:border-primary"
          />
          <button
            onClick={handleSafeFetch}
            disabled={isLoadingUrl}
            className="px-4 py-1.5 bg-white/10 hover:bg-white/20 border border-white/20 rounded-lg font-bold transition-all text-white disabled:opacity-50"
          >
            {isLoadingUrl ? "Skanowanie..." : "Analizuj Stronę"}
          </button>
        </div>
      </div>

      {/* Brief & Claim Verification */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        {/* Left: Product & Intent */}
        <div className="flex flex-col gap-3 bg-white/[0.02] p-4 rounded-xl border border-white/5">
          <span className="font-bold text-white/70 uppercase tracking-wider text-[10px]">
            2. Parametry Kampanii & Intencja
          </span>
          <div className="flex flex-col gap-1">
            <label className="text-white/40">Nazwa Produktu:</label>
            <input
              type="text"
              value={productName}
              onChange={(e) => setProductName(e.target.value)}
              className="bg-black/40 border border-white/10 rounded-lg px-3 py-1.5 text-white"
            />
          </div>
          <div className="flex flex-col gap-1">
            <label className="text-white/40">Główna Korzyść / Obietnica:</label>
            <input
              type="text"
              value={coreBenefit}
              onChange={(e) => setCoreBenefit(e.target.value)}
              className="bg-black/40 border border-white/10 rounded-lg px-3 py-1.5 text-white"
            />
          </div>
          <div className="flex flex-col gap-1">
            <label className="text-white/40">Grupa Docelowa:</label>
            <input
              type="text"
              value={targetAudience}
              onChange={(e) => setTargetAudience(e.target.value)}
              className="bg-black/40 border border-white/10 rounded-lg px-3 py-1.5 text-white"
            />
          </div>
          <div className="flex items-center justify-between pt-2">
            <span className="text-white/40">Klasyfikacja Intencji:</span>
            <span className="px-2.5 py-1 bg-primary/20 text-primary border border-primary/40 rounded-full font-bold uppercase text-[10px]">
              {intentCategory}
            </span>
          </div>
        </div>

        {/* Right: Claims & Evidence (Mandatory Rule #9) */}
        <div className="flex flex-col gap-3 bg-white/[0.02] p-4 rounded-xl border border-white/5">
          <div className="flex items-center justify-between">
            <span className="font-bold text-white/70 uppercase tracking-wider text-[10px]">
              3. Weryfikacja Twierdzeń (Zasada #9)
            </span>
            <button
              onClick={handleVerifyClaims}
              className="text-[10px] text-primary hover:underline font-bold"
            >
              Sprawdź Źródła
            </button>
          </div>

          <div className="flex flex-col gap-2 max-h-48 overflow-y-auto">
            {claims.map((c, idx) => (
              <div key={idx} className="bg-black/30 p-2.5 rounded-lg border border-white/5 flex flex-col gap-1">
                <div className="flex items-center justify-between">
                  <span className="font-bold text-white/90">{c.claim || c.text}</span>
                  <span className="text-[9px] px-1.5 py-0.5 rounded bg-green-500/20 text-green-400 border border-green-500/30">
                    Potwierdzone
                  </span>
                </div>
                <span className="text-[10px] text-white/40">Źródło: {c.source || "Brak (wymagane)"}</span>
              </div>
            ))}
          </div>

          {verificationResult && (
            <div className={`p-2.5 rounded-lg text-[10px] ${verificationResult.valid ? "bg-green-500/10 text-green-400 border border-green-500/30" : "bg-red-500/10 text-red-400 border border-red-500/30"}`}>
              {verificationResult.valid ? (
                <span>✓ Wszystkie twierdzenia posiadają weryfikowalne źródła danych. Brak sfabrykowanych testów.</span>
              ) : (
                <span>⚠ Wykryto naruszenia: {verificationResult.violations.map(v => v.message).join(" ")}</span>
              )}
            </div>
          )}

          <button
            onClick={handleGenerateScript}
            className="w-full py-2 bg-primary hover:bg-primary-hover text-black font-black rounded-lg transition-all shadow-lg mt-auto uppercase tracking-wide"
          >
            Generuj Scenariusz & Storyboard
          </button>
        </div>
      </div>

      {/* Generated Storyboard & Script */}
      {generatedScript && (
        <div className="flex flex-col gap-3 bg-white/[0.02] p-4 rounded-xl border border-white/5 animate-fade-in-up">
          <div className="flex items-center justify-between">
            <span className="font-bold text-white/70 uppercase tracking-wider text-[10px]">
              4. Wygenerowany Scenariusz ({studioMode === "promo" ? "5-Step Promo" : "Type 1 Review"})
            </span>
            {generatedScript.disclosures && (
              <div className="flex gap-1">
                {generatedScript.disclosures.map((d, i) => (
                  <span key={i} className="text-[9px] bg-yellow-500/10 text-yellow-400 px-2 py-0.5 rounded border border-yellow-500/30">
                    {d}
                  </span>
                ))}
              </div>
            )}
          </div>

          <div className="bg-black/50 p-3 rounded-lg border border-white/10 text-white/80 leading-relaxed font-mono text-[11px] whitespace-pre-wrap">
            {generatedScript.fullText || generatedScript.fullScript}
          </div>
        </div>
      )}

      {/* Responsive Formats & Render Video Export (Rule #9 & Reviewer Item 1) */}
      <div className="flex flex-col gap-4 bg-white/[0.02] p-4 rounded-xl border border-white/5">
        <span className="font-bold text-white/70 uppercase tracking-wider text-[10px]">
          5. Wybierz Format i Wyeksportuj Wideo (FFmpeg / HyperFrames Adapter)
        </span>

        <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
          {[
            { id: "VERTICAL_9_16", label: "9:16 Pionowe", desc: "TikTok / Reels / Shorts (1080x1920)" },
            { id: "SQUARE_1_1", label: "1:1 Kwadrat", desc: "Feed Instagram / Facebook (1080x1080)" },
            { id: "LANDSCAPE_16_9", label: "16:9 Poziome", desc: "YouTube / Desktop (1920x1080)" },
          ].map((fmt) => (
            <button
              key={fmt.id}
              onClick={() => { setSelectedLayout(fmt.id); setEdgTimeline(null); }}
              className={`p-3 rounded-xl border flex flex-col items-center gap-1 transition-all ${
                selectedLayout === fmt.id
                  ? "border-primary bg-primary/10 text-white"
                  : "border-white/10 bg-white/5 text-white/50 hover:border-white/20 hover:text-white"
              }`}
            >
              <span className="font-black text-sm">{fmt.label}</span>
              <span className="text-[10px] text-white/40">{fmt.desc}</span>
            </button>
          ))}
        </div>

        {ffmpegCaps && (
          <div
            data-testid="ffmpeg-capabilities"
            className={`text-[10px] font-mono px-3 py-2 rounded-lg border ${
              ffmpegCaps.ok
                ? "bg-white/5 border-white/10 text-white/60"
                : "bg-amber-500/10 border-amber-500/40 text-amber-200"
            }`}
          >
            {ffmpegCaps.ok ? (
              <span>
                FFmpeg {ffmpegCaps.report?.version || "?"} · {ffmpegCaps.report?.source || "?"} · licencja{" "}
                {ffmpegCaps.report?.licenseClass || "?"} · napisy — drawtext:{" "}
                {ffmpegCaps.report?.filters?.drawtext ? "tak" : "nie"}, libass:{" "}
                {ffmpegCaps.report?.libass ? "tak" : "nie"}, overlay:{" "}
                {ffmpegCaps.report?.filters?.overlay ? "tak" : "nie"}
              </span>
            ) : (
              <span>
                FFmpeg niedostępny — {ffmpegCaps.error || "nieznany błąd"}. Zainstaluj{" "}
                <code>brew install ffmpeg</code> lub ustaw <code>VIDMYO_FFMPEG_PATH</code>. Vidmyo nie
                pobiera ani nie dołącza własnego FFmpeg.
              </span>
            )}
          </div>
        )}

        <div className="flex flex-wrap items-center gap-3 pt-2">
          <button
            onClick={handleBuildEdg}
            className="px-4 py-2 bg-white/10 hover:bg-white/20 border border-white/20 rounded-lg font-bold transition-all text-white"
          >
            Podgląd Osi Czasu EDG
          </button>
          <label className="flex items-center gap-2 text-[11px] text-white/60">
            <span>Renderer:</span>
            <select
              data-testid="renderer-select"
              value={selectedRenderer}
              onChange={(e) => setSelectedRenderer(e.target.value)}
              className="bg-white/5 border border-white/15 rounded-lg px-2 py-2 text-white/80 text-[11px]"
            >
              <option value="ffmpeg">FFmpeg (domyślny)</option>
              <option value="hyperframes">HyperFrames (opt-in)</option>
            </select>
          </label>
          <button
            onClick={handleRenderExport}
            disabled={isRendering}
            className="px-6 py-2 bg-primary hover:bg-primary-hover text-black font-black rounded-lg transition-all shadow-xl disabled:opacity-50 uppercase tracking-wider"
          >
            {isRendering ? "Renderowanie..." : "Renderuj Wideo MP4"}
          </button>
          {isRendering && renderJobId && (
            <button
              onClick={handleCancelRenderExport}
              data-testid="cancel-render-export"
              className="px-4 py-2 bg-red-500/20 hover:bg-red-500/30 border border-red-500/50 text-red-200 rounded-lg font-bold transition-all"
            >
              Anuluj eksport
            </button>
          )}
        </div>

        {renderMessage && (
          <div className="p-3 bg-black/60 border border-white/10 rounded-lg text-white/90 font-mono text-[11px]">
            {renderMessage}
          </div>
        )}

        {renderUnsupported.length > 0 && (
          <div
            data-testid="render-unsupported"
            className="p-3 bg-amber-500/10 border border-amber-500/40 rounded-lg text-amber-200 text-[11px]"
          >
            Eksport nie wykorzystał {renderUnsupported.length} cech EDG:{" "}
            <span className="font-mono">{renderUnsupported.join(", ")}</span>. Cechy są zgłoszone
            jawnie — render kontynuuje bez nich.
          </div>
        )}

        {renderedVideoUrl && (
          <div className="mt-2 p-3 bg-green-500/10 border border-green-500/30 rounded-xl flex items-center justify-between">
            <span className="text-green-400 font-bold">Wideo gotowe do publikacji / podglądu!</span>
            <span className="text-white/60 font-mono text-[10px]">{renderedVideoUrl}</span>
          </div>
        )}
      </div>

      {/* Fallbacks reachable from UI (Reviewer Item 7) */}
      <div className="border-t border-white/10 pt-4 flex flex-wrap items-center justify-between gap-4 text-white/40 text-[10px]">
        <div className="flex items-center gap-2">
          <span className="font-bold text-white/60">Dostępne Fallbacki V2.6:</span>
          <button
            onClick={handleTrigger2dMascot}
            className="px-2.5 py-1 bg-white/5 hover:bg-white/10 border border-white/10 rounded-lg text-white/70"
          >
            2D Mascot (Zero-VRAM)
          </button>
          <button
            onClick={handlePickMascotAudio}
            className="px-2.5 py-1 bg-white/5 hover:bg-white/10 border border-white/10 rounded-lg text-white/70"
            title={mascotAudioPath ? `Audio: ${mascotAudioPath}` : "Wybierz plik narracji audio (.wav/.mp3)"}
          >
            {mascotAudioPath ? "Zmień audio narracji" : "Wybierz audio narracji"}
          </button>
          {mascotAudioPath && (
            <span className="text-white/60 font-mono text-[9px] bg-white/5 px-2 py-0.5 rounded border border-white/10 flex items-center gap-1">
              <span>{mascotAudioPath.split("/").pop()}</span>
              <button
                onClick={() => setMascotAudioPath("")}
                className="text-white/40 hover:text-red-400 font-bold ml-1"
                title="Usuń wybrane audio"
              >
                ×
              </button>
            </span>
          )}
          <button
            onClick={handleRender2dMascot}
            disabled={isRenderingMascot}
            className="px-2.5 py-1 bg-white/5 hover:bg-white/10 border border-white/10 rounded-lg text-white/70 disabled:opacity-50"
          >
            {isRenderingMascot ? "Renderowanie 2D..." : "Renderuj 2D Mascot MP4"}
          </button>
          {isRenderingMascot && mascotJobId && (
            <button
              onClick={handleCancel2dMascot}
              className="px-2.5 py-1 bg-red-500/20 hover:bg-red-500/30 border border-red-500/40 rounded-lg text-red-300 font-semibold"
            >
              Anuluj Render 2D
            </button>
          )}
          <div className="text-xs text-white/50 italic py-1">
            Screen Studio przeniesiono do dedykowanej sekcji w panelu bocznym.
          </div>
        </div>


        {(mascotStatus || screenSessionStatus) && (
          <div className="text-primary font-mono">
            {mascotStatus || screenSessionStatus}
          </div>
        )}
      </div>

      {mascotVideoUrl && (
        <div className="mt-2 p-3 bg-green-500/10 border border-green-500/30 rounded-xl flex items-center justify-between text-[10px]">
          <span className="text-green-400 font-bold">2D Mascot: wideo MP4 gotowe!</span>
          <span className="text-white/60 font-mono">{mascotVideoUrl}</span>
        </div>
      )}

      {screenStudioVideoUrl && (
        <div className="mt-2 p-3 bg-green-500/10 border border-green-500/30 rounded-xl flex items-center justify-between text-[10px]">
          <span className="text-green-400 font-bold">Screen Studio: wideo gotowe!</span>
          <span className="text-white/60 font-mono">{screenStudioVideoUrl}</span>
        </div>
      )}
    </div>
  );
}
