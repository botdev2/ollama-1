FROM ollama/ollama:latest

USER root

ADD https://nodejs.org/dist/v22.21.0/node-v22.21.0-linux-x64.tar.gz /tmp/node.tar.gz
RUN tar -xzf /tmp/node.tar.gz -C /usr/local --strip-components=1 && rm /tmp/node.tar.gz

WORKDIR /srv
COPY server.mjs start.sh /srv/
RUN sed -i 's/\r$//' /srv/start.sh && chmod +x /srv/start.sh

ENV PORT=3000 \
    MAX_USERS=5 \
    INSTANCE_NAME="Ollama #1" \
    OLLAMA_BASE=http://127.0.0.1:11434

EXPOSE 3000
ENTRYPOINT ["/srv/start.sh"]
