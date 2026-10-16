# Vidmyo — gotowość istniejących VPS do pilota

Stan na 22 września 2026. Serwer ma obsługiwać konta, płatności i uprawnienia. Renderowanie filmów, obrazów i głosu pozostaje na komputerach klientów.

## Zmierzony stan

| Serwer | Zasoby i bieżące zużycie | Istniejące usługi | Rola w pilocie |
|---|---|---|---|
| Hostinger KVM 2 | 2 vCPU, 7940 MiB RAM, 6584 MiB dostępne; 6,7 GiB zajęte z 96 GiB dysku | Docker: n8n i Traefik; PostgreSQL działa na hoście | Główny kandydat na lekkie API Vidmyo |
| OVH | 1 vCPU, 1919 MiB RAM, 1105 MiB dostępne; 13 GiB wolnego dysku | Apache, MariaDB, PHP-FPM, poczta, Webmin | Zapasowy cel kopii lub awaryjne API po osobnym przygotowaniu |

Hostinger: panel z ostatniego dostępnego okresu (od 19 września) pokazywał CPU około 1,5–2% i RAM około 1,3 GB. Pomiar `free -m` na żywo dał 6584 MiB dostępnej pamięci, a `df -h /` — 90 GiB wolnego miejsca. System działa 136 dni, bez swapu. Ma 67 oczekujących aktualizacji i wymaga restartu; termin aktualizacji trzeba uzgodnić z właścicielem działających usług. Panel ma cotygodniowe automatyczne kopie przechowywane osobno od VPS; widoczne były kopie z 12 i 19 września. Nie sprawdzono jeszcze odtworzenia.

OVH: przejrzano 1122 dziesięciominutowych próbek z ośmiu dni. Minimalna dostępna pamięć wynosiła 982,6 MiB, a maksymalne średnie zajęcie CPU 16,6%. Swap jest wyłączony. Próbki nie obejmują krótkich skoków między pomiarami.

## Decyzja o architekturze pilota

1. **Hostinger jako główny serwer lekkiego API.** Uruchomić Vidmyo w osobnym kontenerze/procesie z limitem pamięci, własnymi sekretami i bazą/rolą PostgreSQL z minimalnymi uprawnieniami. Traefik może kierować ruch z osobnej subdomeny HTTPS. Nie łączyć cyklu życia API Vidmyo z n8n.
2. **OVH jako zasób pomocniczy.** Nadaje się do szyfrowanej kopii poza Hostingerem lub przygotowanego awaryjnego API. Nie zakładać automatycznego przełączenia bez osobnych testów i synchronizacji danych. Nie uruchamiać na nim renderowania lub modeli AI.
3. **Lokalny rendering u klientów.** VPS nie przetwarza filmów ani głosu. Dostęp do chronionych operacji wynika z podpisanych uprawnień, odświeżanych automatycznie. Użytkownik nie ma klikać potwierdzenia co siedem dni.
4. **Kopie i monitoring.** Cotygodniowy snapshot Hostinger jest punktem wyjścia, ale baza licencji potrzebuje częstszych szyfrowanych kopii poza głównym VPS i próby odtworzenia. Monitorować pamięć, dysk, HTTP 5xx, opóźnienia, stan PostgreSQL i wiek kopii.

Oba serwery już istnieją, więc pilot nie wymaga teraz trzeciego VPS ani dodatkowej opłaty za moc obliczeniową. Mogą dojść koszty kopii, domeny i operatora płatności. Obecne pomiary nie określają bezpiecznej liczby klientów; trzeba ją ustalić testem obciążeniowym gotowego backendu.

## Warunki przed uruchomieniem

1. Dokończyć serwer kont i licencji. Aplikacja desktopowa ma klienta podpisanych uprawnień, lecz nie ma jeszcze działającego backendu aktywacji, logowania i rozliczeń. Potrzebne są `POST /v1/desktop/entitlements/refresh`, `POST /v1/team/claims/acquire` i `/renew`, z autoryzacją i atomową kontrolą miejsc zespołu.
2. Podłączyć operatora płatności w trybie testowym. Serwer musi sprawdzać podpis webhooka, deduplikować zdarzenia i nadawać dostęp wyłącznie według potwierdzonego stanu subskrypcji.
3. Oddzielić Vidmyo od istniejących usług: osobny użytkownik/rola DB, sekret, subdomena, limity CPU/RAM, certyfikat TLS, zamknięte porty bazy. Klucz prywatny Ed25519 pozostaje tylko na serwerze, publiczny trafia do instalatora. Wydanie wymaga też rzeczywistego klienta Google Desktop OAuth.
4. Zweryfikować reguły sieciowe przed wdrożeniem. PostgreSQL nasłuchuje również na adresie IPv6 `::` i interfejsie Dockera; UFW jest nieaktywny, reguła INPUT iptables ma ACCEPT, a panel Hostinger nie pokazuje skonfigurowanej zapory. Próba TCP na port 5432 z komputera lokalnego zakończyła się timeoutem, więc dostęp z Internetu nie został potwierdzony. Nie zmieniać reguł bez sprawdzenia połączeń, z których korzystają obecne aplikacje.
5. Zaplanować aktualizacje Hostinger i restart w oknie serwisowym, po sprawdzeniu kopii i działania n8n. Następnie przejść test zakup → automatyczna aktywacja → odświeżenie → siedmiodniowa tolerancja awarii sieci → odwołanie dostępu oraz test odtworzenia bazy.

To jest ocena gotowości infrastruktury, nie uruchomienie produkcyjne Vidmyo. Żadna usługa VPS nie została zmieniona w trakcie audytu.
