# Jak vLLM korzysta z pamięci GPU — krok po kroku

Kiedy wysyłasz prompt, vLLM musi zmieścić na GPU model, dane potrzebne do
obliczeń i zapamiętany kontekst zapytań. Od tego podziału zależy, ile pracy
może wykonywać równocześnie.

Przejdźmy przez ten mechanizm na przykładzie **RTX 5090, vLLM 0.29 i Gemmy 4
26B-A4B NVFP4 z asystentem MTP**. Przy każdym ustawieniu wyjaśniamy, na co
wpływa i jaką wartość przyjmujemy w naszym wdrożeniu.

## 1. Zaczynamy od całej pamięci karty

GPU ma własną pamięć, czyli **VRAM**. To w niej podczas generowania znajdują
się wagi modelu i dane używane przez jego obliczenia.

Nasz RTX 5090 raportuje **32 607 MiB**, czyli około **31,84 GiB**. To punkt
wyjścia do rachunku. MiB i GiB są jednostkami pamięci; 1024 MiB to 1 GiB.

vLLM dostaje określony udział tej pojemności. Ustawienie
**`gpu_memory_utilization` ma u nas domyślną wartość `0.92` i tak je zostawiamy**.
Oznacza budżet równy 92% całkowitej pamięci GPU:

```text
31,84 GiB × 0,92 ≈ 29,30 GiB dla vLLM
31,84 GiB × 0,08 ≈  2,55 GiB poza tym budżetem
```

Te **29,30 GiB** trzeba teraz podzielić między kilka składników. Parametr
obejmuje budżet pamięci, a GPU nadal może wykonywać obliczenia z pełnym
wykorzystaniem swoich jednostek obliczeniowych.

Zapas poza budżetem pozostawia miejsce na dodatkowe alokacje podczas pracy.
Odczyt wolnej pamięci może się zmieniać: `0.92` nie oznacza utrzymywania
przez cały czas dokładnie 8% fizycznie wolnego VRAM.

## 2. Najpierw w pamięci muszą znaleźć się wagi modelu

**Wagi** to wyuczone parametry modelu. Są potrzebne przy każdym przetwarzanym
tokenie — fragmencie tekstu, na którym operuje model.

Pracują tu dwa modele:

- **Model główny: Gemma 4 26B-A4B NVFP4.** Przetwarza kontekst i wyznacza
  odpowiedź. Format NVFP4 zapisuje wiele jego wag w zwartej, czterobitowej
  reprezentacji, zmniejszając ich zapotrzebowanie na pamięć.
- **Asystent MTP: Gemma 4 26B-A4B IT Assistant.** Proponuje kolejne tokeny
  odpowiedzi do weryfikacji przez model główny. Używamy go z ustawieniem
  `num_speculative_tokens=4`.

Razem ich załadowanie zajmuje tutaj około **17,64 GiB pamięci GPU**.

Po odjęciu tego od budżetu zostaje:

```text
29,30 GiB − 17,64 GiB = około 11,66 GiB
```

Ta pozostała część posłuży do wykonywania obliczeń i przechowywania kontekstów.

**Wszystkie zapytania korzystają z tych samych wag.** Jeśli obsługujemy
20 zapytań równocześnie, model jest załadowany raz. To przede wszystkim
konteksty zapytań i dane robocze zwiększają zapotrzebowanie na pamięć.

## 3. Same obliczenia też potrzebują miejsca

Model podczas pracy tworzy wyniki pośrednie. Potrzebuje też buforów używanych
przez operacje na GPU. Dochodzi do tego pamięć związana z **CUDA graphs**:
zapisanymi sekwencjami operacji, które można ponownie uruchamiać z mniejszym
narzutem sterowania.

Dlatego vLLM przy starcie **profiluje zużycie pamięci**: ustala, ile miejsca
potrzebuje działający model, i dopiero na tej podstawie dobiera pulę KV cache.
Przy `gpu_memory_utilization=0.92` pozwalamy mu zrobić ten przydział automatycznie.

Dla naszej konfiguracji orientacyjny podział budżetu wygląda tak:

| Część budżetu vLLM | Pamięć |
|---|---:|
| Załadowane modele, łącznie z MTP | 17,64 GiB |
| Pozostałe alokacje i rezerwy uwzględnione w przydziale | około 2,80 GiB |
| KV cache | około 8,86 GiB |
| **Razem** | **około 29,30 GiB** |

To przybliżony rachunek dla startu z zapisaną kompilacją. Faktyczny przydział
KV danego uruchomienia vLLM wypisuje w logach jako `Available KV cache memory`.

Cache kompilacji znajduje się na dysku i pomaga szybciej uruchomić silnik.
KV cache, któremu przyjrzymy się teraz, znajduje się w VRAM i służy do
przetwarzania kontekstów zapytań.

## 4. Co model zapamiętuje w KV cache?

Generowanie odpowiedzi składa się z dwóch głównych etapów:

1. **Prefill:** model przetwarza tokeny promptu.
2. **Decode:** model generuje dalsze tokeny odpowiedzi, korzystając z kontekstu.

W mechanizmie uwagi (*attention*) model oblicza dla tokenów m.in.
reprezentacje nazywane **keys** i **values**, czyli K i V. Następne tokeny
korzystają z tych reprezentacji, aby uwzględnić wcześniejszy kontekst.
**KV cache przechowuje je do ponownego użycia.**

Wyobraź sobie prompt długości 10 000 tokenów. Po jego przetworzeniu model
zaczyna odpowiedź. Przy generowaniu kolejnych tokenów korzysta z zapisanych
K i V promptu, zamiast za każdym razem odtwarzać je od początku. W miarę
generowania cache uwzględnia także tokeny odpowiedzi.

Z tego wynikają dwa praktyczne związki:

- dłuższe konteksty potrzebują więcej miejsca na zapamiętany stan;
- więcej równoczesnych zapytań oznacza więcej kontekstów do utrzymania.

Dokładny koszt zależy także od architektury modelu. Nasza Gemma łączy warstwy
pełnej uwagi z warstwami uwagi lokalnej, korzystającymi z ograniczonego okna
kontekstu. Dlatego rozmiaru całej puli nie przeliczamy prostym założeniem,
że każda warstwa zawsze przechowuje całą historię każdego zapytania.

## 5. Dlaczego ustawiamy KV cache na FP8?

**FP8** to ośmiobitowy format liczb. Ustawienie `kv_cache_dtype=fp8`
pozwala zapisywać K i V w bardziej zwartej postaci. Dzięki temu w danej
puli pamięci mieści się więcej stanu niż przy zapisie szesnastobitowym.

Format KV cache jest osobnym wyborem od formatu wag modelu. W naszej
konfiguracji **NVFP4 dotyczy wag**, a **FP8 dotyczy KV cache**. Nie są to
dwie nazwy tego samego ustawienia.

Zostawiamy FP8 dla wszystkich warstw uwagi. Lista warstw pomijanych przy
tej kwantyzacji pozostaje pusta.

## 6. Jak ta pamięć przekłada się na liczbę zapytań?

vLLM zarządza KV cache w blokach. Przydziela je kontekstom według potrzeb,
zamiast od razu rezerwować pełny maksymalny kontekst dla każdego zapytania.

Warto rozróżnić dwa limity:

**`max_model_len=32768`** określa maksymalną długość jednej sekwencji.
W tym limicie muszą zmieścić się wejście i generowana odpowiedź. Na przykład
prompt o długości 12 000 tokenów z odpowiedzią do 2000 tokenów potrzebuje
łącznie do 14 000 tokenów kontekstu.

**`max_num_seqs=80`** określa górny limit sekwencji obsługiwanych równocześnie.
Scheduler — część vLLM rozdzielająca pracę — bierze pod uwagę również dostępną
pamięć. Krótkich kontekstów może zmieścić się więcej niż długich.

Dlatego tych wartości nie mnożymy jako obietnicy pojemności. `80 × 32768`
nie oznacza, że tyle tokenów kontekstu zostało z góry zarezerwowanych na GPU.
Zapytania, dla których nie ma jeszcze miejsca lub budżetu pracy, czekają
w kolejce.

## 7. Co oznacza batch 8192 i jak vLLM łączy pracę?

**`max_num_batched_tokens=8192`** to budżet tokenów przetwarzanych w jednej
iteracji schedulera. Określa wielkość porcji pracy trafiającej do modelu.

Prompt może być dłuższy niż 8192 tokeny. Dzięki **chunked prefill** vLLM
dzieli jego przetwarzanie na części. W kolejnych iteracjach może łączyć pracę
nad promptami z generowaniem odpowiedzi na inne zapytania.

Zapytania nie muszą zaczynać się i kończyć razem. Kiedy jedno się kończy,
scheduler może dopuścić następne. To **continuous batching**: skład grupy
obsługiwanych zapytań zmienia się w trakcie pracy.

U nas pozostawiamy budżet **8192 tokenów**. Włączony asynchroniczny scheduler
pozwala przygotowywać kolejne zadania z nakładaniem części pracy CPU i GPU,
żeby ograniczać przerwy pomiędzy obliczeniami.

### A jeśli zapytania mają wspólny początek?

Załóżmy, że wysyłasz wiele zapytań z tą samą długą instrukcją, a dopiero po
niej umieszczasz inne dane. **Prefix caching** pozwala wykorzystać zapisany
stan zgodnych bloków początku promptu w kolejnych zapytaniach.

Wspólne bloki mogą być współdzielone, a ich obliczeń nie trzeba za każdym
razem wykonywać od nowa. Warunkiem jest zgodny początek sekwencji tokenów
oraz dostępność tych bloków w cache. Podobne znaczenie instrukcji nie wystarcza:
zmiana początku promptu zmienia także możliwość jego ponownego wykorzystania.

Dlatego stałe instrukcje warto umieszczać przed zmiennymi danymi. W naszym
wdrożeniu prefix caching jest włączony.

## 8. Kto wykonuje te obliczenia na GPU?

Podział pracy ustala scheduler, natomiast **Model Runner V2**, w skrócie
**MRV2**, przygotowuje i wykonuje przebiegi modelu na GPU. Korzysta przy tym
z konkretnych implementacji operacji, nazywanych backendami.

**Triton attention (`TRITON_ATTN`)** wykonuje obliczenia uwagi, czyli korzystanie
z informacji zawartych w kontekście i KV cache.

**FlashInfer CUTLASS (`flashinfer_cutlass`)** obsługuje operacje MoE dla naszych
wag NVFP4. MoE to model z wieloma zestawami parametrów zwanymi ekspertami;
dla danego tokenu wybierana jest część z nich.

Te backendy wykonują różne części pracy i działają razem. Wybieramy więc
**MRV2 + Triton attention + FlashInfer CUTLASS MoE**.

## 9. Jak MTP przyspiesza generowanie odpowiedzi?

Zwykłe generowanie dopisuje kolejne tokeny na podstawie dotychczasowego
kontekstu. **MTP** wykorzystuje asystenta, który proponuje kilka następnych
tokenów, a model główny weryfikuje propozycję.

Ustawiamy **cztery tokeny spekulacyjne**. Jeśli propozycje zostaną zaakceptowane,
jedna weryfikacja pozwala posunąć odpowiedź o kilka tokenów do przodu.
Odrzucone propozycje są korygowane zgodnie z wynikiem modelu głównego.

Liczba cztery określa długość propozycji. Nie oznacza gwarantowanego
czterokrotnego przyspieszenia: propozycje też trzeba obliczyć, a nie każda
zostanie przyjęta w całości. Asystent zajmuje część pamięci GPU — jego koszt
jest już uwzględniony w opisanym wcześniej ładowaniu modeli.

## 10. Złóżmy to w przebieg jednego zapytania

Wysyłasz 12 000 tokenów wejścia i przewidujesz odpowiedź do 2000 tokenów.

1. **Limit kontekstu:** do 14 000 tokenów mieści się w `max_model_len=32768`.
2. **Przyjęcie do pracy:** scheduler uwzględnia limit 80 sekwencji i dostępne
   bloki KV cache. W razie potrzeby zapytanie czeka na swoją kolej.
3. **Prefill:** wspólny początek może skorzystać z prefix cache. Pozostałe
   tokeny są przetwarzane w porcjach mieszczących się w budżecie iteracji 8192.
4. **Decode:** model korzysta z KV cache w formacie FP8. Asystent MTP proponuje
   po cztery tokeny, które weryfikuje model główny.
5. **Zakończenie:** zapytanie oddaje zajęte miejsce w grupie aktywnych sekwencji.
   Bloki KV mogą zostać ponownie wykorzystane; zachowane prefiksy mogą przydać
   się następnym zapytaniom.

Cały ten proces odbywa się w budżecie wynikającym z **`gpu_memory_utilization=0.92`**.
Osobno host utrzymuje limit mocy **450 W** — ten parametr dotyczy poboru
energii GPU, a nie podziału VRAM.

W ten sposób ustawienia tworzą jedną całość: budżet pamięci mieści model
i konteksty, scheduler dzieli pracę, backendy wykonują obliczenia, a MTP
pozwala sprawniej dopisywać odpowiedź.
