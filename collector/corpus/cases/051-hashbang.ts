#!/usr/bin/env node
// hashbang must stay on the first line
export function hb(x: number) { return x ? "hb" : /*@never*/ "no" }
export function scenario() { return hb(1) }
