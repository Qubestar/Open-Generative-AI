# VIDMYO MASTER ARCHITECTURAL SPECIFICATION & IMPLEMENTATION ROADMAP (V2.5)
*Dokument Przeznaczony do Finalnej Oceny i Audytu Inżynierskiego przez Zewnętrznych Agentów*  
*Środowisko Docelowe: macOS Apple Silicon (Mac Mini M2 Pro, 16 GiB Unified RAM) | Stack: Electron + Next.js App Router + Tailwind + HyperFrames*

---

## 1. WPROWADZENIE I FILOZOFIA ARCHITEKTONICZNA

**Vidmyo** to zintegrowane, desktopowe studio produkcyjne wideo AI nowej generacji, którego celem jest pełna automatyzacja procesu tworzenia, montażu, optymalizacji konwersji i publikacji treści wideo w modelu *Video-as-Code*.

### Trzy Nienaruszalne Filary Systemu:
1. **Rozdział Warstwy Decyzyjnej AI od Deterministycznego Renderera:**  
   AI (LLM / VLM / ASR) odpowiada wyłącznie za analizę semantyczną, ekstrakcję zamiarów wizualnych i generowanie ustandaryzowanego grafu decyzji montażowych (**Editing Decision Graph / JSON**). Za montaż i render odpowiada deterministyczny silnik wykonawczy (**HyperFrames**), a nie sam model AI.
2. **Zero-Friction dla Użytkownika (Out-of-the-Box Experience):**  
   Użytkownik pobierający plik `.dmg` (macOS) lub `.exe` (Windows) otrzymuje gotowe do pracy studio z lokalną syntezą mowy (Kokoro-82M), detekcją ciszy, montażem, awatarami i animacjami natychmiast po instalacji. Zero wymuszania instalacji Dockera, baz danych PostgreSQL/Redis czy pobierania 15 GB środowisk Pythona.
3. **Ochrona Zasobów Sprzętowych (Zasada 16 GB Unified Memory na M2 Pro):**  
   Pamięć w Apple Silicon jest współdzielona pomiędzy CPU i GPU. Wprowadzamy centralny **Resource Governor**, który eliminuje ryzyko błędu Out-Of-Memory (OOM) poprzez sekwencyjne kolejkowanie zadań (concurrency = 1–2), buforowanie dyskowe i podglądy proxy 720p.

---

## 2. GŁÓWNE ZASADY INŻYNIERYJNE (WYNIKI AUDYTU ARCHITEKTURY)

### A. Resource Governor & Job Orchestrator
- **Ścisły limit współbieżności:** Nigdy nie uruchamiamy jednocześnie procesów ciężkich, np. Whisper ASR + render 4K + generowanie awatara LivePortrait + headless Chrome.
- **Kolejkowanie zadań w pipeline:** Orchestrator przydziela zadania workerom sekwencyjnie:  
  `Audio Synthesis -> ASR Transcription -> Semantic Decision Graph -> Asset Fetching -> Video Assembly/Render -> Publishing`.
- Po zakończeniu każdego etapu pamięć procesów pomocniczych jest natychmiast zwalniana (explicit GC & process termination).
- **Preview Proxy:** W trakcie edycji interaktywnej na osi czasu użytkownik operuje na lekkim podglądzie proxy 720p/1080p. Pełna rozdzielczość 4K renderowana jest dopiero przy eksporcie finalnym.

### B. Master Timeline Clock (Zegar Klatkowy)
- Wyeliminowanie błędu kumulacji czasu zmiennoprzecinkowego (`float seconds`), który po 2–3 minutach filmu wywołuje rozjazd audio z wideo (drift desynchronizacyjny).
- Wszystkie zdarzenia, cięcia, napisy i klatki kluczowe operują na sztywnych jednostkach klatek całkowitych:  
  durationFrames = round(audioDurationSeconds * fps)  
  Standard: fps in {30, 60}, audio = 48 000 Hz.

### C. Zunifikowany Silnik Produkcyjny: HyperFrames
- **Decyzja:** Eliminujemy duplikację instancji Chromium. Odrzucamy równoległe stosowanie Remotion jako silnika renderującego wideo w tle.
- **HyperFrames (Apache-2.0, HeyGen, v0.7.107):** Jeden, zoptymalizowany silnik wykonawczy operujący na czystym HTML/CSS/JS (z Anime.js v4) przez headless Chrome + FFmpeg. Posiada wbudowany szybki Kokoro-82M TTS, analizator bitów (`beats.json`) oraz wycinanie tła (`remove-background`).

---

## 3. PEŁNA SPECYFIKACJA 9 SEKCJI VIDMYO

### SEKCJA 1: Vidmyo Auto-Publisher (Social Media Hub)
- **Direct Native Publisher:** Wbudowany w Electrona, lekki klient API bez konieczności stawiania Dockera:
  - *YouTube Data API v3:* Upload filmów standardowych oraz Shorts (`#Shorts`), ustawianie statusów (public, unlisted, scheduled).
  - *TikTok Content Posting API:* Publikacja bezpośrednio na profil twórcy.
  - *Meta Graph API:* Publikacja rolek Instagram Reels dla kont Professional/Creator.
- **Lokalny Token Vault:** Tokeny OAuth 2.0 szyfrowane lokalnie w systemowym macOS Keychain / Electron safeStorage.
- **AI Viral Metadata & Thumbnail Studio:** Automatyczne generowanie 3 wariantów chwytliwych tytułów (do testów A/B), opisów z automatycznymi rozdziałami/timestampami, tagów SEO oraz dobór klatki o najwyższym współczynniku zatrzymania na miniaturę.
- **Postiz / Mixpost Bridge (Opcjonalny Pro Upgrade):** Konektor API/Webhook do zewnętrznej instancji Postiz dla agencji zarządzających dziesiątkami kont.

### SEKCJA 2: Vidmyo Screen Studio (Rejestrator SaaS & Demo Walkthrough)
*Wzorowane na Recordly / Screen Studio*
- **Natywny Capture macOS:** Wykorzystanie ScreenCaptureKit (4K, 60 FPS, znikome obciążenie CPU/GPU M2 Pro).
- **Zsynchronizowana Telemetria Kursora:** Równoległy zapis współrzędnych myszy (x, y) i zdarzeń kliknięć w strumieniu metadanych.
- **Smart Auto-Zoom:** Automatyczne, kinowe zbliżenia na klikane przyciski i formularze z fizyką sprężynową (PixiJS/WebGL).
- **Studio Canvas:** Dynamiczne tła 4K (siatkowe gradienty, rozmyte tapety), zaokrąglone narożniki okna, trójwymiarowy cień oraz okrągła pływająca kamerka prelegenta (Webcam Bubble) z automatycznym wycięciem pokoju przez `hyperframes remove-background`.

### SEKCJA 3: Stock & B-Roll Matcher Engine
*Wzorowane na MoneyPrinterTurbo*
- **Darmowe Bazy Mediów:** Integracja z API Pexels, Pixabay oraz Coverr (100% darmowe licencje komercyjne, 1080p/4K).
- **Visual Intent Extraction:** LLM analizuje zdania i zamiast generycznych słów generuje ustrukturyzowany zamiar wizualny:  
  `{"subject": "przedsiębiorca", "action": "analiza spadków na giełdzie", "emotion": "stres", "shot": "zbliżenie"}`.
- **Match Confidence Threshold:** Jeśli pewność dopasowania klipu ze stocka wynosi < 0.72, system **nie wstawia losowego wideo**, lecz pozostawia kadr oryginalny.
- **1-Click Swap Canvas:** Błyskawiczna galeria do podmiany zaproponowanego ujęcia jednym kliknięciem.

### SEKCJA 4: Vidmyo AI Auto-Editor (Wirtualny Montażysta / Automatyczny Montaż)
*Wzorowane na auto-editor, Gling.ai, Descript i Perfect Cuts v2*
- **The Best Take Selector 2.0:** Semantyczne grupowanie powtórzonych zdań i wieloczynnikowy scoring (płynność, kompletność myśli, pewność w głosie, brak zacięć) – zachowuje najlepszą, a nie ślepo ostatnią próbę.
- **Rozdzielona Detekcja Ciszy i Wypełniaczy:**
  - *Martwa cisza i oddechy:* Wykrywane przez decybele / VAD (Silero VAD).
  - *Dźwięki "yyyy/eeee/hmmm":* Wykrywane na poziomie tokenów transkrypcji ASR (Whisper).
- **Context-Aware Padding (Eliminacja sztywnego 150 ms):**
  - speech -> filler -> speech: 80–130 ms
  - speech -> breath -> speech: 120–220 ms
  - sentence -> sentence: 200–450 ms
  - topic transition: 350–800 ms
- **Event-Driven Punch-In Zoom (1.08x / 1.15x / 1.22x):** Zbliżenia wyzwalane zmianą wątku, pytaniem, słowem kluczowym lub kulminacją zdania (z safeguardem maksymalnej stagnacji wizualnej 6–9 sekund).
- **Sidechain Auto-Ducking:** Muzyka w tle nie skacze dwustanowo (-15 dB), lecz płynnie oddycha za pomocą obwiedni sidechain (attack: 100 ms, release: 500 ms).
- **Eksport NLE:** Wygenerowanie zgrubnego montażu do `.fcpxml` (DaVinci Resolve / Final Cut Pro) oraz `.xml` (Adobe Premiere Pro).

### SEKCJA 5: Viral Retention & Dual-Hook Engine (Z Bazą Visual Hooks MRR)
- **Framework R.A.I.N.Y.:** Heurystyka pierwszych sekund skryptu (Relevance, Anticipation, Intrigue, Novelty, You).
- **Dual-Hook System (System Podwójnego Haka):** Jednoczesne uderzenie hakiem słownym (Curiosity Gap) oraz hipnotyzującym klipem wizualnym (Visual Hook) w pierwszych 2.5 sekundach.
- **Baza Visual Hooks (5 GB, 1000+ klipów MP4 z licencją MRR/PLR):**
  - *Status Prawny:* Potwierdzona licencja **Master Resell Rights i Private Label Rights** (dokument `E_300ViralHooks_MRR.pdf` str. 21).
  - *Dystrybucja:* Nie pakujemy 5 GB do instalatora Vidmyo (zbyt duży plik). Oferujemy go użytkownikom jako **Darmowy Bonus 1-Kliknięciem** do pobrania wewnątrz programu.
  - *Algorytm Rotacji (Anti-Fatigue):* Klipy mają wagi i historię użyć – ten sam klip nie pojawi się na kanale częściej niż raz na 30 dni, co zapobiega karom algorytmów za powtarzalną treść (recycled content penalty).
- **Retention Event Engine:** Dynamiczne rozmieszczanie otwartych pętli narracyjnych (*Retention Loops*) oraz zwrotu akcji (*Midpoint Re-Engagement*) w 45–70% filmu.

### SEKCJA 6: Generative Anime & Cartoon Studio (Bajki i Kreskówki)
- **Script-to-Scene Storyboard:** Automatyczny podział scenariusza na sceny, postacie, tła i kwestie dialogowe (wzorowane na Toonflow-app).
- **Character Consistency Sheet:** Karta tożsamości bohatera zapobiegająca zmianom wyglądu między scenami (architektura inspirowana OmniChar, czysta implementacja bez kodu GPL-3.0).
- **Dual-Engine Execution:**
  - *Tryb 1 (100% Lokalny M2 Pro, 0 zł):* Render w HyperFrames + Anime.js v4. Wektorowe postacie, wycinanki 2D, linie akcji (*speedlines*), dymki komiksowe i ruch ust sterowany amplitudą audio. Czas renderu: ~10 sekund.
  - *Tryb 2 (Chmura BYOK):* Generowanie ujęć fotorealistycznych lub wideo dyfuzji przez zewnętrzne API (Muapi.ai, Kling, Wan 2.1, Flux).

### SEKCJA 7: Vidmyo Avatar & Talking Head Studio (Ożywianie Zdjęć Bez Modeli Dyfuzji)
*Moduł pozwalający wgrać dowolne zdjęcie (portret twórcy, postać AI, grafikę maskotki) i ożywić ją mową z naturalną mimiką.*
- **Dlaczego Eliminujemy Modele Dyfuzji Wideo (SVD, Wan 2.1, CogVideoX)?**
  Modele dyfuzji wideo wymagają 16–24 GB pamięci VRAM na samo załadowanie wag, generują 5-sekundowe wideo przez 8–15 minut i natychmiast doprowadziłyby 16 GB M2 Pro do zapaści pamięciowej (OOM swap).
- **Architektura Wykonawcza: LivePortrait (Kling AI Research) + Lekki Lip-Sync:**
  - **LivePortrait:** Oparty na niejawnych punktach kluczowych (implicit keypoints) i zszywaniu cech wyglądu (appearance feature stitching). Działa bez generowania klatek przez dyfuzję od szumu.
  - **Wydajność na Apple Silicon:** Działa z akceleracją MPS (Metal Performance Shaders) lub CoreML/ONNX. Zużycie pamięci: zaledwie **1.2–1.8 GB RAM**. Szybkość generowania: **30+ FPS** (praktycznie czas rzeczywisty).
  - **Naturalna Ekspresja:** Precyzyjne sterowanie ruchem gałek ocznych, mruganiem, mikro-uśmiechami i rotacją głowy w trzech osiach (yaw, pitch, roll).
  - **Sterowanie Mową (Audio-Driven Lip-Sync):** Mapowanie obwiedni fonemowej audio na punkty warg (wsparcie przez adapter Wav2Lip-HR lub audio-extension LivePortrait).
  - **Zabezpieczenie Resource Governor:** Render awatara jest izolowany jako zadanie sekwencyjne. Jeśli renderowany jest awatar, HyperFrames czeka na zwolnienie pamięci MPS.
  - **Format Wyjściowy:** Przezroczyste wideo ProRes 4444 lub sekwencja klatek WebP/PNG z maską alpha, co pozwala na nałożenie gadającego awatara w dowolnym rogu ekranu w HyperFrames (Webcam overlay) lub jako głównego prezentera.

### SEKCJA 8: Vidmyo Promo & Ads Studio (URL-to-Video / Generator Reklam)
*Wklejasz adres URL (strona firmowa, landing page, karta produktu na Amazonie/Shopify) -> AI analizuje zawartość -> generuje gotową reklamę wideo w 3 formatach.*
- **Inteligentny Crawler & Scraper (Playwright + Cheerio):**
  - Pobiera metadane OpenGraph, nagłówki (H1-H3), treść oferty, cenniki, opinie klientów oraz galerię zdjęć w wysokiej rozdzielczości (hero images, product packshots).
  - Ekstrakcja danych strukturalnych Schema.org: `Product`, `LocalBusiness`, `Organization`, `AggregateRating`.
- **Hybrydowy Klasyfikator Intencji (Auto-Detection z Możliwością Nadpisania):**
  - **Kategoria A: Local Business (Biznes Lokalny):** Np. *Stomatolog w Warszawie, Warsztat Samochodowy w Krakowie, Restauracja*. Wykrywa lokalizację geograficzną, godziny otwarcia, zakres usług i certyfikaty.
  - **Kategoria B: E-Commerce / Physical Product (Produkt Fizyczny):** Wykrywa cenę, warianty, specyfikację, korzyści fizyczne i opinie.
  - **Kategoria C: Digital / SaaS / Serwis:** Wykrywa model subskrypcyjny, funkcjonalności platformy i zrzuty ekranu aplikacji.
  - *User Override:* Użytkownik jednym kliknięciem może zmienić typ lub dopisać dodatkowy kontekst w promptcie (np. *"Skup się na wybielaniu zębów metodą laserową"*).
- **Generator Skryptów Reklamowych (Formuła Hook -> Problem -> Rozwiązanie -> Oferta -> CTA):**
  - Dopasowuje ton narracji (energetyczny, profesjonalny, problemowy).
- **Multi-Format Responsive Render (HyperFrames):**
  - **9:16 (Shorts, TikTok, Instagram Reels):** Kadr pionowy, duży napis na górze przyciągający wzrok, dynamiczne przejścia zrzutów ekranu / zdjęć produktów na środku, animowane korzyści na dole.
  - **1:1 (Facebook & Instagram Feed Ads):** Kadr kwadratowy z ramką brandingową.
  - **16:9 (YouTube Ads, Strona WWW):** Format panoramiczny z kinowymi przejściami i planszą końcową (End Screen).

### SEKCJA 9: Vidmyo Review & UGC Studio (Recenzje, Afiliacja i Local Business)
*Tworzenie autentycznych filmów w stylu User-Generated Content (UGC) oraz wideo-recenzji produktów i usług lokalnych w oparciu o przetestowane psychologicznie struktury konwersji.*

#### Psychologiczna Architektura Konwersji (W oparciu o Trening Alexa Beckera z kanału MyIMPlace):
Audyt materiału wideo ujawnia dwa fundamentalne typy wyszukiwań i intencji klientów, które Vidmyo bezpośrednio implementuje jako gotowe szablony skryptowe dostępne w interfejsie:

1. **Typ 1: Formuła "Review Search" (Dół Lejka – Bezpośrednia Decyzja Zakupowa):**
   - *Intencja Odbiorcy:* Użytkownik wpisuje w wyszukiwarkę konkretną nazwę: `[Nazwa Produktu] recenzja / opinie` lub `[Gabinet Stomatologiczny X Warszawa] opinie`. Szuka potwierdzenia przed wydaniem pieniędzy.
   - *Klucz Konwersji:* **Brutalna szczerość**. Jeśli recenzja wymienia wyłącznie zalety, odbiorca wyczuwa sponsorowaną reklamę i ucieka. Skrypt Vidmyo celowo eksponuje 1–2 realne minusy produktu, co podnosi zaufanie do rekomendacji o 300%.
   - *Dla Afiliacji:* Wstawianie unikalnego pakietu bonusowego ("Kup przez mój link, a otrzymasz bezpłatny poradnik/szablon").
   - *Dla Biznesu Lokalnego:* Prezentacja realnego doświadczenia pacjenta/klienta od wejścia do lokalu po finalny efekt.

2. **Typ 2: Formuła "Goal / Problem / How-To Search" (Poradniki, Edukacja i Rozwiązywanie Problemów — Góra i Środek Lejka – 10x do 100x Większy Wolumen):**
   - *Intencja Odbiorcy:* Użytkownik nie szuka jeszcze konkretnego produktu. Wpisuje zapytanie poradnikowe lub szuka rozwiązania problemu: *"jak zrobić X"*, *"jak szybko pozbyć się bólu zęba w nocy"*, *"jak wybielić zęby bez uszkadzania szkliwa"*, *"jak zaoszczędzić na podatkach w firmie"*, *"jak schudnąć 5 kg przed latem"*.
   - *Wybór w UI:* W interfejsie Vidmyo użytkownik wybiera tryb z przełącznika: **[Review / Opinia Produktu / Firmy]** vs **[Goal / Problem / How-To (Poradnik Edukacyjny)]**.
   - *Dlaczego jest to kluczowe:* Format "How-To" generuje największy organiczny ruch w wyszukiwarkach (YouTube i Google), bo ludzie szukają instrukcji krok po kroku. Liczba osób szukających rozwiązania problemu jest stukrotnie większa niż osób znających już konkretną markę.
   - *Klucz Konwersji (Formuła How-To Edukacyjno-Ofertowa):*
     - *Krok 1 (Pain/Goal Hook):* Zidentyfikowanie frustracji lub celu ("W tym poradniku pokażę Ci, jak rozwiązać X bez Y...").
     - *Krok 2 (Dispelling Myths):* Wyjaśnienie, dlaczego popularne porady z internetu nie działają lub wręcz szkodzą.
     - *Krok 3 (The Hidden Mechanism):* Wyjaśnienie biologicznej, technicznej lub prawnej przyczyny problemu.
     - *Krok 4 (The Logical Vehicle):* Pokazanie, że promowany produkt lub wizyta w danej firmie lokalnej to jedyny logiczny sposób na naprawę tej konkretnej przyczyny.
     - *Krok 5 (Social Proof):* Zintegrowane opinie z Google Maps / Trustpilot.
     - *Krok 6 (Next Step CTA):* Umówienie wizyty, telefon do firmy lub kliknięcie w link partnerski pod poradnikiem.

- **Integrator Wiarygodności (Social Proof Engine):**
  - Automatyczne zaciąganie i stylizowanie gwiazdek Google Reviews, Trustpilot oraz cytatów zadowolonych klientów w formie animowanych badge'y w HyperFrames.
- **Affiliate & UTM Link Generator:**
  - Automatyczne generowanie linków z tagami UTM do wklejenia w opisie na YouTube / TikToku.

---

## 4. TRÓJPOZIOMOWY SYSTEM AUDIO (ZERO-FRICTION)

1. **Poziom 1 (Wbudowany / Zero-Install):** Wykorzystanie natywnego `hyperframes tts` z modelem **Kokoro-82M** (~80 MB) lub Edge-TTS. Działa od razu po instalacji Vidmyo bez pobierania zewnętrznych pakietów Pythona.
2. **Poziom 2 (Lokalne Klonowanie Pro):** Auto-detekcja lokalnego API `Voicebox.app` (`http://127.0.0.1:17493`), gdzie zainstalowany jest komercyjny silnik **Chatterbox (MIT)** z seedem `42` (używany dla kanału Superiusz).
3. **Poziom 3 (Chmurowe API / BYOK):** Podpięcie ElevenLabs / Cartesia / OpenAI Audio.

---

## 5. WEWNĘTRZNE PIPELINE'Y PRODUKCYJNE (TYLKO DLA KANAŁÓW WŁASNYCH: CURIO I SUPERIUSZ)

> [!IMPORTANT]
> **UWAGA DLA RECENZENTA DOTYCZĄCA PRODUKTU VIDMYO DLA KLIENTÓW:**  
> Kwestie potoków kanałów **Curio** oraz **Superiusz** to wyłącznie **nasze wewnętrzne, lokalne środowiska produkcyjne** (poligon testowy i wewnętrzne kanały YouTube twórcy).  
> **NIE SĄ ONE częścią komercyjnego oprogramowania Vidmyo oferowanego użytkownikom końcowym ani nie wchodzą w skład produktu na sprzedaż.**  
> Użytkownicy komercyjni Vidmyo otrzymują uniwersalne, modularne studio (Sekcje 1–9) ze standardowymi szablonami, uniwersalnym silnikiem TTS (Kokoro/BYOK) oraz generatorami reklam/recenzji/awatarów. Pipeline'y Curio i Superiusza służą nam jedynie jako wewnętrzny benchmark jakościowy (*In-House Production Benchmark & Dogfooding*) oraz do automatyzacji naszych własnych kanałów na YouTube.

*Bezpieczeństwo: Oryginalne, działające skrypty zostały zarchiwizowane w nienaruszonym katalogu:*  
`/Volumes/My Lexar/AI Projects/_BACKUP_PIPELINES_20260923/`

### A. Wewnętrzny Pipeline dla CURIO (Doodle Explainer, styl Zenn – Kanał Własny):
1. Generowanie skryptu z frameworkiem R.A.I.N.Y.
2. Generowanie narracji przez wbudowany `hyperframes tts "..."` (Kokoro, głos `am_onyx`).
3. Wykrycie siatki bitów muzyki przez `hyperframes beats bg_music.mp3` -> `beats.json`.
4. Pobranie grafik z Flow (Nano Banana 2) i automatyczne usunięcie tła przez `hyperframes remove-background`.
5. Złożenie całości w szablonie HTML/CSS HyperFrames z animacjami Anime.js. Render do 60 FPS MP4 z idealną synchronizacją klatkową (koniec z błędami desyncu z `assemble.py` i PIL).

### B. Wewnętrzny Pipeline dla SUPERIUSZ (Edukacyjny kanał PL, maskotka Fox stickman – Kanał Własny):
1. Generowanie skryptu z podziałem na akapity.
2. Zapytanie do lokalnego Voiceboxa (`Chatterbox MIT`, profil `Głos 4`, seed `42`) akapit po akapicie (omija błąd bufora długiego tekstu).
3. Złożenie scenariusza w szablonie HTML/CSS HyperFrames z wektorowym liskiem sterowanym przez Anime.js.
4. Parity QA: Porównanie klatka po klatce nowego renderu z archiwalnym przed wyłączeniem starego potoku.

---

## 6. MACIERZ PRAWNA I LICENCYJNA

| Komponent | Licencja | Dozwolony użytek komercyjny (Monetyzacja YT/Social) | Redystrybucja z Vidmyo |
| :--- | :--- | :--- | :--- |
| **Chatterbox TTS** | MIT (kod i wagi) | TAK (100% zweryfikowane) | TAK |
| **Kokoro-82M** | Apache-2.0 | TAK | TAK |
| **HyperFrames** | Apache-2.0 (HeyGen) | TAK | TAK |
| **auto-editor** | Unlicense (Public Domain) | TAK | TAK |
| **LivePortrait** | MIT / Academic-Commercial Permissive | TAK (dozwolona lokalna inferencja) | TAK (jako opcjonalny moduł wag lub inferencja ONNX) |
| **Baza Visual Hooks (5 GB)** | **MRR / PLR** (Master Resell Rights) | TAK (100% zweryfikowane w PDF) | TAK (jako bonus do softu / link) |
| **OmniChar** | GPL-3.0 | NIE (ryzyko copyleft) | **ZAKAZ kopiowania kodu** (tylko inspiracja ideowa) |
| **Postiz** | AGPL-3.0 | NIE (w kodzie aplikacji) | **Tylko zewnętrzne API** (brak kodu Postiz w Vidmyo) |

---

## 7. ETAPOWY PLAN WDROŻENIA (ROADMAPA KROK PO KROKU)

### Faza 0: Fundamenty Stabilności (Dni 1–5)
- Implementacja **Vidmyo Resource Governor** w `packages/core` (limit renderConcurrency = 1–2, ochrona RAM na M2 Pro).
- Wdrożenie **Master Timeline Clock** (sztywna baza klatek całkowitych `integer frames` zamiast zmiennoprzecinkowych sekund).
- Przygotowanie definicji kontraktu **Editing Decision Graph (JSON)**.

### Faza 1: Silnik Audio & HyperFrames Core (Dni 6–10)
- Utworzenie adaptera `packages/core/src/HyperframesAdapter.js` łączącego Vidmyo z globalnym binarium `hyperframes`.
- Podpięcie `hyperframes tts` (Kokoro-82M) jako domyślnego głosu Tier 1.
- Podpięcie lokalnego Voicebox API (`http://127.0.0.1:17493`, Chatterbox seed 42) jako głosu Tier 2.

### Faza 2: Wewnętrzne Testy & Dogfooding (Pipeline Własny Curio & Superiusz) (Dni 11–18)
- *Cel:* Walidacja silnika HyperFrames na realnych projektach produkcyjnych własnych kanałów przed wypuszczeniem modułów dla klientów.
- Odtworzenie szablonu graficznego Curio (Amber Face + doodle) w czystym HTML/CSS/Anime.js dla HyperFrames.
- Odtworzenie szablonu Superiusza (Fox stickman) w HTML/CSS dla HyperFrames.
- Testy porównawcze (Parity QA) – generowanie próbek side-by-side i potwierdzenie 100% spójności marki z wersjami archiwalnymi.

### Faza 3: AI Auto-Editor & Baza Visual Hooks (Dni 19–28)
- Wdrożenie algorytmu **The Best Take Selector 2.0** (grupowanie semantyczne i wieloczynnikowy scoring).
- Wdrożenie rozdzielonej detekcji: VAD dla ciszy + Whisper ASR dla "yyyy/eeee" z płynnym marginesem *Context-Aware Padding*.
- Indeksacja lokalnej bazy 1000+ Visual Hooks z `/Volumes/My Lexar/Marketing Biz/Viral/` oraz mechanizm rotacji klipów.
- Połączenie ze Stock & B-Roll Matcherem (Pexels API) z progiem pewności `confidence >= 0.72`.

### Faza 4: Avatar & Talking Head Studio (Dni 29–38)
- Integracja lekkiego silnika **LivePortrait** z akceleracją Apple Silicon Metal (MPS / ONNX / CoreML) bez użycia modeli dyfuzji wideo.
- Implementacja audio-driven lip-sync i mapowania fonemów na geometrię ust.
- Wpięcie procesu do Resource Governora (ochrona przed kolizją pamięciową z renderem wideo).
- Generowanie przezroczystych nakładek (alpha video / WebP sequence) do umieszczenia w szablonach HyperFrames.

### Faza 5: Vidmyo Promo, Ads & Review/UGC Studio (Dni 39–48)
- Budowa parsera stron WWW (Playwright/Cheerio) z auto-detekcją `LocalBusiness` vs `Product` vs `SaaS`.
- Wdrożenie dwóch silników skryptowych Alexa Beckera:
  - *Review Search Engine:* Oparty na brutalnej szczerości, plusach/minusach i unikalnym bonusie/rabacie.
  - *Goal / Problem / How-To Search Engine:* Oparty na obalaniu mitów, odkryciu ukrytego mechanizmu i przedstawieniu usługi/produktu jako wehikułu (format poradnikowy).
- Przygotowanie responsywnych szablonów HyperFrames w 3 formatach (9:16, 1:1, 16:9) z automatycznym zaciąganiem gwiazdek Google Reviews / Trustpilot.

### Faza 6: Vidmyo Screen Studio & Auto-Publisher (Dni 49–58)
- Implementacja natywnego modułu ScreenCaptureKit w Electronie (4K 60 FPS).
- Rejestracja wektora myszy i automatyczny algorytm kinowego przybliżania (Smart Auto-Zoom z fizyką sprężynową w PixiJS).
- Integracja z oficjalnym YouTube Data API v3 (obsługa Shorts i filmów standardowych) oraz TikTok Content Posting API.
- Lokalny skarbiec tokenów w macOS Keychain.
