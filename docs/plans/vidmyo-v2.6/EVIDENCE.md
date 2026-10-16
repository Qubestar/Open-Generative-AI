# Vidmyo V2.6 — Dziennik Dowodów i Weryfikacji (EVIDENCE)

> [!IMPORTANT]
> Runda poprawek po review Fazy 5 (2026-09-26) ma miejsce w **worktree MAIOX**, nie w głównym checkoutcie Luke'a. Alias `"studio"` w `jsconfig.json` musi zostać sprawdzony przed merge (patrz STATUS).

## CZĘŚĆ I (Faza 5 — runda poprawek po 3. review, 2026-09-26): BEZPIECZEŃSTWO TESTÓW + BRAKUJĄCE TESTY

3. review zatwierdził przebieg Fazy 5, ale zgłosił 2 blokery (sygnały do realnych PID-ów hosta w testach; brak testów timeout/cancel-drzewa/stop dla `startGovernedCapture`) i 4 uwagi. Wszystkie naprawione.

| # | Ustalenie | Naprawa | Dowód |
|---|---|---|---|
| B1 | **SAFETY** — testy wysyłały realne sygnały do arbitralnych PID-ów hosta (`ee.pid = 99901/99001/99002` → `process.kill(-pid,'SIGINT')`, `cancelProcessTree` → SIGTERM/SIGKILL) | Wstrzyknięto seam `killImpl`/`livenessImpl` do `startGovernedCapture` (i do `governor.cancelProcessTree`), używany we wszystkich ścieżkach sygnałów; mostek przekazuje `deps.killImpl`/`deps.livenessImpl`; testy z fake PID-ami wstrzykują `killImpl: () => {}` + `livenessImpl: () => false` | `screenCapture.test.js` i `screenStudioBridgeIntegration.test.js` zielone; brak jakiegokolwiek `process.kill` z fake PID-em |
| B2 | **Brak testów** cancel-drzewa/timeout/stop dla `startGovernedCapture` | Nowy `screenCaptureGoverned.test.js` z realnym fake-ffmpeg (skrypt sh forkowany z `detached:true`, grandchild `sleep 60`); dodano opcjonalny seam `timeoutMs` | 3/3 pass (cancel: `pgrep -g` pusty + plik usunięty + dzierżawa zwolniona; timeout: drzewo zabite + dzierżawa zwolniona + exit raportowany prawdziwie; stop: realny SIGINT, plik niepusty, dzierżawa zwolniona po exit) |
| M1 | `tests/ui_verify.mjs` scenariusz 9 asertował hard-kodowane `true` | Asercja na treści panelu (`/Screen Studio/`) | UI-verify 14/14 |
| M2 | `clickRail` klikał DOM `.click()` bez sprawdzenia widoczności; rail obcinany przy 800 px | `scrollIntoView` + `getBoundingClientRect()` visibility check; `setViewport(1440×900)` w `openScenario` | UI-verify 14/14; screenshot 10 przy 1440 px |
| M3 | `handleCancelRecording` ignorował wynik mostka i zawsze dispatchował sukces | Rozróżnia `{ok:false,cancelled:true}` (sukces) od `{ok:false,error}` (błąd); nowa akcja `CANCEL_RECORDING_FAILURE` + widoczny banner `data-testid="screen-studio-error"` | test reducera „cancel recording failure surfaces the error and code" |
| M4 | `screen:start-recording` przyjmował rendererowy `jobId`, który już istnieje | Odrzuca istniejący JobStore record lub plik w `recordingsDir` (`EJOB_EXISTS`), nie nadpisuje nagrania | `screenStudioBridgeIntegration.test.js` „rejects a jobId that already exists" |

| Komenda | Exit | Wynik |
|---|---|---|
| `npm --prefix packages/core test` | 0 | **612/612 pass, 0 fail** (~79 s); guard izolacji domu **PASS**. Log: `.tmp/vidmyo-v2.6/phase5-fix3-core-test.log`. |
| `npm run lint` | 0 | **0 błędów, 14 ostrzeżeń legacy**. Log: `.tmp/vidmyo-v2.6/phase5-fix3-lint.log`. |
| `npm run build:studio` | 0 | **36 plików** (Babel). |
| `node tests/ui_verify.mjs` | 0 | **verdict: pass, 14/14 scenariuszy, 0 błędów konsoli**; `dev server process group gone: true`. Log: `.tmp/vidmyo-v2.6/phase5-fix3-ui-verify.log`; raport `.tmp/vidmyo-v2.6/ui-verify-report.json`. |
| `graphify update .` | 0 | **355/355 plików AST; 2581 węzłów, 5414 krawędzi, 156 społeczności**. Log: `.tmp/vidmyo-v2.6/phase5-fix3-graphify.log`. |

- **Zakres nowych testów:** +5 (`screenCaptureGoverned` 3, mostek `EJOB_EXISTS` 1, reducer `CANCEL_RECORDING_FAILURE` 1) → 607 → 612.
- **Realne nagranie:** stan bez zmian względem rundy po 2. review (`verdict: "pass"`, `Capture screen 0` index 1) — nie zmieniano ścieżki capture na tym Macu.
- **Wciąż `remaining`/`unverified`:** jak w tabeli stanu Fazy 5 (nagrywanie okien, wielomonitorowe mapowanie, realne kliknięcia, Windows, restart Electrona, alias `studio` do sprawdzenia przed merge).

## CZĘŚĆ I (Faza 5 — runda poprawek po 2. review, 2026-09-26): REALNE NAGRANIE PRZECHODZI

2. review odrzucił `approved`, wskazując że realny przepływ nagrywania jest nadal zepsuty, a diagnoza `blocked-unverified-hardware` nie wytrzymuje. **Recenzja miała rację.** Naprawiono 4 blokery:

| # | Ustalenie | Naprawa | Dowód |
|---|---|---|---|
| 1 | Probe hard-kodował `videoDeviceIndex: 0` (kamera OBS), nigdy nie enumerował urządzeń → fałszywa diagnoza sprzętowa | Probe enumeruje i używa `screens[0].index`; czeka na realny start przechwytywania; 3 s zapisu; weryfikacja strumienia wideo, czasu 3±0,5 s i `blackdetect` | `verdict: "pass"`: `[0] OBS Virtual Camera`, `[1] Capture screen 0`, `[2] Capture screen 1`; wybrany index 1; `durationSec=2.8`; h264 1920×1080; `blackdetect.detected=false`. `.tmp/vidmyo-v2.6/real_capture_probe.json` |
| 2 | `SET_SOURCES` nie wybierał pierwszego realnego ekranu (zostawał 0 = kamera) | Reducer przyjmuje indeks pierwszego ekranu, gdy bieżący nie ma go w świeżej liście | testy `screenStudioModel.test.js` (2 nowe) |
| 3 | UI czytał `sourcesRes.audio` zamiast `audioDevices` → puste listy mikrofonu/systemowego | UI czyta `audioDevices`; stub zwraca wyłącznie realny kształt; test kontraktu mostek→UI | `screenStudioPreloadSurface.test.js` (nowy test kontraktu); UI-verify „microphone list is populated from audioDevices" |
| 4 | UI nie renderował `windows` / BlackHole | UI dispatchuje i renderuje listę okien (disabled + reason) oraz komunikat o braku BlackHole z instrukcją | UI-verify: „BlackHole-absent message explains how to install it" + „windows render as disabled entries with a reason" |

| Komenda | Exit | Wynik |
|---|---|---|
| `electron .tmp/vidmyo-v2.6/real_capture_probe.cjs` | 0 | **`verdict: "pass"`** — realne `Capture screen 0` (index 1), `durationSec=2.8`, h264 1920×1080, `blackdetect` brak. Dowód: `.tmp/vidmyo-v2.6/real_capture_probe.json`. |
| `npm --prefix packages/core test` | 0 | **607/607 pass, 0 fail**; guard izolacji domu **PASS**. Log: `.tmp/vidmyo-v2.6/phase5-fix2-core-test.log`. |
| `npm run lint` | 0 | **0 błędów, 14 ostrzeżeń legacy**. |
| `npm run build:studio` | 0 | **36 plików** (Babel). |
| `node tests/ui_verify.mjs` | 0 | **verdict: pass, 14/14 scenariuszy, 0 błędów konsoli**; `dev server process group gone: true`. Log: `.tmp/vidmyo-v2.6/phase5-fix2-ui-verify.log`; raport `.tmp/vidmyo-v2.6/ui-verify-report.json`. |
| `graphify update .` | 0 | **354/354 plików AST; 2573 węzłów, 5405 krawędzi, 156 społeczności**. Log: `.tmp/vidmyo-v2.6/phase5-fix2-graphify.log`. |

- **Dowód urządzeń (bezpośredni):** `ffmpeg -f avfoundation -list_devices true -i ''` → video `[0] OBS Virtual Camera`, `[1] Capture screen 0`, `[2] Capture screen 1`; audio `[0] Scarlett 18i8 USB`, `[1] Microsoft Teams Audio`. Index 0 jest kamerą — to wyjaśnia zarówno „tylko 60 fps", jak i brak klatek.
- **Wciąż `remaining`/`unverified`:** nagrywanie okien (ScreenCaptureKit, UI renderuje disabled z powodem), wielomonitorowe mapowanie (jeden monitor), realne kliknięcia (`heuristic-labelled`), macierz Windows, IPC Electron w UI-verify (stub). Nie są blokadą zatwierdzenia Fazy 5.

## CZĘŚĆ I (Faza 5 — runda poprawek po 1. review, 2026-09-26): DOWODY NAPRAW BLOKERÓW

Recenzja odrzuciła Fazę 5, wskazując 6 blokerów (eksport bez EDG, Cancel bez efektu, dowolny odczyt pliku, telemetria nieprzekazywana/bez offsetu, nieobsłużony kanał preload, nieaktualny stan joba po samo-zakończeniu FFmpeg), 5 odchyleń planu i uwagę o lokalizacji checkpointu. Poniżej dowody napraw. **Realne nagranie pozostaje zablokowane sprzętowo.**

| Komenda | Exit | Wynik |
|---|---|---|
| `npm --prefix packages/core test` | 0 | **604/604 pass, 0 fail**; guard izolacji domu **PASS**. Log: `.tmp/vidmyo-v2.6/phase5-fix-core-test.log`. |
| `npm run lint` | 0 | **0 błędów, 14 ostrzeżeń legacy**. Log: `.tmp/vidmyo-v2.6/phase5-fix-lint.log`. |
| `npm run build:studio` | 0 | **36 plików** (Babel). Log: `.tmp/vidmyo-v2.6/phase5-fix-build-studio.log`. |
| `node tests/ui_verify.mjs` | 0 | **verdict: pass, 14/14 scenariuszy, 0 błędów konsoli**; scenariusz 12: akcje `["startRecording","stopRecording","buildEdg","renderExport"]`, `edgId=job_record_ui_1`, `cancel === renderJobId`. Log: `.tmp/vidmyo-v2.6/phase5-fix-ui-verify.log`; raport `.tmp/vidmyo-v2.6/ui-verify-report.json`. |
| `node --test packages/core/test/screenStudioBridgeIntegration.test.js` | 0 | **4/4 pass** — real core, fake avfoundation capture (materializuje prawdziwy MP4 na SIGINT), real FFmpeg export, Cancel usuwa plik częściowy, self-exit finalizuje job. |
| `node --test packages/core/test/screenCapture.test.js packages/core/test/screenStudioPreloadSurface.test.js` | 0 | **10/10 + 2/2 pass** — offset telemetrii (300 ms, drop pre-roll), powierzchnia preload (`buildEdg` obecny, `cursorSample` usunięty). |
| `graphify update .` | 0 | **354/354 plików AST; 2573 węzłów, 5405 krawędzi, 156 społeczności**. Log: `.tmp/vidmyo-v2.6/phase5-fix-graphify.log`. |
| `electron .tmp/vidmyo-v2.6/real_capture_probe.cjs` | 0 | TCC **`granted`**, nagranie **fail** → `blocked-unverified-hardware` (**nie „pass"**). Dowód: `.tmp/vidmyo-v2.6/real_capture_probe.json`. |
| `electron .tmp/vidmyo-v2.6/af_fps_probe.cjs` | 0 | Throwaway: przy wspieranym `-framerate 60` urządzenie otwiera się, ale **0 klatek** (`sizeAfter=0` po 4 s), nie kończy się na SIGINT. |

### Naprawy blokerów (dowód bezpośredni)

1. **Eksport (bloker 1):** `electron/preload.js` eksponuje `buildEdg`; `ScreenStudio.jsx` woła `buildEdg` → `renderExport({jobId, edgId})`. Mostek cache'uje EDG w main po `edgId`; `render-export` **nie przyjmuje EDG z renderera**. Dowód: integracja (build-edg→render-export→plik MP4) + UI scenariusz 12.
2. **Cancel (bloker 2):** ten sam `jobId` w `renderExport` i `cancelExport`. Dowód: integracja (cancel → `cancelled:true`, brak pliku) + UI (`cancel === renderJobId`).
3. **Dowolny odczyt (bloker 3):** `render-export` wymaga `edgId` i cache'owanego EDG; dodatkowo ścieżka źródłowa sprawdzana względem `recordingsDir`. Dowód: testy `edgId is required` / `No EDG found`.
4. **Telemetria (bloker 4):** `CursorSampler.startedAtWallClockMs` + `shiftTelemetryToCaptureClock`; mostek trzyma telemetrię/T0 per `jobId`. Dowód: unit offsetu + integracja `samplesCount≥1`, `telemetryStatus='ok'`.
5. **Kanał preload (bloker 5):** usunięto `cursorSample`. Dowód: `screenStudioPreloadSurface.test.js`.
6. **Stan joba (bloker 6):** `onSpawn`→`exit` observer finalizuje job i czyści sesję; sampler zatrzymany na `exit`. Dowód: test self-exit (`isRecording:false`, job `done`) + fix wycieku timera wykryty przy testach.

### Realne nagranie — [SKORYGOWANE 2026-09-26] dowód blokady (był nieprawdziwy)

> [!WARNING]
> Ta sekcja z 1. rundy poprawek była **błędna** i jest zachowana wyłącznie dla śladu. Obowiązuje sekcja „Realne nagranie przechodzi" na górze pliku.

- TCC Screen Recording = `granted` dla procesu Electron. *(nadal prawdziwe)*
- ~~FFmpeg: ... ten Mac wystawia tylko 60 fps.~~ → **błędne:** `-i 0` to kamera OBS Virtual Camera (1920x1080@60). Realny ekran `Capture screen 0` ma indeks **1** i akceptuje 30 fps.
- ~~Przy `-framerate 60`: urządzenie ... nie produkuje klatek.~~ → dotyczyło kamery.
- ~~Wniosek: `blocked-unverified-hardware`~~ → **skorygowane:** realne nagranie `Capture screen 0` przechodzi (`durationSec=2.8`, h264 1920×1080, bez czarnych klatek).

---


Środowisko testowe: macOS arm64 (Darwin 25.5.0), Node.js v25.4.0, Homebrew FFmpeg 8.1.1 (brak `drawtext`; filtr `overlay` obecny — rasteryzacja przezroczystego PNG przez lokalny headless Chromium, kompozycja przez `overlay=...:enable='between(...)'`)  
Zestaw testów Core (pełny, fresh run po wszystkich edycjach 2. review): `npm --prefix packages/core test` → **564/564 pass, 0 fail, exit 0** (~71.4 s); guard izolacji domu **PASS**; log: `.tmp/vidmyo-v2.6/phase4-final-core-test.log` (timestamp 12:02)  
Analiza statyczna: `npm run lint` (**exit 0**, 0 błędów, 14 ostrzeżeń w legacy kodzie); log: `.tmp/vidmyo-v2.6/phase4-final-lint.log` (timestamp 12:05)  
Stan bazy wiedzy: `graphify update .` (**exit 0**, 459 plików AST, 2869 węzłów, 6112 krawędzi, 224 społeczności); log: `.tmp/vidmyo-v2.6/phase4-final-graphify.log` (timestamp 12:05)

---

## CZĘŚĆ I (Faza 5): STAN BIEŻĄCY — WERYFIKACJA ZAKRESU FAZY 5 (2026-09-26)

> [!WARNING]
> Ta sekcja jest **historyczna** i zawiera nieprawdziwe deklaracje, które wykryła recenzja (np. „eksport działa", „realne nagranie awaiting-luke-manual-test"). Aktualny stan i dowody napraw znajdują się w sekcji „CZĘŚĆ I (Faza 5 — runda poprawek po review, 2026-09-26)" na górze pliku. Poniższe komendy/testy pozostają prawdziwe jako pomiar z 2026-09-25, ale wnioski o gotowości zostały skorygowane.

Zakres Fazy 5: dedykowana sekcja „Screen Studio" w sidebarze, realny przepływ nagrywania pod governor-em, budowa EDG i eksport MP4 z realnego nagrania, mostek IPC + preload, audyt osiągalności 9 obszarów, sekcja „Engines & models" w Settings, weryfikacja UI przez realny pasek.

| Komenda | Exit | Wynik |
|---|---|---|
| `npm --prefix packages/core test` | 0 | **596/596 pass, 0 fail** (~82 s); guard izolacji domu **PASS**. Log: `.tmp/vidmyo-v2.6/phase5-final-core-test.log`. |
| `npm run lint` | 0 | **0 błędów, 14 ostrzeżeń legacy**. Log: `.tmp/vidmyo-v2.6/phase5-final-lint.log`. |
| `npm run build:studio` | 0 | **36 plików** skompilowanych (Babel). Log: `.tmp/vidmyo-v2.6/phase5-build-studio-step6.log`. |
| `node tests/ui_verify.mjs` | 0 | **verdict: pass, 14/14 scenariuszy, 0 błędów konsoli** (fresh run po ostatniej zmianie kodu); port 50266 (`net.listen(0)`); `serverGroupGone: true`. Log: `.tmp/vidmyo-v2.6/phase5-ui-verify.log`; raport `.tmp/vidmyo-v2.6/ui-verify-report.json`; zrzuty `.tmp/vidmyo-v2.6/ui/01..14`. |
| `node --test packages/core/test/v26Reachability.test.js` | 0 | **6/6 pass**: 9 obszarów, zakładki TABS + gałęzie renderu, markery osiągalności, Settings → Engines & models read-only, Screen Studio jako zakładka top-level. |
| `node --test packages/core/test/screenStudioBridge.test.js` | 0 | **16/16 pass** (w tym hyperframes-status pinned 0.8.72 + ścieżka braku paczki). |
| `electron .tmp/vidmyo-v2.6/real_capture_probe.cjs` | 0 | **`tccStatus: "denied"`** → verdict `awaiting-luke-manual-test` (**nie „pass"**). Dowód: `.tmp/vidmyo-v2.6/real_capture_probe.json`. |
| `graphify update .` | 0 | **352/352 plików AST; 2563 węzłów, 5391 krawędzi, 155 społeczności**. Log: `.tmp/vidmyo-v2.6/phase5-final-graphify.log`. |

### Scenariusze UI (14/14 pass) — dowód osiągalności z realnego paska

1. PromoReviewStudio (renderer selector + mascot audio picker)
2. CartoonStudio (renderer selector przez przełącznik Marketing)
3. PromoReviewStudio — linia zdolności FFmpeg (stub IPC)
4. AutoEditorPanel — suwaki hipotez + odrzucone wpisy B-roll
5. PublisherQueuePanel — stany kolejki publikacji
6. PromoReviewStudio — `unsupported` (ścieżka sukcesu + widoczny Cancel)
7. PromoReviewStudio — `unsupported` (ścieżka błędu)
8. PromoReviewStudio — Cancel eksportu → „Anulowano"
9. **Screen Studio — nawigacja realnym paskiem + brak uprawnień** (`clickRail('Screen Studio')`, nie `?panel=`)
10. **Screen Studio — start / timer / stop / podgląd** (timer z `screen:status`)
11. **Screen Studio — limit 256 MiB → proxy + Finder** (R1)
12. **Screen Studio — Cancel eksportu → „Anulowano"**
13. **Settings → Engines & models** (FFmpeg raport, HyperFrames pin, pakiety `manifest-pending` z wyłączonym „Zainstaluj")
14. CartoonStudio — Cancel eksportu → „Anulowano"

### Ograniczenia pomiarów (uczciwie)

- **Realne TCC:** `getMediaAccessStatus('screen')` = `denied` dla procesu probe → brak realnego nagrania; element pozostaje `awaiting-luke-manual-test`, nie „pass". Mock/stub nie dowodzi jakości realnego nagrania.
- **IPC Electron w UI:** scenariusze 9–13 stubbują `window.screenStudio`/`window.engines`/`window.promo`; zweryfikowany jest render i logika przejść, nie sam IPC Electrona (`UI unverified (Electron)`).
- **Worktree:** `next dev` uruchomiony z `--webpack` (Turbopack odrzuca symlink `node_modules` poza root); pakiet `studio` rozwiązywany przez alias w `jsconfig.json`. Nie zmienia to zachowania aplikacji.
- **Graphify:** liczby niższe niż Fazy 4 (przeliczenie bieżącego worktree), zapisane bez korekty.

---

## CZĘŚĆ I: STAN BIEŻĄCY — WERYFIKACJA ZAKRESU FAZY 4 I POPRAWEK REVIEW

### Faza 4 — podsumowanie i komendy weryfikacyjne (po rundzie poprawek review 2026-09-25)

| Komenda | Exit | Wynik |
|---|---|---|
| `node --test packages/core/test/noUngovernedFfmpeg.test.js` | 0 | **6/6 pass** (0,1 s): static guard skanuje wszystkie 7 plików (`governedProcess.js`, `ffmpegCapabilities.js`, `screenStudio.js`, `avatarStudio.js`, `rendererAdapter.js`, `promoBridge.js`, `autoEditorBridge.js`) pod kątem `spawn`/`spawnSync`/`execFile`/`exec`. Wszystkie 12 wywołań w 100% dopasowane do `ALLOWLIST_EXCEPTIONS` odpowiadających INVENTORY §3. |
| `node --test packages/core/test/ffmpegGovernedExport.test.js` | 0 | **6/6 pass** (2,9 s): asercja braku ocalałych procesów w grupie (`pgrep -g <pgid>` -> 0 procesów) dla timeout i cancel; realny eksport przez `RendererAdapter.renderExport` z `adapter.cancel(renderId)` (stan `cancelled`, uwolnienie dzierżawy heavy, usunięcie pliku); realny eksport z `timeoutMs` (kod `ETIMEDOUT`, uwolnienie dzierżawy, usunięcie pliku). |
| `node --test packages/core/test/ffmpegCapabilities.test.js` | 0 | **13/13 pass** (1,4 s): `selectH264Encoder` z zachowaniem `-preset` i `-crf` (18 dla exportu, 28 dla preview); realne eksporty wykonane przez `RendererAdapter.renderExport` dla `libx264` i `h264_videotoolbox` z weryfikacją `result.encoder.name` i inspekcją `ffprobe` (strumień h264, czas ±1 klatka + 0,02 s), brak cichego skipa. |
| `node --test packages/core/test/exportCancelModel.test.js` | 0 | **5/5 pass** (0,1 s): formatowanie statusów (`done` / `cancelled` / `error`), etykiety PL („Gotowe” / „Anulowano” / „Błąd”), weryfikacja podpięcia przycisków Cancel i statusów w `CartoonStudio.jsx` oraz `PromoReviewStudio.jsx`. |
| `node tests/ui_verify.mjs` | 0 | **verdict: pass, 10/10 scenariuszy pass, 0 błędów konsoli**: realny przebieg headless Chrome na `next dev` (port 58101); scenariusze 8 (Promo cancel), 9 (Screen Studio cancel) i 10 (Cartoon cancel) pokazują status „Anulowano”; wygenerowano zrzuty 01–10 w `.tmp/vidmyo-v2.6/ui/`; dev server poprawnie zakończony po teście. |
| `npm --prefix packages/core test` (pełny suite, isolated) | 0 | **564/564 pass, 0 fail** (71.4 s); guard **PASS** — 0 naruszeń w realnym `~/.vidmyo` (0 oznaczonych plików, 0 temp-pattern). **Fresh run po wszystkich edycjach 2. review, timestamp 12:02.** |
| `npm run lint` | 0 | **0 błędów, 14 ostrzeżeń legacy** — czysty lint. **Fresh run, timestamp 12:05.** |
| `graphify update .` | 0 | **459 plików AST, 2869 węzłów, 6112 krawędzi, 224 społeczności**. **Fresh run, timestamp 12:05.** |

### Poprawki 2. review Fazy 4 (2026-09-25) — blokada B1 i non-blocking NB2–NB4

| # | Ustalenie | Naprawa |
|---|---|---|
| B1 (blocking) | Logi `phase4-final-*.log` starsze niż ostatnie edycje kodu; deklarowane 564/564 bez logu | Ponownie uruchomiono `npm --prefix packages/core test` (564/564 pass, exit 0, ~71.4 s), `npm run lint` (0 err, 14 warn, exit 0), `graphify update .` (exit 0, 2869 nodes) po wszystkich edycjach. Logi nadpisane z timestampami 12:02/12:05. STATUS/EVIDENCE liczby skorygowane do faktycznych wyników. |
| NB2 | STATUS nie mówi wprost, że `autoEditor:cancel-preview` / `cancelPreview` nie ma UI | Dodano jawny wpis w STATUS: IPC istnieje, brak przycisku UI w `AutoEditorPanel.jsx` (preview to szybki inline render; cancel dostępny programowo). |
| NB3 | Promo/cartoon bridges nie przekazują `store` do `renderExport` — D6 pid checkpoint nie zapisywany | Udokumentowana luka w STATUS. `promoBridge.js` linie 250, 354 wywołują `renderExport` bez `store`; recovery opiera się na `renderAbortControllers` (in-memory) + stan JobStore. Poprawka (niskoryzykowna) na następną rundę. |
| NB4 | Kolejność cancel IPC: `store.cancel` → `controller.abort` (odwrotnie niż plan D6) | Udokumentowane w STATUS. Bridge sprawdza stan `cancelled` po powrocie z `renderExport` — oba porządki dają ten sam wynik. |

### Szczegóły realizacji pozycji i usunięcia blokerów Fazy 4:
1. **Item 1 & Bloker B2 (Governed FFmpeg spawns & static guard):** Wszystkie główne ścieżki eksportu wideo (`rendererAdapter.js: _runFfmpeg`, `screenStudio.js: renderScreenStudioExport`, `avatarStudio.js: render2dMascotVideo`) podlegają Resource Governorowi i używają `runGovernedFfmpeg`. Static guard w `noUngovernedFfmpeg.test.js` sprawdza każde wywołanie `spawn`/`spawnSync`/`execFile`/`exec` w 7 kluczowych plikach i wymaga dopasowania do allowlisty.
2. **Blokery B3 & B4 (Uczciwość dokumentacji spawnu):** Spawny w modułach poza zakresem Fazy 4 (`storyBridge.js:319`, `pipeline.js:95`, `repurposeRunner.js:374`, `cleanerBridge.js:152`, `mcp/lib/vfxService.js:28`) oraz synchroniczny rasteryzator Chrome (`rendererAdapter.js:402`) zostały uczciwie odnotowane w `STATUS.md` i `INVENTORY.md` §3/§3.1 jako `remaining` wraz z technicznymi przyczynami odłożenia (ochrona WIP innych agentów, brak detached process group, synchroniczny generator planu `buildFfmpegArguments`).
3. **Uwaga I5 (Grupa procesowa i cancel w renderExport):** Sprawdzanie ocalałych procesów w grupie procesowej za pomocą `pgrepGroup` (`pgrep -g <pgid>`) włączone do testów cancel i timeout. Dodano testy `RendererAdapter.renderExport` sprawdzające anulowanie przez `adapter.cancel(renderId)` i przekroczenie czasu przez `timeoutMs` ze zwolnieniem dzierżawy i usunięciem pliku.
4. **Item 3 & Uwagi I6, I7 (Capability-aware H.264 encoder, -crf i realne eksporty):** `selectH264Encoder` zachowuje `-preset` i `-crf`. Test w `ffmpegCapabilities.test.js` wykonuje realne krótkie eksporty bezpośrednio przez `RendererAdapter.renderExport` dla `libx264` i `h264_videotoolbox`, weryfikując `result.encoder.name` i metadane `ffprobe`.
5. **Item 2 & Bloker B1 (Weryfikacja UI z Cancel):** Przebieg `node tests/ui_verify.mjs` zrealizowany w realnej instancji przeglądarki Chrome z uruchomionym serwerem Next.js. Wszystkie 10 scenariuszy zakończone statusem sukcesu, zrzuty 01–10 zapisane w `.tmp/vidmyo-v2.6/ui/`, serwer dev zatrzymany.
6. **Item 4 (Decyzje dokumentowe 2026-09-25):** Zapisano decyzje o buildzie LGPL FFmpeg macOS arm64 oraz odrzuceniu wymogu PSNR ≥ 35 dB.



---

## CZĘŚĆ I: STAN BIEŻĄCY — WERYFIKACJA ZAKRESU FAZY 3

### Runda poprawek po review Fazy 3 (2026-09-24) — komendy, exit codes, wyniki

Recenzja: 1 ustalenie **blokujące** (panel Promo nie pokazywał `unsupported`), 4 rekomendowane. Wszystkie 5 rozliczone poniżej.

| Komenda | Exit | Wynik |
|---|---|---|
| `node --test packages/core/test/promoRenderOutcome.test.js packages/core/test/homeIsolation.guard.test.js` | 0 | **17/17 pass** (~4,3 s) — 8 testów buildera wiadomości + panel (source), 9 testów guard (w tym 2 nowe: temp-pattern w `exports/`/`artifacts/`) |
| `node --test packages/core/test/rendererAdapter.test.js packages/core/test/edgToHyperframes.test.js packages/core/test/hyperframesAdapter.test.js packages/core/test/mascotTreeKill.test.js` | 0 | **25/25 pass** (15,9 s) — regresja po zmianie napisów i `projectDir` |
| `node --test packages/core/test/promoBridge.test.js` | 0 | **10/10 pass** (20,3 s) — klientowskie `jobId` honorowane; `jobId: '../escape'` odrzucone (`Invalid job id`) |
| `npm --prefix packages/core test` | 0 | **540/540 pass, 0 fail** (81,5 s), **guard PASS**: `no marked file reached the real home, no temp-pattern file under exports/ or artifacts/`; drukowane reguły: `/vidmyo-home-/i`, `/VIDMYO_TEST_RUN/`, `/vidmyo-home-uwlDCj/i` |
| `npm run lint` | 0 | **0 błędów, 14 ostrzeżeń (legacy)** — identycznie jak baseline |
| `node .tmp/vidmyo-v2.6/ui_verify.mjs` | 0 | **verdict: pass**, **7/7 scenariuszy**, `consoleErrors.other = []`; scenariusze 6/7 (nowe) potwierdzają blok `render-unsupported` na sukcesie (`2 cech EDG: crossfade, zoom` + `Sukces! … nieobsługiwane cechy EDG (2)`) i na błędzie (`Błąd renderu: … (1): crossfade`), a także `cancel-render-export` w trakcie trwającego eksportu |
| `graphify update .` | 0 | AST **453/453** pliki; **2838 węzłów, 6044 krawędzi, 223 społeczności** |

- Logi: `.tmp/vidmyo-v2.6/review-fix-{core-test,lint,ui-verify,graphify}.log`; UI: `.tmp/vidmyo-v2.6/ui-verify-report.json` + `ui/06-promo-unsupported-success.png`, `ui/07-promo-unsupported-error.png`.
- **R1 (blokujące):** wiadomości sukcesu i błędu buduje wspólny `promoRenderOutcome` (`packages/studio/src/promoExportModel.mjs`); panel czyta oba kształty odpowiedzi mostka (`res.unsupported ?? res.result.unsupported`, `err.unsupported`) i renderuje osobny blok z liczbą i nazwami cech. Status, który twierdził, że panel już to raportował, poprawiony (wiersz 4 tabeli Fazy 3).
- **R3:** katalog `projectDir` podany przez wywołującego nigdy nie jest usuwany (`callerOwnedProjectDir`); test w `hyperframesEdgRender.test.js` asertuje przetrwanie katalogu wywołującego i usunięcie katalogu auto-tworzonego.
- **R4:** pliki w `exports/` i `artifacts/`, których nazwa/ścieżka pasuje do wzorców temp bieżącego przebiegu, są **naruszeniem** nawet bez markera; `jobs/` i `governor/` pozostają tylko markerowe. W realnym `~/.vidmyo` dzisiejszy przebieg: 0 naruszeń, 0 notatek.
- **Granice (uczciwie):** scenariusze UI 6/7 używają zastubowanego `window.promo.renderExport` → `UI unverified (Electron)` dla samego IPC; realna ścieżka HyperFrames z `unsupported[]` pozostaje pokryta testami renderującymi. Brak realnego urządzenia/konta = nieweryfikowane. Nie publikowano, nie pobierano, nie instalowano, nie uruchamiano płatnych generacji.
- **Nie zrobiono commita ani checkpoint ref** — obsługuje MAIOX.


### Faza 3 — zamknięcie (close-out, 2026-09-24)

| Komenda | Exit | Wynik |
|---|---|---|
| `npm --prefix packages/core test` | 0 | **530/530 pass, 0 fail** (~70 s z realnymi renderami HyperFrames); guard **PASS** |
| `npm run lint` | 0 | **0 błędów, 14 ostrzeżeń** (legacy) |
| `graphify update .` | 0 | AST 451/451 plików; **2829 węzłów, 6028 krawędzi, 221 społeczności** (poprzednio Faza 2: 2747/5880/217) |
| `docs/pipeline-protection.md` (przegląd) | — | dotyczy granic przekazywania danych agentom i OAuth; **nie dotyczy** `VIDMYO_HOME` ani macierzy zdolności FFmpeg → świadomie nie zmieniano |

- Logi: `.tmp/vidmyo-v2.6/phase3-final-{core-test,lint,graphify}.log`.
- **Granice pomiarów Fazy 3 (uczciwie):**
  - `libass`: `unit-only-real-libass-unverified` — brak `--enable-libass` w lokalnym buildzie.
  - `cancelProcessTree` z 3-sekundową eskalacją SIGTERM→SIGKILL: mierzony na fixture z `trap '' TERM`; regresja Fazy 2 sprawdzona (27/27).
  - UI: scenariusze 3/4/5 używają **zastubowanego** IPC — zweryfikowany jest render kontrolki, nie Electron.
  - HyperFrames vs FFmpeg: PSNR 30,97–34,60 dB (**wymagane ≥ 20**), SSIM 0,987–0,990 (**wymagane ≥ 0,85**); próg raportowany PSNR ≥ 35 dB **niespełniony** (0/3) — zapisano jawnie.
  - Brak realnego urządzenia/konta usługi = nieweryfikowane; nie publikowano, nie pobierano, nie instalowano.
- **Nie zrobiono commita ani checkpoint ref** — obsługuje MAIOX.

### Faza 3, item 5 — UI verification web (2026-09-24)

| Komenda | Exit | Wynik |
|---|---|---|
| `node .tmp/vidmyo-v2.6/ui_verify.mjs` | 0 | **verdict: pass** — 5/5 scenariuszy OK, **0 błędów konsoli** (kategoria „other" = 0; kategoria „electron bridge" = 0), 5 zrzutów |
| serwer | — | 1× `next dev` na losowym wolnym porcie, `VIDMYO_HOME` = katalog tymczasowy, `NEXT_TELEMETRY_DISABLED=1`; po teście **grupa procesowa zabita** (brak `next dev` i brak headless Chrome w `pgrep`) |
| przeglądarka | — | 1× puppeteer-core 25.12.0, `executablePath = resolveChromeBinary()` = `/Applications/Google Chrome.app/.../Google Chrome` — **nic nie pobierano** |

**Scenariusze i kontrolki (`/studio?panel=…`, dev-only flag):**

| # | Ekran | Kontrolki sprawdzone | Status |
|---|---|---|---|
| 1 | PromoReviewStudio (`?panel=marketing`) | `[data-testid=renderer-select]` z `ffmpeg` (domyślny) i `hyperframes` (opt-in); przycisk „Wybierz audio narracji" (mascot audio picker); sekcja eksportu | zweryfikowane |
| 2 | CartoonStudio (przełącznik Marketing → 🎬 Cartoon Studio) | `[data-testid=cartoon-renderer-select]` `ffmpeg`/`hyperframes`; przycisk „Export MP4" | zweryfikowane |
| 3 | PromoReviewStudio — linia zdolności FFmpeg | `[data-testid=ffmpeg-capabilities]` renderuje **realny probe lokalnego FFmpeg**: „FFmpeg 8.1.1 · system · licencja GPL-3.0-or-later · napisy — drawtext: nie, libass: nie, overlay: tak" | **UI unverified (Electron)** dla samego IPC (`window.promo.ffmpegCapabilities` w teście zastubowany) |
| 4 | AutoEditorPanel (`?panel=autoeditor&dir=…`) | 4 suwaki hipotez (próg 0,72 / rotacja 30 dni / padding 150 ms / zoom 1,15x), etykieta „hipotezy konfigurowalne", disclaimer „mierzone, nie gwarantowane", sekcja „Odrzucone wpisy rejestru B-roll" z dokładnymi powodami (mrr/plr blocked, brak proof), echo „Backend otrzymał: próg … rotacja … padding … zoom …" | **UI unverified (Electron)** dla IPC (`window.autoEditor` zastubowany) |
| 5 | PublisherQueuePanel (`?panel=publisher`) | stany kolejki `queued` / `uploading` / `processing` / `published` / badge „Anulowano", przycisk „Ponów", kontrolka postępu uploadu | **UI unverified (Electron)** dla IPC (`window.publisher` zastubowany) |

- Zrzuty: `.tmp/vidmyo-v2.6/ui/{01-promo-review-studio,02-cartoon-studio,03-ffmpeg-capabilities,04-auto-editor-panel,05-publisher-queue-panel}.png` (wszystkie różne md5).
- Raport maszynowy: `.tmp/vidmyo-v2.6/ui-verify-report.json` (kontrolki, `electronPath` per scenariusz, błędy konsoli).
- **Dev-only flag (udokumentowany):** ekrany Promo/Cartoon/Auto-Editor/Publisher nie są osiągalne z poziomu raila (`TABS` nie zawiera `marketing`; Auto-Editor i Publisher żyją w CleanerReview wymagającym projektu/Electron). W `components/StandaloneShell.js` dodano `?panel=marketing|promo|cartoon|autoeditor|publisher` (+ `?dir=`) **wyłącznie przy `NODE_ENV !== 'production'`**. To jedyna dodana droga — wcześniej żadna nie istniała.
- **Uczciwie:** ścieżki IPC (`window.promo`, `window.autoEditor`, `window.publisher`) **nie są** liczone jako zaliczone — odnotowane jako „UI unverified (Electron)" w raporcie. Zaliczone są: render kontrolki, ich wartości domyślne i renderowane stany/etykiety.
- **Bez pobierania:** użyto już zainstalowanego Chrome; brak `playwright install` / pobierania przeglądarek.
- **Uwaga techniczna:** `next dev` blokuje zasoby dla origin `127.0.0.1` (brak `allowedDevOrigins`) — skrypt używa `http://localhost:<port>`; `next.config.mjs` **nie był** modyfikowany.

### Faza 3, item 4 — EDG → HyperFrames (2026-09-24)

Progi zapisane w PLAN **przed pomiarem**: strukturalnie (canvas, 30 fps, h264+aac 48000, Δczas ≤ 1 klatki + 0,02 s, Δklatek ≤ 1, brak zamrożeń przez `freezedetect`) + **wymuszane** PSNR ≥ 20 dB ORAZ SSIM ≥ 0,85; raportowane tylko SSIM ≥ 0,97 i PSNR ≥ 35 dB.

| Komenda | Exit | Wynik |
|---|---|---|
| `node --test packages/core/test/edgToHyperframes.test.js` | 0 | **5/5 pass**: timing z absolutnych klatek przy 60 fps / 6000 klatek (odchylenie < 1e-9 na każdym klipie, suma duracji = absolutny total), kopiowanie po hashu (bity identyczne), `unsupported` (speedlines, transform:rotate, caption-transform-x, audio-asset-type, transition:wipe_left) + **strict rzuca `EDG_UNSUPPORTED`**, escape HTML (`<script>` nie przeżywa, dokładnie 1 `</script>`), odrzucenie niezgodnego aspectu |
| `node --test packages/core/test/hyperframesEdgRender.test.js` | 0 | **2/2 pass (~43 s)**: realne render y EDG→HyperFrames **oraz** EDG→FFmpeg dla 16:9, 9:16 i 1:1 (każdy 4 s) |
| `npm --prefix packages/core test` | 0 | **530/530 pass, 0 fail**; guard **PASS** |
| `npm run lint` | 0 | **0 błędów, 14 ostrzeżeń** |
| `node --test rendererAdapter.test.js edgToHyperframes.test.js hyperframesEdgRender.test.js` | 0 | regresja Fazy 2 zielona (metadata-only HYPERFRAMES zachowane) |

**Zmierzone wartości (`.tmp/vidmyo-v2.6/hf-edg-render-evidence.json`):**

| Aspect | PSNR dB (≥20 wym.) | SSIM (≥0,85 wym.) | Δczas (≤0,0533 s) | Δklatki (≤1) | Zamrożenia | HF / FFmpeg czas |
|---|---|---|---|---|---|---|
| 16:9 1280×720 | **34,41** | **0,98811** | 0 | 0 | 0 s / 0 s | 7,4 s / 4,3 s |
| 9:16 720×1280 | **30,97** | **0,987212** | 0 | 0 | 0 s / 0 s | 7,1 s / 4,1 s |
| 1:1 960×960 | **34,60** | **0,990119** | 0 | 0 | 0 s / 0 s | 7,5 s / 3,7 s |

- Wszystkie 3 proporcje: h264 + aac **48000 Hz**, 30/1 fps, identyczny canvas — **wymagania strukturalne i podobieństwo spełnione**.
- **Uczciwie (próg raportowany):** SSIM ≥ 0,97 spełniony we wszystkich 3; **PSNR ≥ 35 dB NIE** spełniony (30,97–34,60 — inny rasterizer: Chrome vs `zoompan`/`overlay-png`, osobne kodowanie x264). Próg 35 dB był tylko raportowany.
- **Cancel:** `pgid` drzewa = root HyperFrames; przechwycony potomek `hyperframes/dist/renderSetupWorker.js` (ta sama grupa) → po `promo:cancel-render-export`: **0 ocalałych** (`pgrep -g <pgid>` pusty), job `cancelled`, `leaseToken=null`, `leases/` pusty, drugi render (FFmpeg) dopuszczony od razu (**3396 ms**).
- Obsługiwane cechy EDG w konwerterze: video, image, caption, zoom, fade/crossfade, audio z `data-volume`. Nieobsługiwane → `unsupported[]` (strict rzuca, render zwraca listę). Nigdy cicho nie pomijane. **Korekta po review:** w chwili zamknięcia Fazy 3 listę pokazywał tylko `CartoonStudio`; `PromoReviewStudio` dopiero w rundzie poprawek R1 (patrz wyżej) — dziś oba panele pokazują liczbę i nazwy cech na sukcesie i na błędzie (potwierdzone scenariuszami 6/7 `ui_verify.mjs`).
- **FFmpeg pozostaje domyślny**; HyperFrames jest opt-in w `PromoReviewStudio` i `CartoonStudio`. Whitelist `renderer ∈ {ffmpeg, hyperframes}` w `promo:render-export` i `promo:render-cartoon-export`; brak `EDG→HTML` nie jest już fail-closed.
- **Granica:** edytorskie EDG z klipami B-roll/audio-track wskazującymi asset wideo są w `unsupported` (`audio-asset-type:video`) — zgłoszone jawnie; FFmpeg je ignoruje (ścieżka legacy mapuje tylko `0:a?`).

### Faza 3, item 3 — FFmpeg capability detection (2026-09-24)

| Komenda | Exit | Wynik |
|---|---|---|
| `node --test packages/core/test/ffmpegCapabilities.test.js` | 0 | **10/10 pass**: pełny build (drawtext+libass+overlay, GPL-3.0), build LGPL bez libass, build bez `drawtext`, brak binarki → `FFMPEG_MISSING` z `brew install ffmpeg`/`VIDMYO_FFMPEG_PATH`, cache per path+mtime (2 spawn / odczyt, `forceRefresh` = +2), `captionPlan` 4-way z powodami, `hasFilter`/`libassAvailable` z raportu, `escapeFfmpegFilterPath`, `buildAssSubtitleFile` (czas 1/30 s = 0:00:00.03 — z absolutnej klatki), realny probe |
| `.tmp/vidmyo-v2.6/ffmpeg-capabilities.json` | — | **realny probe**: `/opt/homebrew/bin/ffmpeg`, source `system`, **8.1.1**, `licenseClass: GPL-3.0-or-later` (`--enable-gpl --enable-version3`), **brak** `--enable-libass`, `filters: {drawtext:false, subtitles:false, ass:false, overlay:true}`, 481 filtrów |
| `npm --prefix packages/core test` | 0 | **523/523 pass, 0 fail**; guard **PASS** |
| `npm run lint` | 0 | **0 błędów, 14 ostrzeżeń** |
| `node --test rendererAdapter.test.js ffmpegCapabilities.test.js hyperframesCompare.test.js` | 0 | **23/23 pass** (regresja Fazy 2 po podmianie `hasFilter` na raport zdolności) |

- Log: `.tmp/vidmyo-v2.6/phase3-item3-run.log`.
- **Decyzja pakowania FFmpeg (P11) zapisana w PLAN jako „Pending decision":** systemowy / LGPL / GPL+libass; `ffmpeg-static` jest GPL; **nic nie jest bundlowane** — decyzja Luke'a.
- **Uczciwie:** ścieżka `libass` (`subtitles=filename=...`) jest **unit-only** — lokalny build nie ma libass, real render niemożliwy bez zmiany builda. Brak realnego renderu libass = nieweryfikowane, nie „pass".
- **Bez sieci:** żadnego pobierania ani dodania binarki FFmpeg.

### Faza 3, item 2 — mascot cancel tree-kill (2026-09-24)

| Komenda | Exit | Wynik |
|---|---|---|
| `node --test packages/core/test/mascotTreeKill.test.js` | 0 | **4/4 pass**: (1) fałszywy FFmpeg (shell) forkuje `sleep 60` → po `promo:cancel-2d-mascot` **oba PID-y ESRCH < 5 s**, job `cancelled`, `leaseToken=null`, `leases/` pusty, drugi render dopuszczony od razu; (2) odmowa governora → `/Resource limit reached for class 'heavy'/` i `spawnImpl` nigdy nie wywołany; (3) stderr tail w komunikacie błędu; (4) `cancelProcessTree`: `trap '' TERM` przeżywa SIGTERM, **SIGKILL po ~3 s** zabija całe drzewo, lease zwolniony |
| `node --test governor.multiprocess.test.js governor.test.js hyperframesAdapter.test.js` | 0 | **27/27 pass** — brak regresji Fazy 2 po zmianie `cancelProcessTree` |
| `node --test promoBridge.test.js avatarStudio.test.js` | 0 | **16/16 pass** (w tym `render-2d-mascot cancel → cancelled + lease released`, `governor admission refusal`, render z realnym FFmpeg) |
| `npm --prefix packages/core test` | 0 | **513/513 pass, 0 fail**; guard **PASS** |
| `npm run lint` | 0 | **0 błędów, 14 ostrzeżeń** |

- Log: `.tmp/vidmyo-v2.6/phase3-item2-run.log`.
- Granica pomiaru: eskalacja mierzona zegarkowo (elapsed ≥ 2500 ms wymuszony w teście); brak realnego "twardego" procesu ignorującego SIGTERM poza fixture.

### Faza 3, item 1 — test isolation (2026-09-24)

| Komenda | Exit | Wynik |
|---|---|---|
| `node --test packages/core/test/homeIsolation.guard.test.js` | 0 | **7/7 pass** (VIDMYO_HOME/HOME kontrakt, marker, injekcja dirów w 4 mostkach, escape `path.relative`, **tamper self-test: child process pisze oznaczony plik do prawdziwego `~/.vidmyo/jobs` → guard `ok=false` → usunięcie → `ok=true`**, stubowany `app.getPath('userData')` → realny render ląduje w `userData/exports`) |
| `npm --prefix packages/core test` (run 1/2/3, finalny stan) | 0 / 0 / 0 | **509/509 pass, 0 fail** przy każdym przebiegu; guard: **PASS / PASS / PASS**, 0 oznaczonych plików w prawdziwym `~/.vidmyo` |
| `npm run lint` | 0 | **0 błędów, 14 ostrzeżeń** (legacy) |

- Logi: `.tmp/vidmyo-v2.6/phase3-item1-run{1,2,3}.log`.
- Kontrakt: `HOME` **nie jest** nadpisywane (kazy puppeteer/HyperFrames/FFmpeg/Chrome); izonomia przez `VIDMYO_HOME` + `VIDMYO_TEST_RUN` (marker `VIDMYO_TEST_RUN=<uuid>` stampowany w job recordach, lease'ch governora i kolejce publikacji).
- Guard: fail wyłącznie na **nowe/zmienione** wpisy w `~/.vidmyo/{jobs,exports,governor,artifacts}` i `publisher-queue.json` z markerem w treści; pozostałe różnice raportowane jako notatki (live app / inne agenty).
- Zakres watch: `jobs/`, `exports/`, `governor/`, `artifacts/`, `publisher-queue.json`.

### Phase 3 baseline (2026-09-24)

| Komenda | Exit | Wynik |
|---|---|---|
| `git rev-parse HEAD` / `git branch --show-current` | 0 | `4e559e00e527ec7ecf29c585b4ca26daba125793`, `SAI-22-local-agent-providers` |
| `git status --porcelain \| wc -l` | 0 | **278** (baseline Fazy 3; WIP innych agentów zachowany) |
| `git diff --stat > .tmp/vidmyo-v2.6/phase3-baseline.txt` | 0 | 73 wiersze snapshotu |
| `npm --prefix packages/core test` | 0 | **502/502 pass, 0 fail** (~50 s) — `.tmp/vidmyo-v2.6/phase3-baseline-test.log` |
| `Maiox/.tmp/vidmyo-phase3-scope.txt` (odczyt) | 0 | 5 pozycji scope = pozycje 1–5 planu (zgodne 1:1) |

Środowisko: macOS arm64, Node v25.4.0, Homebrew FFmpeg 8.1.1 (`--enable-gpl --enable-version3`; `ffmpeg -buildconf` **nie zawiera** `libass`, `libfreetype`, `libharfbuzz` ani `fontconfig` → brak filtrów `drawtext`/`subtitles`/`ass`), `puppeteer-core` obecny w `node_modules`, `/Applications/Google Chrome.app` obecny.

---

## CZĘŚĆ I (Faza 2): STAN BIEŻĄCY — WERYFIKACJA ZAKRESU FAZY 2

### Runda poprawek po review (2026-09-24) — komendy, exit codes, wyniki

Recenzja Fazy 2 wymagała naprawy pozycji 6 (brak napisów po stronie FFmpeg): zaimplementowano i zweryfikowano ścieżkę `overlay-png` (brak sieci, lokalny Chromium, nakładanie przez filtr `overlay` z czasem `enable`). Po naprawach:

| Komenda | Exit | Wynik |
|---|---|---|
| `node --test packages/core/test/rendererAdapter.test.js` | 0 | **11/11 pass** (w tym test jednostkowy planu `overlay` z `enable` i czasami klatek oraz test jawnych statusów napisów `applied`/`unavailable`/`none`) |
| `node --test packages/core/test/hyperframesCompare.test.js` | 0 | **2/2 pass** (~36 s) — side-by-side z napisami `applied` po obu stronach na wszystkich 3 proporcjach, testem widoczności napisów w regionie kadru i proweniencją progów |
| `node --test packages/core/test/autoEditorBridge.test.js packages/core/test/publisher.test.js packages/core/test/publisher.offline.test.js packages/core/test/publisherBridge.test.js` | 0 | regresja Phase 1 + item 4 zielona |
| `node --test` (zestaw 6 plików: hyperframesCompare, rendererAdapter, autoEditorBridge, publisher, publisher.offline, publisherBridge) | 0 | **49/49 pass** |
| `npm --prefix packages/core test` | 0 | **502/502 pass, 0 fail** (~44 s) |
| `npm run lint` | 0 | **0 błędów, 14 ostrzeżeń** (legacy, niezmiennie) |
| `npm run build` | 0 | Next.js 16.3.2 Turbopack, strony statyczne + dynamiczne wygenerowane |
| `graphify update .` | 0 | 441/441 plików AST; **2747 węzłów, 5880 krawędzi, 217 społeczności** |

**Poprawka R1 — napisy na stronie FFmpeg (item 6):**
- **Ścieżka `overlay-png`:** w `packages/core/src/rendererAdapter.js` wdrożono pełną obsługę napisów bez `drawtext`: każdy klip napisów jest zamieniany bez sieci przez lokalny headless Chromium (`rasterizeCaptionPng`) na przezroczysty PNG w rozdzielczości canvasu z wycentrowanym tekstem, a następnie nakładany w FFmpeg przez `overlay=0:0:enable='between(t,start,end)'` z czasami wyprowadzonymi z EDG.
- **Wybór ścieżki i wykrywanie filtrów:** naprawiono regex w `hasFilter` (`[TSC.]{2,4}` zamiast `{3}`), dzięki czemu filtr `overlay` (flagi `TS` w FFmpeg 8.1.1) jest poprawnie wykrywany. `captionPlan` preferuje `drawtext`, gdy jest dostępny; przy jego braku, gdy dostępny jest `overlay` i Chromium, wybiera `overlay-png` ze statusem `applied` (`renderMode: 'overlay-png'`). Status `unavailable` występuje tylko wtedy, gdy obie ścieżki są niemożliwe.
- **Weryfikacja w teście compare:** w `hyperframesCompare.test.js` na obu silnikach (HF i FFmpeg) wymagany i uzyskany jest status `captions.status === 'applied'` dla wszystkich 3 proporcji (9:16, 1:1, 16:9). Wdrożono asercję widoczności napisów w regionie kadru (`captionRegionHash` na dolnym pasie 136px): kadr podczas napisu (t=1.0) różni się od kadru po napisach (t=3.9) na wyjściu FFmpeg oraz na wyjściu HyperFrames.
- **Test jednostkowy planu:** dodano dedykowany test w `rendererAdapter.test.js` potwierdzający generowanie filtru `overlay=0:0:enable='between(t,0.500,1.500)'` oraz wejść `-loop 1` z podłączonym plikiem PNG.
- **Dowody i pomiary:** `node --test packages/core/test/hyperframesCompare.test.js` → exit 0; `.tmp/vidmyo-v2.6/hf-compare-evidence.json` zawiera nowe zmierzone wartości PSNR i SSIM z nałożonymi napisami po obu stronach.

**Poprawka R2 — crash recovery kolejki (item 4):**
- **Kod:** `packages/core/src/publisher.js`:
  - `PublishRecordStore.load()` — startup reconciliation: rekord na dysku w `uploading` → `queued` z `recoveredAt` (zachowane: `resumableUploadUrl`, `bytesUploaded`, `error=null`); `processing` bez `remoteVideoId` → `queued` (nie da się go odpytać); `processing` z `remoteVideoId` zostaje (jest pollable przez `publisher:poll`). Zmiana jest zapisywana do pliku.
  - `retry()` — akceptuje teraz także `uploading` (re-queue bez duplikatu; wznowienie przez `queryUploadStatus`).
  - Duplicate guard **bez zmian** — odzyskany rekord nie jest zgłaszany ponownie przez `create()`; wznawiany jest istniejący rekord.
  - **Uczciwie o mechanizmie wznowienia:** reconciliacja przy starcie jest automatyczna (load), ale samo wznowienie transferu następuje przez istniejący przepływ kolejki — UI (przycisk „Test Mock Upload" dla `queued`, „Ponów" dla `error`/`cancelled`/odzyskanego) lub `retry()` → `executeUploadSession` → `queryUploadStatus`. Nie ma i nie była tworzona cichej auto-publikacji przy starcie aplikacji.
- **Kod:** `electron/lib/publisherBridge.js` — `getRecordStore` buduje trwały store: domyślnie `app.getPath('userData')/publisher-queue.json` (konwencja jak `story-config.json`/`google-oauth.json`), `deps.queuePath` do testów (explicit `null` = in-memory; bez `app` w runnerze Node store zostaje in-memory). Dzięki temu kolejka **naprawdę przeżywa restart aplikacji**, a reconciliacja wykonuje się przy starcie mostka.
- **Nowy test (process kill):** `publisher.offline.test.js` → `offline: process kill mid-upload leaves \`uploading\` on disk; store load recovers it and resumes without duplicate initiate`: upload startuje, chunk 1 zapisuje się na dysk, „kill" symulowany zawieszeniem requestu chunku 2 i odcięciem staremu store'owi dostępu do pliku (`persistPath = null`); nowa instancja store → rekord `queued` + `recoveredAt` + URL/`bytesUploaded=10` zachowane + `getPendingJobs()=1`; wznowienie: `statusQueries ≥ 1`, `initiates = 1` (bez duplikatu POST), zakresy `bytes 0-9/45` (nie powtarzany) i `bytes 10-19/45`, stan końcowy `processing`, pełny odbiór 45 B; kolejny restart widzi `processing`.
- **Nowy test (bridge):** `publisherBridge.test.js` → `publisherBridge persists the queue to disk and recovers a record killed mid-upload at startup`: `existsSync(userData/publisher-queue.json)`, symulacja killu przez zapis `uploading` na dysk, „restart" = nowa instancja mostka → `publisher:list-queue` zwraca rekord `queued` z `recoveredAt`; `publisher:retry` idempotentny; duplicate guard nadal blokuje ponowne zgłoszenie tego samego pliku.
- **Zaktualizowane asercje:** `publisher.test.js` — test persist/restart teraz wymaga odzyskania `uploading`→`queued` (postęp i URL zachowane, rekord persistuje stan odzyskany); nowe testy: retry z `uploading`, reconciliacja `processing` (bez `remoteVideoId` → odzyskany; z `remoteVideoId` → zachowany).
- **Dowody:** `node --test publisher.test.js publisher.offline.test.js` → **19/19 pass, exit 0**; `node --test publisherBridge.test.js` → **5/5 pass, exit 0**.
- **Granice:** brak wywołań produkcyjnego YouTube; transport produkcyjny nadal fail-closed; wszystkie fetch'e testów z asercją hosta loopback.

**Poprawka R3 — STATUS.md:** sprzeczne sekcje oznaczone jako historia Fazy 1 (banner + opisy „nadpisane przez Fazę 2"), blocker „Brak paczki @heygen/hyperframes" przepisany (pin 0.8.72 + realne blokady), jedna bieżąca tabela obszarów odłożonych/zablokowanych (Screen Studio HW, production YouTube, Windows, NLE, LivePortrait/lipsync, MRR/PLR, captions FFmpeg, EDG→HTML, P11).

### Faza 2, item 1 — B-roll licence-field enforcement (2026-09-24)
- **Zmiany:** `packages/core/src/broll.js` — nowa funkcja `validateBrollLicenseFields(entry)` wymaga: `id`, `fileHash` (≥8), `redistributionRight === true`, `source` (niepusty), dowodu licencji (`licenseProofUrl` http/https **lub** `licenseProofDoc` ścieżka), `license` dokładne równanie kodu z `APPROVED_LICENSE_CODES` (cc0/pexels/pixabay/coverr — dokładne dopasowanie, nie podłańcuch; „dowolna licencja z manifestu" odrzucana), MRR/PLR (`mrr`/`plr`/`commercial_mrr_plr`) zablokowany komunikatem o braku dokumentu redystrybucji. `loadBrollRegistry` partycjonuje manifest na `clips` (zaakceptowane) + `rejected` (z dokładnymi powodami) zamiast crashować; wpisy bez pól nie trafiają do kandydatów. `MediaLicenseRegistry.register` egzekwuje te same pola (odrzucone wpisy z listą powodów w błędzie). Builtin CC0 sample zyskały pełne pola (`redistributionRight`, `source: 'vidmyo-builtin'`, `licenseProofDoc: 'packages/core/src/broll.js'`). `autoEditorBridge.js` zwraca `registry.rejected`; `AutoEditorPanel.jsx` renderuje sekcję „Odrzucone wpisy rejestru B-roll" z dokładnymi powodami per wpis.
- **Dowody:**
  - `node --test packages/core/test/broll.test.js packages/core/test/autoEditorBridge.test.js` → **19/19 pass, exit 0** (w tym: `loadBrollRegistry accepts a fully documented manifest and rejects incomplete entries with exact reasons`, `autoEditorBridge surfaces rejected registry entries with exact licence reasons`, `MediaLicenseRegistry enforces approved licences plus redistributionRight, source and proof of licence`, `validateBrollLicenseFields accepts a complete entry and rejects each missing field with an exact reason`, `loadBrollRegistry builtin CC0 sample passes its own licence validation`).
  - `npm run lint` → exit 0, **0 błędów**, 14 ostrzeżeń (legacy).

### Faza 2, item 2 — Retention/Hooks hypothesis labels (2026-09-24)
- **Zmiany:** `AutoEditorPanel.jsx` — 4 suwaki konfigurowalne (próg 0.50–0.95, rotacja 7–90 dni, padding 0–800 ms, zoom 1.00–1.50x), etykieta sekcji „hipotezy konfigurowalne — do zmierzenia na Twoich danych, nie udowodnione reguły", stopka „mierzone, nie gwarantowane; nie są dowodem uniknięcia kar algorytmicznych", oraz renderowanego echa „Backend otrzymał: próg … · rotacja … · padding … · zoom …". `handleGetSuggestions` wysyła wszystkie 4 wartości. `autoEditorBridge.js` (`autoEditor:get-suggestions`) waliduje zakresy (`threshold [0,1]`, `rotationDays [1,365]`, `paddingMs [0,2000]`, `zoomFactor [1,3]`), odrzuca poza zakresem jasnym błędem, echo wartości w `params` oraz `retention.{rotationDays,paddingMs,zoomFactor}`; `HookRotationRegistry` konfigurowany `rotationDays` z UI.
- **Dowody:**
  - `node --test packages/core/test/autoEditorBridge.test.js` (w zbiorze item 1–2) → **19/19 pass, exit 0**, w tym:
    - `autoEditorBridge get-suggestions applies hypothesis defaults and echoes backend-received params` — domyślne `{threshold:0.72, rotationDays:30, paddingMs:150, zoomFactor:1.15}`, nadpisanie `{0.55,14,250,1.22}` dociera do backendu i jest echoowane, poza zakresem (`threshold 1.5`, `rotationDays 0`) → `ok:false` z komunikatem.
    - `AutoEditorPanel sends all four hypothesis params to the backend and labels them as hypotheses` — panel źródłowo zawiera `threshold: brollThreshold` + `rotationDays, paddingMs, zoomFactor`, etykietę hipotez i echo backendu.
  - `node --test packages/core/test/retention.test.js` → **4/4 pass, exit 0** (regresja HookRotationRegistry/rotation ok).
  - `npm run lint` → exit 0, 0 błędów.

### Faza 2, item 3 — Governor 3-surface test (2026-09-24)
- **Zmiany:** nowy `packages/core/src/governedProcess.js` — `runGovernedProcess({jobId, resourceClass, cmd, args, governor, timeoutMs, signal, spawnImpl, ...})`: admisja **przed** spawnem (odmowa → `spawnImpl` nigdy nie wywołany), `detached:true` (własna grupa procesów), timeout/anulowanie → `governor.cancelProcessTree` (SIGTERM→SIGKILL na `-pgid`, wnuki wliczone), lease zwalniany dopiero po zdarzeniu `exit`, idempotencja per `jobId` (acquire governora). Eksport w `packages/core/index.js`.
- **Nowy test `governor.multiprocess.test.js` (4 scenariusze):**
  1. **3 osobne procesy** (`electron_main` przez JobStore.admit, `cli`/`mcp` przez ResourceGovernor — ten sam kod) startujące jednocześnie przez wspólny plik `go` na **izolowanym `mkdtemp`**: bariera light (każdy trzyma 2 lease = 6 light jednocześnie), heavy bez nakładania się okien (asercja `start[i+1] >= end[i]`), wszystkie exit 0, skan `defaultGovernorDir()` na obecność `runId` → pustota (katalog domyślny nietknięty).
  2. **Anulowanie drzewa:** rodzic (detached) + wnuk; `ps -axo pid,pgid,command` przed: 2 wiersze, oba `pgid == parent`; po `cancelProcessTree`: `psAfter: []`, oba PIDs martwe, lease 0.
  3. **Timeout realnego spawnu:** `timeoutMs:600` → `elapsedMs:609`, reject `code:ETIMEDOUT`, rodzic+wnuk martwi, lease 0.
  4. **Odmowa przy niskim dysku:** `minFreeDiskBytes=1000TB` → błąd `Insufficient disk space`, `spawnInvoked:false`.
- **Dowody (komendy + exit codes zapisane w `.tmp/vidmyo-v2.6/governor_3surface_evidence.json`):**
  - `node --test packages/core/test/governor.multiprocess.test.js` → **4/4 pass, exit 0** (~1.5 s).
  - Exit codes procesów powierzchni: `{electron_main: 0, cli: 0, mcp: 0}`.
  - `node --test packages/core/test/governor.test.js packages/core/test/jobs.test.js packages/core/test/run.test.js` → **exit 0** (regresja Phase 1 zielona).
  - `npm run lint` → exit 0, 0 błędów.
  - *Ograniczenie:* ścieżka Windows (`taskkill`) objęta istniejącym testem jednostkowym mock — status `untested-on-this-host`.

### Faza 2, item 4 — Persistent publish queue offline (2026-09-24)
- **Zmiany:**
  - `publisher.js`: nowy stan `PUBLISH_STATES.CANCELLED`; `cancel()` ustawia `cancelled` (nie `error`), `retry()` działa z `cancelled` i `error`; duplicate check dopuszcza ponowne zgłoszenie po `cancelled`; transport `createYouTubeResumableTransport` zyskał `baseUrl` (domyślnie produkcyjny Google — testy podają loopback) oraz `signal` w `initiate/uploadChunk/queryUploadStatus/checkProcessingStatus`; adapter `YouTubePublisherAdapter` prowadzi `AbortController` per rekord + `cancelUpload()`, sprawdza `isCancelled()` przed/po każdym chunku (cancel wygrywa wyścig z `updateState(UPLOADING)`), AbortError → stan `cancelled` bez nadpisania `error`.
  - Nowy `packages/core/src/publisherMock.js` — loopback mock realnego protokołu resumable: POST initiate z `Location`, PUT z `Content-Range: bytes X-Y/Z` → akumulacja + **308 + `Range`** do kompletności → 200 `{id}`, status query `bytes */Z` → 308/200, kontrolki testowe `rejectTokens` / `quotaOnNextChunk` / `stallNextChunk` + statystyki (`contentRanges`, `statusQueries`, `initiates`, `abortedWhileStalled`). Zakładany wyłącznie na `127.0.0.1`.
  - `publisherBridge.js`: `test-mock-upload` używa **realnego** `createYouTubeResumableTransport` z `baseUrl: mockBaseUrl` (loopback wymuszony walidacją) i token providers z vault (`createVaultTokenProviders` — `getAccessToken`/`refreshAccessToken` przez `googleOAuth.accessToken()`/`refresh()`; statyczny token testowy tylko jako fallback ścieżki mock); rejestr `activeAdapters` — `publisher:cancel` wywołuje `adapter.cancelUpload()` (abort in-flight) zamiast samego `store.cancel`; lokalny mock server bridge zbudowany na tym samym protokole 308/Content-Range + kontrolki.
  - `PublisherQueuePanel.jsx`: badge „Anulowano" dla `cancelled`, przycisk „Ponów" dla `error|cancelled`, obsługa `res.cancelled` w mock upload.
- **Dowody (`node --test packages/core/test/publisher.offline.test.js packages/core/test/publisher.test.js packages/core/test/publisherBridge.test.js` → 20/20 pass, exit 0):**
  1. `offline: multi-chunk upload sends sequential Content-Range and handles 308 until complete` — 5 chunków (45 B / 10 B), `contentRanges` = `bytes 0-9/45 … bytes 40-44/45`, initiates=1, `yt_http_*`, 48 kHz N/A (plik binarny).
  2. `offline: queue survives restart and resumes from bytesUploaded without duplicate initiate` — run1 z padnięciem sieci po 1. chunku (persist `resumableUploadUrl`+`bytesUploaded=10`, state `error`), **nowa instancja store** (restart), `retry`→`queued`, run2: `statusQueries≥1`, `initiates` dalej **1** (brak duplikatu POST), zakresy kontynuowane od `bytes 10-19/45`, completeteżn 45 B.
  3. `offline: cancel aborts the in-flight HTTP request and record ends in cancelled` — serwer trzyma chunk otwarty (`stallNextChunk`), `cancelUpload` → rekord `cancelled` (error=null), serwer obserwuje `abortedWhileStalled≥1` (abort na poziomie HTTP), durable reload → `cancelled`, `retry`→`queued`.
  4. `offline: 403 quotaExceeded maps to the existing quota handling` — `state=queued`, `error` match `/quota exceeded/i`.
  5. `offline: 401 triggers the injected refresh provider exactly once` — `rejectTokens={'stale-token'}` → refresh wywołany **dokładnie 1×**, `unauthorized=1`, upload kończy się `processing`.
  6. `offline: production transport fails closed` — budowa transportu bez `getAccessToken` rzuca wyjątek; adapter bez transportu → `error` + „No publisher transport configured".
  7. `publisher:cancel aborts an in-flight mock upload through IPC and ends in cancelled` (bridge) — cancel przez IPC w trakcie wstrzymanego uploadu → `cancelled:true`, rekord `cancelled`, `abortedWhileStalled≥1`, 0 ukończonych filmów.
  - **Guard sieciowy:** każdy fetch w testach przechodzi przez wrapper assertujący host ∈ {127.0.0.1, localhost} — realne YouTube niemożliwe.
  - **Regresja Analytics:** `node --test packages/core/test/channelsBridge.test.js packages/core/test/youtubeAnalytics.test.js packages/core/test/googleOAuth.test.js` → **exit 0**.
  - `npm run lint` → exit 0, 0 błędów.
  - *Transport produkcyjny:* pozostaje nieaktywny — brak IPC publikującego na domenę Google; `baseUrl` produkcyjny osiągalny tylko z explicit token provider; testy zawsze loopback.

### Faza 2, item 5 — Managed model packages Kokoro/ASR (2026-09-24)
- **Zmiany:** nowy `packages/core/src/modelPackages.js`:
  - `validatePackageManifest` — wymaga `name` (regex `[a-z0-9][a-z0-9._-]*`), `version`, `sha256` (64-hex), `license`, `sourceUrl` (http/https); `status: 'manifest-pending'` ⇒ strukturalnie poprawny placeholder, ale **nieinstalowalny**.
  - `BUILTIN_MODEL_CATALOG`: `kokoro-tts`, `whisper-asr` — oba `manifest-pending` z `version/sha256/license/sourceUrl = null` ( nic nie zmyślone; notatka wyjaśnia, co trzeba zweryfikować).
  - `ModelPackageManager({packagesDir, fetchImpl, catalog})`:
    - `install` — odrzuca pending **przed siecią**, waliduje manifest przed siecią, pobiera do `*.part`, wznawia przez `Range: bytes=N-` (206 append / 200 restart / 416 ⇒ jednokrotny reset part-file), weryfikuje SHA-256 strumieniowo, dopiero potem atomowy `rename` + receipt (tmp+rename). Mismatch checksum ⇒ kasuje zatruty `.part`, brak finalnego pliku i receiptu. Idempotentne: zweryfikowany pakiet wraca bez HTTP.
    - `verify` — re-hash pliku vs receipt (wykrywa podmianę).
    - `uninstall` — rekurencyjny `rm` katalogu pakietu; drugie wywołanie `removed:false`.
    - `status` — `known/pending/installable/installed/verified` + dane receiptu; pakiet zainstalowany z explicit manifestu (poza katalogiem) traktowany jako `known` dzięki receiptowi.
  - Eksport w `packages/core/index.js`.
- **Dowody (`node --test packages/core/test/modelPackages.test.js` → 9/9 pass, exit 0):**
  1. Walidacja: pełne pola OK; brak `version`/`sha256`(64-hex)/`license`/`sourceUrl` ⇒ dokładne powody; pending ⇒ `{ok:true,pending:true}`.
  2. Katalog Kokoro/ASR: oba pending, `sha256/version/sourceUrl/license === null` (brak wymyślonych checksum/wersji).
  3. Install+verify+uninstall na loopback fixture (48 KiB): SHA-256 zgodny, receipt z name/version/sha256/licence/URL, brak `.part`, verify wykrywa podmianę (append 0x00 ⇒ `checksum mismatch`), reinstall po podmianie przywraca stan, `status.installed/verified/installable`, uninstall kasuje katalog, drugi uninstall `removed:false`.
  4. **Wznowienie:** pierwsze pobieranie zrywa socket po 8 KiB z 32 KiB (`dropAfterBytesOnce`) ⇒ `install` odrzuca (błąd sieci), `.part` przetrwał (`0 < size < total`); drugie pobranie wysyła `Range: bytes=<size>-` (assert nagłówka z logu serwera), `resumedFromBytes === partialSize`, finalny SHA-256 zgodny, `.part` zrenamowany.
  5. Zła checksuma (`'a'*64`) ⇒ `Checksum mismatch`, usunięty `.part`, brak final+receipt.
  6. Pending Kokoro/ASR ⇒ `refusing to install`, **0 wywołań fetch** (fetchImpl licznikowy).
  7. Invalid manifest / unknown name ⇒ `Invalid package manifest` / `Unknown model package`, 0 fetch.
  8. Idempotent: 2. install bez HTTP (`requests` serwera bez zmian).
  9. HTTP 404 ⇒ `HTTP 404`, brak final+receipt.
  - Serwer fixture: loopback `127.0.0.1`, obsługa `Range`→206+`Content-Range`, 416 poza zakresem, opcjonalny drop mid-body; małe pliki (1–48 KiB); **bez dużych realnych pobrań**.
  - `npm run lint` → exit 0, 0 błędów.

### Faza 2, item 6 — Real HyperFrames adapter + side-by-side (2026-09-24)
- **Instalacja (jedyny dozwolony ruch sieciowy Fazy 2):** `npm install --save-exact hyperframes@0.8.72` → exit 0; `package.json`: `"hyperframes": "0.8.72"` (exact), `package-lock.json`: `integrity sha512-MSxjylnxtEn7rIL6CzdPbM5ze5ZtuCf1rGtqnkzdsOqst0TQ1Xx1ZZ9WuWGzj3LJCezQzt07OU7/MdtUGxCcyw==`, licencja Apache-2.0. WIP w `package.json`/`package-lock.json` innych agentów zachowany (punktowe diffy). Globalny CLI 0.7.107 **nie** jest używany — adapter rozwiązuje wyłącznie lokalny `node_modules/hyperframes` (weryfikacja dokładnej wersji).
- **Adapter `renderers/hyperframesAdapter.js`:** `HYPERFRAMES_PINNED='0.8.72'`; `resolveHyperframesPackage()` — brak pakietu → dokładny błąd; wersja ≠ pin → `version mismatch` (fail-closed, testowane); `renderComposition()` — `node <cli> render <dir> -o out -f 30 -q looks --quiet` przez `runGovernedProcess` (admisja governora, detached pgid, timeout 300 s, lease zwalniany po `exit`), env `HYPERFRAMES_NO_TELEMETRY=1 NO_UPDATE_CHECK=1`, wyjście walidowane (istnieje, >0 B).
- **RendererAdapter FFmpeg — ścieżka multi-scene (nowa; legacy identyczna jak Faza 1):** 2 klipy wideo + `edg.transitions` → `xfade` (crossfade/dissolve/wipe_left/wipe_right/dip_to_black) albo `concat` (cut); obrazy PNG loopowane `-loop 1 -framerate -t`; zoom przez `zoompan` (FFmpeg 8.1 `crop` ma option `eval`, ale build 8.1.1 go nie udostępnia — zweryfikowano empirycznie: crop+z niedostępne, zoompan działa); audio mix `volume+aresample+aformat(sample_fmts!) → amix normalize=0`; napisy: `captionPlan` preferuje `drawtext`, a przy jego braku wykorzystuje `overlay-png` (offline rasteryzacja headless Chromium do przezroczystego PNG w rozdzielczości canvasu + `overlay=0:0:enable='between(t,start,end)'`), status `applied`; >2 klipy → dokładny błąd unsupported. Ścieżka HYPERFRAMES w `renderExport(execute:true)` → błąd „wymaga projektu HTML" (EDG→HTML niezaimplementowane; **FFmpeg pozostaje domyślny**).
- **Testy adaptera:** `node --test packages/core/test/hyperframesAdapter.test.js` → **5/5 pass, exit 0** (pin found; mismatch fail-closed; missing fail-closed z autorytarnym root; brak index.html; brak outputPath).
- **Side-by-side (progi zapisane w PLAN.md PRZED pomiarem — Faza 2: PSNR ≥ 20 dB, SSIM ≥ 0.85, |Δdur| ≤ 1 klatka + 0.02 s, |Δframes| ≤ 1, audio 48000; plan syntetyczny podawał 35 dB / 0.97 — patrz jawne ustalenie R1 powyżej):**
  - Komenda: `node --test packages/core/test/hyperframesCompare.test.js` → **2/2 pass, exit 0** (~36 s).
  - Scena na oba silniki: obraz (gradient PNG w rozdzielczości canvasu), zoom liniowy 1.0→1.08, crossfade 2.0–2.5 s, mix audio 2 torów (0.4/0.6) — HF: HTML + **lokalny timeline shim (plain JS, bez GSAP, bez CDN)**, FFmpeg: EDG multi-scene. **Napisy:** HF renderuje je jako węzły HTML; strona FFmpeg renderuje je przez `overlay-png` (lokalny headless Chromium, brak sieci). Na obu silnikach status napisów to `applied` na wszystkich 3 proporcjach. Widoczność napisów zweryfikowano porównaniem hashy klatek w oknie napisów vs poza nim na obu wyjściach.
  - **Wyniki zmierzone** (pełne komendy, exit codes, hashe klatek i statusy napisów: `.tmp/vidmyo-v2.6/hf-compare-evidence.json`):

    | aspect | PSNR (HF vs FFmpeg) | SSIM | Δczas trwania | klatki HF/FFmpeg | napisy HF | napisy FFmpeg |
    |---|---|---|---|---|---|---|
    | 9:16 | **35.36 dB** | **0.9958** | 0 s | 120/120 | applied (HTML) | applied (overlay-png) |
    | 1:1 | **33.55 dB** | **0.9937** | 0 s | 120/120 | applied (HTML) | applied (overlay-png) |
    | 16:9 | **36.91 dB** | **0.9964** | 0 s | 120/120 | applied (HTML) | applied (overlay-png) |

  - **Progi — rozliczenie:** próg Fazy 2 (20 dB / 0.85) zaliczony na wszystkich aspectach. Próg syntetycznego planu (35 dB / 0.97): SSIM ≥ 0.97 zaliczone wszędzie; **PSNR ≥ 35 dB zaliczone w 9:16 i 16:9; 1:1 = 33.55 dB (z napisami po obu stronach)**. Zgodnie z PHASE SCOPE **nie przełączano domyślnego renderera — FFmpeg pozostaje domyślny**; pin hyperframes fail-closed bez zmian.
  - ffprobe stream checks na obu wyjściach dla każdego aspectu: h264 wideo, AAC audio, **48000 Hz**, wymiary canvasu (1080×1920 / 1080×1080 / 1920×1080), `r_frame_rate=30/1`; hashe klatek t=1.0 ≠ t=3.0 (ruch/zoom/przejście potwierdzone na obu wyjściach); governor lease = 0 po renderze (pierwszy aspect renderowany z aktywnym governorem).
  - `hyperframes doctor` → all checks passed (lokalny Chrome cache, FFmpeg 8.1.1, bez sieci); render z `HYPERFRAMES_NO_TELEMETRY/HYPERFRAMES_NO_UPDATE_CHECK`, `media.autoProxy=false`.
- `npm run lint` → exit 0, 0 błędów.

### Faza 2 — finalny pełny przebieg PRZED rundą review (2026-09-24; stan historyczny — ostateczne liczby po poprawkach review w sekcji „Runda poprawek po review" na górze Części I)
- **Regresja wykryta i naprawiona (jedyna w Fazie 2):** pełny test `autoEditorBridge.render-preview` (2 klipy wideo z tego samego assetu, bez transition — kształt z Fazy 1) trafiał w nową ścieżkę multi-scene i padał na `distinct assets`. Naprawienie: `useMultiScene = transitions.length > 0` (wieloklipowe EDG bez transition zachowują dokładne zachowanie Fazy 1), plus gałąź `split=2` dla wspólnego assetu z transition, plus najdłuższy `-t` dla współdzielonego obrazu. Weryfikacja: `node --test autoEditorBridge hyperframesCompare rendererAdapter` → **23/23 pass, exit 0**.
- **Pełny zestaw testów (przed poprawkami review):** `npm --prefix packages/core test` → **496 testów, 496 pass, 0 fail, exit 0** (~32 s). **Po poprawkach review: 501/501 pass, exit 0** (5 nowych testów: captions status w rendererAdapter, process kill mid-upload w publisher.offline, durable+recovery w publisherBridge, retry z `uploading` oraz reconciliacja `processing` w publisher.test).
- **Lint:** `npm run lint` → **exit 0, 0 błędów**, 14 ostrzeżeń (legacy kod — niezwiązane z Fazą 2).
- **Graf wiedzy (przed poprawkami review):** `graphify update .` → **exit 0**; surowe wyjście:
  ```text
  Re-extracting code files in . (no LLM needed)...
    AST extraction: 441/441 files (100%)
  [graphify watch] Rebuilt: 2739 nodes, 5855 edges, 220 communities
  [graphify watch] graph.json, graph.html and GRAPH_REPORT.md updated in graphify-out
  Code graph updated.
  ```
  (Faza 1: 2675/5756/216 → Faza 2: 2739/5855/220 → **po poprawkach review: 2744/5869/217**, ostatni przebieg w sekcji „Runda poprawek".)
- **Granice Fazy 2 zachowane:** brak commit/push/deploy; brak wywołań produkcyjnego YouTube; jedyny ruch sieciowy = instalacja `hyperframes@0.8.72`; sekrety niewypisywane; WIP innych agentów nienaruszony (przed każdą edycją `git diff -- <plik>`, wyłącznie edycje punktowe).

### 1. Rzetelność Statusów i Rejestr Blokad (sekcja historyczna Fazy 1 — statusy nadpisane przez Fazę 2 i rundę review)
Zgodnie z zasadą fail-closed oraz uwagami recenzenta, żaden etap nie jest oznaczany jako `completed`, jeśli nie posiada pełnego pokrycia testowego i weryfikacji sprzętowej:
- **P1 EDG & Czas:** `implemented-awaiting-verification` (deterministyczny test dryfu na realnych mediach mierzy onsety markerów błysku i dźwięku w trzech punktach 30-minutowego strumienia przy 30 i 60 fps).
- **P2 Governor:** *(Faza 1: odłożony test wieloprocesowy → **Faza 2 item 3: `completed`, `governor.multiprocess.test.js` 4/4**)*.
- **P3 Renderer:** `partial` (stabilny FFmpeg compositor; `ffmpeg-simple` z `version: '1.0.0'`; **Faza 2: paczka hyperframes@0.8.72 przypięta i zmierzona; pozostaje EDG→HTML i captions FFmpeg `blocked(ffmpeg build lacks drawtext)`**).
- **P8 Screen Studio:** `implemented-awaiting-hardware-verification` (kod adaptera, korelacji PTS i zegara kursora oraz zbierania kliknięć wdrożony; brak fizycznego TCC i pętli BlackHole w CI).
- **P9 Avatar Studio:** `partial` (fallback 2D Mascot z dynamiczną obwiednią RMS zdekodowaną z pliku narracji, probowaniem długości audio, błędem przy braku pliku, syntetycznym tonem jako fallback, przyciskiem wyboru audio i anulowania w UI, obsługą braku bridge'a, wymuszeniem odmowy admisji w Governorze przed spawnem FFmpeg oraz gwarancją pierwszeństwa stanu `cancelled` i zwolnienia slotu; modele Wav2Lip i LivePortrait zablokowane komercyjnie/licencyjnie).
- **P10 Auto-Publisher:** `implemented-offline + blocked-external` (wznawialny upload i anulowanie przetestowane lokalnie na serwerze mock; publikacja produkcyjna zablokowana przez audyt Google App Review, quotę i wymóg jawnej zgody użytkownika).
- **NLE Export:** `unverified-import` (pliki FCPXML 1.9 i Premiere XML v4 generowane zgodnie ze schematem; import w komercyjnych pakietach NLE niezweryfikowany na tej maszynie roboczej).
- **B-roll MRR/PLR:** `blocked (no licence document)` (brak dokumentu licencji redystrybucyjnej; dozwolone wyłącznie zweryfikowane klipy CC0 lub jawnie wskazane przez użytkownika).
- **Weryfikacja UI:** `UI unverified` (automatyczne przejście screenshotowe przez Electron i testy end-to-end odłożone do kolejnej fazy; zweryfikowano poprawność kompilacji Next.js oraz brak błędów lintera).

---

> [!NOTE]
> Sekcje 2–6 poniżej to **archiwum dowodów z Fazy 1** (uruchomienia, komendy i liczby z tamtej rundy). Stan bieżący: patrz „Runda poprawek po review" i sekcje item 1–6 Fazy 2 na górze Części I.

## 2. Uczciwy Renderer (Wycofanie roszczeń HyperFrames i fałszywych porównań side-by-side) — historia Fazy 1
- **Korekty wykonane w kodzie:**
  1. W pliku `packages/core/src/rendererAdapter.js`:
     - Komentarz nagłówkowy: `Supports deterministic FFmpeg assembly, real FFmpeg execution, and ffmpeg-simple baseline (HyperFrames migration remaining)`.
     - Neutralny bazowy konstruktor sceny: `buildSceneConfig(edg, outputPath, opts)` generuje neutralną strukturę sceny bez żadnego przypisanego silnika ani wersji (`engine: undefined`, `version: undefined`).
     - Metoda `buildFfmpegSimpleConfig(edg, outputPath, opts)` opiera się na `buildSceneConfig` i dodaje jednoznaczne metadane `engine: 'ffmpeg-simple'` oraz `version: '1.0.0'`.
     - Metoda `buildHyperFramesConfig(edg, outputPath, opts)` opiera się na `buildSceneConfig` i zwraca placeholder metadanych z `engine: 'hyperframes'` oraz `migrationStatus` (**Faza 1: `remaining` bez paczki; Faza 2: `pinned` + `version: '0.8.72'` — patrz item 6 na górze**).
     - Metoda `compareRenderPipelines(edg, opts)` została zredukowana wyłącznie do statycznego sprawdzenia metadanych (`comparisonType: 'metadata_only'`); usunięto gałąź `executeComparison` oraz wszelkie roszczenia o porównaniu renderów „side-by-side” czy parytecie jakościowym z HyperFrames.
     - W `buildFfmpegSimpleArguments` etykietę filtra drawtext zmieniono z `hf_cap` na `simple_cap`.
     - Samodzielne testy renderowania `adapter.renderExport(..., { execute: true })` testują niezależnie silniki `ffmpeg` i `ffmpeg-simple` dla formatów 9:16, 1:1 i 16:9, zapisując pliki `_simple.mp4` i manifesty `.simple.json` (usunięto nazwy `_hyperframes.mp4` oraz sprawdzanie `.hyperframes.json`).
     - Bezpośrednie wywołanie `RENDERER_TYPES.HYPERFRAMES` rzuca jawny błąd informujący o braku przypiętej paczki `@heygen/hyperframes` w `package.json`.
- **Dowód testowy:**
  - Komenda: `node --test packages/core/test/rendererAdapter.test.js`
  - Kod wyjścia: `0`
  - Wynik: 9/9 testów zdanych (w tym asercja neutralnego `buildSceneConfig`, `simpleConfig.engine === 'ffmpeg-simple'`, `simpleConfig.version === '1.0.0'`, `comparisonType === 'metadata_only'` oraz odrzucenie wykonania HyperFrames z błędem braku paczki).

---

## 3. Avatar 2D Fallback: Preload, Governor, Cancel i UI
- **Korekty wykonane w kodzie:**
  1. **Mostek Electron Preload (`electron/preload.js`):**
     - Dodano brakujące metody w obiekcie `contextBridge.exposeInMainWorld('promo', ...)`:
       - `pickAudio: () => ipcRenderer.invoke('promo:pick-audio')`
       - `cancel2dMascot: (jobId) => ipcRenderer.invoke('promo:cancel-2d-mascot', jobId)`
     - Dodano test jednostkowy weryfikujący, że każdy handler `promo:*` zarejestrowany w `promoBridge.js` posiada odpowiadające wywołanie w `electron/preload.js`.
  2. **Interfejs Użytkownika (`PromoReviewStudio.jsx`):**
     - W metodzie `handlePickMascotAudio` dodano jawne wyświetlanie błędu środowiska (`Błąd środowiska: Desktop bridge 'promo.pickAudio' jest niedostępny`), gdy obiekt bridge nie jest zainicjalizowany.
     - Dodano metodę `handleCancel2dMascot` z obsługą błędów bridge'a.
     - Generator zadania tworzy identyfikator `jobId` przed wywołaniem renderowania, dzięki czemu w trakcie renderowania dostępny jest przycisk `Anuluj Render 2D`.
  3. **Wymuszenie reguły Governora „jedna ciężka operacja” (`promoBridge.js`):**
     - W procedurach `promo:render-2d-mascot`, `promo:render-export`, `promo:render-cartoon-export` oraz `promo:render-screen-studio-export`:
       - Po wywołaniu `const runningJob = store.setState(job.id, 'running')` weryfikowany jest stan zadania.
       - Gdy Governor odmawia transmisji (np. zajęty slot `heavy`), zadanie przechodzi w stan `error` z komunikatem `Governor admission denied`.
       - Mostek IPC natychmiast przerywa wykonanie i zwraca `{ ok: false, error: ... }`, nie uruchamiając procesu FFmpeg.
     - Dodano test asercji: przetrzymanie slotu `heavy` blokuje `render-2d-mascot` i zwraca odmowę bez uruchomienia podprocesu.
  4. **Prawidłowe zakończenie stanu anulowania (`promoBridge.js`):**
     - W `promo:cancel-2d-mascot` kolejność operacji zapewnia brak wyścigu (race condition): najpierw pobierany jest `JobStore` i wywoływane jest `store.cancel(jobId)`, a dopiero w następnym kroku wysyłany jest sygnał SIGTERM do procesu potomnego.
     - W bloku `catch` procedury renderującej sprawdzany jest bieżący stan zadania: jeżeli zadanie zostało anulowane (`currentJob.state === 'cancelled'`), mostek zwraca `{ ok: false, cancelled: true }` i **nie wywołuje** `store.setState(job.id, 'error')`.
     - Zapobiega to rzuceniu wyjątku `Illegal transition cancelled → error`, gwarantuje że stan `cancelled` pozostaje ostatecznym stanem zadania, a token dzierżawy Governora zostaje prawidłowo zwolniony.
- **Dowód testowy:**
  - Komenda: `node --test packages/core/test/avatarStudio.test.js packages/core/test/promoBridge.test.js`
  - Kod wyjścia: `0`
  - Wynik: 16/16 testów zdanych:
    - `preload exposes every promo:* handler registered in promoBridge`
    - `render-2d-mascot respects governor admission: refuses render when heavy slot is held`
    - `render-2d-mascot cancel transitions to cancelled state and releases governor slot`
    - `extractAudioEnvelope decodes PCM from real audio and computes per-frame RMS and mouth openness`
    - `render2dMascotVideo fails with error if supplied audioPath does not exist`
    - `render2dMascotVideo falls back to synthetic tone when no audio is requested and labels source`
    - `render2dMascotVideo decodes audio from real file, computes envelope dynamically, probes duration, and animates mouth`

---

## 4. Deterministyczny Test Braku Dryfu Czasowego na Realnych Mediach
- **Korekty wykonane w kodzie:**
  1. **Generowanie deterministycznego fixtura VFR:**
     - Wideo: czarne tło `color=c=black:s=64x36:d=1800:r=60` z białym błyskiem przez 50 ms co sekundę (`drawbox=...color=white:enable='lt(mod(t,1),0.05)'`) oraz nieregularnymi znacznikami VFR (`select='not(eq(mod(n,5),0))'`).
     - Audio: fala sinusoidalna 1000 Hz o długości 1800 s z bramką głośności (`volume=0:enable='gte(mod(t,1),0.05)'`), tworząca 50 ms ton testowy na początku każdej sekundy i ciszę przez pozostałe 950 ms.
     - Sprawdzono niejednorodność interwałów klatek w fixturze (`uniqueIntervals.size > 1`).
     - *Uwaga techniczna:* Ponieważ filtr VFR odrzuca co 5. klatkę (`mod(n,5) == 0`), klatka przy dokładnie $t = 2.0$ s ($n = 120$) zostaje pominięta w surowym strumieniu VFR. Z tego powodu margines przy punkcie kontrolnym $t = 2$ s dla 60 fps jest ciasny, jednak normalizacja osi czasu w `RendererAdapter` mapuje PTS bezbłędnie i test przechodzi rygorystyczny warunek różnicy A/V $\le 1$ klatki ($\le 16.7$ ms) bez żadnej dodatkowej tolerancji.
  2. **Eksport przez rurociąg Vidmyo (`RendererAdapter`):**
     - Obydwa eksporty (30 fps i 60 fps) wygenerowano z osi czasu EDG z normalizacją CFR oraz resamplingiem audio 48 kHz.
  3. **Weryfikacja onsetów zawartości (Marker Content Sync):**
     - W trzech punktach 30-minutowego pliku: na początku ($t = 2.0$ s), w środku ($t = 900.0$ s, 15 min) i na końcu ($t = 1798.0$ s, ~30 min):
       - Początek błysku wideo (`flashOnset`): wyznaczany na podstawie skoku luminancji (luma mean > 100 na filtrze `showinfo` FFmpeg).
       - Początek beepa audio (`beepOnset`): wyznaczany na podstawie końca ciszy (znacznik `silence_end` na filtrze `silencedetect=noise=-30dB:d=0.03` z fallbackiem na `astats` RMS).
       - Różnica czasu pomiędzy onsetem błysku a onsetem dźwięku: `Math.abs(flashOnset - beepOnset) <= 1.0 / targetFps` (ściśle `<= 33.3` ms przy 30 fps oraz `<= 16.7` ms przy 60 fps).
       - Całkowita różnica długości wideo i audio: `Math.abs(vDuration - aDuration) <= 1.0 / targetFps`.
     - Pliki eksportu i fixtury są natychmiast usuwane po teście.
- **Dowód testowy:**
  - Komenda: `node --test packages/core/test/timebase.test.js`
  - Kod wyjścia: `0` (czas: ~23 s)
  - Wynik: 7/7 testów zdanych.

---

## 5. Kompilacja i Jakość Kodu (Build & Lint)
- **Next.js Production Build:**
  - Komenda: `npm run build`
  - Środowisko: Next.js 16.3.2 (Turbopack)
  - Kod wyjścia: `0`
  - Czas kompilacji: 1310 ms; wygenerowano wszystkie strony statyczne (6/6) oraz trasy dynamiczne (`/studio/[[...slug]]`, `/workflow/[id]`, `/agents/[agent_id]`, `/api/...`).
- **ESLint Check:**
  - Komenda: `npm run lint`
  - Środowisko: ESLint 9 (`packages/studio/src`)
  - Kod wyjścia: `0` (0 błędów, 14 ostrzeżeń w legacy kodzie).
- **Status interfejsu użytkownika:** `UI unverified` (zgodnie z zakresem Fazy 1 automatyczne przejście screenshotowe przez Electron jest odłożone do kolejnej iteracji).

---

## 6. Stan Bazy Wiedzy Kodu (Graphify)
- **Komenda:** `graphify update .`
- **Kod wyjścia:** `0`
- **Raport wykonania:**
  ```text
  Re-extracting code files in . (no LLM needed)...
    AST extraction: 100/432 files (23%)
    AST extraction: 200/432 files (46%)
    AST extraction: 300/432 files (69%)
    AST extraction: 400/432 files (92%)
    AST extraction: 432/432 files (100%)
  [graphify watch] Rebuilt: 2675 nodes, 5756 edges, 216 communities
  [graphify watch] graph.json, graph.html and GRAPH_REPORT.md updated in graphify-out
  Code graph updated.
  ```
- **Komentarz do wyniku:** Narzędzie wykonało pełną ekstrakcję AST dla 432 plików (100%) i pomyślnie zaktualizowało bazę grafu wiedzy Vidmyo: 2675 węzłów, 5756 krawędzi. Operacja zakończona kodem 0.
- **Rozbieżność liczby społeczności:** Konsola `graphify update .` raportuje **216 społeczności** (linia `[graphify watch] Rebuilt: 2675 nodes, 5756 edges, 216 communities`), natomiast nagłówek wygenerowanego pliku `graphify-out/GRAPH_REPORT.md` podaje **84 communities detected**. Identyfikatory społeczności w treści raportu obejmują zakres 0–215 (co odpowiada 216). Prawdopodobna przyczyna rozbieżności: nagłówek raportu zlicza społeczności z odmiennym progiem (np. po scaleniu drobnych klastrów), podczas gdy konsola raportuje surową liczbę klastrów algorytmu Louvain/Leiden. Obie wartości są cytowane uczciwie; narzędzie nie oferuje flagi wyjaśniającej tę różnicę.

---

## CZĘŚĆ II: ARCHIWUM POPRZEDNICH RUND (HISTORIA CHECKPOINTÓW)

> [!NOTE]
> Poniższe sekcje dokumentują stan historyczny z poprzednich iteracji i służą jako zapis postępu, podczas gdy Część I odzwierciedla aktualny stan zweryfikowany w Fazie 1.

---

### Post-approval verification (Phase 2, 2026-09-24, Claude Code supervisor)

- Independent full run `npm --prefix packages/core test` after loop approval: **501/502 — 1 intermittent failure** (`promoBridge render-export routes through JobStore…`: "Governor admission denied … heavy 1/1 in use"). Root cause: `test/promoBridge.test.js` used the real shared governor directory (`~/.vidmyo/governor`, `defaultGovernorDir()`); one of its tests deliberately holds the single heavy slot there, so parallel test files (and a running Vidmyo app) could collide.
- Fix (test-only, production unchanged): each `harness()` injects a core whose `defaultGovernorDir()` returns a private `mkdtemp` directory; the heavy-slot-blocking and cancel/release tests use that same directory.
- Result: `node --test test/promoBridge.test.js` 10/10; full `npm --prefix packages/core test` **502/502 in 5 consecutive runs**, exit 0.
- Remaining isolation gap (not fixed, for a later phase): bridge tests without an Electron `app` fall back to `~/.vidmyo` for `jobs/` and `exports/`, so they still write to the real user data directory.

---

### Post-approval verification (Phase 3, 2026-09-25, Claude Code supervisor)

- The round-2 reviewer could not run the suite (sandbox denied npm test); approval rested on code inspection and saved logs, so the supervisor re-ran everything.
- Independent `npm --prefix packages/core test`: **539/540 in 2 runs — 1 deterministic failure**: `hyperframesEdgRender.test.js` "cancel mid-HyperFrames-render …" → "render tree must be alive before cancel". Diagnosis: the test waited for *any* descendant; the first to appear is a short-lived CLI helper that exits within milliseconds (seen in `ps` as `(node)`), and later descendants also come and go, so the "every snapshot PID alive" precondition raced. Not a cancel defect (the render comparison test in the same file passes).
- Fix (test-only): record every real live descendant seen while waiting; precondition = render root still running + ≥1 real descendant observed. Post-cancel assertions unchanged and still strict: every observed PID ESRCH, no survivor in the render's process group or with the export dir in its command line, job `cancelled`, lease released, next render admitted.
- Result: the file 4/4 runs green; full `npm --prefix packages/core test` **540/540 in 2 consecutive runs**, exit 0, home-isolation guard PASS; 0 files changed under the real `~/.vidmyo` during the runs; `npm run lint` 0 errors (14 legacy warnings).

---

### Post-approval verification (Phase 4, 2026-09-25, Claude Code supervisor)

- Independent `npm --prefix packages/core test`, unsandboxed: **564/564, exit 0, in 70 s and 73 s** (2 consecutive runs; no hang — the round-2 reviewer's >10 min run was inside its own sandbox), home-isolation guard PASS, 0 files changed under the real `~/.vidmyo`, `npm run lint` 0 errors (14 legacy warnings), no leftover ffmpeg / Chrome / `next dev` processes afterwards.

---

### Navigation fix (2026-09-25, Claude Code supervisor, after Luke's first app test)

- Luke's first test of the desktop app showed none of the V2.6 screens: the sidebar (`TABS` in `components/StandaloneShell.js`) still listed only the 9 old sections. `MarketingStudio` (which contains PromoReviewStudio — Screen Studio, 2D mascot, export/cancel — and CartoonStudio) was renderable but hidden from the rail as a "legacy studio", and `PublisherQueuePanel` was mounted only in the dev-only `?panel=` route used by the Phase 3 UI verification. Earlier reviews accepted "component renders" as "reachable in the app".
- Fix: added `Marketing` (Megaphone icon) and `Publish` (CloudUpload icon) to `TABS`; `activeTab === 'publisher'` renders `PublisherQueuePanel`. Auto-Editor (B-roll, retention hypotheses, NLE export) stays where it belongs: Cleaner → review of a processed project (`CleanerReview.jsx`).
- Verified in a browser against `next dev -p 3210`: sidebar shows Marketing and Publish; Marketing opens the V2.6 Promo & UGC Review Studio with a switcher to Cartoon Studio; Publish opens the Auto-Publisher queue; 0 console errors. `eslint components/StandaloneShell.js`: 0 errors (2 pre-existing `slug` hook warnings).

---

### Phase 5 merge-back into the main checkout (2026-09-26, Claude Code supervisor)

- Loop `8da75abf` (Phase 5) ran in worktree `maiox/loop-8da75abf` and was approved at code_review_4. Supervisor verification in the worktree: `npm --prefix packages/core test` 612/612, exit 0, guard PASS, 0 writes to the real `~/.vidmyo`.
- Merge: pre-merge snapshot `refs/checkpoints/vidmyo-v2.6-pre-phase5-merge`. 14 new files copied; 16 changed files copied after confirming each was byte-identical to `refs/checkpoints/vidmyo-v2.6-phase4` in main (no concurrent edits). `EVIDENCE.md` = worktree version + the main-only "Navigation fix" section. `components/StandaloneShell.js` = worktree version (adds Screen Studio) with the **Publish** tab restored at Luke's request (the worker had moved the queue only into Cleaner → review); `v26Features.mjs` publisher entry updated to `sidebarTab: 'publisher'` (Cleaner path kept as a second route).
- Verified in main: `npm run build:studio` (36 files); `npm --prefix packages/core test` **612/612**, exit 0, 80 s, guard PASS, 0 writes to `~/.vidmyo`; `npm run lint` 0 errors; browser check through the real sidebar (`next dev -p 3210`): Channels … VFX, Marketing, Screen Studio, Publish, Agents — Screen Studio shows native recording / demo mode and the macOS Screen Recording permission notice, Publish shows the Auto-Publisher queue, Marketing shows Promo/Cartoon; 0 console errors. Electron restarted (main.js/preload.js changed). A real recording awaits Luke's manual test (grant Screen Recording to Electron).
