export interface Clock {
  now(): number;
}

export interface RandomSource {
  next(): number;
}

export interface IdSource {
  next(): string;
}

export class ManualClock implements Clock {
  readonly #milliseconds: number;

  constructor(milliseconds: number) {
    assertSafeInteger(milliseconds, "clock value");
    this.#milliseconds = milliseconds;
  }

  now(): number {
    return this.#milliseconds;
  }

  advance(milliseconds: number): ManualClock {
    assertSafeInteger(milliseconds, "clock advance");
    if (milliseconds < 0) throw new RangeError("clock advance must not be negative");
    return new ManualClock(this.#milliseconds + milliseconds);
  }
}

export class SequenceRandomSource implements RandomSource {
  readonly #values: readonly number[];
  #position = 0;

  constructor(values: readonly number[]) {
    if (values.length === 0) throw new RangeError("random sequence must not be empty");
    for (const value of values) {
      if (!Number.isFinite(value) || value < 0 || value >= 1) {
        throw new RangeError("random values must be finite numbers in [0, 1)");
      }
    }
    this.#values = [...values];
  }

  next(): number {
    const value = this.#values[this.#position % this.#values.length];
    this.#position += 1;
    if (value === undefined) throw new Error("random sequence invariant failed");
    return value;
  }
}

export class SequenceIdSource implements IdSource {
  readonly #prefix: string;
  #nextValue: number;

  constructor(prefix: string, firstValue = 1) {
    if (prefix.length === 0) throw new RangeError("ID prefix must not be empty");
    assertSafeInteger(firstValue, "first ID value");
    if (firstValue < 0) throw new RangeError("first ID value must not be negative");
    this.#prefix = prefix;
    this.#nextValue = firstValue;
  }

  next(): string {
    const id = `${this.#prefix}-${this.#nextValue}`;
    this.#nextValue += 1;
    return id;
  }
}

function assertSafeInteger(value: number, label: string): void {
  if (!Number.isSafeInteger(value)) throw new RangeError(`${label} must be a safe integer`);
}

export * from "./bounded-run-fixture.js";
export * from "./scripted-capabilities.js";
