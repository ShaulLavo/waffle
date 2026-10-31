// Existing guest transport status values. No namespace or loader dependencies.
export const TCP_IN_USE = -10;
export const TCP_REFUSED = -11;
export const TCP_PIPE = -12;
export const TCP_INVALID = -13;
/** Sticky outbound failure, including before its queued Error record reaches the guest. */
export const TCP_RESET = -14;
