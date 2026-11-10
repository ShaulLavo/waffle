import "./metadata-enumeration-r173-worker.js";
import { FilesystemClient } from "../../fs/client.js";

let disposed = 0;
const dispose = FilesystemClient.prototype.dispose;
FilesystemClient.prototype.dispose = function (this: FilesystemClient) {
  dispose.call(this);
  disposed++;
};
const post = self.postMessage.bind(self);
self.postMessage = (value: unknown) => {
  post({ value, disposedBeforeResult: disposed });
};
