const BENGALI_DIGITS = "০১২৩৪৫৬৭৮৯";

export function normalizeBengaliDigits(value: string): string {
  return value.replace(/[০-৯]/g, (digit) => String(BENGALI_DIGITS.indexOf(digit)));
}
