# Prepare a native relay container

This is a separate Linux x64 preparation path. The existing WebSocket-only image and its release pins remain the default. Its policy remains deny-all for HTTP and TCP, with no network token issuer. The native context pins a separate Node 26.12.1 Trixie slim base. The existing Bookworm WS base cannot load this exact prebuild because it lacks GLIBC_2.38.

## Supply exact qualified inputs

Use the final public `waffle-v0.0.110` pair recorded in `container/native/release.ts`. Its release source is `f1bccf55abb04b0798611f5c2c1c3494ebb187c9`, tree `1b769d860fc0a257fcb2fb2369d26e25102c08d6`, host interface 1. The runtime archive SHA-256 is `8887911306a2a500f7f9e103485132dcfd46ff2590576b3cce86f2201d75fb30`, and the relay archive SHA-256 is `571885cbb57037a6a977ff803d665b4673b47dec332c3afa5193177494b092fd`. Download the canonical URLs from those pins without credentials. Earlier branch-runtime bytes differ and are rejected, even if their version is the same.

Do not substitute R1, rebuild its archives, or relabel its image. Git ancestry through the correction `e81d4808976ed97f5e746150a23b88743f6fb94f` must be available locally; a shallow history fails closed.

Fetch the public `fails-components/webtransport` release asset `webtransport-transport-http3-quiche-v1.6.11-napi-v6-linux-x64.tar.gz` from tag `v1.6.11`. Its SHA-256 is `6340d0f657e37daaf168fe4bd77ad227653df3e3da52c96d1448a98dbfaf4c12`. The extracted `build/Release/webtransport.node` must hash to `5592208da56aee0f53615b8d8c5d57c99a87618593c6343787ac9f92761daf1d`.

From a clean exclusive checkout, with the exact source commit available locally, run:

```sh
node packages/waffle-relay/scripts/prepare-native-container.ts \
	"${RUNTIME_ARCHIVE:?}" "${RUNTIME_SHA256:?}" \
	"${RELAY_ARCHIVE:?}" "${RELAY_SHA256:?}" "${RELEASE_SOURCE:?}" \
	"${NATIVE_PREBUILD:?}" "${NEW_CONTEXT:?}"
```

Use a new, task-owned context under a verified data-drive scratch directory. The helper rejects checksum, version, host-interface and relay-source mismatches. It checks every relay source file against the supplied commit. This check does not prove that compiled exports came from that source. The release owner's qualification and archive custody remain required.

The helper copies the unchanged archives, the native-only package manifest and its checked-in frozen npm lock into the context. It never resolves a fresh dependency graph. The native package pair stays pinned to `1.6.11`, and every registry package in the lock has an integrity value. Existing WS and runtime package metadata remain unchanged. It records archive, source, base, addon, lock and config identities. Failed preparation removes its new context. The caller owns successful context cleanup.

## Qualify the actual image

Install teardown before building. Record existing images and containers, use unique local names, and remove only resources created by this run. Substantial PC work uses the heavy queue. No registry login, push, dispatch or production update belongs in this step.

Build the generated context with `--platform linux/amd64`, `--build-arg SOURCE_COMMIT="$RELEASE_SOURCE"` and `--build-arg RELEASE_VERSION="$RELEASE_VERSION"`. Read `RELEASE_VERSION` from the helper receipt, not a guessed future tag. Both build arguments must match the receipt. The Dockerfile checks context hashes, installs from the frozen lock without scripts, and checks the native archive and extracted addon before any loader runs. The released native entry independently checks both package versions and addon bytes before importing its loader.

Mount `container/native/verify.ts` and its adjacent `release.ts` outside the image through a read-only qualification mount. Run the verifier from that mount. Use the candidate's Node executable, `--read-only`, `--network none`, and a private `/tmp` tmpfs with at least 16 MiB. Do not publish container ports. The final image runs as UID and GID 1000, with root-owned application files. The native runtime stage pins OpenSSL to `3.5.7-1~deb13u3`. Record its actual package version with the qualification receipts. The verifier requires its executable before startup. OpenSSL creates short-lived certificate scratch in `/tmp`; the verifier checks its removal after joined shutdown.

The verifier exercises ordinary native-free imports despite installed peers, the exact public source/tree/archive tuple, root-owned application files, native CLI startup, authenticated non-null discovery, exact public advertised authority and current hash, health paths, authentication and Origin rejection, disabled issuer, normal SIGTERM shutdown, UDP release and a fresh certificate after restart. It does not prove an authenticated native stream, in-process timed rotation, external delivery or application acceptance. Also run the existing released TCP fixture from the exact release source against this image. Keep qualification fixtures out of the image.

Record the preparation commit, release source, both archive hashes, frozen lock hash, config hash, base digest, addon hash and actual image ID. Local qualification cannot grant `packages:write`. Publish no placeholder or merely prepared image.

## Publication custody

The existing `relay-image.yml` workflow qualifies both fixed variants on relevant pull requests with read-only permissions. A manual dispatch defaults to `ws`; selecting `native` explicitly qualifies the final public pair through this helper and verifier. Checkout includes full Git history for the exact source, tree and correction-ancestry checks. Each variant runs the unchanged TCP fixture from its pinned release source, not the current branch fixture.

Only a manual dispatch on canonical repository `main` can upload the publication artifact or enter the existing single `packages:write` job. That job downloads only the same-run producer artifact ID and checks its separately passed receipt hash before loading. Source head, run, attempt, variant, platform, release inputs, Dockerfile, frozen lock and relay config hashes are bound to the saved archive and actual saved config. The qualifier checks the installed lock and policy before saving, removes the image tag, and proves reload of the same archive. The write job does not rebuild or rerun qualification.

Tags remain `ws-<workflow-source>` for WS and become `native-<workflow-source>` for native, only under `ghcr.io/shaullavo/waffle-relay`. After pushing, the workflow proves anonymous pull by the actual immutable registry digest. It hashes the returned manifest and its anonymously downloaded config blob against the qualified saved config bytes. Engine image IDs are recorded separately from config digests. A local manifest digest is not a promised future registry digest, and apt availability or equality of independent rebuilds is not guaranteed. Publication does not update a service or allocate UDP.

## Keep bind and discovery separate

The native policy binds UDP `0.0.0.0:4433` inside the container. It explicitly advertises `https://waffle-relay-public.sprockt.dev:4433/v1/tcp/wt`. HTTP health paths and WebSocket `/v1/tcp` remain on container TCP 8787. The only allowed page Origin remains `https://waffle-network.sprockt.dev`.

Public port 4433 is approved but not reserved. The advertised authority is an intended configuration, not an executable external mapping or a delivery claim. Do not silently choose another public port. If the operator handoff requires a different authority, review and requalify the config.

Brine UDP is not ready to apply. Its stable preview gives the app only `[udp]` with `container_port = 4433` and `exposure = "public"`. Operator `[[udp_grants]]` owns the app, exposure, exact bind and client addresses, and exact host-port range. No host address, host port or network override belongs in the app spec. Brine injects no advertised environment, discovery or certificate changes. Do not bypass its remaining implementation and physical-delivery gates with raw container, proxy, mount or firewall changes.

The initial native image does not need C1 targets, page tokens or a guest packet. Positive TCP policy and final outside-browser acceptance remain separate work. No service update occurs before the parent's final executable handoff.
