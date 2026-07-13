ARG VLLM_IMAGE=vllm/vllm-openai:v0.25.0
FROM ${VLLM_IMAGE}

# vLLM 0.25.0 rejects the official Gemma 4 assistant's intentionally
# draft-width tied embedding before Gemma4MTP can replace its input embedding
# with the target-width tensor. Keep the fix local and auditable until it is
# available upstream.
COPY llm_base_proposer.patch /tmp/llm_base_proposer.patch
RUN cd /usr/local/lib/python3.12/dist-packages/vllm/v1/spec_decode \
    && patch --batch --forward llm_base_proposer.py \
       < /tmp/llm_base_proposer.patch \
    && python3 -m py_compile llm_base_proposer.py \
    && rm /tmp/llm_base_proposer.patch
