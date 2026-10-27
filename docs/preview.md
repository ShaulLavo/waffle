# Preview URL contract

## Draft host contract checkpoint

Root previews use a dedicated, preallocated HTTP(S) origin for each runtime owner
and virtual port. Waffle provisions no DNS, TLS, host routes, or native proxy.
The native host authenticates its connection to the runtime owner before it
installs the private grant below. The preview app never receives that grant.

```ts
import { PreviewRouter } from "waffle/browser/preview";
import type {
  PreviewHostAuthorization,
  PreviewHostOpen,
  PreviewHostInput,
  PreviewHostOutput,
  PreviewHostExchange,
} from "waffle/browser/preview-host";

const previews = new PreviewRouter({
  mode: "root",
  originForPort: (port) => preallocatedOrigins.get(port)!,
});
previews.register(port, existingPreviewServer);
const relay = await previews.bindHost({ port, signal: ownerLifetime.signal });
const privateGrant = relay.authorization;
const appURL = previews.url(port, "/?value=query#section");
```

`originForPort(port): string` returns only an origin root. Paths, query, fragment,
credentials, and non-HTTP(S) schemes are rejected. Binding captures the origin
once. `url` throws until a live relay exists and never falls back to a mounted
path. Each live origin can identify only one virtual port on a router.

The concrete direct relay API is:

- `relay.fetch(authorization: unknown, request: Request): Promise<Response>`.
  It forwards the unchanged pathname and query, method, headers, and buffered body
  over the existing virtual server's raw connection, using the public Host header.
  Response bodies stream. Redirect locations retain their application meaning.
  Request abort and response cancellation close the virtual connection.
- `relay.connect(authorization: unknown, url: string, sink: ConnectionSink)` returns
  `PreviewConnection | null`. The native host sends the original HTTP upgrade
  request and duplex bytes. Waffle does not implement the native WebSocket server.
- `relay.close()` revokes the grant and closes outstanding connections. The owner
  AbortSignal, a replacement binding, or server unregister also revokes it.
- `relay.authorization` is immutable `{owner, port, origin, capability}`. It is
  specific to one router owner, port, origin, and lifetime. Wrong grant fields or
  another request/socket origin fail before a virtual connection opens.

`PreviewHostDispatcher.dispatch(open: PreviewHostOpen, exchange: PreviewHostExchange): Promise<void>`
is the draft exchange endpoint contract. It will be returned on the same relay.

The exported wire shapes are `PreviewHostOpen`, `PreviewHostInput`,
`PreviewHostOutput`, and `PreviewHostExchange`. Each HTTP open includes a URL,
method, header pairs, and `ArrayBuffer | null` body. Socket opens include the URL.
Both carry the private authorization on the authenticated owner connection.
Outputs carry acceptance, response head, data, end, or error. Inputs carry pull,
data, or end. One pull acknowledges one HTTP data chunk. Socket data is raw
HTTP upgrade/TCP bytes, not decoded WebSocket messages. Body buffers can transfer
ownership; native wire adapters must copy or encode bytes when transfer is not
available. Request/Response/ReadableStream objects do not cross the wire.

At this checkpoint, the direct relay and focused unit tests are implemented.
The wire-exchange dispatcher and root-origin browser reference fixture are still
being implemented. No Bun consumer, native host adapter, exact-app acceptance,
or live deployment is wired or claimed complete at this head.

The host maps initial navigation, nested routes, assets, and browser reload by
origin to the same authenticated grant. It cannot depend on a previous clientId,
pathname prefix, opener, or browser-supplied owner/port. Private access, CSP,
COOP/COEP, cross-origin isolation, native transport authentication, and disconnect
revocation remain host policy. Host disconnect must abort the binding lifetime.

## Explicit mounted previews

`new PreviewRouter({baseURL, prefix})` remains an explicit path-mounted mode for
applications designed for that mount. Its service worker removes the mount and
port before forwarding HTTP. The browser keeps that pathname. An unchanged SSR
client router that owns `/` cannot hydrate under this mount. An HTML base element
cannot change `window.location.pathname`.
