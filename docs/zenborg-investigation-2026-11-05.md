# Vidmyo / Zenborg — wynik sprawdzenia 2026-11-05

## Zmiany w UI
Reżyser jest wymagany również dla animacji z kodu. Not needed dotyczy wyłącznie image generation. Animations automatycznie sprawdza połączenie z Zenborgiem. Podłączone profile przeglądarkowe pojawiają się jako karty obok pozostałych reżyserów; kliknięcie wybiera konkretny profil. Bez połączenia widoczna jest akcja Connect Zenborg, bez fikcyjnej karty dostępnego agenta. Zapisany, niedostępny profil wymaga ponownego połączenia albo świadomego wyboru innego reżysera.

## Naprawione połączenie
Vidmyo uruchamiało MCP z checkoutu Maiox, używającego innego katalogu danych niż uruchomiona Zenborg.app 1.0.10. To powodowało HTTP401 AUTH_REQUIRED. Vidmyo teraz preferuje runner z zainstalowanej aplikacji i jej Application Support/Zenborg. Ten sam odczyt profili daje HTTP200 i zwraca ChatGPT Browser Architect. Nie zmieniono kodu Zenborga, danych uwierzytelniających, polityki ani procesu serwera.

## Nadal blokowane wykonanie przez ChatGPT
Rzeczywiste zenborg_ask odrzuca profil browser-agent komunikatem Harness browser-agent is disabled (HARNESS_DISABLED). Nie powstało zlecenie ChatGPT. W sprawdzonej ścieżce collab brakuje zarówno dopuszczenia browser-agent w DEFAULT_POLICY, jak i gałęzi adapterFactory. Istniejący browser worker w agent loops nie dowodzi obsługi pojedynczego zlecenia przez ask. Samo włączenie flagi nie wystarczy.

Opus został zapytany przez działający MCP w projekcie Vidmyo. Po otrzymaniu fragmentów źródeł potwierdził oba braki i skorygował początkową diagnozę dotyczącą samej polityki. Sesja: http://localhost:3001/index.html?session=ses_89ff8db46e2b715ac5c7f0025a4d5bf50a1e . Szczegółowy handoff: zenborg-browser-dispatch-handoff-2026-11-05.md.

Pełnego przebiegu GPT → narracja → MP4 nie można zatem potwierdzić. Lokalny renderer z prawdziwym plikiem narracji przeszedł osobny test. Nie przedstawiamy tego jako ukończonego zlecenia przez GPT.

## Dowody weryfikacji
- .tmp/zenborg-final-checks.json: główne testy726/726, focused46/46, MCP52/52, wszystkie exit0. Izolacja rzeczywistego katalogu użytkownika PASS.
- Ten sam manifest: rzeczywisty render7.1s,640x360,12fps, audio=true,3 różne klatki kontrolne,0 żądań sieciowych, exit0.
- output/playwright/animation-qa/verification.json:10 sprawdzeń UI exit0; scenariusz połączonego UI używa jawnego mocka granic Electron, nie symuluje wykonania przez GPT.
- .tmp/zenborg-director-build.json: produkcyjny build exit0 po zmianie UI.
- .tmp/zenborg-connection-fixed.json, zenborg-auth-diagnosis.json, zenborg-dispatch-diagnosis.json: rzeczywista diagnoza połączenia i odmowy wykonania.

## Bramka wydania — odrębna od Zenborga
Naprawiono dwa ERROR ze skanera: uruchamianie kontenera jako root oraz shell interpolation w codesign. Obecny Semgrep:0 ERROR,58 WARNING,7 INFO;12 błędów parsowania wymaga rozliczenia pokrycia, więc skan nie stanowi pełnego zielonego dowodu. MCP audit:0 podatności. Główny audit produkcyjny:0 critical,12 high,28 moderate; pozostałe zależności runtime wymagają dalszej pracy. Nie zastosowano wymuszonych downgrade ani zmiany progów.

Poprzednie niezamknięte elementy wydania: brak skonfigurowanego typecheck, timeout180s pełnego historycznego skanu sekretów (to nie jest wykryty wyciek), brak pełnego zestawu aktualnych dowodów mutacji/W1/W2/rollback oraz brak związanego z finalnym commitem raportu wydania. Poprzedni ograniczony skan zmienianych plików nie zastępuje skanu historii. Nie wydano instalatora; lokalnie działający UI i testy nie są deklaracją przejścia globalnej bramki.
