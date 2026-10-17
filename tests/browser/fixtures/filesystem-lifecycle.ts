import { SharedFilesystem, WORKSPACE_TAKEN_OVER, UNSAVED_CHANGES_LOST } from "../../src/shared-fs";

const options = new URLSearchParams(location.search);
const storage = options.get("storage") === "opfs" ? "opfs" : "indexeddb";
const id = crypto.randomUUID();
function log(event: Event) {
  const events = JSON.parse(sessionStorage.getItem("lifecycle") ?? "[]");
  events.push({ type: event.type, persisted: "persisted" in event ? event.persisted : false, id });
  sessionStorage.setItem("lifecycle", JSON.stringify(events));
}
addEventListener("pagehide", log);
addEventListener("pageshow", log);
const fs = new SharedFilesystem({ storage, name: options.get("name") ?? "lifecycle" });
const state = { fs, id, ready: false, error: "" };
Object.assign(globalThis, { lifecycle: state });
const edits = document.createElement("textarea");
document.body.append(edits);
const style = document.createElement("style");
style.textContent = "pre{white-space:pre-wrap;overflow-wrap:anywhere}textarea{max-width:90vw}";
document.head.append(style);
fs.onOwnershipLost = () => {
  state.ready = false;
  state.error = `${WORKSPACE_TAKEN_OVER} ${UNSAVED_CHANGES_LOST}`;
  document.body.append(Object.assign(document.createElement("pre"), { textContent: state.error }));
};
void fs.mkdirp("/").then(() => { state.ready = true; document.body.append(" Ready."); }, error => {
  state.error = String(error);
  document.body.append(Object.assign(document.createElement("pre"), { textContent: state.error }));
});
