// Hardware generations. A dump does not record its platform, so the one to
// assume comes from a setting; lines of a gentool case file name theirs.

import type { Instruction } from './parser/model.ts';

export type Generation = 'xe-lp' | 'xe-hpg' | 'xe2' | 'xe3' | 'xe3p';

export const GENERATIONS: readonly Generation[] = ['xe-lp', 'xe-hpg', 'xe2', 'xe3', 'xe3p'];

/** Mesa's `verx10` for each generation. */
const VERSION: Record<Generation, number> = { 'xe-lp': 120, 'xe-hpg': 125, xe2: 200, xe3: 300, xe3p: 350 };

/** `verx10` by gentool platform name. Platforms before Gfx12 have no software scoreboard. */
const PLATFORM_VERSION: Record<string, number> = {
  skl: 90, bxt: 90, kbl: 90, aml: 90, glk: 90, cfl: 90, whl: 90, cml: 90, icl: 110, ehl: 110, jsl: 110,
  tgl: 120, rkl: 120, dg1: 120, adl: 120, sg1: 120, rpl: 120,
  dg2: 125, mtl: 125, arl: 125,
  lnl: 200, bmg: 200, ptl: 300, 'nvl-u': 300, nvl: 350,
};

/** The `verx10` to interpret an instruction with: its case-line platform if it has one, else the assumed generation. */
export function versionOf(inst: Instruction, assumed: Generation): number {
  return (inst.platform && PLATFORM_VERSION[inst.platform]) || VERSION[assumed];
}

/** Bytes in a general register. */
export const grfSize = (version: number) => (version >= 200 ? 64 : 32);
