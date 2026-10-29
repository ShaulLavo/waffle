# Preview URL contract

## Root previews

Root previews use a dedicated, preallocated HTTP(S) origin for each runtime owner
and virtual port. Waffle provisions no DNS, TLS, host routes, or native proxy.
The native host authenticates its connection to the runtime owner before it
installs the private grant below. The preview app never receives that grant.

```ts
import { PreviewRouter } from "waffle/browser/preview";
import type {
  PreviewHostAuthorization,
  PreviewHostOpen,
  PreviewSocketRequest,
  PreviewHostInput,
  PreviewHostOutput,
  PreviewHostExchange,
} from "waffle/browser/preview-host";

const previews = new PreviewRouter({
  mode: "root",
  originForPort: (port) => {
    const origin = preallocatedOrigins.get(port);
    if (!origin) throw new Error("No allocated preview origin");
    return origin;
  },
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
- `relay.connect(authorization: unknown, request: PreviewSocketRequest, sink: ConnectionSink)`
  returns `PreviewConnection | null`. The request contains `url`, `method`, and
  header pairs. Waffle validates and writes the upgrade head before returning the
  connection. The native host then sends only trailing upgrade bytes and later
  duplex data. Waffle does not implement the native WebSocket server.
- `relay.close()` revokes the grant and closes outstanding connections. The owner
  AbortSignal, a replacement binding, or server unregister also revokes it.
- `relay.authorization` is immutable `{owner, port, origin, capability}`. It is
  specific to one router owner, port, origin, and lifetime. Wrong grant fields or
  another request/socket origin fail before a virtual connection opens.

`PreviewHostDispatcher.dispatch(open: PreviewHostOpen, exchange: PreviewHostExchange): Promise<void>`
is implemented by the same returned relay. The native transport adapts its
framing to `PreviewHostExchange`; Waffle does not open a native listener.

The exported wire shapes are `PreviewHostOpen`, `PreviewHostInput`,
`PreviewHostOutput`, and `PreviewHostExchange`. Each HTTP open includes a URL,
method, header pairs, and `ArrayBuffer | null` body. Socket opens include the URL,
method, and header pairs.
Both carry the private authorization on the authenticated owner connection.
Outputs carry acceptance, response head, data, end, or error. HTTP acceptance
precedes the response head; socket acceptance precedes all raw output.
`dispatch` resolves when that exchange ends and clears/closes its exchange.
An HTTP end input cancels its request. Host lifetime revocation also interrupts
a response waiting for pull credit. Inputs carry pull,
data, or end. One pull acknowledges one HTTP data chunk. Socket data is raw
trailing upgrade bytes and later TCP bytes, not decoded WebSocket messages. Body buffers can transfer
ownership; native wire adapters must copy or encode bytes when transfer is not
available. Request/Response/ReadableStream objects do not cross the wire.
Request bodies are buffered; response chunks stream with pull credit. Raw sockets
rely on the authenticated native transport to bound its send queue and propagate
disconnect. Waffle restricts request URLs to the grant before serializing an
upgrade. The host must not interpret arbitrary browser input as a host-control message.

Upgrades use the guest authority `localhost:<target port>` for Host. An exact
Origin lookup in the same router's live host bindings supplies the source port,
so Origin becomes `http://localhost:<source port>`. A same-owner sibling keeps
its own port. The lookup never normalizes the Origin or derives a port from a
header. HTTP Host and Origin retain their public values.

| Socket input                                                                | Relay behavior before connecting         |
| --------------------------------------------------------------------------- | ---------------------------------------- |
| Exact target Origin                                                         | Translate to the target's guest origin   |
| Live same-router sibling Origin                                             | Translate to that sibling's guest origin |
| No Origin                                                                   | Keep Origin absent                       |
| Foreign, cross-owner, closed, unregistered, or replaced Origin              | Reject                                   |
| `null`, guest-shaped Origin, or non-exact spelling such as a trailing slash | Reject                                   |
| Duplicate Host or Origin pairs, invalid header syntax, or invalid method    | Reject                                   |

Other upgrade header pairs retain their case, order, and values, including
Connection and Upgrade. Rejection emits an error without acceptance or a virtual
connection. Unregister, rebind, and source closure affect the next lookup.
Retiring a source binding does not close sockets already admitted to another target.

The direct relay, wire dispatcher, and loopback reference host are implemented.
`packages/waffle/tests/preview-host-reference.ts` adapts HTTP requests through the wire protocol
and keeps grants in the host. It is a test fixture, not a production hosting service.
Native transport authentication, the production Bun adapter, and exact Bun app
acceptance remain consumer work. Raw upgrade bytes are tested; a native WebSocket
proxy and Vite HMR are not established by the HTTP hydration proof.

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

The authenticated HTTP dispatcher preserves validated wire header pairs directly
through the shared raw connection and parser. It does not reconstruct a DOM Request
or Response, so native Origin, Cookie, and repeated Set-Cookie fields survive a
browser-owned relay. The public `relay.fetch` still uses ordinary DOM objects and
their header guards. Native adapters must consume raw `head.headers` as pairs.
