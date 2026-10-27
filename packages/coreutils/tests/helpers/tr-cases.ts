import { cutTrRecording } from "./cut-tr-recording.ts";

export function trCases() {
  return cutTrRecording().cases.filter(({ name }) => !name.startsWith("cut "));
}
