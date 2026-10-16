# Vidmyo V2.6 — Plan Implementacji i Porządek Zależności

## Faza 2 — plan wykonawczy (zatwierdzony; Faza 1 zamknięta, nie regresować)

Kolejność ściśle wg scope MAIOX (najpierw najmniejsze i najbezpieczniejsze):

1. **Item 1 — B-roll licence-field enforcement:** rejestr odrzuca wpisy bez `redistributionRight`, `source` i dowodu licencji (URL lub ścieżka dokumentu); odrzucone wpisy pokazują dokładny powód w istniejącym UI; „dowolna licencja z manifestu" nie jest akceptowana; paczka MRR/PLR zostaje zablokowana. Testy: manifesty akceptowane i odrzucone.
2. **Item 2 — Retention/Hooks hypothesis labels:** próg 0.72, rotacja 30 dni oraz parametry padding/zoom/retention są konfigurowalne przez użytkownika i oznaczone w UI jako hipotezy do zmierzenia, nie udowodnione reguły; skonfigurowane wartości docierają do backendu. Testy: domyślne, nadpisane, odbiór wartości przez backend.
3. **Item 3 — Governor 3-surface:** trzy osobne procesy Node (Electron-main, CLI, MCP lub wierne stand-iny na tym samym kodzie governora) startujące jednocześnie; dowód: wyłączność heavy-lock, współbieżność light, anulowanie całego drzewa dzieci (wnuki wliczone, macOS), timeout na realnym spawnie, odmowa przy za niskim dysku. Komendy i exit codes do EVIDENCE.
4. **Item 4 — Persistent publish queue (offline):** trwała kolejka na dysku przeżywająca restart aplikacji i wznawiana; wznawialny upload z Content-Range i obsługą 308 na lokalnym mocku; cancel przerywa żądanie i kończy jako `cancelled`; błędy quoty mapują się na istniejącą obsługę quoty; odświeżanie tokenu przez wstrzykniętego providera z vaultu main-process. Transport produkcyjny disabled i fail-closed. Bez realnych wywołań YouTube.
5. **Item 5 — Managed model packages (Kokoro/ASR):** manifest z nazwą, wersją, SHA-256, licencją i URL źródła; wznowienie pobierania z weryfikacją checksumy, install/verify/uninstall — wszystko na lokalnym serwerze HTTP fixture z małymi plikami. Prawdziwy URL/checksum tylko po weryfikacji; inaczej `manifest-pending`. Bez dużych realnych pobrań.
6. **Item 6 — Real HyperFrames adapter (ostatnie, najtrudniejsze):** realna paczka HyperFrames przypięta dokładną wersją w `package.json` i lockfile; render HTML → prawdziwy MP4; side-by-side z rendererem FFmpeg (obraz, napisy, zoom, przejście, miks audio) dla 9:16, 1:1 i 16:9, poparte sprawdzeniami ffprobe i PSNR/hashami klatek. Jeśli instalacja lub render niemożliwy na tej maszynie: `blocked` z dokładnym błędem. Nigdy fałszywy render.

Kryteria utrzymania po każdej pozycji: `npm --prefix packages/core test` zielone, `npm run lint` 0 błędów, checkpoint STATUS + EVIDENCE Part I. Na końcu: `graphify update .` z zapisanym realnym wyjściem.

### Progi pomiaru side-by-side (zapisane PRZED pomiarem, item 6)

- **Strukturalne (wymuszone):** dla każdego aspectu (9:16, 1:1, 16:9) oba renderery (HyperFrames i FFmpeg) dają identyczne wymiary canvasu, fps=30, obecność strumienia wideo h264 i audio aac **48000 Hz**, różnica czasu trwania ≤ 1 klatki (≤ 1/30 s + tolerancja muxera 0.02 s), różnica liczby klatek ≤ 1; kadry w tym samym czasie z tego samego pliku mają stabilny hash, a kadry z różnych momentów tego samego rendera różnią się (brak zamrożenia).
- **Podobieństwo (wymuszone sanity + pełny zapis):** uśredniony PSNR ≥ 20 dB i SSIM ≥ 0.85 między renderami HyperFrames i FFmpeg (scena ta sama, ale different rasterizerzy — Chrome vs drawtext/zoompan, osobne kodowanie x264 → pełna identyczność pikseli jest niemożliwa). Faktyczne liczby PSNR/SSIM zapisane w EVIDENCE.
- **Referencja z pełnego planu (WS-3, przełączenie domyślnego silnika — POZA zakresem Fazy 2):** SSIM ≥ 0.97 i PSNR ≥ 35 dB. Próg ten raportowany jest informacyjnie; Faza 2 nie przełącza domyślnego renderera (FFmpeg pozostaje domyślny w każdym wariancie).

**Poza zakresem Fazy 2 (zostawić oznaczone):** Screen Studio natywne/HW; produkcyjne YouTube / app review / real upload; macierz Windows; import NLE w realnych aplikacjach; LivePortrait / audio lipsync; licencja MRR/PLR.

---

## Kolejność Fazy (P0 -> P10)

```
[P0: Inwentaryzacja & Baseline]
        │
        ▼
[P1: Wspólny Kontrakt EDG & Zegar Klatkowy (packages/core)]
        │
        ▼
[P2: Wieloprocesowy Resource Governor & Recovery (JobStore)]
        │
        ▼
[P3: Renderer Adapter & Test Sceny (FFmpeg / HyperFrames)]
        │
        ▼
[P4: AI Auto-Editor & NLE Export (Best Take, VAD/ASR, Padding, FCPXML/Premiere XML)]
        │
        ▼
[P5: B-roll Matcher & Rejestr Licencji + Viral Retention/Hooks (Rotacja 30 dni, R.A.I.N.Y.)]
        │
        ▼
[P6: Promo/Ads & Review/UGC (SSRF-safe Crawler, Intent Classifier, Claim Verification, 3 układy)]
        │
        ▼
[P7: Cartoon & 2D Mascot Studio (Storyboard, Character Consistency, Audio Amplitude)]
        │
        ▼
[P8: Screen Studio Adapter & Telemetria Kursora (Monotonic Clock, Zoom Math, Synthetic Source)]
        │
        ▼
[P9: Avatar & Talking Head Pipeline (Weryfikacja Licencji, Alpha Compositing, 2D Fallback)]
        │
        ▼
[P10: Auto-Publisher YouTube (OAuth Token Vault, Resumable Upload, Idempotent Remote ID)]
```

---

## Szczegółowy Zakres Prac w Modułach

### 1. EDG & Timebase (`packages/core/src/edg.js`, `timebase.js`)
- Schemat EDG v1.0.0 z walidacją struktury, hashami zasobów, warstwami, przejściami, audio, napisami.
- Precyzyjny zegar klatkowy: FPS racjonalny (`{ num: 30, den: 1 }`, `{ num: 60, den: 1 }`), audio 48000 Hz, mapowanie PTS/VFR na stałą siatkę klatek wyjściowych.
- Bezwzględne obliczenia granic (bez kumulacji float).
- Test deterministycznego 30-minutowego scenariusza z weryfikacją braku dryfu.

### 2. Multi-Process Resource Governor (`packages/core/src/governor.js`, rozszerzenie `jobs.js`)
- Plikowa rezerwacja slotów i dzierżawy (`leases/locks`) bezpieczna dla wielu procesów (Electron, CLI, MCP).
- Limit 1 ciężkiej operacji na raz; dopuszczenie lekkiego I/O.
- Dziedziczenie tokenu rezerwacji dla zadań potomnych (unikanie deadlocka).
- Śledzenie PID i bezpieczne zabijanie drzewa procesów (`cancel`).
- Restart recovery: wykrywanie przerwanych zadań (`running` -> `interrupted`), bezpieczne wznawianie.
- Sprawdzanie wolnego miejsca na dysku przed uruchomieniem ciężkiego zadania.
- Idempotencja i cache bazujący na hashu wejścia i wersji operacji.

### 3. Renderer Adapter (`packages/core/src/rendererAdapter.js`)
- Wspólny interfejs renderera: `renderPreview`, `renderExport`, `cancel`, `progress`.
- Działający adapter FFmpeg z obsługą EDG.
- Adapter HyperFrames z przypiętymi zależnościami.
- Porównawczy test sceny: wideo, tekst, zoom, przejścia, miks audio, proporcje (9:16, 1:1, 16:9).

### 4. AI Auto-Editor & NLE Export (`packages/core/src/autoEditor.js`, `nleExport.js`)
- Niedestrukcyjne operacje z mapowaniem source->output.
- Best Take Selector 2.0 (semantyczne grupowanie, wieloczynnikowy scoring, zachowanie najlepszego powtórzenia).
- Rozdzielenie detekcji ciszy akustycznej (VAD) i wypełniaczy leksykalnych (ASR).
- Presety Context-Aware Padding (speech-filler-speech, breath, sentence, topic transition).
- Event-driven punch-in zoom (1.08x, 1.15x, 1.22x).
- Generatory eksportu NLE: `.fcpxml` (Final Cut Pro / DaVinci Resolve) oraz `.xml` (Premiere Pro) z poprawną strukturą XML.

### 5. Stock & B-roll Matcher + Viral Retention (`packages/core/src/broll.js`, `retention.js`)
- B-roll: ekstrakcja zamiarów wizualnych (JSON: subject, action, emotion, shot).
- Rejestr licencji mediów (author, source, license, date, permittedUse).
- Konfigurowalny próg zbieżności (domyślnie 0.72) z regułą zachowania oryginału poniżej progu.
- 1-Click Swap Canvas / model wyboru ujęć.
- Retention: system Dual-Hook (hak werbalny + klip wizualny w pierwszych 2.5s).
- Rejestr rotacji anti-fatigue (okno 30 dni).
- Manifest i download manager dla pakietu klipów (zamiast wbudowywania 5GB).
- Generator zdarzeń retencji (retention loops, midpoint re-engagement).

### 6. Promo/Ads & Review/UGC (`packages/core/src/promoAds.js`, `reviewUgc.js`)
- Bezpieczny URL scraper/crawler z ochroną SSRF (blokada IP prywatnych/loopback, limit rozmiaru, redirectów, timeoutów).
- Traktowanie pobranej treści ściśle jako danych, a nie instrukcji agenta.
- Klasyfikator intencji (Local Business, E-Commerce, Digital/SaaS) z możliwością nadpisania.
- Generator skryptu wg schematu: Hook -> Problem -> Rozwiązanie -> Oferta -> CTA.
- 3 responsywne formaty renderu: 9:16, 1:1, 16:9.
- Review/UGC: obsługa zapytań Typ 1 (Review / dolny lejek) i Typ 2 (Problem/How-to / górny lejek).
- Mechanizm Claim Verification: wymaganie źródeł dla cen, opinii i wyników; zakaz fabrykowania "testowałem 30 dni".
- Oznaczenia disclosure (afiliacja, materiał syntetyczny).

### 7. Generative Anime & Cartoon Studio (`packages/core/src/cartoon.js`)
- Rozbicie skryptu na sceny i scenopis (Script-to-Scene Storyboard).
- Karta spójności postaci (Character Consistency Sheet: rig, kolory, rekwizyty).
- Lokalny silnik 2D: linie akcji (speedlines), dymki komiksowe, uproszczona animacja ust sterowana obwiednią amplitudy audio (z jawnym oznaczeniem, że to animacja amplitudowa, a nie fonemowy lip-sync).
- Interfejs adaptera chmurowego BYOK.

### 8. Screen Studio Adapter (`packages/core/src/screenStudio.js`)
- Abstrakcja ScreenCaptureKit + syntetyczne źródło klatek dla środowisk testowych i headless.
- Telemetria kursora myszy oparta na zegarze monotonicznym skorelowanym z PTS klatek wideo.
- Fizyka i matematyka Smart Auto-Zoom (interpolacja sprężynowa / ease).
- Warstwy dekoracyjne: zaokrąglenie okna, cienie, tła gradientowe.

### 9. Avatar & Talking Head Studio (`packages/core/src/avatarStudio.js`)
- Audyt licencji: jawna weryfikacja i blokada komercyjnego użycia domyślnego kodu/wag Wav2Lip.
- Adapter LivePortrait z parametrami wydajnościowymi i izolacją w Resource Governor.
- Pipeline przezroczystości (ProRes 4444 / PNG alpha frames).
- Fallback: lokalna maskotka 2D z animacją mówienia.

### 10. Auto-Publisher YouTube (`packages/core/src/publisher.js`)
- Natywny adapter YouTube Data API v3 (upload zwykłych filmów i Shorts).
- Obsługa wznawialnego uploadu (Resumable Upload) z zapisem postępu i remote ID.
- Ochrona przed duplikatem (idempotencja, sprawdzanie stanu przed ponowieniem).
- Odrębne stany: `uploading` -> `processing` -> `scheduled` -> `published`.
- Testy offline z mockowanym serwerem HTTP.
- Ochrona: brak rzeczywistego publikowania bez polecenia użytkownika.

---

## Faza 3 — plan wykonawczy (zakres MAIOX Phase 3; Fazy 1–2 zatwierdzone, nie regresować)

Scope zweryfikowany z `Maiox/.tmp/vidmyo-phase3-scope.txt` — 5 pozycji zgodnych 1:1 z planem poniżej.

1. **Item 1 — Test isolation:** żaden test nie czyta ani nie zapisuje w prawdziwym `~/.vidmyo` (`jobs/`, `exports/`, `governor/`, `publisher-queue.json`). Mostki Electron akceptują wstrzykiwalne `userData/jobs/exports` (produkcja nadal `app.getPath('userData')`); każdy test mostka używa prywatnego katalogu `mkdtemp`. Guard test: fail, jeśli run testów utworzy lub zmodyfikuje plik w prawdziwym `~/.vidmyo` z markerem `VIDMYO_TEST_RUN`. Dowód: pełny zestaw core **3× z rzędu** zielony.
2. **Item 2 — Mascot cancel tree-kill:** `promo:cancel-2d-mascot` kończy całe drzewo procesów (grupa, wnuki) przez `runGovernedProcess` z Fazy 2; job kończy się jako `cancelled`, slot governora zwolniony. Test z realnym wnukiem.
3. **Item 3 — FFmpeg capability detection:** runtimeowa detekcja binarki (ścieżka, wersja, flagi licencji) i filtrów (`drawtext`, `libass`, `subtitles`, `overlay`); raport zdolności; renderer wybiera ścieżkę napisów z raportu (drawtext/libass → inaczej PNG overlay) i raportuje wybór; czytelny błąd przy braku FFmpeg. **Bez dodawania/bundlowania binarki** — opcje pakowania (licencja, rozmiar) jako „Pending decision" poniżej.
4. **Item 4 — EDG → HTML dla HyperFrames:** konwersja zwalidowanego EDG (klipy, timing, napisy, zoom, przejścia, miks audio) do kompozycji HyperFrames, żeby `renderExport(HYPERFRAMES, execute)` dawał realny MP4 przez JobStore/governor zamiast fail-closed. FFmpeg domyślny; HyperFrames opt-in (widoczny w istniejącym UI eksportu). Realne render y z EDG przy 9:16, 1:1 i 16:9 versus ścieżka FFmpeg (ffprobe, czas trwania, hash klatek/PSNR/SSIM z udokumentowanymi progami) + test cancel. Nieobsługiwane cechy EDG raportowane jawnie.
5. **Item 5 — UI verification (web):** jeden start aplikacji Next, jedna instalowana przeglądarka headless, ekrany AutoEditorPanel, PromoReviewStudio, CartoonStudio, PublisherQueuePanel — brak błędów konsoli, kluczowe kontrolki obecne, zrzuty w `.tmp/vidmyo-v2.6/ui/`. Bez pobierania przeglądarek. Ścieżki Electron-only zostają „UI unverified (Electron)".

### Progi pomiaru item 4 (zapisane PRZED pomiarem)

- **Strukturalne (wymuszone):** identyczny canvas; 30 fps; h264 + aac 48 kHz; czas trwania w granicach 1 klatki + 0,02 s; liczba klatek w granicach 1; brak zamrożonych klatek (`freezedetect`).
- **Podobieństwo versus render FFmpeg tego samego EDG (wymuszone):** PSNR ≥ 20 dB **oraz** SSIM ≥ 0,85.
- **Raportowane tylko (nie wymuszane):** SSIM ≥ 0,97 i PSNR ≥ 35 dB (próg referencyjny WS-3).

### Decyzja architektoniczna: FFmpeg packaging & libass (Decyzja 2026-09-25)

| Opcja docelowa | Licencja | Status / plan |
|---|---|---|
| Przypięty build LGPL macOS arm64 (libass + freetype + VideoToolbox) | LGPL | **Wybrana opcja dystrybucyjna**: zaplanowana do fazy pakowania/czystej instalacji. W repozytorium roboczym nie bundluje się binarnego bloba. |
| Systemowy FFmpeg (Homebrew / PATH) | zależy od builda użytkownika | Aktywny fallback deweloperski z dynamiczną detekcją zdolności (`probeFfmpegCapabilities`). |
| GPL build (ffmpeg-static itp.) | GPL | **Odrzucone** dla wersji dystrybucyjnej, aby uniknąć restrykcji copyleft GPL w całym pakiecie. |

- **Weryfikacja libass:** Odroczona do fazy pakowania z dedykowanym buildem LGPL (lokalny FFmpeg deweloperski nie ma filtrów `libass`/`drawtext`).
- **Wymóg PSNR ≥ 35 dB:** **Odrzucony**. Naturalne różnice między rasteryzatorem Chromium (HyperFrames) a FFmpeg uniemożliwiają osiągnięcie 35 dB bez pixel-perfect renderera. Parzystość oceniana jest przez SSIM (≥ 0.85), zgodność czasu (≤ 1 klatka + 0.02s) i wymiarów. FFmpeg pozostaje silnikiem domyślnym.
- **W tej fazie (Faza 4) żadna binarka nie jest bundlowana.**

### Poza zakresem Fazy 3 (zostawić oznaczone)

Screen Studio natywne/HW; produkcyjne YouTube / app review / real upload; macierz Windows; czysta instalacja macOS; import NLE w realnych aplikacjach; LivePortrait/lipsync; licencja MRR/PLR; bundlowanie FFmpeg; governowanie spawnów FFmpeg w `rendererAdapter.js` (plain `spawn` w `rendererAdapter.js:1069/1134` — odnotowane jako `remaining`).

---

## Faza 4 — plan wykonawczy (zakres MAIOX Phase 4; Fazy 1–3 zatwierdzone, nie regresować)

Scope: 4 pozycje w kolejności zależności (item 3 przed item 2, żeby UI mogło pokazać encoder).

### Step 0 — Baseline i guard konfliktów
- `.tmp/vidmyo-v2.6/phase4-baseline.txt` (HEAD, branch, liczba porcelain, `git diff --stat` listy plików Fazy 4).
- `npm --prefix packages/core test` → `.tmp/vidmyo-v2.6/phase4-baseline-test.log` (exit code, pass/fail).
- Tabela „Faza 4" w STATUS.md (pozycje 1–4 `remaining`).
- Przed każdym zapisem do współdzielonego pliku WIP (`promoBridge.js`, `rendererAdapter.js`, `autoEditorBridge.js`, `preload.js`, `PromoReviewStudio.jsx`, `CartoonStudio.jsx`) — porównanie mtime z `.tmp/vidmyo-v2.6/phase4-shared-mtimes.txt`; zmiana mtime → stop edycji tego pliku, konflikt w STATUS, kontynuacja pozostałych pozycji.
- **Nie dotykać `storyBridge.js`.**

### Step 1 — Prymitywy governed process (`packages/core/src/governedProcess.js`)
- **Pre-abort:** `signal?.aborted` przed admisją/spawnem → rzuć `{code:'ECANCELLED'}` bez `spawnImpl`, zwolnij już pozyskaną dzierżawę.
- **Bounded stdout:** `captureStdout:{maxBytes}` → `stdio[1]='pipe'`, bufor z limitem; przy przepełnieniu cancel drzewa + `ESTDOUT_LIMIT`; sukces → `stdout: Buffer`.
- **Testy** (`governedProcess.test.js`): pre-abort → `spawnImpl` wywołany 0×; stdout pod capem zwrócony w całości; stdout nad capem → `ESTDOUT_LIMIT` i brak ocalałych w grupie.

### Step 2 — Item 1: governowanie każdego spawnu FFmpeg w render/export
- **D1 `_runFfmpeg`** w `rendererAdapter.js`: wrapper na `runGovernedProcess` (`stdio:['ignore','ignore','pipe']`, `detached:true`, `onSpawn`, `timeoutMs`); zastąpić oba surowe `spawn` (:1291 FFMPEG, :1352 FFMPEG_SIMPLE); usunąć `job.childProcess` + SIGTERM `cancel()` (:54-61).
- **D2 domyślny governor:** brak governora → `new ResourceGovernor({home: vidmyoHome()})`, `jobId = renderId`; admisja idempotentna per jobId.
- **D3 cancel:** wewnętrzny `AbortController` powiązany z `signal` wywołującego; `cancel(renderId)` → `abort()`.
- **D4 mapowanie błędów:** `ECANCELLED`→`cancelled`; `ETIMEDOUT`→`error: timed out after N ms`; `EEXIT`→`error` z ogonem stderr; kasować częściowy plik wyjścia przy każdym niezerowym wyniku.
- **D5 timeout:** `renderExport({timeoutMs})`, domyślnie `max(120000, 10×durationMs)`.
- **D6 pid checkpoint:** `onSpawn` → `store.checkpoint(jobId,'childProcess',{pid,substep:'ffmpeg'})`, exit czyści; kolejność cancel IPC: `controller.abort()` pierwszy, potem `store.cancel()`; `jobs.js` busy-wait bez zmian.
- **`probeMedia` (:542):** async `probeMediaGoverned` (light, 30 s, `captureStdout` 4 MB) do walidacji po renderze; sync `probeMedia` zostaje dla istniejących nie-renderowych wywołań (ich lista w INVENTORY).
- **`screenStudio.js:651`:** eksport przez wspólny helper `runGovernedFfmpeg` (z `index.js`, używany też przez `_runFfmpeg`) przyjmujący governor/jobId/signal/timeoutMs; mostek (`promoBridge.js` ~:655) przekazuje `store.governor`, `job.id`, signal.
- **`avatarStudio.js:137`:** `extractAudioEnvelopeAsync` (light, cap = duration × 8 kHz × 4 B + margin, twardy limit 100 MB); ścieżka renderu maskotki (:380) na wersję async; sync zostaje + lista pozostałych wywołań.
- **Rasteryzator napisów Chrome (:388):** async przez `runGovernedProcess` (light, 15 s, ten sam jobId) — zdejmuje blokadę main-threadu; jeśli zmiana async wyłamie testy overlay → powrót do `spawnSync`, allowlista, `remaining` z powodem.
- **Wyjątki (allowlista, dokumentowana w INVENTORY):** `screenStudio.js:129,230` (capture/enumeration — wymaga SIGINT do finalizacji), `ffmpegCapabilities.js` probes, `rendererAdapter.js:280,319,600` lookups/probes, `storyBridge.js:319` (`remaining`, WIP innych agentów), silniki Python/bash (`pipeline.js:95`, `repurposeRunner.js:374`, `cleanerBridge.js:152`, `mcp/lib/vfxService.js`) — `remaining`, brak detached process group.
- **Testy:** nowy `ffmpegGovernedExport.test.js` (realny FFmpeg, 64×64 PNG, EDG 600–3600 s): (a) cancel 500 ms po `onSpawn`, (b) `timeoutMs:800`, (c) pre-aborted → brak spawnu; asercje: właściwy kod błędu, `pgrep -g <pgid>` exit 1, stan tracker, drugi jobId może `acquire({resourceClass:'heavy',waitForSlotMs:0})`, brak częściowego pliku. `promoBridge.test.js`: cancel cartoon/screen-studio/mascot → `cancelled` + wolna dzierżawa. `autoEditorBridge.test.js`: odmowa admisji → błąd bez spawnu. `noUngovernedFfmpeg.test.js`: skan `spawn(`/`spawnSync(`/`execFile(` w 5 plikach, każdy hit w allowliście zgodnej z tabelą wyjątków INVENTORY. Regresja: `avatarStudio.test.js` zielony.

### Step 3 — Item 3: selekcja enkodera H.264 (przed item 2)
- **`ffmpegCapabilities.js`:** czysty `parseFfmpegEncoders(text)` + probe `ffmpeg -hide_banner -encoders` (spawnSync z timeoutem, cache, ten sam klucz); raport zyskuje `encoders:{libx264,h264_videotoolbox,aac}` i `availableEncoders[]`.
- **`selectH264Encoder(report,{platform,isPreview,height,override})`:** `libx264` (zachować `-preset`/`-crf`); darwin + `h264_videotoolbox` → `-b:v` 2M (preview lub ≤720p), 6M (1080p), 12M (powyżej) + `-profile:v high -pix_fmt yuv420p`, bez crf/preset; inaczej typowany `H264_ENCODER_UNAVAILABLE` z hintami instalacji.
- **Zastosowanie:** `rendererAdapter.js:1029,1168,1628`, `screenStudio.js:642`, `avatarStudio.js:370`; natywny capture `:223` poza zakresem z notatką.
- **Wyniki:** `encoder:{name,reason}` w wynikach; HyperFrames → `encoder:{name:'hyperframes-internal'}`; mostki + linia sukcesu UI pokazują encoder.
- **Testy:** unit (parser na fixture; selektor na 4 wymuszonych raportach: tylko libx264; tylko VT na darwin; żaden na darwin; tylko VT na linux → throw); realne: dwa eksporty 2 s 320×240 (libx264 i VT), ffprobe `codec_name=h264`, duracja ≤ 1 klatka + 0,02 s, `encoder.name` zgodny. VT nie działa na tym Macu → `blocked` ze stderr (nie „pass").

### Step 4 — Item 2: UI cancel
- Nowy `packages/studio/src/exportCancelModel.mjs`: `newExportJobId()` (`/^job_[\w-]+$/`) + `exportOutcome(res)` → `done|cancelled|error` z etykietami PL („Gotowe"/„Anulowano"/„Błąd: …"); testy `exportCancelModel.test.js`.
- **Bridge:** `promo:render-screen-studio-export` i `render-cartoon-export` akceptują `jobId` i rejestrują się we współdzielonym `renderAbortControllers` (istniejące `promo:cancel-render-export` pokrywa promo/cartoon/screen-studio); catch zwraca `jobId` i `code`; stan z `err.code`, nie wyłącznie `store.get().state`.
- **`autoEditor:render-preview`:** governor, jobId, signal; sprawdzenie wyniku admisji (:554); nowe IPC `autoEditor:cancel-preview` + `cancelPreview` w `preload.js`; brak UI → STATUS mówi wprost „brak UI".
- **`PromoReviewStudio.jsx`:** istniejący Cancel (:842) musi pokazać „Anulowano"; dodać Cancel + jobId do eksportu screen-studio (:556).
- **`CartoonStudio.jsx`:** jobId + `data-testid="cancel-cartoon-export"` + `data-testid="export-status"`.
- **Zakres framework:** tylko komponenty; bez zmian Next/routing; `node_modules/next/dist/docs/` czytać tylko jeśli trzeba zmienić `StandaloneShell.js`.
- **Weryfikacja:** `ui_verify.mjs` scenariusze 8–10 (zastubowane bridge pending do cancel → status „Anulowano"; 0 błędów konsoli; screenshoty `.tmp/vidmyo-v2.6/ui/`); jeden run `next dev` z jedną przeglądarką, potem potwierdzić zniknięcie grupy procesowej; Electron IPC → `UI unverified (Electron)` o ile nie uruchomiono aplikacji.

### Step 5 — Item 4: decyzje dokumentowe (2026-09-25)
- **PLAN.md:** „Pending decision: FFmpeg packaging" → przypięty build LGPL macOS arm64 z libass + freetype + VideoToolbox, bundlowany w fazie pakowania/czystej instalacji (źródło i licencja weryfikowane tamże); weryfikacja libass też się tam przenosi (lokalny FFmpeg nie ma libass/drawtext).
- **PSNR:** PSNR ≥ 35 dB (`PLAN.md:20,157`) → **odrzucone** jako wymóg; paritet HF ocenia SSIM + duracja + liczba klatek; PSNR raportowany tylko; FFmpeg domyślnym rendererem.
- **STATUS.md** wiersze poza zakresem: pakowanie → `decided-2026-09-25, scheduled: packaging phase`; libass → przeniesione. Bez luzowania istniejących asercji testowych.
- **INVENTORY.md:** pełna mapa spawnów wraz z rasteryzatorem Chrome i wyjątkami.

### Step 6 — Close-out
- Pełny izolowany suite (guard musi przejść) → `phase4-final-core-test.log`; `npm run lint` 0 błędów → `phase4-final-lint.log`; `graphify update .` realne wyjście → `phase4-final-graphify.log`; skasować duże temp fixtures; STATUS per pozycja; bez commit/ref.

### Ryzyka i ograniczenia
- Wczesne zwolnienie dzierżawy (governed FFmpeg release przed `setState('done')`) — oczekiwane, udokumentować i testować.
- Async napisy/envelope mogą zmienić timing w testach — wersje sync zostają, fallback wg Step 2.
- Testy realnego FFmpeg ≤ 20 s; `timeoutMs` żeby nie wisiały.
- Poza Fazą 4 (zachować tagi): bundlowanie FFmpeg, libass, natywny capture, produkcyjne YouTube, Windows, czysta instalacja macOS, import NLE, LivePortrait/lip-sync, MRR/PLR.

---

## Phase 5, final plan: a real Screen Studio section and navigation reachability

This takes the draft plan and adds the review fixes that check out against the current code. I confirmed four things in the main checkout, read-only:

- **Core export root:** it is `packages/core/index.js`, not `src/index.js`, so Reviewer 1 is right.
- **Custom media protocol:** none exists.
- **Kill grace period:** `governor.cancelProcessTree(pid, {killAfterMs})` already takes one.
- **Media read cap:** an existing precedent caps reads at 256 MiB (`repurposeBridge.js:29`).
- **Shutdown hook:** `main.js:130` `before-quit` already runs `Promise.allSettled([stop…()])`.

### Decisions that change the draft

| # | Change | Reason |
|---|---|---|
| R1 | **Preview size cap.** `screen:read-recording` is capped at **256 MiB** (same as the repurpose preview), not 512. Above that, it returns `tooLarge` and the UI offers two things: "Build preview", a governed 960-wide, low-bitrate proxy at `recordings/<jobId>.preview.mp4`, which then goes through the same capped read; and "Show in Finder". **No new privileged protocol in Phase 5.** | Stays within the memory limits both reviewers raised, without adding a new privileged URL scheme. |
| R2 | **Stop grace period.** Pass `cancelEscalationMs` from `runGovernedFfmpeg` through to `governor.cancelProcessTree(pid, {killAfterMs})`. | The option already exists, so only a small change to `governedProcess.js` is needed. |
| R3 | **Mic plus system audio.** Mix with `amix=inputs=2:normalize=0:dropout_transition=0`, then `aresample=48000`. | Without `normalize=0`, speech comes out at half volume. |
| R4 | **Export timing.** The recording branch uses `fps=N` for video and `aresample=48000:async=1`, then `apad` and `-t <EDG duration>` for audio. Duration comes from **ffprobe**, never the wall clock. | Real screen recordings have a variable frame rate. |
| R5 | **Crop safety.** Crop `w` and `h` are forced to even numbers and at least 2. `x` and `y` are clamped to `[0, in_w-w]` and `[0, in_h-h]` with `min()`/`max()` inside the expression. Zoom changes use smoothstep easing. There are at most 64 segments and the filter string is at most 16 KB; if either limit is exceeded, zoom is turned off with a stated reason and the export continues. | Avoids FFmpeg crop crashes and parser limits. |
| R6 | **Cursor sampling.** 30 Hz. A sample is skipped if the cursor moved less than 2 px, but one is always kept at least every 500 ms. Kept samples are stored as typed arrays of at most 7200 s × 30 entries. | Bounded memory on long recordings. |
| R7 | **Busy status.** The UI shows "Resource busy: recording in progress" when the heavy slot is taken. `screen:status` returns `{governorBusy, heldBy}`, read from the governor's existing snapshot. **No new broadcast channel.** | Other tabs don't look hung. |
| R8 | **Quit handling.** `stopScreenStudio()` is added to the `Promise.allSettled` list at `main.js:134`. It stops gracefully with a hard limit of 10 s, and records the job as `cancelled` or `done`. | Reuses the existing shutdown pattern. |
| R9 | **Screen matching.** The avfoundation screen is matched to an Electron display **by resolution**, not by index (probed W×H = `bounds×scaleFactor`). If no display matches, or more than one does, `telemetryStatus:'display_mapping_uncertain'` and auto-zoom is off. | Multi-monitor safety. |
| R10 | **Test port.** `ui_verify.mjs` uses a port obtained from `net.createServer().listen(0)`. It must never touch port 3210 or Luke's running processes. | Protects Luke's session. |

### Steps

**0. Baseline, read-only.**
- Read `docs/plans/vidmyo-v2.6/STATUS.md` and `PLAN.md`, and continue from them. Do not redo finished Phase 1–4 work.
- Record the Phase 5 baseline table in STATUS.md.
- Guard mtimes against concurrent modifications.
- Read Next guides before touching StandaloneShell.js.
- Append plan to PLAN.md.

**1. Navigation shell. Checkpoint A.**
- Create `packages/studio/src/components/ScreenStudio.jsx` containing only the existing demo (synthetic) flow, moved out of PromoReviewStudio. Leave a one-line pointer in PromoReviewStudio.
- Export it from `packages/studio/src/index.js`.
- In `StandaloneShell.js`:
  - add the tab `{id:'marketing', label:'Marketing'}` and `{id:'screen-studio', label:'Screen Studio'}`;
  - use the `MonitorPlay` icon;
  - add the branch `activeTab==='screen-studio' && <ScreenStudio/>`;
  - fix the comment at line 21.
- Add a case to `navigationShell.test.js`.
- Run `npm run build:studio`, update STATUS, create checkpoint A.

**2. Core capture. Checkpoint B.**
- Create `packages/core/src/screenCapture.js`, exported through `packages/core/index.js`.
- Apply R2 in `governedProcess.js`.
- Write `screenCapture.test.js` and add `screenCapture.js` to `noUngovernedFfmpeg.test.js`.

**3. Export from the real recording. Checkpoint C.**
- `createScreenStudioEdgFromRecording` and `renderScreenStudioExport` recording branch.
- Write `screenStudioRecordingExport.test.js` and drift test.

**4. Bridge. Checkpoint D.**
- Create `electron/lib/screenStudioBridge.js` and `enginesBridge.js`.
- Register in `main.js`, add `stopScreenStudio` to `before-quit` (R8).
- Expose in `preload.js`.
- Write `screenStudioBridge.test.js`.

**5. Screen Studio UI. Checkpoint E.**
- `screenStudioModel.mjs` pure reducer + labels.
- Full UI flow in `ScreenStudio.jsx`.

**6. Reachability and "Engines & models". Checkpoint F.**
- Settings section "Engines & models".
- `packages/studio/src/v26Features.mjs` and `v26Reachability.test.js`.
- Update `INVENTORY.md`.

**7. Verification. Checkpoint G.**
- `tests/ui_verify.mjs` headless browser test.
- `.tmp/vidmyo-v2.6/real_capture_probe.cjs`.

**8. Close-out.**
- Run suites, lint, build:studio, graphify, update STATUS/EVIDENCE.

