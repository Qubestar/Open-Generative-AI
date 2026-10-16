# CurioFlow — plan dostępu dla subskrybentów

Status: propozycja architektury, 22 września 2026. Zakres: plan; bez wdrożenia i zmian kodu.

## Rekomendacja

CurioFlow jest częścią subskrypcji Vidmyo: jedno konto, jedna płatność i osobne uprawnienie `flow.automation`. Oficjalna wtyczka uruchamia nowe generacje tylko po autoryzacji przez wspólny serwis kont i subskrypcji. Nie wprowadzamy osobnych ręcznie kopiowanych kluczy licencyjnych.

Proponowane ustawienia startowe, do zatwierdzenia produktowego przed implementacją: dwie aktywowane instalacje/profil Chrome na osobę i jedna równoległa kolejka na płatne stanowisko. Zespół otrzymuje własne konta użytkowników i przypisane stanowiska. Chrome nie daje wiarygodnej tożsamości fizycznego komputera; instalacja nie oznacza urządzenia odpornego na skopiowanie.

## Ustalenia z repozytoriów

- Vidmyo posiada `packages/core/src/entitlement.js`, `electron/lib/entitlementService.js` i runtime klienta uprawnień. Dokument `docs/local-first-subscription-architecture.md` przewiduje wspólne konta i krótkie pozwolenia dla wtyczki. Uruchomiony backend płatności i podpisywania nie został zweryfikowany w tej sesji; wcześniejszy handoff wskazuje go jako zależność do wdrożenia.
- Znaleziono trzy różne kopie: `Flow Chrome Extension` 0.4.5 z integracją MCM, jego `.worktrees/flow-queue-v1` 0.6.7 oraz `Flow Extension v2` 0.7.0. Nie należy wybierać bazy wydania wyłącznie po numerze wersji. Przed implementacją ustalić faktycznie używany katalog i wymagane integracje.
- W przejrzanych ścieżkach kolejki brak kontroli abonamentu. `src/background/service-worker.js` obsługuje Start/Resume/Retry, a `src/background/queue-runner.js` wysyła `FLOW_SUBMIT`. Bramka musi objąć wspólną ścieżkę wykonywania, nie tylko przyciski.
- Token parowania MCM z localhost uwierzytelnia integrację lokalną; nie jest dowodem opłaconej subskrypcji Vidmyo.

## Instalacja i pierwsze uruchomienie

1. Klient opłaca abonament i otrzymuje dostęp w koncie Vidmyo.
2. Z panelu konta instaluje rozszerzenie z Chrome Web Store. Na start rekomendowana widoczność Unlisted, a przed premierą Private dla testerów.
3. Wybiera „Połącz konto Vidmyo”. Logowanie przez `chrome.identity.launchWebAuthFlow`, Authorization Code + PKCE, losowy `state` i ściśle zarejestrowany adres powrotu. Wtyczka jest klientem publicznym bez sekretu OAuth. Konto w Google Flow może mieć inny e-mail niż konto Vidmyo.
4. Backend rejestruje instalację i stanowisko, a rozszerzenie pokazuje konto, status oraz „Gotowe do pracy”. Desktop nie musi stale działać. W przyszłości parowanie przez desktop może uprościć ten sam przepływ, ale lokalne oświadczenie desktopu nigdy nie zastępuje autoryzacji serwera.
5. Odświeżanie sesji odbywa się automatycznie. Ponowne logowanie tylko po wylogowaniu, unieważnieniu sesji lub jej utracie, a nie co kilka dni.

Unlisted ukrywa pozycję w wyszukiwaniu sklepu, lecz każdy posiadający link może ją zainstalować. Dostęp do używania wynika z konta i płatności. Jeśli wymagane będzie również ograniczenie samej instalacji, Private z listą testerów/Google Group zapewnia dodatkową warstwę, lecz wymaga zarządzania kontami Google i nie zastępuje licencjonowania. [Dokumentacja dystrybucji Chrome](https://developer.chrome.com/docs/webstore/cws-dashboard-distribution).

## Backend i płatności

Wspólny backend Vidmyo na VPS, bez osobnego serwera dla wtyczki. Wybór hosta po pomiarze wolnych zasobów; istniejące n8n i inne usługi wymagają izolacji. Media, rendery, hasła Google i sesje Google Flow pozostają na komputerze klienta.

Minimalne dane: konta, członkostwo w zespole/stanowiska, subskrypcje i opłacony termin, instalacje, odwoływalne sesje, dzierżawy kolejek, pozwolenia na próby i przetworzone zdarzenia płatnicze. Plan jest mapowany na capabilities po stronie serwera; klient nie deklaruje sam swojego pakietu.

Użyć tego samego operatora co Vidmyo; jeśli nie został wybrany, Stripe jest wariantem referencyjnym. Obsługiwać potwierdzenia opłat, zmiany i zakończenie subskrypcji, nieudaną płatność oraz administracyjne odebranie dostępu. Weryfikować podpis webhooka na surowym body, deduplikować event ID, obsłużyć zdarzenia poza kolejnością i okresowo uzgadniać stan z operatorem. Powrót na stronę sukcesu płatności sam nie aktywuje uprawnień. [Stripe: webhooki subskrypcji](https://docs.stripe.com/billing/subscriptions/webhooks).

| Zdarzenie | Zachowanie oficjalnej wtyczki |
|---|---|
| Potwierdzona płatność i aktywne uprawnienie | Można uruchamiać nowe zadania |
| Anulowanie odnowienia | Dostęp do końca już opłaconego okresu |
| Nieudane odnowienie | Nie przedłużać opłaconego terminu; po nim blokować nowe generacje |
| Brak płatności, wygaśnięcie, odebrane stanowisko | Brak nowych pozwoleń; kolejka zachowana |
| Cofnięcie dostępu przez administratora | Unieważnić sesje i dzierżawy; kolejne sprawdzenie odmawia |
| Zwrot/chargeback | Zastosować jawną politykę billingową; nie utożsamiać każdego częściowego zwrotu z anulowaniem |
| Odnowienie po blokadzie | Automatycznie przywrócić uprawnienie; użytkownik sam wznawia kolejkę |

Nie proponujemy trialu ani dodatkowych dni dostępu po nieopłaconym terminie w pierwszej wersji. Ewentualne wyjątki później muszą być jawną polityką, nie skutkiem braku synchronizacji.

## Kontrola wykonywania

- Start tworzy na serwerze ograniczoną czasowo dzierżawę kolejki, atomowo rezerwując limit równoległej pracy dla konta/stanowiska. Start/Resume/Retry i integracje korzystają z tego samego mechanizmu.
- Każda nowa próba generacji pobiera online krótkie pozwolenie, proponowane 60 sekund, tuż przed `FLOW_SUBMIT`. Serwer sprawdza aktualną subskrypcję, stanowisko, instalację, sesję, dzierżawę i limit. Wygaśnięcie nie może przekroczyć opłaconego terminu.
- Podpisane pozwolenie wiąże `accountId`, `installationId`, audience `curioflow`, capability, `queueId`, hash znormalizowanej kolejki, `sceneId`, `attemptId`, nonce, czas wydania i wygaśnięcia. Hash nie wymaga wysyłania promptów, ścieżek ani mediów. Osobny schemat i audience zapobiegają użyciu desktopowego uprawnienia jako pozwolenia wtyczki.
- Serwer zapisuje nonce i idempotency key oraz atomowo rejestruje rezerwację próby; identyczne ponowienie żądania nie tworzy drugiej próby. Wtyczka trwale oznacza próbę przed wysłaniem do Flow. Niejednoznaczna odpowiedź lub restart worker-a oznacza uzgodnienie stanu / `needs_review`, nigdy automatyczną regenerację.
- Dzierżawa odnawiana przy aktywności i alarmach, ze zwolnieniem przy Stop i ograniczonym TTL na awarię. Restart MV3 nie może gubić zabezpieczenia ani blokować konta bez końca. Nie opierać logiki wyłącznie na `setInterval` w pamięci worker-a.
- 401 wymaga odświeżenia/logowania; 403 lub odebrane uprawnienie blokuje pracę. Awaria sieci/5xx przed nową próbą pauzuje kolejkę. Przywrócenie serwera nie powinno bez wiedzy użytkownika uruchamiać kosztownej generacji.
- Już wysłana generacja może się zakończyć; pozwalamy odebrać i pobrać wynik. Stop, podgląd, zapis kolejki i odzyskanie istniejących rezultatów pozostają dostępne po wygaśnięciu. Nie wysyłać następnej sceny z callbacku ukończenia bez nowej autoryzacji.
- Desktopowy siedmiodniowy okres pracy awaryjnej nie uprawnia do nowych generacji w CurioFlow. Flow wymaga internetu, więc uzasadniona jest kontrola online przed każdą próbą.

Nie istnieje atomowa transakcja między naszym API a kliknięciem Google Flow. Cofnięcie dostępu zatrzymuje następne autoryzacje, lecz pozwolenie wydane chwilę wcześniej może być użyte do wygaśnięcia, a już wysłanej generacji nie cofniemy. Celem jest ograniczone, mierzalne okno dostępu, nie obietnica natychmiastowego przerwania wszystkiego.

## Granice bezpieczeństwa i zgodność z Chrome

Tokenów nie umieszczać w DOM, promptach, adresach URL, raportach błędów ani `storage.sync`. Krótkie access tokeny trzymać w `storage.session`; odwoływalny, rotowany refresh token w magazynie ograniczonym do zaufanych kontekstów rozszerzenia. `chrome.storage.local` nie jest sejfem systemowym. Minimalizować scope i czas życia oraz wykrywać ponowne użycie refresh tokena. Zaufane konteksty nadal nie chronią przed właścicielem zmodyfikowanej wtyczki.

W rozszerzeniu tylko publiczny klucz weryfikacyjny; podpisywanie na serwerze. Weryfikacja ścisłego algorytmu, audience, czasu, identyfikatorów i wersji schematu. Sprawdzić obsługę wybranej kryptografii na minimalnym Chrome 114 albo podnieść minimum / dołączyć zweryfikowaną bibliotekę. Zawęzić host_permissions do API i faktycznych witryn Flow. Wiadomości runtime walidują nadawcę, kontekst i payload; tylko worker wykonuje operacje sesji. Audyt istniejących uprawnień debugger i loopback jest częścią przygotowania wydania.

Wszystka logika automatyzacji DOM pozostaje w paczce podlegającej przeglądowi. Serwer dostarcza uprawnienia i zwykłe dane; nie wysyła JavaScript ani języka poleceń interpretowanego jako kod. Ochronę wartości serwerowej budować przez rzeczywiste funkcje serwera, np. planowanie i aktualizowane zasoby, a nie przez zdalne sterowanie ukrytą logiką rozszerzenia. [Wymagania Manifest V3](https://developer.chrome.com/docs/webstore/program-policies/mv3-requirements).

Osoba modyfikująca lokalne JS może usunąć sprawdzanie licencji i używać skopiowanego automatu DOM na własnym koncie Google. Podpisane pozwolenia chronią nasze API i oficjalny klient przed prostym podrabianiem uprawnień, ale Google Flow nie weryfikuje naszych pozwoleń. Nie da się zagwarantować wyłączności działania skopiowanego kodu. Starsze niechronione paczki też nie przestaną działać od wdrożenia nowego backendu. Dystrybucja przez sklep, aktualizacje, wygodne konto i usługi wymagające serwera tworzą praktyczną ochronę komercyjną.

## Kolejność wdrożenia i kryteria odbioru

1. **Baza wydania i kontrakt:** wskazać właściwą kopię CurioFlow, zachować potrzebne MCM/desktop ścieżki, ustalić capability, limity i statusy. Oddzielne identyfikatory testowej i produkcyjnej wtyczki.
2. **Wspólny backend:** konta, billing webhooki, stanowiska, instalacje, sesje, pozwolenia i audyt. Testy sandbox operatora; brak praw na podstawie klientowego `isPaid`.
3. **Logowanie i panel:** połączenie konta, status subskrypcji, zarządzanie instalacjami, wylogowanie i odnośnik do płatności. Rotacja sesji bez cyklicznych pytań do klienta.
4. **QueueRunner:** wspólny gate przed każdą nową próbą, dzierżawa oraz prawidłowa obsługa wznowień, callbacków i MV3. UI pokazuje zrozumiały powód pauzy.
5. **Testy:** płacący/niepłacący, koniec okresu, anulowanie, opóźnione/powtórzone webhooki, skradziony/cofnięty refresh token, zmieniony podpis/hash/audience, replay próby, jednoczesny Start na dwóch instalacjach, restart worker-a, awaria API w trakcie kolejki, ukończenie istniejącego wyniku, brak ponownego submit po niejednoznacznej odpowiedzi. Osobno test MCM i start spoza panelu.
6. **Beta i wydanie:** Private beta, konto testowe/instrukcja dla recenzenta sklepu, opis wymaganej subskrypcji, polityka prywatności i uzasadnienie uprawnień, następnie Unlisted dla klientów. Stare buildy pozostają problemem migracji, bez zapewnień o ich zdalnym wyłączeniu. Wycofanie wadliwego wydania nie może przywracać niechronionego builda jako oficjalnej wersji.

Gotowe do wydania: żadna wspierana ścieżka nowej generacji nie pomija gate; wygasła subskrypcja nie otrzymuje nowych pozwoleń; użytkownik odzyskuje już wygenerowane wyniki; restart nie duplikuje generacji; panel pozwala samodzielnie usunąć starą instalację. Testy live Flow wykonywać dopiero w implementacji z ustalonym limitem generacji.

Dodatkowe źródła: [Chrome identity](https://developer.chrome.com/docs/extensions/reference/api/identity), [Chrome storage](https://developer.chrome.com/docs/extensions/reference/api/storage). Dokumentacja sprawdzona 22.09.2026; konkretne TTL i limity powyżej są rekomendacją, nie istniejącą konfiguracją.
