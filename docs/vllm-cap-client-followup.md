# vLLM: kontrola limitu 64/72 i puli klienta 80/100/120

Uzupełniający test z 15 września 2026 sprawdził, czy po wyłączeniu MTP warto
podnieść `max_num_seqs` ponad 64 oraz utrzymywać więcej niż 80 pojedynczych
requestów HTTP w obiegu. Użytkownik zatrzymał serię po pełnych pomiarach cap 64
i prawie całym cap 72; cap 80 celowo nie został uruchomiony.

## Decyzja

Pozostaje produkcyjne **cap 64**, a dla badanego profilu rekomendowana pula
klienta to **80 pojedynczych requestów**. Cap 72 nie dał przekonującej poprawy:
najlepsza porównywalna średnia liczby JSON-ów/s była wyższa tylko o około 1,6%,
podczas gdy tokeny/s były niższe o 2,1%, średnie KV wzrosło o 9,5 pp, a p95
HTTP o 27,6%. To nie przekracza przyjętego wcześniej praktycznego progu 2%
i zmniejsza zapas pamięci.

Produkcja pozostaje: MTP off, prefix cache on, `max_num_seqs=64`, budżet 8192,
32k kontekstu, utilization 0,92, FP8 KV, priority scheduler i 450 W. Po
zatrzymaniu serii kontener został odtworzony z głównego Compose i oryginalnym
kluczem. Pełny verifier przeszedł; tymczasowy klucz usunięto.

## Zdrowe przebiegi

Każdy pełny przebieg obejmował 20 s rozgrzewki i 60 s pomiaru przez publiczną
trasę HTTPS/Cloudflare. Wszystkie odpowiedzi przechodziły JSON Schema i kontrolę
identyfikatora. Prefix hit wynosił 75%, nie było preemption ani restartów.

| Cap | Pula klienta | Powtórzenia | JSON-y/s | Tokeny/s | KV średnio / szczyt | HTTP p50 / p95 |
|---:|---:|---:|---:|---:|---:|---:|
| 64 | **80** | 2 | **8,81** | **1263** | 76,3% / 80,9% | **8,22 / 15,77 s** |
| 64 | 100 | 1 | 8,86 | 1252 | 76,4% / 80,9% | 10,47 / 17,96 s |
| 64 | 120 | 1 | 8,80 | 1257 | 76,3% / 79,9% | 12,75 / 20,30 s |
| 72 | 80 | 1 | 8,93 | 1288 | 83,9% / 92,6% | 7,99 / 25,44 s |
| 72 | 100 | 2 | **8,95** | 1237 | 85,7% / 91,2% | 10,30 / 20,12 s |
| 72 | 120 | 2 | 8,92 | 1242 | 85,7% / 90,2% | 12,65 / 22,29 s |

Pool 100 przy cap 64 poprawił w jedynym zdrowym przebiegu JSON-y/s tylko o
0,6% względem średniej pool 80, ale podniósł medianę opóźnienia o 27%.
Pool 120 nie poprawił przepustowości i podniósł medianę o około 55%.
W praktyce backlog ponad 80 zwiększał przede wszystkim liczbę oczekujących.

## Odrzucone i niedokończone punkty

Drugie przebiegi cap 64 / pool 100 i 120 zostały niedożywione przez trasę
kliencką: średnia liczba aktywnych sekwencji spadła odpowiednio do 46,9 i 51,0,
zamiast około 63,4, a w próbkach silnik chwilowo był prawie pusty. Nie było
błędu modelu, preemption ani restartu, lecz wyniki 7,30 i 7,45 JSON/s nie są
miarą maksymalnej przepustowości GPU i nie weszły do tabeli.

Użytkownik zatrzymał serię podczas drugiego przebiegu cap 72 / pool 80. Cap 80
nie został rozpoczęty. Te braki nie zmieniają decyzji: zaobserwowana korzyść
cap 72 była zbyt mała względem wzrostu KV i ogona opóźnień, aby uzasadnić
zmianę produkcji.

## Metoda i artefakty

- RTX 5090, vLLM 0.29 / MRV2, Triton attention, FlashInfer CUTLASS, FP8 KV;
- MTP wyłączone, prefix cache włączony, budżet 8192, 32k, utilization 0,92;
- 8192 tokenów wejścia, wspólny prefix 6147 tokenów, średnio około 142 tokenów
  odpowiedzi, priorytet 0;
- każdy cap uruchamiany najpierw kompilacyjnie, potem ponownie z ciepłym AOT;
- tymczasowy klucz izolował inference od ruchu zewnętrznego, bez zmiany `.env`.

Surowe pliki są w ignorowanym katalogu
`benchmark-results/cap-client-matrix-20260915/`. Skrót wyników i SHA-256
ważnych artefaktów znajduje się w
`benchmarks/reddit-matching/cap-client-results-20260915.json`.
