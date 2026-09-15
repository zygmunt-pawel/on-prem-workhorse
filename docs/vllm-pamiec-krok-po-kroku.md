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

Żeby sprawdzić pojemność i bieżące wykorzystanie pamięci karty, uruchom
na komputerze z GPU:

```bash
nvidia-smi --query-gpu=name,memory.total,memory.used,memory.free --format=csv
```

Wynik zawiera:

- `name` — nazwę karty;
- `memory.total` — całkowitą pojemność pamięci GPU;
- `memory.used` — aktualnie zajętą pamięć;
- `memory.free` — aktualnie wolną pamięć.

**Do obliczenia budżetu vLLM bierzemy `memory.total`.** Ilość wolnej pamięci
zmienia się podczas pracy, więc nie jest podstawą tego rachunku.

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
| KV cache — wspólna pula na konteksty sekwencji | około 8,86 GiB |
| **Razem** | **około 29,30 GiB** |

**Mamy więc około 8,86 GiB wspólnej puli na stan sekwencji: ich prompty
oraz wygenerowane tokeny odpowiedzi.** Są to reprezentacje K i V używane
przez uwagę. Każda obsługiwana sekwencja korzysta z potrzebnych jej bloków
tej puli, a jej kontekst rośnie podczas generowania.

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

**Sekwencja to jeden kontekst generowania: prompt wraz z dopisywaną
odpowiedzią.** Przy jednym prompcie i jednej generowanej odpowiedzi zapytanie
odpowiada jednej sekwencji. Jedno żądanie API zawierające wiele promptów może
uruchamiać wiele sekwencji.

### Jedno żądanie z listą promptów czy wiele żądań?

Dla `/v1/completions`, przy jednej odpowiedzi na prompt (`n=1`), oba sposoby
dostarczają modelowi 64 sekwencje:

| Sposób wysłania | Liczba sekwencji |
|---|---:|
| Jedno żądanie HTTP z listą 64 promptów | 64 |
| 64 równoległe żądania HTTP, każde z jednym promptem | 64 |
| 8 równoległych żądań HTTP, każde z 8 promptami | 64 |

vLLM rozdziela listę promptów na osobne zadania generowania i może łączyć
je w pracy schedulera tak samo jak sekwencje z różnych żądań. Samo wspólne
opakowanie HTTP nie tworzy jednego dużego kontekstu ani nie scala odpowiedzi.
Lista wiadomości `messages` w zwykłym `/v1/chat/completions` oznacza natomiast
historię jednej rozmowy, a nie listę niezależnych promptów.

Przy odpowiedzi bez streamingu jedno żądanie z 64 promptami zwraca wynik,
gdy zakończą się wszystkie jego sekwencje. Przy 64 osobnych żądaniach każdą
odpowiedź można odebrać oddzielnie i od razu wysłać następne zadanie.

### `--max-num-seqs 80`: ile sekwencji może pracować równocześnie

Przy uruchamianiu vLLM podajemy **`--max-num-seqs 80`**. Nazwa tego samego
ustawienia w konfiguracji to `max_num_seqs`.

To górny limit liczby sekwencji obsługiwanych w jednej iteracji schedulera.
Scheduler — część vLLM rozdzielająca pracę — musi jednocześnie zmieścić ich
stan w dostępnej puli KV cache i przestrzegać budżetu tokenów danej iteracji.

**Te 80 sekwencji współdzieli około 8,86 GiB KV cache.** Nie dostają po
8,86 GiB każda, a pula nie jest też dzielona na 80 równych, stałych części.
Bloki są przydzielane według potrzeb kontekstów; zgodne prefiksy mogą być
współdzielone.

Dlatego krótkich kontekstów może pracować równocześnie więcej niż długich.
Limit 80 dopuszcza taką równoległość, ale nie gwarantuje, że dowolne
80 zapytań zmieści się naraz. Pozostałe zapytania czekają w kolejce.
**W naszej konfiguracji pozostawiamy `--max-num-seqs 80`.**

Nie oznacza to obowiązku wysyłania paczek po 80 promptów. Można wysłać
80 promptów w jednym żądaniu lub utrzymywać 80 pojedynczych żądań w toku.
Mniejsza liczba również może dobrze wykorzystywać GPU. Przy ciągłym strumieniu
zadań klient uzupełnia swoją pulę: po odebraniu wyniku wysyła kolejne zadanie,
zachowując wybrany limit równoległości.

### Jak dobierać liczbę aktywnych sekwencji?

Punktem wyjścia jest oszacowanie:

```text
liczba sekwencji ≈ dostępna pamięć KV / koszt KV jednej sekwencji
```

Koszt obejmuje prompt i miejsce na rosnącą odpowiedź. Warto uwzględniać
również dłuższe typowe zadania, ponieważ sama średnia nie chroni przed
chwilą, w której jednocześnie trafi wiele długich kontekstów.

W Gemmie część warstw przechowuje cały kontekst, a część tylko przesuwające
się okno. Ponadto zgodne prefiksy mogą dzielić bloki. Dlatego proste mnożenie
średniej liczby tokenów przez liczbę sekwencji daje jedynie orientację.

Limit dobieramy, obserwując przepustowość, opóźnienia i wykorzystanie KV
pod typowym obciążeniem. Wypieranie aktywnych zadań z cache (*preemption*)
oznacza dodatkową pracę przy późniejszym odtworzeniu ich stanu. Większy limit
ma sens, jeśli poprawia przepustowość bez nadmiernego kosztu takiego odtwarzania.

### `--max-model-len 32768`: jak długa może być jedna sekwencja

Drugi parametr startowy, **`--max-model-len 32768`**, określa maksymalną
łączną długość promptu i odpowiedzi dla jednej sekwencji.

Na przykład prompt o długości 12 000 tokenów z odpowiedzią do 2000 tokenów
potrzebuje łącznie do **14 000 tokenów kontekstu**. Mieści się w limicie
32 768. W miarę dopisywania odpowiedzi powiększa się stan tej sekwencji
utrzymywany w KV cache, zgodnie z budową warstw uwagi modelu.

Dla wielu takich sekwencji trzeba zmieścić ich wspólny koszt pamięciowy
w puli około 8,86 GiB. Dlatego `80 × 32768` nie jest pojemnością naszego
cache: jeden parametr ogranicza liczbę sekwencji, drugi długość każdej,
a dostępna pamięć ogranicza ich faktyczną równoczesną obsługę.

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

### Kto wybiera, która część promptu trafia do cache?

**vLLM robi to automatycznie, na poziomie bloków tokenów.** Nie wpisujemy
w treści promptu znacznika „cache do tego miejsca”. Serwer sprawdza, które
pełne bloki początku sekwencji odpowiadają już obliczonym i dostępnym blokom.

Na możliwość ponownego użycia wpływamy układem promptu. Przykład:

```text
[stałe instrukcje]
[stały opis projektu]
[zmienny post do oceny]
```

Dwa posty dotyczące tego samego projektu mogą współdzielić stan instrukcji
i opisu projektu. Jeśli umieścimy unikalny identyfikator przed instrukcjami,
początki promptów szybko przestaną być zgodne. Identyczny tekst występujący
dopiero po różniącym się fragmencie nie odzyskuje zgodności prefiksu: wynik
uwagi zależy również od wcześniejszego kontekstu.

Granica ponownego użycia wynika więc ze zgodności tokenów, granic bloków
i dostępności zapisanych danych. Współdzielenie może działać również między
osobnymi żądaniami HTTP. W modelu z różnymi rodzajami uwagi, takim jak
Gemma, muszą być dostępne dane wymagane przez każdą grupę warstw. Samo
wcześniejsze wysłanie długiego promptu nie gwarantuje więc zachowania każdego
jego prefiksu do późniejszego użycia.

Prefix caching przyspiesza przetwarzanie wspólnego
wejścia; odpowiedź na nowe zapytanie nadal wymaga generowania.

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
