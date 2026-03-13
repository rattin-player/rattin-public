export const constants: { EQ: 1; LT: 2; LTE: 3; GT: 4; GTE: 5 }

declare class SemVerError extends Error {
  static INVALID_VERSION(msg: string, fn?: Function): SemVerError

  static INVALID_RANGE(msg: string, fn?: Function): SemVerError
}

export { SemVerError as errors }

export function satisfies(version: Version, range: Range): boolean

export class Version {
  constructor(
    major: number,
    minor: number,
    patch: number,
    opts?: { prerelease?: string[]; build?: string[] }
  )

  major: number
  minor: number
  patch: number
  prerealease: string[]
  build: string[]

  compare(version: Version): boolean

  toString(): string
}

export namespace Version {
  export function parse(input: string): Version

  export function compare(a: Version, b: Version): number
}

export class Comparator {
  constructor(operator: number, version: Version)

  operator: number
  version: Version

  test(version: Version): boolean

  toString(): string
}

export class Range {
  constructor(comparators?: Comparator[][])

  comparators: Comparator[][]

  test(version: Version): boolean

  toString(): string
}

export namespace Range {
  export function parse(input: string): Range
}
