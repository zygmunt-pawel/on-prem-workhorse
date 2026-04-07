# Official llama.cpp with CUDA 13.0 + sm_89 (Ada PTX fallback for RTX 5090)
# Native sm_120 Blackwell kernels are broken due to nvcc O3 optimizer bug
# (https://github.com/ggml-org/llama.cpp/issues/18331)
# When NVIDIA fixes this, change CUDA_ARCH from 89 to 120 for ~30% faster prompt processing
FROM nvidia/cuda:13.0.0-devel-ubuntu24.04 AS builder

RUN apt-get update && apt-get install -y \
    git cmake build-essential curl \
    && rm -rf /var/lib/apt/lists/*

ARG LLAMA_REPO=https://github.com/ggml-org/llama.cpp.git
ARG LLAMA_BRANCH=master
ARG CUDA_ARCH=89

RUN git clone --depth 1 -b ${LLAMA_BRANCH} ${LLAMA_REPO} /build/llama.cpp

WORKDIR /build/llama.cpp

RUN cmake -B build \
    -DGGML_CUDA=ON \
    -DCMAKE_CUDA_ARCHITECTURES=${CUDA_ARCH} \
    -DGGML_CUDA_FORCE_CUBLAS=OFF \
    -DCMAKE_BUILD_TYPE=Release \
    -DLLAMA_CURL=OFF \
    -DCMAKE_EXE_LINKER_FLAGS="-L/usr/local/cuda/lib64/stubs -lcuda" \
    && cmake --build build --target llama-server -j$(nproc)

FROM nvidia/cuda:13.0.0-runtime-ubuntu24.04

RUN apt-get update && apt-get install -y \
    libgomp1 curl \
    && rm -rf /var/lib/apt/lists/*

COPY --from=builder /build/llama.cpp/build/bin/llama-server /usr/local/bin/llama-server
RUN --mount=from=builder,source=/build/llama.cpp/build,target=/tmp/build \
    find /tmp/build -name '*.so' -exec cp {} /usr/local/lib/ \; && ldconfig
COPY entrypoint.sh /usr/local/bin/entrypoint.sh

EXPOSE 8090

ENTRYPOINT ["entrypoint.sh"]
