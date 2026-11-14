import { describe, expect, it } from 'vitest';
import { MERCHANT_PLAN_LABEL, planLabel } from './planLabel';

describe('planLabel', () => {
  it('labels the single current tier MERCHANT', () => {
    expect(planLabel('MERCHANT')).toBe(MERCHANT_PLAN_LABEL);
    expect(planLabel('merchant')).toBe(MERCHANT_PLAN_LABEL);
    expect(planLabel('  MERCHANT  ')).toBe(MERCHANT_PLAN_LABEL);
  });

  it('collapses every historical plan value to MERCHANT', () => {
    const historical = [
      'Shuru', 'shuru', 'SHURU',
      'Growth', 'growth', 'GROWTH',
      'Partner', 'partner', 'PARTNER',
      'Starter', 'Free',
      'growth_monthly', 'growth_annual',
      'package_1', 'Package 2',
    ];
    for (const value of historical) {
      expect(planLabel(value)).toBe(MERCHANT_PLAN_LABEL);
    }
  });

  it('does not invent a plan for a blank value', () => {
    expect(planLabel(null)).toBe('No plan');
    expect(planLabel(undefined)).toBe('No plan');
    expect(planLabel('   ')).toBe('No plan');
  });

  it('passes an unknown future code through without retired naming', () => {
    expect(planLabel('some_future_tier')).toBe('some future tier');
  });
});