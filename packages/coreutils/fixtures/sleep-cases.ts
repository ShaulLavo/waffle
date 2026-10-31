export interface SleepCase {
  readonly name: string;
  readonly args: string[];
  readonly kind: "duration" | "error" | "metadata";
  readonly status: number;
}

export const sleepCases: readonly SleepCase[] = [
  { name: "zero", args: ["0"], kind: "duration", status: 0 },
  { name: "fractional seconds", args: ["0.025"], kind: "duration", status: 0 },
  { name: "leading decimal", args: [".025"], kind: "duration", status: 0 },
  { name: "seconds suffix", args: ["0.025s"], kind: "duration", status: 0 },
  { name: "minutes suffix", args: ["0.0005m"], kind: "duration", status: 0 },
  { name: "hours suffix", args: ["0.00001h"], kind: "duration", status: 0 },
  { name: "days suffix", args: ["0.0000005d"], kind: "duration", status: 0 },
  { name: "multiple operands", args: ["0.01", "0.02s", "0.0001m"], kind: "duration", status: 0 },
  { name: "exponent", args: ["2.5e-2"], kind: "duration", status: 0 },
  { name: "subnanosecond", args: ["0.0000000001"], kind: "duration", status: 0 },
  { name: "option delimiter", args: ["--", "0"], kind: "duration", status: 0 },
  { name: "missing operand", args: [], kind: "error", status: 1 },
  { name: "empty operand", args: [""], kind: "error", status: 1 },
  { name: "negative duration", args: ["--", "-1"], kind: "error", status: 1 },
  { name: "invalid text", args: ["invalid"], kind: "error", status: 1 },
  { name: "invalid suffix", args: ["1ms"], kind: "error", status: 1 },
  { name: "NaN", args: ["NaN"], kind: "error", status: 1 },
  { name: "invalid option", args: ["--unknown"], kind: "error", status: 1 },
  { name: "invalid operand prevents waiting", args: ["30", "invalid"], kind: "error", status: 1 },
  { name: "multiple invalid operands", args: ["bad", "worse"], kind: "error", status: 1 },
  { name: "help", args: ["--help"], kind: "metadata", status: 0 },
  { name: "version", args: ["--version"], kind: "metadata", status: 0 },
];
