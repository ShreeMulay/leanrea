// Parity fixture: deliberate type errors plus ordinary emit, so the parity
// gate compares non-empty diagnostics and non-trivial output.
export enum Color { Red, Green = "g" }
export class Box<T> {
  #v: T;
  constructor(v: T) { this.#v = v; }
  get value(): T { return this.#v; }
  static of<U>(v: U) { return new Box(v); }
}
export const n: number = "not a number";
export function f(x: string): number { return x.length + missing; }
export async function* gen() { for await (const x of [Promise.resolve(1)]) yield x satisfies number; }
const { a = 1, ...rest } = { b: 2 } as { a?: number; b: number };
export { a, rest };
