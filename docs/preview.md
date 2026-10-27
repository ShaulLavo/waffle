# Preview URL contract

`PreviewRouter.url(port, path)` currently mounts a virtual server at
`<prefix>/<port><path>` on the consumer's origin. `createPreviewServiceWorker`
removes the prefix and port before forwarding the HTTP request. The browser
keeps the mounted URL, including its pathname.

This changes the URL seen by a client router. For example, SSR receives `/`
while hydration sees `/__preview/3137/`. Successful document and module responses
do not establish that an unchanged SSR application can hydrate at this mount.
An HTML `base` element cannot change `window.location.pathname`.

The current worker routes root-relative assets using the requesting preview
client's port. A navigation or reload outside its registration scope does not
acquire that scope. Consumers own worker registration, response transforms,
security headers, and WebSocket adapters.

An unchanged application that owns `/` needs a browser origin dedicated to its
virtual server. The consumer must provide that origin and a transport to its
runtime owner. Service workers cannot enumerate or message windows on another
origin through `clients.matchAll()`.

A root-origin transport must preserve these properties:

- The browser pathname and the forwarded pathname agree. Queries reach the
  server unchanged. Fragments remain in browser history.
- Each origin identifies one runtime owner and one virtual port. Different
  virtual servers cannot claim each other's requests or sockets.
- Root-relative assets, nested navigation, back and forward, and browser reload
  reach the same virtual server.
- HTTP methods, bodies, headers, redirects, and WebSocket URLs retain their
  application meaning.
- Private access, CSP, cross-origin isolation, and authentication remain consumer
  policy. A root-origin transport does not grant wildcard origin access.

Waffle does not provision DNS, TLS, host routes, or a cross-origin relay. A URL
callback alone cannot supply those capabilities.
