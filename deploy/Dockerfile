# Legacy llama.cpp image with a configurable CUDA toolkit + GPU arch.
# The primary RTX 5090 deployment now uses deploy/vllm; this image remains for
# the RTX 3090 stack. Its driver 570 caps at CUDA 12.8, so that compose file
# overrides the defaults with CUDA_TAG=12.8.0 and CUDA_ARCH=86.
ARG CUDA_TAG=13.0.0
FROM nvidia/cuda:${CUDA_TAG}-devel-ubuntu24.04 AS builder

RUN apt-get update && apt-get install -y \
    git cmake build-essential curl \
    && rm -rf /var/lib/apt/lists/*

ARG LLAMA_REPO=https://github.com/ggml-org/llama.cpp.git
ARG LLAMA_BRANCH=master
ARG LLAMA_COMMIT=
ARG CUDA_ARCH=89
ARG BUILD_JOBS=    # empty -> use all cores; set lower on RAM-tight boxes (3090: 15 GB) to avoid OOM

RUN git init /build/llama.cpp \
    && cd /build/llama.cpp \
    && git remote add origin ${LLAMA_REPO} \
    && if [ -n "${LLAMA_COMMIT}" ]; then \
         git fetch --depth 1 origin ${LLAMA_COMMIT}; \
       else \
         git fetch --depth 1 origin ${LLAMA_BRANCH}; \
       fi \
    && git checkout --detach FETCH_HEAD

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
