ARG VLLM_IMAGE=vllm/vllm-openai:v0.29.0@sha256:c2914767605584b6d8f45686b82de173ecc99e781897aa3d0a66dacd72c51ae1
FROM ${VLLM_IMAGE}

# vLLM 0.29 includes the Gemma 4 assistant compatibility fix upstream.
COPY entrypoint.sh /usr/local/bin/on-prem-vllm
RUN chmod 0755 /usr/local/bin/on-prem-vllm

ENTRYPOINT ["/usr/local/bin/on-prem-vllm"]
