import type { ReactNode } from 'react'
import { type FC, useState } from 'react'
export type Cond<T> = T extends string ? 'str' : T extends number ? 'num' : never
export type Mapped<T> = { readonly [K in keyof T as `get${Capitalize<string & K>}`]-?: () => T[K] }
export interface Shape { kind: 'a' | 'b'; area?(): number }
type Fn = (a: number, b?: string) => void
export type { Fn }
let type = 'type-as-identifier'
let as = 'as-ident', satisfies = 'satisfies-ident', declare = 'declare-ident', abstract = 'abstract-ident'
export class WithDeclare { declare d: string; e!: number; f?: number }
export function generic<T extends Cond<'x'> = 'str'>(x: T): T { return x }
export abstract class Ab { abstract m(): void }
export function scenario() {
  const fc: FC | null = null
  const node: ReactNode = 'n'
  return { type, as, satisfies, declare, abstract, keys: Object.keys(new WithDeclare()), g: generic('str'), us: typeof useState, fc, node }
}
