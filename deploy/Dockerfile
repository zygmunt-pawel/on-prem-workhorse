# Official llama.cpp with a configurable CUDA toolkit + GPU arch.
# Defaults target the RTX 5090 box: CUDA 13.0, sm_89 (Ada PTX fallback — native
# sm_120 Blackwell kernels are broken by an nvcc O3 optimizer bug,
# https://github.com/ggml-org/llama.cpp/issues/18331; when fixed, set CUDA_ARCH=120
# for ~30% faster prompt processing).
# Override both args for other GPUs — e.g. the RTX 3090 box, whose driver 570
# caps at CUDA 12.8, so a 13.0 image would fail to init: CUDA_TAG=12.8.0, CUDA_ARCH=86.
ARG CUDA_TAG=13.0.0
FROM nvidia/cuda:${CUDA_TAG}-devel-ubuntu24.04 AS builder

RUN apt-get update && apt-get install -y \
    git cmake build-essential curl \
    && rm -rf /var/lib/apt/lists/*

ARG LLAMA_REPO=https://github.com/ggml-org/llama.cpp.git
ARG LLAMA_BRANCH=master
ARG CUDA_ARCH=89
ARG BUILD_JOBS=    # empty -> use all cores; set lower on RAM-tight boxes (3090: 15 GB) to avoid OOM

RUN git clone --depth 1 -b ${LLAMA_BRANCH} ${LLAMA_REPO} /build/llama.cpp

WORKDIR /build/llama.cpp

RUN cmake -B build \
    -DGGML_CUDA=ON \
    -DCMAKE_CUDA_ARCHITECTURES=${CUDA_ARCH} \
    -DGGML_CUDA_FORCE_CUBLAS=OFF \
    -DCMAKE_BUILD_TYPE=Release \
    -DLLAMA_CURL=OFF \
    -DCMAKE_EXE_LINKER_FLAGS="-L/usr/local/cuda/lib64/stubs -lcuda" \
    && cmake --build build --target llama-server -j${BUILD_JOBS:-$(nproc)}

FROM nvidia/cuda:${CUDA_TAG}-runtime-ubuntu24.04

RUN apt-get update && apt-get install -y \
    libgomp1 curl \
    && rm -rf /var/lib/apt/lists/*

COPY --from=builder /build/llama.cpp/build/bin/llama-server /usr/local/bin/llama-server
RUN --mount=from=builder,source=/build/llama.cpp/build,target=/tmp/build \
    find /tmp/build -name '*.so' -exec cp {} /usr/local/lib/ \; && ldconfig
COPY entrypoint.sh /usr/local/bin/entrypoint.sh

EXPOSE 8090

ENTRYPOINT ["entrypoint.sh"]
