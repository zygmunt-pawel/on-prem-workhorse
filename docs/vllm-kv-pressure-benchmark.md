# vLLM 0.25 vs 0.29 przy nasyceniu KV cache

Pomiar na produkcyjnym RTX 5090, 15 września 2026. Oba obrazy, model i ustawienia
opisuje [raport aktualizacji](vllm-029-benchmark.md). Test porównuje 0.25/MRV1
z 0.29/MRV2, z Triton attention, FlashInfer CUTLASS MoE, FP8 KV, MTP4,
`gpu_memory_utilization=0.92`, batch 8192, max sequences 80, max context 32768
i limitem 450 W. Obie wersje korzystały z zapisanej kompilacji i logowania DEBUG.
Logi potwierdziły 9,41 GiB KV na 0.25 i 8,86 GiB na 0.29.

## Wniosek

**Przewaga zależy od obciążenia.** Przy paczkach ze wspólnym prefiksem i długim
wyjściem 0.29 kończyła całą pracę około 9% szybciej i uniknęła preempcji, które
wystąpiły na 0.25. Przy krótszym wyjściu wspólny prefiks dał praktycznie remis;
bez współdzielenia prefiksu 0.29 była około 2,6% szybsza.

Mniejsza fizyczna pula KV nie oznacza więc automatycznie gorszej przepustowości
przy presji pamięci. W długim scenariuszu 0.29 dopuszczała mniej aktywnych
zapytań naraz, ale kończyła paczkę szybciej. Test nie izoluje wpływu runnera od
pozostałych zmian wersji. To wyniki dwóch powtórzeń na jednym hoście, nie
gwarancja przewagi dla wszystkich długości, schematów JSON lub charakterystyk
ruchu. Po tych testach użytkownik zatwierdził i zlecił migrację na 0.29;
[aktualny stan produkcji](../deploy/server/VERIFIED_STATE.md) zawiera walidację wdrożenia.

## Metoda

- Wszystkie zapytania miały dokładnie **12288 tokenów wejścia**. Wysyłano token
  IDs do `/v1/completions`; SHA-256 całych paczek potwierdziły identyczne wejścia
  na obu wersjach.
- `shared`: 9224 wspólne tokeny na początku (około 75%). Przed każdą mierzoną
  paczką osobne zapytanie rozgrzewało wspólny prefiks; jego czas nie jest w wyniku.
- `independent`: identyfikatory umieszczone na początku ograniczały wspólny
  prefiks do 11 tokenów. Counter prefix hit wyniósł 0%. Tekst jest syntetyczny;
  niezależność oznacza brak możliwości współdzielenia bloków prefix cache.
- W pierwszej serii wysyłano jednocześnie 32 lub 96 zapytań z wyjściem dokładnie
  512 tokenów. Dwa powtórzenia, odwrócona kolejność scenariuszy w drugim.
- W drugiej serii: 96 zapytań ze wspólnym prefiksem, dokładnie 2048 tokenów
  wyjścia, dwa powtórzenia. Odwrócono kolejność wersji: najpierw 0.29, potem 0.25.
- Stałą długość wymuszano przez `min_tokens=max_tokens`, `ignore_eos=true`.
  **To syntetyczny test zasobów, nie test jakości treści lub poprawności JSON.**
  Oddzielny smoke test JSON i autoryzacji wykonywał kontroler każdego startu.
- Strumieniowanie pozwalało zmierzyć klientowi czas do pierwszego tokenu (TTFT)
  i zakończenia odpowiedzi. Metryki `/metrics` próbkowano co około 250 ms.
  Raport zawiera także średni czas w kolejce z histogramu serwera, preempcje,
  maksimum zajęcia KV oraz czas z zajęciem KV co najmniej 95%.
- Każda wersja wykonała **704 mierzone zapytania** (512 + 192), generując
  **655360 tokenów wyjścia**, bez błędów zapytań, długości tokenów ani metryk.
  Nie wlicza to krótkich zapytań rozgrzewających i testów gotowości.
- To skończone paczki, a nie wielogodzinny test ciągłego ruchu. Cache dochodził
  do granicy w części przebiegu; nie był stale zapełniony przez cały test.

## Główne wyniki: 96 zapytań naraz

Czasy to średnie z dwóch kompletnych przebiegów. Procent oznacza zmianę czasu
całej paczki, nie średniego czasu pojedynczego tokenu.

| Scenariusz | Wyjście / zapytanie | 0.25 | 0.29 | Zmiana czasu 0.29 |
|---|---:|---:|---:|---:|
| Wspólny prefiks | 512 | 27,04 s | 27,21 s | +0,6% — praktycznie remis |
| Brak wspólnego prefiksu | 512 | 61,58 s | 59,99 s | −2,6% |
| Wspólny prefiks | 2048 | 55,49 s | 50,60 s | **−8,8%** |

Surowe czasy powtórzeń:

| Scenariusz | 0.25: próba 1 / 2 | 0.29: próba 1 / 2 |
|---|---:|---:|
| Wspólny, 512 | 26,71 / 27,37 s | 26,78 / 27,63 s |
| Niezależny, 512 | 61,42 / 61,74 s | 59,50 / 60,48 s |
| Wspólny, 2048 | 52,46 / 58,52 s | 50,16 / 51,04 s |

## Czy rzeczywiście zapełniliśmy cache?

| Scenariusz | 0.25: szczyt KV | 0.29: szczyt KV | 0.25: czas ≥95%, próba 1 / 2 | 0.29: czas ≥95%, próba 1 / 2 |
|---|---:|---:|---:|---:|
| Wspólny, 512 | 99,6–99,7% | 98,4–98,7% | 9,2 / 8,9 s | 1,9 / 1,4 s |
| Niezależny, 512 | 98,2–98,3% | 99,6–99,7% | 6,7 / 10,8 s | 2,7 / 2,7 s |
| Wspólny, 2048 | 99,85–99,97% | 98,4–98,7% | 25,4 / 24,9 s | 4,9 / 5,7 s |

W każdym scenariuszu występowała kolejka. Pierwsza próba shared/512 na 0.29
nie spełniła z góry przyjętego warunku co najmniej 2 sekund przy KV ≥95%;
dlatego dodano shared/2048, który spełnił go na obu wersjach. Nie zmieniano
progu po obejrzeniu wyników. Różnica czasu blisko pełnego cache wynika także
z innego przebiegu dopuszczania zapytań; nie oznacza identycznego harmonogramu.

## Kolejka, opóźnienia i preempcje

P95 oznacza czas, do którego zakończyło się 95% zapytań lub pojawił się pierwszy
token w 95% zapytań. Poniżej średnia z P95 dwóch powtórzeń.

| Scenariusz | Średnia kolejka 0.25 / 0.29 | P95 do pierwszego tokenu 0.25 / 0.29 | P95 całej odpowiedzi 0.25 / 0.29 |
|---|---:|---:|---:|
| Wspólny, 512 | 8,54 / 9,20 s | 21,57 / 21,17 s | 26,77 / 26,95 s |
| Niezależny, 512 | 26,92 / 26,35 s | 55,25 / 53,29 s | 61,27 / 59,64 s |
| Wspólny, 2048 | 13,23 / 14,26 s | 37,61 / 33,96 s | 52,18 / 49,59 s |

Przy wyjściu 512 nie było preempcji na żadnej wersji. Przy 2048:

- **0.25: 6 zdarzeń preempcji w każdym powtórzeniu, 12 łącznie**;
- **0.29: 0**;
- maksimum jednocześnie aktywnych zapytań: 69 na 0.25, 57 na 0.29.

Zdarzenia preempcji nie muszą oznaczać tylu różnych zapytań. Wymagają zwolnienia
cache i późniejszych ponownych obliczeń, ale wszystkie zapytania ostatecznie
się powiodły. W 0.29 średnia kolejka była nieco dłuższa w scenariuszu shared,
więc nie wszystkie miary opóźnienia poprawiły się mimo szybszego ukończenia
długiej paczki.

## Kontrola z 32 zapytaniami

Wariant niezależny: 0.25 średnio 21,15 s i szczyt KV około 81%; 0.29 20,43 s
i około 91%. Wspólny prefiks zajmował około 51% KV na 0.25 i 60% na 0.29.
Jego czasy na 0.25 wyniosły 17,43 i 9,76 s, na 0.29 9,72 i 9,82 s.
Ze względu na duży rozrzut pierwszej pary nie wyciągamy z niej wniosku
o procentowej przewadze wersji. Przyczyny pierwszego wolniejszego przebiegu
nie wyizolowano. Główne wnioski opierają się na paczkach 96 zapytań.

## Artefakty i uruchomienie

Wyniki lokalnie i na serwerze, pod `benchmark-results/vllm-upgrade-20260915/`:

- `cache-pressure/`: 512 tokenów wyjścia, oba scenariusze i obie wielkości paczek;
- `cache-pressure-long/`: shared/96, 2048 tokenów wyjścia;
- `result.json`: każda odpowiedź, hash wejść/wyjść, metryki i przebieg zajęcia KV;
- `runtime.log`, `status.json`, `comparison.json`, `restored-smoke.json`.

Kontroler `benchmarks/reddit-matching/compare-versions.py` zatrzymuje oryginalną
produkcję i uruchamia kontener testowy na lokalnym porcie 8091. W `finally`
przywraca ten sam kontener produkcyjny i sprawdza health, autoryzację oraz JSON.
Podczas opisanych testów był to 0.25; po migracji jest to 0.29.

Przykład na serwerze, w tmux, po przygotowaniu katalogów zapisanej kompilacji:

```bash
python3 benchmarks/reddit-matching/compare-versions.py \
  --variants v025 v029 --debug-profiling --workload cache-pressure \
  --repetitions 2 --output benchmark-results/pressure-new-run

python3 benchmarks/reddit-matching/compare-versions.py \
  --variants v029 v025 --debug-profiling --workload cache-pressure \
  --pressure-output-tokens 2048 --pressure-levels 96 --pressure-modes shared \
  --repetitions 2 --output benchmark-results/pressure-long-new-run
```

Każda seria wymaga nowego katalogu wyników. Przed startem podłącz właściwe
`cache-v025` i `cache-v029` (historycznie pierwszy nazywał się `cache-baseline`); w logach sprawdź faktyczne użycie zapisanej
kompilacji i rozmiar KV. `baseline` oznacza obraz aktualnego kontenera produkcji,
więc po wdrożeniu 0.29 nie oznacza już 0.25. Wariant `v025` wskazuje jawnie
zachowany lokalnie obraz poprzedniej wersji.

## Potwierdzenie wdrożenia

Pierwsza próba po migracji zanotowała jedno rozłączenie klienta w 192 zapytaniach,
bez restartu silnika, błędów CUDA i preempcji. Zachowano ją w
`migration/pressure-first-attempt/`. Klient benchmarku używa teraz osobnej
puli HTTP na każdą paczkę; hipotezy o nieaktywnym połączeniu nie potwierdzono
bezpośrednio. Nie dodano automatycznych ponowień ani nie usuwano błędnego wyniku.

Następnie na finalnym kontenerze produkcyjnym powtórzono dwie paczki
shared/96/2048: **192/192 poprawnych zapytań**, średnio **52.194 s**,
**0.0 preempcji**, KV w szczycie **98.48% /
99.70%**. Logowanie INFO, KV 8,86 GiB po ciepłym
restarcie. To walidacja wdrożenia; tabel porównania wersji powyżej nie zmieniano.
Szczegóły w [inwentarzu](../deploy/server/VERIFIED_STATE.md).
