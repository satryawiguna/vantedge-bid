import { ValueTransformer } from 'typeorm';

/**
 * Postgres `numeric` is arbitrary precision; JavaScript `number` is a double.
 * Converting between them loses money. The pg driver already returns numeric as
 * a string — this transformer makes that explicit and stops anyone "fixing" it
 * with a parseFloat later.
 */
export const numericTransformer: ValueTransformer = {
  to: (value: string | null): string | null => value,
  from: (value: string | null): string | null => value,
};
