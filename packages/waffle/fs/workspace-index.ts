import { NamespaceProjectionPressure } from "./namespace-projection-table.js";
import { WORKSPACE_LIMITS } from "./workspace-types.js";

export {
  NamespaceProjectionTable as NamespaceIndex,
  NamespaceProjectionPressure as ProjectionPressure,
} from "./namespace-projection-table.js";

export class ChangeBudget {
  private used = 0;
  take(bytes: number): void {
    if (this.used + bytes > WORKSPACE_LIMITS.changeBytes)
      throw new NamespaceProjectionPressure("changes");
    this.used += bytes;
  }
}
