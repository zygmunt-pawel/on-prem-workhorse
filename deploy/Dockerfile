FROM nvidia/cuda:13.2.0-devel-ubuntu24.04 AS builder

RUN apt-get update && apt-get install -y \
    git cmake build-essential curl \
    && rm -rf /var/lib/apt/lists/*

ARG IK_LLAMA_REPO=https://github.com/ikawrakow/ik_llama.cpp.git
ARG IK_LLAMA_BRANCH=main
ARG CUDA_ARCH=120

RUN git clone --depth 1 -b ${IK_LLAMA_BRANCH} ${IK_LLAMA_REPO} /build/ik_llama.cpp

WORKDIR /build/ik_llama.cpp

RUN cmake -B build \
    -DGGML_CUDA=ON \
    -DCMAKE_CUDA_ARCHITECTURES=${CUDA_ARCH} \
    -DCMAKE_BUILD_TYPE=Release \
    -DLLAMA_CURL=OFF \
    -DCMAKE_EXE_LINKER_FLAGS="-L/usr/local/cuda/lib64/stubs -lcuda" \
    && cmake --build build --target llama-server -j$(nproc)

FROM nvidia/cuda:13.2.0-runtime-ubuntu24.04

RUN apt-get update && apt-get install -y \
    libgomp1 curl \
    && rm -rf /var/lib/apt/lists/*

COPY --from=builder /build/ik_llama.cpp/build/bin/llama-server /usr/local/bin/llama-server
COPY entrypoint.sh /usr/local/bin/entrypoint.sh

EXPOSE 8090

ENTRYPOINT ["entrypoint.sh"]
