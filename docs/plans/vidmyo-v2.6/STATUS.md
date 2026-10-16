# Vidmyo V2.6 — Status Realizacji i Checkpoint (2026-09-26, Faza 5 — runda poprawek po 2. review; realne nagranie **przechodzi** na tym Macu)

> [!IMPORTANT]
> Wszystko w tej rundzie znajduje się w **worktree MAIOX** (`data/agent-loop-worktrees/Vidmyo-8da75abf`), **nie w głównym checkoutcie Luke'a** — działająca aplikacja Luke'a nie zawiera tych zmian do momentu merge/scalenia. Alias `"studio"` w `jsconfig.json` (dodany w poprzedniej rundzie, by worktree rozwiązywał własne źródło) **zmienia rozwiązywanie modułów dla głównej aplikacji i musi zostać sprawdzony przed merge**.
>
> Poprzednia runda (1. review) naprawiła realny przepływ „nagranie → EDG → eksport MP4 z Cancel", ale **błędnie** uznała realne nagranie za `blocked-unverified-hardware` — probe hard-kodował `videoDeviceIndex: 0`, którym na tym Macu jest kamera (OBS Virtual Camera), a nie ekran. 2. review to wykrył; runda poniżej koryguje diagnozę i dowodzi realnego nagrania.

## Runda poprawek po 3. review Fazy 5 (2026-09-26) — bezpieczeństwo testów + brakujące testy

3. review zatwierdził przebieg Fazy 5, ale zgłosił 2 blokery (sygnały do realnych PID-ów hosta; brak testów timeout/cancel-drzewa/stop dla `startGovernedCapture`) i 4 uwagi. Wszystkie w zakresie Fazy 5 naprawione; Fazy 1–4 bez regresji.

| # | Ustalenie recenzenta | Naprawa | Weryfikacja |
|---|---|---|---|
| B1 | **SAFETY** — testy wysyłały realne sygnały (`SIGINT`/`SIGTERM`/`SIGKILL`) do arbitralnych PID-ów hosta przez fake `ee.pid` (`99901`/`99001`/`99002`) | `startGovernedCapture` przyjmuje `killImpl`/`livenessImpl`; `governor.cancelProcessTree` przyjmuje `livenessImpl`; wszystkie ścieżki sygnałów używają seamu; mostek przekazuje `deps.killImpl`/`deps.livenessImpl`; testy z fake PID-ami wstrzykują no-op stuby | `screenCapture.test.js`, `screenStudioBridgeIntegration.test.js` zielone; zero `process.kill` z fake PID-em |
| B2 | **Brak testów** — scope item 4 wymaga start/stop/cancel/timeout; brak testu timeoutu i dowodu tree-kill dla `startGovernedCapture` | Nowy `packages/core/test/screenCaptureGoverned.test.js` (realny fake-ffmpeg `detached:true` + grandchild) + seam `timeoutMs` | **3/3 pass**: cancel (`pgrep -g` pusty, plik usunięty, dzierżawa zwolniona), timeout (drzewo zabite, dzierżawa zwolniona, exit prawdziwy), stop (realny SIGINT, plik niepusty, dzierżawa po exit) |
| M1 | scenariusz 9 UI asertował `true` | Asercja na treści panelu `/Screen Studio/` | UI-verify 14/14 |
| M2 | `clickRail` bez sprawdzenia widoczności; rail obcinany przy 800 px | `scrollIntoView` + `boundingBox`-style visibility check + `setViewport(1440×900)` | UI-verify 14/14 |
| M3 | `handleCancelRecording` zawsze dispatchował sukces | Rozróżnia `cancelled:true` (sukces) od un-cancelled `ok:false`; akcja `CANCEL_RECORDING_FAILURE` + banner `data-testid="screen-studio-error"` | test reducera + UI |
| M4 | `screen:start-recording` przyjmował istniejący `jobId` | Odrzuca istniejący rekord JobStore lub plik w `recordingsDir` (`EJOB_EXISTS`) | test mostka „rejects a jobId that already exists" |

| Komenda | Exit | Wynik |
|---|---|---|
| `npm --prefix packages/core test` | 0 | **612/612 pass, 0 fail** (~79 s); guard izolacji domu **PASS**. Log: `.tmp/vidmyo-v2.6/phase5-fix3-core-test.log`. |
| `npm run lint` | 0 | **0 błędów, 14 ostrzeżeń legacy**. Log: `.tmp/vidmyo-v2.6/phase5-fix3-lint.log`. |
| `npm run build:studio` | 0 | **36 plików** (Babel). |
| `node tests/ui_verify.mjs` | 0 | **verdict: pass, 14/14 scenariuszy, 0 błędów konsoli**; `serverGroupGone: true`. Log: `.tmp/vidmyo-v2.6/phase5-fix3-ui-verify.log`; raport `.tmp/vidmyo-v2.6/ui-verify-report.json`. |
| `graphify update .` | 0 | **355/355 plików AST; 2581 węzłów, 5414 krawędzi, 156 społeczności**. Log: `.tmp/vidmyo-v2.6/phase5-fix3-graphify.log`. |

### Stan Fazy 5 po 3. rundzie poprawek

| Element | Status | Uwaga |
|---|---|---|
| Sekcja Screen Studio w sidebarze (`TABS`) | `completed` | `StandaloneShell.js`; render przez `nav[aria-label="Studios"]` |
| Realny flow nagrywania | `completed` | permission/picker/start-stop/cancel/timeout/telemetria/EDG/eksport/Finder |
| Realne nagranie na tym Macu | `completed` (verified) | `verdict: "pass"`, `Capture screen 0` (index 1), 2,8 s |
| Nagrywanie okien / wielomonitor / realne kliknięcia / Windows / restart Electrona | `remaining` / `unverified` | patrz tabela w sekcji „Elementy nieukończone" |
| Alias `jsconfig.json` `"studio"` | `must-check-before-merge` | worktree-only; wpływa na rozwiązywanie modułów w głównym checkoutcie |
| PUBLISH/PUSH/DEPLOY | `not-done` | zgodnie z zasadami MAIOX |

---

## Runda poprawek po 2. review Fazy 5 (2026-09-26) — naprawa blokera realnego nagrania

2. review Fazy 5 odrzucił `approved` twierdząc, że realny przepływ nagrywania jest nadal zepsuty, a diagnoza „blocked-unverified-hardware" nie wytrzymuje. **Recenzja miała rację.** Cztery blokery w zakresie Fazy 5 zostały naprawione:

| # | Ustalenie recenzenta | Naprawa | Weryfikacja |
|---|---|---|---|
| 1 | **Bloker — błędna diagnoza realnego nagrania:** `real_capture_probe.cjs:71` i `af_fps_probe.cjs:13` hard-kodowały `videoDeviceIndex: 0` / `-i 0:none` i nigdy nie wołały `listAvfoundationCaptureDevices()`. `stderr` pokazywał urządzenie z jednym trybem `1920x1080@[60 60]fps` — to kamera, nie „Capture screen N". | Probe **enumeruje urządzenia** i używa `screens[0].index`. `startGovernedCapture` czeka na realny start przechwytywania (`getCaptureT0Ms()`), potem 3 s zapisu; weryfikacja: strumień wideo, czas 3±0,5 s i `blackdetect`. Zablokowanie zgłaszane tylko, gdy **realne** urządzenie „Capture screen" zawiedzie (z `stderr`). | `electron .tmp/vidmyo-v2.6/real_capture_probe.cjs` → **`verdict: "pass"`**: urządzenia `[0] OBS Virtual Camera`, `[1] Capture screen 0`, `[2] Capture screen 1`; wybrany `index=1`; `durationSec=2.8` (tolerancja 2,5–3,5), `h264 1920x1080`, `blackdetect.detected=false`. Dowód: `.tmp/vidmyo-v2.6/real_capture_probe.json`. |
| 2 | **Bloker — zły domyślny wybór ekranu:** `screenStudioModel.mjs:54` ustawiał `selectedScreenIndex: 0`, a `SET_SOURCES` nigdy nie zmieniał go na pierwszy wyliczony ekran. Przy kamerze na indeksie 0 Record wskazywał kamerę albo kończył się `Unknown videoDeviceIndex`. | `SET_SOURCES` wybiera indeks pierwszego ekranu, gdy bieżący nie występuje w świeżej liście (pustej listy nie nadpisuje). | nowy test `screenStudioReducer: SET_SOURCES adopts the first enumerated screen when the current index is not in the list` (ekrany `[1,2]`, start 0 → 1) + test zachowania poprawnego wyboru/pustej listy. |
| 3 | **Bloker — mikrofon/dźwięk systemowy zawsze puste:** bridge `screen:list-sources` zwracał `audioDevices` (`screenStudioBridge.js:273`), a `ScreenStudio.jsx:51` czytał `sourcesRes.audio`; stub `ui_verify.mjs` zwracał oba klucze maskując błąd. | UI czyta `sourcesRes.audioDevices`; stub zwraca **wyłącznie** rzeczywisty kształt mostka (`audioDevices`). Dodano test kontraktu mostek→UI. | `screenStudioPreloadSurface.test.js` → `bridge -> UI list-sources contract: audioDevices key plus windows/BlackHole fields` pass; UI-verify: „microphone list is populated from audioDevices" (`["Brak mikrofonu","MacBook Microphone"]`). |
| 4 | **Bloker — wymagane pola pickera nie renderowane:** bridge zwracał `windows` (disabled + reason), `blackHolePresent` i `blackHoleInstructions`, ale `ScreenStudio.jsx` ich nie pokazywał. | UI dispatchuje i renderuje `windows` (lista disabled z podanym powodem), komunikat o braku BlackHole z instrukcją instalacji oraz potwierdzenie obecności BlackHole; selektor dźwięku systemowego filtruje urządzenia BlackHole. | UI-verify scenariusz 10: „BlackHole-absent message explains how to install it" + „windows render as disabled entries with a reason". |

### Runda poprawek po 2. review — weryfikacja (komendy, exit codes, wyniki)

| Komenda | Exit | Wynik |
|---|---|---|
| `electron .tmp/vidmyo-v2.6/real_capture_probe.cjs` | 0 | **`verdict: "pass"`** — realne nagranie `Capture screen 0` (`index=1`), `durationSec=2.8`, h264 1920×1080, `blackdetect` brak. Dowód: `.tmp/vidmyo-v2.6/real_capture_probe.json`. |
| `npm --prefix packages/core test` | 0 | **607/607 pass, 0 fail** (~91 s); guard izolacji domu **PASS**. Log: `.tmp/vidmyo-v2.6/phase5-fix2-core-test.log`. |
| `npm run lint` | 0 | **0 błędów, 14 ostrzeżeń legacy**. |
| `npm run build:studio` | 0 | **36 plików** (Babel). |
| `node tests/ui_verify.mjs` | 0 | **verdict: pass, 14/14 scenariuszy, 0 błędów konsoli**; `dev server process group gone: true`. Log: `.tmp/vidmyo-v2.6/phase5-fix2-ui-verify.log`; raport `.tmp/vidmyo-v2.6/ui-verify-report.json`. |
| `graphify update .` | 0 | **354/354 plików AST; 2573 węzłów, 5405 krawędzi, 156 społeczności**. Log: `.tmp/vidmyo-v2.6/phase5-fix2-graphify.log`. |

### Realne nagranie — skorygowany stan (dowód, nie „blocked")

- **TCC Screen Recording: `granted`** dla procesu Electron (probe, 2026-09-26).
- **Prawdziwa przyczyna poprzedniej porażki:** `videoDeviceIndex: 0` to kamera OBS, nie ekran. Ten Mac wylicza `[1] Capture screen 0` i `[2] Capture screen 1`; **oba akceptują żądany fps** (np. 30) — wcześniejsze „tylko 60 fps" dotyczyło kamery.
- **Wynik po naprawie:** realne, niepuste nagranie 1920×1080 h264 o czasie **2,8 s** (cel 3 s ±0,5), bez czarnych klatek; governed `startGovernedCapture` + `stop()` SIGINT zwracają `ok:true`, plik ~1,5 MB.
- **Wniosek:** pozycja „realne nagranie" jest **zweryfikowana na tym Macu** (nie „blocked"). Nagranie okien (`ScreenCaptureKit`) i wielomonitorowe mapowanie pozostają `remaining`/`unverified-on-hardware` (patrz tabela niżej).
- **Uwaga:** zapis MP4 przez SIGINT jest fragmentaryczny (`+frag_keyframe`), więc ogon pliku bywa obcięty, ale plik pozostaje odtwarzalny, a `ffprobe`/`blackdetect` działają — to zachowanie produkcyjne, nie artefakt testu.

## Runda poprawek po 1. review Fazy 5 (2026-09-26)

Recenzja Fazy 5 (odrzucona) zgłosiła 6 blokerów, 5 odchyleń planu i 1 uwagę dokumentacyjną. Wszystkie blokery i odchylenia w zakresie Fazy 5 zostały naprawione; realne nagranie pozostaje **zablokowane sprzętowo** i jest jawnie oznaczone (nie „pass").

| # | Ustalenie recenzenta | Naprawa | Weryfikacja |
|---|---|---|---|
| 1 | **Bloker — eksport zepsuty:** `ScreenStudio.jsx` wołał `renderExport` bez EDG; mostek zwracał `EDG timeline is required`; brak `buildEdg` w preload | `electron/preload.js` eksponuje `buildEdg` → `screen:build-edg`; `ScreenStudio.jsx` najpierw woła `buildEdg({jobId: recordingJobId,...})`, potem `renderExport({jobId, edgId, fps, width, height})`. Mostek **nie przyjmuje już EDG z renderera** — buduje EDG w main i cache'uje po `edgId`; `render-export` bierze EDG wyłącznie z cache | `screenStudioBridgeIntegration.test.js` (real core + fake capture + real FFmpeg) → build-edg/render-export OK; UI verify scenariusz 12: `["startRecording","stopRecording","buildEdg","renderExport"]`, `edgId=job_record_ui_1` |
| 2 | **Bloker — Cancel eksportu nic nie robił:** UI generowało własne `jobId`, ale `renderExport` dostawał `jobId` nagrania; `cancelExport` nie znajdował AbortControllera | Ten sam `jobId` przekazywany do `renderExport` i `cancelExport`; `screen:cancel-export` abortuje kontroler pod tym `jobId` | `screenStudioBridgeIntegration.test.js` cancel → `cancelled:true`, plik częściowy usunięty; UI verify: `cancel === renderJobId` |
| 3 | **Bloker — dowolny odczyt pliku:** `render-export` przyjmował EDG z renderera i podawał `screen_source.path` do FFmpeg | EDG nie pochodzi z renderera; dodatkowo defence-in-depth: ścieżka źródłowa musi leżeć w `recordingsDir` | test `edgId is required` (EDG złośliwy `/etc/passwd` odrzucony), `No EDG found` dla nieznanego `edgId` |
| 4 | **Bloker — telemetria nie docierała i nie była wyrównana:** `session.stop()` zwracał `telemetry`/`captureT0Ms`, ale UI ich nie przekazywało; brak korekty offsetu `captureT0Ms - samplerStartedAt` | Telemetria + T0 trzymane w main per `jobId`; `CursorSampler` zapisuje `startedAtWallClockMs`; `shiftTelemetryToCaptureClock()` odejmuje offset i odrzuca pre-roll; `build-edg` używa wyrównanej telemetrii | unit: `shiftTelemetryToCaptureClock` (offset 300 ms, drop pre-roll, brak timestampów = bez zmian); integracja: `samplesCount >= 1`, `telemetryStatus='ok'` |
| 5 | **Bloker — nieobsłużony kanał preload:** `cursorSample` → `screen:cursor-sample` bez handlera | usunięty z `preload.js` (brak konsumenta) | `screenStudioPreloadSurface.test.js`: brak `cursorSample`, brak rejestracji kanału w mostku |
| 6 | **Bloker — nieaktualny stan joba po samo-zakończeniu FFmpeg:** `activeSession` nieczyszczony, `screen:status` raportował `isRecording:true` w nieskończoność | `startGovernedCapture` eksponuje `onExit`/`isStopping`/`isCancelled`; mostek obserwuje `exit` przez `onSpawn`, finalizuje job (ffprobe) i dopiero potem czyści sesję; sampler zatrzymywany na `exit` | integracja „self-exit": `isRecording:false` i job `done` po samo-zakończeniu |
| 7 | **Odchylenie — Stop bez potwierdzenia ffprobe, czas z zegara ściennego** | `screen:stop-recording` potwierdza plik przez ffprobe (`confirmRecording`) i ustawia `durationSec` z probe; brak potwierdzenia → `ok:false`/`EUNCONFIRMED` | integracja: `confirmed:true`, `durationSec` w tolerancji ±0.5 s |
| 8 | **Odchylenie — nieograniczony odczyt podglądu; brak błędu w UI** | `screen:build-preview` sprawdza rozmiar proxy vs 256 MiB; UI ma akcję `SET_PREVIEW_ERROR` i widoczny blok błędu (`data-testid="preview-error"`) | lint/testy zielone; UI renderuje błąd |
| 9 | **Odchylenie — brak walidacji opcji nagrania w mostku** | `validateRecordingOptions` (fps ∈ {24,25,30,60}, `maxDurationSec` 1–7200) i `validateCaptureDevices` (indeksy video/audio wg świeżej enumeracji; przy błędzie enumeracji indeks ≠ null jest odrzucany) **przed** `store.create` | integracja: `Invalid fps`/`Invalid maxDurationSec`/`Unknown audioDeviceIndex`, brak rekordu joba |
| 10 | **Odchylenie — Stop zwalniał dzierżawę za wcześnie** | usunięto `releaseLease()` po `Promise.race`; dzierżawa zwalniana dopiero w handlerze `exit` (po realnym zakończeniu procesu) | `screenCapture.test.js` zielony; komentarz w kodzie wyjaśnia |
| 11 | **Odchylenie — brak testów mostka dla build-edg/render-export/cancel-export** | nowy `packages/core/test/screenStudioBridgeIntegration.test.js` (4 testy: pełny przepływ, self-exit, brak nagrania, walidacja opcji) | 4/4 pass, real FFmpeg |
| 12 | **Uwaga — lokalizacja checkpointu + alias `studio`** | jawnie udokumentowane na górze tego pliku (worktree ≠ checkout Luke'a; alias `studio` do sprawdzenia przed merge) | ten plik |

### Runda poprawek — weryfikacja (komendy, exit codes, wyniki)

| Komenda | Exit | Wynik |
|---|---|---|
| `npm --prefix packages/core test` | 0 | **604/604 pass, 0 fail**; guard izolacji **PASS**. Log: `.tmp/vidmyo-v2.6/phase5-fix-core-test.log`. |
| `npm run lint` | 0 | **0 błędów, 14 ostrzeżeń legacy**. Log: `.tmp/vidmyo-v2.6/phase5-fix-lint.log`. |
| `npm run build:studio` | 0 | **36 plików** (Babel). Log: `.tmp/vidmyo-v2.6/phase5-fix-build-studio.log`. |
| `node tests/ui_verify.mjs` | 0 | **verdict: pass, 14/14 scenariuszy, 0 błędów konsoli**; scenariusz 12 potwierdza `buildEdg → renderExport` i zgodność `jobId` z Cancel. Log: `.tmp/vidmyo-v2.6/phase5-fix-ui-verify.log`; raport `.tmp/vidmyo-v2.6/ui-verify-report.json`. |
| `node --test packages/core/test/screenStudioBridgeIntegration.test.js` | 0 | **4/4 pass** (real core + fake capture + real FFmpeg + Cancel). |
| `graphify update .` | 0 | **354/354 plików AST; 2573 węzłów, 5405 krawędzi, 156 społeczności**. Log: `.tmp/vidmyo-v2.6/phase5-fix-graphify.log`. |
| `electron .tmp/vidmyo-v2.6/real_capture_probe.cjs` | 0 | **`verdict: "pass"`** po korekcie (item 1 wyżej): realne nagranie `Capture screen 0`, `durationSec=2.8`, h264 1920×1080, `blackdetect` brak. Dowód: `.tmp/vidmyo-v2.6/real_capture_probe.json`. |

### Realne nagranie — dokładny stan (skorygowany 2026-09-26)

> [!NOTE]
> Poniższa sekcja (historyczna, z 1. rundy poprawek) zawierała **błędną** diagnozę. Zostawiona dla śladu; obowiązuje stan z sekcji „Runda poprawek po 2. review" powyżej.

- ~~TCC Screen Recording dla procesu Electron: `granted`~~ → nadal `granted`.
- ~~Awaria na poziomie urządzenia avfoundation: urządzenie wystawia tylko 1920x1080@60…~~ → **BŁĘDNA DIAGNOZA:** probe celował w `videoDeviceIndex: 0`, czyli kamerę OBS Virtual Camera. Realny ekran (`Capture screen 0`) jest pod indeksem 1 i akceptuje 30 fps.
- ~~Nawet przy wspieranym 60 fps urządzenie otwiera się bez produkcji klatek…~~ → dotyczyło kamery. Realne urządzenie „Capture screen" produkuje klatki.
- **Wniosek:** pozycja „realne nagranie" jest **zweryfikowana** (`pass`) na tym Macu. Migracja na ScreenCaptureKit pozostaje opcjonalnym `remaining`.

---


## Faza 5 — baseline i checkpointy (2026-09-25)

- **HEAD:** `4e559e00e527ec7ecf29c585b4ca26daba125793`, branch `maiox/loop-8da75abf` (worktree zsynchronizowany z checkpointem `refs/checkpoints/vidmyo-v2.6-phase4` commit `610b91a63818c3283c12ac8cf4cbd1516f366075`).
- **Baseline testów Fazy 5:** `npm --prefix packages/core test` → **564/564 pass, 0 fail, exit 0** (~68.4 s, guard **PASS**).
- **Snapshot mtime współdzielonych plików WIP:** `.tmp/vidmyo-v2.6/phase5-shared-mtimes.txt` (guard konfliktu przed każdym zapisem).
- **Stan git:** zachowano cały WIP innych agentów.

### Tabela Fazy 5 (checkpointy po każdej pozycji)

| # | Pozycja | Status | Pliki | Następny krok |
|---|---|---|---|---|
| 0 | Baseline + checkpoint | `completed` | `PLAN.md`, `STATUS.md`, `.tmp/vidmyo-v2.6/phase5-shared-mtimes.txt`, `.tmp/{context,todos,insights}.md` | Step 1 (Checkpoint A) |
| 1 | Navigation shell (Checkpoint A) | `completed` | `packages/studio/src/components/ScreenStudio.jsx`, `packages/studio/src/index.js`, `components/StandaloneShell.js`, `packages/core/test/navigationShell.test.js` | Step 2 (Checkpoint B) |
| 2 | Core capture (Checkpoint B) | `completed` | `packages/core/src/screenCapture.js`, `packages/core/src/governedProcess.js`, `packages/core/index.js`, `packages/core/test/screenCapture.test.js`, `packages/core/test/noUngovernedFfmpeg.test.js` | Step 3 (Checkpoint C) |
| 3 | Export from recording (Checkpoint C) | `completed` | `packages/core/src/screenStudio.js`, `packages/core/test/screenStudioRecordingExport.test.js` | Step 4 (Checkpoint D) |
| 4 | Bridge (Checkpoint D) | `completed` | `electron/lib/screenStudioBridge.js`, `electron/lib/enginesBridge.js`, `electron/main.js`, `electron/preload.js`, `packages/core/test/screenStudioBridge.test.js` | Step 5 (Checkpoint E) |
| 5 | Screen Studio UI (Checkpoint E) | `completed` | `packages/studio/src/screenStudioModel.mjs`, `packages/studio/src/components/ScreenStudio.jsx`, `packages/core/test/screenStudioModel.test.js`, `packages/core/test/exportCancelModel.test.js` (poprawiona asercja `setDemoStatus`), `npm run build:studio` exit 0 | Step 6 |
| 6 | Reachability & Engines (Checkpoint F) | `completed` | `packages/studio/src/components/SettingsModal.jsx` (sekcja „Engines & models"), `packages/studio/src/v26Features.mjs`, `packages/core/test/v26Reachability.test.js`, `packages/core/test/screenStudioBridge.test.js` (+test HyperFrames), `electron/lib/enginesBridge.js` (`engines:hyperframes-status`), `electron/preload.js` (`engines.hyperframesStatus`), `INVENTORY.md` (ścieżki 9 obszarów) | Step 7 |
| 7 | Verification (Checkpoint G) | `completed` | `tests/ui_verify.mjs` (self-contained, 14 scenariuszy, port z `listen(0)`), `.tmp/vidmyo-v2.6/real_capture_probe.cjs` (probe TCC), `jsconfig.json` (alias `studio` dla izolacji worktree) | Step 8 |
| 8 | Close-out | `completed` | suite 596/596, lint 0 błędów, `build:studio` exit 0, `graphify update .` exit 0, `EVIDENCE.md` Faza 5, `STATUS.md` Faza 5 | Faza 5 gotowa do review |

### Faza 5 — podsumowanie i zamknięcie (2026-09-25) — **podsumowanie NIEAKTUALNE; patrz „Runda poprawek po review Fazy 5" powyżej**

- ~~Wszystkie pozycje scope Fazy 5: `completed`.~~ **Sprostowanie (2026-09-26):** przepływ realnego nagrania→EDG→eksportu był zepsuty (blokery 1–6) — naprawiony w 1. rundzie. Realne nagranie na tym Macu było **błędnie** uznane za `blocked-unverified-hardware`; w 2. rundzie korekty realne nagranie **przechodzi** (`pass`). Fazy 1–4 nie zregresowały.
- **Pełny zestaw testów Core (izolowany, fresh po wszystkich edycjach):** `npm --prefix packages/core test` → **596/596 pass, 0 fail, exit 0** (~82 s); guard izolacji domu **PASS**. Log: `.tmp/vidmyo-v2.6/phase5-final-core-test.log`. *(Aktualnie po rundzie poprawek: 604/604, log `phase5-fix-core-test.log`.)*
- **Analiza statyczna:** `npm run lint` → **exit 0, 0 błędów, 14 ostrzeżeń legacy**. Log: `.tmp/vidmyo-v2.6/phase5-final-lint.log`.
- **Build studia:** `npm run build:studio` → **exit 0** (`36 files`). Log: `.tmp/vidmyo-v2.6/phase5-build-studio-step6.log`.
- **Graphify:** `graphify update .` → **exit 0; 2563 węzłów, 5391 krawędzi, 155 społeczności (352/352 plików AST)**. Log: `.tmp/vidmyo-v2.6/phase5-final-graphify.log`. *(Liczby niższe niż Fazy 4 — graphify przeliczył bieżący stan worktree po zmianach; zapisane bez korekty.)*
- **Weryfikacja UI:** `node tests/ui_verify.mjs` → **verdict: pass, 14/14 scenariuszy, 0 błędów konsoli** (fresh run po ostatniej edycji kodu); port testowy 50266 (z `net.listen(0)`), grupa procesowa dev-serwera potwierdzona jako zamknięta (`serverGroupGone: true`). Log: `.tmp/vidmyo-v2.6/phase5-ui-verify.log`; raport `.tmp/vidmyo-v2.6/ui-verify-report.json`; zrzuty 01–14 w `.tmp/vidmyo-v2.6/ui/`. Scenariusze Screen Studio klikają **realną zakładkę w pasku** (`nav[aria-label="Studios"]`), nie trasę `?panel=`. *(Uwaga: przed rundą poprawek stub UI maskował brakującą ścieżkę build-edg; obecnie scenariusz 12 wymusza `buildEdg`.)*
- **Probe realnego nagrania (TCC):** stan z 2026-09-25 to `tccStatus: "denied"` / `awaiting-luke-manual-test`. **Aktualnie (2026-09-26, po 2. rundzie korekt): `tccStatus: "granted"` i nagranie `pass`** — realne `Capture screen 0` (index 1), 2,8 s, h264 1920×1080, `blackdetect` brak (szczegóły w sekcji „Runda poprawek po 2. review" na górze). Dowód: `.tmp/vidmyo-v2.6/real_capture_probe.json`.

#### Poprawka środowiskowa worktree (udokumentowana)

Worktree ma `node_modules` jako symlink do głównego checkoutu `Vidmyo`, więc `next dev` rozwiązywał pakiet `studio` do **głównego** `packages/studio` (bez zmian Fazy 5). Dodano alias `"studio"` w `jsconfig.json` (wzorowany na istniejących aliasach `ai-agent`/`workflow-builder`), aby worktree rozwiązywał własne źródło. Turbopack odrzuca symlink poza root (panic), więc `tests/ui_verify.mjs` uruchamia `next dev --webpack` (ta sama aplikacja, inny bundler dev). Nie wpływa to na działającą aplikację Luke'a (osobny checkout, osobny plik `jsconfig.json`).

#### Elementy nieukończone / niezweryfikowane (uczciwie)

| Element | Status | Powód |
|---|---|---|
| Realne nagranie na tym Macu | `completed` (verified 2026-09-26) | Po korekcie item 1: `Capture screen 0` (index 1 — NIE kamera na indeksie 0), 2,8 s, h264 1920×1080, `blackdetect` brak. `verdict: "pass"`. |
| Nagrywanie okien | `remaining` (zablokowane w UI z powodem) | prywatne API macOS ScreenCaptureKit; UI renderuje listę okien jako disabled z powodem. Pełne przechwytywanie ekranu przez avfoundation **działa** (patrz wyżej). |
| Wybór ekranu/kamery | `completed` (verified 2026-09-26) | `SET_SOURCES` przyjmuje pierwszy realny ekran, gdy bieżący indeks nie występuje w liście; test modelu + realny probe (index 0 = kamera, index 1 = ekran). |
| Mikrofon / dźwięk systemowy w UI | `completed` (verified 2026-09-26) | UI czyta `audioDevices` z mostka; BlackHole nieobecny → komunikat z instrukcją instalacji; kontrakt mostek→UI pokryty testem. |
| Realne kliknięcia | `heuristic-labelled` | brak źródła zdarzeń kliknięć; `detectDwellEvents` to heurystyka dwell (600 ms / 80 px), jawnie oznaczona jako „nie kliknięcia". |
| Wielomonitorowe mapowanie | `implemented, unverified-on-hardware` | dopasowanie po rozdzielczości (R9); brak drugiego monitora w środowisku. |
| Macierz Windows | `remaining` | poza zakresem Fazy 5. |
| IPC Electron w UI | `UI unverified (Electron)` | scenariusze stubbują `window.screenStudio`/`window.engines`/`window.promo`; sam IPC Electrona nie jest uruchamiany w przeglądarce. |
| Restart aplikacji Luke'a | **wymagany** | zmiany `electron/main.js` i `electron/preload.js` wchodzą dopiero po restarcie Electrona (działająca aplikacja nie jest zatrzymywana). |

#### Checkpoint ref i pliki własne (Faza 5)

**Nie utworzono** `refs/checkpoints/vidmyo-v2.6-phase5`: working tree zawiera duży WIP innych agentów (dziesiątki plików nieśledzonych/zmodyfikowanych poza zakresem Fazy 5), więc zgodnie z planem zamiast refu zapisano listę plików własnych.

Nowe pliki Fazy 5:
- `packages/studio/src/components/ScreenStudio.jsx`, `packages/studio/src/screenStudioModel.mjs`, `packages/studio/src/v26Features.mjs`
- `packages/core/src/screenCapture.js`
- `electron/lib/screenStudioBridge.js`, `electron/lib/enginesBridge.js`
- `packages/core/test/{screenCapture,screenStudioRecordingExport,screenStudioModel,screenStudioBridge,v26Reachability}.test.js`
- `tests/ui_verify.mjs`, `.tmp/vidmyo-v2.6/real_capture_probe.cjs`

Nowe pliki rundy poprawek (2026-09-26):
- `packages/core/test/screenStudioBridgeIntegration.test.js` — mostek end-to-end (real core + fake capture + real FFmpeg + Cancel)
- `packages/core/test/screenStudioPreloadSurface.test.js` — strażnik powierzchni `preload`/UI (`buildEdg` obecny, `cursorSample` usunięty)
- `.tmp/vidmyo-v2.6/af_fps_probe.cjs` — throwaway probe `-framerate 60` (dowód blokady)

Zmodyfikowane pliki Fazy 5 (poza WIP innych agentów):
- `components/StandaloneShell.js`, `electron/main.js`, `electron/preload.js`, `jsconfig.json`
- `packages/core/index.js`, `packages/core/src/{governedProcess,screenStudio,ffmpegCapabilities,screenCapture}.js`
- `packages/core/test/{noUngovernedFfmpeg,exportCancelModel,navigationShell}.test.js`
- `packages/studio/src/{screenStudioModel.mjs,components/ScreenStudio.jsx,components/PromoReviewStudio.jsx,components/SettingsModal.jsx}`
- `tests/ui_verify.mjs`
- `docs/plans/vidmyo-v2.6/{STATUS,EVIDENCE,INVENTORY}.md`



---

## Faza 4 — stan archiwalny (zakończona)

- **HEAD:** `4e559e00e527ec7ecf29c585b4ca26daba125793`, branch `SAI-22-local-agent-providers`, `git status --porcelain | wc -l` = **289** (baseline Fazy 4; duży WIP innych agentów — nie stashować/resetować/worktree; `storyBridge.js` nietknięty).
- **Baseline testów Fazy 4:** `npm --prefix packages/core test` → **540/540 pass, 0 fail, exit 0** (guard **PASS**), `.tmp/vidmyo-v2.6/phase4-baseline-test.log`.
- **Finalny stan testów Fazy 4 (po 2. review):** `npm --prefix packages/core test` → **564/564 pass, 0 fail, exit 0** (~71.4 s, guard **PASS**), fresh `.tmp/vidmyo-v2.6/phase4-final-core-test.log` (timestamp 12:02, po wszystkich edycjach kodu).
- **Snapshot:** `.tmp/vidmyo-v2.6/phase4-baseline.txt`; mtime współdzielonych plików WIP: `.tmp/vidmyo-v2.6/phase4-shared-mtimes.txt` (guard konfliktu przed każdym zapisem).

### Tabela Fazy 4 (checkpointy po każdej pozycji)

| # | Pozycja | Status | Pliki | Następny krok |
|---|---|---|---|---|
| 0 | Baseline + checkpoint | `completed` | `PLAN.md`, `STATUS.md`, `.tmp/vidmyo-v2.6/phase4-baseline*`, `phase4-shared-mtimes.txt` | Step 1 |
| 1 | Prymitywy governed process (pre-abort + captureStdout) | `completed` | `packages/core/src/governedProcess.js` (pre-abort ECANCELLED przed admisją i spawnem + zwolnienie dzierżawy, `captureStdout:{maxBytes}` → `stdio[1]=pipe`, overflow → tree-kill + `ESTDOUT_LIMIT`, sukces → `stdout: Buffer`, settle na `close` + grace 5 s po `exit`), nowy `packages/core/test/governedProcess.test.js` (4 testy) | Step 2 (Item 1) |
| 2 | Item 1 — governowane spawn-y FFmpeg render/export | `completed` | `rendererAdapter.js` (`_runFfmpeg` z `runGovernedFfmpeg`, `probeMediaGoverned`, brak raw spawn), `screenStudio.js` (`renderScreenStudioExport` z `runGovernedFfmpeg`), `avatarStudio.js` (`extractAudioEnvelopeAsync`, `render2dMascotVideo` z `runGovernedFfmpeg`), `promoBridge.js`, `autoEditorBridge.js`, `preload.js`, testy `ffmpegGovernedExport.test.js`, `noUngovernedFfmpeg.test.js` | Step 3 (Item 3) |
| 3 | Item 3 — capability-aware H.264 encoder | `completed` | `ffmpegCapabilities.js` (`parseFfmpegEncoders`, `selectH264Encoder`, encoder probe `-encoders`), `rendererAdapter.js`, `screenStudio.js`, `avatarStudio.js`, mostki, testy `ffmpegCapabilities.test.js` (13/13, w tym realny eksport `h264_videotoolbox` na macOS) | Step 4 (Item 2) |
| 4 | Item 2 — UI Cancel | `completed` | nowy `exportCancelModel.mjs`, `CartoonStudio.jsx` (przycisk cancel, `data-testid="cancel-cartoon-export"`, `data-testid="export-status"`, status „Anulowano"), `PromoReviewStudio.jsx` (cancel dla promo i screen-studio, status „Anulowano"), testy `exportCancelModel.test.js` (5/5) | Step 5 (Item 4) |
| 5 | Item 4 — decyzje dokumentowe 2026-09-25 | `completed` | `PLAN.md`, `STATUS.md`, `INVENTORY.md` (tabela wyjątków spawnu i allowlist) | close-out |
| F | Close-out: suite + lint + graphify | `completed` | `.tmp/vidmyo-v2.6/phase4-final-*.log` | Faza 4 gotowa do review MAIOX |

### Runda poprawek po review Fazy 4 (2026-09-25) — blokady usunięte

Recenzja Fazy 4 wskazała 4 blokery (1: UI verification, 2: static guard, 3: rasteryzator Chrome, 4: spawny poza zakresem) oraz 3 uwagi istotne (5: grupa procesów + test renderExport cancel, 6: realny eksport przez adapter, 7: zachowanie -crf). Wszystkie 7 punktów zostało w pełni zrealizowanych:

| # | Ustalenie recenzenta | Naprawa | Weryfikacja |
|---|---|---|---|
| R1 (B1) | Item 2: brak realnego przebiegu weryfikacji UI dla scenariuszy 8–10 (cancel Promo, Screen Studio, Cartoon) | Poprawiono stub sesji Screen Studio w `.tmp/vidmyo-v2.6/ui_verify.mjs` (`generateScreenSession` + `buildScreenStudioEdg`), dodano runner `tests/ui_verify.mjs` i wykonano pełny przebieg weryfikacji. Wszystkie 10/10 scenariuszy zaliczone, 0 błędów konsoli, zrzuty 01–10 zapisane w `.tmp/vidmyo-v2.6/ui/`, serwer dev poprawnie zatrzymany (brak wiszących procesów). | `node tests/ui_verify.mjs` → **verdict: pass, 10/10 scenariuszy pass, exit 0**; raport `.tmp/vidmyo-v2.6/ui-verify-report.json`, zrzuty 01–10 ze stemplem 11:49. |
| R2 (B2) | Item 1: fałszywa deklaracja o static guard — `ALLOWLIST_EXCEPTIONS` nieużywane, brak skanowania `spawnSync`/`execFile` w `rendererAdapter.js` | Przepisano `packages/core/test/noUngovernedFfmpeg.test.js`: test skanuje wszystkie 7 plików (`governedProcess.js`, `ffmpegCapabilities.js`, `screenStudio.js`, `avatarStudio.js`, `rendererAdapter.js`, `promoBridge.js`, `autoEditorBridge.js`) pod kątem dowolnych wywołań procesów (`spawn`, `spawnSync`, `execFile`, `exec`). Wszystkie 12 trafień musi dokładnie pasować do `ALLOWLIST_EXCEPTIONS` powiązanej 1:1 z tabelą w INVENTORY §3. Nieznane trafienia oblewają test. | `node --test packages/core/test/noUngovernedFfmpeg.test.js` → **6/6 pass, exit 0**. |
| R3 (B3) | Item 1: rasteryzator napisów Chrome `rendererAdapter.js:402` z `spawnSync` nie wymieniony jako `remaining` | Oznaczono uczciwie jako `remaining` w STATUS i INVENTORY §3 (uzasadnienie: `buildFfmpegArguments` jest synchronicznym konstruktorem planu renderu wstawiającym `-i <pngPath>`; migracja do async planowania i `runGovernedProcess` odłożona do etapu unifikacji pipeline). | Zgodność w STATUS, INVENTORY §3 i allowliście strażnika. |
| R4 (B4) | Item 1: brak statusu `remaining` dla spawnów poza zakresem (`storyBridge.js:319`, `pipeline.js:95`, `repurposeRunner.js:374`, `cleanerBridge.js:152`, `mcp/lib/vfxService.js:28`) | Dodano tabelę w STATUS i INVENTORY §3.1 dokumentującą każde z tych wywołań jako `remaining` wraz z przyczyną (ochrona WIP innych agentów, brak detached process group, wywołania poza głównymi ścieżkami eksportu). Skorygowano zdanie w podsumowaniu Fazy 4. | Uczciwa dokumentacja w STATUS i INVENTORY §3.1. |
| R5 (I5) | Item 1: testy cancel/timeout sprawdzały tylko lidera; brak testu `RendererAdapter.renderExport` + `cancel(renderId)` | Do `ffmpegGovernedExport.test.js` dodano funkcję `pgrepGroup` weryfikującą brak procesów potomnych w grupie (`pgrep -g <pgid>`). Dodano testy `RendererAdapter.renderExport` z `adapter.cancel(renderId)` (stan `cancelled`, zwolnienie dzierżawy heavy, usunięcie pliku wyjściowego) oraz z `timeoutMs` (kod `ETIMEDOUT`, zwolnienie dzierżawy, usunięcie pliku). Dodano obsługę `renderId` w opcjach `renderExport`. | `node --test packages/core/test/ffmpegGovernedExport.test.js` → **6/6 pass, exit 0** (2.89s). |
| R6 (I6) | Item 3: realne eksporty w `ffmpegCapabilities.test.js` omijały ścieżki renderu (surowy `spawnSync` z `sel.args`) oraz miały cichy skip | Przepisano test: eksporty dla `libx264` i `h264_videotoolbox` wykonywane są bezpośrednio przez `RendererAdapter.renderExport` z `encoderOverride`. Sprawdzane są: `result.status === 'done'`, `result.encoder.name`, istnienie pliku oraz analiza `ffprobe` (strumień h264, czas trwania ±1 klatka + 0,02 s). Brak kodera na wspieranej platformie zgłasza błąd asercji zamiast cichego skipa. | `node --test packages/core/test/ffmpegCapabilities.test.js` → **13/13 pass, exit 0**. |
| R7 (I7) | Item 3: możliwa regresja jakości — brak `-crf` w selektorze `libx264` | Rozszerzono `selectH264Encoder` o opcję `crf` (domyślnie 18 dla renderu pełnego, 28 dla preview). Zaktualizowano asercje testowe weryfikujące zachowanie flag `-preset` i `-crf`. | `ffmpegCapabilities.test.js` weryfikuje `-crf 18`, `-crf 28` oraz niestandardowy `-crf 23`. |

### Runda poprawek po 2. review Fazy 4 (2026-09-25) — blokada usunięta, non-blocking zaadresowane

Recenzja wskazała 1 blokadę (stale evidence logs) i 3 uwagi non-blocking.

| # | Ustalenie recenzenta | Naprawa | Weryfikacja |
|---|---|---|---|
| B1 | Logi evidence (`phase4-final-core-test.log`, `phase4-final-lint.log`, `phase4-final-graphify.log`) starsze niż ostatnie edycje kodu; deklarowane 564/564 bez logu | Ponowne uruchomienie pełnego suite, lint i graphify po wszystkich edycjach; nadpisanie logów phase4-final-* z exit codes; korekta liczb w STATUS/EVIDENCE do faktycznych wyników. | Patrz sekcja „Podsumowanie i Zamknięcie" poniżej — liczby odpowiadają świeżym logom. |
| NB2 | STATUS nie mówi wprost, że `autoEditor:cancel-preview` / `cancelPreview` nie ma UI | Dodano jawny wpis: IPC `autoEditor:cancel-preview` i `cancelPreview` w `preload.js` istnieją, ale **brak przycisku UI** w `AutoEditorPanel.jsx` (preview nie uruchamia widocznego long-running eksportu — to szybki render inline; cancel jest dostępny programowo dla agentów/MCP). | Uczciwa deklaracja w STATUS. |
| NB3 | Promo i cartoon bridges nie przekazują `store` do `renderExport`, więc D6 pid checkpoint (`childProcess`) nigdy nie jest zapisywany dla tych jobów | Udokumentowana luka: `promoBridge.js` linie 250 i 354 wywołują `adapter.renderExport(...)` bez `store` w opcjach; checkpoint `childProcess` (PLAN D6) nie jest zapisywany; recovery po killu FFmpeg w trakcie tych eksportów opiera się na `renderAbortControllers` (in-memory) i stanie `cancelled` w JobStore, a nie na PID z checkpointu. Przekazanie `store` do `renderExport` jest poprawką o niskim ryzyku na następną rundę. | Luka udokumentowana; nie blokuje poprawności cancel/timeout (testowane w `ffmpegGovernedExport.test.js`). |
| NB4 | Kolejność cancel IPC: `store.cancel` → `controller.abort` (odwrotnie niż plan D6) | Udokumentowane: `promo:cancel-render-export` (linie 299–303) najpierw ustawia stan `cancelled` w JobStore, potem abortuje controller. Działa poprawnie, bo bridge sprawdza stan `cancelled` w catch/success i zwraca `cancelled: true` zamiast `done`. Kolejność D6 (abort → store.cancel) jest równoważna — oba race'y dają ten sam wynik końcowy. | Uczciwie odnotowane; brak regresji. |

### Podsumowanie i Zamknięcie Fazy 4 (po 2. rundzie poprawek review 2026-09-25)

- **Wszystkie 4 pozycje scope + 2 rundy poprawek review: `completed`.** Żadna pozycja nie jest `blocked`.
- **Pełny zestaw testów Core (izolowany):** `npm --prefix packages/core test` → **564/564 pass, 0 fail, exit 0** (czas: ~71.4s). Fresh log: `.tmp/vidmyo-v2.6/phase4-final-core-test.log` (timestamp 12:02).
  - Guard izolacji domowej: **PASS** (0 oznaczonych plików dotarło do prawdziwego `~/.vidmyo`, 0 plików o wzorcu temp pod `exports/` i `artifacts/`).
- **Analiza statyczna:** `npm run lint` → **exit 0, 0 błędów, 14 ostrzeżeń legacy** (identycznie jak baseline). Fresh log: `.tmp/vidmyo-v2.6/phase4-final-lint.log` (timestamp 12:05).
- **Graphify:** `graphify update .` → **exit 0, 459 plików AST, 2869 węzłów, 6112 krawędzi, 224 społeczności**. Fresh log: `.tmp/vidmyo-v2.6/phase4-final-graphify.log` (timestamp 12:05).
- **Weryfikacja UI:** `node tests/ui_verify.mjs` → **verdict: pass, 10/10 scenariuszy pass, exit 0** (Promo, Screen Studio, Cartoon z działającym cancel). Zrzuty 01–10 w `.tmp/vidmyo-v2.6/ui/`.
- **`autoEditor:cancel-preview` / `cancelPreview`:** IPC i preload istnieją; **brak przycisku UI** w `AutoEditorPanel.jsx` — preview jest szybkim inline renderem, cancel dostępny programowo (MCP/agenci).
- **Luka D6 pid checkpoint:** promo/cartoon bridges nie przekazują `store` do `renderExport`; checkpoint `childProcess` nie jest zapisywany. Cancel/timeout działają poprawnie przez `renderAbortControllers` (in-memory) + stan JobStore.
- **Kolejność cancel IPC:** `store.cancel` → `controller.abort` (odwrotnie niż plan D6); wynik końcowy identyczny — bridge sprawdza stan `cancelled` po powrocie z `renderExport`.
- **Decyzje architektoniczne 2026-09-25:**
  - Bundlowanie FFmpeg (P11): build LGPL macOS arm64 z `libass` + `freetype` + `VideoToolbox` zaplanowany na fazę pakowania/dystrybucji; weryfikacja `libass` przeniesiona tamże (lokalny FFmpeg Homebrew 8.1.1 nie ma tych filtrów).
  - Wymóg PSNR ≥ 35 dB został odrzucony jako kryterium parzystości z HyperFrames (SSIM, zgodność klatek i czasu trwania pozostają wiążące).
- **Zasada nienaruszalności:** `storyBridge.js` oraz repozytorium MAIOX pozostały nietknięte. Nie wykonano git commit ani git push (zarządza nimi MAIOX).


---

---

## Runda poprawek po review Fazy 3 (2026-09-24) — zakończona

Recenzja Fazy 3: **jedna pozycja blokująca** (fałszywe deklarowanie raportowania `unsupported` w `PromoReviewStudio`) + 4 rekomendowane. Scope Fazy 3 bez zmian; Fazy 1–2 nie ruszane (żadnej regresji).

| # | Ustalenie recenzenta | Status | Pliki |
|---|---|---|---|
| R1 | **(blokujące)** `PromoReviewStudio` ignorował `res.unsupported` / `res.result.unsupported` — eksport HyperFrames pomijający cechy EDG pokazywał zwykłe „Sukces!", a błąd nie wymieniał cech; STATUS błędnie twierdził, że panel ma „raport unsupported" | `completed` | nowy `packages/studio/src/promoExportModel.mjs` (`promoRenderOutcome`, `promoUnsupportedList`, `promoUnsupportedNote`, `unsupportedFeatureNames`), `PromoReviewStudio.jsx` (oba handlery — success **i** error — przez `promoRenderOutcome`, stan `renderUnsupported`, blok `data-testid="render-unsupported"`), nowy `packages/core/test/promoRenderOutcome.test.js` (8 testów), scenariusze 6/7 w `.tmp/vidmyo-v2.6/ui_verify.mjs` |
| R2 | Zestarzałe napisy „EDG→HTML conversion remains/remaining" w `rendererAdapter.js` (ok. 1242 i 1675) | `completed` | `rendererAdapter.js` (JSDoc `buildHyperFramesConfig`, `note`, JSDoc `renderExport`, komentarz `compareRenderPipelines`, nagłówek pliku) + nieaktualne wiersze w STATUS (`Rejestr blokad` #1, wiersz P3) |
| R3 | `renderExport(HYPERFRAMES)` kasował w `finally` katalog `projectDir` podany przez wywołującego | `completed` | `rendererAdapter.js` (`callerOwnedProjectDir`; kasowany tylko katalog utworzony przez to wywołanie), asercje w `hyperframesEdgRender.test.js` (katalog wywołującego przetrwał + auto-katalog usunięty) |
| R4 | Guard łapał tylko pliki z markerem — nieoznaczony MP4 w realnym `~/.vidmyo` byłby tylko notatką | `completed` | `packages/core/test/_setup/homeGuard.mjs` (`TEMP_PATH_PATTERNS`, `TEMP_PATTERN_DIRS`, `isTempPatternPath`, `reason: 'temp-pattern'` w `runGuard`), `runIsolated.mjs` (wzorzec dokładnej nazwy temp-home + druk reguł), 2 nowe testy w `homeIsolation.guard.test.js` |
| R5 | Brak przycisku „Anuluj" dla działającego eksportu w `PromoReviewStudio` | `completed` | `PromoReviewStudio.jsx` (`handleCancelRenderExport`, `data-testid="cancel-render-export"`), `promoBridge.js` (klientowskie `jobId` w `promo:render-export` / `promo:render-cartoon-export`, walidacja przez `JobStore._file` → `/^job_[\w-]+$/`), test w `promoBridge.test.js` |

### Weryfikacja rundy (komendy, exit codes, wyniki)

| Komenda | Exit | Wynik |
|---|---|---|
| `node --test packages/core/test/promoRenderOutcome.test.js packages/core/test/homeIsolation.guard.test.js` | 0 | **17/17 pass** |
| `node --test packages/core/test/rendererAdapter.test.js packages/core/test/edgToHyperframes.test.js packages/core/test/hyperframesAdapter.test.js packages/core/test/mascotTreeKill.test.js` | 0 | **25/25 pass** (15,9 s) |
| `node --test packages/core/test/promoBridge.test.js` | 0 | **10/10 pass** (20,3 s; klientowskie `jobId` + odrzucenie `../escape`) |
| `npm --prefix packages/core test` (pełny suite, isolated) | 0 | **540/540 pass, 0 fail** (81,5 s); **guard PASS** — 0 naruszeń marker ani temp-pattern, 0 notatek |
| `npm run lint` | 0 | **0 błędów, 14 ostrzeżeń (legacy)** — bez zmian wobec baseline |
| `node .tmp/vidmyo-v2.6/ui_verify.mjs` | 0 | **verdict: pass, 7/7 scenariuszy**, 0 błędów konsoli (scenariusze 6/7 = blok `unsupported` na sukcesie i na błędzie + przycisk anulowania) |
| `graphify update .` | 0 | **453 pliki AST; 2838 węzłów, 6044 krawędzi, 223 społeczności** |

- Logi: `.tmp/vidmyo-v2.6/review-fix-{core-test,lint,ui-verify,graphify}.log`; screenshoty `.tmp/vidmyo-v2.6/ui/06-promo-unsupported-success.png`, `07-promo-unsupported-error.png`.
- **Granice tej rundy (uczciwie):** scenariusze 6/7 UI używają **zastubowanego** `window.promo.renderExport` — zweryfikowany jest render komunikatu w przeglądarce, nie Electron IPC (`UI unverified (Electron)`). Ścieżka HyperFrames z realnym `unsupported[]` pozostaje pokryta przez `hyperframesEdgRender.test.js` / `edgToHyperframes.test.js`.
- **Nie zrobiono commita ani checkpoint ref** — obsługuje MAIOX.

---

## Faza 3 — baseline, checkpointy i zamknięcie (2026-09-24)

- **Faza 3 zamknięta** (5/5 pozycji scope + close-out). Scope odczytany z `Maiox/.tmp/vidmyo-phase3-scope.txt` — 5 pozycji zgodnych 1:1 z planem.
- **HEAD:** `4e559e00e527ec7ecf29c585b4ca26daba125793`, branch `SAI-22-local-agent-providers`, `git status --porcelain | wc -l` = **278** (baseline Fazy 3; duży WIP innych agentów — nie stashować/resetować/worktree).
- **Baseline testów Fazy 3:** `npm --prefix packages/core test` → **502/502 pass, exit 0** (~50 s), zapisany w `.tmp/vidmyo-v2.6/phase3-baseline-test.log`.
- **Snapshot diff:** `.tmp/vidmyo-v2.6/phase3-baseline.txt` (73 wiersze).
- **Guard zakresu (realny `~/.vidmyo`):** `jobs/` 1461 plików, `exports/` 246, `artifacts/` 18, `governor/{cache,leases}`, brak `publisher-queue.json` na starcie Fazy 3.

### Tabela Fazy 3 (checkpointy po każdej pozycji)

| # | Pozycja | Status | Pliki | Następny krok |
|---|---|---|---|---|
| 0 | Baseline + checkpoint | `completed` | `PLAN.md`, `STATUS.md`, `.tmp/vidmyo-v2.6/phase3-baseline*` | item 1 |
| 1 | Test isolation (injectable dirs + guard + 3× pełny suite) | `completed` | nowy `packages/core/src/paths.cjs` (`vidmyoHome`, `testRunMarker`) + `packages/core/src/paths.js` (re-export ESM), `jobs.js`/`governor.js`/`publisher.js` (domyślne ścieżki przez `vidmyoHome()`, marker w zapisach), `electron/lib/promoBridge.js` + `autoEditorBridge.js` + `mediaBridge.js` (factory + `deps.{userDataDir,jobsDir,exportsDir,artifactsDir,brollLibraryDir,governorDir,app}`; `resolveSafeOutputPath` przez `path.relative`), `electron/lib/publisherBridge.js` (`deps.userDataDir`), `mcp/lib/tools.js` (ARTIFACTS przez `vidmyoHome`), nowy `packages/core/test/_setup/{runIsolated.mjs,homeGuard.mjs}`, nowy `packages/core/test/homeIsolation.guard.test.js` (7 testów), zaktualizowane `promoBridge.test.js`/`autoEditorBridge.test.js`/`publisherBridge.test.js` (mkdtemp), `packages/core/package.json` (test → runIsolated) | item 2 |
| 2 | Mascot cancel tree-kill | `completed` | `packages/core/src/governedProcess.js` (stderr tail 8 KB gdy `stdio[2]='pipe'`, hook `onSpawn`, `stderr` na błędach/wyniku), `governor.js` (`cancelProcessTree`: SIGTERM do grupy + eskalacja SIGKILL po `DEFAULT_CANCEL_ESCALATION_MS=3000` z unref i recheckiem żywotności), `avatarStudio.js` (`render2dMascotVideo` przez `runGovernedProcess` z `{governor,jobId,signal,spawnImpl,resourceClass,waitForSlotMs,timeoutMs,stdio:['ignore','ignore','pipe']}`), `promoBridge.js` (AbortController na job, cancel = `store.cancel` → `abort()`, `ffmpegBinary` do testów), nowy `packages/core/test/mascotTreeKill.test.js` (4 testy) | item 3 |
| 3 | FFmpeg capability detection (P11, bez nowej binarki) | `completed` (libass: `unit-only, real libass unverified`) | nowy `packages/core/src/ffmpegCapabilities.js` (`probeFfmpegCapabilities`, `tryProbeFfmpegCapabilities`, `FfmpegMissingError`/`FFMPEG_MISSING` + wskazówki `brew install ffmpeg`/`VIDMYO_FFMPEG_PATH`, cache per path+mtime+size, `classifyFfmpegLicense`, `parseFfmpegFilters`), `rendererAdapter.js` (`capabilities()`, `capabilitiesError()`, `libassAvailable()`, `hasFilter` na raporcie, `captionPlan` 4-way drawtext→libass→overlay-png→unavailable, `writeAssCaptions`/`applyAssCaptions`/`buildAssSubtitleFile`/`escapeFfmpegFilterPath`/`cleanupCaptionArtifacts`, `probeSpawnSync` seam), `index.js` (eksport), `promoBridge.js` (`promo:ffmpeg-capabilities`), `electron/preload.js` (`ffmpegCapabilities`), `PromoReviewStudio.jsx` (linia zdolności + ostrzeżenie + wybór renderera + raport `captions.renderMode` w sukcesie), nowy `packages/core/test/ffmpegCapabilities.test.js` (10), `.tmp/vidmyo-v2.6/ffmpeg-capabilities.json` | item 4 |
| 4 | EDG → HyperFrames adapter | `completed` | nowy `packages/core/src/renderers/edgToHyperframes.js` (`convertEdgToComposition`, `EdgUnsupportedError`/`EDG_UNSUPPORTED`, `unsupported[]`, escape HTML, kopiowanie po hashu do `assets/`, timing z absolutnych klatek `timebase.js`), `hyperframesAdapter.js` (`signal` → `runGovernedProcess`), `rendererAdapter.js` (`renderExport` HYPERFRAMES: convert → `renderComposition({governor,jobId,signal})` → ffprobe walidacja → wynik z `unsupported`; `execute:false` = metadata-only bez zmian), `promoBridge.js` (whitelist `{ffmpeg,hyperframes}`, AbortController, `promo:cancel-render-export`, `renderer` w `render-cartoon-export`), `electron/preload.js`, `PromoReviewStudio.jsx` + `CartoonStudio.jsx` (renderer selector: FFmpeg domyślny / HyperFrames opt-in; **raport `unsupported` w UI początkowo tylko w `CartoonStudio` — `PromoReviewStudio` dopiero w rundzie poprawek R1 poniżej**), `index.js` (eksport), testy: `edgToHyperframes.test.js` (5), `hyperframesEdgRender.test.js` (2), zaktualizowane `rendererAdapter.test.js` (11) | item 5 |
| 5 | UI verification (web) | `completed` (+ jawne `UI unverified (Electron)`) | nowy `.tmp/vidmyo-v2.6/ui_verify.mjs` (1× `next dev` na wolnym porcie z `VIDMYO_HOME`=temp, 1× puppeteer-core + `resolveChromeBinary()`, 5 scenariuszy, klasyfikacja błędów konsoli, kill grupy procesowej), `components/StandaloneShell.js` (dev-only `?panel=` za `NODE_ENV!=='production'` + `?dir=`), `packages/studio/src/index.js` (eksport `CartoonStudio`, `AutoEditorPanel`, `PublisherQueuePanel`), `CartoonStudio.jsx` (renderer selector przeniesiony poza warunek `edg &&`), artefakty `.tmp/vidmyo-v2.6/ui/*.png` (5) + `ui-verify-report.json` | close-out |
| F | Close-out: suite + lint + graphify | `completed` | `.tmp/vidmyo-v2.6/phase3-final-{core-test,lint,graphify}.log` | — |

### Faza 3 — podsumowanie zamknięcia (2026-09-24)

- **Wszystkie 5 pozycji scope + close-out: `completed`.** Żadna nie jest `blocked`.
- `npm --prefix packages/core test` → **530/530 pass, 0 fail, exit 0** (guard **PASS**).
- `npm run lint` → **exit 0, 0 błędów, 14 ostrzeżeń (legacy)**.
- `graphify update .` → **exit 0; 451 plików AST; 2829 węzłów, 6028 krawędzi, 221 społeczności**.
- `node .tmp/vidmyo-v2.6/ui_verify.mjs` → **verdict: pass**, 5/5 scenariuszy, 0 błędów konsoli.
- `docs/pipeline-protection.md` przejrzane — dotyczy granic przekazywania danych agentom i OAuth; **nie ma tam miejsca** na `VIDMYO_HOME` ani macierz zdolności FFmpeg, więc świadomie nie dopisywano nic (plan dopuszcza tylko „jeśli relevant").
- Nie zrobiono commita ani checkpoint ref — MAIOX to obsługuje.

### Pozycje poza zakresem i odłożone — pozostają oznaczone (nie są „ukończone”)

| Obszar / Moduł | Status | Powód / opis |
|---|---|---|
| Screen Studio: natywne nagrywanie i weryfikacja HW | `completed` (Faza 5, korekta 2026-09-26) | Historycznie `blocked-unverified-hardware` (błędny `videoDeviceIndex: 0` = kamera). Po korekcie realne nagranie przechodzi na tym Macu. |
| Production YouTube: app review, realne uploady | `blocked-external` | Audyt Google Trust & Safety (App Review), limity quoty; transport produkcyjny fail-closed; testy tylko loopback; publish wyłącznie po jawnym poleceniu użytkownika. |
| Macierz Windows | `remaining` | Poza zakresem bieżących faz; ścieżka Windows objęta testami jednostkowymi mock (`untested-on-this-host`). |
| Instalacja na czystym macOS | `remaining` | Odroczone do dedykowanej fazy instalacyjnej. |
| Import NLE w realnych aplikacjach | `unverified-import` | Eksport FCPXML/Premiere generowany deterministycznie wg specyfikacji; otwarcie w komercyjnych pakietach niezweryfikowane na tym hoście. |
| LivePortrait / audio-driven lipsync | `blocked-licence` | Wagi i kod Wav2Lip / LivePortrait InsightFace posiadają restrykcje non-commercial / patentowe — blokada fail-closed; aktywny fallback 2D Mascot (Zero-VRAM). |
| Licencja paczki MRR/PLR | `blocked-no-licence-document` | Brak fizycznego dokumentu licencji redystrybucyjnej; dozwolone wyłącznie assety CC0/Pexels/Pixabay/Coverr z kompletnymi polami metadanych. |
| Bundlowanie FFmpeg (P11) | `decided-2026-09-25, scheduled: packaging phase` | Przypięty build LGPL macOS arm64 (libass + freetype + VideoToolbox) zaplanowany do wdrożenia w fazie dystrybucji/pakowania; brak bloba binarnego w repo. |
| Realny render ścieżki `libass` | `deferred-to-packaging-phase` | Odroczone do fazy pakowania z buildem LGPL; obecny lokalny FFmpeg Homebrew 8.1.1 nie ma `--enable-libass`; kod + testy jednostkowe gotowe. |
| Ścieżki eksportu Fazy 4 (`RendererAdapter._runFfmpeg`, `screenStudio.js:renderScreenStudioExport`, `avatarStudio.js:render2dMascotVideo`) | `completed` | Plain `spawn` wyeliminowany z głównych ścieżek renderu Fazy 4; pełen nadzór `runGovernedFfmpeg` z process-group kill, timeout, pre-abort i zwolnieniem dzierżawy. Strzeżone przez `noUngovernedFfmpeg.test.js`. |
| Rasteryzator napisów Chrome (`rendererAdapter.js:402`) | `remaining` | `spawnSync(chrome ...)` w `rasterizeCaptionPng`: `buildFfmpegArguments` jest synchronicznym konstruktorem planu renderu wstawiającym `-i <pngPath>`; pełna migracja do async `runGovernedProcess` odłożona do etapu unifikacji pipeline. |
| Spawny poza zakresem Fazy 4 (`storyBridge.js:319`, `pipeline.js:95`, `repurposeRunner.js:374`, `cleanerBridge.js:152`, `mcp/lib/vfxService.js:28`) | `remaining` | Wywołania `execFile`/`spawn` w modułach pobocznych (WIP innych agentów / legacy konwersja audio / pipeline doodle / runner repurpose); zachowane bez zmian dla ochrony przed regresją i konfliktami edycji. |
| Ścieżki IPC w UI (`window.promo` / `window.autoEditor` / `window.publisher`) | `UI unverified (Electron)` | Render kontrolek, przyciski i stany anulowania zweryfikowane w realnej przeglądarce (`ui_verify.mjs` 10/10 scenariuszy pass), sam IPC Electrona pozostaje `UI unverified (Electron)`. |
| EDG z klipem audio wskazującym asset wideo (ścieżka HyperFrames) | `reported-unsupported` | Zgłoszone w `unsupported[]`, nigdy pomijane cicho. |

---

## Faza 2 — baseline (2026-09-24)

- **HEAD:** `4e559e00e527ec7ecf29c585b4ca26daba125793`
- **Branch:** `SAI-22-local-agent-providers`
- **`git status --porcelain | wc -l`:** 269 na baseline (w tym 196 plików nieśledzonych — duży WIP innych agentów; nie usuwać, nie resetować, nie stashować). Stan w trakcie rundy poprawek: 278 (dopisek innych agentów/ procesów — nie pochodzi z tej rundy; ta runda pisała wyłącznie do `.tmp/vidmyo-v2.6/` i `docs/plans/vidmyo-v2.6/`).
- **Nieśledzone (fragment):** `.codex/`, `assets/`, `docs/plans/vidmyo-v2.6/`, `electron/lib/autoEditorBridge.js`, `electron/lib/channelsBridge.js`, `electron/lib/cleanerBridge.js` i in. Pełna lista w `git status`.
- **Zakres Fazy 2 (zatwierdzony przez MAIOX, loop e4722b78, checkpoint phase1):** 6 pozycji w kolejności: (1) licencje B-roll — enforcement pól, (2) parametry hipotez Retention/Hooks — konfigurowalność + etykiety + dojście wartości do backendu, (3) governor 3-powierzchniowy test wieloprocesowy, (4) trwała kolejka publikacji offline (Content-Range/308, cancel, quota, token refresh), (5) zarządzane paczki modeli Kokoro/ASR (manifest + wznowienie + weryfikacja), (6) realny adapter HyperFrames z przypiętą wersją i side-by-side z FFmpeg.
- **Poza zakresem Fazy 2 (zostawić oznaczone):** Screen Studio natywne/HW, produkcyjne YouTube (app review, real upload), macierz Windows, import NLE w realnych aplikacjach, LivePortrait/lipsync, licencja paczki MRR/PLR. Nie otwierać pracy z Fazy 1 poza naprawą regresji.
- **Worker checkpoint po każdej pozycji:** STATUS (tabela Faza 2) + EVIDENCE Part I (komendy, exit codes, wyniki).

### Tabela Fazy 2 (checkpointy)

| # | Pozycja | Status | Pliki | Następny krok |
|---|---|---|---|---|
| 0 | Checkpoint baseline | `completed` | `STATUS.md`, `PLAN.md`, `.tmp/vidmyo-v2.6/*` | — |
| 1 | B-roll licence-field enforcement | `completed` | `packages/core/src/broll.js` (validateBrollLicenseFields, loadBrollRegistry partition accepted/rejected, MediaLicenseRegistry pełne pola, APPROVED_LICENSE_CODES exact-match, MRR/PLR blocked, builtin CC0 z polami), `electron/lib/autoEditorBridge.js` (registry.rejected w odpowiedzi), `packages/studio/src/components/AutoEditorPanel.jsx` (sekcja odrzuconych wpisów z dokładnymi powodami), `packages/core/test/broll.test.js`, `packages/core/test/autoEditorBridge.test.js` | przejście do item 2 |
| 2 | Retention/Hooks hypothesis labels | `completed` | `AutoEditorPanel.jsx` (4 suwaki: próg/rotacja/padding/zoom, etykieta „mierzone, nie gwarantowane", echo „Backend otrzymał"), `autoEditorBridge.js` (walidacja zakresów params + echo w `params`/`retention`), testy default/override/reject w `autoEditorBridge.test.js` + test źródła panelu | przejście do item 3 |
| 3 | Governor 3-surface test | `completed` | nowy `packages/core/src/governedProcess.js` (admission-first, detached pgid, timeout/cancel → group kill, lease zwalniany po `exit`), nowy `packages/core/test/governor.multiprocess.test.js` (4 scenariusze), `packages/core/index.js` (eksport) | przejście do item 4 |
| 4 | Persistent publish queue offline | `completed` (+ poprawka review: crash recovery) | `packages/core/src/publisher.js` (PUBLISH_STATES.CANCELLED, cancel→`cancelled`, retry z cancelled **oraz z uploading**, `baseUrl`+`signal` w transporcie, `cancelUpload`/AbortController w adapterze, **`load()` — startup reconciliation: rekord w `uploading` → `queued` z `recoveredAt`, sesja/URL i postęp zachowane; `processing` bez `remoteVideoId` → `queued`; `processing` z `remoteVideoId` zostaje (pollable)**), nowy `packages/core/src/publisherMock.js`, `electron/lib/publisherBridge.js` (**trwały queuePath: `userData/publisher-queue.json` (Electron convention), `deps.queuePath` do testów; recovery działa przy starcie mostka przez `store.load()`**), `PublisherQueuePanel.jsx` (badge „Anulowano", Ponów dla cancelled), testy `publisher.offline.test.js` (7: **+ process kill mid-upload → recovered → resume bez duplikatu initiate**), `publisherBridge.test.js` (5: **+ durable queue + recovery po „restart" aplikacji**), `publisher.test.js` (12, zaktualizowane asercje restartu + nowe testy recovery) | przejście do item 5 |
| 5 | Managed model packages | `completed` | nowy `packages/core/src/modelPackages.js` (validatePackageManifest, ModelPackageManager: install/verify/uninstall/status, wznowienie przez Range, receipt atomowy), `BUILTIN_MODEL_CATALOG` kokoro-tts/whisper-asr = `manifest-pending` (sha256/version/url/licence = null — nic nie zmyślone), eksport w `index.js`, testy `modelPackages.test.js` (9) | przejście do item 6 |
| 6 | Real HyperFrames adapter | `completed` | `package.json`+`package-lock.json` (hyperframes **0.8.72** exact, integrity zapisany; Apache-2.0), `packages/core/src/renderers/hyperframesAdapter.js` (HYPERFRAMES_PINNED, fail-closed pin, renderComposition przez `runGovernedProcess`), `rendererAdapter.js` (buildHyperFramesConfig → migrationStatus `pinned`, multi-scene FFmpeg, napisy: `drawtext` lub `overlay-png` przez lokalny Chromium z `enable='between(t,start,end)'`; `hasFilter` wspiera 2–4 flagi; napisy `applied` na obu silnikach), testy `hyperframesAdapter.test.js` (5), `hyperframesCompare.test.js` (2, side-by-side zmierzone 9:16, 1:1, 16:9, napisy `applied` na obu silnikach z weryfikacją widoczności), `rendererAdapter.test.js` (11, test jednostkowy planu `overlay` + jawny status napisów) | Faza 2 ukończona |
| F | Final: pełny test + lint + graphify | `completed` | `npm --prefix packages/core test` → **502/502 pass, exit 0**; `npm run lint` → exit 0 (0 błędów, 14 ostrzeżeń legacy); `graphify update .` → exit 0 (2747 węzłów, 5880 krawędzi, 217 społeczności, 441 plików AST) | — |

### Runda poprawek po review (2026-09-24) — blokady usunięte

Recenzja Fazy 2 wymagała naprawy pozycji 6 (brak napisów po stronie FFmpeg): zaimplementowano ścieżkę `overlay-png` bez sieci przez lokalny Chromium, zintegrowano z planem i wykonaniem FFmpeg, zaktualizowano testy i dowody.

| # | Ustalenie recenzenta | Naprawa | Weryfikacja |
|---|---|---|---|
| R1 | Item 6: strona FFmpeg side-by-side gubiła napisy (build 8.1.1 nie ma `drawtext`); wymagano ścieżki napisów bez `drawtext` z rasteryzacją PNG i filtrem `overlay=...:enable='between(t,start,end)'` | Wdrożono ścieżkę `overlay-png` w `rendererAdapter.js`: lokalna rasteryzacja przez headless Chromium do przezroczystego PNG, kompozycja z `overlay=0:0:enable='between(t,start,end)'`; naprawiono regex flag `hasFilter` (`[TSC.]{2,4}`) wykrywający filtr `overlay`; status napisów `applied` z `renderMode: 'overlay-png'`. W teście `hyperframesCompare.test.js` obie strony (HF i FFmpeg) mają status `applied` na wszystkich 3 proporcjach oraz asercje widoczności napisów w regionie kadru. Dodano test jednostkowy planu `overlay` z `enable` i czasami klatek w `rendererAdapter.test.js`. | `rendererAdapter.test.js` 11/11 pass, `hyperframesCompare.test.js` 2/2 pass (zmierzone PSNR 33.55–36.91 dB, SSIM 0.9937–0.9964), `autoEditorBridge.test.js` 12/12 pass, `npm --prefix packages/core test` 502/502 pass, exit 0 |
| R2 | Item 4: restart po killu w `uploading` — rekord „utknął na zawsze" | `PublishRecordStore.load()` przenosi `uploading` (i `processing` bez `remoteVideoId`) do resumable `queued` z `recoveredAt`; `retry()` akceptuje `uploading`; mostek ma trwały `queuePath` (`userData/publisher-queue.json`). | `publisher.offline.test.js` 7/7 pass, `publisherBridge.test.js` 5/5 pass, `publisher.test.js` 12/12 pass, exit 0 |
| R3 | STATUS.md sprzeczny: starsze sekcje mówiły o braku paczki lub odłożonych testach | Historyczne sekcje oznaczone jako **Faza 1 — historia**; sprzeczne wiersze zaktualizowane; jedna bieżąca tabela poniżej. | Spójne tabele bieżące i historyczne |

### Obszary odłożone i zablokowane — stan na koniec Fazy 2 (**historia**; bieżący stan: sekcja "Pozycje poza zakresem Fazy 3" powyżej)

| Obszar | Status | Powód / brama |
|---|---|---|
| Screen Studio: natywne nagrywanie i weryfikacja HW | `blocked-unverified-hardware` | brak fizycznego sprzętu, uprawnień TCC i BlackHole w środowisku testowym |
| Production YouTube: app review, realne uploady, publikacja | `blocked-external` | audyt Google Trust & Safety (App Review), limity quoty; transport produkcyjny fail-closed; testy tylko loopback; publish wyłącznie po jawnym poleceniu użytkownika |
| Macierz Windows (testy, `taskkill`) | `remaining` | poza zakresem Fazy 2; ścieżka Windows objęta tylko testem jednostkowym mock (`untested-on-this-host`) |
| Import NLE w realnych aplikacjach (FCPXML/Premiere) | `unverified-import` | eksport generowany wg schematu; otwarcie w komercyjnych pakietach niezweryfikowane na tej maszynie |
| LivePortrait / audio-driven lipsync (Wav2Lip) | `blocked-licence` | licencje non-commercial / zastrzeżone — fail-closed; aktywny fallback 2D Mascot |
| Licencja paczki MRR/PLR (b-roll) | `blocked-no-licence-document` | brak dokumentu redystrybucji; dozwolone wyłącznie klisy z pełnymi polami licencji (CC0/pexels/pixabay/coverr) |
| EDG → HTML (render EDG przez HyperFrames) | `completed` w **Fazie 3** (FFmpeg nadal domyślny; HyperFrames opt-in w UI) | konwersja + realne render y zmierzone; patrz EVIDENCE Faza 3 item 4 |
| Instalacja na czystym macOS / weryfikacja dystrybucji FFmpeg (P11) | `remaining` | poza zakresem Fazy 2 |

---

## Faza 1 — sekcje historyczne (checkpoint po Fazie 1; statusy nadpisane przez tabelę Fazy 2 powyżej)

> [!WARNING]
> Poniższy blok („Data i Czas", tabela P0–P11 i rejestr blokad) jest **archiwum z Fazy 1**. Tamte statusy (`implemented-awaiting-verification`, `partial`, „brak paczki HyperFrames") zostały zaktualizowane przez Fazę 2 — patrz Tabela Fazy 2 i tabela „Obszary odłożone" powyżej. Poprawki review (runda 2026-09-24) dotyczą Fazy 2 i są opisane wyżej.

- **Data i Czas:** 2026-09-24 (Faza 1; punkty 1–7 poniżej opisują stan po Fazie 1)
  1. **P1 Czas i Dryf VFR:** `implemented-awaiting-verification`. Wdrożono deterministyczny 30-minutowy (1800s) test VFR z asercją niejednorodnych interwałów klatek (`uniqueIntervals.size > 1`), zsynchronizowanymi błyskami wideo (czarne tło, biały błysk 50ms co 1s) i dźwiękiem testowym (1000 Hz beep 50ms co 1s, cisza w pozostałym czasie). Eksport poprowadzono przez `RendererAdapter` i oś czasu EDG przy 30 i 60 fps. Test lokalizuje początek błysku (onset luma > 100 przez `showinfo`) oraz początek beepa (onset dźwięku przez `silencedetect`/`astats`) na początku (2s), w środku (900s) i na końcu (1798s), weryfikując `|flash_onset - beep_onset| <= 1.0 / targetFps` bez dodatkowych tolerancji.
  2. **P2 Governor (status Fazy 1 — NIEAKTUALNY):** w Fazie 1 oznaczony `implemented-awaiting-verification` z odłożonym testem wieloprocesowym. **Faza 2 item 3 zrealizował odłożony test**: `governor.multiprocess.test.js` 4/4 pass (3 osobne procesy, ciężki lock, konkurencja light, kill grupy procesów z wnukami, timeout realnego spawnu, odmowa przy niskim dysku). Patrz Tabela Fazy 2, wiersz 3.
  3. **P3 Renderer:** `partial`. Uproszczony tor renderowania przemianowany jednoznacznie na `ffmpeg-simple`. Bazowy `buildSceneConfig` generuje neutralną konfigurację sceny bez tagów silnika czy wersji; `buildFfmpegSimpleConfig` dodaje `engine: 'ffmpeg-simple'` oraz `version: '1.0.0'`; `buildHyperFramesConfig` zwraca metadane z `engine: 'hyperframes'`. `compareRenderPipelines` zredukowane wyłącznie do sprawdzenia metadanych (`comparisonType: 'metadata_only'`). *(Faza 2: pakiet hyperframes@0.8.72 przypięty i zweryfikowany realnym renderem side-by-side — patrz wiersz tabeli Fazy 2 nr 6; migracja nie jest już „brakiem paczki".)*
  4. **P6 Promo/Review & P7 Cartoon:** `implemented-awaiting-UI-verification` (crawler SSRF przetestowany na mockach; pełny walkthrough UI odłożony).
  5. **P8 Screen Studio:** `implemented-awaiting-hardware-verification` (brak fizycznego sprzętu, uprawnień TCC i BlackHole w środowisku CI).
  6. **P9 Avatar Studio (Fallback 2D Mascot):** `partial`. Zaimplementowano dynamiczną animację ust sterowaną obwiednią RMS wyprowadzoną z pliku audio narracji (`extractAudioEnvelope`), próbowanie długości z pliku oraz jawny błąd przy braku pliku. W `electron/preload.js` wyeksponowano brakujące metody `pickAudio` (`promo:pick-audio`) oraz `cancel2dMascot` (`promo:cancel-2d-mascot`). W `PromoReviewStudio.jsx` obsłużono błąd środowiska przy braku metod w bridge oraz dodano przycisk anulowania 2D Mascot. W `promoBridge.js` wdrożono wymóg zatwierdzenia przez Governor przed uruchomieniem renderowania oraz obsługę anulowania (stan `cancelled` wygrywa, zwalnia slot w Governorze). **Uwaga (bieżąca, nie sprzeczna z Fazą 2):** `promo:cancel-2d-mascot` wysyła SIGTERM wyłącznie do bezpośredniego procesu potomnego FFmpeg — nie przechodzi przez helper tree-kill Governora (`governedProcess.js`, przetestowany w Fazie 2 item 3). Ścieżka `promo:cancel-2d-mascot` → tree-kill Governora jest **odłożona** (nie otwierana w Fazie 2 poza regresjami).
  7. **P10 Auto-Publisher:** `implemented-offline + blocked-external` (przetestowany na mocku; zewnętrzna blokada Google App Review i limitów quoty). *(Faza 2 item 4: trwałość kolejki + crash recovery — patrz wyżej.)*
- **HEAD Commit:** 4e559e00e527ec7ecf29c585b4ca26daba125793 (+ niezacommitowane zmiany tej sesji)
- **Branch:** SAI-22-local-agent-providers
- **Zestaw testów Fazy 1:** `node --test packages/core/test/avatarStudio.test.js packages/core/test/rendererAdapter.test.js packages/core/test/promoBridge.test.js packages/core/test/timebase.test.js` (**32/32 zdanych, exit 0**)
- **Kompilacja i Lint:** `npm run build` (kod wyjścia 0, Turbopack 1310ms); `npm run lint` (kod wyjścia 0, 0 błędów, 14 ostrzeżeń w legacy kodzie)
- **Graphify (Faza 1):** `graphify update .` (kod wyjścia 0; 2675 węzłów, 5756 krawędzi)

---

## Tabela Postępu Etapów — historyczna inwentaryzacja z Fazy 1 (statusy bieżące: Tabela Fazy 2 i „Obszary odłożone" powyżej)

| Etap | Status historyczny (Faza 1) — komentarz Fazy 2 | Zakres wdrożony i rzeczywisty stan | Pliki powiązane |
|---|---|---|---|
| **P0: Inwentaryzacja & Baseline** | `completed` | Zachowano istniejący WIP, zaktualizowano dokumentację inwentaryzacji bez fałszywych deklaracji. | `INVENTORY.md` |
| **P1: EDG & Zegar Klatkowy** | `implemented-awaiting-verification` | Zegar racjonalny (30/60 fps), próbki 48 kHz, deterministyczny 30-min fixture VFR z asercją VFR, błyskami wideo (luma > 100), beepami audio, sprawdzeniem onsetów (2s/900s/1798s) z błędem A/V ≤ 1 klatka. | `timebase.js`, `timebase.test.js`, `edg.js` |
| **P2: Multi-process Governor & JobStore** | *(Faza 1: `implemented-awaiting-verification`, test 3 powierzchni odłożony → **Faza 2 item 3: `completed`**)* | Bounded wait queue, recovery po restarcie, próg pamięci 10 MiB, bezpieczne anulowanie drzewa procesów, wymuszenie braku spawn FFmpeg przy odmowie admisji. Test wieloprocesowy: `governor.multiprocess.test.js` 4/4. | `governor.js`, `jobs.js`, `governedProcess.js`, `governor.test.js`, `governor.multiprocess.test.js` |
| **P3: Renderer Adapter & Realny Eksport** | *(Faza 1: `partial`, „migracja remaining — brak paczki" → **Faza 2: paczka `hyperframes@0.8.72` przypięta, pin fail-closed, realny render zmierzony, napisy applied na obu silnikach (w tym overlay-png na FFmpeg); **Faza 3: EDG→HTML zrobione** — `renderExport(HYPERFRAMES, execute)` daje realny MP4; FFmpeg domyślny, HyperFrames opt-in**)* | Pełny FFmpeg compositor (`ffmpeg`) 9:16/1:1/16:9; `ffmpeg-simple` baseline; `compareRenderPipelines` = metadata_only; ścieżka HYPERFRAMES renderuje przez adapter HTML i fail-closed na EDG. | `rendererAdapter.js`, `rendererAdapter.test.js`, `renderers/hyperframesAdapter.js`, `hyperframesCompare.test.js` |
| **P4: AI Auto-Editor & NLE Export** | `partial (NLE export unverified-import)` | Konwersja Story/Repurpose/Cleaner do EDG z hashami SHA-256 i proweniencją; eksport FCPXML 1.9 i Premiere XML v4; import w NLE `unverified-import`. | `edg.js`, `project.js`, `repurpose.js`, `nleExport.js` |
| **P5: B-roll & Retention / Hooks** | *(Faza 1: `partial` → **Faza 2 items 1–2 `completed`**)* | Enforcement pól licencji B-roll (rejected z powodami w UI), MRR/PLR nadal `blocked-no-licence-document`. Parametry 0.72/30 dni/padding/zoom jako konfigurowalne hipotezy z etykietami, wartości docierają do backendu. | `broll.js`, `retention.js`, `autoEditorBridge.js`, `AutoEditorPanel.jsx` |
| **P6: Promo / Ads & Review / UGC** | `implemented-awaiting-UI-verification` | Responsywny wideo-as-code EDG, crawler SSRF DNS-guard, weryfikacja źródeł, oznaczenia afiliacji/AI. Walkthrough UI: `UI unverified`. | `promoAds.js`, `reviewUgc.js`, `PromoReviewStudio.jsx` |
| **P7: Generative Cartoon Studio** | `implemented-awaiting-UI-verification` | Szablony 2D, integracja Story/Animations, animacja ust, dymki i speedlines. Logika i render przetestowane; UI walkthrough odłożone. | `cartoon.js`, `CartoonStudio.jsx`, `MarketingStudio.jsx` |
| **P8: Screen Studio Adapter** | `implemented-awaiting-hardware-verification` | Natywny adapter desktopCapturer/avfoundation, korelacja PTS, zdarzenia kliknięć, auto-zoom. Brak sprzętu/TCC w CI. | `screenStudio.js`, `promoBridge.js`, `PromoReviewStudio.jsx` |
| **P9: Avatar & Talking Head Studio** | `partial` | Fallback 2D Mascot z obwiednią RMS, obsługą braku pliku, Governor admission, cancel → `cancelled`. `promo:cancel-2d-mascot` = SIGTERM do bezpośredniego dziecka (tree-kill w promoBridge **odłożony** — nie mylić z przetestowanym tree-kill Governora z Fazy 2 item 3). LivePortrait/Wav2Lip `blocked-licence`. | `avatarStudio.js`, `promoBridge.js`, `preload.js`, `PromoReviewStudio.jsx` |
| **P10: Auto-Publisher YouTube** | *(Faza 1: `implemented-offline + blocked-external` → **Faza 2 item 4: `completed`** z trwałą kolejką i crash recovery)* | Wznawialny upload (`queryUploadStatus`), `AbortController`, cancel → `cancelled`, quota handling, token refresh przez vault-injected providers, transport produkcyjny fail-closed. | `publisher.js`, `publisherBridge.js`, `PublisherQueuePanel.jsx`, `publisherMock.js` |
| **P11: Pakowanie & Środowiska** | `remaining` | Weryfikacja dystrybucji FFmpeg; instalacja na czystym macOS arm64 i macierz Windows odłożone (patrz tabela „Obszary odłożone"). | `rendererAdapter.js` |

---

## Rejestr Zewnętrznych Blokad i Ograniczeń (V2.6 Fail-Closed) — stan bieżący

1. **HyperFrames:** pakiet **`hyperframes@0.8.72` jest przypięty** w `package.json` i `package-lock` (integrity, Apache-2.0); adapter fail-closed weryfikuje pin. Realny render HTML→MP4 zmierzony side-by-side (EVIDENCE Faza 2 item 6). Napisy po stronie FFmpeg zrealizowane przez `overlay-png` (rasteryzacja Chromium offline + filtr `overlay` z `enable='between(...)'`). **Faza 3 zrealizowała konwersję EDG→HTML:** `renderExport(renderer='hyperframes', execute=true)` generuje projekt HTML i renderuje realny MP4 przez JobStore/Governor (FFmpeg pozostaje domyślnym rendererem, HyperFrames opt-in); nieużyte cechy EDG są zwracane w `unsupported[]` i pokazywane w UI. Historyczne „Brak paczki `@heygen/hyperframes`" jest **nieaktualne** (nazwa paczki to `hyperframes`, nie `@heygen/hyperframes`).
2. **B-roll MRR/PLR:** Brak dokumentu licencyjnego potwierdzającego prawo do redystrybucji. Paczka `blocked-no-licence-document`; dozwolone wyłącznie wpisy z kompletnymi polami licencji (kod exact-match + `redistributionRight` + `source` + proof URL/dokument).
3. **Modele Avatara (Wav2Lip / InsightFace):** Licencje non-commercial / zastrzeżone. System fail-closed blokuje wagi w środowisku komercyjnym. Aktywny fallback 2D Mascot z animacją ust sterowaną głosem.
4. **YouTube OAuth App Review:** Dostęp do publicznego API YouTube v3 ograniczony audytem Google Trust & Safety oraz limitami quoty (10 000 jednostek/dzień). Działanie przetestowane offline/loopback mock; rzeczywista publikacja wyłącznie po jawnym poleceniu użytkownika.
5. **macOS Screen Recording TCC & System Audio:** wymaga uprawnień TCC i sterownika BlackHole; kod zgłasza `unverified-on-hardware`.
6. **Zewnętrzne NLE Import:** pliki FCPXML 1.9 i Premiere XML v4 generowane wg schematu; rzeczywiste otwarcie w komercyjnych pakietach `unverified-import`.
7. **Modele Kokoro/ASR:** katalog `manifest-pending` (version/sha256/licence/sourceUrl = null — nic nie zmyślone); instalacja odrzucana przed siecią do czasu zweryfikowania manifestu.
