# vLLM: dalsze strojenie ciągłej generacji JSON

Seria z 15 września 2026 sprawdza liczbę tokenów MTP, budżet tokenów
schedulera i limit aktywnych sekwencji. Punktem odniesienia jest konfiguracja
MTP×2 / 8192 / 56 z [poprzedniego porównania](vllm-mtp-json-benchmark.md).

## Wniosek i końcowe potwierdzenie

**Najlepszy z przetestowanych wariantów to wyłączone MTP / 64 aktywne
sekwencje / budżet 8192 / 100 pojedynczych requestów w obiegu.**
Kontekst pozostaje 32k, utilization 0,92, limit mocy 450 W.

Końcowa, dodatkowa para pomiarów zwycięzcy i ponownie uruchomionej bazy:

| Konfiguracja | JSON-y/s | Tokeny odpowiedzi/s | KV średnio | GPU średnio | Mediana HTTP¹ |
|---|---:|---:|---:|---:|---:|
| MTP×2 / 56 aktywnych | 7.91 | 1139 | 80.8% | 91.2% | 11.73 s |
| bez MTP / 64 aktywne | **8.79** | **1251** | **76.2%** | 95.1% | 10.50 s |

¹ Średnia z median dwóch przebiegów.

To **11,0% więcej JSON-ów/s i 9,8% więcej tokenów/s** w końcowym porównaniu.
Zwycięzca dał **1251 / 1250 tokenów/s**; baza **1146 / 1132 tokeny/s**.
Nie podajemy początkowego maksimum 1269 jako trwałej przepustowości.
Cała seria: **18 poprawnych przebiegów i 12 760 zwalidowanych JSON-ów**,
bez błędów requestów, niezgodności liczników i wywłaszczeń w oknach pomiaru.

Najsilniejsza korzyść pochodzi z wyłączenia MTP dla tego profilu i dużej
współbieżności. Przewaga 64 nad 56 jest mniejsza: 2,8% we wstępnym
porównaniu, a końcowy wynik 64 jest tylko około 1,4% ponad wcześniejszą
średnią 56 bez MTP. W końcowej parze nie powtórzono 56 bez MTP;
trwała przewaga samego limitu 64 wymagałaby dłuższego porównania.

Na polecenie użytkownika zwycięzca został najpierw pozostawiony jako override,
a następnie **awansowany do trwałej konfiguracji produkcyjnej**: bez MTP / 64 /
8192 z oryginalnym kluczem API. Compose, `.env.example`, serwerowe `.env`,
entrypoint i weryfikator deklarują ten sam stan, więc zwykłe odtworzenie
kontenera nie wraca już do MTP×4 / 80. Weryfikacja ustawień, autoryzacji,
lokalnego i publicznego API, JSON, scrapera oraz 450 W przeszła poprawnie.
Pula KV w benchmarkowym ciepłym starcie wynosiła **10,26 GiB**.
[Stan działającego serwera](../deploy/server/VERIFIED_STATE.md).

## MTP i budżet tokenów

Średnie z dwóch przebiegów; wszystkie przy limicie 56 aktywnych sekwencji.

| MTP | Budżet tokenów | JSON-y/s | Tokeny odpowiedzi/s | Pula KV |
|---|---:|---:|---:|---:|
| ×2, punkt odniesienia | 8192 | 7.91 | 1131 | 9.06 GiB |
| ×1 | 8192 | 7.90 | 1136 | 9.25 GiB |
| wyłączone | 8192 | **8.66** | **1235** | 10.32 GiB |
| wyłączone | 6144 | 8.63 | 1229 | 10.58 GiB |
| wyłączone | 10240 | 8.37 | 1203 | 10.03 GiB |

Wyłączenie MTP dało około **9,6% więcej JSON-ów/s** niż MTP×2.
MTP×1 i ×2 są tutaj praktycznie równe. Większa pula KV po wyłączeniu
modelu pomocniczego jest częścią zmierzonej zmiany konfiguracji; seria nie
rozdziela jej wpływu od kosztu obliczeń speculative decoding.

Budżet 6144 zostawia nieco więcej pamięci na KV, ale nie poprawił
przepustowości. 10240 uzyskało około 3,4% mniej JSON-ów/s niż 8192.
Do etapu limitów aktywnych wybrano **wyłączone MTP / budżet 8192**.

## Limit aktywnych sekwencji

Wszystkie warianty poniżej: MTP wyłączone, budżet 8192, pula klienta 100.

| Limit aktywnych | JSON-y/s | Tokeny/s | Pula KV | KV średnio | GPU średnio | Mediana HTTP¹ |
|---:|---:|---:|---:|---:|---:|---:|
| 48 | 8.37 | 1201 | 10.33 GiB | 56.9% | 95.7% | 11.22 s |
| 56 | 8.66 | 1235 | 10.32 GiB | 66.5% | 94.8% | 10.76 s |
| 64 | **8.90** | **1265** | 10.26 GiB | 76.5% | 95.3% | 10.41 s |

¹ Średnia z median obu przebiegów, obejmująca także oczekiwanie w kolejce.

64 dało około **2,8% więcej JSON-ów/s niż 56** i zostało wybrane do
końcowego potwierdzenia. W obu przebiegach 64 nie było wywłaszczeń;
szczytowe zajęcie KV wynosiło około 81,5% / 81,9%. Większy limit po
wyłączeniu MTP wypada inaczej niż w poprzednich testach z modelem
pomocniczym. Ta seria kończy przeszukiwanie na 64 i nie ustala optymalnego
limitu dla wyłączonego MTP powyżej tej wartości.

Najwyższy średni wskaźnik użycia GPU miał wariant 48, mimo najniższej
przepustowości w tej tabeli. Samo wykorzystanie GPU lub zajęcie KV nie
wystarcza do wyboru najszybszej konfiguracji.

## Metoda

- RTX 5090, vLLM 0.29 / Model Runner V2, Triton attention, FlashInfer CUTLASS,
  FP8 KV, utilization **0,92**, limit mocy **450 W**, kontekst **32 768**.
- Ten sam bank co wcześniej: dokładnie **8192 tokeny wejścia**, wspólny
  prefiks **6147 tokenów**, trzy pola JSON (`record_id`, `decision`, `reason`).
  Nie używamy anulowanego profilu z instrukcją 2–3 zdań.
- **100 pojedynczych requestów w obiegu**, uzupełnianych po zakończeniu
  odpowiedzi, HTTPS z Maca przez Cloudflare. Priorytet 0, temperatura 0,
  bez streamingu, naturalny koniec odpowiedzi, limit 1024 tokenów wyjścia.
- Każda konfiguracja: **dwa przebiegi**, każdy po 20 s rozgrzewki i 60 s
  pomiaru, następnie zakończenie wszystkich wysłanych requestów.
- Każdy przebieg ma oddzielny `cache_salt` i unikalne identyfikatory rekordów.
  Klient sprawdza schemat, identyfikator, długość wejścia i zakończenie
  odpowiedzi. Pełna suma tokenów odpowiedzi musi zgadzać się z przyrostem
  licznika silnika. Tymczasowy klucz API izoluje ruch benchmarku.
- Pomiary odbywają się po ciepłym starcie. Pierwsza kompilacja nowego wariantu
  i jej mniejsza pula KV nie są podstawą porównania. Nie wyrównujemy ręcznie
  puli KV: mierzymy całą konfigurację przy tym samym utilization.
- Argumenty działającego procesu są odczytywane po starcie i ponownie
  niezależnie podczas benchmarku. Próbki GPU i mocy co sekundę dopasowujemy
  do okna pomiaru; KV i kolejki odczytujemy z metryk silnika.
- JSON-y/s oznaczają poprawne odpowiedzi odebrane przez klienta. Tokeny/s
  pochodzą z licznika generacji silnika. Granice okna i długości odpowiedzi
  powodują, że te dwa wskaźniki nie muszą zmieniać się identycznie.

## Kolejność i reguła wyboru

1. MTP×2 → ×1 → całkowicie wyłączone MTP.
2. Dla wybranego MTP: budżet 8192 → 6144 → 10240.
3. Dla wybranego MTP i budżetu: limit aktywnych 56 → 48 → 64.
4. Dwa dodatkowe pomiary wybranej konfiguracji oraz, jeśli jest inna,
   dwa ponowne pomiary początkowego MTP×2 / 8192 / 56.

Wybór na każdym etapie wymaga poprawnego zakończenia obu przebiegów i zera
wywłaszczeń w oknach pomiaru. Kryterium to średnia liczba JSON-ów/s.
Jeżeli najwyższa średnia przewyższa wariant odniesienia o najwyżej 2%,
zostawiamy wariant odniesienia. To ustalony przed serią próg praktyczny,
nie test istotności statystycznej.

Jest to przeszukiwanie etapami. Nie sprawdzamy wszystkich kombinacji,
więc wynik nie dowodzi globalnego optimum. Krótkie powtórzenia nie zastępują
testu długotrwałej stabilności ani oceny jakości merytorycznej odpowiedzi.

## Odtworzenie i artefakty

Surowe dane: `benchmark-results/json-tuning-20260915/`. Katalog zawiera bank
poleceń, kopię klienta `network-load.py`, kontroler serii, pomocnik zmieniający
wyłącznie testowy kontener, logi startów, odczytane argumenty, przebiegi,
próbki GPU i weryfikację pozostawionego wariantu. Bank promptów jest wspólny z wcześniejszą
serią sieciową; jego SHA-256 zapisano w wynikach. Sekretów nie kopiujemy.

Walidacja i skrócenie zakończonej serii:

```bash
python3 benchmarks/reddit-matching/summarize-json-tuning.py \
  benchmark-results/json-tuning-20260915 \
  benchmarks/reddit-matching/json-tuning-results-20260915.json
```

Skrypt sprawdza zgodność żywej konfiguracji, liczniki tokenów, unikalność
rekordów, próbki GPU, aktywność MTP i potwierdzony końcowy stan serwera. Zachowuje także
nieudane próby oraz skróty SHA-256 surowych artefaktów.

`verify-kept.sh` jest kopią weryfikatora wdrożenia z oczekiwanym żywym limitem
64, dodatkową kontrolą braku MTP i zgodności klucza API z oryginalnym `.env`.
Standardowy `deploy/server/verify.sh` został następnie zaktualizowany: wymaga
produkcyjnego limitu 64, prefix cache i braku `--speculative-config`.
`restore-cancelled.json` opisuje przerwanie
automatu, a `kept-best.json` i `verification-kept.log` potwierdzają stan końcowy.

Dalsza [kontrola cap 64/72 i puli klienta](vllm-cap-client-followup.md) nie
znalazła wystarczającej korzyści z podniesienia limitu. Produkcja pozostaje na
64; dla tego profilu rekomendowana pula klienta to 80.

[Skrócone wyniki i SHA-256 artefaktów](../benchmarks/reddit-matching/json-tuning-results-20260915.json).
