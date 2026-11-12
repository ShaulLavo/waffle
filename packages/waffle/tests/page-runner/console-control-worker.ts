const query = new URL(location.href).searchParams;
const mode = query.get("mode");
const marker = query.get("marker");
if (!marker) throw new Error("Missing unique console control marker");
if (mode === "worker-only") {
  self.onmessage = () => {
    console.error(marker);
    postMessage("body-pass");
  };
} else {
  if (mode?.startsWith("worker-")) console.error(marker);
  postMessage("body-pass");
  if (mode === "worker-error-self-close" || mode === "clean-self-close") self.close();
}
