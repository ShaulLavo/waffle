import { forbidDurableProcessStorage } from "./process-recycling-storage-control.js";
import "../../browser/fs-worker.js";
forbidDurableProcessStorage();
