# Pamięć GPU i konfiguracja vLLM — krok po kroku

Instrukcja dla naszego serwera **RTX 5090**, **vLLM 0.29** i modelu
**Gemma 4 26B-A4B NVFP4** z oficjalnym asystentem MTP. Poniższe ustawienia
stanowią domyślną konfigurację tego wdrożenia.

## 1. Ustaw konfigurację w `.env`

Połącz się z serwerem i przejdź do repozytorium:

```bash
ssh server@server
cd /home/server/on-prem-workhorse
```

W istniejącym pliku `.env` ustaw:

```dotenv
MODEL_DIR=/home/server/models
VLLM_CACHE_DIR=/home/server/.cache/vllm-gemma4-v029

VLLM_GPU_MEMORY_UTILIZATION=0.92
VLLM_MAX_MODEL_LEN=32768
VLLM_MAX_NUM_SEQS=80
VLLM_MAX_NUM_BATCHED_TOKENS=8192

VLLM_KV_CACHE_DTYPE=fp8
VLLM_KV_CACHE_DTYPE_SKIP_LAYERS=
VLLM_ATTENTION_BACKEND=TRITON_ATTN
VLLM_MOE_BACKEND=flashinfer_cutlass
```

Modele znajdują się w dwóch katalogach pod `MODEL_DIR/hf`:

- `Gemma-4-26B-A4B-NVFP4` — model główny;
- `gemma-4-26B-A4B-it-assistant` — asystent MTP, który proponuje kolejne tokeny.

`VLLM_CACHE_DIR` przechowuje skompilowany kod używany przy kolejnych startach.
Katalog pozostaje na dysku po odtworzeniu kontenera. KV cache kontekstów
zapytań jest natomiast przechowywany w pamięci GPU podczas pracy silnika.

Przy przygotowaniu nowego hosta skorzystaj najpierw z
[instrukcji instalacji serwera](../deploy/server/README.md).

## 2. Pozostaw GPU memory utilization na `0.92`

**Domyślna wartość to `0.92`. Pozostaw ją tak ustawioną.** Compose przekazuje
ją do vLLM jako `--gpu-memory-utilization 0.92`.

Parametr określa budżet pamięci vLLM jako udział całkowitej pamięci GPU.
Obejmuje modele, pamięć roboczą i KV cache. Nie ogranicza wykorzystania
mocy obliczeniowej GPU do 92%.

Pojemność karty sprawdzisz poleceniem:

```bash
nvidia-smi --query-gpu=name,memory.total --format=csv
```

Dla RTX 5090 raportującego **32 607 MiB** rachunek wygląda tak:

```text
Pamięć GPU:          32 607 MiB / 1024 = 31,84 GiB
Budżet vLLM:        31,84 GiB × 0,92 ≈ 29,30 GiB
Poza budżetem:      31,84 GiB × 0,08 ≈  2,55 GiB
```

Budżet liczymy od całkowitej pojemności karty. Pozostała pamięć zapewnia
miejsce na dodatkowe alokacje podczas pracy. Jej chwilową dostępność pokazuje
`memory.free`; nie musi ona wynosić dokładnie 2,55 GiB.

## 3. Pozwól vLLM przydzielić KV cache

KV cache przechowuje wyniki obliczeń uwagi dla tokenów kontekstu. Dzięki temu
model może generować następne tokeny bez ponownego przeliczania całego promptu.

Przy starcie vLLM ładuje modele, profiluje zapotrzebowanie na pamięć i dobiera
rozmiar KV cache w ramach budżetu. Używaj automatycznego przydziału z
`gpu_memory_utilization=0.92` oraz formatu **FP8**:

```dotenv
VLLM_KV_CACHE_DTYPE=fp8
VLLM_KV_CACHE_DTYPE_SKIP_LAYERS=
```

Pusta lista `SKIP_LAYERS` oznacza stosowanie FP8 do wszystkich warstw uwagi.
Nie ustawiaj dodatkowego limitu `--kv-cache-memory-bytes`.

Orientacyjny podział pamięci dla tej konfiguracji:

| Składnik | Pamięć |
|---|---:|
| Cały budżet vLLM | około 29,30 GiB |
| Załadowany model wraz z MTP | około 17,64 GiB |
| KV cache po starcie z zapisaną kompilacją | około 8,86 GiB |
| Reszta budżetu na pozostałe alokacje, w tym pamięć roboczą i CUDA graphs | około 2,80 GiB |

Modele są współdzielone przez obsługiwane zapytania. Więcej równoczesnych
sekwencji nie oznacza ładowania osobnej kopii modelu dla każdej z nich.
Faktyczny przydział KV dla danego uruchomienia odczytaj z logów:

```bash
docker logs ik-llama 2>&1 | grep -E 'Model loading took|Available KV cache memory|GPU KV cache size'
```

`Available KV cache memory` podaje rozmiar puli w GiB, a `GPU KV cache size`
podaje szacowaną pojemność w tokenach.

## 4. Ustaw limity obsługi zapytań

Pozostaw trzy domyślne limity:

| Zmienna | Wartość | Znaczenie |
|---|---:|---|
| `VLLM_MAX_MODEL_LEN` | `32768` | Maksymalny łączny kontekst jednej sekwencji: wejście i generowana odpowiedź. |
| `VLLM_MAX_NUM_SEQS` | `80` | Górny limit sekwencji obsługiwanych równocześnie. |
| `VLLM_MAX_NUM_BATCHED_TOKENS` | `8192` | Budżet tokenów przetwarzanych w jednej iteracji schedulera. |

Scheduler rozdziela pracę pomiędzy zapytania zgodnie z tymi limitami i dostępnym
KV cache. Limit 80 sekwencji nie oznacza rezerwacji 80 pełnych kontekstów po
32 768 tokenów. Przy długich kontekstach część zapytań może czekać w kolejce.

Wspólne początki promptów mogą korzystać ze współdzielonych bloków KV dzięki
włączonemu prefix caching. Chunked prefill dzieli przetwarzanie długiego promptu
na części mieszczące się w budżecie iteracji.

## 5. Używaj MRV2, Tritona i MTP ×4

Konfiguracja rozdziela dwa rodzaje obliczeń:

| Rodzaj obliczeń | Ustawienie |
|---|---|
| Uwaga — korzystanie z kontekstu i KV cache | `VLLM_ATTENTION_BACKEND=TRITON_ATTN` |
| MoE — obliczenia ekspertów modelu NVFP4 | `VLLM_MOE_BACKEND=flashinfer_cutlass` |

[Compose](../docker-compose.yml) włącza **Model Runner V2** przez
`VLLM_USE_V2_MODEL_RUNNER=1`. Runner zarządza wykonywaniem modelu na GPU.

[Entrypoint](../deploy/vllm/entrypoint.sh) ustawia **MTP z czterema tokenami**:
asystent proponuje tokeny, a model główny je weryfikuje. Ten sam skrypt włącza
prefix caching, chunked prefill, asynchroniczny scheduler oraz **xgrammar**
do generowania odpowiedzi zgodnych ze schematem JSON. Te ustawienia są już
częścią polecenia startowego.

Host używa trwałego limitu mocy **450 W**, ustawianego przez usługę
`nvidia-power-limit.service` opisaną w instrukcji instalacji.

## 6. Uruchom i sprawdź usługę

Z katalogu repozytorium na serwerze wykonaj:

```bash
docker compose up -d --build --no-deps ik-llama
docker compose ps
```

Poczekaj, aż `ik-llama` osiągnie stan `healthy`. Podczas pierwszego startu
vLLM przygotowuje kompilację i grafy CUDA; zapisany cache przyspiesza kolejne
uruchomienia.

Uruchom weryfikator:

```bash
./deploy/server/verify.sh
```

Sprawdza on wersję vLLM i konfigurację działającego kontenera, limit 450 W,
stan usług, autoryzację API, odpowiedź JSON, scraper i publiczny tunel.
Poprawne zakończenie wypisuje:

```text
All deployment checks passed.
```

Bieżące zużycie pamięci i limit mocy możesz podejrzeć poleceniem:

```bash
nvidia-smi --query-gpu=memory.total,memory.used,memory.free,power.limit --format=csv
```

Gotowa konfiguracja to **vLLM 0.29 / MRV2 / Triton / CUTLASS**, **FP8 KV**,
**utilization 0.92**, **batch 8192**, **MTP ×4** i **450 W**.
