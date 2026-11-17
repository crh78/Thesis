import { Program, type Provider } from "@anchor-lang/core";
import type { Connection } from "@solana/web3.js";
import idl from "../idl/thesis.json" with { type: "json" };
import type { Thesis } from "./types.ts";

export type ThesisProgram = Program<Thesis>;

/**
 * A program handle for building instructions and reading accounts. It holds no wallet:
 * signing stays with the caller (Privy, a Blink wallet, a crank key).
 */
export function thesisProgram(connection: Connection): ThesisProgram {
  return new Program(idl as Thesis, { connection } as Provider);
}
