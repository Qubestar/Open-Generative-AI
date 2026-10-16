# Vidmyo V2.6 — Szczegółowa Inwentaryzacja i Dowody w Kodzie

Data audytu: 2026-09-24 (Rewizja po zrealizowaniu uwag recenzenta Fazy 1)  
Środowisko: macOS arm64 (Darwin 25.5.0), Node.js v25.4.0, Homebrew FFmpeg 8.1.1, Electron + Next.js  
Aktywna powierzchnia UI: `components/StandaloneShell.js`, `packages/studio/src/components/CleanerStudio.jsx`, `packages/studio/src/components/CleanerReview.jsx`, `packages/studio/src/components/AutoEditorPanel.jsx`, `packages/studio/src/components/MarketingStudio.jsx`, `packages/studio/src/components/PromoReviewStudio.jsx`, `packages/studio/src/components/PublisherQueuePanel.jsx`.

---

## 1. Fundament Architektury (Zegar, EDG, Governor, Renderer)

### 1.1 Zegar Klatkowy & Oś Czasu (P1)
- **Status:** `implemented-awaiting-verification`
- **Plik źródłowy:** `packages/core/src/timebase.js`
- **Dowody w kodzie:**
  - `parseFps(fps)`: obsługa liczb i obiektów wymiernych (`{ num: 30, den: 1 }`, `{ num: 30000, den: 1001 }`).
  - `secondsToFrame(seconds, fps)` / `frameToSeconds(frame, fps)`: konwersja klatkowa bez strat dokładności.
  - `calculateAbsoluteBoundaries(segments, fps)`: konwersja absolutnych granic zapobiegająca kumulacji zaokrągleń (zero drift).
  - `audioSamplesToFrames(samples, sampleRate, fps)` / `framesToAudioSamples(frames, fps, sampleRate)`: synchronizacja próbek 48 kHz.
  - `verifyTimelineDrift(durationSec, cutsCount, fps)`: test syntetyczny 30 minut z wynikiem 0 klatek dryfu na końcu osi czasu.
  - Deterministyczny 30-minutowy test VFR (`timebase.test.js`): zsynchronizowane błyski wideo i beepy audio co 1s; asercja VFR (`uniqueIntervals.size > 1`); eksport przez Vidmyo `RendererAdapter` do 30 i 60 fps. Weryfikacja VFR fixtury i długości strumieni odbywa się przez ffprobe PTS pakietów. Onsety punktów kontrolnych (początek: 2s, środek: 900s, koniec: 1798s) mierzone są filtrem `showinfo` (skok luminancji > 100 dla błysku wideo) oraz `silencedetect`/`astats` (koniec ciszy dla beepa audio), z błędem A/V `<= 1` klatka (`<= 1.0 / targetFps`, bez dodatkowej tolerancji).
- **Plik testu:** `packages/core/test/timebase.test.js` (7 testów).

### 1.2 Editing Decision Graph — EDG v1.0.0 (P1)
- **Status:** `implemented-awaiting-verification`
- **Plik źródłowy:** `packages/core/src/edg.js`
- **Dowody w kodzie:**
  - `validateEdg(edg)`: walidacja schematu, wersji, proporcji ekranu (16:9, 9:16, 1:1), ścieżek, unikalności hashów zasobów SHA-256 oraz braku nakładania się klipów na jednej ścieżce.
  - `createEmptyEdg({ aspect, fps, sampleRate })` / `createEdgTimeline(options)`: inicjalizacja standardowego EDG z obsługą custom canvas (np. 64x36).
  - `sanitizeAiEdgSuggestion(raw, edg)`: bramka bezpieczeństwa odrzucająca próby wstrzykiwania kodu (`eval`, `script`, `process`) oraz ograniczająca operacje AI do dozwolonego zbioru EDG.
- **Plik testu:** `packages/core/test/edg.test.js` (4 testy).

### 1.3 Multi-process Resource Governor & JobStore (P2)
- **Status:** `implemented-awaiting-verification`
- **Pliki źródłowe:** `packages/core/src/governor.js`, `packages/core/src/jobs.js`
- **Dowody w kodzie:**
  - `withLock(fn)`: wyłączna blokada międzyprocesowa z wykorzystaniem atomowego katalogu `governor.lock`, zapobiegająca wyścigom (race conditions) między wieloma instancjami Electron/CLI/MCP.
  - `acquire({ jobId, resourceClass, parentReservationToken, pid })`: limit 1 ciężkiej operacji na raz (`heavyLimit = 1`), sprawdzanie wolnego miejsca na dysku (`checkDiskSpace`), dziedziczenie tokenu przez podzadania.
  - Anulowanie drzewa procesów: POSIX `process.kill(-pid)` oraz Windows `taskkill /pid <pid> /T /F` weryfikowane przed zwolnieniem slotu.
  - `recoverInterruptedJobs()`: wykrywanie i oznaczanie osieroconych procesów po restarcie aplikacji (`interrupted`).
  - Integracja w `JobStore`: `jobStore.admit(jobId)`, automatyczne zwalnianie dzierżawy w `setState('done'|'error'|'cancelled')` oraz w `cancel(id)`.
  - **Ograniczenie weryfikacji:** Pełny test współbieżności 3 osobnych powierzchni (Electron, CLI, MCP) w oddzielnych procesach OS został odłożony do późniejszej fazy.
- **Pliki testów:** `packages/core/test/governor.test.js`, `packages/core/test/jobs.test.js`.

### 1.4 Renderer Adapter & Realny Eksport (P3)
- **Status:** `partial`
- **Plik źródłowy:** `packages/core/src/rendererAdapter.js`
- **Dowody w kodzie:**
  - `resolveFfmpegBinary(customPath)` / `resolveFfprobeBinary(customPath)`: zarządzany resolver z metadanymi `MANAGED_FFMPEG_PACKAGES` (v6.1.1, GPL-3.0).
  - `buildFfmpegArguments(edg, outputPath, opts)`: generowanie filtergraphu i flag FFmpeg dla formatów 16:9, 9:16 i 1:1, obsługa generatora lavfi `color=c=black`, zabezpieczenie tekstu `escapeFfmpegDrawtext()`, wymuszenie CFR (`-r fps -fps_mode cfr`) oraz synchronizacji audio (`-af aresample=async=1:first_pts=0 -c:a aac -ar 48000`).
  - `buildFfmpegSimpleConfig(edg, outputPath)`: generowanie konfiguracji dla uproszczonego baseline renderera z oznaczeniem `engine: 'ffmpeg-simple'`.
  - `compareRenderPipelines(edg)`: porównanie geometrii, FPS i warstw między pełnym FFmpeg multi-layer compositorem a uproszczonym `ffmpeg-simple`.
  - Jawna odmowa renderowania pikseli dla HyperFrames (`RENDERER_TYPES.HYPERFRAMES`) rzucająca błąd braku przypiętej paczki `@heygen/hyperframes`. Migracja HyperFrames uczciwie oznaczona jako `remaining`.
  - `renderExport(edg, outputPath, { execute: true })`: realne wywołanie FFmpeg, śledzenie procesu potomnego, obsługa anulowania.
  - `probeMedia(filePath)`: inspekcja strumieni audio/wideo przez `ffprobe`.
- **Plik testu:** `packages/core/test/rendererAdapter.test.js` (9 testów, realny eksport MP4 z H.264 1080p i AAC 48 kHz potwierdzony przez `ffprobe`).

---

## 2. Inwentaryzacja 9 Obszarów Docelowych

> **Ścieżki w sidebarze (audyt Fazy 5):** każdy obszar ma realny punkt wejścia w działającej aplikacji (nie trasa dev-only `?panel=`). Audyt jest zakodowany w `packages/studio/src/v26Features.mjs` i strzeżony testem `packages/core/test/v26Reachability.test.js`.

### Obszar 1: Auto-Publisher (YouTube Data API v3)
- **Stan:** `implemented-offline + blocked-external`
- **Ścieżka w sidebarze:** `Cleaner` → recenzja projektu (`CleanerReview`) → dolny panel `PublisherQueuePanel` (`<PublisherQueuePanel>` w `CleanerReview.jsx`).
- **Kod w rdzeniu:** `packages/core/src/publisher.js` (`PublishRecordStore` z trwałością dyskową `publisher-queue.json`, `listQueue()`, `getPendingJobs()`, `cancel()`, `retry()`, `YouTubePublisherAdapter` z pollingiem statusu i obsługą wyczerpania quoty).
- **Integracja w aplikacji:** `electron/lib/publisherBridge.js` (połączenie z `googleOAuth.accessToken()` w OS safeStorage token vault; rejestracja IPC `publisher:get-status`, `publisher:create-session`, `publisher:test-mock-upload`, `publisher:list-queue`, `publisher:poll`, `publisher:cancel`, `publisher:retry`).
- **Narzędzia i UI:** `electron/preload.js` (`window.publisher`), komponent `packages/studio/src/components/PublisherQueuePanel.jsx` podpięty do `CleanerReview.jsx` i `AutoEditorPanel.jsx`.
- **Testy:** `packages/core/test/publisher.test.js`, `packages/core/test/publisherBridge.test.js` (testy offline na lokalnym serwerze mock).
- **Blokady zewnętrzne:** YouTube OAuth 2.0 App Review dla publikacji na konta publiczne, limity quoty API (10 000 jednostek/dzień) oraz wymóg każdorazowej jawnej zgody użytkownika. Produkcyjna publikacja odłożona.

### Obszar 2: Screen Studio Adapter
- **Stan:** `verified-on-this-host (real capture pass, 2026-09-26)` — nagranie okien pozostaje `remaining`.
- **Ścieżka w sidebarze:** `Screen Studio` (własna zakładka w `TABS` z ikoną `MonitorPlay`, Faza 5) → `ScreenStudio.jsx` (`data-testid="screen-studio-panel"`). Tryb demo (sesja syntetyczna) jest jawnie oznaczony wewnątrz tej sekcji.
- **Kod w rdzeniu:** `packages/core/src/screenStudio.js` (`generateSyntheticScreenSession`, `computeAutoZoomKeyframes`, `createStudioCanvasConfig`, `checkNativeScreenRecordingPermission`, `listAvfoundationCaptureDevices`, `createScreenStudioEdgFromRecording`, `renderScreenStudioExport`), `packages/core/src/screenCapture.js` (`buildCaptureArgs`, `startGovernedCapture`, `mapCursorToRecording`, `detectDwellEvents`, `CursorSampler`).
- **Integracja w aplikacji:** dedykowany mostek `electron/lib/screenStudioBridge.js` (IPC `screen:check-permission`, `screen:open-permission-settings`, `screen:list-sources`, `screen:status`, `screen:start-recording`, `screen:stop-recording`, `screen:cancel-recording`, `screen:read-recording`, `screen:build-preview`, `screen:build-edg`, `screen:render-export`, `screen:cancel-export`, `screen:show-in-finder`), ekspozycja `window.screenStudio` w `electron/preload.js`; legacy ścieżki `promo:*` pozostają dla demo. **Faza 5 runda poprawek (2026-09-26):** EDG budowany i cache'owany w main (renderer nie dostarcza EDG), `buildEdg → renderExport` z tym samym `jobId` dla Cancel, telemetria+offset zegara w main, ffprobe-potwierdzenie Stop.
- **Testy:** `packages/core/test/screenStudio.test.js`, `packages/core/test/screenCapture.test.js`, `packages/core/test/screenStudioRecordingExport.test.js`, `packages/core/test/screenStudioBridge.test.js`, `packages/core/test/screenStudioModel.test.js`, `packages/core/test/screenStudioBridgeIntegration.test.js`, `packages/core/test/screenStudioPreloadSurface.test.js`.
- **Weryfikacja sprzętowa (korekta 2026-09-26):** macOS TCC Screen Recording = **`granted`**. `listAvfoundationCaptureDevices()` na tym hoście: video `[0] OBS Virtual Camera`, `[1] Capture screen 0`, `[2] Capture screen 1`. Wcześniejsza diagnoza `blocked-unverified-hardware` była **błędna** — probe celował w `videoDeviceIndex: 0` (kamera). Realny ekran `Capture screen 0` (index 1) akceptuje 30 fps; governed `startGovernedCapture` nagrywa 2,8 s h264 1920×1080 bez czarnych klatek (`verdict: "pass"`). Nagrywanie **okien** (prywatne API ScreenCaptureKit) pozostaje `remaining` i jest renderowane w UI jako disabled z powodem. BlackHole wymagany do audio systemowego (gdy nieobecny, UI pokazuje instrukcję instalacji).

### Obszar 3: Stock & B-roll Matcher
- **Stan:** `partial (MRR/PLR B-roll pack blocked: no licence document)`
- **Ścieżka w sidebarze:** `Cleaner` → recenzja projektu → `AutoEditorPanel` → przycisk `B-roll & Retention Suggestions`.
- **Kod w rdzeniu:** `packages/core/src/broll.js` (`extractVisualIntent`, `MediaLicenseRegistry`, `matchBrollClip`).
- **Integracja w aplikacji:** `electron/lib/autoEditorBridge.js`, `packages/studio/src/components/AutoEditorPanel.jsx` (wyświetlanie sugestii B-roll, kontrolka suwaka progu 0.72, przycisk manualnej podmiany w UI).
- **Testy:** `packages/core/test/broll.test.js`, `packages/core/test/autoEditorBridge.test.js`.
- **Blokady zewnętrzne:** Paczki MRR/PLR 1000+ klipów bez zweryfikowanego dokumentu licencji i praw redystrybucji są zablokowane; wbudowany rejestr operuje wyłącznie na zweryfikowanych klipach CC0/własnych.

### Obszar 4: AI Auto-Editor & NLE Export
- **Stan:** `partial (NLE export unverified-import)`
- **Ścieżka w sidebarze:** `Cleaner` → recenzja projektu → `AutoEditorPanel` (osadzony w `CleanerReview.jsx`) → przycisk eksportu NLE.
- **Kod w rdzeniu:** `packages/core/src/autoEditor.js`, `packages/core/src/nleExport.js`.
- **Integracja w aplikacji:**
  - `electron/lib/autoEditorBridge.js` (obsługa `autoEditor:get-edg`, `autoEditor:apply-action`, `autoEditor:undo`, `autoEditor:redo`, `autoEditor:get-suggestions`, `autoEditor:export-nle`, `autoEditor:render-preview`).
  - `electron/preload.js` (ekspozycja `window.autoEditor`).
  - `packages/studio/src/components/CleanerReview.jsx` & `AutoEditorPanel.jsx` (aktywny interfejs w działającej aplikacji z obsługą Undo/Redo, eksportem FCPXML/Premiere i podglądem EDG).
- **Testy:** `packages/core/test/autoEditor.test.js`, `packages/core/test/nleExport.test.js`, `packages/core/test/autoEditorBridge.test.js`.
- **Ograniczenie weryfikacji:** Dialekty XML są zgodne ze specyfikacjami DTD Final Cut Pro 1.9 i Premiere XML v4, jednak rzeczywisty import w zainstalowanych aplikacjach NLE pozostaje niezweryfikowany (`unverified-import`).

### Obszar 5: Viral Retention & Dual-Hooks
- **Stan:** `partial (retention parameters & rotation treated as configurable hypotheses)`
- **Ścieżka w sidebarze:** `Cleaner` → recenzja projektu → `AutoEditorPanel` → suwaki hipotez (próg/rotacja/padding/zoom) z etykietą „mierzone, nie gwarantowane".
- **Kod w rdzeniu:** `packages/core/src/retention.js` (`scoreRainyHook`, `HookRotationRegistry`, `generateRetentionEvents`).
- **Integracja w aplikacji:** `electron/lib/autoEditorBridge.js` oraz `packages/studio/src/components/AutoEditorPanel.jsx` (prezentacja wyniku R.A.I.N.Y., kontrolka okna rotacji 30 dni i punktów kontrolnych retencji).
- **Testy:** `packages/core/test/retention.test.js`, `packages/core/test/autoEditorBridge.test.js`.
- **Status założeń:** Parametry 0.72, rotacja 30 dni oraz reguły zoomu są konfigurowalnymi hipotezami (nie gwarancjami platformowymi).

### Obszar 6: Generative Anime & Cartoon Studio
- **Stan:** `implemented-awaiting-UI-verification`
- **Ścieżka w sidebarze:** `Marketing` → przełącznik workspace'u → `🎬 Cartoon Studio` (`<CartoonStudio>` w `MarketingStudio.jsx`).
- **Kod w rdzeniu:** `packages/core/src/cartoon.js` (`CharacterSheet`, `decomposeScriptToCartoonScenes`, `computeAmplitudeMouthAnimation`, `createCartoonEdgTimeline`, `CloudByokAdapter`).
- **Integracja w aplikacji:** Oś czasu `createCartoonEdgTimeline` z obsługą warstwy tła, efektów speedlines i dialogów, renderowana bezpośrednio przez `RendererAdapter`.
- **Testy:** `packages/core/test/cartoon.test.js` (w tym realny eksport MP4 zweryfikowany z `ffprobe`).
- **Ograniczenie weryfikacji:** Logika i render zweryfikowane testami jednostkowymi i ffprobe; pełny UI walkthrough w interfejsie użytkownika pozostaje `UI unverified`.

### Obszar 7: Avatar & Talking Head Studio
- **Stan:** `partial`
- **Ścieżka w sidebarze:** `Marketing` → `V2.6 Promo & UGC Review Studio` → render 2D Mascot (`handleTrigger2dMascot` w `PromoReviewStudio.jsx`).
- **Kod w rdzeniu:** `packages/core/src/avatarStudio.js`:
  - `extractAudioEnvelope(audioPath)`: dynamiczne dekodowanie PCM 16-bit mono przez FFmpeg, obliczanie RMS per klatka, wyprowadzanie `mouthStates` (otwartość ust 0.0 - 1.0) oraz probowanie rzeczywistej długości audio.
  - `render2dMascotVideo()`: renderowanie wideo z animacją ust sterowaną obwiednią mowy, miksowanie pliku narracji, zgłaszanie błędu przy braku wskazanego pliku audio, jawne oznaczanie syntetycznego tonu przy braku audio, rejestrowanie procesu potomnego przez `onSpawn`.
  - `auditAvatarModelLicense()`: blokada komercyjna Wav2Lip i LivePortrait InsightFace.
- **Integracja w aplikacji:**
  - Mostek `electron/lib/promoBridge.js`: `promo:render-2d-mascot` (zapis PID procesu w zadaniu JobStore), `promo:cancel-2d-mascot` (anulowanie procesu przez Governor), `promo:pick-audio` (okno dialogowe wyboru pliku narracji).
  - UI w `packages/studio/src/components/PromoReviewStudio.jsx`: przycisk wyboru audio narracji, identyfikator pliku, przycisk renderowania MP4, obsługa błędów braku mostka.
- **Testy:** `packages/core/test/avatarStudio.test.js` (6 testów: ekstrakcja obwiedni, błąd braku pliku, syntetyczny ton, render z dynamiczną obwiednią z realnego audio i zmieniającymi się klatkami ust), `packages/core/test/promoBridge.test.js` (render i cancel przez JobStore).
- **Blokady zewnętrzne:** Wagi Wav2Lip (restrykcje non-commercial) oraz LivePortrait/InsightFace pozostają zablokowane fail-closed. Działa w pełni zweryfikowany fallback 2D Mascot (Zero-VRAM).

### Obszar 8: Promo & Ads Studio
- **Stan:** `implemented-awaiting-UI-verification`
- **Ścieżka w sidebarze:** `Marketing` → `V2.6 Promo & UGC Review Studio` (`<PromoReviewStudio>` w `MarketingStudio.jsx`).
- **Kod w rdzeniu:** `packages/core/src/promoAds.js` (`safeFetchPromoPage` z utwardzoną ochroną SSRF i DNS resolution, `classifyPromoIntent`, `generatePromoScript`, `createResponsivePromoEdg`).
- **Integracja w aplikacji:**
  - `electron/lib/promoBridge.js` (`promo:safe-fetch`, `promo:load-fixtures`, `promo:build-edg`, `promo:render-export`).
  - `electron/preload.js` (`window.promo`).
  - `packages/studio/src/components/PromoReviewStudio.jsx` wmontowany w `packages/studio/src/components/MarketingStudio.jsx` z 3 fixture'ami (SaaS, Dental Clinic, Ergonomic Chair).
- **Testy:** `packages/core/test/promoAds.test.js` (w tym realne eksporty wideo MP4 we wszystkich 3 formatach: 9:16, 1:1, 16:9 z inspekcją `ffprobe`).
- **Ograniczenie weryfikacji:** Crawler SSRF sprawdzony na mockach DNS; brak testu na realnej sieci zewnętrznej; UI walkthrough pozostaje `UI unverified`.

### Obszar 9: Review & UGC Studio
- **Stan:** `implemented-awaiting-UI-verification`
- **Ścieżka w sidebarze:** `Marketing` → `V2.6 Promo & UGC Review Studio` → weryfikacja twierdzeń UGC (`window.promo.verifyClaims` w `PromoReviewStudio.jsx`) i skrypty Type 1/Type 2.
- **Kod w rdzeniu:** `packages/core/src/reviewUgc.js` (`verifyUgcClaims`, `generateType1ReviewScript`, `generateType2GoalProblemScript`, `createResponsiveUgcEdg`).
- **Integracja w aplikacji:**
  - Tabela weryfikacji źródeł twierdzeń w `PromoReviewStudio.jsx` (blokada fałszywych testów 30-dniowych i anonimowych cytatów, Zasada #9).
  - Generowanie skryptów Type 1 Review z regulatory disclosures (`#afiliacja`, `#ai #synthetic`).
  - Tworzenie responsywnego EDG i eksport MP4 przez RendererAdapter.
- **Testy:** `packages/core/test/reviewUgc.test.js` (w tym realny eksport MP4 zweryfikowany z `ffprobe`).
- **Ograniczenie weryfikacji:** Sprawdzone testami Node i ffprobe; UI walkthrough pozostaje `UI unverified`.

### Punkty wejścia w Settings (bez własnej zakładki)

Trzy funkcje V2.6 nie potrzebują zakładki w sidebarze i mają jawny punkt wejścia w modalu ustawień (ikona ⚙️ „Settings" w nagłówku):

- **Model packages manager (Kokoro TTS / Whisper ASR):** `Settings` → sekcja `Engines & models` → lista paczek (`manifest-pending` z zablokowanym przyciskiem instalacji i podanym powodem). IPC `engines:model-packages-status`, `engines:model-package-verify`.
- **FFmpeg capability report:** `Settings` → `Engines & models` → linia zdolności (wersja, klasa licencji, źródło, filtry napisów). IPC `promo:ffmpeg-capabilities`.
- **HyperFrames opt-in:** pin w `Settings` → `Engines & models` (status `engines:hyperframes-status`); sam wybór renderera pozostaje w selektorach Promo i Cartoon (`renderer-select`, `cartoon-renderer-select`; FFmpeg domyślny, HyperFrames opt-in).

---

## 3. Mapa i Tabela Wyjątków Spawnu Procesów Potomnych (Faza 4 Allowlist)

Wszystkie długotrwałe operacje renderowania i eksportu wideo w Vidmyo V2.6 podlegają bezwzględnemu nadzorowi Resource Governora i przechodzą przez `runGovernedFfmpeg` (`packages/core/src/governedProcess.js`). Bezpośrednie wywołania `child_process.spawn` w ścieżkach eksportu zostały wyeliminowane i są strzeżone statycznym testem strażniczym `packages/core/test/noUngovernedFfmpeg.test.js`.

| Moduł / Plik | Użycie `child_process` | Cel / Operacja | Uzasadnienie wyjątku od `runGovernedFfmpeg` | Status strażnika |
|---|---|---|---|---|
| `packages/core/src/governedProcess.js` | `spawn` | Implementacja bazowego biegacza procesów `runGovernedProcess` / `runGovernedFfmpeg` | Rdzeń prymitywu: tworzy detached process group, śledzi PID, wymusza timeout, pre-abort i limit bufora stdout. | Dozwolone (rdzeń) |
| `packages/core/src/ffmpegCapabilities.js` | `spawnSync` | Probowanie wersji, koderów, kodeków i filtrów (`-version`, `-codecs`, `-encoders`, `-filters`) | Krótkie sondy diagnostyczne (kilka ms), brak tworzenia procesów w tle, wyniki cachowane per mtime binarki. | Dozwolone (sonda) |
| `packages/core/src/screenStudio.js` | `spawn` | `listAvfoundationCaptureDevices` (enumeracja wejść AVFoundation) | Krótka enumeracja urządzeń wejściowych macOS dla sprawdzenia uprawnień sprzętowych. | Dozwolone (sonda HW) |
| `packages/core/src/screenStudio.js` | `spawn` | `startAvfoundationCapture` (aktywna sesja nagrywania pulpitu) | Interaktywne nagrywanie czasu rzeczywistego kontrolowane przez sesję; wymaga łagodnego SIGINT do sfinalizowania kontenera MP4. | Dozwolone (capture) |
| `packages/core/src/avatarStudio.js` | `spawnSync` | `extractAudioEnvelope` (synchroniczny fallback RMS) | Zachowany dla wstecznej kompatybilności. Główny render używa `extractAudioEnvelopeAsync` + `runGovernedFfmpeg`. | Dozwolone (fallback sync) |
| `packages/core/src/rendererAdapter.js` | `spawnSync` | Wyszukiwanie ścieżek `which`/`where`, inspekcja filtrów i metadanych `ffprobe` | Natychmiastowe zapytania o metadane plików i obecność narzędzi systemowych. | Dozwolone (proby) |
| `packages/core/src/rendererAdapter.js` | `spawnSync` | Rasteryzator napisów Chrome (Chromium headless DOM → PNG overlay fallback w `buildFfmpegArguments`) | Generowanie klatek PNG napisów przy braku `libass`/`drawtext`; synchroniczny krok w `buildFfmpegArguments`; migracja do async `runGovernedProcess` odłożona do unifikacji pipeline. | `remaining` (sync overlay fallback) |
| `electron/lib/promoBridge.js` | *brak* | Eksporty promo, cartoon, screen-studio, 2D mascot | Wszystkie renderowania delegowane do `core` z `store.governor`, `jobId` i AbortController. Brak bezpośredniego `child_process`. | Wymuszone (0 spawnów) |
| `electron/lib/autoEditorBridge.js` | *brak* | Podgląd i eksporty NLE | Delegowane do `RendererAdapter` z `store.governor`, `jobId` i AbortController. Brak bezpośredniego `child_process`. | Wymuszone (0 spawnów) |

### 3.1. Spawny procesów potomnych poza zakresem Fazy 4 (oznaczone jako `remaining`)

Poniższe moduły zawierają wywołania `child_process`, które nie wchodzą w zakres ścieżek eksportu objętych Fazą 4 (`RendererAdapter._runFfmpeg`, `screenStudio.js:renderScreenStudioExport`, `avatarStudio.js:render2dMascotVideo`, mostki promo/autoEditor). Zostały one zachowane bez modyfikacji, aby chronić WIP innych agentów i uniknąć regresji w równolegle rozwijanych podsystemach:

| Moduł / Plik | Użycie `child_process` | Cel / Operacja | Powód odłożenia (status `remaining`) |
|---|---|---|---|
| `electron/lib/storyBridge.js:319` | `execFile` | Konwersja audio FFmpeg (MP3 → WAV 24kHz) | WIP innych agentów; legacy konwersja audio bez detached process group; nietknięty zgodnie z zasadą nienaruszalności. |
| `packages/core/src/pipeline.js:95` | `execFile` | Finalizacja wideo doodle pipeline (`finalize_video.sh`) | WIP innych agentów; doodle scripts runner bez detached process group. |
| `packages/core/src/repurposeRunner.js:374` | `spawn` | Podproces CLI repurpose engine (`vidmyo_repurpose.cli`) | WIP innych agentów; Python worker runner zarządzany przez JobStore bez detached process group. |
| `electron/lib/cleanerBridge.js:152` | `execFile` | Biegacz transkrypcji i czyszczenia Cleaner Python | WIP innych agentów; backend Pythona wywoływany przez execFile bez integracji z ResourceGovernor. |
| `mcp/lib/vfxService.js:28` | `execFile` | Walidacja projektu VFX w MCP service | WIP innych agentów; walidator VFX bez detached process group. |


