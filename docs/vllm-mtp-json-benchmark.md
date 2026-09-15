# vLLM: liczba tokenów MTP przy generowaniu JSON

**Aktualizacja:** [dalsze strojenie tego samego profilu](vllm-json-tuning-benchmark.md)
porównało również MTP×1 i wyłączenie MTP. Bez MTP przy 64 aktywnych końcowe
potwierdzenie dało 8,79 JSON/s, wobec 7,91 dla MTP×2 / 56. Poniżej zachowano
wcześniejsze wyniki i zalecenia z etapów ×2/×3/×4 oraz 16k.

Porównanie z 15 września 2026 dotyczy MTP×2, ×3 i ×4 przy
`max_num_seqs=56` oraz stale uzupełnianej puli 100 pojedynczych requestów.
Celem jest liczba poprawnych JSON-ów na sekundę przy długim, częściowo
wspólnym wejściu. Nie używamy testu swobodnego tekstu jako kryterium wyboru.

## Wynik

**MTP×2 i ×3 dały podobną przepustowość, około 3–4% wyższą od ×4.**
Różnica między ×2 a ×3 to tylko około 0,3% JSON-ów/s, a zakresy wyników
poszczególnych przebiegów nakładają się. Nie dowodzi to przewagi ×2 nad ×3.

Średnie z dwóch przebiegów każdego wariantu:

| MTP | JSON-y/s | Tokeny odpowiedzi/s | KV średnio | Mediana HTTP, średnia z przebiegów | Pula KV |
|---:|---:|---:|---:|---:|---:|
| 4 | 7.64 | 1088 | 82.2% | 12.15 s | 8.96 GiB |
| 3 | 7.90 | 1126 | 81.2% | 11.74 s | 9.02 GiB |
| 2 | 7.92 | 1131 | 80.3% | 11.82 s | 9.06 GiB |

Każdy wariant zakończył dwa poprawne przebiegi; łącznie **5401 JSON-ów**
przeszło walidację. Nie było błędów requestów, niezgodności liczników ani
wywłaszczeń w oknach pomiaru. Tokeny/s w poszczególnych przebiegach:
×4 **1087 / 1090**, ×3 **1131 / 1122**, ×2 **1137 / 1126**.

MTP×2 jest rozsądnym kandydatem do konfiguracji 56 aktywnych / 100 requestów:
uzyskało najwyższą średnią i największą pulę KV, ale ×3 mieści się w tym samym
zakresie wydajności. Dodatkowe KV względem ×4 to około **0,10 GiB**, czyli
około 1,1% puli. Te krótkie testy nie potwierdzają długotrwałej stabilności
ani uniwersalnego optimum dla wszystkich schematów JSON.

MTP×4 proponowało średnio około 1,81 zaakceptowanego tokenu na próbę,
×3 około 1,57, a ×2 około 1,23. Udział zaakceptowanych propozycji wyniósł
odpowiednio około 46%, 54% i 63%. Wyższa liczba trafionych tokenów na próbę
nie oznaczała wyższej końcowej przepustowości. To metryki z liczników vLLM,
nie ocena jakości odpowiedzi.

Pomiary są testowe: nie zmieniono `.env` ani domyślnego entrypointu.
Po serii przywrócono konfigurację produkcyjną **80 sekwencji / MTP×4**
i oryginalny klucz API. Pełna weryfikacja wdrożenia przeszła poprawnie,
w tym zdrowie usług, autoryzacja, JSON, publiczny tunel i limit 450 W.
Średnie wykorzystanie GPU w pomiarach wynosiło: ×4 **89,8%**, ×3 **91,6%**,
×2 **92,4%**. Weryfikacja przywrócenia znajduje się w artefaktach.

## Metoda

- Ten sam RTX 5090, obraz vLLM 0.29, Model Runner V2, Triton attention,
  FlashInfer CUTLASS, FP8 KV, utilization 0,92, budżet 8192 tokenów i 450 W.
- HTTPS z Maca przez Cloudflare; liczniki silnika przez osobny tunel SSH.
- Prompty mają dokładnie 8192 tokeny i wspólny prefiks 6147 tokenów.
- Trzy pola JSON: `record_id`, `decision`, `reason`. Xgrammar wymusza schemat;
  klient sprawdza schemat, identyfikator rekordu, liczbę tokenów wejścia
  i zakończenie odpowiedzi. Nie oceniamy jakości merytorycznej uzasadnienia.
- Temperatura 0, `n=1`, bez streamingu, priorytet 0. Każdy zakończony request
  jest natychmiast zastępowany kolejnym. Maksymalna odpowiedź: 1024 tokeny,
  naturalny koniec generacji; bez wymuszania stałej liczby tokenów.
- Każdy wariant: dwa przebiegi, po 20 s rozgrzewki i 90 s pomiaru.
  Odrębny `cache_salt` dla każdego przebiegu, unikalne rekordy w jego obrębie.
- Po pomiarze wszystkie wysłane zadania kończą pracę. Suma ich
  `usage.completion_tokens` musi zgadzać się z pełnym przyrostem licznika
  generacji silnika. Wynik nie zawiera obcego ruchu ani ponowień żądań.
- Nowe warianty MTP przechodzą pierwszą kompilację i ponowny start przed
  pomiarem. Pula KV jest ustalana automatycznie przy stałym utilization;
  porównujemy wynik całej konfiguracji, bez sztucznego wyrównywania KV.
- `nvidia-smi` próbkuje GPU i moc co sekundę. Średnie obejmują wyłącznie
  90-sekundowe okna pomiaru; synchronizacja zegarów jest przybliżona.
- JSON-y/s liczymy po odebraniu poprawnych odpowiedzi. Tokeny/s pochodzą
  z licznika silnika. Średnia długość odpowiedzi i granice okna mogą wpływać
  na relację tych dwóch wskaźników.

## Profile

Profil początkowy powtarza wcześniejszy benchmark: instrukcja `reason`
na około 30, 100 lub 220 słów, średnio około 142 tokeny całej odpowiedzi.
Kolejność konfiguracji: ×4, ×3, ×2, po dwa przebiegi każdej.

Przygotowano również bank 4096 promptów z instrukcją **2–3 zwięzłych zdań**
w `reason` (30, 45 lub 60 słów), ale użytkownik anulował tę dodatkową serię
przed pierwszym żądaniem inferencji. Żaden wynik poniżej nie pochodzi z tego
profilu. Wcześniejszy bank z instrukcją 10–20 słów również nie był testowany.

Nie porównujemy bezpośrednio tokenów/s między profilami o różnej długości
odpowiedzi. W każdym profilu konfiguracje korzystają z tego samego banku.

## Limit kontekstu 16k i większa liczba aktywnych sekwencji

Dodatkowa krótka seria używała **16 384 tokenów maksymalnego kontekstu**,
MTP×2 i stałej puli 100 pojedynczych requestów. Zmieniano limit aktywnych
sekwencji: 56, 80, 100. Prompty i odpowiedzi pozostały takie same jak
w zakończonym profilu początkowym: 8192 tokeny wejścia, średnio około
142 tokeny odpowiedzi. Nie użyto anulowanego profilu 2–3 zdań.

Każdy wariant przeszedł pierwszą kompilację i ciepły start, a następnie
20 s rozgrzewki + **jeden pomiar 60 s**. To szybkie porównanie, bez dodatkowych
powtórzeń ani badania stabilności długotrwałej.

| Limit kontekstu | Limit aktywnych | JSON-y/s | Tokeny/s | Pula KV | KV średnio | Wywłaszczenia |
|---:|---:|---:|---:|---:|---:|---:|
| 32 768 | 56 | 7.92 | 1131 | 9.06 GiB | 80.3% | 0 / 0 |
| 16 384 | 56 | 8.00 | 1133 | 9.06 GiB | 80.9% | 0 |
| 16 384 | 80 | 6.83 | 972 | 8.92 GiB | 96.0% | 3 |
| 16 384 | 100 | 6.87 | 979 | 8.85 GiB | 96.0% | 3 |

Pierwszy wiersz to wcześniejsza średnia z dwóch 90-sekundowych pomiarów;
pozostałe pochodzą z nowej serii. Wynik 16k / 56 mieści się w zakresie
wcześniejszych wyników tokenów/s przy 32k / 56. Nie widać korzyści pamięciowej
ani wyraźnego przyspieszenia od samego obniżenia limitu kontekstu.

Przy 16k podniesienie limitu aktywnych do 80 lub 100 obniżyło przepustowość
JSON o około **14–15%** względem 56. Średnia liczba pracujących sekwencji
wzrosła z 55,0 do 61,7 / 61,1, ale udział trafień prefix cache spadł z około
70% do 63%. Mediana HTTP wzrosła z 11,66 s do około 13,56–13,57 s.
Wysokie zajęcie KV i wywłaszczenia wskazują na presję pamięci; seria nie
izoluje wszystkich kosztów schedulera i przetwarzania promptów.

**Dla tego obciążenia pozostaje zalecenie: 56 aktywnych / 100 requestów,
MTP×2 lub ×3.** 16k może służyć jako ograniczenie długości przyjmowanych
zadań, ale ten test nie daje powodu do skracania kontekstu dla przepustowości.

Przy 56 aktywnych log podawał 150 436 szacowanych tokenów KV dla limitu 32k
i 86 320 dla 16k, mimo identycznej puli **9,06 GiB**. Funkcja
`get_kv_cache_capacity()` wylicza tę prezentowaną wartość jako szacowaną
współbieżność dla pełnego kontekstu pomnożoną przez `max_model_len`.
Nie jest to niezależna od konfiguracji miara fizycznej pamięci;
porównanie opiera się na GiB oraz rzeczywistym obciążeniu.

Wszystkie **1827 JSON-ów** przeszły walidację, liczniki tokenów były zgodne.
Średnie próbki GPU wyniosły 90,0% / 93,9% / 87,8% dla limitów 56 / 80 / 100.
Po serii przywrócono produkcyjne 32k / 80 sekwencji / MTP×4 oraz oryginalny
klucz API. Pełna weryfikacja wdrożenia przeszła poprawnie.
Surowe dane i skrypty: `benchmark-results/context16k-20260915/`.
[Skrócone wyniki 16k](../benchmarks/reddit-matching/context16k-results-20260915.json).

## Alternatywy dla MTP

Suffix decoding może wykorzystywać powtórzenia w promptach i wcześniejszych
generacjach. Powtarzalne klucze JSON mogą być pomocne, ale nowa treść pola
`reason` ogranicza możliwość prostego kopiowania tokenów. Sam format JSON
nie dowodzi przewagi konkretnej metody.
[Dokumentacja suffix decoding](https://docs.vllm.ai/en/v0.29.0/features/speculative_decoding/suffix/).

W zainstalowanym vLLM 0.29 Model Runner V2 odrzuca `ngram`, `ngram_gpu`
i `suffix` jako nieobsługiwane. Potwierdzono to w
`vllm/config/vllm.py`, w kontroli zgodności runnera. Ich pomiar wymagałby
zmiany runnera i osobnego porównania całej konfiguracji; nie są wariantami
zmierzonej tutaj serii MTP.
[Źródło konfiguracji v0.29](https://github.com/vllm-project/vllm/blob/v0.29.0/vllm/config/vllm.py).

## Odtworzenie i artefakty

`prepare-network-load.py --profile json-short` przygotowuje profil 2–3 zdań;
`--tokenizer` pozwala użyć lokalnej kopii dokładnych plików tokenizera.
`network-load.py` prowadzi pomiar i zapisuje liczniki propozycji oraz akceptacji
MTP. `summarize-mtp-network.py` sprawdza wyniki i dopasowuje próbki GPU.

Surowe artefakty: `benchmark-results/mtp-network-20260915/` i
`benchmark-results/mtp-json-short-20260915/`. Zawierają polecenia, kopie
skryptów, odczytane argumenty procesu, logi startów oraz weryfikację
przywrócenia. Tymczasowe klucze API nie są kopiowane do artefaktów lokalnych.

[Skrócone wyniki i skróty artefaktów](../benchmarks/reddit-matching/mtp-network-results-20260915.json).
