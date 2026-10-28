# Prepare a transferred filesystem connection

Await `FilesystemClient.ready({ signal })` once in the receiving agent before its
first synchronous filesystem call. A transferred MessagePort can require that
agent's event loop to run before its first request can reach the service.
Blocking the agent in a synchronous request before that point can prevent delivery.

```ts
const fs = new FilesystemClient(connection);
await fs.ready({ signal });
const root = fs.preopen("/");
```

`bootstrap` performs this barrier automatically before resident attachment,
executor setup, namespace hooks, default preopens, or descriptor binding. Executors
using the supplied client do not need a second barrier.

Readiness submits a non-mutating `connectionReady` request and waits for its actual
completion message on that client's port. Shared completion state alone is
insufficient. The request does not call the backend, allocate a file handle, or
change the filesystem epoch. Each explicit call makes an independent round trip.
Success confirms that exchange, not future service health or an exclusive lease.

AbortSignal cancellation, connection revocation, service failure, and client
disposal reject pending readiness with the existing filesystem cancellation error.
The request buffer and listeners are released before readiness settles. Late
completion cannot revive a canceled request or enable executor setup. The
filesystem owner still revokes connections on service failure and owns native
physical-stop acknowledgement. Closing an arbitrary port without revoking its
connection is not a supported failure signal.

There is no elapsed-time deadline, retry, or timer supplying readiness. The waiting
agent yields its event loop. A live service may remain pending until it processes
the request or the owner cancels it. Shutdown aborts and joins pending startup work
before releasing its connection or stopping its native worker.
