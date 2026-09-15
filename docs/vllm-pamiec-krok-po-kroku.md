# Pamięć GPU i vLLM — krok po kroku

**Aktualna produkcja: vLLM 0.29 / MRV2, `--gpu-memory-utilization 0.92`.**
To ustawienie projektu, zachowane po migracji z 0.25. Poniższy opis i odczyty
są historycznym zapisem zmiany 0.90 → 0.92 na **vLLM 0.25**; nie należy ich
odczytywać jako bieżących pomiarów 0.29. Porównanie przy takim samym stanie
kompilacji wykazało 9,41 GiB KV na 0.25 i 8,86 GiB na 0.29/MRV2 (~5,8% mniej).
Różnica raportowanej liczby tokenów obejmuje też zmianę wzoru schedulera.

Aktualne [wnioski i porównanie pamięci](vllm-029-benchmark.md),
[test nasycenia KV](vllm-kv-pressure-benchmark.md) oraz
[zweryfikowany stan produkcji](../deploy/server/VERIFIED_STATE.md).

## 1. Sprawdzamy, ile pamięci VRAM raportuje karta

Zaczynamy od pamięci karty graficznej (VRAM). Jest ona osobna od RAM-u
komputera. Do obliczeń używamy wartości raportowanej przez sterownik,
zamiast zakładać dokładnie 32 GB na podstawie nazwy/specyfikacji karty.

Na serwerze z RTX 5090 uruchamiamy:

```bash
nvidia-smi --query-gpu=name,memory.total,memory.used,memory.free --format=csv
```

Znaczenie pól:

| Pole | Co oznacza |
|---|---|
| `name` | Nazwa karty graficznej. |
| `memory.total` | Całkowita pamięć GPU raportowana przez sterownik — punkt wyjścia do dalszych obliczeń. |
| `memory.used` | Pamięć zajęta w chwili pomiaru, m.in. przez działające procesy. |
| `memory.free` | Pamięć wolna w chwili pomiaru. |

W [ostatnim zapisanym pomiarze z 4 września 2026](../deploy/server/VERIFIED_STATE.md)
nasz RTX 5090 raportował **32 607 MiB** pamięci całkowitej.

Przeliczenie jednostek:

```text
1 GiB = 1024 MiB
32 607 MiB / 1024 = około 31,84 GiB
```

**Do kolejnego kroku przyjmujemy więc 31,84 GiB całkowitej pamięci GPU.**
To cała raportowana pojemność, a nie ilość wolna ani pamięć przeznaczona
wyłącznie na wagi modelu. GiB i GB są różnymi jednostkami; tutaj liczymy
w MiB i GiB, zgodnie z wynikiem `nvidia-smi`.

Wartość potwierdzono ponownie przez SSH (`server@server`) 15 września 2026:
`memory.total=32607 MiB`, `memory.used=29414 MiB`, `memory.free=2696 MiB`.
To chwilowy odczyt; całkowita pojemność może obejmować również pamięć
zarezerwowaną przez sterownik, więc `used + free` nie musi równać się `total`.

## 2. Obliczamy budżet pamięci vLLM

W [konfiguracji Compose](../docker-compose.yml) domyślne ustawienie to
`VLLM_GPU_MEMORY_UTILIZATION=0.92`. Skrypt uruchomieniowy przekazuje je jako
`--gpu-memory-utilization 0.92`. Wcześniejsze ustawienie wynosiło `0.90`.

Oznacza to, że vLLM planuje wykorzystanie 92% całkowitej raportowanej pamięci
GPU. Liczymy od `memory.total`, a nie od chwilowego `memory.free`:

```text
Pamięć całkowita:     32 607 MiB / 1024 = 31,8428 GiB
Budżet vLLM:         31,8428 GiB × 0,92 ≈ 29,30 GiB
Poza tym budżetem:   31,8428 GiB × 0,08 ≈  2,55 GiB
```

**29,30 GiB to wspólny budżet na wagi modelu i MTP, pamięć roboczą
uwzględnioną podczas profilowania oraz KV cache.** Nie jest to budżet samych
wag. Parametr dotyczy pamięci; GPU nadal może wykorzystywać pełną moc
obliczeniową.

Pozostałe około 2,55 GiB zapewnia zapas m.in. na dodatkowe alokacje w trakcie
pracy. Nie jest to gwarancja, że `nvidia-smi` zawsze pokaże tyle wolnej pamięci:
zużycie zmienia się w czasie, a pamięć mogą zajmować też inne procesy.

Dlaczego wcześniej ustawiliśmy 0,90? W [testach mieszanego obciążenia](../benchmarks/reddit-matching/README.md#mixed-production-oom-and-revised-safety-envelope)
przy wcześniejszym 0,94 obliczenia MoE potrzebowały dodatkowych 724 MiB,
gdy fizycznie wolne pozostawało tylko 495–575 MiB. Silnik kończył pracę
z błędem CUDA OOM (brak pamięci GPU).

Zapas poza budżetem vLLM wynosi:

| Ustawienie | Zapas poza budżetem vLLM |
|---|---:|
| `0.94` | około **1,91 GiB** |
| `0.90` | około **3,18 GiB** |
| `0.92` — obecne | około **2,55 GiB** |

Przy obecnym `0.92` zapas wynosi więc **2,55 GiB**.

**Wynik tego kroku: do podziału wewnątrz vLLM mamy około 29,30 GiB.**

### Jak dobierać `--gpu-memory-utilization` — dokumentacja vLLM

Sprawdzone 15 września 2026 w oficjalnej dokumentacji vLLM 0.25.0:

- Parametr określa udział pamięci GPU dla konkretnej instancji vLLM.
  Dokumentacja tej wersji podaje domyślne `0.92`. Potwierdzono to również
  w zainstalowanym na serwerze `vllm/config/cache.py`:
  `gpu_memory_utilization: float = Field(default=0.92, gt=0, le=1)`.
  Nasze obecne `0.92` jest ustawione jawnie.
- Przy automatycznym doborze KV cache vLLM profiluje zużycie pamięci
  i przeznacza pozostałą część budżetu na cache. Zwiększenie parametru
  pozwala powiększyć cache.
- Dokumentacja zaleca rozważenie podniesienia wartości, gdy brakuje KV cache
  i sekwencje są często wstrzymywane, a następnie przeliczane ponownie
  (preemption/recompute). Taka sytuacja zwiększa opóźnienia.
- Można też zmniejszyć `max_num_seqs` lub `max_num_batched_tokens`.
  To inne ustawienia wpływające na zapotrzebowanie na pamięć.
- Jawne ustawienie `--kv-cache-memory-bytes` zastępuje automatyczny dobór
  cache na podstawie `gpu_memory_utilization`. Nasz entrypoint nie używa
  tego nadpisania.

Źródła: [opis parametrów](https://docs.vllm.ai/en/v0.25.0/configuration/engine_args/#--gpu-memory-utilization),
[strojenie i preemption](https://docs.vllm.ai/en/v0.25.0/configuration/optimization/#preemption),
[kod profilowania pamięci](https://docs.vllm.ai/en/v0.25.0/api/vllm/v1/worker/gpu_worker/).

Na polecenie użytkownika zwiększyliśmy ustawienie z `0.90` do `0.92`,
aby uzyskać więcej miejsca na KV cache. Sam fakt, że jest to wartość
domyślna vLLM, nie dowodzi stabilności dla każdego modelu i obciążenia.
Zmiany sprawdzamy na reprezentatywnym obciążeniu,
sprawdzając błędy OOM, preemption, opóźnienia i przepustowość. Sam udany
start modelu nie wystarcza do potwierdzenia stabilności. Jest to procedura
doboru dla naszego wdrożenia, a nie uniwersalna wartość zalecana przez vLLM.

## 3. Ustalamy, ile VRAM zajmują załadowane wagi modelu i MTP

Z budżetu 29,30 GiB część zajmują wagi głównego modelu
`Gemma-4-26B-A4B-NVFP4` i asystenta `gemma-4-26B-A4B-it-assistant`.
Wagi to wyuczone parametry modeli potrzebne do wykonywania obliczeń.

**Wagi są współdzielone przez obsługiwane sekwencje.** Uruchomienie 80
sekwencji nie oznacza załadowania 80 kopii modelu do pamięci GPU.

W zapisanym stanie produkcji mamy rozmiary katalogów modeli na dysku:

| Składnik | Rozmiar na dysku — nie pomiar VRAM |
|---|---:|
| Model główny | około 18 GiB |
| Asystent MTP | około 832 MiB, czyli 0,81 GiB |
| Razem | około 18,8 GiB |

**Nie odejmujemy tych 18,8 GiB jako potwierdzonego zużycia VRAM.**
Katalogi zawierają pliki modelu, a reprezentacja załadowana na GPU może
zajmować inną ilość pamięci.

Na serwerze szukamy informacji o ładowaniu i profilowaniu pamięci w logach:

```bash
docker logs ik-llama 2>&1 | grep -Ei 'model loading took|loading model weights|model weights take|memory profiling|available kv cache memory'
```

Podczas odczytu przez SSH 15 września 2026 logi kontenera pokazały:

```text
Model loading took 17.64 GiB memory
```

**17,64 GiB obejmuje załadowany model główny razem z MTP.** Sprawdzono
to w kodzie zainstalowanego vLLM: w `gpu_model_runner.py`, w funkcji
`load_model`, zarówno ładowanie modelu głównego, jak i `drafter.load_model`
odbywa się w tym samym bloku `DeviceMemoryProfiler`. Nie doliczamy MTP
ponownie. Jest to pomiar alokacji podczas ładowania modeli, nie suma
rozmiarów plików ani całkowita zajętość GPU z `nvidia-smi`.

Na tym etapie rachunek wygląda tak:

```text
29,30 GiB − 17,64 GiB = około 11,66 GiB
                        na pamięć roboczą i KV cache
```

**Wynik tego kroku: załadowane modele zajmują około 17,64 GiB, a z budżetu
pozostaje około 11,66 GiB.** Nie można tej reszty w całości przypisać
kontekstom, ponieważ obliczenia również potrzebują pamięci.

### Odczyty przed zmianą: `0.90`

Ostatnie wpisy startowe znalezione w logach (oznaczone `09-01 10:41`)
podają `0.90`, **8,78 GiB KV cache**, **241 245 tokenów pojemności cache**
oraz **0,44 GiB szacowanej pamięci CUDA graphs**. Starsze wpisy (`08-29`)
podawały 8,24 GiB i 226 341 tokenów. Pojemność cache zależy od profilowania
danego uruchomienia; starszej wartości nie należy traktować jako stałej.

Preemption oznacza wstrzymanie sekwencji przez scheduler, gdy brakuje
miejsca w KV cache, i zwolnienie jej bloków cache. W trybie `RECOMPUTE`
vLLM później odtwarza potrzebny stan przez ponowne przeliczenie kontekstu.
Request może się zakończyć poprawnie, ale zajmuje więcej czasu i obliczeń.
To co innego niż CUDA OOM, które może przerwać pracę silnika.
Źródło: [preemption w vLLM](https://docs.vllm.ai/en/v0.25.0/configuration/optimization/#preemption).

Odczyt `/metrics` podczas sprawdzania serwera pokazał
`vllm:num_preemptions_total=0`, zero aktywnych i oczekujących requestów
oraz zerowe wykorzystanie KV cache. Licznik dotyczy bieżącego procesu;
odczyt podczas bezczynności nie zastępuje testu pod obciążeniem.

| Ustawienie | Budżet vLLM | Zapas poza budżetem |
|---|---:|---:|
| `0.90` — poprzednie | 28,66 GiB | 3,18 GiB |
| `0.92` — obecne | 29,30 GiB | 2,55 GiB |

Zmiana na `0.92` dodałaby około **0,64 GiB** budżetu. Przy niezmienionym
wyniku profilowania pozostałych alokacji KV cache mógłby wzrosnąć z 8,78
do około **9,42 GiB**, czyli o około **7%**. To oszacowanie, nie wynik
testu `0.92`. Taką zmianę należy zweryfikować benchmarkiem mieszanego
obciążenia; wcześniejsze OOM przy `0.94` dotyczyły dodatkowej pamięci MoE.
Powyższe odczyty wykonano przed zmianą konfiguracji. Wynik uruchomienia
z `0.92` zapisano osobno poniżej.

### Pomiary po zmianie na `0.92` — 15 września 2026

Nowe logi startowe potwierdzają:

| Składnik | Wartość |
|---|---:|
| Budżet vLLM | około 29,30 GiB |
| Załadowany model razem z MTP | 17,64 GiB |
| KV cache | **9,41 GiB** |
| Pojemność KV cache | **258 472 tokeny** |
| Szacowana pamięć CUDA graphs | 0,44 GiB |

W porównaniu z poprzednim uruchomieniem (`0.90`, 241 245 tokenów)
pojemność wzrosła o **17 227 tokenów, czyli około 7,1%**. Wartość 0,44 GiB
CUDA graphs jest częścią innych alokacji wewnątrz budżetu — nie należy
odejmować jej ponownie po uwzględnieniu całej pamięci poza modelami i cache.

Weryfikacja po restarcie:

- kontener `ik-llama`: `running/healthy`, zero restartów;
- zmienna w działającym kontenerze: `ON_PREM_VLLM_GPU_MEMORY_UTILIZATION=0.92`;
- uwierzytelnione `/v1/chat/completions`: HTTP 200, odpowiedź `ready`;
- publiczne `https://model.leads.run/health`: HTTP 200;
- jeden przebieg benchmarku syntetycznych requestów, do 64 równoległych
  sekwencji, bez błędów requestów, parsowania, preemption ani CUDA OOM;
- limit mocy pozostał na poziomie 450 W.

| Faza | Czas | Łączna szybkość generowania |
|---|---:|---:|
| Prefilter | 4,799 s | 3786,8 tokenów/s |
| Sieve | 73,154 s | 783,6 tokenów/s |
| Mixed | 37,533 s | 1002,0 tokenów/s |

Wynik JSON zapisano lokalnie i na serwerze pod
`benchmark-results/g92-20260915/result.json` (katalog ignorowany przez Git).
Jest to pojedynczy przebieg kontrolny, a nie długotrwały test stabilności
ani kontrolowane porównanie szybkości z `0.90`.

Po benchmarku `nvidia-smi` pokazało **1476 MiB wolnej pamięci**, czyli około
**1,44 GiB**, oraz 30634 MiB zajętej. Pokazuje to różnicę między budżetowym
zapasem 2,55 GiB a faktycznie wolną pamięcią w danej chwili: dodatkowe
alokacje i rezerwacje mogą korzystać z zapasu. `0.92` nie gwarantuje
utrzymywania dokładnie 8% fizycznie wolnego VRAM podczas pracy.

## 4. Backend uwagi: co oblicza i czego używamy

Attention (uwaga) pozwala modelowi korzystać z informacji o innych tokenach
kontekstu. Backend uwagi to implementacja tych obliczeń na GPU, np.
`TRITON_ATTN`, `FLASH_ATTN` lub `FLASHINFER`. Wybór może wpływać na czas
przetwarzania promptu, generowania oraz zużycie pamięci roboczej.

Ogólny mechanizm vLLM sprawdza backendy według listy priorytetów i wybiera
pierwszy zgodny z GPU, typami danych i konfiguracją modelu. Nie wykonuje
przy starcie benchmarku wszystkich backendów na naszych requestach.
Ręczne `--attention-backend FLASHINFER` wskazuje konkretną implementację;
niezgodna konfiguracja może zostać odrzucona błędem.
Źródło: [wybór i zgodność backendów](https://docs.vllm.ai/en/v0.25.0/design/attention_backends/#backend-selection-behavior).

### Nasza Gemma ma dodatkową regułę wyboru

Kontrola serwera 15 września 2026 potwierdziła log:

```text
Gemma4 model has heterogeneous head dimensions (head_dim=256, global_head_dim=512). FA4 not available, forcing TRITON_ATTN backend.
```

Warstwy uwagi lokalnej i pełnej używają różnych wymiarów głów: 256 i 512.
W tej sytuacji kod obsługi Gemmy preferuje jednolitą ścieżkę FA4, jeśli
jest dostępna. Przy jej braku i bez ręcznego wyboru backendu ustawia Triton.
W naszym uruchomieniu nastąpiła właśnie ta druga sytuacja. Asystent MTP
dziedziczy wybór backendu głównego modelu.
Źródło: [Gemma4Config](https://docs.vllm.ai/en/v0.25.0/api/vllm/model_executor/models/config/#vllm.model_executor.models.config.Gemma4Config)
oraz odczyt zainstalowanego `vllm/v1/spec_decode/gemma4.py`.

| Rodzaj obliczeń | Backend na serwerze |
|---|---|
| Uwaga — operacje na kontekście i KV cache | **`TRITON_ATTN`** |
| MoE — obliczenia ekspertów na wagach NVFP4 | **`FLASHINFER_CUTLASS`** |

To osobne wybory. Używanie FlashInfer do MoE nie oznacza używania go
do uwagi. `TRITON_ATTN` działa również na NVIDIA; nie jest ograniczony do AMD.

### Czy porównywaliśmy backendy uwagi?

W dostępnych skryptach i wynikach nie znaleziono benchmarku porównującego
`TRITON_ATTN`, `FLASH_ATTN` i `FLASHINFER` dla tej konfiguracji. Ostatni
benchmark `0.92` działał na Tritonie. Wcześniejsze opisane eksperymenty
dotyczyły m.in. schedulera i formatów KV cache; nie stanowią takiego porównania.

Samo dopisanie `FLASH_ATTN` nie zapewnia zgodności: zainstalowany backend
akceptuje KV cache `fp8` na CUDA tylko dla ścieżki FA3 na SM90, podczas gdy
RTX 5090 to SM120. FlashInfer wymaga osobnego sprawdzenia całej konfiguracji,
w tym warstw Gemmy i MTP, a następnie benchmarku poprawności i wydajności.
Podczas tej kontroli nie zmieniano backendu ani nie restartowano modelu.
