FROM docker.io/library/node@sha256:9d09a088be40a970e2b690a9fb13ad69a0fc529d7b98e9be6a11ba1e9176f0a1 AS dependencies
WORKDIR /app
COPY package.json package-lock.json ./
COPY assets /assets
RUN printf '%s\n' \
      '874314dbfb2263b5fa5ffc1d04a668440fe0fb2999d50567deee3c46cebb9302  /assets/waffle-0.0.109.tgz' \
      '83e429364a8115f445e3ef8c13d601920f45e007f9b83e054c5e34a07c483538  /assets/waffle-relay-0.0.109.tgz' | sha256sum --check \
    && npm ci --omit=optional --ignore-scripts --no-audit --no-fund \
    && test ! -d node_modules/@fails-components \
    && test -z "$(find node_modules -name '*.node' -print)"

FROM docker.io/library/node@sha256:9d09a088be40a970e2b690a9fb13ad69a0fc529d7b98e9be6a11ba1e9176f0a1
LABEL org.opencontainers.image.source="https://github.com/ShaulLavo/waffle" \
      org.opencontainers.image.revision="5f3d329f35be618e5b4d822c0ee933bbfd9a10f5" \
      org.opencontainers.image.version="0.0.109"
WORKDIR /app
COPY --from=dependencies --chown=1000:1000 /app /app
COPY --chown=1000:1000 relay.json /app/relay.json
USER 1000:1000
ENV NODE_ENV=production
EXPOSE 8787/tcp
ENTRYPOINT ["/usr/local/bin/node", "/app/node_modules/waffle-relay/dist/cli.js"]
CMD ["serve", "--config", "/app/relay.json"]
