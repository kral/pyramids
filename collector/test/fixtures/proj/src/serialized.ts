/* vto-ignore-file */
export function double(n: number) { return n * 2; }
export function runSerialized(fn: Function, arg: number) { return new Function('return (' + fn.toString() + ')(' + arg + ')')(); }
