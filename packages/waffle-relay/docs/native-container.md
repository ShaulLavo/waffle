# Prepare a native relay container

This is a separate Linux x64 preparation path. It does not change the existing WebSocket-only image, release pins, or publication workflow. Its policy remains deny-all for HTTP and TCP, with no network token issuer. The native context pins a separate Node 26.12.1 Trixie slim base. The existing Bookworm WS base cannot load this exact prebuild because it lacks GLIBC_2.38.

## Supply exact qualified inputs

Obtain the paired runtime and relay archives, their SHA-256 values, and the exact source commit from the release owner. Candidate archives are not public release assets. Do not substitute R1, rebuild its archives, or relabel its image. The source must contain the bind and advertised-address correction. Its Git ancestry through `e81d4808976ed97f5e746150a23b88743f6fb94f` must be available locally; a shallow history fails closed.

Fetch the public `fails-components/webtransport` release asset `webtransport-transport-http3-quiche-v1.6.11-napi-v6-linux-x64.tar.gz` from tag `v1.6.11`. Its SHA-256 is `6340d0f657e37daaf168fe4bd77ad227653df3e3da52c96d1448a98dbfaf4c12`. The extracted `build/Release/webtransport.node` must hash to `5592208da56aee0f53615b8d8c5d57c99a87618593c6343787ac9f92761daf1d`.

From a clean exclusive checkout, with the exact source commit available locally, run:

```sh
node packages/waffle-relay/scripts/prepare-native-container.ts \
	"${RUNTIME_ARCHIVE:?}" "${RUNTIME_SHA256:?}" \
	"${RELAY_ARCHIVE:?}" "${RELAY_SHA256:?}" "${RELEASE_SOURCE:?}" \
	"${NATIVE_PREBUILD:?}" "${NEW_CONTEXT:?}"
```

Use a new, task-owned context under a verified data-drive scratch directory. The helper rejects checksum, version, host-interface and relay-source mismatches. It checks every relay source file against the supplied commit. This check does not prove that compiled exports came from that source. The release owner's qualification and archive custody remain required.

The helper copies the unchanged archives into the context. It resolves an npm lock with lifecycle scripts disabled and the native package pair pinned to `1.6.11`. No repository package metadata changes. It records archive, source, base, addon, lock and config identities. Failed preparation removes its new context. The caller owns successful context cleanup.

## Qualify the actual candidate

Install teardown before building. Record existing images and containers, use unique local names, and remove only resources created by this run. Substantial PC work uses the heavy queue. No registry login, push, dispatch or production update belongs in this step.

Build the generated context with `--platform linux/amd64`, `--build-arg SOURCE_COMMIT="$RELEASE_SOURCE"` and `--build-arg RELEASE_VERSION="$RELEASE_VERSION"`. Read `RELEASE_VERSION` from the helper receipt, not a guessed future tag. Both build arguments must match the receipt. The Dockerfile checks context hashes, installs from the frozen lock without scripts, and checks the native archive and extracted addon before any loader runs. The released native entry independently checks both package versions and addon bytes before importing its loader.

Run `container/native/verify.ts` outside the image through a read-only qualification mount. Use the candidate's Node executable, `--read-only`, `--network none`, and a private `/tmp` tmpfs with at least 16 MiB. Do not publish container ports. The final image runs as UID and GID 1000, with root-owned application files. The native runtime stage installs the OpenSSL command-line utility. Record its actual package version with the qualification receipts. The verifier requires its executable before startup. OpenSSL creates short-lived certificate scratch in `/tmp`; the verifier checks its removal after joined shutdown.

The verifier exercises ordinary native-free imports despite installed peers, native CLI startup, authenticated non-null discovery, exact public advertised authority and current hash, health paths, authentication and Origin rejection, disabled issuer, normal SIGTERM shutdown, UDP release and a fresh certificate after restart. It does not prove an authenticated native stream, in-process timed rotation, external delivery or application acceptance. Also run the existing released TCP fixture from the exact release source against this image. Keep qualification fixtures out of the image.

Record the preparation commit, release source, both archive hashes, frozen lock hash, config hash, base digest, addon hash and actual image ID. Preserve the reviewed same-run save/load image custody when integrating publication later. Local qualification cannot grant `packages:write`, and this preparation adds no workflow producer. The parent must arrange a reviewed change to the existing publication path after the exact candidate is qualified. Publish no placeholder or merely prepared image.

## Keep bind and discovery separate

The native policy binds UDP `0.0.0.0:4433` inside the container. It explicitly advertises `https://waffle-relay-public.sprockt.dev:4433/v1/tcp/wt`. HTTP health paths and WebSocket `/v1/tcp` remain on container TCP 8787. The only allowed page Origin remains `https://waffle-network.sprockt.dev`.

Public port 4433 is approved but not reserved. The advertised authority is an intended configuration, not an executable external mapping or a delivery claim. Do not silently choose another public port. If the operator handoff requires a different authority, review and requalify the config.

Brine UDP is not ready to apply. Its stable preview gives the app only `[udp]` with `container_port = 4433` and `exposure = "public"`. Operator `[[udp_grants]]` owns the app, exposure, exact bind and client addresses, and exact host-port range. No host address, host port or network override belongs in the app spec. Brine injects no advertised environment, discovery or certificate changes. Do not bypass its remaining implementation and physical-delivery gates with raw container, proxy, mount or firewall changes.

The initial native image does not need C1 targets, page tokens or a guest packet. Positive TCP policy and final outside-browser acceptance remain separate work. No service update occurs before the parent's final executable handoff.
