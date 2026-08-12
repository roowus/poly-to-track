import { describe, expect, it } from 'vitest';
import { parseTypedValue } from '../src/ui/slider-value';

describe('parseTypedValue', () => {
  it('parses plain numbers', () => {
    expect(parseTypedValue('37', -180, 180)).toBe(37);
    expect(parseTypedValue('-90', -180, 180)).toBe(-90);
    expect(parseTypedValue('0', -180, 180)).toBe(0);
  });

  it('is NOT snapped to the drag step — typing exists for exact values', () => {
    expect(parseTypedValue('37', -180, 180)).toBe(37); // the 5° drag snap would give 35
    expect(parseTypedValue('22.5', -180, 180)).toBe(22.5);
    expect(parseTypedValue('1.55', 0.1, 8)).toBe(1.55);
  });

  it('rounds to 2 decimals (the pose precision)', () => {
    expect(parseTypedValue('1.555', 0.1, 8)).toBe(1.56);
    expect(parseTypedValue('12.333333', 4, 256)).toBe(12.33);
  });

  it('clamps to the range', () => {
    expect(parseTypedValue('9999', -180, 180)).toBe(180);
    expect(parseTypedValue('-9999', -180, 180)).toBe(-180);
    expect(parseTypedValue('0.01', 0.1, 8)).toBe(0.1);
  });

  it('tolerates units and decoration the readout shows', () => {
    expect(parseTypedValue('45°', -180, 180)).toBe(45);
    expect(parseTypedValue('×1.5', 0.1, 8)).toBe(1.5);
    expect(parseTypedValue('  x2  ', 0.1, 8)).toBe(2);
    expect(parseTypedValue('scale 3', 0.1, 8)).toBe(3);
  });

  it('accepts a decimal comma', () => {
    expect(parseTypedValue('1,5', 0.1, 8)).toBe(1.5);
  });

  it('returns null when there is no number', () => {
    expect(parseTypedValue('', -180, 180)).toBeNull();
    expect(parseTypedValue('abc', -180, 180)).toBeNull();
    expect(parseTypedValue('°', -180, 180)).toBeNull();
  });
});
