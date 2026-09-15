# vLLM 0.25.0 → 0.29.0 na RTX 5090 — 15 września 2026

Dodatkowo wykonano [test nasycenia KV cache](vllm-kv-pressure-benchmark.md):
przy 96 zapytaniach krótki output ze wspólnym prefiksem dał remis, niezależne
prompty około 2,6% krótszy czas na 0.29, a długi output ze wspólnym prefiksem
około 8,8% krótszy czas i zero preempcji wobec 12 zdarzeń na 0.25.

**Decyzja wdrożeniowa:** po porównaniach i zgodzie użytkownika wdrożono
0.29 / MRV2 / Triton / CUTLASS. [Inwentarz](../deploy/server/VERIFIED_STATE.md)
zawiera osobną walidację docelowego kontenera. Wszystkie poniższe porównania
zachowują oryginalne wersje, ustawienia i wyniki.

## Zakres

Porównanie wykonano na rzeczywistym serwerze `server`, na jednej karcie RTX 5090,
z tymi samymi lokalnymi snapshotami Gemma 4 26B-A4B NVFP4 i oficjalnego asystenta
MTP. Ustawienia: MTP ×4, FP8 KV, `gpu_memory_utilization=0.92`,
`max_num_batched_tokens=8192`, `max_num_seqs=80`, kontekst 32768, limit 450 W,
prefix caching, chunked prefill, async scheduling i xgrammar.

Kontenery testowe korzystały z portu dostępnego wyłącznie na serwerze
(`127.0.0.1:8091`), modeli zamontowanych tylko do odczytu i osobnych katalogów
cache. Kontener produkcyjny był na czas testów zatrzymany. Jego obraz, konfiguracja,
sekrety i modele nie były zmieniane.

## Metoda

- Ten sam syntetyczny fixture co w `benchmarks/reddit-matching/benchmark.py`:
  prefilter, szczegółowe odpowiedzi JSON i mieszana paczka, do 64 sekwencji.
- Trzy powtórzenia każdej fazy po identycznej rozgrzewce. Czasy ładowania,
  kompilacji i rozgrzewki nie wchodzą do wyników generowania.
- Temperatura 0 i identyczne prompty. Odpowiedzi mogą różnić się między wersjami
  i powtórzeniami; zapisano także liczbę tokenów i przepustowość.
- Dodatkowa walidacja całego JSON Schema (`jsonschema.Draft202012Validator`),
  obejmująca typy, wymagane pola, ograniczenia długości i dodatkowe pola.
- Każdy udany wariant obsłużył 576 sekwencji pomiarowych oraz 4 rozgrzewkowe;
  290 odpowiedzi JSON poddano pełnej walidacji schematu.
- Osobny smoke test: brak klucza zwraca 401, a autoryzowane
  `/chat/completions` generuje poprawny prosty JSON.
- Pierwszy pomiar 0.25.0 odbywał się podczas pobierania nowego obrazu i miał
  większy rozrzut. Zachowano go osobno (`baseline-run`); poniższa tabela używa
  późniejszej kontroli, wykonanej bez pobierania i budowania obrazów w tle.

To test wydajności i poprawności protokołu/schematu na danych syntetycznych.
Nie mierzy trafności klasyfikacji ani równoważności jakości odpowiedzi modeli.

## Główne porównanie

Obie wersje używały backendu MoE `flashinfer_cutlass`. 0.29.0 korzystała z
domyślnego Model Runner V2; 0.25.0 z poprzedniego runnera i istniejącego patcha
zgodności asystenta Gemmy. 0.29.0 wystartowała bez tego lokalnego patcha.

| Faza | 0.25.0: mediana czasu | 0.29.0: mediana czasu | 0.25.0: output tok/s | 0.29.0: output tok/s |
|---|---:|---:|---:|---:|
| Prefilter | 4,7819 s | 4,4777 s | 3861,15 | 3977,76 |
| Szczegółowy JSON | 71,1760 s | 68,8757 s | 800,27 | 827,19 |
| Mieszana paczka | 38,7420 s | 36,9894 s | 970,29 | 1008,10 |
| Suma median czasów | **114,6999 s** | **110,3428 s** | — | — |

Suma median spadła o **3,8%**. Przepustowość wyjściowa wzrosła o około 3–4%,
zależnie od fazy. W obu wariantach: zero błędów zapytań, walidacji schematu,
odczytu metryk i preempcji. Trzy powtórzenia jednego fixture nie dowodzą takiego
samego zysku przy każdym obciążeniu.

## Pamięć

| Odczyt przy starcie | 0.25.0 | 0.29.0 / CUTLASS |
|---|---:|---:|
| Załadowany model i MTP | 17,64 GiB | 17,64 GiB |
| Dostępna pamięć KV cache | 9,41 GiB | 8,29 GiB |
| Raportowana pojemność KV | 258 472 tokeny | 137 596 tokenów |

Nowa wersja raportuje **46,8% mniej tokenów KV**, ale fizyczna pula KV jest
mniejsza o około **11,9%**. Analiza kodu z obu faktycznie użytych obrazów po
benchmarku wyjaśniła tę rozbieżność: kalkulacja dla sliding-window attention
w 0.25 uwzględnia jedną paczkę `max_num_batched_tokens=8192`, a w 0.29
`max_in_flight_tokens`. Przy async scheduling i jednej karcie to **2 × 8192**.
Nowa kalkulacja uwzględnia bloki utrzymywane przez dwie nakładające się paczki,
zanim można zwolnić dane wychodzące poza okno uwagi.

Liczba „GPU KV cache size” jest tu szacunkiem pojemności dla maksymalnej długości
zapytania, wyprowadzonym z liczby bloków wymaganych przez wszystkie grupy warstw.
Nie jest bezpośrednim odczytem liczby fizycznych miejsc na tokeny. Ta sama reguła
sliding-window służy także limitom przyjmowania zapytań; nie należy jednak
utożsamiać spadku tego szacunku z dwukrotnym spadkiem rzeczywistej pojemności.

Rekonstrukcja dla Gemmy: pięć grup sliding-window (bloki po 16 tokenów, okno
1024) i jedna full-attention (bloki po 32 tokeny), po pięć warstw w grupie.
Zapotrzebowanie na zapytanie długości 32768 wynosi:

- 0.25: `5 × 577 + 1024 = 3909` bloków;
- 0.29: `5 × 1089 + 1024 = 6469` bloków.

Pule 30834 i 27164 bloków odtwarzają dokładnie raportowane **258472** i
**137596** tokenów, a ich rozmiary to odpowiednio 9,40979 i 8,28979 GiB.
Liczby bloków puli odtworzono z logów i wzorów, bez odczytu obiektu cache
działającego silnika. Funkcje zainstalowanych wersji sprawdzono osobno na CPU,
bez ładowania modeli i zatrzymywania produkcji. Gdy w kalkulacji 0.29 podstawić
starą regułę jednej paczki, otrzymujemy **227707 tokenów** — około 12% mniej
niż w 0.25, zgodnie ze zmianą fizycznej pamięci. To porównanie matematyczne,
a nie pomiar serwera z wyłączonym async scheduling.

Źródła: `SlidingWindowSpec.max_memory_usage_bytes` w
[0.25](https://github.com/vllm-project/vllm/blob/v0.25.0/vllm/v1/kv_cache_interface.py)
i [0.29](https://github.com/vllm-project/vllm/blob/v0.29.0/vllm/v1/kv_cache_interface.py),
oraz [max_in_flight_tokens / max_concurrent_batches](https://github.com/vllm-project/vllm/blob/v0.29.0/vllm/config/vllm.py).
Kod z obrazów i skrypt rekonstrukcji zapisano w `cache-investigation/` obok
surowych wyników benchmarku.

Osobną kwestią pozostaje przyczyna mniejszej fizycznej puli o około 1,12 GiB:
wersje używają innych runnerów i mają inne koszty profilowania pamięci.
Nie wyizolowano pełnego podziału tej różnicy. Fixture korzysta ze wspólnych
prefiksów i zmieścił się bez preempcji. Nie sprawdzono granicy pojemności na
wielu długich, niezależnych kontekstach.

### Zgłoszenia upstream sprawdzone 15 września 2026

- [PR #53306](https://github.com/vllm-project/vllm/pull/53306), scalony
  24 sierpnia, dodaje rezerwowanie pamięci CUDA graphs w MRV2 przed wyznaczeniem
  puli KV. Nasz obraz 0.29 zawiera tę implementację. Poprzedni runner w naszym
  0.25 także rezerwował pamięć grafów, więc sama obecność tej funkcji nie
  wyjaśnia całego spadku między naszymi pomiarami.
- [Issue #50780](https://github.com/vllm-project/vllm/issues/50780) opisuje
  spadek KV o 18–24% od 0.26 przy niezmienionej konfiguracji modelu Qwen3.5
  z GDN: tymczasowe alokacje podczas profilowania zaliczano do pamięci grafów.
  [Proponowana poprawka #50848](https://github.com/vllm-project/vllm/pull/50848)
  pozostawała otwarta i niescalona. To inna architektura niż nasza Gemma;
  podobieństwo objawu nie potwierdza tej samej przyczyny.
- [Issue #50159](https://github.com/vllm-project/vllm/issues/50159) dotyczy
  Gemmy 4 31B w 0.26 i różnic profilowania między MRV1 a MRV2. Tam MRV2
  przyznawał około 0,9 GiB **więcej** KV i wariant int8 kończył się OOM pod
  obciążeniem. To dowód problemów zgłaszanych w tym obszarze, nie potwierdzenie
  regresji naszego modelu NVFP4 na jednej RTX 5090.

Nasze logi dają bardziej bezpośredni trop:

| Pamięć CUDA graphs | 0.25 | 0.29 |
|---|---:|---:|
| Szacunek odjęty przed alokacją KV | 0,44 GiB | 0,76 GiB |
| Późniejszy pomiar opisany jako actual | 0,49 GiB | 0,43 GiB |

Różnica odjętych szacunków wynosi około 0,32 GiB z całego spadku 1,12 GiB.
Pozostałe około 0,80 GiB wymaga porównania pozostałych składników profilu
pamięci. Różnica estimate/actual nie oznacza automatycznie bezpiecznej pamięci
do oddania KV; fazy startu mają inne alokacje, a szczyt podczas obciążenia też
wymaga miejsca. Nie znaleziono zgłoszenia wyjaśniającego dokładnie naszą
konfigurację 0.29 + Gemma 26B-A4B NVFP4 + MTP4 + RTX 5090.

Powyższe zgłoszenia były podstawą poniższego testu obu runnerów. Nie stosowano
proponowanych patchy upstream ani nie zwiększano utilization.

## Dodatkowy test runnerów i wpływu kompilacji

Na prośbę użytkownika przetestowano 0.29 z `VLLM_USE_V2_MODEL_RUNNER=0`,
a następnie powtórzono pełny benchmark domyślnego MRV2. Obie serie miały
`VLLM_LOGGING_LEVEL=DEBUG`, trzy powtórzenia, ten sam fixture i ustawienia.
Każda zaliczyła 580 odpowiedzi, w tym 290 pełnych walidacji JSON Schema,
bez błędów zapytań, schematu, metryk i bez preempcji.

| Faza, mediana | 0.25 / MRV1, wcześniejsza kontrola | 0.29 / MRV1 | 0.29 / MRV2, powtórzenie |
|---|---:|---:|---:|
| Prefilter | 4,7819 s | 4,5520 s | 4,3619 s |
| JSON | 71,1760 s | 71,9376 s | 66,5096 s |
| Mieszana paczka | 38,7420 s | 39,6863 s | 35,7149 s |
| Suma median | 114,6999 s | 116,1759 s | 106,5864 s |

MRV2 osiągnął około 8,3% krótszy czas niż MRV1 w tej samej wersji 0.29 oraz
około 7,1% krótszy niż wcześniejsza kontrola 0.25 (ta ostatnia miała logowanie
INFO). To pomiary jednego fixture, bez oceny istotności statystycznej ani
granicy przepustowości dla niezależnych długich kontekstów.

Ponowny start MRV2 z zapisaną kompilacją dał **8,86 GiB KV**, zamiast 8,29 GiB
podczas pierwszego startu. Dlatego wykonano dodatkowe testy samego startu,
autoryzacji i JSON-a dla 0.25 oraz MRV1 w 0.29:

| Wariant | Start wymagający pełnej kompilacji | Start z wykorzystaniem zapisanej kompilacji |
|---|---:|---:|
| 0.25 / MRV1 | 8,87 GiB | 9,41 GiB |
| 0.29 / MRV1 | 8,48 GiB | 9,06 GiB |
| 0.29 / MRV2 | 8,29 GiB | 8,86 GiB |

Kontrola 0.25 w katalogu `warm-start-control` mimo istniejącego katalogu cache
wykonała ponowną kompilację (logi: 71,65 s i 11,19 s), więc jej 8,87 GiB należy
do kolumny startu z kompilacją. Wartość 9,41 GiB potwierdzają wcześniejszy
benchmark oraz ponowne starty oryginalnej produkcji. MRV1 w 0.29 przy drugim
starcie załadował skompilowane grafy (1,80 s i 0,24 s).

**Początkowe 12% różnicy nie było porównaniem równych warunków startu.**
Po wykorzystaniu zapisanej kompilacji różnica 0.25 → 0.29/MRV2 wynosi około
0,55 GiB, czyli **5,8%**, a dla MRV1 około 0,35 GiB, czyli **3,7%**.
Nie chodzi o cache promptów: KV jest pusty po restarcie. Szczyt zużycia
pamięci podczas kompilacji wpływa na rozmiar puli ustalany przy starcie.

W logach 0.29/MRV1 całkowity profilowany koszt poza KV zmalał z 19,75 do
19,18 GiB, a przyrost szczytu PyTorch z 1,71 do 1,14 GiB. W ponownym starcie
MRV2 koszt poza KV wyniósł 19,23 GiB, a szacunek grafów 0,76 GiB; MRV1 miał
odpowiednio 19,18 i 0,61 GiB. Różnica około 0,20 GiB między runnerami składa
się więc z około 0,05 GiB profilu poza KV i 0,15 GiB rezerwy grafów.

Kod `memory_profiling` także zmienił się między wersjami: 0.29 używa różnicy
wolnej pamięci GPU i zapasu do szczytu alokacji, podczas gdy 0.25 sumowała
wagi, przyrost szczytu PyTorch i przyrost pamięci spoza PyTorch. Nie
wyizolowano jeszcze wpływu samej zmiany wzoru od zmian bibliotek i buforów.

Artefakty: `runner-comparison/` (pełne benchmarki) i `warm-start-control/`
(dodatkowe starty). Powrót do MRV1 odzyskuje mało KV i pogarsza zmierzony
czas; MRV2 pozostaje lepszym wariantem 0.29 dla tego fixture. Nie zmieniono
konfiguracji produkcji.

## Backend b12x

Bezpośredni `--moe-backend b12x`, z pakietem `b12x==1.2.6`, zakończył start błędem:

```text
NvFp4 MoE backend 'B12X' does not support the deployment configuration
since kernel does not support MoEActivation.GELU_TANH activation.
```

To brak obsługi aktywacji Gemmy, a nie brak pamięci. Nie zmieniano funkcji
aktywacji ani wag modelu, żeby obchodzić to ograniczenie.

Osobna ścieżka `--moe-backend flashinfer_b12x`, dostępna w bazowym obrazie
0.29.0 bez doinstalowywania pakietu b12x, obsłużyła aktywację i załadowała model.
Start zakończył się jednak błędem CUDA OOM podczas przygotowania obliczeń:
próba alokacji kolejnych **132 MiB** przy około **59 MiB wolnego VRAM**.
Traceback wskazuje `_pad_intermediate_to_tile`, tworzące dodatkowe tensory wag
dopasowane do rozmiaru kafelków kernela.
Nie doszło do benchmarku zapytań. Zachowano 0.92, batch 8192, MTP×4 i 450 W;
nie zmniejszano ustawień, żeby uzyskać korzystniejszy wynik dla tego wariantu.

| Wariant | Wynik |
|---|---|
| 0.25.0 / CUTLASS | Pełny benchmark zaliczony |
| 0.29.0 / CUTLASS | Pełny benchmark zaliczony, około 3,8% krótszy czas |
| 0.29.0 / b12x 1.2.6 | Brak obsługi `GELU_TANH`, błąd startu |
| 0.29.0 / flashinfer_b12x | CUDA OOM przed gotowością serwera |

## Backend uwagi FlashInfer

Osobna próba 0.29/MRV2 zmieniła wyłącznie backend uwagi na `FLASHINFER`.
Backend MoE pozostał `flashinfer_cutlass`, z FP8 KV, MTP4, .92 i batch 8192.
Wariant korzystał z izolowanej kopii entrypointu; produkcyjny plik i obraz nie
zostały zmienione. Kod z obrazu deklaruje obsługę head size 512. Przy starcie
warstwy globalne 512 użyły standardowego FlashInfer decode, bo XQA obsługuje
mniejszy zakres wymiarów; log jawnie potwierdził ten fallback.

Wynik: **błąd startu po 352,90 s**, przed gotowością i benchmarkiem zapytań.
Załadowano 17,61 GiB, przydzielono 7,64 GiB KV (126862 raportowanych tokenów).
Szacunek pamięci grafów wyniósł 1,44 GiB, późniejszy pomiar 0,66 GiB.
Po przechwyceniu grafów, podczas `warmup_kernels` i próbnego kroku decode,
wystąpił `torch.AcceleratorError: CUDA error: an illegal memory access was
encountered`. Błąd ujawnił się w samplerze; asynchroniczne raportowanie CUDA
nie pozwala przypisać winy konkretnemu kernelowi na podstawie tego stosu.
Nie był to CUDA OOM ani przekroczenie limitu czasu startu. Nie uzyskano danych
wydajności ani walidacji JSON dla FlashInfer.

FlashAttention i FlexAttention sprawdzono w kodzie obrazu, bez benchmarków:
FlashAttention nie udostępnia tej ścieżki FP8 na SM120, a FlexAttention nie
deklaruje FP8 KV. Nie zmieniano formatu KV ani nie wyłączano grafów/MTP,
żeby wymusić ich działanie. Sprawdzonym backendem uwagi pozostaje Triton.
Artefakty: `attention-comparison/v029_flashinfer/`.

## Wniosek

Najlepszym sprawdzonym wariantem 0.29 dla tego fixture jest **MRV2 + Triton
attention + FlashInfer CUTLASS MoE**. Ostatni pomiar miał około 7,1% krótszy
czas niż wcześniejsza kontrola 0.25; pierwsza seria pokazała 3,8%. Obie serie
0.29/MRV2 przeszły bez błędów. MRV1 w 0.29 był wolniejszy przy niewielkiej
korzyści pamięciowej.

Przy porównywalnym starcie z zapisaną kompilacją fizyczna pula KV zmalała
z 9,41 do 8,86 GiB, czyli około 5,8%. Początkowe 12% obejmowało także koszt
pierwszej kompilacji w profilu pamięci. Dodatkowy duży spadek raportowanej
liczby tokenów wynika ze zmienionej kalkulacji dla async scheduling.

Pierwotny test potwierdza korzyść dla paczek ze wspólnymi prefiksami,
mieszczących się w cache. Późniejszy [test presji pamięci](vllm-kv-pressure-benchmark.md)
sprawdził też nasycenie cache i wykazał przewagę zależną od obciążenia:
od remisu do około 9% krótszego czasu na 0.29. Nie można wprost zbilansować
procentowego zysku szybkości z procentową stratą pojemności.
FlashInfer attention i obie ścieżki b12x nie
przeszły startu przy badanych ustawieniach. Po zakończeniu testów użytkownik
autoryzował migrację: produkcja została przełączona na 0.29 / MRV2 / Triton /
CUTLASS. Stan wdrożenia i walidacja są zapisane w
[aktualnym inwentarzu](../deploy/server/VERIFIED_STATE.md).

W opisanych historycznych seriach procedura przywracała kontener 0.25.0 i sprawdzała
health, autoryzację oraz odpowiedź JSON. Faktyczny wynik przywrócenia zapisują
`comparison.json` i `restored-smoke.json` w katalogu każdej serii.

## Artefakty i odtworzenie

[Zestawienie wyników JSON](data/vllm-upgrade-20260915.json) jest wersjonowane
w Git: statusy wszystkich wariantów, identyfikatory obrazów, statystyki i SHA-256
surowych raportów. Nie zawiera promptów, odpowiedzi ani sekretów.


Surowe wyniki znajdują się w ignorowanym katalogu
`benchmark-results/vllm-upgrade-20260915/`, lokalnie oraz na serwerze:

- `comparison/baseline/`: końcowa kontrola 0.25.0;
- `comparison/v029/`: 0.29.0 / CUTLASS;
- `comparison/b12x/`: nieudany start natywnego b12x;
- `baseline-run/`: wstępna seria podczas pobierania obrazu;
- `flashinfer-comparison/`: dodatkowa próba FlashInfer b12x.
- `runner-comparison/`: trzy powtórzenia 0.29/MRV1 i kontrola MRV2;
- `warm-start-control/`: dodatkowe starty 0.25 i 0.29/MRV1;
- `attention-comparison/`: nieudany start FlashInfer attention.

Każdy wariant zapisuje status, log startu/runtime, raport faz i walidacji oraz
smoke test, jeśli start się powiódł. `comparison.json` zapisuje identyfikatory
obrazów i fakt przywrócenia produkcji. Sekret jest przekazywany przez środowisko,
nie przez argument programu, i usuwany z zapisywanych logów kontenera.

Skrypt `benchmarks/reddit-matching/compare-versions.py` należy uruchamiać na
serwerze w `tmux`. Zatrzymuje produkcyjny LLM na czas pomiarów i przywraca ten sam
kontener w `finally`. Przed startem sprawdza ustawienia i limit 450 W. Obrazy
trzeba wcześniej pobrać/zbudować; skrypt nie pobiera ich w trakcie pomiarów.

```bash
docker pull vllm/vllm-openai:v0.29.0
docker build -f benchmarks/reddit-matching/Dockerfile.b12x \
  -t on-prem-workhorse-vllm-benchmark:v0.29.0-b12x-1.2.6 \
  benchmarks/reddit-matching

python3 benchmarks/reddit-matching/compare-versions.py \
  --variants v025 v029 b12x flashinfer_b12x \
  --repetitions 3 \
  --output benchmark-results/vllm-version-comparison-new-run
```

Dodatkowe warianty: `v029_mrv1` wymusza MRV1, `v029_flashinfer` wymusza
FlashInfer attention. `--debug-profiling` zapisuje szczegółowe logi;
`--startup-only` wykonuje start oraz test autoryzacji i JSON bez benchmarku.
Używaj nowego katalogu wyników dla każdej serii. Aby zbadać ponowny start,
przed uruchomieniem podłącz właściwy wcześniejszy katalog `cache-<wariant>`;
sam istniejący katalog nie gwarantuje trafienia w cache kompilacji — sprawdź log.

Po migracji wariant `baseline` oznacza bieżący obraz produkcyjny 0.29. Do
ponownego porównania wersji wybierz jawnie `v025 v029`; obraz 0.25 zachowano
na serwerze. Dotychczasowych katalogów `baseline` i ich wyników nie zmieniano.

## Zgodność odpowiedzi API

Smoke test `/v1/chat/completions` na 0.29 zwrócił pole `reasoning` zamiast
`reasoning_content` używanego w 0.25. Pole odpowiedzi `content` i obsługa
`response_format: json_schema` przeszły walidację. Klient, który odczytuje
osobno rozumowanie, powinien uwzględnić nową nazwę; benchmark `/v1/completions`
nie zależy od tego pola. Nie zmieniano kodu zewnętrznego klienta LeadsRun.

## Potwierdzenie po migracji na produkcji

Docelowy obraz `on-prem-workhorse-vllm:v0.29.0-gemma4-mtp` przeszedł kontrolowany
restart z użyciem zapisanej kompilacji: **8,86 GiB KV**, estymata **147 129 tokenów**.
Pierwszy start z kompilacją miał 8,29 GiB / 137 596 tokenów. Ustawienia to jawne
MRV2 / Triton / CUTLASS, .92 / 8192 / MTP4 / 450 W, logowanie INFO.

Trzy przebiegi benchmarku Reddit na finalnym kontenerze: mediana prefilter
**4.464 s**, JSON/sieve
**67.156 s**, mixed
**36.417 s**; suma median
**108.037 s**. Zaliczone 580 odpowiedzi z rozgrzewką,
w tym 290 pełnych walidacji JSON Schema; zero błędów i preempcji.

Pierwsza próba presji KV miała jedno `Server disconnected` na 192 zapytania,
po 0,155 s od rozpoczęcia zapytania w drugiej paczce. Silnik pozostał zdrowy,
bez restartów, błędów CUDA i preempcji. Możliwą przyczyną było ponowne użycie
bezczynnego połączenia HTTP; nie jest to dowiedziona diagnoza. Klient dostał
osobną pulę połączeń na każdą paczkę, bez automatycznych ponowień. Nieudaną
próbę zachowano w `migration/pressure-first-attempt/` i zbiorczym JSON.

Powtórzone paczki shared/96/2048 z osobnymi pulami HTTP przeszły **192/192** zapytań, średnio
**52.194 s**, z **0.0 preempcjami**. To osobne potwierdzenie wdrożenia,
nie zastąpienie wcześniejszego porównania A/B. Weryfikator usług przeszedł przed
benchmarkami i po nich; kontenery są zdrowe. Nie badano wielogodzinnej stabilności.

Artefakty: `benchmark-results/vllm-upgrade-20260915/migration/`; wyniki są też
w [zbiorczym JSON](data/vllm-upgrade-20260915.json). Aktualizacja obejmuje obraz,
Compose, przykładowe ustawienia, weryfikator, runbook, inwentarz i benchmarki.
