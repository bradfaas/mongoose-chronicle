import { computeDelta, applyDelta, applyDeltas, isDeltaEmpty } from '../src/utils/delta';

describe('Delta utilities', () => {
  describe('computeDelta', () => {
    it('should detect changed fields', () => {
      const original = { name: 'John', age: 30 };
      const updated = { name: 'John', age: 31 };

      const delta = computeDelta(original, updated);

      expect(delta).toEqual({ age: 31 });
    });

    it('should detect new fields', () => {
      const original = { name: 'John' };
      const updated = { name: 'John', age: 30 };

      const delta = computeDelta(original, updated);

      expect(delta).toEqual({ age: 30 });
    });

    it('should detect deleted fields as null', () => {
      const original = { name: 'John', age: 30 };
      const updated = { name: 'John' };

      const delta = computeDelta(original, updated);

      expect(delta).toEqual({ age: null });
    });

    it('should ignore _id field', () => {
      const original = { _id: '123', name: 'John' };
      const updated = { _id: '456', name: 'John' };

      const delta = computeDelta(original, updated);

      expect(delta).toEqual({});
    });

    it('should handle nested objects', () => {
      const original = { name: 'John', address: { city: 'NYC' } };
      const updated = { name: 'John', address: { city: 'LA' } };

      const delta = computeDelta(original, updated);

      expect(delta).toEqual({ address: { city: 'LA' } });
    });

    it('should handle arrays', () => {
      const original = { name: 'John', tags: ['a', 'b'] };
      const updated = { name: 'John', tags: ['a', 'b', 'c'] };

      const delta = computeDelta(original, updated);

      expect(delta).toEqual({ tags: ['a', 'b', 'c'] });
    });
  });

  describe('applyDelta', () => {
    it('should apply field changes', () => {
      const base = { name: 'John', age: 30 };
      const delta = { age: 31 };

      const result = applyDelta(base, delta);

      expect(result).toEqual({ name: 'John', age: 31 });
    });

    it('should add new fields', () => {
      const base = { name: 'John' };
      const delta = { age: 30 };

      const result = applyDelta(base, delta);

      expect(result).toEqual({ name: 'John', age: 30 });
    });

    it('should remove fields when delta value is null', () => {
      const base = { name: 'John', age: 30 };
      const delta = { age: null };

      const result = applyDelta(base, delta);

      expect(result).toEqual({ name: 'John' });
    });

    it('should not mutate original base', () => {
      const base = { name: 'John', age: 30 };
      const delta = { age: 31 };

      applyDelta(base, delta);

      expect(base).toEqual({ name: 'John', age: 30 });
    });
  });

  describe('applyDeltas', () => {
    it('should apply multiple deltas sequentially', () => {
      const base = { name: 'John', age: 30, city: 'NYC' };
      const deltas = [
        { age: 31 },
        { city: 'LA' },
        { name: 'Jane' },
      ];

      const result = applyDeltas(base, deltas);

      expect(result).toEqual({ name: 'Jane', age: 31, city: 'LA' });
    });

    it('should handle empty deltas array', () => {
      const base = { name: 'John', age: 30 };

      const result = applyDeltas(base, []);

      expect(result).toEqual({ name: 'John', age: 30 });
    });
  });

  describe('isDeltaEmpty', () => {
    it('should return true for empty object', () => {
      expect(isDeltaEmpty({})).toBe(true);
    });

    it('should return false for non-empty object', () => {
      expect(isDeltaEmpty({ age: 31 })).toBe(false);
    });
  });
});
