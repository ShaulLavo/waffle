FROM docker.io/library/node@sha256:9d09a088be40a970e2b690a9fb13ad69a0fc529d7b98e9be6a11ba1e9176f0a1 AS dependencies
ARG SOURCE_COMMIT
ARG RELEASE_VERSION
WORKDIR /app
COPY package.json package-lock.json relay.json source-inputs.json SHA256SUMS ./
COPY assets ./assets
RUN sha256sum --check SHA256SUMS \
    && node --input-type=module -e 'import assert from "node:assert/strict"; import {readFileSync} from "node:fs"; const input=JSON.parse(readFileSync("source-inputs.json")); assert.match(process.env.SOURCE_COMMIT, /^[0-9a-f]{40}$/); assert.equal(input.source, process.env.SOURCE_COMMIT); assert.equal(input.version, process.env.RELEASE_VERSION); assert.equal(process.platform, "linux"); assert.equal(process.arch, "x64");' \
    && npm ci --omit=optional --ignore-scripts --no-audit --no-fund \
    && printf '%s\n' '6340d0f657e37daaf168fe4bd77ad227653df3e3da52c96d1448a98dbfaf4c12  assets/native.tar.gz' | sha256sum --check \
    && tar -xzf assets/native.tar.gz -C node_modules/@fails-components/webtransport-transport-http3-quiche build/Release/webtransport.node \
    && printf '%s\n' '5592208da56aee0f53615b8d8c5d57c99a87618593c6343787ac9f92761daf1d  node_modules/@fails-components/webtransport-transport-http3-quiche/build/Release/webtransport.node' | sha256sum --check \
    && rm -r assets

FROM docker.io/library/node@sha256:9d09a088be40a970e2b690a9fb13ad69a0fc529d7b98e9be6a11ba1e9176f0a1
ARG SOURCE_COMMIT
ARG RELEASE_VERSION
LABEL org.opencontainers.image.source="https://github.com/ShaulLavo/waffle" \
      org.opencontainers.image.revision="$SOURCE_COMMIT" \
      org.opencontainers.image.version="$RELEASE_VERSION"
WORKDIR /app
COPY --from=dependencies /app /app
USER 1000:1000
ENV NODE_ENV=production WAFFLE_RELAY_TMPDIR=/tmp
EXPOSE 8787/tcp 4433/udp
STOPSIGNAL SIGTERM
ENTRYPOINT ["/usr/local/bin/node", "/app/node_modules/waffle-relay/dist/cli.js"]
CMD ["serve", "--config", "/app/relay.json"]
