/**
 * `currency` is a free TEXT column — the schema does not constrain it to ISO
 * 4217 and nothing server-side validates it — so it is printed beside the
 * number rather than handed to Intl.NumberFormat as a currency code, which
 * throws on anything that is not one.
 */
export function formatDealValue(deal: {
  value: number | null;
  currency: string | null;
}): string {
  if (deal.value === null) return "";
  const amount = new Intl.NumberFormat(undefined, {
    maximumFractionDigits: 2,
  }).format(deal.value);
  return deal.currency ? `${amount} ${deal.currency}` : amount;
}
