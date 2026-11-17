import { configAddress } from "./pda.ts";
import type { ThesisProgram } from "./program.ts";

export function fetchConfig(program: ThesisProgram) {
  return program.account.config.fetch(configAddress(program.programId));
}
